"""This PC's history of the library: the states folder sync settled on, each content stored once.

Kept in this PC's device folder (paths.history_directory: never synced or backed up):

    entries/<time>-<id>.json.gz   one per recorded state: what the state was (kind, time, counts, hash) and
                                  its manifest, every file's path with the SHA-256 and size of its contents
                                  and the database as chunks of CHUNK bytes
    blobs/<sha256>[.z]            each distinct content once, named by the SHA-256 of the content itself;
                                  ".z" holds it zlib-compressed (all but PDFs and images, as in a backup)

A state is recorded when a sync publishes this PC's library ("publish"), takes in another PC's ("pull"),
or a choice between two libraries leaves one out ("set_aside"); "before_restore" is kept for the library
as it was just before a restore replaced it. Most files are the same from one state to the next, so a
state costs only what changed: the new files and the database chunks that differ (SQLite's backup keeps
each page in its place, so an edit changes a few chunks).

Writing is all or nothing: the blobs are written first and the entry last, each to a temporary file that
is renamed into place. A recording stopped halfway leaves only blobs that no entry uses, which the next
clean-up (prune) removes. An entry whose blobs are not all there (a file removed by hand) is incomplete,
and nothing relies on it. Before anything is removed for a state's sake (the folder a sync moved aside),
the state is read back in full (verified_state): a blob found damaged is moved aside, so the next
recording of that content stores it anew. A state recorded from another PC's archive carries the hash
that PC claimed, and never stands for a library of this PC.

What is kept (retained): the newest `recent` states published or taken in, plus the last of each of the
`days` most recent days Papeer synced on before today (a day without a sync does not count, so Friday's
last state is still there on Monday), plus the newest SPECIAL_LIMIT of each other kind. recent and days
are this PC's settings (history_settings), as the drives of two PCs differ.

This module also lists what earlier versions left beside the library for the same purpose (the ZIPs a
choice set aside, and the folders each restore or sync moved aside), with their sizes, for the user to
remove after confirming (legacy_items, remove_legacy).
"""
from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import closing, contextmanager
from datetime import date, datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import uuid
import zipfile
import zlib

from papeer import __version__
from papeer.core.backup import DATABASE_FILES, STORED_SUFFIXES, unsafe_path
from papeer.core.fileio import (atomic_write_bytes, atomic_write_json, ensure_free_space, is_temporary, move_file,
                                 sync_directory)
from papeer.core.paths import device_directory, history_directory
from papeer.providers import check_cancel

FORMAT = 2
# The database is stored as chunks of this size: an edit changes a few of them (measured in the L1 design).
CHUNK = 256 * 1024
_READ_SIZE = 1024 * 1024
# zlib's fastest level: the text files compress almost as well as at the default (6) in a fraction of the
# time, which the first recording (the whole library) is mostly spent on. Blobs are named by their
# uncompressed contents, so the level can change without storing anything twice.
COMPRESSION = 1
# A file of another PC's revision up to this size is read into memory to learn its SHA-256 before it is
# written (most are); a larger one is written to a temporary blob while it is read.
_IN_MEMORY = 16 * 1024**2

KINDS = ("publish", "pull", "set_aside", "before_restore")
REGULAR = frozenset({"publish", "pull"})
# The newest this many of each other kind are kept, as many as the side backups before them.
SPECIAL_LIMIT = 3
DEFAULT_SETTINGS = {"recent": 5, "days": 3}
SETTING_RANGES = {"recent": (1, 50), "days": (0, 30)}
# A temporary file older than this is a leftover of a forced exit: a recording takes seconds, not an hour.
STALE_TEMPORARY = 3600
# Damaged blobs moved aside (verify_entry) are kept this long, to look into, then removed.
DAMAGED_KEPT = 7 * 24 * 3600

_ID = re.compile(r"[0-9a-f]{32}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
# Reading another PC's revision (a ZIP in the sync folder) that is damaged, cut short or still arriving.
_READ_ERRORS = (OSError, EOFError, ValueError, KeyError, zipfile.BadZipFile, zlib.error)
# A recording, a clean-up and a restore of one history never overlap: in this process (the lock, held
# throughout, which a thread may take again) and across processes (a lock on the history's ".lock" file,
# taken when this process first needs it). Otherwise a clean-up could remove the blobs a recording has
# just written, or those a restore is reading.
_LOCK = threading.RLock()
_HELD: dict[str, tuple[int, object]] = {}
# How long to wait for another process holding the history before giving up.
LOCK_WAIT = 30.0
# A recording that stores more than this is told as such: the first one copies the whole library.
LARGE_RECORDING = 64 * 1024**2


def _now() -> datetime:
    """The time a state is recorded at (replaced in tests)."""
    return datetime.now(timezone.utc)


class SourceUnreadable(Exception):
    """Another PC's revision could not be read, or holds a path that must not be written.

    Not a ValueError (nor an OSError): a failure to write this PC's history must never pass for it.
    """


class HistoryDataMissing(ValueError):
    """A blob a state needs is missing or does not match its name."""


class HistoryBusy(ValueError):
    """Another process holds this history (a second Papeer on the same library)."""


def _lock_file(handle) -> None:
    handle.seek(0)
    if sys.platform == "win32":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle) -> None:
    try:
        handle.seek(0)
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def _acquire_file_lock(path: Path):
    """The history's lock file, opened and locked; waits up to LOCK_WAIT for another process (HistoryBusy)."""
    handle = open(path, "a+b")  # noqa: SIM115 - kept open while the lock is held, closed by _unlock_file
    deadline = time.monotonic() + LOCK_WAIT
    while True:
        try:
            _lock_file(handle)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise HistoryBusy("このPCの履歴を別のPapeerが使っています。しばらくしてからもう一度お試しください。") from None
            time.sleep(0.1)


