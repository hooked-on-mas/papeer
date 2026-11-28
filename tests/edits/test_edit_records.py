"""Ordinary replication must retain action history atomically, without a checkpoint."""
from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

import pytest

from native_core_test_authority import core_repository
from _native_owner_api import owner_api

FOLDER = Path(__file__).parent.parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text("utf-8"))
SCOPE = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "edit-record"}
RECORDS = FIXTURE["editRecords"]


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with closing(sqlite3.connect(tmp_path / "library.sqlite3")) as db, db:
            yield db
    repository = core_repository(connection, SCOPE)
    repository.initialize(FIXTURE["document"])
    return repository, connection


def test_reverse_arrival_and_restart_keep_normal_undo_redo_history(setup):
    repository, connection = setup
    repository.receive_records(list(reversed(RECORDS[1:])))
    read = repository.read(FIXTURE["document"]["id"])
    assert len(read["waiting"]) == 2 and len(read["history"]) == 2
    repository.receive_records([RECORDS[0]])
    restarted = core_repository(connection, SCOPE)
    read = restarted.read(FIXTURE["document"]["id"])
    assert read["heads"] == [RECORDS[2]["batch"]["id"]] and read["waiting"] == []
    assert {value["operationId"] for value in read["history"]} == {value["batch"]["id"] for value in RECORDS}
    assert restarted.checkpoint()["edits"] == RECORDS
    assert restarted.pending_records() == []


def test_native_abort_never_leaks_projection_history_or_receipt_and_can_retry(setup):
    repository, connection = setup
    with connection() as db:
        db.execute("CREATE TRIGGER fail_record BEFORE INSERT ON edit_batches BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.Error, match="quota"):
        repository.receive_records(RECORDS)
    restarted = core_repository(connection, SCOPE)
    assert restarted.read(FIXTURE["document"]["id"])["history"] == []
    assert restarted.read(FIXTURE["document"]["id"])["heads"] == [FIXTURE["document"]["version"]]
    assert all(restarted.receipt(value["batch"]["id"]) is None for value in RECORDS)
    with connection() as db:
        db.execute("DROP TRIGGER fail_record")
    restarted.receive_records(RECORDS)
    assert restarted.checkpoint()["edits"] == RECORDS


def test_history_enrichment_preserves_receipts_and_rejects_conflicting_arrival_atomically(setup):
    repository, _ = setup
    first = RECORDS[0]
    assert repository.commit(first["batch"])["status"] == "durable"
    repository.acknowledge(first["batch"]["id"], "peer")
    receipt = repository.receipt(first["batch"]["id"])
    repository.receive_records([first])
    assert repository.receipt(first["batch"]["id"]) == receipt
    assert repository.pending_records() == [first]
    conflict = deepcopy(first)
    conflict["history"]["undoRequested"] = True
    with pytest.raises(ValueError, match="history-id-reused"):
        repository.receive_records([RECORDS[1], conflict])
    assert repository.receipt(RECORDS[1]["batch"]["id"]) is None
    repository.receive([first["batch"]])
    assert repository.pending_records() == [first]


def test_local_retries_cannot_change_history_or_silently_add_metadata(setup):
    repository, connection = setup
    first = RECORDS[0]
    assert repository.commit(first["batch"], first["history"])["status"] == "durable"
    different = {**first["history"], "undoRequested": True}
    assert "history-id-reused" in repository.commit(first["batch"], different)["reason"]
    assert repository.commit(first["batch"])["status"] == "durable"
    other = core_repository(connection, {**SCOPE, "epoch": "other"})
    other.initialize(FIXTURE["document"])
    other.commit(first["batch"])
    assert "history-id-reused" in other.commit(first["batch"], first["history"])["reason"]


@pytest.mark.parametrize("damage", ["operationId", "beforeVersion", "afterVersion", "self-action", "extra"])
def test_invalid_metadata_rejects_before_any_arrival_is_saved(setup, damage):
    repository, _ = setup
    bad = deepcopy(RECORDS[1])
    if damage == "self-action":
        bad["history"]["action"]["operationId"] = bad["batch"]["id"]
    elif damage == "extra":
        bad["extra"] = True
    else:
        bad["history"][damage] = FIXTURE["document"]["id"]
    with pytest.raises(ValueError):
        repository.receive_records([RECORDS[0], bad])
    assert repository.checkpoint()["edits"] == []


def test_full_creation_record_keeps_initial_root_and_history_and_cannot_be_rewritten(setup):
    repository, connection = setup
    repository.initialize(FIXTURE["markdown"])
    repository.initialize(FIXTURE["library"])
    metadata = FIXTURE["resource"]["metadata"]
    repository.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), metadata)
    publication = FIXTURE["publications"][0]["value"]
    batch = publication["libraryBatch"]
    history = {"operationId": batch["id"], "beforeVersion": batch["parents"][0], "afterVersion": batch["id"], "undoRequested": False}
    assert repository.publish(publication, history)["status"] == "durable"
    expected = [{"batch": batch, "history": history, "publication": publication}]
    restarted = core_repository(connection, SCOPE)
    assert restarted.pending_records() == expected
    assert "history-id-reused" in restarted.publish(publication, {**history, "undoRequested": True})["reason"]
    assert restarted.pending_records() == expected
    restarted.receive_records(expected)
    assert restarted.read(publication["content"]["id"])["checkpoint"]["root"] == publication["content"]


