"""Device-local folder selection and exclusive library synchronization jobs."""
from contextlib import nullcontext
from fastapi import APIRouter, Depends

from papeer.core import drive_sync
from papeer.providers import Cancelled
from sidecar import deps
from sidecar.job_types import JobKind, JobStarted
from sidecar.schemas.drive import FolderRequest, OptionsRequest, SyncRequest

router = APIRouter(dependencies=[Depends(deps.verify_token)])


@router.get("/api/drive")
def drive_status():
    return drive_sync.status(deps.get_data_dir())


def idle():
    """No job may run while the sync settings change (JobManager.idle)."""
    return deps.job_manager.idle("実行中の処理が終わってから変更してください。")


@router.post("/api/drive/folder")
def select_folder(body: FolderRequest):
    with idle():
        return drive_sync.connect(deps.get_data_dir(), body.path)


@router.delete("/api/drive")
def disconnect():
    with idle():
        drive_sync.disconnect(deps.get_data_dir())
    return {"status": "disconnected"}


@router.delete("/api/drive/review")
def dismiss_review():
    """「同期しない」 on a sync that stopped for review: automatic sync stops until turned on again."""
    with idle():
        return drive_sync.dismiss_review(deps.get_data_dir())


@router.post("/api/drive/new-library")
def start_new_library():
    """The data folder of a synced library is gone and the user chose to start a new, empty one."""
    with idle():
        return drive_sync.start_new_library(deps.get_data_dir())


@router.put("/api/drive")
def options(body: OptionsRequest):
    with idle():
        return drive_sync.set_auto_sync(deps.get_data_dir(), body.auto_sync)


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
    return drive_sync.check_connected(deps.get_data_dir())


@router.post("/api/drive/sync")
def sync(body: SyncRequest) -> JobStarted:
    root = deps.get_data_dir()
    def action(cancel, progress, _):
        # Before waiting for the admitted requests: the PDFs and images being shown may keep loading
        # throughout, and the background sync does not wait for those reads (deps.SIDE_READ).
        with deps.background_sync() if body.background else nullcontext():
            return run(cancel, progress)

    def run(cancel, progress):
        try:
            deps.wait_for_library_requests(side_reads=not body.background, cancel=cancel)
        except Cancelled:
            # Stopping is not a failure: no error is recorded, so automatic sync resumes next time.
            raise Cancelled(drive_sync.SYNC_CANCELLED) from None
        return drive_sync.sync_connected(root, cancel, progress, choice=body.choice, expected_heads=body.expected_heads,
                                         confirm=body.confirm, background=body.background)
    return deps.submit_job(JobKind.DRIVE_SYNC, action)
