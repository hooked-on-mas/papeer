import hashlib
import json
from pathlib import Path

from _summary_responses import clean_summary_response
import threading

import pytest

from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService, link_citations
from papeer.core.storage import Library
from papeer.core.summary_review import _apply_edits, _excerpt_span, _grounded_quote, normalize_citation_code, reference_issues, review_article
from papeer.providers import Cancelled

IDENTITY = "a" * 32
LINK = f"[p.2](papeer://{IDENTITY}/2)"


def test_reference_checks_reject_unknown_assets_scope_and_unconverted_code(tmp_path):
    (tmp_path / "p2f1.png").write_bytes(b"png")
    assets = {"media/p2f1.png"}
    valid = f"Result {LINK}\n\n![Figure](media/p2f1.png)"
    assert reference_issues(valid, IDENTITY, {2}, assets, tmp_path) == []
    for invalid in [valid.replace("p2f1", "image1"), valid.replace("/2)", "/3)"),
                    valid + f" [{IDENTITY}:p2]", valid + " [invented:p2]", valid + " [ID:pN]", valid.replace(LINK, f"`{LINK}`"),
                    valid + "\n![Figure](media/p2f1.png)", valid.replace("media/p2f1.png", "../p2f1.png"),
                    valid + " <img src='unknown.png'>", valid.replace(LINK, LINK.replace(IDENTITY, "b" * 32)),
                    "```markdown\n" + valid + "\n```", valid.replace("![Figure](media/p2f1.png)", "`![Figure](media/p2f1.png)`")]:
        assert reference_issues(invalid, IDENTITY, {2}, assets, tmp_path)
    assert normalize_citation_code(f"`{LINK}`") == LINK
    assert normalize_citation_code(f"{LINK} {LINK} {LINK}") == LINK
    assert normalize_citation_code(f"{LINK}\n\n{LINK}") == f"{LINK}\n\n{LINK}"
    assert normalize_citation_code(f"`code {LINK}`").startswith("`code")


def test_pending_assets_are_checked_without_overwriting_previous_images(tmp_path):
    article = f"Result {LINK}\n\n![Figure](media/p2f1.png)"
    assets = {"media/p2f1.png"}
    assert reference_issues(article, IDENTITY, {2}, assets, tmp_path)
    assert reference_issues(article, IDENTITY, {2}, assets, tmp_path, pending_assets=assets) == []
    assert reference_issues(article.replace("p2f1", "invented"), IDENTITY, {2}, assets, tmp_path, pending_assets=assets)


@pytest.mark.parametrize("aside", ["供給された研究ノートに基づく。", "ノートの範囲では不明。",
                                  "このノートからは言えない。", "提供テキストは途中で終わる。",
                                  "供給範囲には計算量がない。"])
def test_summary_rejects_internal_input_scope_as_a_paper_limitation(tmp_path, aside):
    assert reference_issues(f"結果。{LINK} {aside}", IDENTITY, {2}, set(), tmp_path)
    assert reference_issues(f"著者は研究ノートを公開した。{LINK}", IDENTITY, {2}, set(), tmp_path) == []


def test_review_uses_original_pages_and_applies_only_grounded_local_edits():
    article = f"The methods always agree. {LINK}\n\nOther correct material."
    source = "At K=4 the methods are similar; at K=8 ADPT is better."

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            assert [{"page": p["page"], "text": p["text"]} for p in request["source_pages"]] == [{"page": 2, "text": source}]
            assert request["article"] == article
            return json.dumps({"edits": [{"category": "condition", "reason": "Kの条件が欠落", "page": 2,
                "evidence": "at K=8 ADPT is better.", "original": f"The methods always agree. {LINK}",
                "replacement": f"K=4では同等、K=8ではADPTが優れる。 [{IDENTITY}:p2]"}]})

    result, report = review_article(article, IDENTITY, [{"page": 2, "text": source}], Provider(), threading.Event(),
                                    lambda _: None, lambda text: link_citations(text, {IDENTITY: 2}))
    assert "Other correct material." in result and "always agree" not in result and LINK in result
    assert report["source_pages"] == [2] and len(report["edits"]) == 1


