from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from papeer.core.edit_model import EditGraph
from _native_owner_api import owner_api
from native_core_test_authority import core_repository

FIXTURE = json.loads((Path(__file__).parent / "fixtures/shared-edits.json").read_text(encoding="utf-8"))


def identity(value):
    return f"00000000-0000-0000-0000-{value:012d}"


def batch(value):
    return deepcopy(next(edit for edit in FIXTURE["batches"] if edit["id"] == identity(value)))


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "library.sqlite3") as db:
            yield db
    scope = {"accountId": "fixture-account", "libraryId": FIXTURE["libraryId"], "epoch": "fixture-epoch"}
    repository = core_repository(connection, scope)
    for name in ("document", "markdown", "library"):
        repository.initialize(FIXTURE[name])
    return repository, connection, scope


def test_atomic_commit_restart_receipts_and_outbox(setup):
    repo, connection, scope = setup
    edit = batch(201)
    history = {"operationId": edit["id"], "beforeVersion": FIXTURE["document"]["version"], "afterVersion": edit["id"], "undoRequested": False}
    assert repo.commit(edit, history)["status"] == "durable"
    restarted = core_repository(connection, scope)
    state = restarted.read(edit["targetId"])
    assert state["heads"] == [edit["id"]]
    assert state["history"] == [history]
    assert restarted.pending() == [edit]
    assert restarted.commit(edit)["status"] == "durable"
    assert len(restarted.read(edit["targetId"])["receipts"]) == 1
    restarted.acknowledge(edit["id"])
    assert restarted.pending() == []
    assert restarted.receipt(edit["id"])["importedBy"] == []
    restarted.acknowledge(edit["id"], "other-host")
    assert restarted.receipt(edit["id"])["importedBy"] == ["other-host"]


def test_sticky_form_page_batches_preserve_complete_payload_through_native_save_retry_and_restart(setup):
    repo, connection, scope = setup
    document = deepcopy(FIXTURE["document"])
    other = deepcopy(FIXTURE["batches"][0]["changes"][0]["annotation"])
    sticky = {"kind": "sticky", "id": identity(910), "text": "form body", "anchor": {"x": 72, "y": 144},
              "color": None, "quote": "retained exact quote", "metadata": {"label": "topic", "createdAt": "2026-10-27T12:34:56.789Z"}}

    def commit(number, changes):
        nonlocal document
        page = document["pages"][0]
        edit = {"kind": "page", "id": identity(number), "libraryId": FIXTURE["libraryId"], "targetId": document["id"],
                "parents": [document["version"]], "expected": {"pageId": page["id"], **{key: page[key] for key in
                ("backgroundRevision", "lifecycleVersion", "annotationVersion")}}, "changes": deepcopy(changes)}
        history = {"operationId": edit["id"], "beforeVersion": document["version"], "afterVersion": edit["id"], "undoRequested": False}
        assert repo.commit(edit, history)["status"] == "durable"
        assert repo.commit(deepcopy(edit), deepcopy(history))["status"] == "durable", "same operation retry is idempotent"
        restarted = core_repository(connection, scope)
        read = restarted.read(document["id"])
        assert read["heads"] == [edit["id"]]
        assert next(value for value in restarted.pending() if value["id"] == edit["id"]) == edit
        assert [value for value in read["history"] if value["operationId"] == edit["id"]] == [history]
        assert len([receipt for receipt in read["receipts"] if receipt["id"] == edit["id"]]) == 1
        document = deepcopy(EditGraph(read["checkpoint"]).states[edit["id"]])
        return document["pages"][0]["annotations"]

    assert commit(911, [{"type": "create", "annotation": other}, {"type": "create", "annotation": sticky}]) == [other, sticky]
    edited = {**deepcopy(sticky), "text": "edited body", "anchor": {"x": 200, "y": 300},
              "metadata": {**sticky["metadata"], "label": "new classification"}}
    assert commit(912, [{"type": "update", "annotation": edited}]) == [other, edited]
    assert commit(913, [{"type": "delete", "id": sticky["id"]}]) == [other]
    assert commit(914, [{"type": "create", "annotation": edited}]) == [other, edited]
    assert edited["color"] is None and edited["quote"] == sticky["quote"] and edited["metadata"]["createdAt"] == sticky["metadata"]["createdAt"]



