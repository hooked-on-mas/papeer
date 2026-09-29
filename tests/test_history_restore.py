"""Going back to a state of this PC's history, or to a backup ZIP (papeer/core/history_restore.py)."""
import hashlib
import json
from pathlib import Path
import threading
import time
import zlib

import pytest

from papeer.core import drive_sync as sync
from papeer.core import history_restore
from papeer.core import local_history as history
from papeer.core.backup import create_backup
from papeer.core.paths import device_directory, history_directory
from papeer.core.storage import Library
from papeer.providers import Cancelled

from test_local_history import SAMPLE, record


@pytest.fixture
def lib(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE)
    lib.update(identity, note="first")
    (lib.folder(identity) / "article.md").write_text("サマリー", "utf-8")
    (lib.root / "settings.json").write_text(json.dumps({"model": "first-model"}))
    lib.identity = identity
    return lib


def moved_aside(lib):
    return sorted(path.name for path in lib.root.parent.iterdir()
                  if path.name.startswith(lib.root.name + "-before-restore-") or path.name.startswith(lib.root.name + "-restore-"))


def run_restore(lib, entry_id, **kwargs):
    told = []
    result = history_restore.restore_entry(lib, entry_id, threading.Event(), told.append,
                                           import_settings=kwargs.pop("import_settings", False))
    return result, told


def test_going_back_to_a_state_keeps_the_current_one_in_the_history(lib):
    first = record(lib)
    lib.update(lib.identity, note="second")
    (lib.root / "settings.json").write_text(json.dumps({"model": "second-model"}))
    current_hash = sync.fingerprint(lib)
    result, told = run_restore(lib, first)
    restored = Library(lib.root)
    assert restored.paper(lib.identity)["note"] == "first"
    # Settings stay as they are unless asked for, as in a backup restore.
    assert json.loads((lib.root / "settings.json").read_text())["model"] == "second-model"
    # The library as it was is a state of its own, and no folder stays beside the library.
    assert result["previous_path"] is None and moved_aside(lib) == []
    before = next(entry for entry in history.entries(lib.root) if entry["id"] == result["before_restore"])
    assert (before["kind"], before["hash"], before["group"]) == ("before_restore", current_hash, "special")
    assert any("履歴から組み立てています" in line for line in told)
    # And the restore can be undone from there.
    run_restore(lib, before["id"])
    assert Library(lib.root).paper(lib.identity)["note"] == "second"


def test_settings_come_back_when_asked(lib):
    first = record(lib)
    (lib.root / "settings.json").write_text(json.dumps({"model": "second-model"}))
    run_restore(lib, first, import_settings=True)
    assert json.loads((lib.root / "settings.json").read_text())["model"] == "first-model"


def test_a_state_with_a_missing_or_damaged_blob_is_not_restored(lib):
    first = record(lib)
    lib.update(lib.identity, note="second")
    pdf = hashlib.sha256((lib.folder(lib.identity) / "original.pdf").read_bytes()).hexdigest()
    blobs = history_directory(lib.root) / "blobs"
    (blobs / pdf).rename(blobs.parent / "kept-aside")
    with pytest.raises(ValueError, match="戻せません"):
        run_restore(lib, first)
    (blobs.parent / "kept-aside").rename(blobs / pdf)
    article = hashlib.sha256("サマリー".encode()).hexdigest() + ".z"
    (blobs / article).write_bytes(zlib.compress(b"damaged"))
    with pytest.raises(ValueError, match="破損"):
        run_restore(lib, first)
    # Nothing changed: the library, the folders beside it, and the history (but the damaged blob, moved aside).
    assert Library(lib.root).paper(lib.identity)["note"] == "second"
    assert moved_aside(lib) == []
    assert [entry["kind"] for entry in history.entries(lib.root)] == ["publish"]
    assert (history_directory(lib.root) / "damaged" / article).exists()
    with pytest.raises(ValueError, match="見つかりません"):
        run_restore(lib, "0" * 32)


def test_a_restore_stopped_before_the_swap_changes_nothing(lib, monkeypatch):
    first = record(lib)
    lib.update(lib.identity, note="second")
    cancel = threading.Event()
    materialize = history.materialize

    def stop_after(*args, **kwargs):
        result = materialize(*args, **kwargs)
        cancel.set()
        return result

    monkeypatch.setattr(history, "materialize", stop_after)
    with pytest.raises(Cancelled):
        history_restore.restore_entry(lib, first, cancel, lambda _: None, import_settings=False)
    assert Library(lib.root).paper(lib.identity)["note"] == "second"
    assert moved_aside(lib) == [] and [entry["kind"] for entry in history.entries(lib.root)] == ["publish"]


