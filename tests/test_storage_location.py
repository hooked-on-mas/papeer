"""Local storage selection replaces folder sync; a failed change never selects a partial library."""
from contextlib import contextmanager
import json
import os
import sqlite3
import subprocess
import sys
import time

from fastapi.testclient import TestClient
import pytest

from papeer.core import cloud_drive, paths, storage_location as location
from papeer.core.instance import LibraryLock
from papeer.core.storage import Library, LibraryMissingError
from sidecar import deps
from sidecar.app import app
from sidecar.lifecycle.jobs import JobManager


@pytest.fixture
def library(monkeypatch):
    monkeypatch.delenv("PAPEER_DATA_DIR", raising=False)
    monkeypatch.delenv("PAPERDESK_DATA_DIR", raising=False)
    lib = Library(paths.data_directory())
    (lib.root / "memo.md").write_text("initial", "utf-8")
    with lib.connection() as db:
        db.execute("CREATE TABLE storage_probe(value TEXT)")
        db.execute("INSERT INTO storage_probe VALUES ('initial')")
    return lib


@contextmanager
def locked(root):
    lock = LibraryLock()
    assert lock.try_acquire(root)
    try:
        yield lock
    finally:
        lock.release()


def test_change_copies_the_latest_library_only_at_restart(library, tmp_path):
    source, target = library.root, tmp_path / "new" / "Papeer"
    cloud_drive.save_state(source, {"folder_id": "existing-drive-library", "auto_upload": True})
    history = paths.history_directory(source)
    history.mkdir(parents=True)
    (history / "keep.txt").write_text("history", "utf-8")
    location.schedule(source, str(target))
    assert paths.data_directory() == source
    assert not target.exists()
    (source / "memo.md").write_text("edited after scheduling", "utf-8")
    with library.connection() as db:
        db.execute("UPDATE storage_probe SET value = 'latest'")
    with locked(source) as lock:
        assert location.apply_pending(source, lock) == target
    assert paths.data_directory() == target
    assert (target / "memo.md").read_text("utf-8") == "edited after scheduling"
    with sqlite3.connect(target / "library.sqlite3") as db:
        assert db.execute("SELECT value FROM storage_probe").fetchone() == ("latest",)
    assert (source / "memo.md").exists()
    assert paths.history_directory(target) == history
    assert cloud_drive.state(target)["folder_id"] == "existing-drive-library"
    assert location.status(target)["pending_path"] is None
    assert not list(target.parent.glob(".papeer-storage-*"))
    # Selecting the destination does not turn on the retired folder sync.
    assert not paths.sync_state_path(target).exists()


@pytest.mark.parametrize("kind", ["same", "child", "parent", "nonempty", "file", "relative", "device", "blank"])
def test_invalid_destination_is_rejected_without_changing_settings(library, tmp_path, kind):
    root = library.root
    nonempty = tmp_path / "occupied"
    nonempty.mkdir()
    (nonempty / "user.txt").write_text("keep", "utf-8")
    values = {"same": str(root), "child": str(root / "child"), "parent": str(root.parent),
              "nonempty": str(nonempty), "file": str(nonempty / "user.txt"), "relative": "relative/path",
              "device": str(paths.device_directory() / "data"), "blank": " "}
    with pytest.raises(ValueError):
        location.schedule(root, values[kind])
    assert not paths.storage_location_settings()
    assert (nonempty / "user.txt").read_text("utf-8") == "keep"


def test_cancel_keeps_current_location_and_data(library, tmp_path):
    location.schedule(library.root, str(tmp_path / "new"))
    assert location.cancel(library.root)["pending_path"] is None
    assert paths.data_directory() == library.root
    assert (library.root / "memo.md").exists()


def test_history_remains_restorable_after_repeated_location_changes(library, tmp_path):
    from papeer.core import drive_sync, history_restore, local_history

    entry = local_history.record_folder(library.root, library.root, kind="publish",
                                        library_hash=drive_sync.fingerprint(library), counts=None)
    assert entry is not None
    original_history = paths.history_directory(library.root)
    current = library.root
    for name in ("first", "second"):
        target = tmp_path / name
        location.schedule(current, str(target))
        with locked(current) as lock:
            assert location.apply_pending(current, lock) == target
        assert paths.history_directory(target) == original_history
        assert entry in {item["id"] for item in local_history.entries(target)}
        current = target
    (current / "memo.md").write_text("newer", "utf-8")
    history_restore.restore_entry(Library(current), entry, None, lambda _: None, import_settings=True)
    assert (current / "memo.md").read_text("utf-8") == "initial"


@pytest.mark.parametrize("reason", ["copy", "space", "occupied", "locked", "source-lock"])
def test_failed_copy_keeps_the_source_selected(library, tmp_path, monkeypatch, reason):
    root, target = library.root, tmp_path / "destination"
    target.mkdir()  # An empty destination is allowed.
    location.schedule(root, str(target))
    target_lock = LibraryLock()
    if reason == "copy":
        def fail(*_):
            raise OSError("copy interrupted")
        monkeypatch.setattr(location, "_copy_file", fail)
    elif reason == "space":
        def no_space(*_):
            raise ValueError("空き容量が不足しています")
        monkeypatch.setattr(location, "ensure_free_space", no_space)
    elif reason == "occupied":
        (target / "new-user-file").write_text("keep", "utf-8")
    elif reason == "locked":
        assert target_lock.try_acquire(target)
    try:
        with locked(root) as lock:
            assert location.apply_pending(root, LibraryLock() if reason == "source-lock" else lock) == root
    finally:
        target_lock.release()
    assert paths.data_directory() == root
    assert location.status(root)["error"]
    assert (root / "memo.md").read_text("utf-8") == "initial"
    assert not (target / "library.sqlite3").exists()
    assert not list(target.parent.glob(".papeer-storage-*"))


