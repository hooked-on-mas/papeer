"""Whole-dataset bootstrap must not expose a partial catalog or erase local journals."""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from native_core_test_authority import core_repository
from _native_owner_api import owner_api

FOLDER = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text("utf-8"))
SCOPE = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "checkpoint"}


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "library.sqlite3") as db:
            yield db
    repository = core_repository(connection, SCOPE)
    return repository, connection


def resource(repository):
    metadata = FIXTURE["resource"]["metadata"]
    repository.store_resource(metadata["id"], metadata["sha256"], metadata["mediaType"], (FOLDER / FIXTURE["resource"]["file"]).read_bytes(), metadata)


def test_checkpoint_native_abort_restart_waiting_history_and_pending_are_preserved(setup):
    repository, connection = setup
    checkpoint = FIXTURE["checkpoint"]
    with pytest.raises(ValueError):
        repository.install_checkpoint(checkpoint)
    with pytest.raises(ValueError, match="missing-target"):
        repository.read(SCOPE["libraryId"])
    resource(repository)
    with connection() as db:
        db.execute("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON edit_batches BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.Error, match="quota"):
        repository.install_checkpoint(checkpoint)
    with pytest.raises(ValueError, match="missing-target"):
        repository.read(SCOPE["libraryId"])
    assert repository.pending() == []
    with connection() as db:
        db.execute("DROP TRIGGER fail_checkpoint")
    repository.install_checkpoint(checkpoint)
    restarted = core_repository(connection, SCOPE)
    assert restarted.checkpoint() == checkpoint
    assert restarted.pending() == []
    with connection() as db:
        db.execute("CREATE TRIGGER reject_rebuild BEFORE INSERT ON edit_projections BEGIN SELECT RAISE(ABORT, 'unnecessary rebuild'); END")
    restarted.install_checkpoint(checkpoint)  # Its atomic acceptance hash also survives restart.
    with connection() as db:
        db.execute("DROP TRIGGER reject_rebuild")
    assert restarted.read(FIXTURE["document"]["id"])["waiting"] == [FIXTURE["batches"][3]["id"]]
    assert len(restarted.read(SCOPE["libraryId"])["history"]) == 1
    edit = deepcopy(next(batch for batch in FIXTURE["batches"] if batch["kind"] == "markdown"))
    assert restarted.commit(edit)["status"] == "durable"
    receipt = restarted.receipt(edit["id"])
    restarted.install_checkpoint(checkpoint)
    assert restarted.receipt(edit["id"]) == receipt
    assert restarted.pending() == [edit]


@pytest.mark.parametrize("damage", ["root", "duplicate-root", "duplicate-batch", "history", "publication", "scope"])
def test_checkpoint_rejects_rebinding_and_rolls_back_every_component(setup, damage):
    repository, _ = setup
    resource(repository)
    repository.install_checkpoint(FIXTURE["checkpoint"])
    before = repository.checkpoint()
    value = deepcopy(before)
    if damage == "root":
        next(root for root in value["roots"] if root["kind"] == "markdown")["content"] = "wrong genesis"
    elif damage == "duplicate-root":
        value["roots"].append(value["roots"][0])
    elif damage == "duplicate-batch":
        value["edits"].append(value["edits"][0])
    elif damage == "history":
        next(edit for edit in value["edits"] if "history" in edit)["history"]["afterVersion"] = FIXTURE["document"]["id"]
    elif damage == "publication":
        next(edit for edit in value["edits"] if "publication" in edit)["publication"]["libraryBatch"]["changes"][0]["item"]["title"] = "changed"
    else:
        value["libraryId"] = FIXTURE["document"]["id"]
    with pytest.raises(ValueError):
        repository.install_checkpoint(value)
    assert repository.checkpoint() == before


def test_checkpoint_api_uses_the_same_corpus_without_losing_history(monkeypatch, tmp_path):
    # install-checkpoint is closed to the local owner (D2); the same corpus is installed through the test-only
    # Core harness and must read back through the authorized API without losing history.
    with owner_api(tmp_path, monkeypatch, SCOPE["libraryId"], SCOPE["epoch"], resource) as api:
        before = api.rows()
        denied = api.post("install-checkpoint", {"scope": api.scope, "checkpoint": FIXTURE["checkpoint"]})
        assert denied.status_code == 403 and api.rows() == before
        api.core().install_checkpoint(FIXTURE["checkpoint"])
        assert api.post("checkpoint", api.scope).json() == FIXTURE["checkpoint"]