def test_a_zip_restore_records_the_library_and_leaves_no_folder(lib, tmp_path):
    backup = tmp_path / "backup.zip"
    create_backup(lib, backup)
    lib.update(lib.identity, note="after the backup")
    result = history_restore.restore_zip(lib, backup, threading.Event(), lambda _: None, import_settings=False)
    assert Library(lib.root).paper(lib.identity)["note"] == "first"
    assert result["previous_path"] is None and moved_aside(lib) == []
    [before] = history.entries(lib.root)
    assert before["kind"] == "before_restore"
    target = tmp_path / "before"
    history.materialize(lib.root, before["id"], target)
    assert Library(target).paper(lib.identity)["note"] == "after the backup"
    # A backup that is not one: the library and the history stay as they were.
    invalid = tmp_path / "invalid.zip"
    invalid.write_bytes(b"not a zip")
    with pytest.raises(Exception):
        history_restore.restore_zip(lib, invalid, threading.Event(), lambda _: None, import_settings=False)
    assert [entry["id"] for entry in history.entries(lib.root)] == [before["id"]]
    assert Library(lib.root).paper(lib.identity)["note"] == "first"


def test_when_the_library_cannot_be_recorded_it_stays_beside_it(lib, tmp_path, monkeypatch):
    backup = tmp_path / "backup.zip"
    create_backup(lib, backup)
    lib.update(lib.identity, note="after the backup")

    def full(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(history, "record_folder", full)
    result = history_restore.restore_zip(lib, backup, threading.Event(), lambda _: None, import_settings=False)
    assert result["previous_path"] and result["before_restore"] is None
    assert Library(Path(result["previous_path"])).paper(lib.identity)["note"] == "after the backup"


def test_what_differs_from_a_state(lib):
    first = record(lib)
    lib.update(lib.identity, note="second")
    difference = history_restore.difference(lib, first)
    assert difference["notes"] == 1 and difference["local_only"] == difference["remote_only"] == 0


def test_histories_left_by_a_library_that_moved_are_listed_and_removed(lib, tmp_path, monkeypatch):
    monkeypatch.setattr(history, "LOCK_WAIT", 0.3)
    record(lib)
    old_key = history_directory(lib.root).name
    moved = Library(tmp_path / "moved")
    [other] = history.other_histories(moved.root)
    assert (other["key"], other["library"], other["library_exists"], other["entries"]) == (
        old_key, str(lib.root.resolve()), True, 1)
    assert other["size"] > 0 and other["modified"]
    assert history.other_histories(lib.root) == []  # Its own history is never listed.
    # One made before the library was noted: listed without it.
    unknown = device_directory() / "history" / ("f" * 64)
    (unknown / "entries").mkdir(parents=True)
    listed = {item["key"]: item for item in history.other_histories(moved.root)}
    assert listed["f" * 64]["library"] is None and listed["f" * 64]["library_exists"] is False
    # Only the keys listed are removed; one held by another Papeer stays.
    held = history._acquire_file_lock(unknown / ".lock")
    try:
        result = history.remove_other_histories(moved.root, [old_key, "f" * 64, "0" * 64, "../x",
                                                             history_directory(moved.root).name])
    finally:
        history._unlock_file(held)
    assert result["removed"] == [old_key] and result["failed"] == ["f" * 64]
    assert not history_directory(lib.root).exists() and unknown.exists()


def wait(job_id):
    from sidecar import deps
    deadline = time.monotonic() + 30
    while deps.job_manager.get_job(job_id).running and time.monotonic() < deadline:
        time.sleep(0.02)
    return deps.job_manager.get_job(job_id)


def test_history_restore_api(lib, monkeypatch):
    from fastapi.testclient import TestClient
    from sidecar import deps
    from sidecar.app import app
    from sidecar.jobs import JobManager

    first = record(lib)
    sync.save_state(lib.root, {"connected": True, "base": "1", "hash": "h"})
    lib.update(lib.identity, note="second")
    monkeypatch.setattr(deps, "get_data_dir", lambda: lib.root)
    monkeypatch.setattr(deps, "get_library", lambda: Library(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    with TestClient(app) as client:
        overview = client.get("/api/history").json()
        assert [(item["id"], item["group"]) for item in overview["entries"]] == [(first, "recent")]
        assert overview["usage"]["unreadable"] == 0
        assert client.get(f"/api/history/{first}/difference").json()["notes"] == 1
        assert client.get(f"/api/history/{'0' * 32}/difference").status_code == 400
        job = wait(client.post("/api/history/restore", json={"entry_id": first}).json()["job_id"])
        assert job.status == "succeeded", job.error
        assert job.result.previous_path is None
        failed = wait(client.post("/api/history/restore", json={"entry_id": "0" * 32}).json()["job_id"])
        assert failed.status == "failed" and "履歴から戻せませんでした" in failed.error
        assert client.get("/api/history/others").json() == {"items": [], "size": 0}
        assert client.post("/api/history/others/remove", json={"keys": ["x"]}).json()["removed"] == []
    assert Library(lib.root).paper(lib.identity)["note"] == "first"
    # The state restored may be older than the sync folder's: the next sync asks first.
    assert sync.status(lib.root)["restored"] is True


def notes_in_history(lib):
    notes = {}
    for entry in history.entries(lib.root):
        target = lib.root.parent / f"state-{entry['id']}"
        if not target.exists():
            history.materialize(lib.root, entry["id"], target)
        notes[entry["id"]] = Library(target).paper(lib.identity)["note"]
    return notes


def test_trying_several_past_states_keeps_the_one_started_from(lib):
    """The library X was never synced; the user goes back to one past state after another, then syncs."""
    states = []
    for note in ("s1", "s2", "s3"):
        Library(lib.root).update(lib.identity, note=note)
        states.append(record(lib))
    Library(lib.root).update(lib.identity, note="X unsynced")
    first, _ = run_restore(lib, states[0])
    for entry_id in (states[1], states[2], states[0]):
        again, _ = run_restore(lib, entry_id)
        # The library gone back to is a state the history holds already: no new "before_restore".
        assert again["before_restore"] in states
    history.prune(lib.root)  # As the next sync does.
    kept = notes_in_history(lib)
    assert kept[first["before_restore"]] == "X unsynced"
    assert [entry["kind"] for entry in history.entries(lib.root)].count("before_restore") == 1


def test_a_before_restore_state_held_by_another_state_takes_no_place():
    def entry(seq, kind, library_hash):
        return {"id": f"{seq:032x}", "seq": seq, "kind": kind, "day": "2026-09-10", "hash": library_hash}
    found = [entry(1, "before_restore", "x"), entry(2, "publish", "a"), entry(3, "before_restore", "a"),
             entry(4, "before_restore", "b"), entry(5, "before_restore", "c"), entry(6, "before_restore", "a")]
    from datetime import date
    kept = history.retained(found, 5, 0, date(2026, 9, 10))
    # "a" is held by the published state: its before_restore copies take none of the 3 places, so "x" stays.
    assert kept == {entry(n, "", "")["id"] for n in (1, 2, 4, 5)}


def test_whatever_fails_after_the_swap_the_restore_succeeds_and_the_folder_stays(lib, monkeypatch):
    first = record(lib)
    lib.update(lib.identity, note="second")
    verified_state = history.verified_state
    calls = []

    def fails_after_the_swap(*args, **kwargs):
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("held by a virus scan")
        return verified_state(*args, **kwargs)

    monkeypatch.setattr(history, "verified_state", fails_after_the_swap)
    result, _ = run_restore(lib, first)
    assert Library(lib.root).paper(lib.identity)["note"] == "first"
    assert result["previous_path"] and Library(Path(result["previous_path"])).paper(lib.identity)["note"] == "second"


def test_a_recording_that_fails_leaves_no_blobs_behind(lib, tmp_path, monkeypatch):
    first = record(lib)
    lib.update(lib.identity, note="second")
    (lib.root / "new-file.txt").write_text("written by the failed recording")

    def full(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(history, "_write_entry", full)
    result, _ = run_restore(lib, first)
    assert result["previous_path"] and result["before_restore"] is None  # Kept beside it, as before.
    manifests = history._read_entries(history_directory(lib.root))[0]
    used = set().union(*(history._referenced(entry) for entry in manifests))
    assert {path.name for path in (history_directory(lib.root) / "blobs").iterdir()} == used


def test_without_folder_sync_a_restore_cleans_up_too(lib):
    first = record(lib)
    for n in range(5):
        Library(lib.root).update(lib.identity, note=f"unsynced {n}")
        run_restore(lib, first)
    kinds = [entry["kind"] for entry in history.entries(lib.root)]
    assert kinds.count("before_restore") == history.SPECIAL_LIMIT


def test_a_history_that_cannot_be_read_back_at_all_still_lets_the_restore_through(lib, monkeypatch):
    first = record(lib)
    lib.update(lib.identity, note="second")

    def broken(*_args, **_kwargs):
        raise RuntimeError("cannot read the history just now")

    monkeypatch.setattr(history, "verified_state", broken)
    result, _ = run_restore(lib, first)
    # Recorded anew before the swap; not read back after it, so the old library stays beside it too.
    assert Library(lib.root).paper(lib.identity)["note"] == "first"
    assert result["before_restore"] and result["previous_path"]
    assert Library(Path(result["previous_path"])).paper(lib.identity)["note"] == "second"
