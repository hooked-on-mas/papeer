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

from papeer.core.paths import app_env
from papeer.core.code_version import application_version
from sidecar import deps
from sidecar.routes import ai_jobs, drive, ink, papers, reading, settings, system


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    deps.job_manager.set_loop(asyncio.get_running_loop())
    yield


app = FastAPI(
    title="Papeer Sidecar",
    version=application_version(),
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


def allowed_during_snapshot(method: str, path: str) -> bool:
    if method == "OPTIONS":
        return True
    if method == "GET":
        return path in SNAPSHOT_READS
    return method == "POST" and SNAPSHOT_CONTROLS.fullmatch(path) is not None


@app.middleware("http")
async def protect_library_snapshot(request: Request, call_next):
    """While a backup or restore copies the library, answer everything else with 409."""
    guarded = not allowed_during_snapshot(request.method, request.url.path)
    # Authentication comes first: a request without the token is refused by its route (401), and must
    # neither learn that a snapshot is running nor be counted among the requests a snapshot waits for.
    if guarded and not deps.token_matches(deps.provided_token(request.headers.get("authorization"),
                                                              request.query_params.get("token"))):
        return await call_next(request)
    if guarded and not deps.begin_library_request():
        return JSONResponse(status_code=409, content={"detail": "同期・バックアップ・復元が終わるまでお待ちください。"})
    try:
        return await call_next(request)
    finally:
        if guarded:
            deps.end_library_request()


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://localhost:5173",
        "http://127.0.0.1:1420",
        "http://127.0.0.1:5173",
    ],
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
    port = int(app_env("PORT") or "8000")
    # Media URLs carry the token in the query string, so the access log would write it out.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
