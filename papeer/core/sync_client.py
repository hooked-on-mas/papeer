"""The program that carries the sync folder between PCs, as the messages of the sync name it.

Google Drive for desktop (PC版Google Drive) on Windows and macOS. Linux has no official client: there the
folder is one that the user's own sync software keeps in step (Syncthing, Dropbox, rclone bisync…;
docs/google-drive-sync.md), and the messages name that. The frontend words it the same way
(frontend/src/lib/platform.ts syncClientNames).
"""
from __future__ import annotations

import sys

SYNC_CLIENT = "同期ソフト" if sys.platform.startswith("linux") else "PC版Google Drive"

# macOS asks the user before an app reads a folder another app provides (Google Drive's under
# ~/Library/CloudStorage) or Documents, Desktop and Downloads. Refused, reading fails with EPERM.
MAC_PERMISSION_HINT = ("macOS の「システム設定」→「プライバシーとセキュリティ」→「ファイルとフォルダ」で、"
                       "Papeer がこのフォルダーを使えるように許可されているかも確認してください。")


def permission_hint(exc: BaseException) -> str:
    """What to add to a message about a sync folder that could not be read or written: on macOS, where to
    allow Papeer when the system refused it (PermissionError); nothing otherwise."""
    return MAC_PERMISSION_HINT if sys.platform == "darwin" and isinstance(exc, PermissionError) else ""
