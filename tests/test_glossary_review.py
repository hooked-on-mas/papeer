"""Regressions for context-specific dictionaries and opt-in, paper-only terminology."""
import json
from pathlib import Path
import threading

import pytest
from fastapi.testclient import TestClient

from papeer.core.storage import Library
from papeer.core.glossary_domains import select_domains, split_domain
from papeer.core.glossary_draft import draft_glossary
from papeer.core.terminology import (
    GlossaryConflict, effective_glossary, global_glossary, glossary_scope_key, paper_domains, paper_glossary,
    save_global_glossary, save_paper_domains, save_paper_glossary, term_contexts)


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "lib")
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures/sample.pdf", "")
    with lib.connection() as db:
        db.execute("UPDATE pages SET text=? WHERE paper_id=?",
                   ("Autonomous driving uses trajectory optimization. The slope of the objective is computed. Work continues.", identity))
    return lib, identity


class Provider:
    def __init__(self, answer):
        self.answer = answer
        self.sent = []

    def generate(self, instruction, data, schema):
        self.sent.append(json.loads(data))
        return json.dumps(self.answer)


def test_broad_dictionary_does_not_leak_earthwork_meanings_into_driving(library):
    lib, paper = library
    terms = [{"source": "slope", "target": "法面", "domain": "ロボティクス・建設機械"},
             {"source": "work", "target": "土工", "domain": "ロボティクス・建設機械"},
             {"source": "trajectory optimization", "target": "軌道最適化", "domain": "ロボティクス・建設機械"}]
    save_global_glossary(lib.root, terms)
    # Legacy selections also require a term-level review before applying specialist translations.
    save_paper_domains(lib.root, paper, ["ロボティクス・建設機械"], None, "ai", ["ロボティクス・建設機械"])
    assert effective_glossary(lib, paper) == []
    provider = Provider({"domains": ["ロボティクス・建設機械"], "new_domain": "自動車の自動運転", "allowed_terms": [2, 999]})
    select_domains(lib, paper, provider, threading.Event())
    assert effective_glossary(lib, paper) == [{"source": "trajectory optimization", "target": "軌道最適化"}]
    sent = provider.sent[0]["candidate_terms"]
    assert sent[0]["target"] == "法面" and "objective" in sent[0]["context"]
    assert global_glossary(lib.root) == terms  # Selection does not reorganize the library dictionary.
    before = glossary_scope_key(terms)
    changed = [*terms[:2], {**terms[2], "target": "経路最適化"}]
    assert glossary_scope_key(changed) != before
    save_global_glossary(lib.root, changed)
    assert effective_glossary(lib, paper) == []  # A changed translation cannot borrow the old approval.


def test_manual_domain_choices_stay_fixed_and_are_still_filtered(library):
    lib, paper = library
    terms = [{"source": "slope", "target": "法面", "domain": "土工"}]
    save_global_glossary(lib.root, terms)
    save_paper_domains(lib.root, paper, ["土工"], None, "user", ["土工"])
    provider = Provider({"domains": [], "new_domain": "自動運転", "allowed_terms": []})
    assert select_domains(lib, paper, provider, threading.Event()) == {"domains": ["土工"], "new_domain": None}
    assert provider.sent[0]["fixed_domains"] == ["土工"]
    assert paper_domains(lib.root, paper)["chosen_by"] == "user"
    assert effective_glossary(lib, paper) == []


def test_changed_source_invalidates_term_approval(library):
    lib, paper = library
    save_global_glossary(lib.root, [{"source": "slope", "target": "勾配", "domain": "最適化"}])
    select_domains(lib, paper, Provider({"domains": ["最適化"], "new_domain": None, "allowed_terms": [0]}), threading.Event())
    assert effective_glossary(lib, paper) == [{"source": "slope", "target": "勾配"}]
    with lib.connection() as db:
        db.execute("UPDATE pages SET text='The construction machine grades a slope.' WHERE paper_id=?", (paper,))
    assert effective_glossary(lib, paper) == []


def test_applicability_keeps_approved_domains_from_later_batches(library):
    lib, paper = library
    terms = [{"source": f"concept{i}", "target": f"概念{i}", "domain": "制御" if i < 40 else "認識"} for i in range(41)]
    save_global_glossary(lib.root, terms)
    with lib.connection() as db:
        db.execute("UPDATE pages SET text=? WHERE paper_id=?", (" ".join(t["source"] for t in terms), paper))

    class Batches(Provider):
        def generate(self, instruction, data, schema):
            entries = json.loads(data)["candidate_terms"]
            self.sent.append(entries)
            return json.dumps({"domains": [entries[0]["domain"]], "new_domain": None,
                               "allowed_terms": [entries[-1]["id"]]})

    provider = Batches(None)
    select_domains(lib, paper, provider, threading.Event())
    assert [len(batch) for batch in provider.sent] == [40, 1]
    assert effective_glossary(lib, paper) == [{"source": t["source"], "target": t["target"]} for t in terms[39:]]


