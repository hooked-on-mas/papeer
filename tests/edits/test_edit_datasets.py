"""Completed manifests bind an exact, self-contained dataset to an atomic native import."""
from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edits.datasets import assert_dataset_checkpoint, checkpoint_hash
from native_core_test_authority import core_repository
from _native_owner_api import owner_api

FOLDER = Path(__file__).parent.parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text("utf-8"))
MANIFEST = FIXTURE["datasetManifest"]
SCOPE = MANIFEST["scope"]
CHECKPOINT = FIXTURE["checkpoint"]


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with closing(sqlite3.connect(tmp_path / "library.sqlite3")) as db, db:
            yield db
    return core_repository(connection, SCOPE), connection


def resource(repository):
    value = FIXTURE["resource"]["metadata"]
    return repository.store_resource(value["id"], value["sha256"], value["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), value)


def test_completed_manifest_native_abort_restart_retry_and_receipt_are_atomic(setup):
    repository, connection = setup
    assert_dataset_checkpoint(MANIFEST, CHECKPOINT, SCOPE)
    with pytest.raises(ValueError, match="dataset-resource-missing"):
        repository.install_dataset(MANIFEST, CHECKPOINT)
    resource(repository)
    with connection() as db:
        db.execute("CREATE TRIGGER fail_completion BEFORE INSERT ON edit_datasets BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.Error, match="quota"):
        repository.install_dataset(MANIFEST, CHECKPOINT)
    with pytest.raises(ValueError, match="missing-target"):
        repository.read(SCOPE["libraryId"])
    restarted = core_repository(connection, SCOPE)
    assert restarted.installed_datasets() == []
    assert all(restarted.receipt(record["batch"]["id"]) is None for record in CHECKPOINT["edits"])
    with connection() as db:
        db.execute("DROP TRIGGER fail_completion")
    restarted.install_dataset(MANIFEST, CHECKPOINT)
    restarted = core_repository(connection, SCOPE)
    assert restarted.installed_datasets() == [MANIFEST]
    assert restarted.checkpoint() == CHECKPOINT
    assert restarted.pending_records() == []
    with connection() as db:
        db.execute("CREATE TRIGGER fail_rebuild BEFORE INSERT ON edit_roots BEGIN SELECT RAISE(ABORT, 'unnecessary rebuild'); END")
    restarted.install_dataset(MANIFEST, CHECKPOINT)
    assert restarted.read(FIXTURE["document"]["id"])["waiting"] == [FIXTURE["batches"][3]["id"]]


def test_import_preserves_pending_history_and_unopened_intent_without_confusing_completion_with_upload(setup):
    repository, connection = setup
    repository.initialize(FIXTURE["document"])
    first = FIXTURE["editRecords"][0]
    repository.commit(first["batch"], first["history"])
    repository.replace_intent(FIXTURE["document"]["id"], FIXTURE["intents"][0], None)
    receipt = repository.receipt(first["batch"]["id"])
    resource(repository)
    repository.install_dataset(MANIFEST, CHECKPOINT)
    restarted = core_repository(connection, SCOPE)
    assert restarted.pending_records() == [first]
    assert restarted.receipt(first["batch"]["id"]) == receipt
    assert restarted.read_intent(FIXTURE["document"]["id"]) == FIXTURE["intents"][0]
    assert restarted.installed_datasets() == [MANIFEST]
    current = restarted.checkpoint()
    reused = {**MANIFEST, "checkpointSha256": checkpoint_hash(current)}
    with pytest.raises(ValueError, match="dataset-id-reused"):
        restarted.install_dataset(reused, current)


@pytest.mark.parametrize("damage", ["scope", "missing-resource", "extra-resource", "duplicate-resource", "hash", "missing-content", "invalid-batch"])
def test_manifest_validates_its_complete_content_without_relying_on_other_local_roots(setup, damage):
    repository, _ = setup
    resource(repository)
    repository.install_checkpoint(CHECKPOINT)
    manifest, checkpoint = deepcopy(MANIFEST), deepcopy(CHECKPOINT)
    if damage == "scope":
        manifest["scope"]["epoch"] = "other"
    elif damage == "missing-resource":
        manifest["resources"] = []
    elif damage == "extra-resource":
        manifest["resources"].append({**manifest["resources"][0], "id": "ffffffff-ffff-ffff-ffff-ffffffffffff"})
    elif damage == "duplicate-resource":
        manifest["resources"].append(manifest["resources"][0])
    elif damage == "hash":
        manifest["checkpointSha256"] = "0" * 64
    elif damage == "missing-content":
        checkpoint["roots"] = [root for root in checkpoint["roots"] if root["id"] != FIXTURE["markdown"]["id"]]
        manifest["checkpointSha256"] = checkpoint_hash(checkpoint)
    else:
        record = next(record for record in checkpoint["edits"] if record["batch"]["kind"] == "page")
        record["batch"]["expected"]["backgroundRevision"] = FIXTURE["document"]["id"]
        manifest["checkpointSha256"] = checkpoint_hash(checkpoint)
    with pytest.raises(ValueError):
        repository.install_dataset(manifest, checkpoint)
    assert repository.installed_datasets() == []
    assert repository.checkpoint() == CHECKPOINT


def test_dataset_api_keeps_manifest_resources_and_scope_and_refuses_partial_or_mismatched_content(setup, monkeypatch, tmp_path):
    # install-dataset is closed to the local owner (D2). Installation validation runs on the native repository
    # through the test-only Core harness; the authorized API must read installed manifests with their resources
    # and scope, deny a foreign scope, and keep the closed install route from changing any row.
    repository, connection = setup
    resource(repository)
    wrong = deepcopy(MANIFEST); wrong["checkpointSha256"] = "0" * 64
    with pytest.raises(ValueError):
        repository.install_dataset(wrong, CHECKPOINT)
    assert repository.installed_datasets() == []
    repository.install_dataset(MANIFEST, CHECKPOINT)
    assert repository.installed_datasets() == [MANIFEST]
    assert core_repository(connection, {**SCOPE, "accountId": "other"}).installed_datasets() == []

    def seed(repo):
        resource(repo)
        repo.install_dataset({**MANIFEST, "scope": repo.scope}, CHECKPOINT)
    with owner_api(tmp_path, monkeypatch, SCOPE["libraryId"], SCOPE["epoch"], seed) as api:
        manifest = {**MANIFEST, "scope": api.scope}
        listed = api.post("datasets", api.scope).json()
        assert manifest in listed and all(value["scope"] == api.scope for value in listed)
        assert listed == api.core().installed_datasets()
        before = api.rows()
        for body in ({"scope": api.scope, "manifest": manifest, "checkpoint": CHECKPOINT},
                     {"scope": api.scope, "manifest": {**manifest, "checkpointSha256": "0" * 64}, "checkpoint": CHECKPOINT}):
            assert api.post("install-dataset", body).status_code == 403
        assert api.post("datasets", {**api.scope, "accountId": "other"}).status_code == 403
        assert api.rows() == before


def test_content_encoding_matches_binary64_unicode_and_json_type_corpus():
    for record in FIXTURE["contentHashes"]:
        assert edit_content_hash(record["value"]) == record["sha256"]
    assert edit_content_hash({"😀": 1.0, "\ue000": 2, "a": -0.0}) == edit_content_hash({"a": 0, "\ue000": 2.0, "😀": 1})
    assert edit_content_hash(False) != edit_content_hash(0)
    assert edit_content_hash([]) != edit_content_hash({})
    cycle = []; cycle.append(cycle)
    for value in [float("inf"), float("nan"), 1 << 10000, {1: "wrong"}, "\ud800", {"\udfff": "bad"}, cycle, (1, 2)]:
        with pytest.raises(ValueError, match="non-json-content"):
            edit_content_hash(value)
