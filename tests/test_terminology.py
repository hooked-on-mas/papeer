"""How glossary terms are found in source texts, and the check of their renderings after translation."""
from __future__ import annotations

import json
import threading

import pymupdf as fitz
import pytest

from papeer.core.config import Settings
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core import search
from papeer.core.terminology import (apply_glossary, glossary_warnings, kept_glossary_warnings, matching_terms,
                                     missing_renderings, save_global_glossary)
from papeer.layout.math_layout import MATH_TOKEN
from papeer.translation.translation import page_fingerprint


def found(source: str, text: str) -> bool:
    return bool(matching_terms(text, [{"source": source, "target": "訳"}]))


@pytest.mark.parametrize("source, text", [
    ("RL", "We train the agent with RL."),
    ("RL", "RL-based controllers"),
    ("RL", "Two RLs and LLMs"),
    ("MPC", "Nonlinear MPCs are used."),
    ("GPT-4", "compared with GPT-4."),
    ("reinforcement learning", "Reinforcement\nLearning is"),
    ("predictive control", "model predic-\ntive control"),
    ("predictive control", "model predic­\ntive  control"),
    ("model-based", "a model-\nbased method"),
    ("neural network", "deep neural\n  networks"),
    ("policy", "the learned policies"),
    ("process", "Gaussian processes"),
    ("key", "the keys"),
    ("filter", "Kalman ﬁlters"),
    ("C++", "written in C++."),
    ("k-NN (baseline)", "the k-NN (baseline) method"),
    ("強化学習", "深層強化\n学習では"),
    ("ＲＬ", "the RL agent"),
    ("GPT-4", "GPT-4. It is"),
    ("5G", "5G, 4G"),
])
def test_terms_are_found_across_lines_hyphens_plurals_and_width(source, text):
    assert found(source, text)


@pytest.mark.parametrize("source, text", [
    ("RL", "the world is early"),
    ("RL", "RLHF improves"),
    ("RL", "rl in lower case is not the abbreviation"),
    ("MPC", "mpc"),
    ("GPT-4", "GPT-4o"),
    ("state", "the statement was estated"),
    ("action", "a fraction of the transaction"),
    ("gain", "again and against"),
    ("PID", "a rapid response"),
    ("a.b", "axb"),
    ("tracking error", "tracking [[PD_MATH_p1b2_0]] error"),
    ("policy", "policymaker"),
    ("RL", "RLS estimator"),  # Recursive least squares, not the plural of RL.
    ("GP", "GPS receiver"),
    ("PC", "PCS"),
    ("state", "the state_space variable"),
    ("GPT-4", "GPT-4.5 is newer"),
    ("5G", "2.5G networks"),
])
def test_terms_are_not_found_inside_other_words_or_in_other_case(source, text):
    assert not found(source, text)


def test_formula_markers_are_not_searched():
    assert not found("PD", "[[PD_MATH_p1b2_0]]")
    assert not found("MATH", "see [[PD_MATH_p1b2_0]]")


def test_matches_keep_the_glossary_entries_and_order_so_the_same_set_keeps_the_page_fingerprint():
    glossary = [{"source": "observer", "target": "オブザーバ"}, {"source": "adaptive controller", "target": "適応制御器"},
                {"source": "RL", "target": "強化学習"}]
    forward = [{"id": "a", "block": "a", "page": 1, "text": "The adaptive controller feeds the observer."}]
    backward = [{"id": "a", "block": "a", "page": 1, "text": "The observer feeds the adaptive\ncontrollers."}]
    apply_glossary(forward, glossary)
    apply_glossary(backward, glossary)
    # In the glossary's order, as the glossary has them (not in the order of the text).
    assert forward[0]["glossary"] == backward[0]["glossary"] == glossary[:2]
    assert forward[0]["glossary"][0] is glossary[0]
    # As the previous matching (casefolded substring) gave it for the same set of terms: pages
    # whose terms did not change keep their saved translations.
    old = [{"id": "a", "block": "a", "page": 1, "text": forward[0]["text"],
            "glossary": [item for item in glossary if item["source"].casefold() in forward[0]["text"].casefold()]}]
    assert page_fingerprint(forward) == page_fingerprint(old)
    # A unit without terms has no glossary field, as before.
    plain = [{"id": "b", "block": "b", "page": 1, "text": "The world is round."}]
    apply_glossary(plain, glossary)
    assert "glossary" not in plain[0]