@contextmanager
def _locked(folder: Path):
    """Hold the history at `folder` (created if need be) against other threads and processes."""
    with _LOCK:
        key = str(folder)
        depth, handle = _HELD.get(key, (0, None))
        if depth == 0:
            folder.mkdir(parents=True, exist_ok=True)
            handle = _acquire_file_lock(folder / ".lock")
        _HELD[key] = (depth + 1, handle)
        try:
            yield
        finally:
            depth, handle = _HELD.pop(key)
            if depth > 1:
                _HELD[key] = (depth - 1, handle)
            else:
                _unlock_file(handle)


def _check(cancel: threading.Event | None) -> None:
    if cancel is not None:
        check_cancel(cancel)


def compressed(path: str) -> bool:
    """Whether a file of the library is stored compressed: all but those compressed already (backup.STORED_SUFFIXES)."""
    return PurePosixPath(path).suffix.lower() not in STORED_SUFFIXES


def blob_name(digest: str, compress: bool) -> str:
    return digest + (".z" if compress else "")


def _rechunk(pieces: Iterable[bytes], size: int) -> Iterator[bytes]:
    """The bytes of `pieces` again, in pieces of exactly `size` (the last may be shorter)."""
    buffer = bytearray()
    for piece in pieces:
        buffer += piece
        while len(buffer) >= size:
            yield bytes(buffer[:size])
            del buffer[:size]
    if buffer:
        yield bytes(buffer)


def _file_chunks(path: Path, size: int = _READ_SIZE) -> Iterator[bytes]:
    with path.open("rb") as stream:
        while piece := stream.read(size):
            yield piece


class _Blobs:
    """The blobs folder of one history, with the names it held when opened (kept up to date by this object)."""

    def __init__(self, folder: Path, *, create: bool = False):
        self.folder = folder
        if create:
            folder.mkdir(parents=True, exist_ok=True)
        self.names = _blob_names(folder)

    def has(self, digest: str, compress: bool, size: int | None = None) -> bool:
        """Whether the content is stored; an uncompressed blob of another size (damaged) does not count."""
        name = blob_name(digest, compress)
        if name not in self.names:
            return False
        if compress or size is None:
            return True
        try:
            return (self.folder / name).stat().st_size == size
        except OSError:
            return False

    def write(self, pieces: Iterable[bytes], compress: bool, cancel=None, expected: str | None = None) -> tuple[str, int]:
        """Store the content given in `pieces`; (its SHA-256, its size).

        With `expected`, content with another SHA-256 is refused (the file changed while it was recorded).
        """
        descriptor, name = tempfile.mkstemp(dir=self.folder, prefix=".blob.", suffix=".tmp")
        temporary = Path(name)
        digest, size = hashlib.sha256(), 0
        try:
            with os.fdopen(descriptor, "wb") as output:
                compressor = zlib.compressobj(COMPRESSION) if compress else None
                for piece in pieces:
                    _check(cancel)
                    digest.update(piece)
                    size += len(piece)
                    output.write(compressor.compress(piece) if compressor else piece)
                if compressor:
                    output.write(compressor.flush())
                output.flush()
                # On disk before it is renamed, through the handle it was written with: opening a file just
                # written again (as fileio.replace_file does) makes a virus scanner read it once more.
                os.fsync(output.fileno())
            value = digest.hexdigest()
            if expected is not None and value != expected:
                raise ValueError("記録中にライブラリのファイルが変わりました。もう一度同期してください。")
            if not self.has(value, compress, size):
                move_file(temporary, self.folder / blob_name(value, compress))
                self.names.add(blob_name(value, compress))
            return value, size
        finally:
            temporary.unlink(missing_ok=True)

    def put_bytes(self, data: bytes, compress: bool) -> str:
        digest = hashlib.sha256(data).hexdigest()
        if not self.has(digest, compress, len(data)):
            self.write([data], compress, expected=digest)
        return digest

    def put_file(self, path: Path, compress: bool, known: tuple[str, int] | None, cancel=None) -> tuple[str, int]:
        """Store a file; `known` is its (SHA-256, size) as already read, so a stored one is not read again."""
        size = path.stat().st_size
        if known is not None and known[1] == size:
            if self.has(known[0], compress, size):
                return known[0], size
            return self.write(_file_chunks(path), compress, cancel, expected=known[0])
        return self.write(_file_chunks(path), compress, cancel)


def _blob_names(folder: Path) -> set[str]:
    try:
        return {path.name for path in folder.iterdir() if not is_temporary(path)}
    except FileNotFoundError:
        return set()