@pytest.mark.parametrize("change", [{"evidence": "Not in the actual original paper"}, {"page": 1},
                                   {"original": "Invented excerpt"}, {"replacement": ""}])
def test_unverifiable_review_is_rejected(change):
    edit = {"category": "fact", "reason": "誤記", "page": 2, "evidence": "The source provides an enclosing bound.",
            "original": "Draft text", "replacement": "Corrected text"} | change

    class Provider:
        def generate(self, *_):
            return json.dumps({"edits": [edit]})

    with pytest.raises(ValueError, match="根拠"):
        review_article("Draft text", IDENTITY, [{"page": 2, "text": "The source provides an enclosing bound."}],
                       Provider(), threading.Event(), lambda _: None, lambda text: text)


def test_review_rejects_section_rewrites_and_covers_all_source_chunks():
    requests = []

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            requests.append(request)
            return '{"edits": []}'

    sources = [{"page": page, "text": "x" * 9000} for page in range(1, 4)]
    _, report = review_article("Whole draft", IDENTITY, sources, Provider(), threading.Event(),
                               lambda _: None, lambda text: text)
    assert len(requests) == 3
    assert [{"page": p["page"], "text": p["text"]} for request in requests for p in request["source_pages"]] == sources
    assert all(request["article"] == "Whole draft" for request in requests)
    assert report["source_pages"] == [1, 2, 3]

    class LongEdit:
        def generate(self, *_):
            return json.dumps({"edits": [{"category": "fact", "reason": "誤記", "page": 2,
                "evidence": "Source evidence", "original": "Whole draft", "replacement": "x" * 2401}]})

    with pytest.raises(ValueError, match="長すぎ"):
        review_article("Whole draft", IDENTITY, [{"page": 2, "text": "Source evidence"}], LongEdit(),
                       threading.Event(), lambda _: None, lambda text: text)


def test_review_retries_bad_format_once_without_applying_partial_edits():
    class Provider:
        calls = 0

        def generate(self, instruction, data, schema):
            self.calls += 1
            if self.calls == 1:
                return "invalid JSON"
            assert "previous_response_error" in json.loads(data)
            assert "Escape every backslash" in json.loads(data)["response_format_hint"]
            assert json.loads(data)["article"] == "Original draft"
            return '{"edits": []}'

    provider = Provider()
    result, report = review_article("Original draft", IDENTITY, [{"page": 2, "text": "Source content"}],
                                    provider, threading.Event(), lambda _: None, lambda text: text)
    assert provider.calls == 2 and result == "Original draft" and report["edits"] == []


@pytest.mark.parametrize(("source", "evidence"), [
    ("bounds corresponding to each sub-\nbox.", "bounds corresponding to each sub-box."),
    ("the reach-\nable set of a sub-\nbox", "the reachable set of a sub-box"),
    ("An efﬁcient polynomial bound.", "An efficient polynomial bound.")])
def test_verbatim_evidence_allows_pdf_wrapping_and_latin_ligatures(source, evidence):
    class Provider:
        def generate(self, *_):
            return json.dumps({"edits": [{"category": "guarantee", "reason": "近似の範囲", "page": 2,
                "evidence": evidence, "original": "Draft",
                "replacement": "Polynomial approximation bounds."}]})

    text, _ = review_article("Draft", IDENTITY, [{"page": 2, "text": source}],
                            Provider(), threading.Event(), lambda _: None, lambda text: text)
    assert text == "Polynomial approximation bounds."


@pytest.mark.parametrize(("source", "quote"), [("the re-sign operation", "the resign operation"),
    ("the resign operation", "the re-sign operation"), ("the bound is 1-\n2", "the bound is 12"),
    ("the bound is x²", "the bound is x2")])
def test_quote_normalization_never_changes_real_hyphens_numbers_or_math(source, quote):
    assert not _grounded_quote(quote, source)


