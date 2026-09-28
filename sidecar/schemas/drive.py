"""Request models of the sync folder and its jobs (sidecar/routes/drive.py)."""
from __future__ import annotations

from pydantic import BaseModel


class FolderRequest(BaseModel):
    path: str


class SyncRequest(BaseModel):
    choice: str | None = None
    expected_heads: list[str] | None = None
    # 「このまま同期する」 after a sync stopped for review (a library that shrank a lot, or was restored).
    confirm: bool = False
    # The automatic sync without the waiting screen: never takes in another PC's library (see drive_sync.sync).
    background: bool = False


class OptionsRequest(BaseModel):
    auto_sync: bool
