"""Device input is captured before settings migration, without following credentials or unrelated state."""
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from papeer.core import paths
from papeer.core.migrations.legacy_device import NativeLegacyDeviceBackup
from sidecar import deps
from sidecar.app import app


@pytest.fixture
def device(tmp_path):
    library, root = tmp_path / "library", tmp_path / "device"
    library.mkdir()
    root.mkdir()
    (library / "library.sqlite3").write_bytes(b"must not open or recover")
    key, custom, other = paths.library_key(library), "c" * 64, "f" * 64
    values = {
        "device-settings.json": b'{"provider_options":{"api":{"base_url":"http://local-model"}}}',
        "history-settings.json": b'{"keep":42}', "ocr-settings.json": b'{"language":"jpn"}',
        "storage-location.json": json.dumps({"path": str(library.resolve()), "history_key": custom}).encode(),
        ".device-settings.json.interrupted.tmp": b"interrupted settings", key + ".json": b'{"last_revision":"shared-base"}',
        key + ".cloud-drive.json": b'{"manifest_id":"remote-manifest"}', key + ".sync-blobs.json": b'{"first_seen":"keep"}',
        key + ".opened.json": b'{"paper":42}', key + ".review-pages.json": b'{"page":3}', key + ".future-record": b"unknown durable keyed record",
        "." + key + ".cloud-drive.json.interrupted.tmp": b"pending device write", key + ".search.sqlite3": b"raw search cache",
        key + ".search.sqlite3-wal": b"raw WAL", key + ".search.sqlite3-shm": b"raw SHM",
        "history/" + key + "/state.json": b"current history", "history/" + custom + "/pending.tmp": b"relocated history",
        "google-drive-credentials.dpapi": b"excluded credential", "instances/active.json": b"excluded process state",
        "logs/current.log": b"excluded log", "tessdata/fast/jpn.traineddata": b"rebuildable OCR model",
        other + ".json": b"another library", "history/" + other + "/state.json": b"another history",
    }
    for name, value in values.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
    (root / "history" / custom / "empty").mkdir()
    return library, root, key, custom, other, values


def test_device_capture_preserves_durable_records_history_alias_raw_wal_unknown_keyed_files_and_interrupted_writes(device, monkeypatch):
    library, root, key, custom, other, values = device
    excluded = {"google-drive-credentials.dpapi", "instances/active.json", "logs/current.log", "tessdata/fast/jpn.traineddata", other + ".json", "history/" + other + "/state.json"}
    original_open = Path.open

    def restricted(path, *args, **kwargs):
        if path.is_relative_to(root) and path.relative_to(root).as_posix() in excluded:
            raise AssertionError("excluded input was opened")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", restricted)
    port = NativeLegacyDeviceBackup(library, root)
    plan = port.inventory(str(uuid4()))
    assert plan["manifest"]["source"]["kind"] == "desktop-device"
    assert {"/".join(entry["key"]) for entry in plan["manifest"]["entries"]} == set(values) - excluded
    assert ["history", custom, "empty"] in plan["manifest"]["containers"]
    manifest = port.capture(plan)
    for entry in manifest["entries"]:
        assert port.object(manifest["id"], entry) == values["/".join(entry["key"])]
    restarted = NativeLegacyDeviceBackup(library, root)
    assert restarted.load(manifest["id"]) == manifest and restarted.plan(manifest["id"]) == plan
    restarted.assert_current(plan)
    assert (library / "library.sqlite3").read_bytes() == b"must not open or recover"
    assert key in {container[1] for container in manifest["containers"] if len(container) == 2 and container[0] == "history"}


def test_missing_device_source_is_an_empty_immutable_input_without_creating_or_initializing_it(tmp_path):
    library, root = tmp_path / "library", tmp_path / "not-created"
    library.mkdir()
    port = NativeLegacyDeviceBackup(library, root)
    plan = port.inventory(str(uuid4()))
    assert plan["manifest"]["entries"] == [] and plan["manifest"]["containers"] == [] and not root.exists()
    assert port.capture(plan) == plan["manifest"] and not root.exists()
    root.mkdir()
    (root / "google-drive-credentials.dpapi").write_bytes(b"new process credential")
    with pytest.raises(ValueError, match="backup-source-changed"):
        port.assert_current(plan)
    current = port.inventory(str(uuid4()))
    assert current["manifest"]["entries"] == [] and port.capture(current) == current["manifest"]
    assert NativeLegacyDeviceBackup(library, root).load(plan["manifest"]["id"]) == plan["manifest"]


