"""Canonical native staging must leave the raw legacy source byte-for-byte unchanged."""
from copy import deepcopy
import json
from pathlib import Path
from uuid import uuid4

from native_core_test_authority import core_repository
from papeer.core.edit_storage import canonical_edit_connection, edit_storage_root
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from _native_owner_api import TOKEN, owner_api
from sidecar import deps

FIXTURE = json.loads((Path(__file__).parent / "fixtures/shared-edits.json").read_text("utf-8"))
SCOPE = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "separate-native"}


def test_target_staging_and_process_reopen_preserve_the_entire_raw_legacy_observation(tmp_path):
    source = tmp_path / "legacy"
    source.mkdir()
    (source / "library.sqlite3").write_bytes(b"input must not be opened/recovered as a database")
    (source / ".notebook-change.json").write_text('{"pending":true}', "utf-8")
    backup = NativeLegacyBackup(source)
    plan = backup.inventory("00000000-0000-0000-0000-000000009980")
    backup.capture(plan)
    repository = core_repository(canonical_edit_connection(source), SCOPE)
    repository.initialize(FIXTURE["document"])
    batch = deepcopy(FIXTURE["batches"][0])
    assert repository.commit(batch)["status"] == "durable"
    restarted = core_repository(canonical_edit_connection(source), SCOPE)
    assert restarted.read(FIXTURE["document"]["id"])["heads"] == [batch["id"]]
    backup.assert_current(plan)
    assert (edit_storage_root(source) / "content.sqlite3").is_file()
    assert (source / "library.sqlite3").read_bytes() == b"input must not be opened/recovered as a database"


def test_default_native_api_does_not_depend_on_legacy_library_initialization(tmp_path, monkeypatch):
    # The owner API needs the real bearer, durable grant, lease and admission; development no-auth grants no owner
    # authority and initialize is closed to the owner (D2), so the root is seeded through the test-only Core harness.
    source = tmp_path / "legacy"
    source.mkdir()
    seed = lambda repo: repo.initialize(FIXTURE["document"])  # noqa: E731
    with owner_api(tmp_path, monkeypatch, SCOPE["libraryId"], SCOPE["epoch"], seed, data_dir=source) as api:
        client, scope = api.client, api.scope
        before = api.rows()
        assert api.post("initialize", {"scope": scope, "root": FIXTURE["document"]}).status_code == 403
        assert api.rows() == before
        assert api.post("read", {"scope": scope, "targetId": FIXTURE["document"]["id"]}).json()["heads"] == [FIXTURE["document"]["version"]]
        monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
        monkeypatch.setattr(deps, "get_auth_token", lambda: None)
        assert client.post("/api/edits/read", json={"scope": scope, "targetId": FIXTURE["document"]["id"]},
                           headers={key: value for key, value in api.headers.items() if key != "Authorization"}).status_code == 403
        monkeypatch.delenv("PAPEER_DEV_NO_AUTH")
        monkeypatch.setattr(deps, "get_auth_token", lambda: TOKEN)
        # An old source appearing later must be retained and block ordinary I/O,
        # while explicit raw backup remains available for deliberate recovery.
        (source / "library.sqlite3").write_bytes(b"raw input")
        assert client.post('/api/edits/legacy-startup/presence', json={}, headers={"Authorization": api.headers["Authorization"]}).json() == 'legacy-present'
        assert api.post("read", {"scope": scope, "targetId": FIXTURE["document"]["id"]}).status_code == 403
        assert (source / "library.sqlite3").read_bytes() == b"raw input"
        auth = {"Authorization": api.headers["Authorization"]}
        plan = client.post("/api/edits/legacy-backup/inventory", json={"id": str(uuid4()), "area": "canonical"}, headers=auth).json()
        assert plan["manifest"]["entries"][0]["key"] == ["content.sqlite3"]
        assert client.post("/api/edits/legacy-backup/capture", json={"plan": plan, "area": "canonical"}, headers=auth).json() == plan["manifest"]
        assert client.post("/api/edits/legacy-backup/load", json={"id": plan["manifest"]["id"], "area": "legacy"}, headers=auth).json() is None
        assert client.post("/api/edits/legacy-backup/inventory", json={"id": str(uuid4()), "area": "arbitrary-path"}, headers=auth).status_code == 422
