"""This PC's history of the library (papeer/core/local_history.py): blobs, entries, what is kept, earlier leftovers."""
from datetime import date, datetime, timedelta
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import threading
import time
import zipfile
import zlib

import pytest

from papeer.core import drive_sync as sync
from papeer.core import local_history as history
from papeer.core.backup import create_backup
from papeer.core.paths import device_directory, history_directory
from papeer.core.storage import Library
from papeer.providers import Cancelled

SAMPLE = Path(__file__).parent / "fixtures/sample.pdf"


@pytest.fixture
def lib(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE)
    lib.update(identity, note="first")
    lib.save_ink(identity, "original", 1, [{"id": "stroke"}])
    (lib.folder(identity) / "article.md").write_text("サマリー", "utf-8")
    (lib.root / "ui-state.json").write_text('{"last_paper":"' + identity + '"}')
    lib.identity = identity
    return lib


def record(lib, kind="publish", **values):
    library_hash, files = sync.fingerprint_files(lib)
    return history.record_folder(lib.root, lib.root, kind=kind, library_hash=library_hash,
                                 counts=sync.library_counts(lib.root), files=files, **values)


def blobs(root) -> set[str]:
    folder = history_directory(root) / "blobs"
    return {path.name for path in folder.iterdir()} if folder.is_dir() else set()


def test_a_recorded_state_comes_back_whole(lib, tmp_path):
    entry_id = record(lib)
    [entry] = history.entries(lib.root)
    assert (entry["id"], entry["kind"], entry["complete"]) == (entry_id, "publish", True)
    assert entry["counts"] == sync.library_counts(lib.root) and entry["hash"] == sync.fingerprint(lib)
    target = tmp_path / "state"
    history.materialize(lib.root, entry_id, target)
    assert sync.fingerprint(target) == entry["hash"]
    # The window state travels with a snapshot as in a backup, though it is not part of the hash.
    assert (target / "ui-state.json").read_bytes() == (lib.root / "ui-state.json").read_bytes()
    assert Library(target).paper(lib.identity)["note"] == "first"
    # In this PC's device folder: neither synced nor backed up with the library.
    assert history_directory(lib.root).is_relative_to(device_directory())
    assert not history_directory(lib.root).is_relative_to(lib.root.resolve())


def test_each_content_is_stored_once_and_named_by_it(lib):
    record(lib)
    stored = blobs(lib.root)
    folder = history_directory(lib.root) / "blobs"
    pdf = (lib.folder(lib.identity) / "original.pdf").read_bytes()
    # PDFs are stored as they are; the rest compressed, both named by the SHA-256 of the content.
    assert (folder / hashlib.sha256(pdf).hexdigest()).read_bytes() == pdf
    article = "サマリー".encode()
    assert zlib.decompress((folder / (hashlib.sha256(article).hexdigest() + ".z")).read_bytes()) == article
    # Recording the same state again adds nothing.
    assert record(lib) is None
    assert blobs(lib.root) == stored and len(history.entries(lib.root)) == 1
    # A memo edited: only database chunks are new, no file is stored again.
    lib.update(lib.identity, note="second")
    record(lib)
    added = blobs(lib.root) - stored
    assert added and all(name.endswith(".z") for name in added)
    assert len(history.entries(lib.root)) == 2
    # No temporary file is left behind.
    assert not [name for name in blobs(lib.root) if name.startswith(".")]


def test_an_edit_changes_only_a_few_database_chunks(lib):
    with lib.connection() as db:
        db.execute("CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT)")
        db.executemany("INSERT INTO filler (body) VALUES (?)", [(os.urandom(500).hex(),) for _ in range(3000)])
    record(lib)
    [first] = history._read_entries(history_directory(lib.root))[0]
    lib.update(lib.identity, note="changed")
    record(lib)
    second = history._read_entries(history_directory(lib.root))[0][-1]
    chunks = second["db"]["chunks"]
    assert len(chunks) >= 10
    assert len(set(chunks) - set(first["db"]["chunks"])) <= 3


def test_a_file_that_changed_while_it_was_recorded_is_refused(lib):
    library_hash, files = sync.fingerprint_files(lib)
    rel = f"papers/{lib.identity}/article.md"
    files[rel] = ("0" * 64, files[rel][1])  # What was read no longer matches the file.
    with pytest.raises(ValueError, match="記録中に"):
        history.record_folder(lib.root, lib.root, kind="publish", library_hash=library_hash, counts={}, files=files)
    assert history.entries(lib.root) == []