def test_unrelated_process_credential_log_and_other_library_churn_does_not_invalidate_the_selected_footprint(device, monkeypatch):
    library, root, _key, _custom, other, _values = device
    port = NativeLegacyDeviceBackup(library, root)
    plan = port.inventory(str(uuid4()))
    copy = port._copy

    def noisy(entry):
        copy(entry)
        (root / "google-drive-credentials.dpapi").write_bytes(b"rotated credential")
        (root / "logs/another.log").write_bytes(b"new log")
        (root / (other + ".late.json")).write_bytes(b"unrelated state")
        (root / "history" / other / "late.json").write_bytes(b"unrelated history")

    monkeypatch.setattr(port, "_copy", noisy)
    assert port.capture(plan) == plan["manifest"]
    port.assert_current(plan)


def test_late_selected_records_keep_the_fixed_plan_and_never_publish_partial_completion(device, monkeypatch):
    library, root, key, _custom, _other, _values = device
    port = NativeLegacyDeviceBackup(library, root)
    plan = port.inventory(str(uuid4()))
    copy = port._copy

    def late(entry):
        copy(entry)
        (root / (key + ".late-record.json")).write_bytes(b"durable later input")

    monkeypatch.setattr(port, "_copy", late)
    with pytest.raises(ValueError, match="backup-source-changed"):
        port.capture(plan)
    assert port.load(plan["manifest"]["id"]) is None and port.plan(plan["manifest"]["id"]) == plan
    restarted = NativeLegacyDeviceBackup(library, root)
    manifest = restarted.capture(restarted.inventory(str(uuid4())))
    assert any(entry["key"] == [key + ".late-record.json"] for entry in manifest["entries"])


def test_history_selection_refreshes_each_scan_and_damaged_location_keeps_raw_bytes_and_every_potential_history(device):
    library, root, _key, _custom, other, _values = device
    port = NativeLegacyDeviceBackup(library, root)
    before = port.inventory(str(uuid4()))
    (root / "storage-location.json").write_text(json.dumps({"path": str(library.resolve()), "history_key": other}), "utf-8")
    with pytest.raises(ValueError, match="backup-source-changed"):
        port.assert_current(before)
    current = port.inventory(str(uuid4()))
    assert any(entry["key"] == ["history", other, "state.json"] for entry in current["manifest"]["entries"])
    completed = port.capture(current)
    (root / "storage-location.json").write_bytes(b'{bad JSON: raw history association')
    damaged = port.inventory(str(uuid4()))
    assert any(entry["key"] == ["history", other, "state.json"] for entry in damaged["manifest"]["entries"])
    assert port.capture(damaged) == damaged["manifest"]
    assert NativeLegacyDeviceBackup(library, root).load(completed["id"]) == completed


def test_device_api_uses_the_server_footprint_and_never_settings_load_or_legacy_library(device, monkeypatch):
    library, root, _key, _custom, _other, _values = device
    before = hashlib.sha256((library / "library.sqlite3").read_bytes()).hexdigest()
    monkeypatch.setattr(paths, "device_directory", lambda: root)
    monkeypatch.setattr(deps, "get_data_dir", lambda: library)
    monkeypatch.setattr(deps, "get_library", lambda: (_ for _ in ()).throw(AssertionError("must not initialize old Library")))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    client = TestClient(app)
    base = "/api/edits/legacy-backup/"
    plan = client.post(base + "inventory", json={"area": "device", "id": str(uuid4())}).json()
    result = client.post(base + "capture", json={"area": "device", "plan": plan})
    assert result.status_code == 200, result.text
    assert result.json() == plan["manifest"]
    assert client.post(base + "load", json={"area": "device", "id": plan["manifest"]["id"]}).json() == plan["manifest"]
    assert client.post(base + "load", json={"area": "legacy", "id": plan["manifest"]["id"]}).json() is None
    assert client.post(base + "inventory", json={"area": "device", "id": str(uuid4()), "path": str(root.parent)}).status_code == 422
    assert hashlib.sha256((library / "library.sqlite3").read_bytes()).hexdigest() == before
