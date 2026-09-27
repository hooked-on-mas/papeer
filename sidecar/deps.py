"""Shared runtime state and helpers for the sidecar routes.

Routes reach the job manager, settings, the library and AI connections through this
module (as `deps.<name>`, looked up at call time, so tests can replace them), which
keeps the rules for combining saved settings, unsaved dialog values and the session
API key in one place.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import hmac
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any, Callable, Iterator

from fastapi import Header, HTTPException, Query, status

from papeer.core.config import Settings, api_key_from_env
from papeer.core.errors import Conflict, NotFound
from papeer.core.paths import app_env, data_directory
from papeer.core.storage import Library, LibraryMissingError, NewerSchemaError, library_missing, missing_library_message
from papeer.providers import ProviderBackend, check_cancel, create_provider
from sidecar.job_types import SNAPSHOT_KINDS, JobKind, LibraryChangedEvent
from sidecar.jobs import JobManager
from sidecar.schemas import ProviderActionRequest

job_manager = JobManager()

# Entered in the settings dialog or given at launch; kept only while the app runs.
_runtime_api_key: str = api_key_from_env()

# A snapshot starts only after already-admitted HTTP handlers have finished (their responses sent, files
# included: see app.ProtectLibrarySnapshot).
_requests_condition = threading.Condition()
_library_requests = 0
# The reads a background sync lets through (app.BACKGROUND_SYNC_READS), counted apart: that sync need not
# wait for them (they only read), and a stream of pdf.js range requests would otherwise keep it from ever
# finding none running. Every other snapshot waits for them too.
_side_reads = 0
SIDE_READ = "side-read"

# The "code" of a 409 for a request refused unrun because a snapshot holds the library: the frontend may
# send it again once the job is over (frontend/src/lib/libraryBusy.ts).
LIBRARY_BUSY = "library_busy"


class LibraryBusy(Conflict):
    """409 with the code LIBRARY_BUSY; raised before a handler changed anything."""

    def __init__(self, message: str = "同期・バックアップ・復元が終わるまでお待ちください。"):
        super().__init__(message, code=LIBRARY_BUSY)


# Set while an automatic sync runs in the background (drive_sync.sync(background=True)): it reads the
# library but never writes or replaces it, so reads that only read (app.BACKGROUND_SYNC_READS) may run beside it.
_background_sync = threading.Event()


@contextmanager
def background_sync() -> Iterator[None]:
    _background_sync.set()
    try:
        yield
    finally:
        _background_sync.clear()


def snapshot_blocks(read_only: bool = False) -> bool:
    """Whether a request must wait for the running snapshot; a read-only one need not beside a background sync.

    At most one snapshot job runs at a time (JobManager), so a running drive-sync while the flag is set is
    the background one. Around its start and end (flag not yet or no longer set) reads are refused: safe.
    """
    if not snapshot_running():
        return False
    if not read_only or not _background_sync.is_set():
        return True
    return not all(job.kind == JobKind.DRIVE_SYNC for job in job_manager.get_jobs() if job.running and job.kind in SNAPSHOT_KINDS)


def begin_library_request(read_only: bool = False) -> str | None:
    """Admit a request: None when a snapshot refuses it, else what to give end_library_request afterwards."""
    global _library_requests, _side_reads
    with _requests_condition:
        if snapshot_blocks(read_only):
            return None
        if read_only:
            _side_reads += 1
            return SIDE_READ
        _library_requests += 1
        return "request"


def end_library_request(kind: object = "request") -> None:
    global _library_requests, _side_reads
    with _requests_condition:
        if kind == SIDE_READ:
            _side_reads -= 1
        else:
            _library_requests -= 1
        _requests_condition.notify_all()


# How often a snapshot waiting for the admitted requests looks at its 中止 button.
CANCEL_POLL = 0.5


def wait_for_library_requests(timeout: float | None = None, *, side_reads: bool = True,
                              cancel: threading.Event | None = None) -> bool:
    """Wait until no admitted request is running; False if some still are after `timeout` seconds.

    side_reads=False (a background sync) leaves out the reads that may run beside it. With `cancel`, the
    wait raises Cancelled once it is set (checked every CANCEL_POLL seconds), so a sync, backup or restore
    can be stopped while it still waits for a slow request.
    """
    deadline = None if timeout is None else time.monotonic() + timeout
    with _requests_condition:
        while _library_requests or (side_reads and _side_reads):
            if cancel is not None:
                check_cancel(cancel)
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return False
            step = CANCEL_POLL if cancel is not None else remaining
            _requests_condition.wait(step if remaining is None or step is None else min(step, remaining))
        return True


# --- Access ---
#
# Every route except /health needs the token that Tauri hands the sidecar at launch (PAPEER_TOKEN).
# Without one the sidecar refuses to start, and a request is refused, unless the developer asked for
# an unauthenticated server with PAPEER_DEV_NO_AUTH=1; a packaged sidecar never honours that flag.

# A new flag, so unlike the other variables it has no PAPERDESK_* spelling.
DEV_NO_AUTH = "PAPEER_DEV_NO_AUTH"


def get_auth_token() -> str | None:
    return app_env("TOKEN") or None


def auth_disabled() -> bool:
    """True only for a development server started without a token on purpose."""
    if get_auth_token() or getattr(sys, "frozen", False):
        return False
    return os.environ.get(DEV_NO_AUTH) == "1"


def token_matches(provided: str | None) -> bool:
    """Whether a request may pass; compared in constant time so the token cannot be guessed byte by byte."""
    if auth_disabled():
        return True
    expected = get_auth_token()
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def provided_token(authorization: str | None, token: str | None) -> str | None:
    """The token a request carries: the Authorization header, else the `token` query parameter."""
    # <img> tags cannot send headers, so media URLs carry the token as a query parameter.
    if authorization and authorization.startswith("Bearer "):
        return authorization[len("Bearer "):].strip()
    return token or None


def verify_token(authorization: str | None = Header(None), token: str | None = Query(None)) -> None:
    if auth_disabled():
        return
    provided = provided_token(authorization, token)
    if provided is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが必要です。")
    if not token_matches(provided):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが不正です。")


# --- Library ---

def get_data_dir() -> Path:
    return data_directory()


def snapshot_running() -> bool:
    """Whether the library folder is being copied or replaced (job_types.SNAPSHOT_KINDS)."""
    return any(job.running and job.kind in SNAPSHOT_KINDS for job in job_manager.get_jobs())


def get_library() -> Library:
    # Reached only by requests admitted before the snapshot began (the middleware refuses the rest), which
    # it waits for; the handlers call this before changing anything (they check their input first), so the
    # refused request did not run. Beside a background sync, the admitted requests may go on: it never
    # writes the library, and waits for them before reading it.
    if snapshot_blocks(read_only=True):
        raise LibraryBusy()
    try:
        return Library(get_data_dir())
    except (NewerSchemaError, LibraryMissingError) as exc:
        # Opened by a newer Papeer, or a synced library's folder is gone: say so instead of a bare
        # server error (or an empty library) on every request.
        raise Conflict(str(exc)) from None


def require_library_folder() -> None:
    """For writes that go to the data folder without opening the Library (settings, prompts, ui-state).

    They would otherwise create the folder of a synced library that has gone missing, and the moved
    folder could not simply be put back.
    """
    root = get_data_dir()
    if library_missing(root):
        raise Conflict(missing_library_message(root))


def paper_folder(lib: Library, paper_id: str) -> Path:
    try:
        lib.paper(paper_id)
        return lib.folder(paper_id)
    except (KeyError, ValueError):
        raise NotFound("論文が見つかりません。") from None


# --- Jobs ---

def submit_job(kind: JobKind, action: Callable[..., Any], paper_id: str | None = None) -> dict[str, str]:
    """Start a background job; ConcurrencyConflict (409) when it would overlap a job it must not run beside."""
    return {"job_id": job_manager.submit_job(kind, action, paper_id=paper_id).job_id}


def library_changed() -> None:
    """Tell the frontend to reload the library list."""
    job_manager.broadcast(LibraryChangedEvent())


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
