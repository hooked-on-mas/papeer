"""Keeping sync and backup cheap: remembered file digests, stored PDFs, free space, the revision listing."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import time
import zipfile

import pytest

from papeer.core import drive_sync as sync
from papeer.core import fileio
from papeer.core.fileio import InsufficientSpaceError, ensure_free_space
from papeer.core.paths import device_directory, fingerprint_cache_path
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import Library

SAMPLE = Path(__file__).parent / "fixtures/sample.pdf"


@pytest.fixture
def lib(tmp_path):
    library = Library(tmp_path / "data")
    identity, _ = library.import_pdf(SAMPLE)
    library.update(identity, note="メモ")
    (library.folder(identity) / "article.md").write_text("サマリー", "utf-8")
    (library.root / "prompts").mkdir()
    (library.root / "prompts" / "chat.txt").write_text("prompt", "utf-8")
    return library


@pytest.fixture
def settled(monkeypatch):
    """Files written by the test count as written long ago, so they are recorded at once.

    (Not 0: a file's time comes from the file system's clock, which may run slightly ahead of time.time_ns().)
    """
    monkeypatch.setattr(sync, "RACY_NS", -3600 * 10**9)


@pytest.fixture
def hashed(monkeypatch):
    """The paths whose contents were read and hashed."""
    paths: list[str] = []
    original = hashlib.file_digest

    def counting(stream, digest):
        paths.append(Path(stream.name).name)
        return original(stream, digest)
    monkeypatch.setattr(hashlib, "file_digest", counting)
    return paths


def legacy_fingerprint(root: Path) -> str:
    """The hash as Papeer computed it before the digests were recorded (revisions already published)."""
    digest = hashlib.sha256()
    with closing(sqlite3.connect(root / "library.sqlite3")) as db:
        for line in db.iterdump():
            digest.update(line.encode("utf-8") + b"\n")
    for path in sorted(root.rglob("*")):
        if path.is_file() and not fileio.is_temporary(path) and path.name not in {
                "library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm", "ui-state.json"}:
            digest.update(path.relative_to(root).as_posix().encode("utf-8"))
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def same_size_edit(path: Path, text: str) -> None:
    """Rewrite a file in place with contents of the same length and another modification time."""
    before = path.stat()
    path.write_text(text, "utf-8")
    assert path.stat().st_size == before.st_size
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns - 10**9))


def test_hashed_and_recorded_values_are_the_hash_revisions_carry(lib, settled):
    expected = legacy_fingerprint(lib.root)
    assert sync.fingerprint(lib) == expected
    assert not fingerprint_cache_path(lib.root).exists()  # staging copies record nothing
    assert sync.fingerprint(lib, remember=True) == expected
    assert sync.recorded_fingerprint(lib.root) == (expected, expected)
    # Kept with this PC's device files, never in the library (so never backed up or synced).
    path = fingerprint_cache_path(lib.root)
    assert path.is_relative_to(device_directory()) and not path.is_relative_to(lib.root)


def test_the_check_reads_no_file(lib, settled, hashed, monkeypatch):
    identity = lib.papers()[0]["id"]
    sync.fingerprint(lib, remember=True)
    assert "original.pdf" in hashed
    hashed.clear()
    # Closing the connection that dumped the database checkpoints it, which changes the database file:
    # the next check dumps it once more, and from then on the key holds.
    sync.recorded_fingerprint(lib.root)
    expected = legacy_fingerprint(lib.root)
    with monkeypatch.context() as patch:
        patch.setattr(sync.sqlite3, "connect", lambda *a, **k: pytest.fail("dumped the database"))
        assert sync.recorded_fingerprint(lib.root)[0] == expected
    # A change to the database alone is hashed from the records: the database is dumped, no file read.
    lib.save_ink(identity, "original", 1, [{"id": "stroke", "points": [[1, 2]]}])
    assert sync.recorded_fingerprint(lib.root)[0] == legacy_fingerprint(lib.root) != expected
    assert hashed == []


def test_a_changed_file_is_left_to_a_sync(lib, settled, hashed):
    identity = lib.papers()[0]["id"]
    sync.fingerprint(lib, remember=True)
    _, before = sync.recorded_fingerprint(lib.root)
    hashed.clear()
    same_size_edit(lib.folder(identity) / "article.md", "要約文章")  # as many bytes as サマリー
    changed, version = sync.recorded_fingerprint(lib.root)
    assert changed is None and version not in (None, before)
    assert sync.recorded_fingerprint(lib.root)[1] == version  # the same while nothing else changes
    (lib.root / "prompts" / "new.txt").write_text("new", "utf-8")
    assert sync.recorded_fingerprint(lib.root)[1] not in (None, version)
    assert hashed == []
    assert sync.fingerprint(lib, remember=True) == legacy_fingerprint(lib.root)
    assert sync.recorded_fingerprint(lib.root)[0] == legacy_fingerprint(lib.root)
    (lib.root / "prompts" / "chat.txt").unlink()
    assert sync.recorded_fingerprint(lib.root)[0] is None


@pytest.mark.parametrize("contents", [
    "not json",
    json.dumps([1, 2, 3]),
    json.dumps({"format": 99, "files": {}}),
    json.dumps({"format": 1, "root": "elsewhere", "files": {}, "database": None, "hash": "0" * 64}),
    json.dumps({"format": 1, "files": {"papers": "x"}, "database": [], "hash": 5}),
])
def test_a_damaged_record_is_not_trusted_and_a_sync_replaces_it(lib, settled, contents):
    path = fingerprint_cache_path(lib.root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, "utf-8")
    assert sync.recorded_fingerprint(lib.root)[0] is None
    assert sync.fingerprint(lib, remember=True) == legacy_fingerprint(lib.root)
    assert json.loads(path.read_text("utf-8"))["format"] == sync.FINGERPRINT_CACHE_FORMAT
    assert sync.recorded_fingerprint(lib.root)[0] == legacy_fingerprint(lib.root)


def test_a_record_for_an_older_file_is_not_used(lib, settled):
    identity = lib.papers()[0]["id"]
    sync.fingerprint(lib, remember=True)
    path = fingerprint_cache_path(lib.root)
    value = json.loads(path.read_text("utf-8"))
    rel = f"papers/{identity}/article.md"
    # A stale entry: the key of some earlier version of the file, with a wrong digest and hash.
    value["files"][rel] = [value["files"][rel][0], value["files"][rel][1] - 5, value["files"][rel][2], "0" * 64]
    value["hash"] = "f" * 64
    path.write_text(json.dumps(value), "utf-8")
    assert sync.recorded_fingerprint(lib.root)[0] is None


def test_a_file_written_while_it_was_hashed_is_never_trusted(lib, monkeypatch):
    """With the real racy window, whatever the machine's speed: the clock is held at the file's time."""
    identity = lib.papers()[0]["id"]
    article = lib.folder(identity) / "article.md"
    written = article.stat().st_mtime_ns
    monkeypatch.setattr(sync, "_now_ns", lambda: written + 10**9)
    sync.fingerprint(lib, remember=True)
    record = json.loads(fingerprint_cache_path(lib.root).read_text("utf-8"))
    assert f"papers/{identity}/article.md" not in record["files"] and record["hash"] is None
    article.write_text("要約文章", "utf-8")  # a second write that keeps the size and the time
    os.utime(article, ns=(written, written))
    assert sync.recorded_fingerprint(lib.root)[0] is None
    assert sync.fingerprint(lib) == legacy_fingerprint(lib.root)


def test_a_file_dated_in_the_future_is_recorded(lib):
    """Otherwise it would never be, and every check would leave the whole library to a sync."""
    old, future = time.time_ns() - 3600 * 10**9, time.time_ns() + 3600 * 10**9
    for path in lib.root.rglob("*"):
        if path.is_file():
            os.utime(path, ns=(old, old))
    article = lib.folder(lib.papers()[0]["id"]) / "article.md"
    os.utime(article, ns=(future, future))
    sync.fingerprint(lib, remember=True)
    assert sync.recorded_fingerprint(lib.root)[0] == legacy_fingerprint(lib.root)
    article.write_text("要約文章", "utf-8")  # a later write gives it the current time
    assert sync.recorded_fingerprint(lib.root)[0] is None


def test_backup_stores_pdfs_and_images_and_still_restores(lib, tmp_path):
    identity = lib.papers()[0]["id"]
    (lib.folder(identity) / "media").mkdir()
    (lib.folder(identity) / "media" / "figure.PNG").write_bytes(b"\x89PNG" + b"0" * 1000)
    archive_path = tmp_path / "backup.zip"
    create_backup(lib, archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        methods = {info.filename: info.compress_type for info in archive.infolist()}
        assert archive.testzip() is None
    assert methods[f"papers/{identity}/original.pdf"] == zipfile.ZIP_STORED
    assert methods[f"papers/{identity}/media/figure.PNG"] == zipfile.ZIP_STORED
    assert methods["library.sqlite3"] == methods[f"papers/{identity}/article.md"] == zipfile.ZIP_DEFLATED
    expected = sync.fingerprint(lib)
    lib.update(identity, note="後で変えた")
    restore_backup(lib, archive_path)
    assert sync.fingerprint(Library(lib.root)) == expected


def disk_with_free_space(monkeypatch, free: int):
    usage = shutil.disk_usage(Path.cwd())
    monkeypatch.setattr(fileio.shutil, "disk_usage", lambda _: usage._replace(free=free))


def test_a_backup_that_would_not_fit_stops_before_writing(lib, tmp_path, monkeypatch):
    disk_with_free_space(monkeypatch, fileio.SPACE_MARGIN)
    destination = tmp_path / "out" / "backup.zip"
    with pytest.raises(InsufficientSpaceError, match="空き容量が足りません"):
        create_backup(lib, destination)
    assert not destination.parent.exists() or not any(destination.parent.iterdir())


def test_a_restore_that_would_not_fit_leaves_the_library(lib, tmp_path, monkeypatch):
    archive_path = tmp_path / "backup.zip"
    create_backup(lib, archive_path)
    before = sync.fingerprint(lib)
    folders = sorted(lib.root.parent.iterdir())
    disk_with_free_space(monkeypatch, fileio.SPACE_MARGIN)
    with pytest.raises(InsufficientSpaceError):
        restore_backup(lib, archive_path)
    assert sync.fingerprint(lib) == before
    assert sorted(lib.root.parent.iterdir()) == folders


def test_sizes_on_one_drive_add_up(tmp_path, monkeypatch):
    disk_with_free_space(monkeypatch, fileio.SPACE_MARGIN + 150)
    ensure_free_space({tmp_path / "a": 100, tmp_path / "missing" / "b": 50})
    with pytest.raises(InsufficientSpaceError):
        ensure_free_space({tmp_path / "a": 100, tmp_path / "missing" / "b": 51})


def test_folder_sync_checks_space_in_the_sync_folder(lib, tmp_path, monkeypatch):
    sync.connect(lib.root, str(tmp_path / "drive"))
    disk_with_free_space(monkeypatch, 10**12)
    real = fileio.shutil.disk_usage

    def usage(path):
        value = real(path)
        return value._replace(free=0) if Path(path).is_relative_to(tmp_path / "drive") else value
    monkeypatch.setattr(fileio.shutil, "disk_usage", usage)
    monkeypatch.setattr(fileio.os, "stat", _distinct_drive(tmp_path / "drive"))
    with pytest.raises(InsufficientSpaceError):
        sync.sync(lib, sync.FolderDrive(tmp_path / "drive"), threading.Event(), lambda _: None)
    assert not list((tmp_path / "drive").iterdir())


def _distinct_drive(folder: Path):
    """os.stat that puts `folder` on a drive of its own (st_dev), as a Google Drive mount would be."""
    real = os.stat

    def stat(path, *args, **kwargs):
        value = real(path, *args, **kwargs)
        if Path(path).is_relative_to(folder):
            fields = list(value)
            fields[2] = value.st_dev + 1  # st_dev
            return os.stat_result(fields)
        return value
    return stat


def test_revisions_are_read_once(lib, tmp_path, monkeypatch):
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    remote = sync.FolderDrive(folder)
    sync.sync(lib, remote, threading.Event(), lambda _: None)
    first = remote.revisions()
    opened: list[str] = []
    original = zipfile.ZipFile

    def counting(path, *args, **kwargs):
        opened.append(Path(path).name)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(sync.zipfile, "ZipFile", counting)
    assert sync.FolderDrive(folder).revisions() == first
    assert opened == []
    # A new revision is read; one that disappeared is no longer listed.
    lib.update(lib.papers()[0]["id"], note="変更")
    monkeypatch.setattr(sync.zipfile, "ZipFile", original)
    sync.sync(lib, remote, threading.Event(), lambda _: None)
    monkeypatch.setattr(sync.zipfile, "ZipFile", counting)
    assert len(remote.revisions()) == 2 and len(opened) == 1
    newest = sync.revision_heads(remote.revisions())[0]["id"]
    (folder / f"{newest}.papeer-sync").unlink()
    assert [item["id"] for item in remote.revisions()] == [first[0]["id"]]


def test_a_folder_briefly_held_open_is_renamed_after_a_wait(tmp_path, monkeypatch):
    """A virus scan or the indexer may hold a file of the library for a moment when a restore swaps folders."""
    from papeer.core import reading_tools
    source = tmp_path / "library"
    source.mkdir()
    real = Path.rename
    refusals = []

    def rename(self, target):
        if len(refusals) < 2:
            refusals.append(self)
            raise PermissionError("in use")
        return real(self, target)
    monkeypatch.setattr(Path, "rename", rename)
    reading_tools._rename_folder(source, tmp_path / "moved", wait=0)
    assert len(refusals) == 2 and (tmp_path / "moved").is_dir()
