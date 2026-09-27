"""Device-local folder selection and exclusive library synchronization jobs."""
from contextlib import nullcontext
from pathlib import Path
import zipfile
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from papeer.core import drive_sync
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar import deps

router = APIRouter(dependencies=[Depends(deps.verify_token)])


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


@router.get("/api/drive")
def drive_status():
    return drive_sync.status(deps.get_data_dir())


@router.post("/api/drive/folder")
def select_folder(body: FolderRequest):
    require_idle()
    try:
        return drive_sync.connect(deps.get_data_dir(), body.path)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        raise HTTPException(400, str(exc)) from exc


def require_idle():
    if any(job.running for job in deps.job_manager.get_jobs()):
        raise HTTPException(409, "実行中の処理が終わってから変更してください。")


@router.delete("/api/drive")
def disconnect():
    require_idle()
    drive_sync.disconnect(deps.get_data_dir())
    return {"status": "disconnected"}


@router.delete("/api/drive/review")
def dismiss_review():
    """「同期しない」 on a sync that stopped for review: automatic sync stops until turned on again."""
    require_idle()
    return drive_sync.dismiss_review(deps.get_data_dir())


@router.post("/api/drive/new-library")
def start_new_library():
    """The data folder of a synced library is gone and the user chose to start a new, empty one."""
    require_idle()
    try:
        return drive_sync.start_new_library(deps.get_data_dir())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/api/drive")
def options(body: OptionsRequest):
    require_idle()
    root = deps.get_data_dir()
    state = drive_sync.read_state(root)
    state["auto_sync"] = body.auto_sync
    drive_sync.save_state(root, state)
    return drive_sync.status(root)


@router.get("/api/drive/side-backups")
def side_backups():
    """The libraries a choice between two left out (drive_sync.side_backups), restored through POST /api/restore."""
    return {"items": drive_sync.side_backups(deps.get_data_dir()), "limit": drive_sync.SIDE_BACKUP_LIMIT}


@router.get("/api/drive/check")
def check():
    """Whether the automatic sync has anything to do, and whether it would reload the page (drive_sync.check).

    Unlike a sync it does not hold the library, so the user's edits go on while it looks. Being an
    ordinary library request, a sync or backup waits for it to finish, and it is refused while one runs.
    """
    root = deps.get_data_dir()
    state = drive_sync.read_state(root)
    if not state.get("connected") or not state.get("folder"):
        return {"action": "none", "local_version": None}
    try:
        return drive_sync.check(root, drive_sync.FolderDrive(Path(state["folder"])))
    except Exception:
        # A missing folder, revisions still arriving, an unreadable file...: the sync itself reports it
        # (and automatic sync stops until the user has looked), so leave the explaining to it.
        return {"action": "quiet", "local_version": None}


@router.post("/api/drive/sync")
def sync(body: SyncRequest):
    root = deps.get_data_dir()
    def action(cancel, progress, _):
        # Before waiting for the admitted requests: the PDFs and images being shown may keep loading
        # throughout, and the background sync does not wait for those reads (deps.SIDE_READ).
        with deps.background_sync() if body.background else nullcontext():
            return run(cancel, progress)

    def run(cancel, progress):
        try:
            deps.wait_for_library_requests(side_reads=not body.background, cancel=cancel)
            state = drive_sync.read_state(root)
            if not state.get("connected") or not state.get("folder"):
                raise ValueError("同期フォルダーを指定してください。")
            return drive_sync.sync(Library(root), drive_sync.FolderDrive(Path(state["folder"])), cancel, progress,
                                   choice=body.choice, expected_heads=body.expected_heads, confirm=body.confirm,
                                   background=body.background)
        except Cancelled:
            # Stopping is not a failure: no error is recorded, so automatic sync resumes next time.
            raise Cancelled("同期を中止しました。") from None
        except Exception as exc:
            message = str(exc) if isinstance(exc, ValueError) else "同期フォルダーを読み書きできませんでした。保存先とPC版Google Driveを確認して再試行してください。"
            state = drive_sync.read_state(root)
            state["error"] = message
            drive_sync.save_state(root, state)
            raise ValueError(message) from None
    return deps.submit_job("drive-sync", action)
