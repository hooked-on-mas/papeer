"""Admission is checked before any legacy recovery writes; it is not writer-quiescence proof."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from papeer.core.edit_contracts import validate_legacymigrationhold
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from papeer.core.migrations.legacy_startup import NativeLegacyStartup, LegacyMigrationRequired, legacy_startup_allowed
from papeer.core.storage import Library
from sidecar import deps
from sidecar.app import app, remove_unused_translation_runs, allowed_during_snapshot
from papeer.translation import translation_preview


def test_migration_admission_corpus_matches_the_typescript_contract():
    corpus = json.loads((Path(__file__).parent.parent / "fixtures/shared-edits.json").read_text("utf-8"))["legacyMigrationHolds"]
    for case in corpus:
        if case["valid"]:
            validate_legacymigrationhold(case["value"])
        else:
            with pytest.raises(ValueError):
                validate_legacymigrationhold(case["value"])


def test_hold_is_immutable_durable_and_blocks_library_initialization_before_database_or_journal_recovery(tmp_path):
    root = tmp_path / "library"
    root.mkdir()
    original = {"library.sqlite3": b"do not even try SQL", ".notebook-change.json": b'{"pending":"keep raw"}'}
    for key, value in original.items():
        (root / key).write_bytes(value)
    startup = NativeLegacyStartup(root)
    assert startup.read() is None and not startup.root.exists()
    hold = {"version": 1, "runId": str(uuid4())}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: NativeLegacyStartup(root).hold(hold), range(2)))
    assert results == [hold, hold] and NativeLegacyStartup(root).read() == hold
    with pytest.raises(LegacyMigrationRequired):
        startup.hold({**hold, "runId": str(uuid4())})
    with pytest.raises(LegacyMigrationRequired):
        Library(root)
    assert {path.name: path.read_bytes() for path in root.iterdir()} == original
    assert not legacy_startup_allowed(root)
    # Raw capture is deliberately possible while startup is held; it does not initialize Library.
    backup = NativeLegacyBackup(root)
    plan = backup.inventory(str(uuid4()))
    assert backup.capture(plan) == plan["manifest"]
    assert NativeLegacyStartup(root).read() == hold


def test_corrupt_hold_stays_blocked_and_startup_cleanup_never_touches_the_source(tmp_path, monkeypatch):
    root = tmp_path / "library"
    root.mkdir()
    startup = NativeLegacyStartup(root)
    hold = {"version": 1, "runId": str(uuid4())}
    startup.hold(hold)
    monkeypatch.setattr(deps, "get_data_dir", lambda: root)
    monkeypatch.setattr(translation_preview, "remove_unused_translation_runs", lambda _: (_ for _ in ()).throw(AssertionError("startup cleanup wrote legacy input")))
    remove_unused_translation_runs()
    startup.path.write_text('{"version":1,"runId":"damaged"}', "utf-8")
    assert not legacy_startup_allowed(root)
    remove_unused_translation_runs()
    with pytest.raises(LegacyMigrationRequired):
        Library(root)
    assert list(root.iterdir()) == []
    with pytest.raises(ValueError):
        startup.read()


def test_oversized_hold_stays_blocked_without_opening_the_library(tmp_path):
    root = tmp_path / 'library'; root.mkdir()
    original = root / 'original'; original.write_bytes(b'untouched')
    startup = NativeLegacyStartup(root)
    startup.hold({'version': 1, 'runId': str(uuid4())})
    startup.path.write_bytes(b'x' * 65_537)
    with pytest.raises(ValueError, match='backup-read-limit'):
        startup.read()
    assert not legacy_startup_allowed(root)
    assert original.read_bytes() == b'untouched'


def test_startup_api_is_authenticated_and_never_coerces_a_malformed_or_conflicting_hold(tmp_path, monkeypatch):
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(deps, "get_data_dir", lambda: root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "0")
    monkeypatch.setenv("PAPEER_TOKEN", "startup-fixture")
    client = TestClient(app)
    base = "/api/edits/legacy-startup/"
    assert client.post(base + "read", json={}).status_code == 401
    client.headers["Authorization"] = "Bearer startup-fixture"
    assert client.post(base + "read", json={}).json() is None
    hold = {"version": 1, "runId": str(uuid4())}
    invalid = deepcopy(hold)
    invalid["autoRelease"] = True
    assert client.post(base + "hold", json={"hold": invalid}).status_code == 422
    assert client.post(base + "read", json={}).json() is None
    assert client.post(base + "hold", json={"hold": hold}).json() == hold
    assert client.post(base + "hold", json={"hold": {**hold, "runId": str(uuid4())}}).status_code == 409
    assert client.post(base + "read", json={}).json() == hold
    # This route can write settings/device migrations without ever creating Library.
    assert client.get("/api/settings").status_code == 409
    assert client.get("/api/papers").json()["code"] == "legacy_migration_required"
    assert list(root.iterdir()) == []
    assert allowed_during_snapshot("POST", base + "read"), "metadata admission must answer without opening a busy legacy library"
    assert not allowed_during_snapshot("POST", base + "hold")