def _blob_chunks(folder: Path, name: str, cancel=None) -> Iterator[bytes]:
    """A blob's content, checked against its name at the end (HistoryDataMissing when missing or different)."""
    digest = hashlib.sha256()
    decompressor = zlib.decompressobj() if name.endswith(".z") else None
    try:
        with (folder / name).open("rb") as stream:
            while piece := stream.read(_READ_SIZE):
                _check(cancel)
                if decompressor:
                    piece = decompressor.decompress(piece)
                digest.update(piece)
                yield piece
            if decompressor:
                rest = decompressor.flush()
                digest.update(rest)
                yield rest
    except (FileNotFoundError, zlib.error) as exc:
        raise HistoryDataMissing("この時点のデータの一部が見つからないか、破損しています。") from exc
    if digest.hexdigest() != name.removesuffix(".z"):
        raise HistoryDataMissing("この時点のデータの一部が破損しています。")


# --- Entries ---

def _entry_files(folder: Path) -> list[Path]:
    try:
        return [path for path in (folder / "entries").iterdir() if path.name.endswith(".json.gz") and not is_temporary(path)]
    except FileNotFoundError:
        return []


def _valid_entry(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    db, files = value.get("db"), value.get("files")
    return (value.get("format") == FORMAT and isinstance(value.get("id"), str) and bool(_ID.fullmatch(value["id"]))
            and value.get("kind") in KINDS and type(value.get("seq")) is int
            and isinstance(value.get("created"), str) and isinstance(value.get("day"), str)
            and bool(_DAY.fullmatch(value["day"])) and isinstance(value.get("hash"), str)
            and isinstance(db, dict) and isinstance(db.get("chunks"), list)
            and all(isinstance(c, str) and _DIGEST.fullmatch(c) for c in db["chunks"])
            and isinstance(db.get("sha256"), str) and type(db.get("size")) is int
            and type(value.get("verified", True)) is bool and isinstance(files, dict) and all(
                isinstance(rel, str) and isinstance(item, list) and len(item) == 2 and isinstance(item[0], str)
                and bool(_DIGEST.fullmatch(item[0])) and type(item[1]) is int for rel, item in files.items()))


def _read_entries(folder: Path) -> tuple[list[dict], int]:
    """(the readable entries, oldest first; how many entry files could not be read).

    Each entry carries its file as "_file". An entry file that cannot be read (damaged, or written by a
    newer Papeer) is left alone, and while there is one, no blob is cleaned up (it may need them).
    """
    result, unreadable = [], 0
    for path in _entry_files(folder):
        try:
            value = json.loads(gzip.decompress(path.read_bytes()))
        except Exception:  # noqa: BLE001 - damaged in any way (zlib, gzip, JSON, UTF-8...): one entry lost, not the history
            unreadable += 1
            continue
        if not _valid_entry(value):
            unreadable += 1
            continue
        result.append({**value, "_file": path})
    result.sort(key=lambda entry: entry["seq"])
    return result, unreadable


def _referenced(entry: dict) -> set[str]:
    names = {blob_name(digest, compressed(rel)) for rel, (digest, _size) in entry["files"].items()}
    return names | {blob_name(digest, True) for digest in entry["db"]["chunks"]}


def missing_blobs(folder: Path, entry: dict, names: set[str] | None = None) -> set[str]:
    """The blobs an entry needs that are not in the history's blobs folder, or (stored uncompressed, so
    their size is known) are there with another size. A compressed blob is checked only by verify_entry."""
    present = _blob_names(folder / "blobs") if names is None else names
    missing = _referenced(entry) - present
    for rel, (digest, size) in entry["files"].items():
        name = blob_name(digest, compressed(rel))
        if not compressed(rel) and name in present:
            try:
                if (folder / "blobs" / name).stat().st_size != size:
                    missing.add(name)
            except OSError:
                missing.add(name)
    return missing


def _public(entry: dict, names: set[str] | None = None, folder: Path | None = None) -> dict:
    """What a caller is told of an entry: all but the manifest, with its size and whether it is complete."""
    result = {key: value for key, value in entry.items() if key not in ("files", "db", "_file", "format")}
    result["verified"] = entry.get("verified", True)
    result["size"] = entry["db"]["size"] + sum(size for _digest, size in entry["files"].values())
    result["files"] = len(entry["files"])
    if names is not None and folder is not None:
        result["complete"] = not missing_blobs(folder, entry, names)
    return result


def entries(root: Path) -> list[dict]:
    """The recorded states of the library at `root`, newest first; "complete" when every blob is there
    (compressed ones by name only: verify_entry reads them). "group" places each in the list the settings
    show: "recent" (the newest `recent` published or taken in), "daily" (the other ones published or
    taken in: the last of a day) and "special" (set aside, before a restore)."""
    folder = history_directory(root)
    found, _ = _read_entries(folder)
    names = _blob_names(folder / "blobs")
    recent = history_settings()["recent"]
    regular = [entry["id"] for entry in found if entry["kind"] in REGULAR]
    newest = set(regular[max(0, len(regular) - recent):])
    result = []
    for entry in reversed(found):
        item = _public(entry, names, folder)
        item["group"] = "special" if entry["kind"] not in REGULAR else "recent" if entry["id"] in newest else "daily"
        result.append(item)
    return result


@contextmanager
def holding(root: Path):
    """Hold the history of the library at `root` for a restore: no recording or clean-up meanwhile."""
    with _locked(history_directory(root)):
        yield


def _inspect(folder: Path, entry: dict, cancel, checked: dict[str, int | None]) -> tuple[set[str], bool]:
    """(the blobs of an entry that are missing or do not match their name, whether the database they make up
    matches the entry's SHA-256 and size). Every blob is read, as materialize reads it, but nothing is written.
    `checked` remembers each blob's size (None when bad) across calls."""
    blobs = folder / "blobs"

    def size_of(name: str) -> int | None:
        if name not in checked:
            try:
                checked[name] = sum(len(piece) for piece in _blob_chunks(blobs, name, cancel))
            except HistoryDataMissing:
                checked[name] = None
        return checked[name]
    bad = set()
    for rel, (digest, size) in entry["files"].items():
        name = blob_name(digest, compressed(rel))
        if size_of(name) != size:
            bad.add(name)
    database, total = hashlib.sha256(), 0
    for chunk in entry["db"]["chunks"]:
        name = blob_name(chunk, True)
        if checked.get(name, 0) is None:
            bad.add(name)
            continue
        length = 0
        try:
            for piece in _blob_chunks(blobs, name, cancel):
                database.update(piece)
                length += len(piece)
        except HistoryDataMissing:
            checked[name] = None
            bad.add(name)
            continue
        checked[name] = length
        total += length
    whole = not bad and database.hexdigest() == entry["db"]["sha256"] and total == entry["db"]["size"]
    return bad, whole


def _quarantine(folder: Path, names: Iterable[str]) -> None:
    """Move damaged blobs out of the way, so the next recording of the same content stores it anew."""
    damaged = folder / "damaged"
    for name in names:
        source = folder / "blobs" / name
        if not source.exists():
            continue
        damaged.mkdir(exist_ok=True)
        os.replace(source, damaged / name)


def verify_entry(root: Path, entry_id: str, cancel=None) -> bool:
    """Whether a recorded state can be written out whole: every blob read and checked, the database too.
    Blobs found damaged are moved aside (to "damaged/"), so a later recording stores them again."""
    folder = history_directory(root)
    if not folder.is_dir():
        return False
    with _locked(folder):
        found, _ = _read_entries(folder)
        entry = next((item for item in found if item["id"] == entry_id), None)
        if entry is None or missing_blobs(folder, entry):
            return False
        bad, whole = _inspect(folder, entry, cancel, {})
        _quarantine(folder, bad)
        return whole


def verified_state(root: Path, library_hash: str, cancel=None) -> str | None:
    """The ID of a state with this hash (drive_sync.fingerprint) whose every blob was read and found as
    recorded, newest first; None when there is none. Only states recorded from a library on this PC count:
    one recorded from another PC's archive carries the hash that PC claimed (see record_archive).
    Damaged blobs found on the way are moved aside (verify_entry)."""
    folder = history_directory(root)
    if not folder.is_dir():
        return None
    with _locked(folder):
        found, _ = _read_entries(folder)
        names = _blob_names(folder / "blobs")
        checked: dict[str, int | None] = {}
        for entry in reversed(found):
            if entry["hash"] != library_hash or not entry.get("verified", True) or missing_blobs(folder, entry, names):
                continue
            bad, whole = _inspect(folder, entry, cancel, checked)
            if bad:
                _quarantine(folder, bad)
                names -= bad
                continue
            if whole:
                return entry["id"]
        return None


def _new_entry(found: list[dict], kind: str, library_hash: str, counts: dict | None, schema_version: int,
               db: dict, files: dict, meta: dict, *, verified: bool) -> dict:
    now = _now()
    return {"format": FORMAT, "id": uuid.uuid4().hex,
            # The order entries were recorded in: unlike the time, it does not go back with the clock.
            "seq": max((entry["seq"] for entry in found), default=0) + 1,
            "created": now.astimezone(timezone.utc).isoformat(),
            # The day on this PC's clock (midnight to midnight), by which `days` is counted.
            "day": now.astimezone().date().isoformat(),
            "kind": kind, "device": platform.node(), "app_version": __version__, "schema_version": schema_version,
            "hash": library_hash, "counts": counts if isinstance(counts, dict) else None,
            # Whether the hash was worked out from these very files (a library on this PC), or only claimed
            # by the PC that published them (record_archive).
            "verified": verified,
            **{key: value for key, value in meta.items() if value is not None}, "db": db, "files": files}


def _write_entry(folder: Path, entry: dict) -> None:
    """Write the entry: the last step, which makes the state recorded.

    Every blob it names was flushed to disk before it was renamed into place; the renames themselves are
    flushed here, once, before the entry that relies on them (POSIX; NTFS journals a rename).
    """
    sync_directory(folder / "blobs")
    (folder / "entries").mkdir(parents=True, exist_ok=True)
    stamp = datetime.fromisoformat(entry["created"]).strftime("%Y%m%d-%H%M%S")
    data = gzip.compress(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0)
    atomic_write_bytes(folder / "entries" / f"{stamp}-{entry['id']}.json.gz", data)


def _remember_library(folder: Path, root: Path) -> None:
    """Note which library the history belongs to (its folder is named by a digest of the path), so a history
    left behind when the library moved can be told apart (other_histories)."""
    marker = folder / "library.json"
    if not marker.exists():
        atomic_write_json(marker, {"library": str(root.resolve())}, indent=None)


def _latest_regular(found: list[dict]) -> dict | None:
    return next((entry for entry in reversed(found) if entry["kind"] in REGULAR), None)


# --- Recording ---

def _snapshot(database: Path, directory: Path) -> tuple[Path, int]:
    """A consistent copy of the database (SQLite's backup, as create_backup takes it) and its schema version."""
    if not database.is_file():
        raise ValueError("ライブラリのデータベースが見つかりません。")
    target = directory / "library.sqlite3"
    with closing(sqlite3.connect(database, timeout=30)) as source, closing(sqlite3.connect(target)) as copy:
        source.backup(copy)
        version = copy.execute("PRAGMA user_version").fetchone()[0]
    return target, version


def _put_database(blobs: _Blobs, pieces: Iterable[bytes], cancel) -> dict:
    digest, size, chunks = hashlib.sha256(), 0, []
    for piece in _rechunk(pieces, CHUNK):
        _check(cancel)
        digest.update(piece)
        size += len(piece)
        chunks.append(blobs.put_bytes(piece, True))
    return {"chunk": CHUNK, "size": size, "sha256": digest.hexdigest(), "chunks": chunks}


def record_folder(root: Path, source: Path, *, kind: str, library_hash: str, counts: dict | None,
                  files: dict[str, tuple[str, int]] | None = None, cancel=None, progress=None, **meta) -> str | None:
    """Record the library in `source` (the library at `root` itself, or a copy about to replace it).

    `files` gives the SHA-256 and size of files already read (drive_sync.fingerprint_files), so the files
    stored before are not read again. Returns the new entry's ID, or None when a published or taken state
    is recorded again unchanged (the newest such state already holds it, complete).
    The files are those of a backup (create_backup): all but the database files and temporary leftovers.
    `progress` is told when much is to be stored (the first recording copies the whole library).
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r}")
    folder = history_directory(root)
    with _locked(folder):
        _remember_library(folder, root)
        found, _ = _read_entries(folder)
        latest = _latest_regular(found)
        if (kind in REGULAR and latest is not None and latest["hash"] == library_hash
                and not missing_blobs(folder, latest)):
            return None
        blobs = _Blobs(folder / "blobs", create=True)
        known = files or {}
        paths = []
        for path in sorted(source.rglob("*")):
            _check(cancel)
            if path.is_file() and not is_temporary(path) and path.name not in DATABASE_FILES:
                paths.append((path, path.relative_to(source).as_posix()))
        database = sum(path.stat().st_size for path in (source / name for name in DATABASE_FILES[:2]) if path.is_file())
        new = 0
        for path, rel in paths:
            size, item = path.stat().st_size, known.get(rel)
            if not (item and item[1] == size and blobs.has(item[0], compressed(rel), size)):
                new += size
        # What is not stored yet, and the database: its snapshot in the temporary folder, then its chunks.
        ensure_free_space({blobs.folder: new + database, Path(tempfile.gettempdir()): database})
        if progress is not None and new >= LARGE_RECORDING:
            progress(f"このPCの履歴にライブラリを記録しています（{new / 1024**3:.1f} GB。初回は時間がかかります）…"
                     if new >= 1024**3 else
                     f"このPCの履歴にライブラリを記録しています（{new // 1024**2} MB。初回は時間がかかります）…")
        manifest = {}
        for path, rel in paths:
            _check(cancel)
            manifest[rel] = list(blobs.put_file(path, compressed(rel), known.get(rel), cancel))
        with tempfile.TemporaryDirectory() as directory:
            snapshot, version = _snapshot(source / "library.sqlite3", Path(directory))
            db = _put_database(blobs, _file_chunks(snapshot, CHUNK), cancel)
        entry = _new_entry(found, kind, library_hash, counts, version, db, manifest, meta, verified=True)
        _check(cancel)
        _write_entry(folder, entry)
        return entry["id"]


def _member_chunks(archive: zipfile.ZipFile, info: zipfile.ZipInfo, size: int) -> Iterator[bytes]:
    """A ZIP entry's content; what reading it raises becomes SourceUnreadable (never what writing raises)."""
    try:
        with archive.open(info) as member:
            while True:
                try:
                    piece = member.read(size)
                except _READ_ERRORS as exc:
                    raise SourceUnreadable() from exc
                if not piece:
                    return
                yield piece
    except _READ_ERRORS as exc:
        raise SourceUnreadable() from exc


def record_archive(root: Path, stream, *, kind: str, library_hash: str, counts: dict | None,
                   schema_version: int, cancel=None, **meta) -> str:
    """Record a library given as a backup ZIP (another PC's revision, read where it lies); the new entry's ID.

    Each file is read once: its SHA-256 is learnt while it is read, and it is written only when not stored
    yet. The ZIP's own checks (the CRC of each entry) catch a file damaged or cut short. Reading the ZIP
    raises SourceUnreadable, as does a path that must not be written; writing this PC's history raises
    as it is. `library_hash` is what that PC says of the library: the state is marked unverified, and
    verified_state never takes it for a library of this PC.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r}")
    folder = history_directory(root)
    with _locked(folder):
        _remember_library(folder, root)
        found, _ = _read_entries(folder)
        blobs = _Blobs(folder / "blobs", create=True)
        try:
            archive = zipfile.ZipFile(stream)
            infos = [info for info in archive.infolist() if not info.is_dir()]
        except _READ_ERRORS as exc:
            raise SourceUnreadable() from exc
        with archive:
            seen = set()
            for info in infos:
                normalized = info.filename.casefold()
                if (unsafe_path(info.filename) or normalized in seen
                        or (info.external_attr >> 16) & 0o170000 == 0o120000):
                    raise SourceUnreadable()
                seen.add(normalized)
            if "library.sqlite3" not in {info.filename for info in infos}:
                raise SourceUnreadable()
            ensure_free_space({blobs.folder: sum(info.file_size for info in infos)})
            manifest, db = {}, None
            for info in infos:
                _check(cancel)
                name = info.filename
                if name in ("papeer-backup.json", "paperdesk-backup.json"):
                    continue  # The backup's own description, not a file of the library.
                if name == "library.sqlite3":
                    db = _put_database(blobs, _member_chunks(archive, info, CHUNK), cancel)
                elif info.file_size <= _IN_MEMORY:
                    data = b"".join(_member_chunks(archive, info, _READ_SIZE))
                    manifest[name] = [blobs.put_bytes(data, compressed(name)), len(data)]
                else:
                    manifest[name] = list(blobs.write(_member_chunks(archive, info, _READ_SIZE), compressed(name), cancel))
        assert db is not None
        entry = _new_entry(found, kind, library_hash, counts, schema_version, db, manifest, meta, verified=False)
        _check(cancel)
        _write_entry(folder, entry)
        return entry["id"]


def remove_entries(root: Path, ids: Iterable[str]) -> None:
    """Remove these states (their blobs go with the next clean-up)."""
    wanted = set(ids)
    folder = history_directory(root)
    if not wanted or not folder.is_dir():
        return
    with _locked(folder):
        found, _ = _read_entries(folder)
        for entry in found:
            if entry["id"] in wanted:
                entry["_file"].unlink(missing_ok=True)


def materialize(root: Path, entry_id: str, target: Path, cancel=None) -> dict:
    """Write a recorded state as a library folder at `target` (which must not exist); the entry as entries() tells it.

    Every blob is checked against its name, the database against its SHA-256 and size, and every path
    against unsafe_path: HistoryDataMissing or ValueError, leaving `target` for the caller to remove.
    """
    folder = history_directory(root)
    if not folder.is_dir():
        raise ValueError("選んだ時点の記録が見つかりません。")
    with _locked(folder):
        return _materialize(folder, entry_id, target, cancel)


def materialize_database(root: Path, entry_id: str, target: Path, cancel=None) -> None:
    """Write only the database of a recorded state to the file `target` (to compare it with the library)."""
    folder = history_directory(root)
    if not folder.is_dir():
        raise ValueError("選んだ時点の記録が見つかりません。")
    with _locked(folder):
        found, _ = _read_entries(folder)
        entry = next((item for item in found if item["id"] == entry_id), None)
        if entry is None:
            raise ValueError("選んだ時点の記録が見つかりません。")
        _write_database(folder / "blobs", entry, target, cancel)


def _write_database(blobs: Path, entry: dict, target: Path, cancel) -> None:
    digest, written = hashlib.sha256(), 0
    with target.open("wb") as output:
        for chunk in entry["db"]["chunks"]:
            for piece in _blob_chunks(blobs, blob_name(chunk, True), cancel):
                digest.update(piece)
                written += output.write(piece)
    if digest.hexdigest() != entry["db"]["sha256"] or written != entry["db"]["size"]:
        raise HistoryDataMissing("この時点のデータベースが破損しています。")


def _materialize(folder: Path, entry_id: str, target: Path, cancel) -> dict:
    found, _ = _read_entries(folder)
    entry = next((item for item in found if item["id"] == entry_id), None)
    if entry is None:
        raise ValueError("選んだ時点の記録が見つかりません。")
    target.mkdir(parents=True)
    blobs = folder / "blobs"
    for rel, (digest, size) in entry["files"].items():
        if unsafe_path(rel) or rel in DATABASE_FILES:
            raise ValueError("記録のパスが不正です。")
        path = target.joinpath(*PurePosixPath(rel).parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with path.open("wb") as output:
            for piece in _blob_chunks(blobs, blob_name(digest, compressed(rel)), cancel):
                written += output.write(piece)
        if written != size:
            raise HistoryDataMissing("この時点のデータの一部が破損しています。")
    _write_database(blobs, entry, target / "library.sqlite3", cancel)
    return _public(entry)


# --- What is kept ---

def retained(found: list[dict], recent: int, days: int, today: date) -> set[str]:
    """The IDs kept of `found` (oldest first, as _read_entries gives them).

    The newest `recent` states published or taken in; the last of each of the `days` most recent days
    before `today` with such a state, the days counted in the order they were used (a clock set back
    makes a later day look earlier, but not a later use); the newest SPECIAL_LIMIT of each other kind,
    leaving out "before_restore" states that another state kept holds already.
    """
    regular = [entry for entry in found if entry["kind"] in REGULAR]
    keep = {entry["id"] for entry in regular[max(0, len(regular) - recent):]} if recent > 0 else set()
    last_of_day: dict[str, dict] = {}
    for entry in regular:
        last_of_day[entry["day"]] = entry
    past = sorted((entry for day, entry in last_of_day.items() if day != today.isoformat()),
                  key=lambda entry: entry["seq"], reverse=True)
    keep |= {entry["id"] for entry in past[:max(0, days)]}
    for kind in KINDS:
        if kind in REGULAR:
            continue
        candidates = [item for item in found if item["kind"] == kind]
        if kind == "before_restore":
            # One holding the same library as another state kept (and read from a library on this PC) adds
            # nothing to go back to, so it takes none of the SPECIAL_LIMIT places: going back and forth between
            # past states must not push out the state the user started from.
            held = {item["hash"] for item in found if item["id"] in keep and item.get("verified", True) and item.get("hash")}
            candidates = [item for item in candidates if not (item.get("hash") and item["hash"] in held)]
        keep |= {entry["id"] for entry in candidates[-SPECIAL_LIMIT:]}
    return keep


def _today() -> date:
    return _now().astimezone().date()


def prune(root: Path, *, protect: Iterable[str] = ()) -> list[str]:
    """Remove the states the settings no longer keep (never those in `protect`), then the unused blobs.

    Returns the IDs removed. Blobs are left alone while an entry file cannot be read (it may need them).
    """
    folder = history_directory(root)
    if not folder.is_dir():
        return []
    with _locked(folder):
        found, unreadable = _read_entries(folder)
        settings = history_settings()
        keep = retained(found, settings["recent"], settings["days"], _today()) | set(protect)
        removed = []
        for entry in found:
            if entry["id"] not in keep:
                entry["_file"].unlink(missing_ok=True)
                removed.append(entry["id"])
        _collect_garbage(folder, [entry for entry in found if entry["id"] in keep] if not unreadable else None)
        return removed


def _collect_garbage(folder: Path, kept: list[dict] | None) -> None:
    """Remove the blobs no kept entry uses (none when `kept` is None), stale temporary files, and damaged
    blobs set aside more than DAMAGED_KEPT seconds ago."""
    referenced = set().union(*(_referenced(entry) for entry in kept)) if kept else set()
    stale = time.time() - STALE_TEMPORARY
    for path in list((folder / "damaged").iterdir()) if (folder / "damaged").is_dir() else []:
        try:
            if path.stat().st_mtime < time.time() - DAMAGED_KEPT:
                path.unlink()
        except OSError:
            pass
    for place in (folder / "blobs", folder / "entries"):
        try:
            paths = list(place.iterdir())
        except FileNotFoundError:
            continue
        for path in paths:
            try:
                if is_temporary(path):
                    if path.stat().st_mtime < stale:
                        path.unlink()
                elif place.name == "blobs" and kept is not None and path.name not in referenced:
                    path.unlink()
            except FileNotFoundError:
                pass


def preview_settings(root: Path, recent: int, days: int) -> list[dict]:
    """The states that other settings would remove at the next sync, newest first (for the confirmation)."""
    _validated(recent, days)
    found, _ = _read_entries(history_directory(root))
    keep = retained(found, recent, days, _today())
    return [_public(entry) for entry in reversed(found) if entry["id"] not in keep]


def usage(root: Path) -> dict:
    """How much the history of the library at `root` takes on this PC: bytes, states, blobs, and the
    entry files that cannot be read (damaged, or from a newer Papeer; while there is one, no blob is removed)."""
    folder = history_directory(root)
    total = blobs = 0
    for directory, _folders, names in os.walk(folder):
        for name in names:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except OSError:
                continue
            blobs += Path(directory).name == "blobs" and not name.startswith(".")
    found, unreadable = _read_entries(folder)
    return {"bytes": total, "entries": len(found), "blobs": blobs, "unreadable": unreadable}


# --- This PC's settings ---

def settings_path() -> Path:
    return device_directory() / "history-settings.json"


def history_settings() -> dict:
    """{"recent": N, "days": D} for this PC; a missing or malformed value is the default."""
    try:
        stored = json.loads(settings_path().read_text("utf-8"))
    except (OSError, ValueError):
        stored = {}
    stored = stored if isinstance(stored, dict) else {}
    result = {}
    for key, default in DEFAULT_SETTINGS.items():
        low, high = SETTING_RANGES[key]
        value = stored.get(key)
        result[key] = value if type(value) is int and low <= value <= high else default
    return result


def _validated(recent: int, days: int) -> None:
    for key, value, label in (("recent", recent, "直近の世代数"), ("days", days, "日ごとに残す日数")):
        low, high = SETTING_RANGES[key]
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f"{label}は{low}〜{high}で指定してください。")


def save_history_settings(recent: int, days: int) -> dict:
    """Keep `recent` states and one a day for `days` days on this PC; applied by the next sync's prune."""
    _validated(recent, days)
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, {"version": 1, "recent": recent, "days": days}, indent=None)
    return history_settings()


