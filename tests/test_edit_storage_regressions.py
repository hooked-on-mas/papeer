"""Review regressions: bounded graph state, resource cutover and causal history."""
from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

import pytest

from papeer.core.edit_model import EditGraph
from native_core_test_authority import core_repository
from papeer.core.edit_repository import StorageIntegrityError

FOLDER = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text("utf-8"))
SCOPE = FIXTURE["datasetManifest"]["scope"]


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with closing(sqlite3.connect(tmp_path / "review.sqlite3")) as db, db:
            yield db
    return core_repository(connection, SCOPE), connection


def test_graph_shares_immutable_objects_bounds_materializations_and_recovers_evicted_parents():
    root = deepcopy(FIXTURE["document"])
    graph = EditGraph({"version": 1, "libraryId": SCOPE["libraryId"], "root": root, "batches": []})
    ids = []
    for index in range(80):
        parent = graph.states[graph.view["heads"][0]]
        page = parent["pages"][0]
        batch = deepcopy(FIXTURE["batches"][0])
        batch["id"] = str(uuid4()); batch["parents"] = [parent["version"]]
        batch["expected"]["annotationVersion"] = page["annotationVersion"]
        batch["changes"][0]["annotation"]["id"] = str(uuid4())
        graph.receive([batch]); ids.append(batch["id"])
        if index:
            assert graph.states[batch["id"]]["pages"][0]["annotations"][0] is page["annotations"][0]
        batch["changes"][0]["annotation"]["style"]["color"] = "#abcdef"
    assert len(graph.states.cache) <= 16
    assert len(graph.states[ids[0]]["pages"][0]["annotations"]) == 1
    assert len(graph.states[ids[-1]]["pages"][0]["annotations"]) == 80
    with pytest.raises(TypeError):
        graph.states[ids[0]]["pages"][0]["annotations"][0]["style"]["color"] = "#abcdef"
    assert root == FIXTURE["document"]
    # A late branch uses an evicted parent without changing its original child.
    late = deepcopy(FIXTURE["batches"][0]); late["id"] = str(uuid4()); late["parents"] = [ids[0]]
    late["expected"]["annotationVersion"] = ids[0]; late["changes"][0]["annotation"]["id"] = str(uuid4())
    graph.receive([late])
    assert graph.view["heads"] == sorted([ids[-1], late["id"]])
    assert EditGraph(graph.checkpoint()).view == graph.view


def cumulative_batches(count):
    parent = FIXTURE["document"]["version"]
    annotation_version = FIXTURE["document"]["pages"][0]["annotationVersion"]
    batches = []
    for index in range(count):
        batch = deepcopy(FIXTURE["batches"][0])
        batch["id"] = f"11000000-0000-0000-0000-{index:012d}"
        batch["parents"] = [parent]
        batch["expected"]["annotationVersion"] = annotation_version
        annotation = batch["changes"][0]["annotation"]
        annotation["id"] = f"22000000-0000-0000-0000-{index:012d}"
        annotation["geometry"] = {"kind": "path", "points": [{"x": value, "y": value} for value in range(20)]}
        batches.append(batch)
        parent = annotation_version = batch["id"]
    return batches


def test_projection_gc_keeps_all_branches_and_rebuilds_past_versions_after_restart(setup):
    repository, connection = setup
    repository.initialize(FIXTURE["document"])
    batches = cumulative_batches(80)
    for batch in batches:
        assert repository.commit(batch)["status"] == "durable"
    with connection() as db:
        assert db.execute("SELECT COUNT(*) FROM edit_batches").fetchone()[0] == 80
        assert db.execute("SELECT COUNT(*) FROM edit_projections").fetchone()[0] == 2
        assert db.execute("SELECT COUNT(*) FROM edit_projection_pages").fetchone()[0] == 3
    restarted = core_repository(connection, SCOPE)
    graph = EditGraph(restarted.read(FIXTURE["document"]["id"])["checkpoint"])
    assert len(graph.states[batches[0]["id"]]["pages"][0]["annotations"]) == 1
    branch = deepcopy(batches[1]); branch["id"] = str(uuid4())
    branch["changes"][0]["annotation"]["id"] = str(uuid4())
    restarted.receive([branch])
    assert restarted.read(FIXTURE["document"]["id"])["heads"] == sorted([branch["id"], batches[-1]["id"]])
    with connection() as db:
        assert db.execute("SELECT COUNT(*) FROM edit_projections").fetchone()[0] == 3
        assert db.execute("SELECT COUNT(*) FROM edit_projection_pages").fetchone()[0] == 4
        db.execute("CREATE TRIGGER fail_gc BEFORE DELETE ON edit_projections BEGIN SELECT RAISE(ABORT, 'gc-failure'); END")
    following = deepcopy(batches[-1]); following["id"] = str(uuid4()); following["parents"] = [batches[-1]["id"]]
    following["expected"]["annotationVersion"] = batches[-1]["id"]
    following["changes"][0]["annotation"]["id"] = str(uuid4())
    assert restarted.commit(following)["status"] == "aborted"
    assert restarted.receipt(following["id"]) is None
    assert len(restarted.checkpoint()["edits"]) == 81


