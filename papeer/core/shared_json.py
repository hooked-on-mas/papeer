"""Parsed JSON files kept in memory and shared between readers until the file changes.

document.json of a long paper takes a tenth of a second or more to parse (198 pages: 4 MB, about
0.1 s, 12 MB in memory), and the reader, search and translation read it again for every request.
A file is parsed again only when its signature (modification time, size, file id) changes: every
write of the app replaces the file (fileio.atomic_output), which gives it a new file id as well.

The value is shared, also between threads: callers read it and never modify it in place. Code
that adjusts blocks makes its own copies (materialize_flows, build_translated_pdf and the like);
copying the whole value (copy.deepcopy) would take longer than parsing it again.
"""
from __future__ import annotations

from collections import OrderedDict
import json
import os
from pathlib import Path
import threading
import time
from typing import Any

# At most this many files, whose sizes on disk add up to at most MAX_BYTES; in memory a parsed
# file takes about three times its size written without indentation. A file larger than MAX_BYTES
# by itself is read and returned, never kept.
MAX_ENTRIES = 16
MAX_BYTES = 32 * 1024**2

# Windows refuses to open a file for the moment another thread or process moves a new one over it
# (os.replace in fileio.atomic_output, which retries the other way round for the same reason). A
# replacement takes milliseconds, so a read refused so is tried again up to _READ_ATTEMPTS times,
# _READ_WAIT seconds apart (a second in all), and then fails with the last PermissionError.
_READ_ATTEMPTS = 20
_READ_WAIT = 0.05

Signature = tuple[int, int, int]

_LOCK = threading.Lock()
_ENTRIES: OrderedDict[str, tuple[Signature, Any]] = OrderedDict()


def signature(path: Path) -> Signature:
    """What changes whenever `path` is written again; raises OSError (FileNotFoundError) like a read."""
    info = os.stat(path)
    return info.st_mtime_ns, info.st_size, info.st_ino


def _read_text(path: Path) -> str:
    for _ in range(_READ_ATTEMPTS - 1):
        try:
            return Path(path).read_text("utf-8")
        except PermissionError:
            time.sleep(_READ_WAIT)
    return Path(path).read_text("utf-8")


def _key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(path))


def _store(key: str, stamp: Signature, value: Any) -> None:
    # Holding _LOCK.
    if stamp[1] > MAX_BYTES:
        _ENTRIES.pop(key, None)
        return
    _ENTRIES[key] = (stamp, value)
    _ENTRIES.move_to_end(key)
    while len(_ENTRIES) > 1 and (len(_ENTRIES) > MAX_ENTRIES
                                 or sum(entry[0][1] for entry in _ENTRIES.values()) > MAX_BYTES):
        _ENTRIES.popitem(last=False)


def read_shared_json(path: Path) -> Any:
    """The parsed content of the JSON file `path`, shared with other callers: do not modify it.

    Raises what reading and parsing the file would (OSError, ValueError).
    """
    key = _key(path)
    stamp = signature(path)
    with _LOCK:
        entry = _ENTRIES.get(key)
        if entry is not None and entry[0] == stamp:
            _ENTRIES.move_to_end(key)
            return entry[1]
    value = json.loads(_read_text(path))
    # Kept only when the file did not change while it was read; a later call reads it again anyway,
    # since its signature then differs from the one kept.
    if signature(path) == stamp:
        with _LOCK:
            _store(key, stamp, value)
    return value


def remember(path: Path, value: Any) -> None:
    """Keep `value`, just written to `path` by the caller, as its content (the caller hands it over: no more changes)."""
    try:
        stamp = signature(path)
    except OSError:
        return
    with _LOCK:
        _store(_key(path), stamp, value)


def clear() -> None:
    """Forget every file (tests)."""
    with _LOCK:
        _ENTRIES.clear()
