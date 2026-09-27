"""Device-local folder selection and exclusive library synchronization jobs."""
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


@router.put("/api/drive")
def options(body: OptionsRequest):
    require_idle()
    root = deps.get_data_dir()
    state = drive_sync.read_state(root)
    state["auto_sync"] = body.auto_sync
    drive_sync.save_state(root, state)
    return drive_sync.status(root)


@router.post("/api/drive/sync")
def sync(body: SyncRequest):
    root = deps.get_data_dir()
    def action(cancel, progress, _):
        deps.wait_for_library_requests()
        try:
            state = drive_sync.read_state(root)
            if not state.get("connected") or not state.get("folder"):
                raise ValueError("同期フォルダーを指定してください。")
            return drive_sync.sync(Library(root), drive_sync.FolderDrive(Path(state["folder"])), cancel, progress,
                                   choice=body.choice, expected_heads=body.expected_heads)
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
