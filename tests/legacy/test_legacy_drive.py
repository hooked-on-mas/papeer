import base64
from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from papeer.core.migrations.legacy_drive import LegacyDriveRead
from papeer.core.migrations.legacy_backup import FileLegacyBackupStore, inventory_hash
from sidecar import deps
from sidecar.app import app
from sidecar.routes import edits
from tools.legacy_drive_fixture import FixtureLegacyDrive

FIXTURES = Path(__file__).parent.parent / "fixtures"
FIXTURE = json.loads((FIXTURES / "shared-legacy-drive.json").read_text("utf-8"))


def artifact():
    data = deepcopy(json.loads((FIXTURES / "shared-edits.json").read_text("utf-8"))["legacyBackup"])
    data["plan"]["manifest"]["source"] = {"kind": "drive", "id": "permission/library"}
    data["plan"]["manifest"]["inventorySha256"] = inventory_hash(data["plan"]["manifest"])
    return data


def test_read_only_drive_transport_collects_pagination_both_kinds_raw_bytes_and_exact_int64_versions():
    drive = FixtureLegacyDrive(FIXTURE)
    port = LegacyDriveRead(drive)
    assert port.account() == FIXTURE["identity"]["accountId"]
    library = FIXTURE["identity"]["libraryId"]
    assert port.metadata(library)["version"] == "9007199254740993"
    root = port.children("legacy-folder")
    assert len(root) > 2 and any("pageToken=" in url for url in drive.calls)
    assert [file["id"] for file in port.library_files(library, "ink-v1")] == ["ink-operation"]
    assert [file["id"] for file in port.library_files(library, "notes-v1")] == ["note-operation", "referenced-note-operation"]
    assert [file["id"] for file in port.library_files(library, "note-blob-v1")] == ["note-blob"]
    assert port.read("note-operation") == b'{bad JSON: preserve before parsing'
    before = len(drive.calls)
    for identity in ("../escape", "x'query", "valid\n", "a" * 201):
        with pytest.raises(ValueError):
            port.metadata(identity)
    with pytest.raises(ValueError):
        port.library_files(library, "wrong-kind")
    assert len(drive.calls) == before
    drive.fixture["incompleteSearch"] = True
    with pytest.raises(ValueError, match="incomplete-list"):
        port.children("legacy-folder")


def test_file_artifacts_require_a_fixed_plan_and_all_bodies_before_publication_and_survive_restart(tmp_path):
    fixture = artifact()
    plan = fixture["plan"]
    store = FileLegacyBackupStore(tmp_path / "artifacts", plan["manifest"]["source"])
    assert store.plan(plan["manifest"]["id"]) is None and not store.root.exists()
    with pytest.raises(ValueError, match="backup-plan-changed"):
        store.publish(plan["manifest"])
    store.prepare(plan)
    with pytest.raises(OSError):
        store.publish(plan["manifest"])
    assert store.reference(plan["manifest"]["id"]) is None
    bodies = {body["sha256"]: base64.b64decode(body["dataBase64"]) for body in fixture["bodies"]}
    for entry in plan["manifest"]["entries"]:
        store.put_object(entry, bodies[entry["sha256"]])
    restarted = FileLegacyBackupStore(store.root, store.source)
    restarted.publish(plan["manifest"])
    assert restarted.manifest(plan["manifest"]["id"]) == plan["manifest"]
    changed = deepcopy(plan)
    changed["observationSha256"] = "0" * 64
    with pytest.raises(ValueError, match="backup-id-reused"):
        restarted.prepare(changed)
    entry = plan["manifest"]["entries"][0]
    with pytest.raises(ValueError, match="backup-object-hash"):
        restarted.put_object(entry, b"wrong")
    (store.root / "objects" / entry["sha256"]).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="backup-object-hash"):
        restarted.manifest(plan["manifest"]["id"])
    assert restarted.reference(plan["manifest"]["id"]) == plan["manifest"]


def test_authenticated_artifact_and_drive_api_do_not_initialize_or_mutate_the_legacy_library(tmp_path, monkeypatch):
    root = tmp_path / "library"
    root.mkdir()
    (root / "library.sqlite3").write_bytes(b"do not open or recover")
    before = (root / "library.sqlite3").read_bytes()
    monkeypatch.setattr(deps, "get_data_dir", lambda: root)
    monkeypatch.setattr(deps, "get_library", lambda: (_ for _ in ()).throw(AssertionError("must not initialize old Library")))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "0")
    monkeypatch.setenv("PAPEER_TOKEN", "fixture-secret")
    monkeypatch.setattr(edits, "legacy_drive_storage", lambda: LegacyDriveRead(FixtureLegacyDrive(FIXTURE)))
    client = TestClient(app)
    fixture = artifact()
    plan = fixture["plan"]
    source = plan["manifest"]["source"]
    route = "/api/edits/backup-artifacts/"
    assert client.post(route + "plan", json={"source": source, "id": plan["manifest"]["id"]}).status_code == 401
    client.headers["Authorization"] = "Bearer fixture-secret"
    assert client.post("/api/edits/legacy-drive/account", json={}).json() == FIXTURE["identity"]["accountId"]
    assert client.post("/api/edits/legacy-drive/metadata", json={"fileId": "bad'query"}).status_code == 422
    assert client.post(route + "prepare", json={"source": source, "plan": plan}).status_code == 200
    assert client.post(route + "publish", json={"source": source, "manifest": plan["manifest"]}).status_code == 503
    bodies = {body["sha256"]: body["dataBase64"] for body in fixture["bodies"]}
    for entry in plan["manifest"]["entries"]:
        result = client.post(route + "put-object", json={"source": source, "entry": entry, "dataBase64": bodies[entry["sha256"]]})
        assert result.status_code == 200, result.text
    assert client.post(route + "publish", json={"source": source, "manifest": plan["manifest"]}).status_code == 200
    assert client.post(route + "manifest", json={"source": source, "id": plan["manifest"]["id"]}).json() == plan["manifest"]
    other = {"kind": "drive", "id": "another account/library"}
    assert client.post(route + "manifest", json={"source": other, "id": plan["manifest"]["id"]}).json() is None
    assert (root / "library.sqlite3").read_bytes() == before
    assert list(root.iterdir()) == [root / "library.sqlite3"]
