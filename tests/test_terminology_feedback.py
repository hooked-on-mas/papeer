"""Post-reading corrections keep PDFs, search and future preferences coherent without new AI calls."""
import json
import threading
from types import SimpleNamespace

import pytest

from papeer.core.automatic_terminology import prepare_terminology
from papeer.core.errors import Conflict, Invalid
from papeer.core.glossary_domains import select_domains
from papeer.core.paragraph_revisions import adopt_revision, revision_history, translation_paragraphs
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService, cached_page_texts
from papeer.core.terminology import (effective_glossary, global_glossary, paper_domains, paper_glossary,
                                     save_global_glossary, save_paper_glossary)
from papeer.core.terminology_feedback import apply_replacement, replacement_preview, term_card
from papeer.core.terminology_research import research_term, trusted_usage_url
from papeer.providers import Cancelled
from test_large_json import make_paper
from test_workflow import FakeProvider


class TermProvider(FakeProvider):
    def generate(self, instruction, data, schema=None):
        self.calls += 1
        payload = json.loads(data)
        if schema and "domain" in schema["properties"]:
            return json.dumps({"domain": "強化学習", "terms": [{"source": "policy", "target": "ポリシー"},
                {"source": "absent term", "target": "不存在語"}]})
        if schema and "allowed_terms" in schema["properties"]:
            return json.dumps({"domains": ["強化学習"], "new_domain": None, "allowed_terms": [0]})
        return json.dumps({"translations": [{"id": u["id"], "text": "ポリシーを比較する。"}
            for u in payload["blocks"]]}, ensure_ascii=False)