@pytest.mark.parametrize("boundary", ["install", "repeat-install", "publish", "activate"])
def test_corrupt_same_length_resource_cannot_pass_completion_or_pointer_boundary(setup, boundary):
    repository, connection = setup
    metadata = FIXTURE["resource"]["metadata"]
    repository.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), metadata)
    initial = FIXTURE["datasetControls"]["initial"]
    repository.replace_dataset_control(initial[0], None)
    if boundary != "install":
        repository.install_dataset(FIXTURE["datasetManifest"], FIXTURE["checkpoint"])
    if boundary == "activate":
        repository.replace_dataset_control(initial[1], initial[0]["id"])
    before = repository.dataset_control()
    with connection() as db:
        db.execute("UPDATE edit_resource_bytes SET payload=?", (b"x" * metadata["byteLength"],))
    # Corrupted saved bytes are a storage-integrity failure, deliberately outside ValueError (physical identity).
    with pytest.raises(StorageIntegrityError, match="stored-data-invalid"):
        if boundary in {"install", "repeat-install"}:
            repository.install_dataset(FIXTURE["datasetManifest"], FIXTURE["checkpoint"])
        else:
            repository.replace_dataset_control(initial[1 if boundary == "publish" else 2], before["id"])
    assert repository.dataset_control() == before
    if boundary == "install":
        assert repository.installed_datasets() == []


def test_invalid_action_is_rejected_without_poisoning_same_id_retry(setup):
    repository, _ = setup
    repository.initialize(FIXTURE["document"])
    records = deepcopy(FIXTURE["editRecords"])
    repository.receive_records(records[:2])
    bad = deepcopy(records[2]); bad["history"]["action"]["operationId"] = str(uuid4())
    with pytest.raises(ValueError, match="history-action-order"):
        repository.receive_records([bad])
    assert repository.receipt(bad["batch"]["id"]) is None
    assert repository.commit(bad["batch"], bad["history"])["status"] == "aborted"
    repository.receive_records([records[2]])
    assert len(repository.read(FIXTURE["document"]["id"])["history"]) == 3


def test_partial_history_recovers_and_late_invalid_history_does_not_block_valid_parent(setup):
    repository, connection = setup
    repository.initialize(FIXTURE["document"])
    records = deepcopy(FIXTURE["editRecords"])
    repository.receive([records[0]["batch"]])
    repository.receive_records([records[1]])
    repository.receive_records([records[0]])
    assert len(repository.read(FIXTURE["document"]["id"])["history"]) == 2
    other_scope = {**SCOPE, "epoch": "late"}
    other = core_repository(connection, other_scope)
    other.initialize(FIXTURE["document"])
    bad = deepcopy(records[1]); bad["history"]["action"]["operationId"] = str(uuid4())
    other.receive_records([bad])  # Causal chain has not arrived yet.
    other.receive_records([records[0]])
    assert other.read(FIXTURE["document"]["id"])["history"] == [records[0]["history"]]
    other.receive_records([records[1]])  # Correct metadata for the same content ID.
    assert len(other.read(FIXTURE["document"]["id"])["history"]) == 2


def test_empty_receive_keeps_validation_and_only_writes_repaired_history(setup, monkeypatch):
    repository, _ = setup
    repository.initialize(FIXTURE["document"])
    records = deepcopy(FIXTURE["editRecords"])
    repository.receive_records(records[:2])
    original_put = repository._put
    writes = []

    def counted(db, edit, namespace=None):
        writes.append(edit["batch"]["id"])
        return original_put(db, edit, namespace)

    monkeypatch.setattr(repository, "_put", counted)
    repository.receive_records([])
    assert writes == []
    before = repository.read(FIXTURE["document"]["id"])
    assert len(before["history"]) == 2
    with repository._transaction("receive-records") as db:
        bad = next(edit for edit in repository._edits(db) if edit["batch"]["id"] == records[1]["batch"]["id"])
        bad["history"]["action"]["operationId"] = str(uuid4())
        original_put(db, bad)
    writes.clear()
    repository.receive_records([])
    assert writes == [records[1]["batch"]["id"]]
    after = repository.read(FIXTURE["document"]["id"])
    assert after["history"] == [records[0]["history"]]
    assert len(after["receipts"]) == len(before["receipts"])
    assert after["heads"] == before["heads"]
