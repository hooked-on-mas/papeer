from contextlib import contextmanager
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import threading

import pytest

from _legacy_library import legacy_backup, legacy_library
from papeer import __version__
from papeer.core import drive_sync as sync
from papeer.core import local_history
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

    @contextmanager
    def open_library(self, identity):
        yield io.BytesIO(self.data[identity])


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


def recorded_state(lib, entry_id):
    """A state in this PC's history, written out as a library of its own (beside the library's folder)."""
    target = lib.root.parent / ("state-" + entry_id)
    local_history.materialize(lib.root, entry_id, target)
    return Library(target)


def set_aside_entries(lib):
    return [entry for entry in local_history.entries(lib.root) if entry["kind"] == "set_aside"]


def moved_aside(lib):
    return sorted(path.name for path in lib.root.parent.iterdir() if path.name.startswith(lib.root.name + "-before-restore-"))


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
    before = moved_aside(b)
    result = run(b, remote)
    assert result["reloaded"]
    assert b.paper(identity)["note"] == "new note"
    # The library as it was is in this PC's history (the state last synced), so no folder is moved aside.
    assert result["previous_path"] is None and moved_aside(b) == before
    pulled, previous = local_history.entries(b.root)[:2]
    assert (pulled["kind"], pulled["hash"]) == ("pull", sync.fingerprint(b))
    assert recorded_state(b, previous["id"]).paper(identity)["note"] == ""
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
    assert result["previous_path"] is None
    [kept] = result["set_aside"]
    assert recorded_state(b, kept).paper(identity)["note"] == "B"
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
    # The choice is already published, so the library it left out stays kept.
    assert [item["side"] for item in set_aside_entries(b)] == ["local"]
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
    result = run(b, remote)
    assert result["status"] == "conflict"
    # Its older database (fewer tables and columns) is compared all the same.
    assert result["conflicts"][0]["diff"]["remote_only"] == 1
    # Validated against the database as the old PC hashed it, not as this version migrates it.
    assert run(b, remote, choice=revision, expected_heads=[revision])["reloaded"] is True
    lib = Library(b.root)
    assert database_version(b.root / "library.sqlite3") == SCHEMA_VERSION
    assert (lib.paper(identity)["tags"], lib.paper(identity)["bibliography_version"]) == (["古いタグ"], 1)
    # The old PC stored the label of the translation state; opened here, it is a code.
    assert lib.paper(identity)["status"] == "partial"
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
        return job.result.model_dump()

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


def test_pcs_updated_to_status_codes_do_not_conflict(tmp_path, monkeypatch):
    """The real conversion of stored labels (storage._status_codes): both PCs convert the synced library
    the same way, so the second one to sync after updating finds it already published."""
    from papeer.core import reading_tools, storage
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "device-state"))
    migrations = storage.MIGRATIONS

    def schema(steps):
        monkeypatch.setattr(storage, "MIGRATIONS", steps)
        for module in (storage, sync, reading_tools):
            monkeypatch.setattr(module, "SCHEMA_VERSION", len(steps))

    schema(migrations[:migrations.index(storage._status_codes)])
    a, b = Library(tmp_path / "a"), Library(tmp_path / "b")
    for lib in (a, b):
        sync.save_state(lib.root, {"connected": True})
    identity, _ = a.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    with a.connection() as db:
        db.execute("UPDATE papers SET status='翻訳途中・再開可' WHERE id=?", (identity,))
    remote = MemoryDrive()
    connect_pair(a, b, remote)
    schema(migrations)
    a, b = Library(a.root), Library(b.root)
    assert a.paper(identity)["status"] == b.paper(identity)["status"] == "resumable"
    assert sync.fingerprint(a) == sync.fingerprint(b) != sync.read_state(a.root)["hash"]
    count = len(remote.items)
    assert run(a, remote)["status"] == "synced"
    assert len(remote.items) == count + 1
    result = run(b, remote)
    assert (result["status"], result["reloaded"]) == ("synced", False)
    assert len(remote.items) == count + 1


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


# --- Automatic sync: the cheap check, and the background sync that never replaces the library ---

@pytest.fixture
def settled(monkeypatch):
    """Files written just now are recorded at once (see test_sync_load)."""
    monkeypatch.setattr(sync, "RACY_NS", -3600 * 10**9)


