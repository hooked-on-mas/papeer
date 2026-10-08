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
from papeer.core.terminology import effective_glossary, global_glossary, paper_domains, paper_glossary
from papeer.core.terminology_feedback import apply_replacement, replacement_preview
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
