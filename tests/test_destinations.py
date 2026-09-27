r"""Saving a copy inside the library is refused however the path to it is written (see destinations.py)."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import subprocess
import sys

import pytest

from papeer.core.destinations import inside_library

WINDOWS = sys.platform == "win32"
BS = "\\"


@pytest.fixture
def library(tmp_path) -> Path:
    root = tmp_path / "LibraryRootLongName"
    (root / "papers" / ("a" * 32)).mkdir(parents=True)
    (root / "library.sqlite3").write_bytes(b"db")
    return root


def test_plain_paths(library, tmp_path):
    assert inside_library(library, library)
    assert inside_library(library / "library.sqlite3", library)
    assert inside_library(library / "papers" / "new" / "x.pdf", library)
    assert inside_library(tmp_path / "Outside" / ".." / library.name / "x.pdf", library)
    assert not inside_library(tmp_path / "Outside" / "x.pdf", library)
    assert not inside_library(Path(str(library) + "2") / "x.pdf", library)
    assert not inside_library(tmp_path, library)
    # A library that cannot be looked at (a missing synced folder) is still compared by its path.
    gone = tmp_path / "gone"
    assert inside_library(gone / "x.pdf", gone)
    assert inside_library(Path(str(gone).upper()) / "x.pdf", gone) == (sys.platform == "win32")
    assert not inside_library(tmp_path / "Outside" / "x.pdf", gone)


def test_a_library_that_cannot_be_read_is_still_compared_by_its_path(library, monkeypatch):
    import papeer.core.destinations as destinations

    def unreadable(path, *args, **kwargs):
        raise PermissionError(path)

    monkeypatch.setattr(destinations.os, "stat", unreadable)
    assert inside_library(library / "new.pdf", library)
    assert not inside_library(library.parent / "Outside" / "x.pdf", library)


def test_the_desktop_is_allowed(library):
    assert not inside_library(Path.home() / "Desktop" / "export.pdf", library)


@pytest.mark.skipif(not WINDOWS, reason="Windows path forms")
def test_windows_spellings_of_the_library(library):
    text = str(library)
    assert inside_library(Path(text.upper()) / "NEW.PDF", library)
    assert inside_library(Path(text.replace(BS, "/") + "/papers/x.pdf"), library)
    # The long-path prefix, and a trailing space or dot that Windows drops from the folder name.
    assert inside_library(Path(BS * 2 + "?" + BS + text) / "library.sqlite3", library)
    assert inside_library(Path(BS * 2 + "?" + BS + text) / "new" / "x.pdf", library)
    assert inside_library(Path(text + " ") / "x.pdf", library)
    assert inside_library(Path(text + ".") / "x.pdf", library)


@pytest.mark.skipif(not WINDOWS, reason="Windows admin shares")
def test_admin_share_of_the_library(library):
    share = BS * 2 + "127.0.0.1" + BS + str(library)[0] + "$" + str(library)[2:]
    if not os.path.isdir(share):
        pytest.skip("administrative share not reachable")
    assert inside_library(Path(share) / "new.pdf", library)
    assert inside_library(Path(share) / "newdir" / "new.pdf", library)


@pytest.mark.skipif(not WINDOWS, reason="Windows junctions and 8.3 names")
def test_junction_and_short_name(library, tmp_path):
    junction = tmp_path / "J"
    subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(library)], capture_output=True, check=False)
    if junction.exists():
        assert inside_library(junction / "papers" / "new.pdf", library)
        assert inside_library(junction / "newdir" / "new.pdf", library)
    buffer = ctypes.create_unicode_buffer(500)
    ctypes.windll.kernel32.GetShortPathNameW(str(library), buffer, 500)  # type: ignore[attr-defined]
    if buffer.value and Path(buffer.value).name != library.name:
        assert inside_library(Path(buffer.value) / "newdir" / "new.pdf", library)
