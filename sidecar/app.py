"""The sidecar application: startup, CORS, the backup guard, job events, and the route modules."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import re
import sys
from typing import AsyncGenerator

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from papeer import __version__
from papeer.core.errors import AppError
from papeer.core.paths import app_env
from papeer.translation import translation_preview
from sidecar import deps
from sidecar.errors import AnswerUnexpectedErrors, error_response, log_to_file, where
from sidecar.routes import ai_jobs, drive, ink, papers, reading, settings, system


def remove_unused_translation_runs() -> None:
    """Page previews of translations that stopped when the app was forced to close; see remove_unused_translation_runs."""
    try:
        translation_preview.remove_unused_translation_runs(deps.get_data_dir())
    except Exception as exc:  # Never a reason not to start (an odd library folder included): the next launch tries again.
        print(f"警告: 翻訳の一時ファイルを掃除できませんでした: {exc!r}", file=sys.stderr)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    deps.job_manager.set_loop(asyncio.get_running_loop())
    # Before the first request, so no translation is writing a run folder its preview does not name yet.
    await asyncio.to_thread(remove_unused_translation_runs)
    yield


app = FastAPI(
    title="Papeer Sidecar",
    version=__version__,
    lifespan=lifespan,
    # The API schema and its pages would be the only routes open without the token.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


# What must still answer while a sync, backup or restore holds the library: reading its progress,
# and stopping it or the whole app (closing the window cancels the job, then calls /shutdown).
SNAPSHOT_READS = {"/health", "/api/jobs", "/api/drive"}
SNAPSHOT_CONTROLS = re.compile(r"/api/jobs/(?:cancel-all|[^/]+/cancel)|/shutdown")
# What a background sync lets through (deps.snapshot_blocks): the PDFs, images and summary that pdf.js,
# <img> and the summary pane load, which have no way to wait and send again (unlike apiRequest). Their
# handlers only read files and query the database, and the background sync only reads the library too
# (it never takes in another PC's), so neither changes what the other sees: the snapshot the sync hashes
# and archives stays consistent. They are counted like other requests, so a sync, backup or restore that
# starts later waits for them.
BACKGROUND_SYNC_READS = re.compile(r"/api/papers/[0-9a-f]{32}/(?:files/[^?]+|media/[^/]+|article)")


def read_beside_background_sync(method: str, path: str) -> bool:
    return method == "GET" and BACKGROUND_SYNC_READS.fullmatch(path) is not None


def allowed_during_snapshot(method: str, path: str) -> bool:
    if method == "OPTIONS":
        return True
    if method == "GET":
        return path in SNAPSHOT_READS
    return method == "POST" and SNAPSHOT_CONTROLS.fullmatch(path) is not None


# The one conversion of failures into answers (sidecar/errors.py): Invalid, NotFound and Conflict (a refused
# snapshot's LibraryBusy and a job's ConcurrencyConflict included) with their status, the core's ValueErrors
# with 400; a ValueError from elsewhere (json, pydantic) as a bug. Other bugs are answered by
# AnswerUnexpectedErrors below, inside the CORS middleware.
@app.exception_handler(AppError)
@app.exception_handler(ValueError)
async def refused(request: Request, exc: Exception) -> JSONResponse:
    return error_response(exc, where(request.scope))


class ProtectLibrarySnapshot:
    """While a sync, backup or restore holds the library, answer everything else with 409.

    A plain ASGI middleware rather than @app.middleware("http"): the app returns only once the response
    is sent, file bodies included, so a request stays counted while pdf.js or <img> still reads its file.
    A snapshot that waits for the counted requests therefore finds no file of the library held open by
    the sidecar (a restore renames the whole folder, which Windows refuses while a file in it is open).
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        guarded = not allowed_during_snapshot(request.method, request.url.path)
        # Authentication comes first: a request without the token is refused by its route (401), and must
        # neither learn that a snapshot is running nor be counted among the requests a snapshot waits for.
        if not guarded or not deps.token_matches(deps.provided_token(request.headers.get("authorization"),
                                                                     request.query_params.get("token"))):
            await self.app(scope, receive, send)
            return
        admitted = deps.begin_library_request(read_beside_background_sync(request.method, request.url.path))
        if not admitted:
            # The request did not run at all, so the frontend may send it again once the job is over.
            await error_response(deps.LibraryBusy())(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            deps.end_library_request(admitted)


# Before CORS: the last middleware added runs first, so refusals and answers to bugs get the CORS headers too.
app.add_middleware(AnswerUnexpectedErrors)
app.add_middleware(ProtectLibrarySnapshot)


# The Tauri window's origins (macOS/Linux, then Windows). Only a development sidecar (`just dev-sidecar`,
# which `tauri dev` talks to) also answers the Vite dev server the window, or a browser, loads the
# frontend from; the packaged sidecar, a PyInstaller exe, serves the release build alone.
APP_ORIGINS = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")
DEV_ORIGINS = ("http://localhost:1420", "http://localhost:5173", "http://127.0.0.1:1420", "http://127.0.0.1:5173")


def allowed_origins(packaged: bool) -> list[str]:
    return list(APP_ORIGINS if packaged else APP_ORIGINS + DEV_ORIGINS)


app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(getattr(sys, "frozen", False)),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (system, settings, papers, ai_jobs, reading, ink, drive):
    app.include_router(module.router)
app.include_router(system.public)


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket, token: str | None = Query(None)) -> None:
    """Job progress and library changes, pushed to the frontend."""
    if not deps.token_matches(token):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    manager = deps.job_manager
    queue: asyncio.Queue = asyncio.Queue()
    manager.add_listener(queue)
    try:
        while True:
            send_task = asyncio.create_task(queue.get())
            recv_task = asyncio.create_task(websocket.receive_text())
            done, pending = await asyncio.wait([send_task, recv_task], return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()

            if recv_task in done:
                try:
                    await recv_task
                except WebSocketDisconnect:
                    break

            if send_task in done:
                event = await send_task
                await websocket.send_text(json.dumps(event, ensure_ascii=False))
    except Exception:
        pass
    finally:
        manager.remove_listener(queue)


def startup_error() -> str | None:
    """Why the sidecar must not start, if it must not."""
    if deps.get_auth_token() or deps.auth_disabled():
        return None
    return ("PAPEER_TOKEN が設定されていないため起動しません。開発時は `just dev-sidecar` で起動してください"
            "（認証なしで起動する場合は PAPEER_DEV_NO_AUTH=1 を指定）。")


def main() -> None:
    import uvicorn

    error = startup_error()
    if error:
        sys.exit(error)
    if deps.auth_disabled():
        print("警告: PAPEER_DEV_NO_AUTH=1 のため認証なしで起動します（開発専用）。", file=sys.stderr)
    # Tracebacks of bugs, kept on this PC: Tauri does not read the packaged sidecar's stderr.
    log_to_file()
    port = int(app_env("PORT") or "8000")
    # Media URLs carry the token in the query string, so the access log would write it out.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