def test_native_api_preserves_full_record_fields_in_both_directions(setup, monkeypatch, tmp_path):
    # Outgoing: commit and pending-records through the real owner API (bearer, grant, lease, admission).
    # Incoming: receive-records is closed to the local owner (D2), so the receiving repository accepts the same
    # records through the test-only Core harness and the closed route must not change any row.
    _, connection = setup
    with owner_api(tmp_path, monkeypatch, SCOPE["libraryId"], SCOPE["epoch"], lambda repo: repo.initialize(FIXTURE["document"])) as api:
        for record in RECORDS:
            assert api.post("commit", {"scope": api.scope, **record}).json()["status"] == "durable"
        assert api.post("pending-records", api.scope).json() == RECORDS
        before = api.rows()
        assert api.post("receive-records", {"scope": api.scope, "records": list(reversed(RECORDS))}).status_code == 403
        assert api.rows() == before
    receiver_scope = {**SCOPE, "epoch": "receiver"}
    receiver = core_repository(connection, receiver_scope)
    receiver.initialize(FIXTURE["document"])
    receiver.receive_records(list(reversed(RECORDS)))
    assert receiver.checkpoint()["edits"] == RECORDS
    # A Drive poll can contain more than 1,000 edits. Keep early children private,
    # rather than failing at a cardinality limit absent in IndexedDB.
    arrivals = [{"batch": {"kind": "markdown", "imageResources": [], "id": str(uuid4()), "libraryId": SCOPE["libraryId"],
                 "targetId": FIXTURE["markdown"]["id"], "parents": [FIXTURE["markdown"]["version"]], "content": str(index)}}
                for index in range(1001)]
    receiver.receive_records(arrivals)
    assert all(receiver.receipt(record["batch"]["id"])["durable"] for record in arrivals)
    with pytest.raises(ValueError, match="missing-target"):
        receiver.read(FIXTURE["markdown"]["id"])
    receiver.initialize(FIXTURE["markdown"])
    assert len(receiver.read(FIXTURE["markdown"]["id"])["heads"]) == 1001
    bad = deepcopy(RECORDS[0]); bad["history"]["undoRequested"] = True
    with pytest.raises(ValueError, match="history-id-reused"):
        receiver.receive_records([bad])
    assert receiver.read(FIXTURE["document"]["id"])["history"] == [record["history"] for record in RECORDS]
