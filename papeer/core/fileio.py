"""Crash-safe file writes: a reader sees either the old file or the complete new one, never a torn mix.

Every write goes to a uniquely named temporary file beside the target (so concurrent writers never
share one), is flushed to disk with os.fsync, and then moves over the target with os.replace.
Text is written as given: "\\n" stays LF on every OS, so synced files are identical across devices.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

_REPLACE_ATTEMPTS = 50
_REPLACE_WAIT = 0.1
_TEMPORARY_PREFIX, _TEMPORARY_SUFFIX = ".", ".tmp"


def is_temporary(path: Path) -> bool:
    """A leftover of atomic_output (".<name>.<random>.tmp") that a crash or forced exit left behind.

    Snapshots of the library (sync fingerprint, backup ZIP) skip these so they never spread to other devices.
    """
    name = Path(path).name
    return name.startswith(_TEMPORARY_PREFIX) and name.endswith(_TEMPORARY_SUFFIX)


def replace_file(source: Path, target: Path) -> None:
    """Flush `source` to disk and move it over `target`.

    Windows refuses the move while another process briefly holds the target open
    (virus scan, indexing, a PDF viewer), so a PermissionError is retried for a few seconds.
    macOS and Linux replace an open file without complaint; a PermissionError there is a real one,
    raised after the same few seconds.

    On macOS os.fsync hands the data to the drive but does not make it flush its own cache
    (fcntl F_FULLFSYNC would, at some tens of milliseconds per file). As SQLite does by default for the
    library's database, it is not used: a power cut at the wrong moment may lose the newest writes, the
    same risk the database takes. A crash of the app or the system (the drive keeps power) loses nothing.
    """
    with open(source, "rb+") as stream:  # Windows can only flush a handle opened for writing.
        os.fsync(stream.fileno())
    for _ in range(_REPLACE_ATTEMPTS - 1):
        try:
            os.replace(source, target)
            break
        except PermissionError:
            time.sleep(_REPLACE_WAIT)
    else:
        os.replace(source, target)
    _sync_directory(Path(target).parent)


def move_file(source: Path, target: Path) -> None:
    """Move `source`, already flushed to disk by its writer, over `target`, retrying while Windows refuses it
    (see replace_file). The folder is not flushed: the caller does it once for many (sync_directory)."""
    for _ in range(_REPLACE_ATTEMPTS - 1):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            time.sleep(_REPLACE_WAIT)
    os.replace(source, target)


def sync_directory(directory: Path) -> None:
    """Flush the renames made in `directory` to disk (POSIX; nothing to do on Windows)."""
    _sync_directory(Path(directory))


def _sync_directory(directory: Path) -> None:
    # POSIX needs the directory flushed for the rename itself to survive a crash;
    # Windows cannot open a directory this way and NTFS journals the rename.
    if os.name == "nt":
        return
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


@contextmanager
def atomic_output(path: Path) -> Iterator[Path]:
    """A temporary file to write in place of `path`, for writers that want a file name (PyMuPDF, zipfile).

    When the block finishes, the temporary file replaces `path`; if it raises, `path` is untouched.
    The parent folder must already exist: creating it here could revive a deleted paper's folder.
    """
    path = Path(path)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f"{_TEMPORARY_PREFIX}{path.name}.",
                                        suffix=_TEMPORARY_SUFFIX)
    os.close(descriptor)
    temporary = Path(name)
    try:
        yield temporary
        replace_file(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    with atomic_output(path) as temporary, open(temporary, "wb") as stream:
        stream.write(data)


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, text.encode(encoding))


def atomic_write_json(path: Path, value: object, *, indent: int | None = 2) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=indent))


# --- Free space ---
#
# A library copy (backup, sync revision, restore) is as large as the library itself, often gigabytes.
# Running out of space halfway leaves nothing broken (atomic_output discards the partial file), but only
# after minutes of copying, so the writers ask first.

# Room left over on top of the estimate: the system and other programs keep writing while the copy runs,
# and a drive filled to the last byte fails in ways that are hard to read.
SPACE_MARGIN = 256 * 1024**2


class InsufficientSpaceError(ValueError):
    """Not enough free space for a copy of the library; the message names the drive and the sizes."""


def _size_text(size: int) -> str:
    return f"{size / 1024**3:.1f} GB" if size >= 1024**3 else f"{max(1, round(size / 1024**2))} MB"


def ensure_free_space(needs: dict[Path, int]) -> None:
    """Raise InsufficientSpaceError unless every drive has room for what is about to be written to it.

    `needs` maps a place (a file or folder, which need not exist yet) to the bytes that will be written
    there; places on the same drive add up. A drive whose free space cannot be read is not checked.
    """
    drives: dict[int, list] = {}
    for place, size in needs.items():
        existing = Path(place)
        while not existing.exists() and existing.parent != existing:
            existing = existing.parent
        try:
            device = existing.stat().st_dev
        except OSError:
            continue
        drives.setdefault(device, [existing, 0])[1] += size
    for existing, size in drives.values():
        try:
            free = shutil.disk_usage(existing).free
        except OSError:
            continue
        if free < size + SPACE_MARGIN:
            raise InsufficientSpaceError(
                f"空き容量が足りません。{existing.anchor or existing} に約{_size_text(size + SPACE_MARGIN)}の空きが必要です"
                f"（現在の空き：{_size_text(free)}）。不要なファイルを削除してから、もう一度お試しください。")
