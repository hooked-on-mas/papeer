"""The test suite never reads or writes the user's real Papeer folders (see conftest.py)."""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import sqlite3

import pytest

from _isolation import REAL_LIBRARY, RealDataAccessError, is_under, path_forms, take_violations
from papeer.core.config import device_settings_path
from papeer.core.drive_sync import state_path
from papeer.core.paths import data_directory

# Below the real library but never existing: if the guard ever broke, these calls stop at
# FileNotFoundError (or sqlite's "unable to open") instead of changing real data.
PROBE = REAL_LIBRARY / "__papeer_guard_probe__"


def test_data_folders_point_at_the_test_folder(isolated_app_data):
    assert data_directory() == (isolated_app_data / "Papeer").resolve()
    assert state_path(Path("library")).is_relative_to(isolated_app_data)
    assert device_settings_path().is_relative_to(isolated_app_data)
    assert not data_directory().is_relative_to(REAL_LIBRARY)


def test_each_test_gets_a_fresh_data_folder(isolated_app_data):
    assert not (isolated_app_data / "Papeer").exists()


@pytest.mark.parametrize("touch", [
    lambda: open(PROBE / "prompts" / "translation.txt", encoding="utf-8"),
    lambda: (PROBE / "settings.json").write_text("{}", "utf-8"),
    lambda: list(PROBE.iterdir()),
    lambda: (PROBE / "new-folder").mkdir(),
    lambda: sqlite3.connect(PROBE / "library.sqlite3"),
], ids=["read", "write", "list", "mkdir", "sqlite"])
def test_real_library_access_is_refused(touch):
    with pytest.raises(RealDataAccessError):
        touch()
    assert len(take_violations()) == 1


@pytest.mark.skipif(os.name != "nt", reason="8.3 short names exist only on Windows")
def test_short_names_are_resolved_before_comparing(tmp_path):
    folder = tmp_path / "LongFolderNameForGuard"
    folder.mkdir()
    buffer = ctypes.create_unicode_buffer(1024)
    ctypes.windll.kernel32.GetShortPathNameW(str(folder), buffer, len(buffer))  # type: ignore[attr-defined]
    if not buffer.value or os.path.normcase(buffer.value) == os.path.normcase(str(folder)):
        pytest.skip("8.3 short names are disabled on this volume")
    roots = tuple(path_forms(folder))
    assert is_under(Path(buffer.value) / "settings.json", roots)
    assert not is_under(tmp_path / "LongFolderNameForGuard2" / "settings.json", roots)


def test_swallowed_access_still_fails_the_test(pytester, tmp_path, monkeypatch):
    # A separate pytest run whose "real" LOCALAPPDATA is a folder we own.
    here = Path(__file__).parent
    pytester.makeconftest((here / "conftest.py").read_text("utf-8"))
    pytester.makepyfile(_isolation=(here / "_isolation.py").read_text("utf-8"))
    fake_real = tmp_path / "fake-real-appdata"
    (fake_real / "Papeer").mkdir(parents=True)
    note = fake_real / "Papeer" / "note.md"
    note.write_text("real", "utf-8")
    pytester.makepyfile(test_inner=f"""
from pathlib import Path

NOTE = Path({str(note)!r})

try:
    NOTE.read_text("utf-8")  # swallowed at import time
except Exception:
    pass


def test_import_time_access_is_blamed():
    pass


def test_swallowed():
    try:
        NOTE.write_text("overwritten", "utf-8")
    except Exception:
        pass


def test_clean():
    pass
""")
    monkeypatch.setenv("LOCALAPPDATA", str(fake_real))
    monkeypatch.delenv("PAPEER_DATA_DIR")
    monkeypatch.setenv("PYTHONUTF8", "1")  # the Japanese messages come back through a pipe
    result = pytester.runpytest_subprocess("-p", "no:cacheprovider")
    # Setup error for the import-time access; teardown error (after a passing body) for the swallowed one.
    result.assert_outcomes(passed=2, errors=2)
    result.stdout.fnmatch_lines(["*テスト開始前に実データへのアクセスがありました*",
                                 "*テストが実データに触れました: open*note.md*"])
    assert note.read_text("utf-8") == "real"
