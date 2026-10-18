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


class DriveLegacyRemoveRequest(BaseModel):
    # IDs of the first format's revisions as GET /api/drive/format listed them ("removable"), confirmed by the user.
    ids: list[str]


class OptionsRequest(BaseModel):
    auto_sync: bool


class HistorySettingsRequest(BaseModel):
    # How many of the newest states to keep, and for how many days Papeer was used the last state of each.
    recent: int
    days: int


class LegacyRemoveRequest(BaseModel):
    # Paths as GET /api/history/legacy listed them, confirmed by the user.
    paths: list[str]


class HistoryRestoreRequest(BaseModel):
    entry_id: str
    # As for a backup: take the settings and prompts of that state too, or keep the current ones.
    import_settings: bool = False


class OtherHistoriesRemoveRequest(BaseModel):
    # Keys as GET /api/history/others listed them, confirmed by the user.
    keys: list[str]
