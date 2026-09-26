"""The sidecar application: startup, CORS, the backup guard, job events, and the route modules."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
from typing import AsyncGenerator

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from papeer.core.paths import app_env
from papeer.core.code_version import application_version
from sidecar import deps
from sidecar.routes import ai_jobs, ink, papers, reading, settings, system


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    deps.job_manager.set_loop(asyncio.get_running_loop())
    yield


app = FastAPI(
    title="Papeer Sidecar",
    version=application_version(),
    lifespan=lifespan,
)


@app.middleware("http")
async def protect_library_snapshot(request: Request, call_next):
    """While a backup or restore copies the library, answer everything else with 409."""
    if request.method != "OPTIONS" and request.url.path not in {"/health", "/api/jobs"} and deps.snapshot_running():
        return JSONResponse(status_code=409, content={"detail": "バックアップ・復元が終わるまでお待ちください。"})
    return await call_next(request)


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

for module in (system, settings, papers, ai_jobs, reading, ink):
    app.include_router(module.router)
app.include_router(system.public)


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket, token: str | None = Query(None)) -> None:
    """Job progress and library changes, pushed to the frontend."""
    expected_token = deps.get_auth_token()
    if expected_token and token != expected_token:
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


def main() -> None:
    import uvicorn

    port = int(app_env("PORT") or "8000")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
