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
    # Deleting the last paper empties the library, which both sides confirm (see test_shrunk_library_*).
    assert run(a, remote)["status"] == "review"
    run(a, remote, confirm=True)
    assert run(b, remote)["status"] == "review"
    run(b, remote, confirm=True)
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


# --- Safety checks: a library that lost most of its contents, a restored backup, a missing folder ---

def add_stickies(lib, identity, count):
    return [lib.add_bookmark(identity, 1, "original", f"quote {n}")["id"] for n in range(count)]


def test_revisions_record_what_the_library_holds(pair):
    a, _, identity, remote = pair
    a.update(identity, note="メモ")
    add_stickies(a, identity, 2)
    a.save_ink(identity, "original", 1, [{"id": "stroke"}])
    a.save_ink(identity, "original", 2, [])  # A page whose ink was erased is not counted.
    run(a, remote)
    assert remote.items[0]["counts"] == {"papers": 1, "notes": 1, "stickies": 2, "ink": 1}
    assert sync.read_state(a.root)["counts"] == remote.items[0]["counts"]


@pytest.mark.parametrize("before,after,shrunk", [
    ({"stickies": 10}, {"stickies": 5}, ["stickies"]),   # 5 of 10: both the floor and half
    ({"stickies": 10}, {"stickies": 6}, []),             # less than half
    ({"stickies": 4}, {"stickies": 0}, []),              # fewer than 5 items
    ({"papers": 300}, {"papers": 270}, []),              # a clean-up in a large library
    ({"papers": 2}, {"papers": 0}, ["papers"]),          # emptied: always asks
    ({"papers": 2, "notes": 8}, {"papers": 1, "notes": 1}, ["notes"]),
    (None, {"papers": 0}, []),                           # nothing to compare with
])
def test_what_counts_as_a_large_decrease(before, after, shrunk):
    assert sync.shrunk_kinds(before, after) == shrunk


