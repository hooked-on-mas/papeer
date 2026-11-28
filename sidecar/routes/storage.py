"""The local library's storage location; independent of Google Drive uploads."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from papeer.core import storage_location
from sidecar import deps

router = APIRouter(dependencies=[Depends(deps.verify_token)])


class StorageRequest(BaseModel):
    path: str


class StorageStatus(BaseModel):
    path: str
    pending_path: str | None
    error: str | None
    overridden: bool
    missing: bool


@router.get("/api/storage", response_model=StorageStatus)
def status():
    return storage_location.status(deps.get_data_dir())


@router.put("/api/storage", response_model=StorageStatus)
def select(body: StorageRequest):
    with deps.job_manager.idle("実行中の処理が終わってから保存先を変更してください。"):
        lib = deps.get_library()
        return storage_location.schedule(lib.root, body.path)


@router.delete("/api/storage/pending", response_model=StorageStatus)
def cancel():
    with deps.job_manager.idle("実行中の処理が終わってから変更してください。"):
        return storage_location.cancel(deps.get_data_dir())
