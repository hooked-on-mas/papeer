"""The AI's proposal of folders for papers (papeer.core.library_organize), its all-or-nothing application
(Library.apply_moves) and their routes (POST /api/collections/organize and /apply-moves)."""
from __future__ import annotations

import json
import threading
import time

from fastapi.testclient import TestClient
import pytest

from papeer.core.errors import Conflict, Invalid, NotFound
from papeer.core.library_organize import MAX_PAPERS, organize_candidates, propose_organization
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar.jobs import JobManager


class Scripted:
    """A provider that answers with what it is given and remembers what it was sent."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.sent = []

    def generate(self, instruction, data, schema=None):
        self.sent.append((instruction, json.loads(data)))
        answer = self.answers.pop(0)
        return answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)


def add_paper(lib, number, title, collection="", text="", author="", year=""):
    identity = f"{number:032x}"
    with lib.connection() as db:
        # created_at is fixed: papers() sorts by it (whole seconds) and then by id, so the order never depends on the clock.
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,first_author,publication_year,created_at)"
                   " VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (identity, f"sha{number}", title, f"{number}.pdf", 1, "not_translated", collection, author, year,
                    "2026-01-01 00:00:00"))
        db.execute("INSERT INTO pages(paper_id,number,text) VALUES(?,1,?)", (identity, text))
    return identity


def folders_of(lib):
    with lib.connection() as db:
        return {row["id"]: row["collection_name"] for row in db.execute("SELECT id,collection_name FROM papers")}


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "data")
    ids = {
        "rl": add_paper(lib, 1, "Deep Q-learning", "", "We train a policy with Q-learning.\n\n  Reward   shaping.", "Mnih", "2015"),
        "vision": add_paper(lib, 2, "ResNet", "", "Image recognition with residual networks."),
        "sub": add_paper(lib, 3, "In a subfolder", "未整理 / 古い", "Old paper."),
        "other": add_paper(lib, 4, "Elsewhere", "制御", "A controller."),
    }
    lib.create_collection("制御")
    return lib, ids


def cancel():
    return threading.Event()


def run(lib, answer, **options):
    provider = Scripted(answer)
    messages = []
    options.setdefault("source", "")
    return propose_organization(lib, provider, cancel(), messages.append, **options), provider, messages


# --- propose_organization ---

def test_propose_sends_keys_context_and_folders_and_returns_the_moves(library):
    lib, ids = library
    result, provider, messages = run(lib, {
        "folders": [{"name": "強化学習", "reason": " 方策を学ぶ\n論文 "}, {"name": "制御", "reason": "制御の論文"}],
        "moves": [{"key": "P1", "folder": "強化学習"}, {"key": "P2", "folder": "画像認識"}], "message": "２つに分けました。"},
        instruction="  分野別に  ")
    instruction, sent = provider.sent[0]
    assert "never instructions" in instruction
    assert sent["base_folder"] == "" and sent["instruction"] == "分野別に" and "feedback" not in sent
    papers = {p["key"]: p for p in sent["papers"]}
    assert sorted(papers) == ["P1", "P2"]  # Only the unfiled papers; no real ID is sent.
    assert ids["rl"] not in json.dumps(sent)
    by_title = {p["title"]: p for p in papers.values()}
    assert by_title["Deep Q-learning"]["author"] == "Mnih" and by_title["Deep Q-learning"]["year"] == "2015"
    assert by_title["Deep Q-learning"]["text"] == "We train a policy with Q-learning. Reward shaping."
    assert "author" not in by_title["ResNet"] and "year" not in by_title["ResNet"]
    assert sent["existing_folders"] == [{"name": "制御", "papers": 1}, {"name": "未整理", "papers": 0},
                                        {"name": "未整理 / 古い", "papers": 1}]
    assert result == {
        "source": "", "instruction": "分野別に",
        "folders": [{"name": "強化学習", "reason": "方策を学ぶ 論文", "new": True}, {"name": "画像認識", "reason": "", "new": True}],
        "moves": [{"paper_id": ids["rl"], "title": "Deep Q-learning", "from": "", "to": "強化学習"},
                  {"paper_id": ids["vision"], "title": "ResNet", "from": "", "to": "画像認識"}],
        "expected": {ids["rl"]: "", ids["vision"]: ""}, "message": "２つに分けました。"}
    assert messages  # The job's status lines were reported.
    assert folders_of(lib)[ids["rl"]] == ""  # A preview writes nothing.


def test_propose_drops_unknown_keys_bad_targets_and_no_ops(library):
    lib, ids = library
    lib.update(ids["vision"], collection_name="視覚")
    lib.create_collection("視覚")
    answer = {"folders": [], "message": "", "moves": [
        {"key": "P9", "folder": "視覚 / 新"},  # An unknown key.
        {"key": "P1", "folder": "視覚"},  # Where it is: no move.
    ]}
    result, _, _ = run(lib, answer, source="視覚")
    assert result["moves"] == [] and result["folders"] == [] and result["expected"] == {}
    for folder in ["視覚 / ../x", "視覚 / " + "あ" * 81, "  /  ", "他 / 新", "視覚 / ."]:
        result, _, _ = run(lib, {**answer, "moves": [{"key": "P1", "folder": folder}]}, source="視覚")
        assert result["moves"] == [], folder
    # An existing folder anywhere is fine, and the last answer for a key decides.
    result, _, _ = run(lib, {**answer, "moves": [{"key": "P1", "folder": "視覚 / 新"}, {"key": "P1", "folder": "制御"}]},
                       source="視覚")
    assert [(m["from"], m["to"]) for m in result["moves"]] == [("視覚", "制御")]
    assert result["folders"] == [{"name": "制御", "reason": "", "new": False}]


def test_propose_accepts_existing_folders_and_new_ones_below_the_base_and_normalizes(library):
    lib, ids = library
    lib.create_collection("A / B")
    lib.update(ids["sub"], collection_name="A")
    result, provider, _ = run(lib, {
        "folders": [{"name": "a / b", "reason": "既存"}, {"name": "A\\新規 / 下", "reason": "新しい"}],
        "moves": [{"key": "P1", "folder": "a/b"}, {"key": "P2", "folder": " A \\ 新規 / 下 "}, {"key": "P3", "folder": "他"}],
        "message": ""}, source="A")
    assert [p["title"] for p in provider.sent[0][1]["papers"]] == ["In a subfolder"]
    # P3 does not exist, and an existing folder matches ignoring case.
    assert result["moves"] == [{"paper_id": ids["sub"], "title": "In a subfolder", "from": "A", "to": "A / B"}]
    assert result["folders"] == [{"name": "A / B", "reason": "既存", "new": False}]
    result, _, _ = run(lib, {"folders": [{"name": "A / 新規 / 下", "reason": "新しい"}],
                             "moves": [{"key": "P1", "folder": "A / 新規 / 下"}], "message": ""}, source="A")
    assert result["folders"] == [{"name": "A / 新規 / 下", "reason": "新しい", "new": True}]
    assert result["moves"][0]["to"] == "A / 新規 / 下"
    # A folder named only in moves is accepted with an empty reason; one without a move is not listed.
    result, _, _ = run(lib, {"folders": [{"name": "A / 空", "reason": "x"}, {"name": "他 / 外", "reason": "y"}],
                             "moves": [{"key": "P1", "folder": "A / 無"}], "message": ""}, source="A")
    assert result["folders"] == [{"name": "A / 無", "reason": "", "new": True}]


def test_parents_are_matched_to_existing_folders_ignoring_case(library):
    lib, ids = library
    lib.create_collection("Control")
    lib.create_collection("A")
    lib.create_collection("a")
    lib.create_collection("Deep / Shallow")
    result, _, _ = run(lib, {"folders": [], "message": "", "moves": [
        {"key": "P1", "folder": "control / RL"},  # Under the existing Control, not a second 'control'.
        {"key": "P2", "folder": "deep / shallow / New"}]})
    assert [m["to"] for m in result["moves"]] == ["Control / RL", "Deep / Shallow / New"]
    # Several spellings in one answer are one new folder: the first accepted one is used.
    result, _, _ = run(lib, {"folders": [{"name": "NEW / b", "reason": "r"}], "message": "", "moves": [
        {"key": "P1", "folder": "new / x"}, {"key": "P2", "folder": "New / y"}]})
    assert [m["to"] for m in result["moves"]] == ["new / x", "new / y"]
    assert [f["name"] for f in result["folders"]] == ["new / x", "new / y"]
    # Names that differ only in case: the exact spelling wins, otherwise the first in order ("A" before "a").
    result, _, _ = run(lib, {"folders": [], "message": "", "moves": [
        {"key": "P1", "folder": "a / sub"}, {"key": "P2", "folder": "A / sub"}]})
    assert [m["to"] for m in result["moves"]] == ["a / sub", "A / sub"]
    result, _, _ = run(lib, {"folders": [], "message": "", "moves": [{"key": "P1", "folder": "A"}, {"key": "P2", "folder": "a"}]})
    assert [m["to"] for m in result["moves"]] == ["A", "a"]
    # A mere spelling of the base is the base: under it new folders are allowed, elsewhere they are not.
    lib.update(ids["rl"], collection_name="Control")
    result, _, _ = run(lib, {"folders": [], "message": "", "moves": [
        {"key": "P1", "folder": "CONTROL / 新"}, {"key": "P2", "folder": "他 / 新"}]}, source="Control")
    assert [m["to"] for m in result["moves"]] == ["Control / 新"]


def test_a_folder_is_organized_without_its_subfolders(library):
    lib, ids = library
    result, provider, _ = run(lib, {"folders": [], "moves": [{"key": "P1", "folder": "未整理 / 古い / 新"}], "message": ""},
                              source="未整理 / 古い")
    assert [p["title"] for p in provider.sent[0][1]["papers"]] == ["In a subfolder"]
    assert result["moves"][0]["to"] == "未整理 / 古い / 新"
    lib.update(ids["rl"], collection_name="未整理")
    result, provider, _ = run(lib, {"folders": [], "moves": [], "message": ""}, source="未整理")
    assert [p["title"] for p in provider.sent[0][1]["papers"]] == ["Deep Q-learning"]  # Not the one in 未整理 / 古い.


def test_paper_ids_restrict_the_papers_and_may_come_from_other_folders(library):
    lib, ids = library
    result, provider, _ = run(lib, {"folders": [], "moves": [{"key": "P1", "folder": "新"}, {"key": "P2", "folder": "制御"}],
                                    "message": ""}, source="", paper_ids=[ids["other"], ids["rl"], ids["other"]])
    papers = provider.sent[0][1]["papers"]
    assert [(p["title"], p["current_folder"]) for p in papers] == [("Elsewhere", "制御"), ("Deep Q-learning", "")]
    assert result["moves"] == [{"paper_id": ids["other"], "title": "Elsewhere", "from": "制御", "to": "新"},
                               {"paper_id": ids["rl"], "title": "Deep Q-learning", "from": "", "to": "制御"}]
    assert result["expected"] == {ids["other"]: "制御", ids["rl"]: ""}
    with pytest.raises(NotFound):
        run(lib, {"folders": [], "moves": [], "message": ""}, paper_ids=[ids["rl"], "f" * 32])
    with pytest.raises(Invalid):
        run(lib, {"folders": [], "moves": [], "message": ""}, paper_ids=[])


def test_too_many_and_no_papers_are_refused_before_asking(library):
    lib, ids = library
    for number in range(10, 10 + MAX_PAPERS - 2):  # Two are unfiled already.
        add_paper(lib, number, f"Paper {number}")
    assert len(organize_candidates(lib, "")) == MAX_PAPERS
    add_paper(lib, 9, "One too many")
    provider = Scripted()
    with pytest.raises(Invalid, match="絞ってください"):
        propose_organization(lib, provider, cancel(), lambda _: None, source="")
    assert provider.sent == []
    with pytest.raises(Invalid):
        propose_organization(lib, provider, cancel(), lambda _: None, source="なにもない")
    with pytest.raises(Invalid):
        propose_organization(lib, provider, cancel(), lambda _: None, source="制御 / 未作成")
    assert provider.sent == []
    # Selecting narrows it again.
    assert len(organize_candidates(lib, "", [ids["rl"]])) == 1


def test_feedback_and_the_previous_proposal_are_sent(library):
    lib, ids = library
    first, _, _ = run(lib, {"folders": [{"name": "強化学習", "reason": "RL"}],
                            "moves": [{"key": "P1", "folder": "強化学習"}], "message": "案"})
    second, provider, _ = run(lib, {"folders": [{"name": "学習", "reason": "学習全般"}],
                                    "moves": [{"key": "P1", "folder": "学習"}], "message": "直しました"},
                              feedback=" もっと大きくまとめて ", previous={**first, "usage": None})
    sent = provider.sent[0][1]
    assert sent["feedback"] == "もっと大きくまとめて"
    assert sent["previous_proposal"] == {"folders": [{"name": "強化学習", "reason": "RL"}], "message": "案",
                                         "moves": [{"key": "P1", "title": "Deep Q-learning", "folder": "強化学習"}]}
    assert second["moves"][0]["to"] == "学習"


@pytest.mark.parametrize("answer", ["not json", {"folders": [], "moves": "x", "message": ""},
                                    {"folders": [], "moves": [{"key": "P1"}], "message": ""},
                                    {"folders": [{"name": 3}], "moves": [], "message": ""},
                                    {"folders": [], "moves": [{"key": "P1", "folder": 3}], "message": ""}])
def test_an_unusable_answer_is_refused(library, answer):
    lib, _ = library
    with pytest.raises(ValueError, match="再試行"):
        run(lib, answer)


def test_cancel_is_honoured(library):
    lib, _ = library
    stop = threading.Event()

    class Stopping(Scripted):
        def generate(self, *args):
            stop.set()
            return super().generate(*args)

    with pytest.raises(Cancelled):
        propose_organization(lib, Stopping({"folders": [], "moves": [{"key": "P1", "folder": "x"}], "message": ""}),
                             stop, lambda _: None, source="")
    stop = threading.Event()
    stop.set()
    provider = Scripted()
    with pytest.raises(Cancelled):
        propose_organization(lib, provider, stop, lambda _: None, source="")
    assert provider.sent == []


# --- apply_moves ---

def test_apply_moves_moves_papers_and_creates_folders_with_their_parents(library):
    lib, ids = library
    lib.create_collection("制御 / 既存")
    result = lib.apply_moves(
        [{"paper_id": ids["rl"], "to": " 機械学習\\強化学習 / 理論 "}, {"paper_id": ids["vision"], "to": "制御 / 既存"},
         {"paper_id": ids["other"], "to": "制御"}],  # Already there: not counted.
        {ids["rl"]: "", ids["vision"]: "", ids["other"]: "制御"})
    assert result == {"moved": 2, "created": ["機械学習", "機械学習 / 強化学習", "機械学習 / 強化学習 / 理論"]}
    assert folders_of(lib)[ids["rl"]] == "機械学習 / 強化学習 / 理論" and folders_of(lib)[ids["vision"]] == "制御 / 既存"
    assert {"機械学習", "機械学習 / 強化学習", "機械学習 / 強化学習 / 理論"} <= set(lib.collections())
    with lib.connection() as db:
        assert {r[0] for r in db.execute("SELECT name FROM collections")} >= {"機械学習 / 強化学習", "機械学習 / 強化学習 / 理論"}


def test_apply_moves_changes_nothing_when_a_paper_moved_or_is_gone(library):
    lib, ids = library
    before = folders_of(lib)
    collections = lib.collections()
    moves = [{"paper_id": ids["rl"], "to": "新 / 先"}, {"paper_id": ids["vision"], "to": "新 / 別"}]
    with pytest.raises(Conflict) as stale:
        lib.apply_moves(moves, {ids["rl"]: "", ids["vision"]: "どこか"})
    assert stale.value.code == "collection_changed" and stale.value.status_code == 409
    with pytest.raises(Conflict) as missing:
        lib.apply_moves([*moves, {"paper_id": "e" * 32, "to": "新"}], {ids["rl"]: "", ids["vision"]: "", "e" * 32: ""})
    assert missing.value.code == "collection_changed"
    assert folders_of(lib) == before and lib.collections() == collections
    with pytest.raises(Invalid):  # No expected folder, or a paper twice.
        lib.apply_moves(moves, {ids["rl"]: ""})
    with pytest.raises(Invalid):
        lib.apply_moves([moves[0], moves[0]], {ids["rl"]: ""})
    assert folders_of(lib) == before and lib.collections() == collections


def test_the_same_proposal_cannot_be_applied_twice(library):
    lib, ids = library
    moves, expected = [{"paper_id": ids["rl"], "to": "強化学習"}], {ids["rl"]: ""}
    assert lib.apply_moves(moves, expected) == {"moved": 1, "created": ["強化学習"]}
    with pytest.raises(Conflict):
        lib.apply_moves(moves, expected)
    assert lib.apply_moves([{"paper_id": ids["rl"], "to": ""}], {ids["rl"]: "強化学習"}) == {"moved": 1, "created": []}


# --- the routes ---

@pytest.fixture
def client(library, monkeypatch):
    from sidecar import app as runtime
    from sidecar import deps
    lib, ids = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    changed = []
    monkeypatch.setattr("sidecar.deps.library_changed", lambda: changed.append(True))
    with TestClient(runtime.app) as test_client:
        test_client.changed = changed
        test_client.deps = deps
        yield test_client, lib, ids


def wait(deps, job_id):
    job = deps.job_manager.get_job(job_id)
    deadline = time.monotonic() + 10
    while job.running and time.monotonic() < deadline:
        time.sleep(0.01)
    return job


def test_organize_route_runs_a_library_job_and_apply_moves_applies_its_result(client, monkeypatch):
    test_client, lib, ids = client
    deps = test_client.deps
    made = []

    class Provider:
        def __init__(self, settings, cancel):
            made.append((settings.model, settings.reasoning_effort))

        def generate(self, instruction, data, schema):
            return json.dumps({"folders": [{"name": "強化学習", "reason": "RL"}],
                               "moves": [{"key": "P1", "folder": "強化学習"}], "message": "案です。"})

    monkeypatch.setattr("sidecar.deps.create_provider", Provider)
    response = test_client.post("/api/collections/organize", json={"instruction": "分野別", "model": "m1", "effort": "low"})
    assert response.status_code == 200
    job = wait(deps, response.json()["job_id"])
    assert (job.status, job.kind, job.paper_id) == ("succeeded", "library-organize", None), job.error
    proposal = job.result.model_dump()
    assert made == [("m1", "low")]
    assert proposal["moves"] == [{"paper_id": ids["rl"], "title": "Deep Q-learning", "from": "", "to": "強化学習"}]
    assert proposal["expected"] == {ids["rl"]: ""} and proposal["folders"][0]["new"] is True
    assert proposal["usage"] is None and proposal["message"] == "案です。"
    assert folders_of(lib)[ids["rl"]] == ""
    # Revising: the proposal goes back as `previous`.
    response = test_client.post("/api/collections/organize", json={"previous": proposal, "feedback": "x"})
    assert wait(deps, response.json()["job_id"]).status == "succeeded"

    body = {"moves": [{"paper_id": m["paper_id"], "to": m["to"]} for m in proposal["moves"]], "expected": proposal["expected"]}
    response = test_client.post("/api/collections/apply-moves", json=body)
    assert response.status_code == 200 and response.json() == {"moved": 1, "created": ["強化学習"]}
    assert test_client.changed == [True] and folders_of(lib)[ids["rl"]] == "強化学習"
    assert "強化学習" in test_client.get("/api/collections").json()
    response = test_client.post("/api/collections/apply-moves", json=body)
    assert response.status_code == 409 and response.json()["code"] == "collection_changed"
    assert test_client.changed == [True]  # A refused application broadcasts nothing.


def test_organize_route_refuses_bad_requests_before_a_job_starts(client):
    test_client, lib, ids = client
    assert test_client.post("/api/collections/organize", json={"source": "ない"}).status_code == 400
    assert test_client.post("/api/collections/organize", json={"paper_ids": ["f" * 32]}).status_code == 404
    assert test_client.post("/api/collections/organize", json={"instruction": "あ" * 2001}).status_code == 422
    assert test_client.post("/api/collections/organize", json={"paper_ids": []}).status_code == 422
    assert test_client.post("/api/collections/apply-moves", json={"moves": [], "expected": {}}).status_code == 422
    assert test_client.post("/api/collections/apply-moves", json={
        "moves": [{"paper_id": ids["rl"], "to": "x"}], "expected": {}}).status_code == 400
    assert test_client.deps.job_manager.get_jobs() == []


def test_only_one_library_job_runs_at_a_time_and_apply_does_not_wait_for_it(client, monkeypatch):
    test_client, lib, ids = client
    deps = test_client.deps
    gate = threading.Event()
    entered = threading.Event()

    class Slow:
        def __init__(self, settings, cancel):
            pass

        def generate(self, instruction, data, schema):
            entered.set()
            assert gate.wait(5)
            return json.dumps({"folders": [], "moves": [], "message": ""})

    monkeypatch.setattr("sidecar.deps.create_provider", Slow)
    try:
        started = test_client.post("/api/collections/organize", json={})
        assert started.status_code == 200 and entered.wait(5)
        assert test_client.post("/api/collections/organize", json={}).status_code == 409
        body = {"moves": [{"paper_id": ids["rl"], "to": "x"}], "expected": {ids["rl"]: ""}}
        # A move is only a folder change, so a running job does not hold it back.
        assert test_client.post("/api/collections/apply-moves", json=body).status_code == 200
        assert folders_of(lib)[ids["rl"]] == "x"
    finally:
        gate.set()
        assert deps.job_manager.wait_idle(5)
