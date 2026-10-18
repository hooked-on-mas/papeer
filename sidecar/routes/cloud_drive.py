"""Direct Google Drive upload, separate from the existing two-way folder sync."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from papeer.core import cloud_drive, cloud_drive_auth
from sidecar import deps
from sidecar.job_types import JobKind, JobStarted

router = APIRouter(dependencies=[Depends(deps.verify_token)])


class ConnectRequest(BaseModel):
    client_id: str
    client_secret: str


class OptionsRequest(BaseModel):
    auto_upload: bool


class UploadRequest(BaseModel):
    force: bool = True


@router.get("/api/cloud-drive")
def status():
    return cloud_drive.status(deps.get_data_dir())


@router.post("/api/cloud-drive/connect")
def connect(body: ConnectRequest):
    with deps.job_manager.idle("処理が終わってから接続してください。"):
        # Switching Google accounts must not reuse file IDs or the old upload baseline.
        root = deps.get_data_dir()
        result = cloud_drive_auth.connect(body.client_id.strip(), body.client_secret.strip())
        cloud_drive.save_state(root, {"auto_upload": True})
        return result


@router.delete("/api/cloud-drive")
def disconnect():
    with deps.job_manager.idle("処理が終わってから接続を解除してください。"):
        cloud_drive_auth.disconnect()
        cloud_drive.save_state(deps.get_data_dir(), {})
    return {"connected": False}


@router.put("/api/cloud-drive")
def options(body: OptionsRequest):
    with deps.job_manager.idle("処理が終わってから変更してください。"):
        root = deps.get_data_dir()
        cloud_drive.save_state(root, cloud_drive.state(root) | {"auto_upload": body.auto_upload})
    return cloud_drive.status(root)


@router.post("/api/cloud-drive/upload")
def upload(body: UploadRequest) -> JobStarted:
    lib = deps.get_library()

    def action(cancel, progress, _):
        deps.wait_for_library_requests(cancel=cancel)
        return cloud_drive.publish(lib, cancel, progress, force=body.force)

    return deps.submit_job(JobKind.CLOUD_UPLOAD, action)
