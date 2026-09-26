"""Health, shutdown, remembered UI state and the job list."""
from __future__ import annotations

import asyncio
import os
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from papeer.core.code_version import application_version
from sidecar import deps
from sidecar.schemas import HealthResponse, UIStateModel
from sidecar.ui_state import load_ui_state, save_ui_state

public = APIRouter()
router = APIRouter(dependencies=[Depends(deps.verify_token)])


@public.get("/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    version = application_version()
    return {"status": "ok", "version": version, "code_version": version}


@router.post("/shutdown")
def shutdown() -> dict[str, str]:
    def stop():
        asyncio.run(asyncio.sleep(0.5))
        os._exit(0)

    threading.Thread(target=stop, daemon=True).start()
    return {"status": "shutting down"}


@router.get("/api/ui-state", response_model=UIStateModel)
def get_ui_state() -> dict[str, Any]:
    return load_ui_state(deps.get_data_dir())


@router.put("/api/ui-state")
def put_ui_state(body: UIStateModel) -> dict[str, str]:
    save_ui_state(deps.get_data_dir(), body.model_dump())
    return {"status": "saved"}


@router.get("/api/jobs")
def get_jobs() -> list[dict[str, Any]]:
    return [job.model_dump() for job in deps.job_manager.get_jobs()]


@router.post("/api/jobs/cancel-all")
def cancel_all_jobs() -> dict[str, int]:
    manager = deps.job_manager
    return {"cancelled": sum(manager.cancel_job(job.job_id) for job in manager.get_jobs() if job.running)}


@router.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, str]:
    if not deps.job_manager.cancel_job(job_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="実行中のジョブが見つかりません。")
    return {"status": "cancelling"}
