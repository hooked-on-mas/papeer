from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from native_core_test_authority import core_repository
from papeer.core.edits.intents import assert_edit_intent
from _native_owner_api import owner_api

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures/shared-edits.json").read_text("utf-8"))
RECORDS = FIXTURE["intents"]
SCOPE = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "intent"}
TARGET = FIXTURE["document"]["id"]


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "library.sqlite3") as db:
            yield db
    repository = core_repository(connection, SCOPE)
    repository.initialize(FIXTURE["document"])
    return repository, connection


def test_intent_native_atomic_abort_restart_cas_and_scope_are_preserved(setup):
    repository, connection = setup
    with connection() as db:
        db.execute("CREATE TRIGGER fail_intent BEFORE INSERT ON edit_intents BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.Error, match="quota"):
        repository.replace_intent(TARGET, RECORDS[0], None)
    assert repository.read_intent(TARGET) is None
    with connection() as db:
        db.execute("DROP TRIGGER fail_intent")
    expected = None
    for record in RECORDS:
        assert repository.replace_intent(TARGET, record, expected) == {"status": "written"}
        assert repository.replace_intent(TARGET, record, expected) == {"status": "written"}
        expected = record["id"]
    restarted = core_repository(connection, SCOPE)
    assert restarted.read_intent(TARGET) == RECORDS[-1]
    assert restarted.pending_intents() == [{"targetId": TARGET, "record": RECORDS[-1]}]
    assert restarted.replace_intent(TARGET, None, RECORDS[0]["id"]) == {"status": "conflict"}
    for changes in [{"accountId": "other"}, {"epoch": "other"}, {"libraryId": FIXTURE["markdown"]["id"]}]:
        assert core_repository(connection, {**SCOPE, **changes}).read_intent(TARGET) is None
    assert restarted.replace_intent(TARGET, None, RECORDS[-1]["id"]) == {"status": "cleared"}
    assert restarted.replace_intent(TARGET, None, RECORDS[-1]["id"]) == {"status": "cleared"}


@pytest.mark.parametrize("fault", ["dispatched", "undo", "inverse", "request", "history", "scope"])
def test_intent_cannot_lose_an_undo_request_inverse_or_original_payload(setup, fault):
    repository, _ = setup
    original = RECORDS[-1]
    repository.replace_intent(TARGET, original, None)
    value = deepcopy(original)
    value["id"] = "00000000-0000-0000-0000-000000009999"
    if fault == "dispatched":
        value["intent"]["dispatched"] = False
    elif fault == "undo":
        value["intent"]["undoRequested"] = False
    elif fault == "inverse":
        value["intent"].pop("inverse")
    elif fault == "request":
        value["intent"]["request"]["batch"]["changes"][0]["annotation"]["style"]["color"] = "#000000"
    elif fault == "history":
        value["intent"]["inverse"]["history"]["afterVersion"] = TARGET
    else:
        value["intent"]["request"]["batch"]["libraryId"] = TARGET
    with pytest.raises(ValueError):
        repository.replace_intent(TARGET, value, original["id"])
    assert repository.read_intent(TARGET) == original


def test_database_backup_contains_the_pending_intent_and_its_referenced_parent(setup, tmp_path):
    repository, connection = setup
    repository.replace_intent(TARGET, RECORDS[2], None)
    target = tmp_path / "backup.sqlite3"
    with connection() as source, sqlite3.connect(target) as backup:
        source.backup(backup)
    @contextmanager
    def backed_up():
        with sqlite3.connect(target) as db:
            yield db
    restored = core_repository(backed_up, SCOPE)
    assert restored.read_intent(TARGET) == RECORDS[2]
    assert restored.read(TARGET)["checkpoint"]["root"] == FIXTURE["document"]
    assert restored.receipt(FIXTURE["batches"][0]["id"]) is None


def test_intent_api_preserves_the_complete_payload_and_rejects_invalid_scope(monkeypatch, tmp_path):
    # Real bearer, durable grant, lease and admission; the fixture document is seeded at the grant namespace.
    with owner_api(tmp_path, monkeypatch, SCOPE["libraryId"], SCOPE["epoch"], lambda repo: repo.initialize(FIXTURE["document"])) as api:
        repository = api.core()
        body = {"scope": api.scope, "targetId": TARGET}
        assert api.post("replace-intent", {**body, "record": RECORDS[-1], "expectedId": None}).json() == {"status": "written"}
        assert api.post("intent", body).json() == RECORDS[-1]
        assert api.post("replace-intent", {**body, "record": None, "expectedId": RECORDS[0]["id"]}).json() == {"status": "conflict"}
        assert api.post("replace-intent", {**body, "targetId": FIXTURE["markdown"]["id"], "record": RECORDS[-1], "expectedId": None}).status_code == 422
        # A scope other than the admitted one is refused by the authority before any repository access.
        assert api.post("intent", {**body, "scope": {**api.scope, "epoch": "other"}}).status_code == 403
        assert_edit_intent(repository.read_intent(TARGET), SCOPE["libraryId"], TARGET)
