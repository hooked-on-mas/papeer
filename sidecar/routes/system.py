"""Health, shutdown, remembered UI state and the job list."""
from __future__ import annotations

import os
import threading
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from papeer import __version__
from papeer.core.code_version import application_version
from sidecar import deps
from sidecar.schemas import HealthResponse, UIStateModel
from sidecar.ui_state import load_ui_state, save_ui_state

public = APIRouter()
router = APIRouter(dependencies=[Depends(deps.verify_token)])


@public.get("/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    # version: the app release (MAJOR.MINOR.PATCH, `just bump`); code_version: the translation code identity
    # that keys the translation cache (code-version.txt in a build), which changes without a release.
    return {"status": "ok", "version": __version__, "code_version": application_version()}


# How long /shutdown lets cancelled jobs wind down (CLI subprocesses stopped, files closed) and
# in-flight requests finish before the process exits anyway. Tauri waits longer than this for
# the process to end before it kills it (SIDECAR_EXIT_TIMEOUT in src-tauri/src/lib.rs).
SHUTDOWN_JOB_TIMEOUT = 20.0
SHUTDOWN_REQUEST_TIMEOUT = 5.0


def exit_process() -> None:
    # A normal exit of this (child) process lets PyInstaller's bootloader delete its %TEMP%\_MEI* folder.
    os._exit(0)


@router.post("/shutdown")
def shutdown() -> dict[str, Any]:
    """Stop every job, wait for them (bounded), answer, then exit.

    The caller waits for this response, so by the time it arrives nothing is writing any more;
    new jobs are refused from the first moment.
    """
    manager = deps.job_manager
    cancelled = manager.close()
    jobs_stopped = manager.wait_idle(SHUTDOWN_JOB_TIMEOUT)
    requests_finished = deps.wait_for_library_requests(SHUTDOWN_REQUEST_TIMEOUT)

    exit_now = exit_process  # looked up now, so a test's replacement is still the one called later

    def stop():
        time.sleep(0.5)  # let the response reach the caller
        exit_now()

    threading.Thread(target=stop, daemon=True).start()
    return {"status": "shutting down", "cancelled": cancelled, "stopped": jobs_stopped and requests_finished}


@router.get("/api/ui-state", response_model=UIStateModel)
def get_ui_state() -> dict[str, Any]:
    return load_ui_state(deps.get_data_dir())


@router.put("/api/ui-state")
def put_ui_state(body: UIStateModel) -> dict[str, str]:
    deps.require_library_folder()
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
