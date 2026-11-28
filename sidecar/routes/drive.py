"""Restore existing local history and manage older backups; folder synchronization is retired."""
from fastapi import APIRouter, Depends
from papeer.core import drive_sync, history_restore, local_history
from sidecar import deps
from sidecar.lifecycle.job_types import JobStarted
from sidecar.routes.reading import start_restore
from sidecar.schemas.drive import (HistoryRestoreRequest, HistorySettingsRequest, LegacyRemoveRequest,
                                  OtherHistoriesRemoveRequest)

router = APIRouter(dependencies=[Depends(deps.verify_token)])


def idle():
    return deps.job_manager.idle("実行中の処理が終わってから変更してください。")


@router.get("/api/drive/side-backups")
def side_backups():
    """The ZIPs earlier versions kept of what a choice between two left out (drive_sync.side_backups),
    restored through POST /api/restore. A choice now keeps them in this PC's history (GET /api/history)."""
    return {"items": drive_sync.side_backups(deps.get_data_dir()), "limit": drive_sync.SIDE_BACKUP_LIMIT}


@router.get("/api/history")
def history():
    """This PC's history of the library (local_history): the states kept, newest first, what they take and the settings."""
    root = deps.get_data_dir()
    return {"entries": local_history.entries(root), "usage": local_history.usage(root),
            "settings": local_history.history_settings(), "ranges": local_history.SETTING_RANGES,
            "special_limit": local_history.SPECIAL_LIMIT}


@router.get("/api/history/preview")
def history_preview(recent: int, days: int):
    """The states other settings would remove at the next sync, for the confirmation before saving them."""
    return {"removed": local_history.preview_settings(deps.get_data_dir(), recent, days)}


@router.put("/api/history/settings")
def history_settings(body: HistorySettingsRequest):
    """This PC's settings (not synced); the next sync removes what they no longer keep."""
    with idle():
        return local_history.save_history_settings(body.recent, body.days)


@router.get("/api/history/{entry_id}/difference")
def history_difference(entry_id: str):
    """What differs between the library and a state of the history, shown before going back to it."""
    lib = deps.get_library()
    return history_restore.difference(lib, entry_id)


@router.post("/api/history/restore")
def history_restore_job(body: HistoryRestoreRequest) -> JobStarted:
    """Go back to a state of this PC's history; the library as it was is recorded as "before_restore"."""
    lib = deps.get_library()
    return start_restore(lib, "履歴から戻せませんでした",
                         lambda cancel, progress: history_restore.restore_entry(
                             lib, body.entry_id, cancel, progress, import_settings=body.import_settings))


@router.get("/api/history/others")
def other_histories():
    """This PC's histories of libraries at other places (the data folder moved), with their sizes."""
    items = local_history.other_histories(deps.get_data_dir())
    return {"items": items, "size": sum(item["size"] for item in items)}


@router.post("/api/history/others/remove")
def remove_other_histories(body: OtherHistoriesRemoveRequest):
    """Remove the histories the user confirmed (their keys as GET /api/history/others gave them)."""
    with idle():
        return local_history.remove_other_histories(deps.get_data_dir(), body.keys)


@router.get("/api/history/legacy")
def legacy():
    """What earlier versions left beside the library (set-aside ZIPs, folders moved aside), with their sizes."""
    items = local_history.legacy_items(deps.get_data_dir())
    return {"items": items, "size": sum(item["size"] for item in items)}


@router.post("/api/history/legacy/remove")
def remove_legacy(body: LegacyRemoveRequest):
    """Remove the items the user confirmed (their paths as GET /api/history/legacy gave them); others are ignored."""
    root = deps.get_data_dir()
    with idle():
        result = local_history.remove_legacy(root, body.paths)
        drive_sync.forget_previous_path(root, result["removed"])
    return result