@pytest.mark.parametrize("target, translation", [
    ("適応制御器", "適応制御器を用いる。"),
    ("ＲＬ", "RLで学習する。"),
    ("Transformer", "transformerを用いる。"),
    ("強化学習", "強化 学習を用いる。"),
    ("コンピューター", "コンピュータで計算する。"),
    ("モンテカルロ法", "モンテ・カルロ法で求める。"),
    ("割り当て", "資源の割当を決める。"),
    ("割当", "資源の割り当てを決める。"),
    ("取扱", "取り扱いに注意する。"),
    ("方策（ポリシー）", "ポリシーを更新する。"),
    ("方策（ポリシー）", "方策を更新する。"),
    ("方策／ポリシー", "ポリシーを更新する。"),
    ("オブザーバ、観測器", "観測器を設計する。"),
])
def test_spelling_differences_of_a_rendering_are_not_reported(target, translation):
    unit = {"glossary": [{"source": "term", "target": target}]}
    assert missing_renderings(unit, translation) == []


def test_missing_renderings_and_the_report_entries():
    terms = [{"source": "policy", "target": "方策"}, {"source": "observer", "target": "オブザーバ"}]
    unit = {"id": "p2b1_0", "page": 2, "text": f"The policy uses the observer {'[[PD_MATH_p2b1_0]]'} and\nmore.",
            "glossary": terms}
    assert missing_renderings(unit, "オブザーバはポリシーを使う。") == [terms[0]]
    assert missing_renderings(unit, "オブザーバは方策を使う。") == []
    assert glossary_warnings([unit], {"p2b1_0": "ポリシーはオブザーバを使う。"}) == [
        {"page": 2, "unit": "p2b1_0", "excerpt": "The policy uses the observer and more.",
         "terms": [{"source": "policy", "target": "方策"}]}]
    assert glossary_warnings([unit], {"p2b1_0": "方策はオブザーバを使う。"}) == []


def test_kept_warnings_hold_only_the_terms_the_current_glossary_still_finds():
    warning = {"page": 1, "unit": "a", "excerpt": "The policy and the observer.",
               "terms": [{"source": "policy", "target": "方策"}, {"source": "observer", "target": "オブザーバ"}]}
    unit = {"id": "a", "page": 1, "text": warning["excerpt"],
            "glossary": [{"source": "policy", "target": "方策"}, {"source": "observer", "target": "観測器"}]}
    # The rendering of observer changed since: its warning named another rendering.
    assert kept_glossary_warnings([warning], {"a": unit}) == [{**warning, "terms": [warning["terms"][0]]}]
    assert kept_glossary_warnings([warning], {"a": {**unit, "glossary": []}}) == []
    assert kept_glossary_warnings([warning, "broken", {"unit": "gone"}], {}) == []


class Provider:
    """Translates every block as 訳 followed by its formula markers: no glossary rendering."""

    def __init__(self):
        self.settings = Settings(translation_concurrency=1)

    def generate(self, instruction, data, schema=None):
        payload = json.loads(data)
        blocks = payload.get("blocks", payload.get("texts", []))
        return json.dumps({"translations": [{"id": u["id"], "text": "訳。" + "".join(MATH_TOKEN.findall(u["text"]))}
                                            for u in blocks]}, ensure_ascii=False)


def test_translation_report_lists_paragraphs_without_the_rendering_until_revised(tmp_path):
    source = tmp_path / "paper.pdf"
    with fitz.open() as pdf:
        for text in ["The adaptive controller keeps the world stable.", "Nothing to check on this page."]:
            pdf.new_page().insert_text((72, 72), text)
        pdf.save(source)
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    save_global_glossary(library.root, [{"source": "adaptive controller", "target": "適応制御器"},
                                        {"source": "RL", "target": "強化学習"}])
    service = PaperService(library, Provider(), threading.Event())
    report = service.translate(identity)
    [warning] = report["glossary_warnings"]
    assert warning["page"] == 1 and warning["terms"] == [{"source": "adaptive controller", "target": "適応制御器"}]
    assert warning["excerpt"].startswith("The adaptive controller")
    # A page not translated in the next run keeps its warning; one translated again is checked again.
    assert service.translate(identity, {2})["glossary_warnings"] == [warning]
    report = service.translate(identity, {1}, replacements={warning["unit"]: "適応制御器は世界を安定に保つ。"})
    assert report["glossary_warnings"] == []
    report = service.translate(identity, {1}, replacements={warning["unit"]: "訳。"})
    assert report["glossary_warnings"] == [warning]
    # A term taken out of the glossary no longer warns on a page kept as it was.
    save_global_glossary(library.root, [{"source": "RL", "target": "強化学習"}])
    assert service.translate(identity, {2})["glossary_warnings"] == []


def test_search_of_the_translation_reads_saved_translations_once_for_all_pages(tmp_path, monkeypatch):
    source = tmp_path / "paper.pdf"
    with fitz.open() as pdf:
        for number in range(1, 4):
            pdf.new_page().insert_text((72, 72), f"The adaptive controller of page {number}.")
        pdf.save(source)
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    save_global_glossary(library.root, [{"source": "adaptive controller", "target": "適応制御器"}])
    PaperService(library, Provider(), threading.Event()).translate(identity)
    # Without translation.md, each page's text comes from the saved translations.
    (library.folder(identity) / "translation.md").unlink()
    calls = []
    original = search.cached_page_texts
    monkeypatch.setattr(search, "cached_page_texts", lambda *args: calls.append(args) or original(*args))
    found = search.search_paper(library, identity, "訳", "translated")
    assert [item["page"] for item in found["results"]] == [1, 2, 3]
    assert len(calls) == 1


