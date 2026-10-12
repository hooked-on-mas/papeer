"""The sidecar application: startup, CORS, the backup guard, job events, and the route modules."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
import re
import socket
import sys
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from papeer import __version__
from papeer.core.errors import AppError
from papeer.core.paths import app_env
from papeer.translation import translation_preview
from sidecar import deps, instance
from sidecar.errors import AnswerUnexpectedErrors, error_response, log_to_file, where
from sidecar.instance import TrackActivity
from sidecar.job_types import event_schemas
from sidecar.routes import ai_jobs, attachments, notebooks, drive, ink, ocr, papers, reading, research, discovery, settings, system


def remove_unused_translation_runs() -> None:
    """Page previews of translations that stopped when the app was forced to close; see remove_unused_translation_runs."""
    try:
        translation_preview.remove_unused_translation_runs(deps.get_data_dir())
    except Exception as exc:  # noqa: BLE001 - never a reason not to start (an odd library folder included): the next launch tries again.
        print(f"警告: 翻訳の一時ファイルを掃除できませんでした: {exc!r}", file=sys.stderr)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    deps.job_manager.set_loop(asyncio.get_running_loop())
    # Before the first request, so no translation is writing a run folder its preview does not name yet. And
    # only the sidecar that holds the library's lock gets here (main() claims it before the server starts),
    # so no other sidecar's running translation has its run folder taken away.
    await asyncio.to_thread(remove_unused_translation_runs)
    # Started here, not in main(): the idle timer begins when the server is about to answer, so a slow start
    # is never counted as idleness. Only a sidecar the CLI started, and asked to (PAPEER_IDLE_EXIT).
    grace = instance.idle_exit_grace()
    if grace is not None:
        instance.start_idle_exit(grace)
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


# What must still answer while a sync, backup or restore holds the library: reading its progress (and how
# the jobs a reconnecting window waited on ended), and stopping it or the whole app (closing the window
# cancels the job, then calls /shutdown). /api/instance is what the CLI and a second window check a discovery
# file's claim with: a sidecar busy with a sync must still answer it as itself.
SNAPSHOT_READS = {"/health", "/api/instance", "/api/jobs", "/api/drive"}
SNAPSHOT_JOB_READ = re.compile(r"/api/jobs/[^/]+")
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
        return path in SNAPSHOT_READS or SNAPSHOT_JOB_READ.fullmatch(path) is not None
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
# TrackActivity (what the idle exit looks at) is outside ProtectLibrarySnapshot, so a request it refuses with
# 409 counts as activity, and inside CORS, so its 503 `sidecar_closing` is readable by a window.
app.add_middleware(AnswerUnexpectedErrors)
app.add_middleware(ProtectLibrarySnapshot)
app.add_middleware(TrackActivity)


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

for module in (system, settings, papers, attachments, notebooks, ai_jobs, reading, ink, drive, ocr, research, discovery):
    app.include_router(module.router)
app.include_router(system.public)


def openapi() -> dict[str, Any]:
    """The API's schema (never served: openapi_url=None), with the events of /ws/events among its components."""
    if app.openapi_schema is None:
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
        components = schema.setdefault("components", {}).setdefault("schemas", {})
        for name, event_schema in event_schemas().items():
            components.setdefault(name, event_schema)
        app.openapi_schema = schema
    return app.openapi_schema


app.openapi = openapi


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket, token: str | None = Query(None)) -> None:
    """Job progress and library changes, pushed to the frontend (the events of sidecar/job_types.py)."""
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
    except Exception:  # noqa: BLE001, S110 - the window went away mid-send: the listener is removed below.
        pass
    finally:
        manager.remove_listener(queue)


def startup_error() -> str | None:
    """Why the sidecar must not start, if it must not."""
    if deps.get_auth_token() or deps.auth_disabled():
        return None
    return ("PAPEER_TOKEN が設定されていないため起動しません。開発時は `just dev-sidecar` で起動してください"
            "（認証なしで起動する場合は PAPEER_DEV_NO_AUTH=1 を指定）。")


SIGTERM_REQUEST_TIMEOUT = 3
# uvicorn's exit code when the server could not start (the port is taken): uvicorn.run exits with it.
EXIT_PORT_TAKEN = 3
# Where the packaged app and `tauri dev` expect the sidecar when no port is given.
DEFAULT_PORT = 8000


def bind_socket(port: int) -> socket.socket:
    """Listen on 127.0.0.1:`port` (0: any free port); exit with EXIT_PORT_TAKEN, as uvicorn.run does, if taken.

    Bound here, before the server starts, so that the port is known (PAPEER_PORT=0) for the discovery file
    that is written before the server runs. SO_REUSEADDR as asyncio sets it for a server, which is POSIX only:
    on Windows it would let a second sidecar bind a port that is in use. Listening at once means a client that
    comes while the app starts waits in the backlog (the CLI connects as soon as it finds the file) instead of
    being refused.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "posix":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.listen(2048)
    except OSError as exc:
        sock.close()
        print(f"ポート {port} を使えません（別のプログラムが使用中です）: {exc}", file=sys.stderr)
        sys.exit(EXIT_PORT_TAKEN)
    return sock


def main() -> None:
    import uvicorn

    error = startup_error()
    if error:
        sys.exit(error)
    if deps.auth_disabled():
        print("警告: PAPEER_DEV_NO_AUTH=1 のため認証なしで起動します（開発専用）。", file=sys.stderr)
    # Tracebacks of bugs, kept on this PC: Tauri does not read the packaged sidecar's stderr.
    log_to_file()
    # Ending with the app however it ends (see system.watch_stdin and system.stop_on_terminate). Before the
    # library is claimed, so that an app closed while this sidecar waits for another to hand it over ends it
    # at once, instead of its taking the library over afterwards.
    system.start_watching_stdin()
    system.stop_on_terminate()
    # One sidecar per library (sidecar/instance.py): the lock first, so what the sidecar does to the library
    # at startup (the lifespan's cleanup of translation runs) cannot meet another sidecar's work. May exit
    # with instance.EXIT_LIBRARY_IN_USE.
    root = deps.get_data_dir()
    who = instance.launcher()
    instance.claim_library(root, who)
    sock = bind_socket(int(app_env("PORT") or str(DEFAULT_PORT)))
    port = sock.getsockname()[1]
    # Only now: whoever reads the file finds a socket that is listening.
    instance.advertise(root, port, deps.get_auth_token(), who)
    # Media URLs carry the token in the query string, so the access log would write it out. After SIGTERM,
    # requests still running get a few seconds before the jobs are stopped (system.stop_on_terminate).
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info", access_log=False,
                            timeout_graceful_shutdown=SIGTERM_REQUEST_TIMEOUT)
    server = uvicorn.Server(config)
    # What uvicorn.run says when it binds the socket itself (and `just dev-sidecar` shows).
    logging.getLogger("uvicorn.error").info("Uvicorn running on http://127.0.0.1:%d (Press CTRL+C to quit)", port)
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        pass
    finally:
        instance.withdraw()
        instance.release()
    if not server.started:
        sys.exit(EXIT_PORT_TAKEN)


if __name__ == "__main__":
    main()