def test_pdf_highlight_payloads_and_existing_ink_survive_sqlite_retry_restart_and_raw_history(setup):
    repo, connection, scope = setup
    metadata = FIXTURE["resource"]["metadata"]
    pdf = (Path(__file__).parent / "fixtures" / FIXTURE["resource"]["file"]).read_bytes()
    assert repo.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], pdf, metadata) == metadata
    document = deepcopy(FIXTURE["document"])
    document["id"] = identity(920)
    page = document["pages"][0]
    page.update(deepcopy(metadata["pdfPages"][0]))
    page["background"] = {"kind": "pdf", "resourceId": metadata["id"], "sourceRevision": metadata["sha256"], "pdfPage": 1}
    ink = deepcopy(FIXTURE["batches"][0]["changes"][0]["annotation"])
    page["annotations"] = [deepcopy(ink)]
    repo.initialize(document)
    highlights = []
    for index, text_range in enumerate(({"kind": "indexed", "start": 3, "end": 12}, {"kind": "unindexed"})):
        highlights.append({"kind": "highlight", "id": identity(921 + index), "quote": f"exact quote {index} 世界",
            "range": text_range, "quads": [[{"x": 20, "y": 30}, {"x": 90, "y": 30}, {"x": 90, "y": 42}, {"x": 20, "y": 42}]],
            "backgroundRevision": page["backgroundRevision"], "anchor": {"x": 55, "y": 45},
            "text": f"comment {index}", "color": "#facc15", "metadata": {"label": f"label {index}", "createdAt": "2026-10-27T12:34:56.789Z"}})
    edit = {"kind": "page", "id": identity(923), "libraryId": FIXTURE["libraryId"], "targetId": document["id"],
        "parents": [document["version"]], "expected": {"pageId": page["id"], **{key: page[key] for key in
        ("backgroundRevision", "lifecycleVersion", "annotationVersion")}},
        "changes": [{"type": "create", "annotation": deepcopy(value)} for value in highlights]}
    history = {"operationId": edit["id"], "beforeVersion": document["version"], "afterVersion": edit["id"], "undoRequested": False}
    first = repo.commit(edit, history)
    assert first["status"] == "durable"
    receipt = deepcopy(first["receipt"])
    assert receipt == {"id": edit["id"], "targetId": document["id"], "durable": True, "upload": "pending", "importedBy": []}
    retry = repo.commit(deepcopy(edit), deepcopy(history))
    assert retry["status"] == "durable" and retry["receipt"] == receipt
    restarted = core_repository(connection, scope)
    read = restarted.read(document["id"])
    assert read["heads"] == [edit["id"]]
    assert [value for value in read["history"] if value["operationId"] == edit["id"]] == [history]
    assert [value for value in read["receipts"] if value["id"] == edit["id"]] == [receipt]
    assert restarted.receipt(edit["id"]) == receipt
    assert next(value for value in restarted.pending() if value["id"] == edit["id"]) == edit
    saved = EditGraph(read["checkpoint"]).states[edit["id"]]
    assert saved["pages"][0]["annotations"] == [ink, *highlights]
    with connection() as db:
        rows = db.execute("SELECT payload, history, receipt FROM edit_batches WHERE scope=? AND id=?", (restarted.namespace, edit["id"])).fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0][0]) == edit
    assert json.loads(rows[0][1]) == history
    assert json.loads(rows[0][2]) == receipt

def test_native_transaction_failure_rolls_back_every_part(setup):
    repo, connection, _ = setup
    with connection() as db:
        db.execute("CREATE TRIGGER fail_projection BEFORE INSERT ON edit_projections BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    assert repo.commit(batch(201))["status"] == "aborted"
    assert repo.pending() == []
    assert repo.receipt(identity(201)) is None
    assert repo.read(FIXTURE["document"]["id"])["heads"] == [identity(100)]
    with connection() as db:
        assert db.execute("SELECT COUNT(*) FROM edit_batches").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM edit_projection_pages").fetchone()[0] == 2
        db.execute("DROP TRIGGER fail_projection")
    assert repo.commit(batch(201))["status"] == "durable"
    with connection() as db:
        # One new immutable page; the untouched second page was not rewritten/copied.
        assert db.execute("SELECT COUNT(*) FROM edit_projection_pages").fetchone()[0] == 3


def test_parent_waiting_recovery_and_same_id_integrity(setup):
    repo, _, _ = setup
    repo.receive([batch(204), batch(202)])
    assert repo.read(FIXTURE["document"]["id"])["waiting"] == [identity(202), identity(204)]
    repo.receive([batch(203), batch(201)])
    assert repo.read(FIXTURE["document"]["id"])["heads"] == [identity(202), identity(204)]
    assert repo.commit(batch(206))["status"] == "durable"
    repo.receive([batch(205), batch(207)])
    assert repo.read(FIXTURE["document"]["id"])["heads"] == [identity(205), identity(206), identity(207)]
    wrong = batch(205); wrong["changes"][0]["annotation"]["style"]["color"] = "#000000"
    with pytest.raises(ValueError, match="batch-id-reused"):
        repo.receive([batch(501), wrong])
    assert repo.receipt(identity(501)) is None


def test_scope_isolation_and_all_contracts(setup):
    repo, connection, scope = setup
    for number in (201, 203, 501, 502, 301, 302):
        assert repo.commit(batch(number))["status"] == "durable"
    assert repo.read(FIXTURE["document"]["id"])["heads"] == [identity(201), identity(203)]
    assert repo.read(FIXTURE["markdown"]["id"])["heads"] == [identity(501), identity(502)]
    assert repo.read(FIXTURE["library"]["id"])["heads"] == [identity(302)]
    for different in ({**scope, "accountId": "other"}, {**scope, "epoch": "other"}, {**scope, "libraryId": identity(999)}):
        isolated = core_repository(connection, different)
        assert isolated.pending() == []
        assert isolated.receipt(identity(201)) is None
        with pytest.raises(ValueError, match="missing-target"):
            isolated.read(FIXTURE["document"]["id"])


def test_real_authenticated_api_uses_the_same_repository(monkeypatch, tmp_path):
    # Real bearer, durable grant, lease and admission; the same fixture roots are seeded at the grant namespace.
    def seed(repo):
        for name in ("document", "markdown", "library"):
            repo.initialize(FIXTURE[name])
    with owner_api(tmp_path, monkeypatch, FIXTURE["libraryId"], "fixture-epoch", seed) as api:
        scope, repo = api.scope, api.core()
        response = api.post("commit", {"scope": scope, "batch": batch(201)})
        assert response.status_code == 200
        assert response.json()["status"] == "durable"
        assert repo.pending() == [batch(201)]
        receipt = api.post("receipt", {"scope": scope, "batchId": identity(201)}).json()
        assert receipt["durable"]
        assert api.post("read", {"scope": scope, "targetId": FIXTURE["document"]["id"]}).json()["heads"] == [identity(201)]
        assert api.post("commit", {"scope": scope, "batch": {**batch(201), "parents": [identity(999)]}}).json()["status"] == "aborted"
