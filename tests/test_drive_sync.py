from copy import deepcopy
import hashlib
from pathlib import Path
import threading

import pytest

from _legacy_library import legacy_backup, legacy_library
from papeer import __version__
from papeer.core import drive_sync as sync
from papeer.core.storage import SCHEMA_VERSION, Library, NewerSchemaError, database_version


class MemoryDrive:
    def __init__(self):
        self.items = []
        self.data = {}
        self.fail = False

    def revisions(self):
        return deepcopy(self.items)

    def upload(self, path, metadata, cancel, progress):
        if self.fail:
            raise OSError("offline")
        identity = str(len(self.items) + 1)
        self.items.append({**metadata, "id": identity, "created": "2026-09-27T00:00:00Z"})
        self.data[identity] = path.read_bytes()
        return identity

    def download(self, identity, path, cancel, progress):
        path.write_bytes(self.data[identity])


@pytest.fixture
def pair(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "device-state"))
    a, b = Library(tmp_path / "a"), Library(tmp_path / "b")
    for lib in (a, b):
        sync.save_state(lib.root, {"connected": True})
    identity, _ = a.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    return a, b, identity, MemoryDrive()


def run(lib, remote, **kwargs):
    return sync.sync(lib, remote, threading.Event(), lambda _: None, **kwargs)


def connect_pair(a, b, remote):
    run(a, remote)
    assert run(b, remote)["status"] == "conflict"
    run(b, remote, choice="1", expected_heads=["1"])
    run(a, remote)


def test_all_data_roundtrip_and_noop(pair):
    a, b, identity, remote = pair
    a.save_ink(identity, "original", 1, [{"id": "stroke", "points": [[1, 2]]}])
    a.update(identity, note="読書メモ", tags=["研究"])
    a.add_exchange(identity, "question", "answer")
    a.save_note_template("custom", "template")
    folder = a.folder(identity)
    for name, content in {"article.md": "サマリー", "translation.md": "訳文", "article-usage.json": "{}"}.items():
        (folder / name).write_text(content, "utf-8")
    (a.root / "prompts").mkdir()
    (a.root / "prompts" / "custom.txt").write_text("prompt")
    (a.root / "ui-state.json").write_text('{"last_paper":"' + identity + '"}')
    connect_pair(a, b, remote)
    assert sync.fingerprint(a) == sync.fingerprint(b)
    assert b.ink(identity, "original", 1)[0]["id"] == "stroke"
    assert b.paper(identity)["note"] == "読書メモ"
    assert (b.folder(identity) / "article.md").read_text("utf-8") == "サマリー"
    assert (b.root / "ui-state.json").read_bytes() == (a.root / "ui-state.json").read_bytes()
    assert sync.state_path(a.root).is_relative_to(a.root) is False
    count = len(remote.items)
    run(a, remote)
    run(b, remote)
    assert len(remote.items) == count


def test_edit_and_delete_propagate_without_losing_previous_copy(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="new note")
    run(a, remote)
    result = run(b, remote)
    assert result["reloaded"]
    assert b.paper(identity)["note"] == "new note"
    assert Library(Path(result["previous_path"])).paper(identity)["note"] == ""
    a.delete_paper(identity)
    run(a, remote)
    run(b, remote)
    assert not b.papers()