# --- What earlier versions left beside the library ---

def side_backup_folder(root: Path) -> Path:
    """Where earlier versions kept the libraries a choice left out, as backup ZIPs beside the library."""
    root = root.resolve()
    return root.with_name(root.name + "-sync-backups")


def _folder_size(path: Path) -> int:
    total = 0
    for directory, _folders, names in os.walk(path):  # Links are not followed.
        for name in names:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except OSError:
                continue
    return total


def _modified(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        return None


def _real_folder(path: Path) -> bool:
    """A folder itself, not a link to one (symbolic, or a Windows junction): removing through a link could
    reach what it points to."""
    return path.is_dir() and not path.is_symlink() and not path.is_junction()


def legacy_items(root: Path) -> list[dict]:
    """What earlier versions kept on this PC outside the history, newest first, with each one's size.

    "side_backup": a ZIP a choice between two libraries left out (with its description beside it);
    "before_restore": the library as it was before a restore or a sync replaced it, moved aside.
    A link (symbolic or junction) is never listed: removing it could reach what it points to.
    """
    items = []
    folder = side_backup_folder(root)
    for path in sorted(folder.glob("*.zip")) if _real_folder(folder) else []:
        try:
            if path.is_symlink() or not path.is_file():
                continue
            size = path.stat().st_size
            description = path.with_suffix(".json")
            size += description.stat().st_size if description.is_file() else 0
        except OSError:
            continue
        items.append({"kind": "side_backup", "path": str(path), "name": path.name, "size": size,
                      "modified": _modified(path)})
    resolved = root.resolve()
    prefix = resolved.name + "-before-restore-"
    try:
        siblings = list(resolved.parent.iterdir())
    except OSError:
        siblings = []
    for path in sorted(siblings):
        if not path.name.startswith(prefix) or not _real_folder(path):
            continue
        items.append({"kind": "before_restore", "path": str(path), "name": path.name, "size": _folder_size(path),
                      "modified": _modified(path)})
    items.sort(key=lambda item: item["modified"] or "", reverse=True)
    return items


def _writable_again(function, path, _error) -> None:
    """shutil.rmtree's retry for a read-only file, which Windows refuses to remove."""
    os.chmod(path, stat.S_IWRITE)
    function(path)


def remove_legacy(root: Path, paths: Iterable[str]) -> dict:
    """Remove the items of legacy_items at these paths, which the user confirmed; any other path is ignored.

    {"removed": paths removed, "failed": paths that could not be (in use, say), "items": what is left}.
    A folder that could only be removed in part stays listed with what is left of it.
    """
    listed = {item["path"]: item for item in legacy_items(root)}
    removed, failed = [], []
    for value in dict.fromkeys(paths):
        item = listed.get(value)
        if item is None:
            continue
        path = Path(item["path"])
        try:
            if item["kind"] == "side_backup":
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
            else:
                shutil.rmtree(path, onexc=_writable_again)
        except OSError:
            failed.append(value)
            continue
        removed.append(value)
    folder = side_backup_folder(root)
    try:
        if _real_folder(folder) and not any(folder.glob("*.zip")):
            for leftover in folder.glob("*.json"):  # Descriptions whose archive is gone.
                leftover.unlink(missing_ok=True)
            folder.rmdir()
    except OSError:
        pass
    return {"removed": removed, "failed": failed, "items": legacy_items(root)}


# --- Histories of libraries at other places ---

def other_histories(root: Path) -> list[dict]:
    """The histories on this PC that belong to no library at `root`: left behind when the library moved
    (the data folder changed), or those of another data folder. Newest first, each with its size.

    "library" is the path it was recorded for (None when not noted: made before that was noted), and
    "library_exists" whether a library is still there (then it is that library's own history).
    """
    base = device_directory() / "history"
    current = history_directory(root).name
    result = []
    try:
        folders = [path for path in base.iterdir() if _DIGEST.fullmatch(path.name) and path.name != current]
    except FileNotFoundError:
        return []
    for folder in folders:
        if not _real_folder(folder):
            continue
        try:
            library = json.loads((folder / "library.json").read_text("utf-8")).get("library")
        except (OSError, ValueError, AttributeError):
            library = None
        library = library if isinstance(library, str) else None
        found = _entry_files(folder)
        times = [path.stat().st_mtime for path in found if path.exists()]
        result.append({"key": folder.name, "library": library,
                       "library_exists": bool(library) and (Path(library) / "library.sqlite3").is_file(),
                       "size": _folder_size(folder), "entries": len(found),
                       "modified": datetime.fromtimestamp(max(times), timezone.utc).isoformat() if times else _modified(folder)})
    result.sort(key=lambda item: item["modified"] or "", reverse=True)
    return result


def remove_other_histories(root: Path, keys: Iterable[str]) -> dict:
    """Remove the histories of other_histories with these keys, which the user confirmed; others are ignored.

    One in use by another Papeer (its lock held) is left as it is. {"removed", "failed", "items"}.
    """
    listed = {item["key"] for item in other_histories(root)}
    base = device_directory() / "history"
    removed, failed = [], []
    for key in dict.fromkeys(keys):
        if key not in listed:
            continue
        folder = base / key
        try:
            with _locked(folder):
                for path in list(folder.iterdir()):
                    if path.name == ".lock":
                        continue
                    if path.is_dir() and not path.is_symlink() and not path.is_junction():
                        shutil.rmtree(path, onexc=_writable_again)
                    else:
                        path.unlink()
            shutil.rmtree(folder, onexc=_writable_again)
        except (OSError, HistoryBusy):
            failed.append(key)
            continue
        removed.append(key)
    return {"removed": removed, "failed": failed, "items": other_histories(root)}
