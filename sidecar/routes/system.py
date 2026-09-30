"""Health, shutdown, remembered UI state and the job list."""
from __future__ import annotations

import os
import signal
import sys
import threading
import time
from types import FrameType
from typing import Any

from fastapi import APIRouter, Depends

from papeer import __version__
from papeer.core.code_version import application_version
from papeer.core.errors import NotFound
from papeer.core.paths import app_env
from papeer.providers.common import end_running_clis
from sidecar import deps
from sidecar.job_types import JobInfo
from sidecar.schemas.system import HealthResponse, UIStateModel
from sidecar.ui_state import load_ui_state, save_ui_state

public = APIRouter()
router = APIRouter(dependencies=[Depends(deps.verify_token)])


@public.get("/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    # version: the app release (MAJOR.MINOR.PATCH, `just bump`); code_version: the identity of the code that
    # extracts and draws PDFs (code-version.txt in a build), which changes without a release. It does not key
    # the translation cache (papeer.translation.translation.TranslationKey does).
    return {"status": "ok", "version": __version__, "code_version": application_version()}


# How long /shutdown lets cancelled jobs wind down (CLI subprocesses stopped, files closed) and
# in-flight requests finish before the process exits anyway. Tauri waits longer than this for
# the process to end before it kills it (SIDECAR_EXIT_TIMEOUT in src-tauri/src/sidecar.rs).
SHUTDOWN_JOB_TIMEOUT = 20.0
SHUTDOWN_REQUEST_TIMEOUT = 5.0


def exit_process() -> None:
    # A CLI still running (its job did not stop in time) ends now, not after the sidecar: each runs in a
    # session of its own, which ending the sidecar's process group would not reach.
    end_running_clis()
    # Exit code 0 tells Tauri and `just smoke-sidecar` the sidecar ended by itself.
    os._exit(0)


def stop_work(end_clis: bool = False) -> tuple[int, bool]:
    """Refuse new jobs, cancel the running ones and wait for them and the library requests (bounded).

    With end_clis (the app is gone, or wants the sidecar gone now), the running CLIs are ended at once,
    right after their jobs are cancelled (so that no job records the failure or starts its CLI again),
    instead of when each job gets to it. Returns how many jobs were cancelled, and whether everything had
    stopped in time.
    """
    manager = deps.job_manager
    cancelled = manager.close()
    if end_clis:
        end_running_clis()
    jobs_stopped = manager.wait_idle(SHUTDOWN_JOB_TIMEOUT)
    requests_finished = deps.wait_for_library_requests(SHUTDOWN_REQUEST_TIMEOUT)
    return cancelled, jobs_stopped and requests_finished


# The packaged app starts the sidecar with PAPEER_WATCH_STDIN=1 and a pipe as its standard input, which it
# never writes to (frontend/src-tauri/src/sidecar.rs). The pipe closes when the app's process ends, however
# it ends (a crash, a kill): the sidecar then stops its jobs (and the CLIs they run) and exits, as after
# /shutdown. On Windows the app's job object ends it as well; on macOS and Linux this is what does.
WATCH_STDIN_VARIABLE = "WATCH_STDIN"


def watch_stdin(fd: int) -> None:
    """Read file descriptor `fd` until it ends, then stop the work and exit (run on a daemon thread).

    os.read on the descriptor, not sys.stdin.buffer: a daemon thread blocked in a buffered read holds the
    buffer's lock, and Python ending meanwhile (the port was taken, say) aborts with "Fatal Python error:
    _enter_buffered_busy" instead of exiting with its code.
    """
    try:
        while os.read(fd, 4096):
            pass
    except OSError:
        pass  # A broken or closed pipe: the app is gone all the same.
    print("標準入力が閉じたため（アプリが終了したため）、ジョブを止めて終了します。", file=sys.stderr, flush=True)
    stop_work(end_clis=True)
    exit_process()


def start_watching_stdin() -> bool:
    """Start watch_stdin on the process's standard input when the app asked for it (PAPEER_WATCH_STDIN=1)."""
    if app_env(WATCH_STDIN_VARIABLE) != "1":
        return False
    try:
        fd = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):  # No standard input at all.
        return False
    threading.Thread(target=watch_stdin, args=(fd,), name="watch-stdin", daemon=True).start()
    return True


def stop_on_terminate() -> None:
    """macOS and Linux: SIGTERM (sent by the app when the sidecar does not end after /shutdown, and on Linux
    when the app's process ends: PR_SET_PDEATHSIG) stops the jobs and the CLIs they run before the exit.

    uvicorn takes SIGTERM over while it serves; once it has stopped serving, it gives the signal back
    to the handler set here (uvicorn.Server.capture_signals). Without it, the job threads (daemons) would
    end with the process and the CLIs, each in a session of its own (providers.common.process_kwargs),
    would keep running.
    """
    if os.name == "nt":
        return

    def terminate(_signum: int, _frame: FrameType | None) -> None:
        stop_work(end_clis=True)
        exit_process()

    signal.signal(signal.SIGTERM, terminate)


@router.post("/shutdown")
def shutdown() -> dict[str, Any]:
    """Stop every job, wait for them (bounded), answer, then exit.

    The caller waits for this response, so by the time it arrives nothing is writing any more;
    new jobs are refused from the first moment.
    """
    cancelled, stopped = stop_work()

    exit_now = exit_process  # looked up now, so a test's replacement is still the one called later

    def stop():
        time.sleep(0.5)  # let the response reach the caller
        exit_now()

    threading.Thread(target=stop, daemon=True).start()
    return {"status": "shutting down", "cancelled": cancelled, "stopped": stopped}


@router.get("/api/ui-state", response_model=UIStateModel)
def get_ui_state() -> dict[str, Any]:
    return load_ui_state(deps.get_data_dir())


@router.put("/api/ui-state")
def put_ui_state(body: UIStateModel) -> dict[str, str]:
    deps.require_library_folder()
    save_ui_state(deps.get_data_dir(), body.model_dump())
    return {"status": "saved"}


@router.get("/api/jobs", response_model=list[JobInfo])
def get_jobs() -> list[JobInfo]:
    """The running jobs; how a finished one ended is GET /api/jobs/{job_id}."""
    return [job for job in deps.job_manager.get_jobs() if job.running]


@router.post("/api/jobs/cancel-all")
def cancel_all_jobs() -> dict[str, int]:
    manager = deps.job_manager
    # Only as the app closes (AppShell): not the user's 中止 of each job (JobManager.stopped_by_user).
    return {"cancelled": sum(manager.cancel_job(job.job_id, by_user=False) for job in manager.get_jobs() if job.running)}


@router.get("/api/jobs/{job_id}", response_model=JobInfo)
def get_job(job_id: str) -> JobInfo:
    """A running job, or one of the last finished ones (jobs.FINISHED_JOBS_KEPT) with its result or error."""
    job = deps.job_manager.get_job(job_id)
    if job is None:
        raise NotFound("ジョブが見つかりません。")
    return job


@router.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, str]:
    if not deps.job_manager.cancel_job(job_id):
        raise NotFound("実行中のジョブが見つかりません。")
    return {"status": "cancelling"}
