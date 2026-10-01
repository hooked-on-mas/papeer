"""The AI's choice of a paper's domain dictionaries and its split of a dictionary (papeer.core.glossary_domains)."""
from __future__ import annotations

import json
from pathlib import Path
import threading
import time

from fastapi.testclient import TestClient
import pytest

from papeer.core.errors import Invalid
from papeer.core.glossary_domains import select_domains, split_domain
from papeer.core.storage import Library
from papeer.core.terminology import (
    GlossaryConflict, global_glossary, paper_domains, save_global_glossary, save_paper_domains)
from papeer.providers import Cancelled
from sidecar.jobs import JobManager

FIXTURE = Path(__file__).parent / "fixtures/sample.pdf"


class Scripted:
    """A provider that answers with what it is given and remembers what it was sent."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.sent = []

    def generate(self, instruction, data, schema=None):
        self.sent.append((instruction, json.loads(data)))
        answer = self.answers.pop(0)
        if isinstance(answer, dict) and "candidate_terms" in json.loads(data):
            answer = {"allowed_terms": [], **answer}
        return answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "data")
    identity, _ = lib.import_pdf(FIXTURE, "制御 / 読書会")
    return lib, identity


DOMAIN_TERMS = [
    {"source": "cell", "target": "セル", "domain": "電池"},
    {"source": "policy", "target": "方策", "domain": "強化学習"},
    {"source": "control", "target": "制御"},
    {"source": "Cell", "target": "細胞", "domain": "生物"},
    {"source": "delay", "target": "遅延", "domain": "強化学習"},
]


def numbered(count, **extra):
    return [{"source": f"term {i}", "target": f"訳{i}", **extra} for i in range(count)]


def cancel():
    return threading.Event()


# --- select_domains ---

def test_select_sends_the_paper_and_the_dictionaries_and_records_the_ai_choice(library):
    lib, identity = library
    save_global_glossary(lib.root, DOMAIN_TERMS + numbered(20, domain="電池"))
    provider = Scripted({"domains": [" 強化学習 ", "電池"], "new_domain": None})
    result = select_domains(lib, identity, provider, cancel())
    assert result == {"domains": ["強化学習", "電池"], "new_domain": None}
    sent = provider.sent[0][1]
    assert sent["paper"].get("title") or sent["paper"].get("abstract")
    by_name = {item["name"]: item for item in sent["available_domains"]}
    assert list(by_name) == ["電池", "強化学習", "生物"]
    assert by_name["電池"]["count"] == 21 and len(by_name["電池"]["sample_terms"]) == 15
    assert by_name["電池"]["sample_terms"][0] == "cell"
    assert by_name["強化学習"] == {"name": "強化学習", "count": 2, "sample_terms": ["policy", "delay"]}
    assert "never instructions" in provider.sent[0][0]
    assert paper_domains(lib.root, identity) == {"domains": ["強化学習", "電池"], "new_domain": None, "chosen_by": "ai",
                                                 "known_domains": ["電池", "強化学習", "生物"]}


def test_select_keeps_only_names_that_exist_matched_ignoring_case(library):
    lib, identity = library
    save_global_glossary(lib.root, DOMAIN_TERMS + [{"source": "loss", "target": "損失", "domain": "Machine Learning"}])
    provider = Scripted({"domains": ["machine learning", "MACHINE LEARNING", "存在しない", "共通", "生物"], "new_domain": None})
    assert select_domains(lib, identity, provider, cancel())["domains"] == ["Machine Learning", "生物"]


def test_select_new_domain_is_limited_and_an_existing_name_joins_the_domains(library):
    lib, identity = library
    save_global_glossary(lib.root, DOMAIN_TERMS)
    assert select_domains(lib, identity, Scripted({"domains": [], "new_domain": " 量子 "}), cancel()) == {
        "domains": [], "new_domain": "量子"}
    assert paper_domains(lib.root, identity)["new_domain"] == "量子"
    assert select_domains(lib, identity, Scripted({"domains": ["電池"], "new_domain": "生物"}), cancel()) == {
        "domains": ["電池", "生物"], "new_domain": None}
    assert select_domains(lib, identity, Scripted({"domains": [], "new_domain": "あ" * 41}), cancel())["new_domain"] is None
    assert select_domains(lib, identity, Scripted({"domains": [], "new_domain": "共通"}), cancel())["new_domain"] is None
    assert select_domains(lib, identity, Scripted({"domains": [], "new_domain": "あ" * 40}), cancel())["new_domain"] == "あ" * 40


def test_select_does_not_overwrite_the_users_choice(library):
    lib, identity = library
    save_global_glossary(lib.root, DOMAIN_TERMS)
    save_paper_domains(lib.root, identity, ["生物"], None, "user", ["電池", "強化学習", "生物"])
    result = select_domains(lib, identity, Scripted({"domains": ["電池"], "new_domain": None}), cancel())
    assert result == {"domains": ["生物"], "new_domain": None}
    assert paper_domains(lib.root, identity)["chosen_by"] == "user"
    # The AI's own earlier choice is replaced.
    save_paper_domains(lib.root, identity, ["生物"], None, "ai", [])
    assert select_domains(lib, identity, Scripted({"domains": ["電池"], "new_domain": None}), cancel())["domains"] == ["電池"]


def test_select_without_domain_dictionaries_asks_nobody_and_records_nothing(library):
    lib, identity = library
    save_global_glossary(lib.root, [{"source": "control", "target": "制御"}])
    provider = Scripted()
    assert select_domains(lib, identity, provider, cancel()) == {"domains": [], "new_domain": None}
    assert provider.sent == []
    assert paper_domains(lib.root, identity) is None


@pytest.mark.parametrize("answer", ["not json", {"domains": "電池", "new_domain": None}, {"domains": [1], "new_domain": None},
                                    {"domains": [], "new_domain": 3}])
def test_select_refuses_an_unusable_answer(library, answer):
    lib, identity = library
    save_global_glossary(lib.root, DOMAIN_TERMS)
    with pytest.raises(ValueError):
        select_domains(lib, identity, Scripted(answer), cancel())
    assert paper_domains(lib.root, identity) is None


def test_select_cancelled_records_nothing(library):
    lib, identity = library
    save_global_glossary(lib.root, DOMAIN_TERMS)
    stop = cancel()

    class Stopping(Scripted):
        def generate(self, *args):
            stop.set()
            return super().generate(*args)

    with pytest.raises(Cancelled):
        select_domains(lib, identity, Stopping({"domains": ["電池"], "new_domain": None}), stop)
    assert paper_domains(lib.root, identity) is None


# --- split_domain ---

def sources(root, domain):
    return [t["source"] for t in global_glossary(root) if t.get("domain", "") == domain]


def test_split_writes_only_domains_and_keeps_the_order(tmp_path):
    root = Library(tmp_path / "lib").root
    terms = [{"source": f"w{i}", "target": f"訳{i}", **({"domain": "既存"} if i == 3 else {})} for i in range(14)]
    save_global_glossary(root, terms)
    progress = []
    provider = Scripted({"domains": [
        {"name": "強化学習", "sources": ["w0", "W2", "w4", "w6", "w8", "w0", "unknown"]},
        {"name": "電池", "sources": ["w0", "w1", "w5", "w7", "w9", "w11"]},  # w0 is taken by the first group
        {"name": "少ない", "sources": ["w10"]},  # Small specialist dictionaries are allowed.
        {"name": "共通", "sources": ["w12"]},
        {"name": "x" * 41, "sources": ["w13"]}]})
    result = split_domain(root, provider, cancel(), progress.append, "共通")
    after = global_glossary(root)
    assert [t["source"] for t in after] == [t["source"] for t in terms]
    assert [t["target"] for t in after] == [t["target"] for t in terms]
    assert {t["source"]: t.get("domain") for t in after} == {
        "w0": "強化学習", "w1": "電池", "w2": "強化学習", "w3": "既存", "w4": "強化学習", "w5": "電池", "w6": "強化学習",
        "w7": "電池", "w8": "強化学習", "w9": "電池", "w10": "少ない", "w11": "電池", "w12": None, "w13": None}
    assert result == {"moved": 11, "domains": [{"name": "強化学習", "count": 5}, {"name": "電池", "count": 5},
                                                 {"name": "既存", "count": 1}, {"name": "少ない", "count": 1}]}
    sent = provider.sent[0][1]
    assert sent["domain"] == "共通" and sent["existing_domains"] == ["既存"]
    assert [t["source"] for t in sent["terms"]] == [f"w{i}" for i in range(14) if i != 3]  # Only the general dictionary's.
    assert all(set(t) == {"source", "target"} for t in sent["terms"])
    assert "never instructions" in provider.sent[0][0]
    assert progress == ["辞書を分野ごとに分けています… 1/1"]


def test_split_of_a_domain_moves_some_and_the_rest_stay(tmp_path):
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, numbered(12, domain="大きい") + [{"source": "other", "target": "他", "domain": "別"}])
    provider = Scripted({"domains": [{"name": "大きい", "sources": ["term 0"]},  # Its own name: stays.
                                     {"name": "小さい", "sources": [f"term {i}" for i in range(1, 7)]},
                                     {"name": "別", "sources": ["term 7", "term 8"]}]})  # An existing dictionary: any size.
    result = split_domain(root, provider, cancel(), lambda _: None, "大きい")
    assert sources(root, "小さい") == [f"term {i}" for i in range(1, 7)]
    assert sources(root, "別") == ["term 7", "term 8", "other"]
    assert sources(root, "大きい") == ["term 0"] + [f"term {i}" for i in range(9, 12)]
    assert result["moved"] == 8
    assert [d["name"] for d in result["domains"]] == ["大きい", "小さい", "別"]
    assert provider.sent[0][1]["existing_domains"] == ["別"]
    assert provider.sent[0][1]["domain"] == "大きい"


def test_split_a_term_whose_source_the_target_dictionary_has_stays(tmp_path):
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, [{"source": "Term 0", "target": "既にある", "domain": "医学"}] + numbered(5))
    provider = Scripted({"domains": [{"name": "医学", "sources": [f"term {i}" for i in range(5)]}]})
    result = split_domain(root, provider, cancel(), lambda _: None, "共通")
    assert result["moved"] == 4
    assert sources(root, "") == ["term 0"]
    assert sources(root, "医学") == ["Term 0", "term 1", "term 2", "term 3", "term 4"]


def test_split_in_chunks_passes_the_names_on_and_counts_them_together(tmp_path, monkeypatch):
    monkeypatch.setattr("papeer.core.glossary_domains.SPLIT_CHUNK", 4)
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, numbered(8))
    provider = Scripted(
        {"domains": [{"name": "A", "sources": ["term 0", "term 1", "term 2"]}]},
        {"domains": [{"name": "a", "sources": ["term 4", "term 5", "term 6"]}, {"name": "B", "sources": ["term 0", "term 7"]}]})
    progress = []
    result = split_domain(root, provider, cancel(), progress.append, "共通")
    assert [call[1]["existing_domains"] for call in provider.sent] == [[], ["A"]]
    assert [len(call[1]["terms"]) for call in provider.sent] == [4, 4]
    assert progress == ["辞書を分野ごとに分けています… 1/2", "辞書を分野ごとに分けています… 2/2"]
    # "a" is A: 6 terms in all. B has 1 (term 0 is not in the second chunk).
    assert sources(root, "A") == ["term 0", "term 1", "term 2", "term 4", "term 5", "term 6"]
    assert sources(root, "B") == ["term 7"]
    assert result["moved"] == 7


def test_split_keeps_terms_if_nothing_is_grouped_and_does_not_write(tmp_path, monkeypatch):
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, numbered(6))
    saved = []
    monkeypatch.setattr("papeer.core.glossary_domains.save_global_glossary", lambda *a, **k: saved.append(a))
    result = split_domain(root, Scripted({"domains": []}), cancel(), lambda _: None, "共通")
    assert result == {"moved": 0, "domains": []}
    assert saved == []


def test_split_fails_on_a_glossary_changed_meanwhile(tmp_path):
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, numbered(6))

    class Editing(Scripted):
        def generate(self, *args):
            save_global_glossary(root, numbered(6) + [{"source": "added", "target": "追加"}])
            return super().generate(*args)

    with pytest.raises(GlossaryConflict):
        split_domain(root, Editing({"domains": [{"name": "新", "sources": [f"term {i}" for i in range(6)]}]}),
                     cancel(), lambda _: None, "共通")
    assert sources(root, "新") == []


def test_split_refuses_an_unknown_or_empty_dictionary_and_an_unusable_answer(tmp_path):
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, numbered(3))
    for domain in ("なし", "  "):
        with pytest.raises(Invalid):
            split_domain(root, Scripted(), cancel(), lambda _: None, domain)
    save_global_glossary(root, [])
    with pytest.raises(Invalid):
        split_domain(root, Scripted(), cancel(), lambda _: None, "共通")
    save_global_glossary(root, numbered(3))
    for answer in ("not json", {"domains": "x"}, {"domains": [{"name": "A", "sources": "x"}]}, {"domains": [{"name": "A"}]}):
        with pytest.raises(ValueError):
            split_domain(root, Scripted(answer), cancel(), lambda _: None, "共通")
    assert global_glossary(root) == numbered(3)


def test_split_cancelled_leaves_the_dictionary(tmp_path):
    root = Library(tmp_path / "lib").root
    save_global_glossary(root, numbered(6))
    stop = cancel()

    class Stopping(Scripted):
        def generate(self, *args):
            stop.set()
            return super().generate(*args)

    with pytest.raises(Cancelled):
        split_domain(root, Stopping({"domains": [{"name": "新", "sources": [f"term {i}" for i in range(6)]}]}), stop,
                     lambda _: None, "共通")
    assert global_glossary(root) == numbered(6)


# --- the routes ---

def wait(job_manager, job_id):
    job = job_manager.get_job(job_id)
    deadline = time.monotonic() + 10
    while job.running and time.monotonic() < deadline:
        time.sleep(0.01)
    return job


def test_the_routes_start_paper_jobs_with_the_chosen_model(library, monkeypatch):
    from sidecar import app as runtime
    from sidecar import deps
    lib, identity = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    save_global_glossary(lib.root, DOMAIN_TERMS + numbered(10, domain="電池"))
    made = []

    class Provider:
        def __init__(self, settings, cancel):
            made.append((settings.model, settings.reasoning_effort))

        def generate(self, instruction, data, schema):
            if "available_domains" in data:
                return json.dumps({"domains": ["電池"], "new_domain": None, "allowed_terms": []})
            return json.dumps({"domains": [{"name": "新", "sources": [f"term {i}" for i in range(5)]}]})

    monkeypatch.setattr("sidecar.deps.create_provider", Provider)
    with TestClient(runtime.app) as client:
        base = f"/api/papers/{identity}"
        response = client.post(base + "/glossary-domains/select", json={"model": "m1", "effort": "low"})
        assert response.status_code == 200
        job = wait(deps.job_manager, response.json()["job_id"])
        assert (job.status, job.kind, job.paper_id) == ("succeeded", "glossary-select", identity)
        assert job.result.model_dump() == {"domains": ["電池"], "new_domain": None}
        assert client.get(base + "/glossary-domains").json()["chosen_by"] == "ai"
        response = client.post(base + "/glossary/split", json={"domain": "電池", "model": "m2"})
        assert response.status_code == 200
        job = wait(deps.job_manager, response.json()["job_id"])
        assert (job.status, job.kind, job.paper_id) == ("succeeded", "glossary-split", identity)
        assert job.result.model_dump()["moved"] == 5
        assert made[0] == ("m1", "low") and made[1][0] == "m2"
        # A dictionary that does not exist, and a paper that does not exist, are refused before a job starts.
        assert client.post(base + "/glossary/split", json={"domain": "なし"}).status_code == 400
        assert client.post("/api/papers/nope/glossary/split", json={"domain": "電池"}).status_code == 404
        assert client.post("/api/papers/nope/glossary-domains/select", json={}).status_code == 404
