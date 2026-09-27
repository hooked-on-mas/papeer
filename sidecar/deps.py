"""Shared runtime state and helpers for the sidecar routes.

Routes reach the job manager, settings, the library and AI connections through this
module (as `deps.<name>`, looked up at call time, so tests can replace them), which
keeps the rules for combining saved settings, unsaved dialog values and the session
API key in one place.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import threading
from typing import Any, Callable

from fastapi import Header, HTTPException, Query, status

from papeer.core.config import Settings, api_key_from_env
from papeer.core.paths import app_env, data_directory
from papeer.core.storage import Library
from papeer.providers import ProviderBackend, create_provider
from sidecar.jobs import ConcurrencyConflict, JobManager
from sidecar.schemas import ProviderActionRequest

job_manager = JobManager()

# Entered in the settings dialog or given at launch; kept only while the app runs.
_runtime_api_key: str = api_key_from_env()

# While these run, the library folder is being copied or replaced.
SNAPSHOT_JOBS = {"backup", "restore", "drive-sync"}

# A snapshot starts only after already-admitted HTTP handlers have finished.
_requests_condition = threading.Condition()
_library_requests = 0


def begin_library_request() -> bool:
    global _library_requests
    with _requests_condition:
        if snapshot_running():
            return False
        _library_requests += 1
        return True


def end_library_request() -> None:
    global _library_requests
    with _requests_condition:
        _library_requests -= 1
        _requests_condition.notify_all()


def wait_for_library_requests() -> None:
    with _requests_condition:
        _requests_condition.wait_for(lambda: _library_requests == 0)


# --- Access ---

def get_auth_token() -> str | None:
    return app_env("TOKEN")


def verify_token(authorization: str | None = Header(None), token: str | None = Query(None)) -> None:
    expected = get_auth_token()
    if not expected:
        return
    # <img> tags cannot send headers, so media URLs carry the token as a query parameter.
    if authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer "):].strip()
    elif token:
        provided = token
    else:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが必要です。")
    if provided != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが不正です。")


# --- Library ---

def get_data_dir() -> Path:
    return data_directory()


def snapshot_running() -> bool:
    return any(job.running and job.kind in SNAPSHOT_JOBS for job in job_manager.get_jobs())


def get_library() -> Library:
    if snapshot_running():
        raise HTTPException(status_code=409, detail="バックアップ・復元が終わるまでお待ちください。")
    return Library(get_data_dir())


def paper_folder(lib: Library, paper_id: str) -> Path:
    try:
        lib.paper(paper_id)
        return lib.folder(paper_id)
    except (KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")


# --- Jobs ---

def submit_job(kind: str, action: Callable[..., Any], paper_id: str | None = None) -> dict[str, str]:
    """Start a background job; 409 when it would overlap a job it must not run beside."""
    try:
        return {"job_id": job_manager.submit_job(kind, action, paper_id=paper_id).job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


def library_changed() -> None:
    """Tell the frontend to reload the library list."""
    job_manager.broadcast({"type": "library.changed"})


# --- Settings and AI connections ---

def get_settings() -> Settings:
    return Settings.load(get_data_dir())


def runtime_api_key() -> str:
    return _runtime_api_key


def set_runtime_api_key(value: str) -> None:
    global _runtime_api_key
    _runtime_api_key = value


def settings_from_request(body: ProviderActionRequest | None) -> Settings:
    """Saved settings with the dialog's unsaved values applied, so login/check test what the user is editing."""
    settings = get_settings()
    if body is None:
        return settings
    values = body.model_dump(exclude_none=True, exclude={"api_key", "provider_options"})
    settings = replace(settings, **values)
    for provider, options in (body.provider_options or {}).items():
        for key, value in options.items():
            settings.set_option(provider, key, value)
    return settings


def settings_for_run(model: str | None, effort: str | None) -> Settings:
    """Saved settings with the model/effort a dialog chose for one job; ValueError for an unknown effort."""
    settings = get_settings()
    return replace(settings, model=model or settings.model, reasoning_effort=effort or settings.reasoning_effort)


def provider_for(settings: Settings | None = None, cancel: threading.Event | None = None,
                 api_key: str | None = None) -> ProviderBackend:
    """The AI connection for these settings (the saved ones by default).

    The key is the one given here (unsaved in the dialog), else the session key, else the launch environment's.
    """
    settings = settings or get_settings()
    settings = replace(settings, api_key=api_key or _runtime_api_key or settings.api_key)
    return create_provider(settings, cancel)