def test_check_tells_what_an_automatic_sync_would_do(pair, settled):
    a, b, identity, remote = pair
    assert sync.check(a.root, remote)["action"] == "quiet"  # never published
    connect_pair(a, b, remote)
    assert sync.check(a.root, remote) == {"action": "none", "local_version": sync.fingerprint(a)}
    # The second PC took in the first's library after hashing its own: the records are of the old files,
    # so the check leaves it to a sync (in the background, and it finds nothing to publish).
    assert sync.check(b.root, remote)["action"] == "quiet"
    count = len(remote.items)
    run(b, remote, background=True)
    assert len(remote.items) == count
    assert sync.check(b.root, remote)["action"] == "none"
    a.save_note_template("custom", "template")
    # A change to the database alone is hashed from the records.
    assert sync.check(a.root, remote) == {"action": "quiet", "local_version": sync.fingerprint(a)}
    a.update(identity, note="A")  # note.md changes too: the check leaves the hashing to the sync
    assert sync.check(a.root, remote)["action"] == "quiet"
    run(a, remote)
    assert sync.check(a.root, remote)["action"] == "none"
    assert sync.check(b.root, remote)["action"] == "pull"
    b.update(identity, note="B")
    assert sync.check(b.root, remote)["action"] == "quiet"  # a conflict: recorded without touching the library


def test_the_first_check_after_launch_trusts_no_record(pair, settled):
    """A change that kept every file's size, time and ID waits at most until the next launch."""
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    assert sync.check(a.root, remote)["action"] == "none"
    sync._VERIFIED.clear()  # as after a restart of the sidecar
    assert sync.check(a.root, remote) == {"action": "quiet", "local_version": None}
    run(a, remote, background=True)  # hashes every file, and nothing changed: nothing is published
    assert sync.check(a.root, remote)["action"] == "none"