def test_conflicting_edits_require_choice_and_preserve_both(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    run(a, remote)
    heads = [item["id"] for item in sync.revision_heads(remote.items)]
    assert run(b, remote)["status"] == "conflict"
    assert b.paper(identity)["note"] == "B"
    with pytest.raises(ValueError, match="別のPC"):
        run(b, remote, choice="local", expected_heads=["stale"])
    result = run(b, remote, choice=heads[0], expected_heads=heads)
    assert b.paper(identity)["note"] == "A"
    assert Library(Path(result["previous_path"])).paper(identity)["note"] == "B"
    assert len(sync.revision_heads(remote.items)) == 1


def test_failed_upload_and_corrupt_download_leave_local_unchanged(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    before = sync.read_state(a.root)
    remote.fail = True
    with pytest.raises(OSError):
        run(a, remote)
    assert sync.read_state(a.root) == before
    remote.fail = False
    run(a, remote)
    head = sync.revision_heads(remote.items)[0]
    remote.data[head["id"]] = b"corrupt"
    with pytest.raises(ValueError, match="検証"):
        run(b, remote)
    assert b.paper(identity)["note"] == ""


def test_failed_resolution_upload_does_not_replace_local(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    run(a, remote)
    head = sync.revision_heads(remote.items)[0]["id"]
    remote.fail = True
    with pytest.raises(OSError):
        run(b, remote, choice=head, expected_heads=[head])
    assert b.paper(identity)["note"] == "B"


def test_concurrent_publications_remain_branches(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    observed = remote.revisions()
    run(a, remote)
    original = remote.revisions
    remote.revisions = lambda: observed
    run(b, remote)
    remote.revisions = original
    assert len(sync.revision_heads(remote.items)) == 2
    assert run(a, remote)["status"] == "conflict"
    assert run(b, remote)["status"] == "conflict"


def test_snapshot_waits_for_existing_requests(monkeypatch):
    from sidecar import deps
    monkeypatch.setattr(deps, "snapshot_running", lambda: False)
    assert deps.begin_library_request()
    entered = threading.Event()
    def worker():
        deps.wait_for_library_requests()
        entered.set()
    thread = threading.Thread(target=worker)
    thread.start()
    assert not entered.wait(0.05)
    deps.end_library_request()
    thread.join(2)
    assert entered.is_set()


def test_drive_api_sync_status_and_error_redaction(pair, monkeypatch):
    import time
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    a, _, _, remote = pair
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    sync.save_state(a.root, {"connected": True, "folder": str(a.root.parent / "shared")})
    monkeypatch.setattr(sync, "FolderDrive", lambda _: remote)
    with TestClient(app) as client:
        response = client.post("/api/drive/sync", json={})
        assert response.status_code == 200
        identity = response.json()["job_id"]
        deadline = time.monotonic() + 5
        while deps.job_manager.get_job(identity).running and time.monotonic() < deadline:
            time.sleep(0.01)
        job = deps.job_manager.get_job(identity)
        assert job.status == "succeeded", job.error
        state = client.get("/api/drive").json()
        assert state["last_sync"]
        assert "base" not in state and "hash" not in state

        def failure(_):
            raise RuntimeError("secret-token-in-oauth-url")
        monkeypatch.setattr(sync, "FolderDrive", failure)
        identity = client.post("/api/drive/sync", json={}).json()["job_id"]
        deadline = time.monotonic() + 5
        while deps.job_manager.get_job(identity).running and time.monotonic() < deadline:
            time.sleep(0.01)
        job = deps.job_manager.get_job(identity)
        assert job.status == "failed"
        assert "secret-token" not in job.error
        assert "secret-token" not in client.get("/api/drive").text

def test_cancel_during_the_final_replacement_keeps_the_library_and_retries_next_time(pair, monkeypatch):
    """Stopping just before the folders are swapped loses nothing: the next sync pulls the same revision."""
    from papeer.providers import Cancelled
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    state = sync.read_state(b.root)
    folders = sorted(b.root.parent.iterdir())
    cancel = threading.Event()
    original = sync.restore_backup

    def restore(lib, archive, stop=None):
        if Path(lib.root).resolve() == Path(b.root).resolve():
            cancel.set()  # the user cancels while the replacement starts
        return original(lib, archive, stop)

    monkeypatch.setattr(sync, "restore_backup", restore)
    with pytest.raises(Cancelled):
        sync.sync(b, remote, cancel, lambda _: None)
    assert b.paper(identity)["note"] != "A"
    assert sync.read_state(b.root) == state
    assert sorted(b.root.parent.iterdir()) == folders  # no half-restored or moved-aside folder
    assert run(b, remote)["reloaded"] is True
    assert Library(b.root).paper(identity)["note"] == "A"


def test_cancel_after_publishing_a_choice_offers_the_choice_again(pair, monkeypatch):
    """A merge revision is already published when the replacement is cancelled; this PC keeps its data."""
    from papeer.providers import Cancelled
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    assert run(b, remote)["status"] == "conflict"
    head = sync.revision_heads(remote.items)[0]["id"]
    cancel = threading.Event()
    upload = remote.upload

    def upload_then_cancel(*args):
        identity_ = upload(*args)
        cancel.set()
        return identity_

    monkeypatch.setattr(remote, "upload", upload_then_cancel)
    with pytest.raises(Cancelled):
        sync.sync(b, remote, cancel, lambda _: None, choice=head, expected_heads=[head])
    assert b.paper(identity)["note"] == "B"
    monkeypatch.setattr(remote, "upload", upload)
    result = run(b, remote)
    assert result["status"] == "conflict"
    merged = result["conflicts"][0]["id"]
    assert run(b, remote, choice=merged, expected_heads=[merged])["reloaded"] is True
    assert Library(b.root).paper(identity)["note"] == "A"


def publish_old_revision(remote, tmp_path):
    """A revision as a Papeer from before schema versioning published it: no schema_version,
    the hash taken over its own (unmigrated) database."""
    legacy = tmp_path / "old-pc"
    identity = legacy_library(legacy, "middle")
    archive = tmp_path / "old.zip"
    legacy_backup(legacy, archive)
    revision = str(len(remote.items) + 1)
    remote.items.append({"parents": [], "hash": sync.fingerprint(legacy), "device": "old-pc", "id": revision,
                         "archive_hash": hashlib.sha256(archive.read_bytes()).hexdigest(),
                         "created": "2026-09-01T00:00:00Z"})
    remote.data[revision] = archive.read_bytes()
    return identity, revision


def test_revision_from_before_schema_versioning_is_taken_and_migrated(pair, tmp_path):
    a, b, _, remote = pair
    identity, revision = publish_old_revision(remote, tmp_path)
    assert run(b, remote)["status"] == "conflict"
    # Validated against the database as the old PC hashed it, not as this version migrates it.
    assert run(b, remote, choice=revision, expected_heads=[revision])["reloaded"] is True
    lib = Library(b.root)
    assert database_version(b.root / "library.sqlite3") == SCHEMA_VERSION
    assert (lib.paper(identity)["tags"], lib.paper(identity)["bibliography_version"]) == (["古いタグ"], 1)
    # The choice republishes the old archive as it is, under its own version and hash.
    merged = remote.items[-1]
    assert (merged["schema_version"], merged["hash"]) == (0, remote.items[0]["hash"])
    # Migrating what was taken is not a change to publish.
    count = len(remote.items)
    run(Library(b.root), remote)
    assert len(remote.items) == count
    # Another PC accepts the republished revision too.
    assert run(a, remote)["status"] == "conflict"
    run(a, remote, choice=merged["id"], expected_heads=[merged["id"]])
    assert Library(a.root).paper(identity)["read_status"] == "積読"


def test_revisions_record_the_schema_and_app_versions(pair):
    a, _, _, remote = pair
    run(a, remote)
    assert (remote.items[0]["schema_version"], remote.items[0]["app_version"]) == (SCHEMA_VERSION, __version__)


def test_revision_from_a_newer_papeer_is_refused(pair):
    a, b, identity, remote = pair
    run(a, remote)
    remote.items[0].update(schema_version=SCHEMA_VERSION + 1, app_version="9.9.9")
    remote.data.clear()  # Refused before downloading anything.
    sync.save_state(b.root, {"connected": True, "hash": sync.fingerprint(b)})
    with pytest.raises(NewerSchemaError, match=r"新しいバージョンのPapeer（9\.9\.9）.*更新"):
        run(b, remote)
    with pytest.raises(NewerSchemaError):
        run(b, remote, choice="1", expected_heads=["1"])
    assert Library(b.root).papers() == []