def test_context_evidence_matches_pdf_hyphenation_and_plural_rules():
    text = "A model-\nbased controller follows trajectories. A workplace is mentioned separately."
    assert "model-based" in term_contexts(text, {"source": "model-based"})[0]
    assert "trajectories" in term_contexts(text, {"source": "trajectory"})[0]
    assert term_contexts(text, {"source": "work"}) == []


def test_paper_overrides_are_isolated_conflict_checked_and_deleted_with_paper(library):
    lib, paper = library
    shared = [{"source": "slope", "target": "法面"}]
    save_global_glossary(lib.root, shared)
    empty = {"terms": [], "dismissed": []}
    local = [{"source": "slope", "target": "勾配"}]
    save_paper_glossary(lib.root, paper, local, ["work"], empty)
    assert effective_glossary(lib, paper) == local
    assert global_glossary(lib.root) == shared
    assert paper_glossary(lib.root, "another-paper")["terms"] == []
    with pytest.raises(GlossaryConflict):
        save_paper_glossary(lib.root, paper, [], [], empty)
    lib.delete_paper(paper)
    assert paper_glossary(lib.root, paper) == {**empty, "scope": None}


def test_split_preview_can_separate_single_specialist_terms_without_saving(library):
    lib, _ = library
    terms = [{"source": "slope", "target": "法面", "domain": "ロボティクス・建設機械"},
             {"source": "trajectory optimization", "target": "軌道最適化", "domain": "ロボティクス・建設機械"}]
    save_global_glossary(lib.root, terms)
    provider = Provider({"domains": [{"name": "法面工学", "sources": ["slope"]},
                                    {"name": "自動車の自動運転", "sources": ["trajectory optimization"]}]})
    preview = split_domain(lib.root, provider, threading.Event(), lambda _: None, "ロボティクス・建設機械", preview=True)
    assert preview["moved"] == 2
    assert [t["domain"] for t in preview["terms"]] == ["法面工学", "自動車の自動運転"]
    assert preview["original"] == terms and global_glossary(lib.root) == terms


def test_draft_excludes_routine_paper_specific_and_declined_terms_and_caps_entire_paper(library):
    lib, paper = library
    save_paper_glossary(lib.root, paper, [], ["declined"], {"terms": [], "dismissed": []})
    # Two chunks: higher-priority candidates from the later chunk must reach the final shortlist.
    with lib.connection() as db:
        db.execute("UPDATE pages SET text=? WHERE paper_id=?",
                   ("routine unique declined " + " ".join(f"choice{i}" for i in range(5)) + " " * 24000
                    + " ".join(f"choice{i}" for i in range(5, 10)), paper))

    class Draft(Provider):
        def generate(self, instruction, data, schema):
            chunk = json.loads(data)["source"]
            def candidate(source, **more):
                return {"source": source, "target": "推奨訳", "reason": "意味の選択が読解に影響", "priority": 1,
                        "reusable": True, "needs_confirmation": True, **more}
            return json.dumps({"terms": [candidate("routine", needs_confirmation=False), candidate("unique", reusable=False),
                                         candidate("declined"), *[candidate(f"choice{i}", priority=1 if i < 5 else 3)
                                         for i in range(10) if f"choice{i}" in chunk]]})
    result = draft_glossary(lib, paper, Draft(None), threading.Event(), lambda _: None, [])
    assert [t["source"] for t in result["terms"]] == [f"choice{i}" for i in range(5, 10)]
    assert all(t["reason"] and t["context"] for t in result["terms"])
    assert paper_glossary(lib.root, paper)["terms"] == []


def test_local_glossary_routes_do_not_save_shared_terms_and_reject_conflicts(library, monkeypatch):
    from sidecar.app import app
    lib, paper = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(app) as client:
        endpoint = f"/api/papers/{paper}/glossary"
        empty = client.get(endpoint).json()
        assert empty == {"terms": [], "dismissed": []}
        body = {"terms": [{"source": "slope", "target": "勾配"}], "dismissed": ["Work"], "expected": empty}
        assert client.put(endpoint, json=body).status_code == 200
        assert client.get(endpoint).json()["dismissed"] == ["work"]
        assert client.get("/api/glossary").json() == []
        assert client.put(endpoint, json=body).status_code == 409
        body["expected"] = client.get(endpoint).json()
        body["terms"][0]["domain"] = "自動運転"
        assert client.put(endpoint, json=body).status_code == 400
        assert client.get("/api/papers/missing/glossary").status_code == 404