def test_shrunk_library_is_neither_published_nor_taken_in_without_confirmation(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    stickies = add_stickies(a, identity, 10)
    run(a, remote)
    run(b, remote)
    for sticky in stickies[:6]:
        a.delete_bookmark(identity, sticky)
    count = len(remote.items)
    result = run(a, remote)
    assert result["status"] == "review"
    assert result["review"]["reason"] == "shrunk"
    assert (result["review"]["before"]["stickies"], result["review"]["after"]["stickies"]) == (10, 4)
    assert "付箋" in result["review"]["message"]
    assert "hash" not in result["review"]
    assert result["review"]["heads"] == [item["id"] for item in sync.revision_heads(remote.items)]
    # Automatic sync keeps stopping here until the user decides; nothing is published meanwhile.
    assert run(a, remote)["status"] == "review"
    assert len(remote.items) == count
    assert sync.status(a.root)["review"]["reason"] == "shrunk"
    assert run(a, remote, confirm=True)["status"] == "synced"
    assert len(remote.items) == count + 1
    assert sync.status(a.root)["review"] is None
    # The other PC asks before taking it in, and keeps its data until then.
    result = run(b, remote)
    assert (result["status"], result["review"]["reason"]) == ("review", "remote_shrunk")
    assert (result["review"]["before_label"], result["review"]["after_label"]) == ("このPC", "同期フォルダー")
    assert len(b.bookmarks(identity)) == 10
    assert run(b, remote, confirm=True)["reloaded"] is True
    assert len(Library(b.root).bookmarks(identity)) == 4
    # Settled: later syncs compare with the new counts.
    assert run(a, remote)["status"] == run(b, remote)["status"] == "synced"


def test_confirmation_applies_only_to_what_was_shown(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    stickies = add_stickies(a, identity, 10)
    run(a, remote)
    for sticky in stickies[:6]:
        a.delete_bookmark(identity, sticky)
    assert run(a, remote)["status"] == "review"
    a.delete_bookmark(identity, stickies[6])  # Changed after the review was shown: asked again.
    count = len(remote.items)
    result = run(a, remote, confirm=True)
    assert (result["status"], result["review"]["after"]["stickies"]) == ("review", 3)
    assert len(remote.items) == count
    # Without a pending review, confirm has nothing to apply to.
    sync.dismiss_review(a.root)
    assert run(a, remote, confirm=True)["status"] == "review"
    assert run(a, remote, confirm=True)["status"] == "synced"


def test_dismissing_a_review_stops_automatic_sync(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.delete_paper(identity)
    assert run(a, remote)["status"] == "review"
    state = sync.dismiss_review(a.root)
    assert (state["review"], state["auto_sync"]) == (None, False)
    # A later manual sync checks again.
    assert run(a, remote)["status"] == "review"


def test_restored_backup_is_published_only_after_confirmation(pair, tmp_path):
    from papeer.core.reading_tools import create_backup, restore_backup
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    create_backup(a, tmp_path / "old.zip")
    a.update(identity, note="newer")
    run(a, remote)
    run(b, remote)
    restore_backup(a, tmp_path / "old.zip")
    sync.mark_restored(a.root)
    assert sync.status(a.root)["restored"] is True
    count = len(remote.items)
    result = run(a, remote)
    assert (result["status"], result["review"]["reason"]) == ("review", "restored")
    assert len(remote.items) == count
    assert run(a, remote, confirm=True)["status"] == "synced"
    assert sync.status(a.root)["restored"] is False
    run(b, remote)
    assert Library(b.root).paper(identity)["note"] == ""


def test_restore_marks_the_library_for_review_only_once_it_was_synced(pair):
    a, b, _, remote = pair
    sync.mark_restored(b.root)
    assert sync.status(b.root)["restored"] is False  # Never synced: its first sync offers a choice anyway.
    connect_pair(a, b, remote)
    sync.mark_restored(b.root)
    assert sync.status(b.root)["restored"] is True


def test_restore_api_marks_the_library_for_review(pair, tmp_path, monkeypatch):
    import time
    from fastapi.testclient import TestClient
    from papeer.core.reading_tools import create_backup
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    a, b, _, remote = pair
    connect_pair(a, b, remote)
    create_backup(a, tmp_path / "backup.zip")
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())

    def restore(client):
        identity = client.post("/api/restore", json={"path": str(tmp_path / "backup.zip")}).json()["job_id"]
        deadline = time.monotonic() + 10
        while deps.job_manager.get_job(identity).running and time.monotonic() < deadline:
            time.sleep(0.01)
        return deps.job_manager.get_job(identity)

    with TestClient(app) as client:
        assert restore(client).status == "succeeded"
        assert sync.status(a.root)["restored"] is True

        # The restore has succeeded even when the mark cannot be saved.
        def broken(_root):
            raise OSError("device folder locked")
        monkeypatch.setattr(sync, "mark_restored", broken)
        assert restore(client).status == "succeeded"


def test_missing_data_folder_is_not_recreated_empty(pair):
    import shutil
    from papeer.core.storage import LibraryMissingError
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    shutil.rmtree(a.root)
    with pytest.raises(LibraryMissingError, match="見つかりません"):
        Library(a.root)
    assert not a.root.exists()
    assert sync.status(a.root)["library_missing"] is True
    with pytest.raises(ValueError, match="見つかっています"):
        sync.start_new_library(b.root)
    # Starting anew forgets the last sync, so the synced library is offered instead of being overwritten.
    state = sync.start_new_library(a.root)
    assert state["library_missing"] is False and sync.read_state(a.root)["connected"] is True
    result = run(Library(a.root), remote)
    assert result["status"] == "conflict"
    head = result["conflicts"][0]["id"]
    run(Library(a.root), remote, choice=head, expected_heads=[head])
    assert Library(a.root).paper(identity)


def test_missing_data_folder_without_folder_sync_starts_a_new_library(pair):
    import shutil
    a, b, _, remote = pair
    connect_pair(a, b, remote)
    sync.disconnect(a.root)
    shutil.rmtree(a.root)
    assert Library(a.root).papers() == []


def test_missing_data_folder_api(pair, monkeypatch):
    import shutil
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    a, b, _, remote = pair
    connect_pair(a, b, remote)
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    shutil.rmtree(a.root)
    with TestClient(app) as client:
        response = client.get("/api/papers")
        assert response.status_code == 409 and "見つかりません" in response.json()["detail"]
        assert client.get("/api/ui-state").status_code == 200
        assert client.put("/api/ui-state", json={"reading_pages": {}, "last_paper": "", "sort": 0,
                                                 "expanded_collections": []}).status_code == 409
        assert client.put("/api/settings", json={"reasoning_effort": "low"}).status_code == 409
        assert client.put("/api/prompts", json={}).status_code == 409
        assert not a.root.exists()
        assert client.get("/api/drive").json()["library_missing"] is True
        assert client.post("/api/drive/new-library").status_code == 200
        assert client.get("/api/papers").status_code == 200
        assert client.post("/api/drive/new-library").status_code == 400


def test_review_api(pair, monkeypatch):
    import time
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    state = sync.read_state(a.root)
    state["folder"] = str(a.root.parent / "shared")
    sync.save_state(a.root, state)
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    monkeypatch.setattr(sync, "FolderDrive", lambda _: remote)
    a.delete_paper(identity)

    def sync_job(client, body):
        identity_ = client.post("/api/drive/sync", json=body).json()["job_id"]
        deadline = time.monotonic() + 5
        while deps.job_manager.get_job(identity_).running and time.monotonic() < deadline:
            time.sleep(0.01)
        job = deps.job_manager.get_job(identity_)
        assert job.status == "succeeded", job.error
        return job.result

    with TestClient(app) as client:
        assert sync_job(client, {})["status"] == "review"
        assert client.get("/api/drive").json()["review"]["reason"] == "shrunk"
        assert client.delete("/api/drive/review").json()["auto_sync"] is False
        assert sync_job(client, {})["status"] == "review"
        assert sync_job(client, {"confirm": True})["status"] == "synced"
        assert client.get("/api/drive").json()["review"] is None


def test_pcs_updated_to_the_same_migration_do_not_conflict(pair, monkeypatch):
    """The second PC finds its migrated library already in the sync folder: no conflict, nothing published twice."""
    from papeer.core import reading_tools, storage
    a, b, identity, remote = pair
    connect_pair(a, b, remote)

    def title_index(db, _root):
        db.execute("CREATE INDEX papers_title ON papers(title)")  # Changes the logical contents (iterdump).

    version = len(storage.MIGRATIONS) + 1
    monkeypatch.setattr(storage, "MIGRATIONS", [*storage.MIGRATIONS, title_index])
    for module in (storage, sync, reading_tools):
        monkeypatch.setattr(module, "SCHEMA_VERSION", version)
    a, b = Library(a.root), Library(b.root)
    assert sync.fingerprint(a) == sync.fingerprint(b) != sync.read_state(a.root)["hash"]
    count = len(remote.items)
    assert run(a, remote)["status"] == "synced"
    assert len(remote.items) == count + 1
    result = run(b, remote)
    assert (result["status"], result["reloaded"]) == ("synced", False)
    assert len(remote.items) == count + 1
    assert sync.read_state(b.root)["base"] == remote.items[-1]["id"]
    # Later edits flow as usual.
    b.update(identity, note="after the update")
    run(b, remote)
    assert run(a, remote)["reloaded"] is True


# Backing out of a review without losing anything: the usual choice of a whole library, with the review's heads.

def test_shrunk_library_can_take_the_sync_folders_back(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    stickies = add_stickies(a, identity, 10)
    run(a, remote)
    run(b, remote)
    for sticky in stickies[:6]:
        a.delete_bookmark(identity, sticky)
    review = run(a, remote)["review"]
    # The head is the common ancestor here, and can still be taken.
    assert review["heads"] == [sync.read_state(a.root)["base"]]
    result = run(a, remote, choice=review["heads"][0], expected_heads=review["heads"])
    assert result["reloaded"] is True
    assert len(Library(a.root).bookmarks(identity)) == 10
    assert sync.status(a.root)["review"] is None
    assert run(Library(a.root), remote)["status"] == "synced"
    # The other PC already holds the same contents: nothing to take in.
    result = run(b, remote)
    assert (result["status"], result["reloaded"]) == ("synced", False)


def test_restored_backup_can_be_dropped_for_the_sync_folders(pair, tmp_path):
    from papeer.core.reading_tools import create_backup, restore_backup
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    create_backup(a, tmp_path / "old.zip")
    a.update(identity, note="newer")
    run(a, remote)
    restore_backup(a, tmp_path / "old.zip")
    sync.mark_restored(a.root)
    review = run(a, remote)["review"]
    assert review["reason"] == "restored"
    assert run(a, remote, choice=review["heads"][0], expected_heads=review["heads"])["reloaded"] is True
    assert Library(a.root).paper(identity)["note"] == "newer"
    assert sync.status(a.root)["restored"] is False


def test_shrunk_sync_folder_can_be_replaced_with_this_pcs_library(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    stickies = add_stickies(a, identity, 10)
    run(a, remote)
    run(b, remote)
    for sticky in stickies[:6]:
        a.delete_bookmark(identity, sticky)
    run(a, remote)
    run(a, remote, confirm=True)
    review = run(b, remote)["review"]
    assert review["reason"] == "remote_shrunk"
    result = run(b, remote, choice="local", expected_heads=review["heads"])
    assert (result["status"], result["reloaded"]) == ("synced", False)
    assert len(b.bookmarks(identity)) == 10
    # The first PC gets its stickies back on its next sync (an increase, so no question).
    assert run(a, remote)["reloaded"] is True
    assert len(Library(a.root).bookmarks(identity)) == 10


def test_same_contents_from_a_newer_papeer_are_not_taken_as_synced(pair):
    a, _, _, remote = pair
    run(a, remote)
    remote.items[0].update(schema_version=SCHEMA_VERSION + 1, app_version="9.9.9")
    # Holds the revision's contents, but has not synced it (no common ancestor).
    sync.save_state(a.root, {"connected": True, "hash": sync.fingerprint(a)})
    with pytest.raises(NewerSchemaError):
        run(a, remote)
    assert "base" not in sync.read_state(a.root)
