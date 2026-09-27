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