def test_a_revision_archive_is_recorded_as_the_same_state(lib, tmp_path):
    record(lib)
    before = blobs(lib.root)
    archive = tmp_path / "revision.zip"
    create_backup(lib, archive)
    entry_id = history.record_archive(lib.root, io.BytesIO(archive.read_bytes()), kind="set_aside",
                                      library_hash=sync.fingerprint(lib), counts={"papers": 1}, schema_version=0,
                                      side="remote", source_device="other-pc")
    # Every file was stored already: at most database chunks are new.
    assert all(name.endswith(".z") for name in blobs(lib.root) - before)
    entry = history.entries(lib.root)[0]
    assert (entry["id"], entry["kind"], entry["side"], entry["source_device"]) == (entry_id, "set_aside", "remote", "other-pc")
    target = tmp_path / "state"
    history.materialize(lib.root, entry_id, target)
    assert sync.fingerprint(target) == sync.fingerprint(lib)
    assert not (target / "papeer-backup.json").exists()


def zip_bytes(members: dict[str, bytes], method=zipfile.ZIP_STORED) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", method) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return stream.getvalue()


@pytest.mark.parametrize("data", [
    b"damaged",
    zip_bytes({"library.sqlite3": b"db", "../outside.txt": b"x"}),
    zip_bytes({"library.sqlite3": b"db", "papers/CON.txt": b"x"}),
    zip_bytes({"papers/a/original.pdf": b"%PDF"}),  # No database.
])
def test_an_archive_that_cannot_be_read_or_holds_bad_paths_is_unreadable(lib, data):
    with pytest.raises(history.SourceUnreadable):
        history.record_archive(lib.root, io.BytesIO(data), kind="set_aside", library_hash="h", counts=None,
                               schema_version=0)
    assert history.entries(lib.root) == []


