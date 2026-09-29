"""Where the library and this PC's files go on each platform (papeer/core/paths.py)."""
from __future__ import annotations

from pathlib import Path
import sys

import pytest

from papeer.core import paths


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A home folder of our own, whichever platform the test plays (Path.home reads USERPROFILE on Windows)."""
    folder = tmp_path / "home"
    monkeypatch.setenv("HOME", str(folder))
    monkeypatch.setenv("USERPROFILE", str(folder))
    monkeypatch.delenv("PAPEER_DATA_DIR", raising=False)
    monkeypatch.delenv("PAPERDESK_DATA_DIR", raising=False)
    for name in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local-appdata"))
    return folder


def places() -> tuple[Path, Path, Path, Path]:
    return paths.data_directory(), paths.device_directory(), paths.cache_directory(), paths.log_directory()


def test_windows_keeps_its_folders_under_local_appdata(home, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    local = tmp_path / "local-appdata"
    assert places() == (local / "Papeer", local / "PapeerSync", local / "PapeerSync", local / "PapeerSync" / "logs")


def test_windows_without_local_appdata_uses_the_usual_one(home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("LOCALAPPDATA")
    assert paths.default_data_directory() == home / "AppData" / "Local" / "Papeer"


def test_macos_uses_application_support_caches_and_logs(home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    library = home / "Library"
    assert places() == (library / "Application Support" / "Papeer", library / "Application Support" / "PapeerSync",
                        library / "Caches" / "Papeer", library / "Logs" / "Papeer")


def test_linux_follows_the_xdg_base_folders(home, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert places() == (home / ".local/share/papeer", home / ".local/state/papeer", home / ".cache/papeer",
                        home / ".local/state/papeer/logs")
    for name in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        monkeypatch.setenv(name, str(tmp_path / name))
    assert places() == (tmp_path / "XDG_DATA_HOME" / "papeer", tmp_path / "XDG_STATE_HOME" / "papeer",
                        tmp_path / "XDG_CACHE_HOME" / "papeer", tmp_path / "XDG_STATE_HOME" / "papeer" / "logs")


@pytest.mark.parametrize("value", ["relative/data", ""])
def test_linux_ignores_an_xdg_folder_that_is_not_absolute(home, monkeypatch, value):
    # The XDG Base Directory specification: a relative path is invalid and must be ignored.
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", value)
    monkeypatch.setenv("XDG_STATE_HOME", value)
    assert paths.data_directory() == home / ".local/share/papeer"
    assert paths.device_directory() == home / ".local/state/papeer"


def test_other_posix_systems_are_treated_as_linux(home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "freebsd14")
    assert paths.data_directory() == home / ".local/share/papeer"


@pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
def test_papeer_data_dir_moves_only_the_library(home, tmp_path, monkeypatch, platform):
    monkeypatch.setattr(sys, "platform", platform)
    device = paths.device_directory()
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "elsewhere"))
    assert paths.data_directory() == (tmp_path / "elsewhere").resolve()
    assert paths.device_directory() == device


@pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
def test_a_paperdesk_folder_is_never_used(home, tmp_path, monkeypatch, platform):
    # Earlier versions used %LOCALAPPDATA%\\PaperDesk on Windows; its library is expected to have been moved.
    monkeypatch.setattr(sys, "platform", platform)
    (tmp_path / "local-appdata" / "PaperDesk" / "papers" / "a").mkdir(parents=True)
    (home / ".local/share/PaperDesk/papers/a").mkdir(parents=True)
    assert paths.data_directory() == paths.default_data_directory()


def test_the_files_kept_for_a_library_are_named_by_its_path(tmp_path):
    root = tmp_path / "library"
    key = paths.library_key(root)
    assert len(key) == 64 and key == paths.library_key(tmp_path / "x" / ".." / "library")
    assert paths.sync_state_path(root).name == key + ".json"
    assert paths.history_directory(root) == paths.device_directory() / "history" / key
    assert paths.library_key(tmp_path / "other") != key