def test_automatic_choices_are_pinned_before_parallel_translation_and_user_corrections_win(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy improves control."]])
    provider = TermProvider()
    prepare_terminology(lib, paper, provider, threading.Event(), lambda _: None)
    assert effective_glossary(lib, paper) == [{"source": "policy", "target": "ポリシー"}]
    assert global_glossary(lib.root) == []
    assert paper_glossary(lib.root, paper)["terms"] == []
    assert paper_domains(lib.root, paper)["new_domain"] == "強化学習"
    prepare_terminology(lib, paper, provider, threading.Event(), lambda _: None)
    assert provider.calls == 1
    PaperService(lib, provider, threading.Event()).translate(paper)
    preview = replacement_preview(lib, paper, "policy", "ポリシー", "方策")
    calls = provider.calls
    result = apply_replacement(lib, paper, "policy", "ポリシー", "方策", preview["key"],
        [c["id"] for c in preview["changes"]], "shared", provider, threading.Event(), lambda _: None, lambda *_: None)
    assert result == {"changed": 1, "remember": "shared"}
    assert provider.calls == calls
    assert effective_glossary(lib, paper) == [{"source": "policy", "target": "方策"}]
    assert global_glossary(lib.root) == [{"source": "policy", "target": "方策", "domain": "強化学習"}]
    # "shared" keeps this paper's own choice too, as "paper" does.
    assert paper_glossary(lib.root, paper)["terms"] == [{"source": "policy", "target": "方策"}]
    assert "方策" in translation_paragraphs(lib, paper)[0]["text"]
    assert "方策" in cached_page_texts(lib.folder(paper), lib.document(paper))[1][0]
    # A new paper uses the remembered preference only after its meaning is approved.
    second, _ = lib.import_pdf(make_other_pdf(tmp_path))
    select_domains(lib, second, provider, threading.Event())
    assert effective_glossary(lib, second) == [{"source": "policy", "target": "方策"}]


def make_other_pdf(tmp_path):
    import pymupdf as fitz
    path = tmp_path / "other.pdf"
    with fitz.open() as pdf:
        pdf.new_page().insert_text((40, 70), "A policy learns actions for a new task.")
        pdf.save(path)
    return path


def test_bulk_replacement_is_source_scoped_and_can_be_undone_without_ai(tmp_path):
    lib, paper = make_paper(tmp_path, [["The policy controls actions."], ["Other content unrelated to this term."]])
    provider = TermProvider()
    PaperService(lib, provider, threading.Event()).translate(paper)
    before = translation_paragraphs(lib, paper)
    preview = replacement_preview(lib, paper, "policy", "ポリシー", "方策")
    assert len(preview["changes"]) == 1
    change = preview["changes"][0]
    calls = provider.calls
    apply_replacement(lib, paper, "policy", "ポリシー", "方策", preview["key"], [change["id"]], "paper",
                      provider, threading.Event(), lambda _: None, lambda *_: None)
    after = translation_paragraphs(lib, paper)
    assert after[0]["text"] == "方策を比較する。"
    assert after[1] == before[1]
    assert provider.calls == calls
    import pymupdf as fitz
    with fitz.open(PaperFiles(lib.folder(paper)).translated_pdf) as pdf:
        assert "方策" in pdf[0].get_text()
        assert "ポリシー" in pdf[1].get_text()
    assert "方策" in PaperFiles(lib.folder(paper)).translation_md.read_text("utf-8")
    assert revision_history(lib.folder(paper))[-1]["before"] == before[0]["text"]
    adopt_revision(lib, paper, change["id"], change["text"], provider, threading.Event(), lambda _: None,
                   lambda *_: None, expected_text=change["after"])
    assert translation_paragraphs(lib, paper)[0]["text"] == before[0]["text"]
    assert provider.calls == calls
    assert paper_glossary(lib.root, paper)["terms"] == [{"source": "policy", "target": "方策"}]


def test_stale_preview_refuses_writes_and_unselected_paragraphs_stay(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy learns."], ["Another policy learns."]])
    provider = TermProvider()
    PaperService(lib, provider, threading.Event()).translate(paper)
    preview = replacement_preview(lib, paper, "policy", "ポリシー", "方策")
    apply_replacement(lib, paper, "policy", "ポリシー", "方策", preview["key"], [preview["changes"][0]["id"]],
                      "none", provider, threading.Event(), lambda _: None, lambda *_: None)
    texts = [p["text"] for p in translation_paragraphs(lib, paper)]
    assert texts == ["方策を比較する。", "ポリシーを比較する。"]
    with pytest.raises(Conflict):
        apply_replacement(lib, paper, "policy", "ポリシー", "方策", preview["key"], [], "shared",
                          provider, threading.Event(), lambda _: None, lambda *_: None)
    assert global_glossary(lib.root) == []


def test_formula_markers_and_nonmatching_senses_are_protected(monkeypatch):
    marker = "[[PD_MATH_policy_0]]"
    paragraphs = [{"id": "a", "pages": [1], "source": f"A policy has {marker}.", "text": f"policy is {marker}."},
                  {"id": "b", "pages": [2], "source": "The policymaker acts.", "text": "policy"}]
    monkeypatch.setattr("papeer.core.terminology_feedback.translation_paragraphs", lambda *_: paragraphs)
    monkeypatch.setattr("papeer.core.terminology_feedback.effective_glossary", lambda *_: [])
    result = replacement_preview(None, "p", "policy", "policy", "方策")
    assert result["changes"][0]["after"] == f"方策 is {marker}."
    assert len(result["changes"]) == 1
    with pytest.raises(Invalid):
        replacement_preview(None, "p", "policy", marker, "方策")


def test_remember_only_and_existing_translation_resume_do_not_call_ai(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy learns."]])
    provider = TermProvider()
    PaperService(lib, provider, threading.Event()).translate(paper)
    calls = provider.calls
    prepare_terminology(lib, paper, provider, threading.Event(), lambda _: None)
    assert provider.calls == calls
    preview = replacement_preview(lib, paper, "policy", "ない訳語", "方策")
    assert preview["changes"] == []
    result = apply_replacement(lib, paper, "policy", "ない訳語", "方策", preview["key"], [], "paper",
                              provider, threading.Event(), lambda _: None, lambda *_: None)
    assert result["changed"] == 0
    assert "ポリシー" in translation_paragraphs(lib, paper)[0]["text"]
    assert provider.calls == calls


def test_cancelled_automatic_preparation_does_not_pin_partial_choices(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy learns."]])
    cancel = threading.Event(); cancel.set()
    with pytest.raises(Cancelled):
        prepare_terminology(lib, paper, TermProvider(), cancel, lambda _: None)
    assert not PaperFiles(lib.folder(paper)).automatic_glossary.exists()


@pytest.mark.parametrize("url", ["https://translate.google.com/", "https://www.deepl.com/translator",
    "https://example.com/glossary", "https://u.ac.jp.evil.com/article", "https://u.ac.jp/translate?url=paper",
    "https://user:password@u.ac.jp/article", "javascript:alert(1)"])
def test_untrusted_translation_and_spoofed_source_urls_are_rejected(url):
    assert trusted_usage_url(url) == ""


def test_web_lookup_requires_actual_japanese_usage_in_trusted_evidence(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy learns."]])
    class WebProvider:
        spec = SimpleNamespace(web_search=True)
        def search_web(self, instruction, data, schema):
            assert "Never use machine translation" in instruction
            assert json.loads(data)["contexts"]
            return json.dumps({"candidates": [
                {"target": "方策", "explanation": "学習する方策の文脈。", "sources": [
                    {"title": "大学の講義資料", "url": "https://rl.example.ac.jp/lecture.pdf", "quote": "方策に従い行動を選択する。"}]},
                {"target": "政策", "explanation": "自動翻訳", "sources": [
                    {"title": "翻訳サイト", "url": "https://translate.google.com/", "quote": "政策"}]},
                {"target": "ポリシー", "explanation": "出典にない", "sources": [
                    {"title": "大学", "url": "https://rl.example.ac.jp/lecture.pdf", "quote": "行動を選択する。"}]}]})
    result = research_term(lib, paper, "policy", WebProvider(), threading.Event())
    assert [c["target"] for c in result["candidates"]] == ["方策"]
    assert global_glossary(lib.root) == []


def _paragraph(i, source, text):
    return {"id": f"u{i}", "pages": [1], "source": source, "text": text}


def test_term_card_finds_the_translation_in_use_and_how_other_paragraphs_render_it(monkeypatch):
    paragraphs = [_paragraph(i, "The policy is learned.", "方策を学習し評価する。ネットワークを使う。") for i in range(5)]
    paragraphs += [_paragraph(10 + i, "A policy is evaluated.", "ポリシーを評価する。ネットワークを使う。") for i in range(3)]
    paragraphs += [_paragraph(20, "Policy as written.", "policy をそのまま残す。")]
    paragraphs += [_paragraph(30 + i, "Network design.", "ネットワークを設計する。") for i in range(4)]
    monkeypatch.setattr("papeer.core.terminology_feedback.translation_paragraphs", lambda *_: paragraphs)
    monkeypatch.setattr("papeer.core.terminology_feedback.effective_glossary",
                        lambda *_: [{"source": "policy", "target": "方策"}, {"source": "network", "target": "ネットワーク"}])
    monkeypatch.setattr("papeer.core.terminology_feedback.global_glossary", lambda *_: [])
    lib = SimpleNamespace(root=None)
    for text, side in (("policy", "original"), ("方策", "translated")):
        card = term_card(lib, "p", text, side)
        assert (card["source"], card["current"], card["count"], card["missing"]) == ("policy", "方策", 5, 4)
        assert card["candidates"] == []
        assert [(v["text"], v["count"]) for v in card["variants"]] == [("ポリシー", 3), ("policy", 1)]
    # A phrase holding two glossary terms is ambiguous: one card each, nothing chosen.
    ambiguous = term_card(lib, "p", "policy network", "original")
    assert ambiguous["source"] == "" and [c["source"] for c in ambiguous["candidates"]] == ["policy", "network"]
    # Unknown words give back what the selection tells, and no counts or variants.
    assert term_card(lib, "p", "reward", "original") == {"source": "reward", "current": "", "count": 0, "missing": 0,
                                                         "variants": [], "dictionary": [], "candidates": [],
                                                         "source_candidates": []}
    assert term_card(lib, "p", "報酬", "translated")["current"] == "報酬"
    assert term_card(lib, "p", "  ", "original")["source"] == ""


def test_term_card_counts_paragraphs_of_a_saved_translation_without_ai(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy learns."], ["Another policy learns."]])
    provider = TermProvider()
    PaperService(lib, provider, threading.Event()).translate(paper)
    preview = replacement_preview(lib, paper, "policy", "ポリシー", "方策")
    apply_replacement(lib, paper, "policy", "ポリシー", "方策", preview["key"], [preview["changes"][0]["id"]],
                      "paper", provider, threading.Event(), lambda _: None, lambda *_: None)
    calls = provider.calls
    card = term_card(lib, paper, "方策", "translated")
    assert (card["source"], card["count"], card["missing"]) == ("policy", 1, 1)
    # One paragraph is too few to tell wording apart statistically; the paragraph is only counted.
    assert card["variants"] == []
    assert provider.calls == calls


def test_term_card_with_many_matches_counts_cheaply_and_works_out_wording_for_one_term(monkeypatch):
    names = [f"term{i}" for i in range(12)]
    paragraphs = [_paragraph(i, " ".join(names) + " appear here.", "用語" * 100 + "ポリシー") for i in range(300)]
    terms = [{"source": name, "target": "ポリシー"} for name in names]
    monkeypatch.setattr("papeer.core.terminology_feedback.translation_paragraphs", lambda *_: paragraphs)
    monkeypatch.setattr("papeer.core.terminology_feedback.effective_glossary", lambda *_: terms)
    monkeypatch.setattr("papeer.core.terminology_feedback.global_glossary", lambda *_: [])
    from papeer.core import terminology_feedback as feedback
    prepared, wording = [], []
    real_prepare, real_variants = feedback.prepare_search, feedback._variants
    monkeypatch.setattr(feedback, "prepare_search", lambda text: prepared.append(text) or real_prepare(text))
    monkeypatch.setattr(feedback, "_variants", lambda *args: wording.append(args[1]["source"]) or real_variants(*args))
    # Twelve terms match the translated word: counts for the six most used, no wording work, each text normalized once.
    card = term_card(SimpleNamespace(root=None), "p", "ポリシー", "translated")
    assert card["source"] == "" and len(card["candidates"]) == 6
    assert all(c["variants"] == [] and c["count"] == 300 for c in card["candidates"])
    assert wording == [] and len(prepared) == len(paragraphs)
    # One chosen term: its wording is worked out, once.
    prepared.clear()
    card = term_card(SimpleNamespace(root=None), "p", "term3", "original")
    assert card["source"] == "term3" and wording == ["term3"] and len(prepared) == len(paragraphs)


def _stub_paper(monkeypatch, paragraphs, terms, shared=()):
    """A paper whose translation, effective glossary and shared dictionary are given."""
    monkeypatch.setattr("papeer.core.terminology_feedback.translation_paragraphs", lambda *_: paragraphs)
    monkeypatch.setattr("papeer.core.terminology_feedback.effective_glossary", lambda *_: terms)
    monkeypatch.setattr("papeer.core.terminology_feedback.global_glossary", lambda *_: list(shared))
    return SimpleNamespace(root=None)


def test_term_card_variants_include_the_dictionarys_other_translations_and_show_its_entries(monkeypatch):
    paragraphs = [_paragraph(1, "A policy.", "方策を使う。"), _paragraph(2, "The policy.", "政策を使う。")]
    shared = [{"source": "policy", "target": "政策", "domain": "経済"}, {"source": "Policy", "target": "ポリシー"}]
    lib = _stub_paper(monkeypatch, paragraphs, [{"source": "policy", "target": "方策"}], shared)
    card = term_card(lib, "p", "policy", "original")
    # One paragraph is too few for wording statistics: the entry of the dictionary is what names the variant.
    assert (card["count"], card["missing"]) == (1, 1)
    assert card["variants"] == [{"text": "政策", "count": 1}]
    assert card["dictionary"] == [{"target": "政策", "domain": "経済"}, {"target": "ポリシー", "domain": ""}]


def test_term_card_with_every_paragraph_using_the_translation_has_no_missing_and_no_variants(monkeypatch):
    paragraphs = [_paragraph(i, "The policy.", "方策を使う。") for i in range(3)]
    lib = _stub_paper(monkeypatch, paragraphs, [{"source": "policy", "target": "方策"}])
    card = term_card(lib, "p", "方策", "translated")
    assert (card["count"], card["missing"], card["variants"]) == (3, 0, [])


def test_term_card_ignores_formula_markers_and_matches_full_width_and_line_breaks(monkeypatch):
    marker = "[[PD_MATH_q_0]]"
    paragraphs = [_paragraph(1, f"The Q-learning {marker} agent.", f"Ｑ学習 {marker} を使う。"),
                  _paragraph(2, "Q-learning is old.", "Q学習は古い。"),
                  _paragraph(3, "Q-learning again.", "別の手法。")]
    lib = _stub_paper(monkeypatch, paragraphs, [{"source": "Q-learning", "target": "Q学習"}])
    # Full-width and half-width forms are one translation; a selection broken over lines is one phrase.
    for text, side in (("Q学習", "translated"), ("Ｑ学習", "translated"), ("Q-learning", "original"), ("Q-\nlearning", "original")):
        card = term_card(lib, "p", text, side)
        assert (card["source"], card["current"], card["count"], card["missing"]) == ("Q-learning", "Q学習", 2, 1), (text, card)
    # A selection that is only a formula marker names nothing.
    assert term_card(lib, "p", marker, "translated")["current"] == ""


def test_term_card_names_the_original_wording_of_an_unregistered_translation(monkeypatch):
    paragraphs = [_paragraph(i, f"The learned policy improves control in task {i}.", "政策を学習する。") for i in range(4)]
    paragraphs += [_paragraph(10 + i, f"The network is deep in task {i}.", "ネットワークは深い。") for i in range(6)]
    lib = _stub_paper(monkeypatch, paragraphs, [{"source": "network", "target": "ネットワーク"}])
    card = term_card(lib, "p", "政策", "translated")
    assert (card["source"], card["current"], card["count"]) == ("", "政策", 4)
    texts = [c["text"] for c in card["source_candidates"]]
    assert "policy" in texts and "network" not in texts and "task" not in texts
    assert {"text": "policy", "count": 4} in card["source_candidates"]
    # A dictionary source that most of them hold is named as the dictionary spells it.
    lib = _stub_paper(monkeypatch, paragraphs, [{"source": "Policy", "target": "方策"}, {"source": "network", "target": "ネットワーク"}])
    assert {"text": "Policy", "count": 4} in term_card(lib, "p", "政策", "translated")["source_candidates"]
    # One paragraph cannot tell the term from the rest of its sentence.
    lib = _stub_paper(monkeypatch, paragraphs[:1], [])
    assert term_card(lib, "p", "政策", "translated")["source_candidates"] == []


def test_term_card_counts_each_spelling_of_the_untranslated_source_as_it_appears(monkeypatch):
    paragraphs = [_paragraph(1, "A policy.", "方策を使う。")]
    paragraphs += [_paragraph(2 + i, "The policy.", "Policy を使う。") for i in range(3)]
    paragraphs += [_paragraph(10, "The policy.", "policy を使う。")]
    lib = _stub_paper(monkeypatch, paragraphs, [{"source": "policy", "target": "方策"}])
    card = term_card(lib, "p", "policy", "original")
    assert (card["count"], card["missing"]) == (1, 4)
    # "Policy" is replaced as written: its button names that spelling, with that spelling's paragraphs.
    assert {"text": "Policy", "count": 3} in card["variants"] and {"text": "policy", "count": 1} in card["variants"]


def _seeded_paper(tmp_path):
    lib, paper = make_paper(tmp_path, [["A policy learns."], ["Another policy learns."]])
    provider = TermProvider()
    prepare_terminology(lib, paper, provider, threading.Event(), lambda _: None)
    PaperService(lib, provider, threading.Event()).translate(paper)
    return lib, paper, provider


def _apply(lib, paper, provider, remember, before="ポリシー", target="方策"):
    preview = replacement_preview(lib, paper, "policy", before, target)
    return apply_replacement(lib, paper, "policy", before, target, preview["key"], [c["id"] for c in preview["changes"]],
                             remember, provider, threading.Event(), lambda _: None, lambda *_: None)


def test_remembering_a_replacement_overwrites_the_papers_own_choice_and_keeps_its_other_settings(tmp_path):
    lib, paper, provider = _seeded_paper(tmp_path)
    save_paper_glossary(lib.root, paper, [{"source": "policy", "target": "古い訳"}, {"source": "reward", "target": "報酬"}],
                        ["noise", "other"], {"terms": [], "dismissed": []})
    _apply(lib, paper, provider, "paper", before="ポリシー")
    saved = paper_glossary(lib.root, paper)
    assert saved["terms"] == [{"source": "reward", "target": "報酬"}, {"source": "policy", "target": "方策"}]
    assert saved["dismissed"] == ["noise", "other"]
    assert global_glossary(lib.root) == []


def test_sharing_a_replacement_overwrites_only_the_same_source_in_the_same_domain(tmp_path):
    lib, paper, provider = _seeded_paper(tmp_path)
    assert paper_domains(lib.root, paper)["new_domain"] == "強化学習"
    save_global_glossary(lib.root, [{"source": "policy", "target": "旧訳", "domain": "強化学習"},
                                    {"source": "policy", "target": "別分野の訳", "domain": "経済"},
                                    {"source": "reward", "target": "報酬", "domain": "強化学習"}])
    _apply(lib, paper, provider, "shared")
    assert global_glossary(lib.root) == [{"source": "policy", "target": "方策", "domain": "強化学習"},
                                         {"source": "policy", "target": "別分野の訳", "domain": "経済"},
                                         {"source": "reward", "target": "報酬", "domain": "強化学習"}]
    # The paper keeps the choice as its own too.
    assert paper_glossary(lib.root, paper)["terms"] == [{"source": "policy", "target": "方策"}]
