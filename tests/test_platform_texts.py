"""Texts that name what this OS has: the sync's client, macOS's folder permission, a CLI's path."""
from __future__ import annotations

import importlib
import sys

import pytest

from papeer.core import sync_client
from papeer.core.storage import Library
from papeer.providers import common


@pytest.mark.parametrize(("platform", "client"), [("win32", "PC版Google Drive"), ("darwin", "PC版Google Drive"),
                                                  ("linux", "同期ソフト")])
def test_the_sync_names_google_drive_where_it_has_a_client(monkeypatch, platform, client):
    monkeypatch.setattr(sys, "platform", platform)
    try:
        assert importlib.reload(sync_client).SYNC_CLIENT == client
    finally:
        monkeypatch.undo()
        importlib.reload(sync_client)


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_a_refused_folder_points_to_macos_privacy_settings_on_macos_only(monkeypatch, platform):
    refused = PermissionError(1, "Operation not permitted")
    assert "プライバシーとセキュリティ" in _hint("darwin", refused, monkeypatch)
    assert _hint("darwin", OSError(5, "Input/output error"), monkeypatch) == ""
    assert _hint(platform, refused, monkeypatch) == ""


def _hint(platform: str, exc: BaseException, monkeypatch) -> str:
    monkeypatch.setattr(sys, "platform", platform)
    return sync_client.permission_hint(exc)


def test_a_cli_path_hint_names_what_this_os_finds(monkeypatch):
    monkeypatch.setattr(common, "_windows", lambda: True)
    assert common.cli_path_hint("claude.cmd", "~/.local/bin/claude") == "空欄なら自動検出（claude.cmd など）"
    monkeypatch.setattr(common, "_windows", lambda: False)
    assert common.cli_path_hint("claude.cmd", "~/.local/bin/claude") == "空欄なら自動検出（~/.local/bin/claude など）"


def test_a_file_name_any_pc_cannot_use_is_refused_with_the_rules(tmp_path):
    lib = Library(tmp_path / "lib")
    with pytest.raises(ValueError, match="どのPCでも使えるファイル名") as refused:
        lib.rename_paper("0" * 32, "a:b")
    assert "Windows" not in str(refused.value)
