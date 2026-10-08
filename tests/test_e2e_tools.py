"""The helpers of the end-to-end tests (frontend/e2e): the stand-in AI and the synthetic PDFs."""
from __future__ import annotations

import json

import pymupdf

from tools import e2e_pdfs
from tools.e2e_stub_ai import answer, domains_answer, glossary_answer
from tools.smoke_sidecar import SCHEMA_MARKER


def test_glossary_answer_takes_long_words_of_the_source_once_each():
    data = json.dumps({"source": "Adaptive control of adaptive systems with robust estimator gradient.", "existing_terms": []})
    terms = json.loads(glossary_answer(data))["terms"]
    assert [t["source"] for t in terms] == ["Adaptive", "control", "systems", "estimator", "gradient"]
    assert [t["target"] for t in terms] == ["訳語1", "訳語2", "訳語3", "訳語4", "訳語5"]


def test_answer_tells_glossary_translation_and_other_requests_apart():
    glossary = [{"content": "Build a glossary"}, {"content": json.dumps({"source": "tracking", "existing_terms": []})}]
    assert answer(glossary)[0] == "glossary"
    units = [{"id": "p1-b1", "text": "Hello"}]
    kind, content = answer([{"content": f"Translate. {SCHEMA_MARKER}"}, {"content": json.dumps({"blocks": units})}])
    assert kind == "translation"
    assert [t["id"] for t in json.loads(content)["translations"]] == ["p1-b1"]
    assert answer([{"content": "Summarize"}, {"content": "text"}])[0] == "other"


def test_answer_chooses_no_domains_and_splits_nothing():
    select = [{"content": "Choose"}, {"content": json.dumps({"paper": {"title": "T"}, "available_domains": [{"name": "電池"}]})}]
    kind, content = answer(select)
    assert kind == "domains"
    assert json.loads(content) == {"domains": [], "new_domain": None, "allowed_terms": []}
    split = [{"content": "Split"}, {"content": json.dumps({"domain": "共通", "terms": [], "existing_domains": []})}]
    kind, content = answer(split)
    assert kind == "domains"
    assert json.loads(content) == {"domains": []}
    assert json.loads(domains_answer('{"available_domains": []}'))["new_domain"] is None


def test_pdfs_are_two_column_papers_with_their_titles(tmp_path):
    assert e2e_pdfs.main([str(tmp_path)]) == 0
    for name, title, pages in e2e_pdfs.PAPERS:
        with pymupdf.open(tmp_path / name) as pdf:
            assert pdf.page_count == pages
            assert pdf.metadata["title"] == title
            assert title in pdf[0].get_text()
            assert len(pdf.get_toc()) == pages