def test_an_archive_damaged_inside_is_unreadable_and_writing_failures_are_not(lib, monkeypatch):
    data = bytearray(zip_bytes({"library.sqlite3": b"database" * 100, "papers/a/note.md": b"note text" * 100}))
    position = data.index(b"note textnote text")
    data[position] ^= 0xFF  # The CRC no longer matches.
    with pytest.raises(history.SourceUnreadable):
        history.record_archive(lib.root, io.BytesIO(bytes(data)), kind="set_aside", library_hash="h", counts=None,
                               schema_version=0)

    def full(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(history._Blobs, "write", full)
    good = zip_bytes({"library.sqlite3": b"database", "papers/a/note.md": b"another"})
    with pytest.raises(OSError, match="disk full"):
        history.record_archive(lib.root, io.BytesIO(good), kind="set_aside", library_hash="h", counts=None,
                               schema_version=0)


def test_a_missing_blob_makes_a_state_incomplete_until_it_is_stored_again(lib, tmp_path):
    entry_id = record(lib)
    library_hash = sync.fingerprint(lib)
    pdf = hashlib.sha256((lib.folder(lib.identity) / "original.pdf").read_bytes()).hexdigest()
    (history_directory(lib.root) / "blobs" / pdf).unlink()
    assert history.entries(lib.root)[0]["complete"] is False
    assert history.verified_state(lib.root, library_hash) is None
    with pytest.raises(history.HistoryDataMissing):
        history.materialize(lib.root, entry_id, tmp_path / "state")
    # Recording the same state again does not rely on the incomplete one: it stores the file anew.
    new = record(lib)
    assert new is not None
    assert [entry["complete"] for entry in history.entries(lib.root)] == [True, True]
    assert history.verified_state(lib.root, library_hash) == new


def test_an_uncompressed_blob_of_another_size_counts_as_missing(lib):
    record(lib)
    pdf = hashlib.sha256((lib.folder(lib.identity) / "original.pdf").read_bytes()).hexdigest()
    (history_directory(lib.root) / "blobs" / pdf).write_bytes(b"cut short")
    assert history.entries(lib.root)[0]["complete"] is False
    # And it is written again by the next recording of the same file.
    lib.update(lib.identity, note="again")
    record(lib)
    assert [entry["complete"] for entry in history.entries(lib.root)] == [True, True]


def test_a_damaged_compressed_blob_is_found_by_reading_and_moved_aside(lib, tmp_path):
    entry_id = record(lib)
    library_hash = sync.fingerprint(lib)
    article = hashlib.sha256("サマリー".encode()).hexdigest() + ".z"
    blob = history_directory(lib.root) / "blobs" / article
    blob.write_bytes(zlib.compress("別の内容".encode()))
    # The name is there, so it looks complete without reading it.
    assert history.entries(lib.root)[0]["complete"] is True
    assert history.verified_state(lib.root, library_hash) is None
    assert not blob.exists() and (history_directory(lib.root) / "damaged" / article).exists()
    assert history.entries(lib.root)[0]["complete"] is False
    assert history.verify_entry(lib.root, entry_id) is False
    # The next recording of the same content stores it anew, and the state can be written out again.
    lib.update(lib.identity, note="again")
    record(lib)
    assert history.verify_entry(lib.root, entry_id) is True
    history.materialize(lib.root, entry_id, tmp_path / "state")
    assert sync.fingerprint(tmp_path / "state") == library_hash


def test_a_state_recorded_from_another_pcs_archive_never_stands_for_this_library(lib, tmp_path):
    archive = tmp_path / "revision.zip"
    create_backup(lib, archive)
    library_hash = sync.fingerprint(lib)
    entry_id = history.record_archive(lib.root, io.BytesIO(archive.read_bytes()), kind="set_aside",
                                      library_hash=library_hash, counts=None, schema_version=0)
    assert history.entries(lib.root)[0]["verified"] is False
    assert history.verify_entry(lib.root, entry_id) is True  # Whole, but its hash is only what was claimed.
    assert history.verified_state(lib.root, library_hash) is None
    new = record(lib)
    assert history.verified_state(lib.root, library_hash) == new


def test_a_damaged_blob_is_never_written_out(lib, tmp_path):
    entry_id = record(lib)
    article = hashlib.sha256("サマリー".encode()).hexdigest() + ".z"
    (history_directory(lib.root) / "blobs" / article).write_bytes(zlib.compress("別の内容".encode()))
    with pytest.raises(history.HistoryDataMissing):
        history.materialize(lib.root, entry_id, tmp_path / "state")


def test_a_recording_stopped_halfway_leaves_only_unused_blobs(lib, monkeypatch):
    def stopped(*_args):
        raise Cancelled("stopped")

    write_entry = history._write_entry
    monkeypatch.setattr(history, "_write_entry", stopped)
    with pytest.raises(Cancelled):
        record(lib)
    monkeypatch.setattr(history, "_write_entry", write_entry)
    assert history.entries(lib.root) == [] and blobs(lib.root)
    # Stopped while a blob is being written: its temporary file goes too.
    folder = history_directory(lib.root) / "blobs"

    class DuringWrite(threading.Event):
        def is_set(self):
            return any(path.name.startswith(".blob.") for path in folder.iterdir())

    (lib.root / "extra.txt").write_text("extra")
    with pytest.raises(Cancelled):
        history.record_folder(lib.root, lib.root, kind="publish", library_hash="x", counts={}, cancel=DuringWrite())
    assert history.entries(lib.root) == []
    assert not [name for name in blobs(lib.root) if name.startswith(".")]
    # The next clean-up removes what no entry uses; the next recording works.
    history.prune(lib.root)
    assert blobs(lib.root) == set()
    assert record(lib) is not None and history.entries(lib.root)[0]["complete"]


def test_stale_temporary_files_are_removed(lib):
    record(lib)
    folder = history_directory(lib.root) / "blobs"
    old, fresh = folder / ".blob.old.tmp", folder / ".blob.fresh.tmp"
    old.write_bytes(b"x")
    fresh.write_bytes(b"x")
    past = time.time() - history.STALE_TEMPORARY - 60
    os.utime(old, (past, past))
    history.prune(lib.root)
    assert not old.exists() and fresh.exists()


def entry(seq, kind="publish", day="2026-09-10"):
    return {"id": f"{seq:032x}", "seq": seq, "kind": kind, "day": day}


def test_the_newest_states_are_kept():
    found = [entry(n) for n in range(1, 9)]
    assert history.retained(found, 5, 3, date(2026, 9, 10)) == {entry(n)["id"] for n in range(4, 9)}
    assert history.retained(found, 1, 0, date(2026, 9, 10)) == {entry(8)["id"]}
    assert history.retained(found[:3], 5, 0, date(2026, 9, 10)) == {entry(n)["id"] for n in (1, 2, 3)}
    assert history.retained(found, 50, 0, date(2026, 9, 10)) == {item["id"] for item in found}


def test_the_last_state_of_each_day_used_is_kept():
    # Used on the 1st, 2nd, 5th (a Friday) and 8th (a Monday); not on the days between.
    days = ["2026-09-01", "2026-09-02", "2026-09-05", "2026-09-08", "2026-09-09"]
    found = [entry(n, day=day) for n, day in enumerate([d for d in days for _ in range(3)], start=1)]
    kept = history.retained(found, 1, 3, date(2026, 9, 9))
    # The newest; the last of the 8th, 5th and 2nd (today, the 9th, is not a past day). Not the 1st.
    assert kept == {entry(n)["id"] for n in (15, 12, 9, 6)}
    assert history.retained(found, 1, 0, date(2026, 9, 9)) == {entry(15)["id"]}
    # Once the 9th is over, it counts as a day too.
    assert history.retained(found, 1, 3, date(2026, 9, 10)) == {entry(n)["id"] for n in (15, 12, 9)}


def test_days_follow_the_order_of_use_when_the_clock_went_back():
    # Recorded on the 20th, then the clock was set back to the 5th.
    found = [entry(1, day="2026-09-19"), entry(2, day="2026-09-20"), entry(3, day="2026-09-04"),
             entry(4, day="2026-09-05")]
    assert history.retained(found, 1, 2, date(2026, 9, 5)) == {entry(n)["id"] for n in (4, 3, 2)}


def test_set_aside_and_before_restore_keep_their_own_newest_three():
    found = [entry(n, "set_aside") for n in range(1, 6)] + [entry(n, "before_restore") for n in range(6, 10)]
    found += [entry(10)]
    kept = history.retained(found, 1, 0, date(2026, 9, 10))
    assert kept == {entry(n)["id"] for n in (3, 4, 5, 7, 8, 9, 10)}


def test_days_are_counted_on_this_pcs_clock(lib, monkeypatch):
    for moment in (datetime(2026, 9, 1, 23, 59), datetime(2026, 9, 2, 0, 1)):
        monkeypatch.setattr(history, "_now", lambda moment=moment: moment.astimezone())
        lib.update(lib.identity, note=str(moment))
        record(lib)
    assert [item["day"] for item in history.entries(lib.root)] == ["2026-09-02", "2026-09-01"]


def test_prune_follows_the_settings_and_removes_what_no_state_uses(lib, monkeypatch):
    start = datetime(2026, 9, 1, 12).astimezone()
    extra = lib.root / "extra.bin"
    for n in range(4):
        monkeypatch.setattr(history, "_now", lambda n=n: start + timedelta(days=n))
        extra.write_bytes(os.urandom(1000) + b".pdf")
        record(lib)
    assert len(history.entries(lib.root)) == 4  # The newest 5 are kept by default.
    history.save_history_settings(1, 1)
    removed = history.prune(lib.root)
    kept = history.entries(lib.root)
    assert len(removed) == 2 and len(kept) == 2  # The newest, and the last of the day before.
    for item in kept:
        history.materialize(lib.root, item["id"], lib.root.parent / item["id"])
    manifests = history._read_entries(history_directory(lib.root))[0]
    used = set().union(*(history._referenced(item) for item in manifests))
    assert blobs(lib.root) == used
    # The states just recorded (protect) always stay.
    history.save_history_settings(1, 0)
    assert history.prune(lib.root, protect=[kept[1]["id"]]) == []


@pytest.mark.parametrize("damage", ["newer", "zlib", "gzip", "json"])
def test_an_entry_that_cannot_be_read_costs_only_itself(lib, damage):
    record(lib)
    stored = blobs(lib.root)
    folder = history_directory(lib.root) / "entries"
    if damage == "newer":
        (folder / "20990101-000000-future.json.gz").write_bytes(gzip.compress(json.dumps({"format": 99}).encode()))
    else:
        victim = next(folder.iterdir())
        data = bytearray(victim.read_bytes())
        if damage == "zlib":  # The deflate stream inside the gzip is damaged: zlib.error.
            for i in range(12, min(60, len(data) - 8)):
                data[i] ^= 0x5A
        elif damage == "gzip":
            data[:2] = b"xx"
        else:
            data = bytearray(gzip.compress(b"{not json"))
        victim.write_bytes(bytes(data))
    lib.update(lib.identity, note="after the damage")
    # Listing, recording and the clean-up go on; the entry that cannot be read is counted.
    assert record(lib) is not None
    listed = history.entries(lib.root)
    assert len(listed) == (2 if damage == "newer" else 1)
    assert history.usage(lib.root)["unreadable"] == 1
    history.remove_entries(lib.root, [item["id"] for item in listed])
    history.prune(lib.root)
    # Blobs are left alone while an entry cannot be read: it may need them.
    assert stored <= blobs(lib.root)


def test_another_process_holding_the_history_is_waited_for(lib, monkeypatch):
    record(lib)
    folder = history_directory(lib.root)
    other = history._acquire_file_lock(folder / ".lock")  # As another Papeer would hold it.
    monkeypatch.setattr(history, "LOCK_WAIT", 0.3)
    try:
        lib.update(lib.identity, note="while held")
        with pytest.raises(history.HistoryBusy):
            record(lib)
        with pytest.raises(history.HistoryBusy):
            history.prune(lib.root)
    finally:
        history._unlock_file(other)
    assert record(lib) is not None
    # Taken again by the same thread (a recording within a restore, say) without waiting for itself.
    with history._locked(folder), history._locked(folder):
        history.prune(lib.root)


def test_a_large_recording_is_told(lib, monkeypatch):
    told = []
    monkeypatch.setattr(history, "LARGE_RECORDING", 1)
    library_hash, files = sync.fingerprint_files(lib)
    history.record_folder(lib.root, lib.root, kind="publish", library_hash=library_hash, counts={}, files=files,
                          progress=told.append)
    assert told and "初回は時間がかかります" in told[0]
    lib.update(lib.identity, note="small")
    told.clear()
    monkeypatch.setattr(history, "LARGE_RECORDING", 64 * 1024**2)
    record(lib, progress=told.append)
    assert told == []


def test_settings_belong_to_this_pc_and_are_checked(lib):
    assert history.history_settings() == {"recent": 5, "days": 3}
    assert history.save_history_settings(10, 0) == {"recent": 10, "days": 0}
    assert history.settings_path().is_relative_to(device_directory())
    for recent, days in ((0, 3), (51, 3), (5, -1), (5, 31), (True, 3)):
        with pytest.raises(ValueError):
            history.save_history_settings(recent, days)
    history.settings_path().write_text('{"recent": 500, "days": "3"}')
    assert history.history_settings() == {"recent": 5, "days": 3}
    history.settings_path().write_text("not json")
    assert history.history_settings() == {"recent": 5, "days": 3}


def test_preview_tells_what_other_settings_would_remove(lib):
    ids = []
    for n in range(3):
        lib.update(lib.identity, note=f"note {n}")
        ids.append(record(lib))
    assert [item["id"] for item in history.preview_settings(lib.root, 1, 0)] == [ids[1], ids[0]]
    assert history.preview_settings(lib.root, 5, 3) == []
    with pytest.raises(ValueError):
        history.preview_settings(lib.root, 0, 0)
    assert len(history.entries(lib.root)) == 3  # Nothing removed by looking.


def test_usage_counts_what_the_history_takes(lib):
    assert history.usage(lib.root) == {"bytes": 0, "entries": 0, "blobs": 0, "unreadable": 0}
    record(lib)
    usage = history.usage(lib.root)
    assert usage["entries"] == 1 and usage["blobs"] == len(blobs(lib.root))
    assert usage["bytes"] >= (lib.folder(lib.identity) / "original.pdf").stat().st_size


def legacy_setup(root: Path) -> tuple[Path, Path]:
    backups = history.side_backup_folder(root)
    backups.mkdir()
    (backups / "20260101-000000-abcdef-local.zip").write_bytes(b"z" * 100)
    (backups / "20260101-000000-abcdef-local.json").write_text("{}")
    moved = root.resolve().with_name(root.name + "-before-restore-20260102-000000-abcdef")
    (moved / "papers").mkdir(parents=True)
    (moved / "papers" / "a.pdf").write_bytes(b"p" * 1000)
    (moved / "library.sqlite3").write_bytes(b"d" * 24)
    return backups, moved


def test_what_earlier_versions_left_is_listed_with_sizes_and_removed_only_when_asked(lib):
    backups, moved = legacy_setup(lib.root)
    other = lib.root.with_name("elsewhere-before-restore-20260101")  # Another library's.
    other.mkdir()
    unrelated = lib.root.with_name(lib.root.name + "-notes")
    unrelated.mkdir()
    items = history.legacy_items(lib.root)
    assert [(item["kind"], item["name"], item["size"]) for item in sorted(items, key=lambda item: item["kind"])] == [
        ("before_restore", moved.name, 1024), ("side_backup", "20260101-000000-abcdef-local.zip", 102)]
    os.chmod(moved / "papers" / "a.pdf", stat.S_IREAD)  # Windows refuses to remove a read-only file as it is.
    result = history.remove_legacy(lib.root, [str(moved), str(other), str(unrelated), str(lib.root), "C:/nowhere"])
    assert result["removed"] == [str(moved)] and result["failed"] == []
    assert not moved.exists() and other.exists() and unrelated.exists() and lib.root.exists()
    result = history.remove_legacy(lib.root, [item["path"] for item in result["items"]])
    assert result["items"] == [] and not backups.exists()


@pytest.mark.skipif(os.name != "nt", reason="a junction is a Windows link")
def test_a_link_is_never_listed_or_followed(lib, tmp_path):
    import _winapi
    precious = tmp_path / "precious"
    precious.mkdir()
    (precious / "keep.txt").write_text("keep")
    link = lib.root.resolve().with_name(lib.root.name + "-before-restore-link")
    _winapi.CreateJunction(str(precious), str(link))
    assert history.legacy_items(lib.root) == []
    assert history.remove_legacy(lib.root, [str(link)])["removed"] == []
    assert (precious / "keep.txt").read_text() == "keep"
    os.rmdir(link)
    # Nor the folder of set-aside ZIPs, when it is a link.
    (precious / "20260101-000000-abcdef-local.zip").write_bytes(b"zip")
    _winapi.CreateJunction(str(precious), str(history.side_backup_folder(lib.root)))
    assert history.legacy_items(lib.root) == []
    history.remove_legacy(lib.root, [str(history.side_backup_folder(lib.root) / "20260101-000000-abcdef-local.zip")])
    assert (precious / "20260101-000000-abcdef-local.zip").exists()
    os.rmdir(history.side_backup_folder(lib.root))


def test_history_api(lib, monkeypatch):
    from fastapi.testclient import TestClient
    from sidecar import deps
    from sidecar.app import app
    from sidecar.jobs import JobManager

    entry_id = record(lib)
    backups, moved = legacy_setup(lib.root)
    sync.save_state(lib.root, {"connected": True, "previous_path": str(moved)})
    monkeypatch.setattr(deps, "get_data_dir", lambda: lib.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    with TestClient(app) as client:
        answer = client.get("/api/history").json()
        assert [item["id"] for item in answer["entries"]] == [entry_id] and answer["entries"][0]["complete"]
        assert answer["settings"] == {"recent": 5, "days": 3} and answer["usage"]["entries"] == 1
        assert client.get("/api/history/preview", params={"recent": 1, "days": 0}).json() == {"removed": []}
        assert client.get("/api/history/preview", params={"recent": 0, "days": 0}).status_code == 400
        assert client.put("/api/history/settings", json={"recent": 2, "days": 1}).json() == {"recent": 2, "days": 1}
        assert client.put("/api/history/settings", json={"recent": 99, "days": 1}).status_code == 400
        legacy = client.get("/api/history/legacy").json()
        assert legacy["size"] == 1024 + 102 and len(legacy["items"]) == 2
        result = client.post("/api/history/legacy/remove", json={"paths": [str(moved), str(lib.root)]}).json()
        assert result["removed"] == [str(moved)] and [item["kind"] for item in result["items"]] == ["side_backup"]
    assert lib.root.exists() and not moved.exists() and backups.exists()
    # The status no longer points at the folder removed.
    assert sync.status(lib.root)["previous_path"] is None