def test_background_sync_publishes_but_leaves_taking_in_to_a_later_sync(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    assert run(a, remote, background=True)["status"] == "synced"
    state = sync.read_state(b.root)
    count = len(remote.items)
    assert run(b, remote, background=True) == {"status": "deferred", "reloaded": False, "previous_path": None}
    assert b.paper(identity)["note"] == "" and sync.read_state(b.root) == state and len(remote.items) == count
    assert run(b, remote)["reloaded"] is True
    assert Library(b.root).paper(identity)["note"] == "A"


def test_a_wrong_recorded_hash_never_reaches_the_sync_folder(pair, settled):
    """The records only decide whether to sync; what is published is hashed from the files."""
    from papeer.core.paths import fingerprint_cache_path
    a, b, identity, remote = pair
    (a.root / "prompts").mkdir()
    (a.root / "prompts" / "chat.txt").write_text("prompt", "utf-8")
    connect_pair(a, b, remote)
    sync.check(a.root, remote)  # settles the record after the last sync
    assert sync.check(a.root, remote)["action"] == "none"
    path = fingerprint_cache_path(a.root)
    value = json.loads(path.read_text("utf-8"))
    count = len(remote.items)

    # A damaged record that claims a change: the sync finds none, publishes nothing, and mends the record.
    path.write_text(json.dumps({**value, "hash": "0" * 64}), "utf-8")
    assert sync.check(a.root, remote)["action"] == "quiet"
    run(a, remote, background=True)
    assert len(remote.items) == count and sync.read_state(a.root)["hash"] == sync.fingerprint(a)
    sync.check(a.root, remote)
    assert sync.check(a.root, remote)["action"] == "none"

    # A stale record that hides a change (rewritten in place, size and time kept) only delays the automatic
    # sync: a sync still publishes it.
    prompt = a.root / "prompts" / "chat.txt"
    before = prompt.stat()
    prompt.write_text("PROMPT", "utf-8")
    os.utime(prompt, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert sync.check(a.root, remote)["action"] == "none"
    run(a, remote)
    assert len(remote.items) == count + 1
    assert remote.items[-1]["hash"] == sync.fingerprint(a) == sync.read_state(a.root)["hash"]
    assert run(b, remote)["reloaded"] is True
    assert (b.root / "prompts" / "chat.txt").read_text("utf-8") == "PROMPT"


def test_check_api_and_background_flag(pair, monkeypatch, settled):
    import time
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    run(b, remote)  # records the files it took in
    for lib in (a, b):
        state = sync.read_state(lib.root)
        sync.save_state(lib.root, {**state, "folder": str(lib.root.parent / "shared")})
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    monkeypatch.setattr(sync, "FolderDrive", lambda _: remote)
    a.update(identity, note="A")
    run(a, remote)
    monkeypatch.setattr(deps, "get_data_dir", lambda: b.root)
    with TestClient(app) as client:
        assert client.get("/api/drive/check").json()["action"] == "pull"
        job_id = client.post("/api/drive/sync", json={"background": True}).json()["job_id"]
        deadline = time.monotonic() + 5
        while deps.job_manager.get_job(job_id).running and time.monotonic() < deadline:
            time.sleep(0.01)
        assert deps.job_manager.get_job(job_id).result.status == "deferred"
        assert b.paper(identity)["note"] == ""

        def unreachable(_):
            raise ValueError("同期フォルダーが見つかりません。")
        monkeypatch.setattr(sync, "FolderDrive", unreachable)
        # The sync reports the problem; the check only says a sync has something to tell.
        assert client.get("/api/drive/check").json() == {"action": "quiet", "local_version": None}
        sync.disconnect(b.root)
        assert client.get("/api/drive/check").json()["action"] == "none"


def test_a_newer_revision_at_launch_is_taken_in_by_the_first_sync(pair, settled):
    """Until the library is hashed once the check cannot tell a take-in from a publication, so the first
    automatic sync after launch runs with the waiting screen (not in the background) and takes it in."""
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    run(b, remote)
    a.update(identity, note="A")
    run(a, remote)
    sync._VERIFIED.clear()  # as after a restart of the sidecar
    assert sync.check(b.root, remote) == {"action": "quiet", "local_version": None}
    # A background sync could only defer it (see autoSyncSchedule.ts: the take-in then runs at once).
    assert run(b, remote, background=True)["status"] == "deferred"
    assert run(b, remote)["reloaded"] is True
    assert Library(b.root).paper(identity)["note"] == "A"


# --- Choosing between two libraries: what differs, and the side left out ---

def another_pdf(tmp_path):
    """The sample PDF with a trailing comment: a different file, so a second paper."""
    path = tmp_path / "another.pdf"
    path.write_bytes((Path(__file__).parent / "fixtures/sample.pdf").read_bytes() + b"\n% another paper\n")
    return path


def test_conflict_shows_what_differs_from_each_head(pair, tmp_path):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    other, _ = a.import_pdf(another_pdf(tmp_path))
    a.update(identity, note="A")
    add_stickies(a, identity, 2)
    a.save_ink(identity, "original", 1, [{"id": "stroke"}])
    b.update(identity, note="B")
    b.save_ink(identity, "original", 2, [])  # An emptied page holds no ink.
    run(a, remote)
    result = run(b, remote)
    assert result["status"] == "conflict"
    diff = result["conflicts"][0]["diff"]
    assert (diff["local_only"], diff["remote_only"]) == (0, 1)
    assert (diff["local_titles"], diff["remote_titles"]) == ([], [a.paper(other)["title"]])
    # Counted among the papers both sides have; the other paper's contents are not counted again.
    assert (diff["notes"], diff["stickies"], diff["ink"]) == (1, 2, 1)
    assert (diff["local_counts"]["papers"], diff["remote_counts"]["papers"]) == (1, 2)
    assert sync.status(b.root)["conflicts"][0]["diff"] == diff


def test_what_differs_leaves_out_what_an_older_database_lacks(pair, tmp_path):
    import sqlite3
    a, _, identity, _ = pair
    a.update(identity, note="A")
    a.save_ink(identity, "original", 1, [{"id": "stroke"}])
    older = tmp_path / "older.sqlite3"
    with sqlite3.connect(older) as db:
        db.execute("CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT, note TEXT)")
        db.execute("CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, paper_id TEXT, quote TEXT)")
        db.execute("INSERT INTO papers VALUES (?, 'T', 'A')", (identity,))
        db.execute("INSERT INTO bookmarks VALUES (1, ?, 'quote 0')", (identity,))
    a.add_bookmark(identity, 1, "original", "quote 0")
    diff = sync.library_difference(a.root / "library.sqlite3", older)
    # The sticky note matches on the columns both have; the ink has no table to match on the other side.
    assert (diff["notes"], diff["stickies"], diff["ink"]) == (0, 0, 1)
    assert diff["remote_counts"] == {"papers": 1, "notes": 1, "stickies": 1, "ink": 0}


def test_conflict_is_offered_even_when_what_differs_cannot_be_read(pair, monkeypatch):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    run(a, remote)

    @contextmanager
    def unreadable(_identity):
        raise OSError("still arriving")
        yield

    monkeypatch.setattr(remote, "open_library", unreadable)
    result = run(b, remote)
    assert result["status"] == "conflict" and result["conflicts"][0]["diff"] is None


def test_choice_keeps_the_side_left_out_in_this_pcs_history(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    assert run(b, remote)["status"] == "conflict"
    head = sync.revision_heads(remote.items)[0]
    result = run(b, remote, choice="local", expected_heads=[head["id"]])
    kept = set_aside_entries(b)
    assert [item["id"] for item in kept] == result["set_aside"]
    assert (kept[0]["side"], kept[0]["source_device"], kept[0]["source_created"]) == ("remote", head["device"], head["created"])
    assert (kept[0]["counts"], kept[0]["hash"], kept[0]["revision"]) == (head["counts"], head["hash"], head["id"])
    assert kept[0]["complete"]
    # Recorded from the revision's archive: the same library, file for file.
    assert recorded_state(b, kept[0]["id"]).paper(identity)["note"] == "A"
    assert sync.fingerprint(b.root.parent / ("state-" + kept[0]["id"])) == head["hash"]
    # No ZIP beside the library any more.
    assert sync.side_backups(b.root) == [] and not sync.side_backup_folder(b.root).exists()

    # Taking the sync folder's library keeps this PC's.
    b.update(identity, note="B2")
    run(b, remote)
    a.update(identity, note="A2")
    assert run(a, remote)["status"] == "conflict"
    head = sync.revision_heads(remote.items)[0]
    result = run(a, remote, choice=head["id"], expected_heads=[head["id"]])
    assert Library(a.root).paper(identity)["note"] == "B2"
    local = set_aside_entries(a)[0]
    assert (local["side"], local["counts"]["papers"]) == ("local", 1)
    assert recorded_state(a, local["id"]).paper(identity)["note"] == "A2"
    # This PC's library is in the history, so the folder the swap moved aside is gone.
    assert result["previous_path"] is None and moved_aside(a) == []


def test_nothing_is_set_aside_that_holds_nothing_to_go_back_to(pair):
    a, b, _, remote = pair
    run(a, remote)
    # b holds no paper: taking the sync folder's library leaves nothing of b's behind.
    assert run(b, remote)["status"] == "conflict"
    assert run(b, remote, choice="1", expected_heads=["1"])["set_aside"] == []
    assert set_aside_entries(b) == []


def test_zips_earlier_versions_set_aside_stay_listed(tmp_path):
    root = tmp_path / "library"
    folder = sync.side_backup_folder(root)
    folder.mkdir()
    names = [f"2026010{n}-000000-abcdef-local" for n in range(sync.SIDE_BACKUP_LIMIT + 2)]
    for name in names:
        (folder / (name + ".zip")).write_bytes(b"zip")
        (folder / (name + ".json")).write_text(json.dumps({"side": "local", "device": "PC"}))
    kept = sync.side_backups(root)
    # None is removed by a sync any more: only the user does (local_history.remove_legacy).
    assert [item["name"] for item in kept] == [name + ".zip" for name in reversed(names)]
    assert (kept[0]["side"], kept[0]["device"]) == ("local", "PC")
    # A missing or unreadable description leaves only what the file itself tells.
    (folder / (names[-1] + ".json")).write_text("not json")
    assert sync.side_backups(root)[0] == {
        "path": str(folder / (names[-1] + ".zip")), "name": names[-1] + ".zip", "size": 3,
        "device": None, "created": None, "saved": None, "side": None, "counts": None}


def test_side_backups_api_and_restore(pair, monkeypatch):
    import time
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    from papeer.core.backup import create_backup

    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    # A ZIP an earlier version set aside.
    folder = sync.side_backup_folder(b.root)
    folder.mkdir()
    create_backup(a, folder / "20260101-000000-abcdef-remote.zip")
    (folder / "20260101-000000-abcdef-remote.json").write_text(json.dumps({"side": "remote", "device": "PC-A"}))
    monkeypatch.setattr(deps, "get_data_dir", lambda: b.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    with TestClient(app) as client:
        response = client.get("/api/drive/side-backups").json()
        assert response["limit"] == sync.SIDE_BACKUP_LIMIT == local_history.SPECIAL_LIMIT
        kept = response["items"]
        assert [item["side"] for item in kept] == ["remote"]
        # The usual restore: settings kept unless asked, the schema checked, and the next sync asks first.
        job_id = client.post("/api/restore", json={"path": kept[0]["path"], "import_settings": False}).json()["job_id"]
        deadline = time.monotonic() + 10
        while deps.job_manager.get_job(job_id).running and time.monotonic() < deadline:
            time.sleep(0.01)
        assert deps.job_manager.get_job(job_id).status == "succeeded"
    assert Library(b.root).paper(identity)["note"] == "A"
    assert sync.status(b.root)["restored"] is True


def test_a_choice_stopped_before_publishing_keeps_nothing_set_aside(pair, monkeypatch):
    from papeer.providers import Cancelled
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    assert run(b, remote)["status"] == "conflict"
    head = sync.revision_heads(remote.items)[0]["id"]

    def cancelled(*_args):
        raise Cancelled("stopped")

    monkeypatch.setattr(remote, "upload", cancelled)
    with pytest.raises(Cancelled):
        run(b, remote, choice=head, expected_heads=[head])
    # Offered again, and set aside anew then.
    assert set_aside_entries(b) == []
    assert b.paper(identity)["note"] == "B"


def test_this_pcs_library_can_be_chosen_over_a_damaged_revision(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    assert run(b, remote)["status"] == "conflict"
    head = sync.revision_heads(remote.items)[0]
    remote.data[head["id"]] = b"damaged"
    result = run(b, remote, choice="local", expected_heads=[head["id"]])
    assert result["status"] == "synced" and result["set_aside"] == []
    expected = [{k: head[k] for k in ("id", "device", "created")}]
    assert result["not_set_aside"] == expected
    assert sync.status(b.root)["not_set_aside"] == expected
    assert set_aside_entries(b) == []
    assert Library(b.root).paper(identity)["note"] == "B"
    assert sync.revision_heads(remote.items)[0]["parents"] == [head["id"]]
    # Cleared by the next sync.
    run(b, remote)
    assert sync.status(b.root)["not_set_aside"] == []


def test_a_full_drive_stops_setting_aside(pair, monkeypatch):
    from papeer.core.fileio import InsufficientSpaceError
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    run(b, remote)
    head = sync.revision_heads(remote.items)[0]["id"]

    def full(*_args):
        raise InsufficientSpaceError("空き容量が不足しています。")

    monkeypatch.setattr(local_history, "ensure_free_space", full)
    count = len(remote.items)
    with pytest.raises(InsufficientSpaceError):
        run(b, remote, choice="local", expected_heads=[head])
    assert len(remote.items) == count
    assert set_aside_entries(b) == []


def conflicted_pair(pair):
    """b chose nothing yet between its note B and a's revision with note A."""
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    run(a, remote)
    b.update(identity, note="B")
    assert run(b, remote)["status"] == "conflict"
    return b, identity, remote, sync.revision_heads(remote.items)[0]


def test_failing_to_write_a_backup_on_this_pc_stops_the_choice(pair, monkeypatch, tmp_path):
    b, identity, remote, head = conflicted_pair(pair)
    # Not a damaged revision: the history cannot be written here (a missing or locked folder, say).
    blocked = tmp_path / "blocked"
    blocked.write_text("a file where the folder should be")
    monkeypatch.setattr(local_history, "history_directory", lambda _root: blocked / "history")
    count = len(remote.items)
    with pytest.raises(OSError):
        run(b, remote, choice="local", expected_heads=[head["id"]])
    assert len(remote.items) == count
    assert sync.status(b.root)["conflicts"]


def test_a_revision_cut_short_while_read_is_skipped(pair, monkeypatch):
    b, identity, remote, head = conflicted_pair(pair)

    class Truncated(io.BytesIO):
        def read(self, *_args):
            raise EOFError("compressed file ended before the end-of-stream marker was reached")

    @contextmanager
    def truncated(identity_):
        yield Truncated(remote.data[identity_])

    monkeypatch.setattr(remote, "open_library", truncated)
    result = run(b, remote, choice="local", expected_heads=[head["id"]])
    assert result["status"] == "synced" and [item["id"] for item in result["not_set_aside"]] == [head["id"]]
