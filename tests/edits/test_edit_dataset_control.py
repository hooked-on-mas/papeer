"""The control journal, active pointer, native guards and receipt copy are one atomic boundary."""
from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

import pytest

from papeer.core.edits.datasets import checkpoint_hash
from native_core_test_authority import core_repository
from _native_owner_api import owner_api

FOLDER = Path(__file__).parent.parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text("utf-8"))
SCOPE = FIXTURE["datasetManifest"]["scope"]
INITIAL = FIXTURE["datasetControls"]["initial"]
ROTATION = FIXTURE["datasetControls"]["rotation"]
MARKDOWN = next(batch for batch in FIXTURE["batches"] if batch["kind"] == "markdown")


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with closing(sqlite3.connect(tmp_path / "library.sqlite3")) as db, db:
            yield db
    return core_repository(connection, SCOPE), connection


def populate(repository, checkpoint=None):
    value = FIXTURE["resource"]["metadata"]
    repository.store_resource(value["id"], value["sha256"], value["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), value)
    repository.install_checkpoint(checkpoint or FIXTURE["checkpoint"])


def activate(repository):
    populate(repository)
    assert repository.replace_dataset_control(INITIAL[0], None)["status"] == "written"
    repository.install_dataset(FIXTURE["datasetManifest"], FIXTURE["checkpoint"])
    for previous, record in zip(INITIAL, INITIAL[1:3]):
        assert repository.replace_dataset_control(record, previous["id"])["status"] == "written"


@pytest.mark.parametrize("phase", [0, 1, 2])
def test_durable_control_corpus_and_active_pointer_survive_restart_and_exact_retry(setup, phase):
    repository, connection = setup
    populate(repository)
    repository.replace_dataset_control(INITIAL[0], None)
    repository.install_dataset(FIXTURE["datasetManifest"], FIXTURE["checkpoint"])
    for index in range(1, phase + 1):
        repository.replace_dataset_control(INITIAL[index], INITIAL[index - 1]["id"])
    restarted = core_repository(connection, SCOPE)
    assert restarted.dataset_control() == INITIAL[phase]
    assert restarted.replace_dataset_control(INITIAL[phase], None) == {"status": "written"}
    result = restarted.commit(MARKDOWN)
    assert result["status"] == ("durable" if phase == 2 else "aborted")
    if phase != 2:
        assert "dataset-frozen" in result["reason"]


def rotation(source, connection, pending=False):
    activate(source)
    if pending:
        assert source.commit(MARKDOWN)["status"] == "durable"
        source.acknowledge(MARKDOWN["id"], "source-peer")
    records = deepcopy(ROTATION)
    checkpoint = source.checkpoint()
    for record in records:
        plan = record["transition"]["publication"]
        plan["checkpoint"] = deepcopy(checkpoint)
        plan["manifest"]["checkpointSha256"] = checkpoint_hash(checkpoint)
        if record["transition"]["phase"] == "activated":
            record["active"] = deepcopy(plan["manifest"])
    target_scope = records[0]["transition"]["publication"]["manifest"]["scope"]
    target = core_repository(connection, target_scope)
    populate(target, checkpoint)
    assert target.replace_dataset_control(records[0], INITIAL[2]["id"])["status"] == "written"
    plan = records[0]["transition"]["publication"]
    target.install_dataset(plan["manifest"], plan["checkpoint"])
    target.replace_dataset_control(records[1], records[0]["id"])
    return target, records


def test_activation_atomically_copies_pending_receipts_and_rejects_inactive_writers_then_rollback_quarantines_new_edits(setup):
    source, connection = setup
    target, records = rotation(source, connection, pending=True)
    with connection() as db:
        db.execute("CREATE TRIGGER fail_active BEFORE UPDATE ON edit_dataset_controls WHEN json_extract(NEW.payload,'$.transition.phase')='activated' BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.Error, match="quota"):
        target.replace_dataset_control(records[2], records[1]["id"])
    assert source.dataset_control() == records[1]
    assert target.receipt(MARKDOWN["id"])["upload"] == "accepted", "failed pointer swap must roll back receipt copy"
    assert source.receipt(MARKDOWN["id"])["upload"] == "pending"
    with connection() as db:
        db.execute("DROP TRIGGER fail_active")
    target.replace_dataset_control(records[2], records[1]["id"])
    assert source.dataset_control()["active"]["scope"] == target.scope
    assert target.receipt(MARKDOWN["id"])["upload"] == "pending"
    assert "source-peer" in target.receipt(MARKDOWN["id"])["importedBy"]
    assert "dataset-inactive" in source.commit(MARKDOWN)["reason"]
    child = {"kind": "markdown", "imageResources": [], "id": str(uuid4()), "libraryId": SCOPE["libraryId"], "targetId": FIXTURE["markdown"]["id"], "parents": [MARKDOWN["id"]], "content": "new epoch pending"}
    assert target.commit(child)["status"] == "durable"
    target.replace_intent(FIXTURE["document"]["id"], FIXTURE["intents"][0], None)
    with pytest.raises(ValueError, match="dataset-pending-intents"):
        target.replace_dataset_control(records[3], records[2]["id"])
    target.replace_intent(FIXTURE["document"]["id"], None, FIXTURE["intents"][0]["id"])
    target.replace_dataset_control(records[3], records[2]["id"])
    assert source.dataset_control()["active"]["scope"] == SCOPE
    assert source.read(FIXTURE["markdown"]["id"])["heads"] == [MARKDOWN["id"]]
    assert target.read(FIXTURE["markdown"]["id"])["heads"] == [child["id"]]
    assert len(target.pending_records()) == 2 and len(source.pending_records()) == 1
    assert "dataset-inactive" in target.commit(child)["reason"]
    assert source.commit(MARKDOWN)["status"] == "durable"


@pytest.mark.parametrize("phase", ["frozen", "inactive"])
def test_every_native_mutation_checks_the_atomic_access_head_without_loading_the_large_plan(setup, phase):
    source, connection = setup
    target, records = rotation(source, connection)
    if phase == "inactive":
        target.replace_dataset_control(records[2], records[1]["id"])
    reason = "dataset-" + phase
    assert reason in source.commit(MARKDOWN)["reason"]
    assert reason in source.publish(FIXTURE["publications"][0]["value"])["reason"]
    metadata = FIXTURE["resource"]["metadata"]
    attempts = [lambda: source.initialize(FIXTURE["document"]), lambda: source.install_checkpoint(FIXTURE["checkpoint"]),
                lambda: source.install_dataset(FIXTURE["datasetManifest"], FIXTURE["checkpoint"]), lambda: source.receive_records([]),
                lambda: source.replace_intent(FIXTURE["document"]["id"], FIXTURE["intents"][0], None),
                lambda: source.acknowledge(FIXTURE["batches"][0]["id"]), lambda: source.acknowledge(FIXTURE["batches"][0]["id"], "peer"),
                lambda: source.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), metadata)]
    for operation in attempts:
        with pytest.raises(ValueError, match=reason):
            operation()
    assert source.checkpoint() == FIXTURE["checkpoint"], "read/archive access remains available and source content is untouched"


def test_pending_intent_and_late_source_change_cannot_be_hidden_by_cutover(setup):
    source, connection = setup
    activate(source)
    target = core_repository(connection, ROTATION[0]["transition"]["publication"]["manifest"]["scope"])
    populate(target)
    source.replace_intent(FIXTURE["document"]["id"], FIXTURE["intents"][0], None)
    with pytest.raises(ValueError, match="dataset-pending-intents"):
        target.replace_dataset_control(ROTATION[0], INITIAL[2]["id"])
    source.replace_intent(FIXTURE["document"]["id"], None, FIXTURE["intents"][0]["id"])
    source.commit(MARKDOWN)
    with pytest.raises(ValueError, match="dataset-content-changed"):
        target.replace_dataset_control(ROTATION[0], INITIAL[2]["id"])
    assert source.dataset_control() == INITIAL[2]


def test_cas_plan_identity_phase_and_epoch_reuse_are_validated_in_native_api(setup, monkeypatch, tmp_path):
    # Control transitions require a separate plan-scoped authority; the owner API keeps replace-dataset-control
    # closed (D2). The same CAS/plan/identity/epoch checks therefore run on the native repository through the
    # test-only Core harness, and the authorized API is checked for read, foreign-scope and closed-route denial.
    repository, connection = setup
    activate(repository)
    assert repository.dataset_control() == INITIAL[2]
    assert core_repository(connection, {**SCOPE, "accountId": "other"}).dataset_control() is None
    wrong = deepcopy(ROTATION[0]); wrong["identity"]["accountId"] = "other"
    with pytest.raises(ValueError):
        repository.replace_dataset_control(wrong, INITIAL[2]["id"])
    assert repository.replace_dataset_control(ROTATION[0], str(uuid4())) == {"status": "conflict"}
    assert repository.replace_dataset_control(ROTATION[0], INITIAL[2]["id"]) == {"status": "written"}
    changed = deepcopy(ROTATION[1]); changed["transition"]["publication"]["checkpointObjectId"] = str(uuid4())
    with pytest.raises(ValueError, match="dataset-plan-changed"):
        repository.replace_dataset_control(changed, ROTATION[0]["id"])
    assert repository.dataset_control() == ROTATION[0]

    with owner_api(tmp_path, monkeypatch, SCOPE["libraryId"], SCOPE["epoch"]) as api:
        control = api.post("dataset-control", api.scope).json()
        assert control["identity"] == {"accountId": api.scope["accountId"], "libraryId": SCOPE["libraryId"]}
        assert control["active"]["scope"] == api.scope
        before = api.rows()
        assert api.post("dataset-control", {**api.scope, "accountId": "other"}).status_code == 403
        record = deepcopy(ROTATION[0]); record["identity"]["accountId"] = api.scope["accountId"]
        for expected in (control["id"], str(uuid4())):
            assert api.post("replace-dataset-control", {"scope": api.scope, "record": record, "expectedId": expected}).status_code == 403
        assert api.rows() == before
        assert api.post("dataset-control", api.scope).json() == control