def test_environment_override_takes_precedence(library, tmp_path, monkeypatch):
    location.schedule(library.root, str(tmp_path / "next"))
    override = tmp_path / "override"
    monkeypatch.setenv("PAPEER_DATA_DIR", str(override))
    assert paths.data_directory() == override
    assert location.status(override)["overridden"]
    with pytest.raises(ValueError, match="環境変数"):
        location.schedule(override, str(tmp_path / "other"))


def test_missing_selected_library_is_never_recreated(library, tmp_path):
    target = tmp_path / "new"
    location.schedule(library.root, str(target))
    with locked(library.root) as lock:
        location.apply_pending(library.root, lock)
    (target / "library.sqlite3").unlink()
    assert location.status(target)["missing"]
    with pytest.raises(LibraryMissingError):
        Library(target)
    assert not (target / "library.sqlite3").exists()


def test_invalid_location_setting_does_not_fall_back_to_empty_library(library):
    setting = paths.device_directory() / "storage-location.json"
    setting.parent.mkdir(parents=True, exist_ok=True)
    setting.write_text(json.dumps({"path": "relative"}), "utf-8")
    with pytest.raises(ValueError, match="保存先の設定"):
        paths.data_directory()


def test_oversized_location_setting_does_not_fall_back_to_empty_library(library):
    setting = paths.device_directory() / "storage-location.json"
    setting.parent.mkdir(parents=True, exist_ok=True)
    setting.write_text(json.dumps({"path": str(library.root), "padding": "x" * 65_536}), "utf-8")
    with pytest.raises(ValueError, match="保存先の設定"):
        paths.data_directory()
    assert (library.root / "memo.md").read_text("utf-8") == "initial"


def test_storage_api_authentication_selection_and_cancel(library, tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_TOKEN", "storage-test-token")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    headers = {"Authorization": "Bearer storage-test-token"}
    with TestClient(app) as client:
        assert client.get("/api/storage").status_code == 401
        assert client.put("/api/storage", json={"path": str(tmp_path / "new")}).status_code == 401
        result = client.put("/api/storage", headers=headers, json={"path": str(tmp_path / "new")})
        assert result.status_code == 200
        assert result.json()["path"] == str(library.root)
        assert result.json()["pending_path"] == str(tmp_path / "new")
        assert client.delete("/api/storage/pending", headers=headers).json()["pending_path"] is None


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/api/drive"), ("POST", "/api/drive/folder"), ("PUT", "/api/drive"),
    ("GET", "/api/drive/check"), ("POST", "/api/drive/sync"), ("POST", "/api/drive/migrate"),
])
def test_folder_sync_is_no_longer_available(library, monkeypatch, method, path):
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(app) as client:
        assert client.request(method, path, json={}).status_code == 404


@pytest.mark.parametrize("occupied", [False, True])
def test_real_startup_preserves_pending_location_until_explicit_admission(library, tmp_path, occupied):
    """Canonical startup keeps both old roots/settings unchanged for deliberate P6 admission."""
    from papeer.core.instance import read_instance
    from urllib.request import Request, urlopen

    root, target = library.root, tmp_path / "new-library"
    location.schedule(root, str(target))
    if occupied:
        target.mkdir()
        (target / "existing.txt").write_text("keep", "utf-8")
    setting = paths.device_directory() / "storage-location.json"
    setting_before = setting.read_bytes(), setting.stat().st_mtime_ns

    def bodies(folder):
        return {path.relative_to(folder).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in folder.rglob('*') if path.is_file()} if folder.exists() else None

    source_before, target_before = bodies(root), bodies(target)
    env = os.environ | {"PAPEER_TOKEN": "storage-startup-token", "PAPEER_PORT": "0",
                        "PAPEER_WATCH_STDIN": "1", "PAPEER_LAUNCHER": "app"}
    process = subprocess.Popen([sys.executable, "-m", "sidecar"], env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    selected = root
    try:
        deadline = time.monotonic() + 60
        info = None
        while time.monotonic() < deadline and process.poll() is None:
            info = read_instance(selected)
            if info is not None:
                break
            time.sleep(0.05)
        assert info is not None, "sidecar did not advertise the selected library"
        assert info.data_dir == str(selected)
        request = Request(f"http://127.0.0.1:{info.port}/api/storage",
                          headers={"Authorization": "Bearer storage-startup-token"})
        with urlopen(request, timeout=15) as response:
            state = json.load(response)
        assert state["path"] == str(selected)
        assert state["error"] is None
        assert state["pending_path"] == str(target)
        assert (setting.read_bytes(), setting.stat().st_mtime_ns) == setting_before
        assert bodies(root) == source_before
        assert bodies(target) == target_before
        assert not list(target.parent.glob('.papeer-storage-*'))
        probe = LibraryLock()
        try:
            assert probe.try_acquire(selected) is False
            assert probe.try_acquire(target) is True
        finally:
            probe.release()
    finally:
        assert process.stdin is not None
        process.stdin.close()
        try:
            process.wait(30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(10)
        if process.stderr:
            process.stderr.close()