DOMAIN_TERMS = [
    {"source": "cell", "target": "セル", "domain": "電池"},
    {"source": "policy", "target": "方策", "domain": "強化学習"},
    {"source": "control", "target": "制御"},
    {"source": "Cell", "target": "細胞", "domain": "生物"},
    {"source": "delay", "target": "遅延", "domain": "強化学習"},
]


def domain_library(tmp_path):
    from papeer.core.terminology import save_paper_domains
    lib = Library(tmp_path / "lib")
    save_global_glossary(lib.root, DOMAIN_TERMS)
    return lib.root, lambda paper, domains, by="user": save_paper_domains(lib.root, paper, domains, None, by, ["電池", "強化学習", "生物"])


def test_effective_glossary_keeps_the_order_takes_the_first_source_and_drops_domains(tmp_path):
    from papeer.core.terminology import glossary_for_folder, domain_names
    root, choose = domain_library(tmp_path)
    folder = root / "papers" / "p1"
    assert domain_names(DOMAIN_TERMS) == ["電池", "強化学習", "生物"]
    # Nothing recorded: the general dictionary and every domain, as before (a repeated source: the first).
    assert glossary_for_folder(folder) == [{"source": t["source"], "target": t["target"]} for t in DOMAIN_TERMS[:3] + DOMAIN_TERMS[4:]]
    choose("p1", ["生物", "強化学習"])
    assert glossary_for_folder(folder) == [{"source": "policy", "target": "方策"}, {"source": "control", "target": "制御"},
                                           {"source": "Cell", "target": "細胞"}, {"source": "delay", "target": "遅延"}]
    choose("p1", [])
    assert glossary_for_folder(folder) == [{"source": "control", "target": "制御"}]
    assert glossary_for_folder(root / "papers" / "p2")[0]["source"] == "cell"


def test_domains_are_recorded_only_when_written_and_the_user_choice_stays(tmp_path):
    import sqlite3
    from papeer.core.terminology import paper_domains, save_paper_domains
    root, choose = domain_library(tmp_path)
    assert paper_domains(root, "p1") is None
    with sqlite3.connect(root / "library.sqlite3") as db:
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='paper_glossary_domains'").fetchone()
    assert save_paper_domains(root, "p1", ["電池"], None, "ai", [], only_if_ai=True)
    assert save_paper_domains(root, "p1", ["生物"], "新分野", "ai", ["電池"], only_if_ai=True)
    choose("p1", ["強化学習"])
    assert not save_paper_domains(root, "p1", ["電池"], None, "ai", [], only_if_ai=True)
    assert paper_domains(root, "p1") == {"domains": ["強化学習"], "new_domain": None, "chosen_by": "user",
                                         "known_domains": ["電池", "強化学習", "生物"]}
    assert save_paper_domains(root, "p2", ["電池"], None, "ai", [], only_if_ai=True)


def test_a_domain_does_not_change_what_a_translation_is_cached_by(tmp_path):
    from papeer.core.terminology import glossary_for_folder
    plain = [{"source": t["source"], "target": t["target"]} for t in DOMAIN_TERMS[:3]]
    root = Library(tmp_path / "lib").root
    units = [{"id": "a", "page": 1, "text": "The cell policy uses control."}]
    before = [dict(u) for u in units]
    apply_glossary(before, plain)
    save_global_glossary(root, DOMAIN_TERMS[:3])
    after = [dict(u) for u in units]
    apply_glossary(after, glossary_for_folder(root / "papers" / "p1"))
    assert after == before and after[0]["glossary"] == plain
    assert page_fingerprint(after) == page_fingerprint(before)


def test_validate_terms_takes_a_domain_and_repeats_by_domain():
    from papeer.core.glossary_draft import validate_terms
    assert validate_terms([{"source": "cell", "target": "セル", "domain": " 電池 "}, {"source": "Cell", "target": "細胞"},
                           {"source": "cell2", "target": "細胞", "domain": "共通"}]) == [
        {"source": "cell", "target": "セル", "domain": "電池"}, {"source": "Cell", "target": "細胞"},
        {"source": "cell2", "target": "細胞"}]
    for bad in ([{"source": "a", "target": "b"}, {"source": "A", "target": "c", "domain": ""}],
                [{"source": "a", "target": "b", "domain": "x"}, {"source": "A", "target": "c", "domain": "x"}],
                [{"source": "a", "target": "b", "domain": "d" * 41}], [{"source": "a", "target": "b", "domain": None}]):
        with pytest.raises(ValueError):
            validate_terms(bad)