def test_edits_resolve_locations_in_immutable_draft_and_reject_overlaps():
    def change(original, replacement):
        return dict(category="fact", reason="条件確認", original=original, replacement=replacement,
                    page=2, evidence="The source provides an enclosing bound.")

    source = [{"page": 2, "text": "The source provides an enclosing bound."}]
    article, _ = _apply_edits("First sentence. Second sentence.",
        {"edits": [change("First sentence.", "Keep Second sentence. here."),
                   change("Second sentence.", "Correct second.")]}, source, lambda text: text)
    assert article == "Keep Second sentence. here. Correct second."
    with pytest.raises(ValueError, match="重複"):
        _apply_edits("First sentence. Second sentence.",
            {"edits": [change("First sentence.", "Updated."), change("First sentence. Second", "Other.")]},
            source, lambda text: text)

    with pytest.raises(ValueError, match="修正箇所"):
        _apply_edits("First sentence.",
            {"edits": [change("First sentence.", "New phrase."), change("New phrase.", "Not an original excerpt.")]},
            source, lambda text: text)


def test_rendered_prose_anchor_can_omit_only_balanced_strong_markers():
    article = "**Dempster–Shafer構造**は集合に質量を割り当てる。次の文。"
    plain = "Dempster–Shafer構造は集合に質量を割り当てる。"
    location = _excerpt_span(article, plain)
    assert location == (0, article.index("次の文"))
    answer = {"edits": [dict(category="omission", reason="条件を追加", original=plain, replacement="正規化された構造を扱う。",
                             page=2, evidence="The paper uses normalized belief structures.")]}
    revised, applied = _apply_edits(article, answer, [{"page": 2, "text": "The paper uses normalized belief structures."}], lambda text: text)
    assert revised == "正規化された構造を扱う。次の文。"
    assert applied[0]["original"].startswith("**Dempster")
    assert _excerpt_span(article + article, plain) is None
    assert _excerpt_span(article, plain.replace("–", "-")) is None
    assert _excerpt_span(article, plain.replace("構造", "理論")) is None
    assert _excerpt_span("**long term** suffix", "term suffix") is None
    for protected in ["`x**a**`", "$x**a**$", "\\(x**a**\\)", "```\nx**a**\n```"]:
        assert _excerpt_span(protected, "xa") is None


def test_bad_references_fail_after_one_repair_and_keep_existing_summary(tmp_path):
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    files = PaperFiles(library.folder(identity))
    files.article_md.write_text("Previous verified article", "utf-8")

    class Provider:
        calls = 0

        def generate(self, *_):
            self.calls += 1
            return f"Invalid ![Figure](media/image1.png) [{identity}:p1]"

    provider = Provider()
    with pytest.raises(ValueError, match="画像・引用"):
        PaperService(library, provider, threading.Event()).article(identity)
    assert provider.calls == 3
    assert files.article_md.read_text("utf-8") == "Previous verified article"
    assert not files.article_review.exists()


def test_successful_review_report_matches_saved_summary_and_cancel_prevents_publish(tmp_path):
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    files = PaperFiles(library.folder(identity))
    cancel = threading.Event()

    class Provider:
        def generate(self, instruction, data, schema=None):
            return clean_summary_response(data) if schema else f"Summary [{identity}:p1]"

    # This test concerns reviews, independent of the fixture's diagrams.
    from unittest.mock import patch
    with patch("papeer.core.service.summary_figures", return_value=[]):
        article = PaperService(library, Provider(), cancel).article(identity)
    report = json.loads(files.article_review.read_text("utf-8"))
    assert report["article_sha256"] == hashlib.sha256(article.encode()).hexdigest()
    assert report["reference_checks"] == "passed" and report["source_pages"] == [1, 2]
    cancel.set()
    with pytest.raises(Cancelled):
        PaperService(library, Provider(), cancel).article(identity)
    assert files.article_md.read_text("utf-8") == article
