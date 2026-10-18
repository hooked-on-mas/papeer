"""One sidecar per library: taking the library, telling where this sidecar is, and leaving when idle.

The pieces (papeer/core/instance.py holds the lock and the discovery file; this module is what the running
sidecar does with them):

- claim_library: before the sidecar listens, take the library's lock. When another Papeer holds it, a
  window (launcher "app" or "dev") takes over from a headless sidecar the CLI started ("cli") by asking
  it to shut down (POST /shutdown, which stops its jobs without the user's 中止: their partial
  translations and caches stay); anything else gives up with exit code EXIT_LIBRARY_IN_USE.
- advertise / withdraw: the discovery file (InstanceInfo) tells the CLI where the sidecar listens and what
  its token is; withdraw removes it (only if it is this process's) on a clean exit.
- TrackActivity and start_idle_exit: a sidecar the CLI started (launcher "cli", PAPEER_IDLE_EXIT set)
  leaves by itself once nothing has been asked of it for a while. Idle means all of: no running job, no
  HTTP request in flight, no /ws/events open, and the last request ended at least the grace period ago.
  GET /health and GET /api/instance are not requests in that sense: a CLI polls them while it waits for
  the sidecar to come up or to go, so counting them would let it keep an idle sidecar alive for ever.
  (A started or finished request, a socket opening or closing: those reset the timer.)

Once the idle sidecar has decided to leave, TrackActivity answers every new HTTP request with 503
`sidecar_closing` (the repo's error shape, {"detail", "code"}); the check and the decision are made under
one lock, so a request is either counted in time to keep the sidecar or refused: never cut off.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any, Callable
import urllib.error
import urllib.request

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from papeer import __version__
from papeer.core import instance as discovery
from papeer.core.instance import InstanceInfo, LibraryLock
from papeer.core.paths import app_env
from sidecar import deps
from sidecar.errors import log

LAUNCHER_VARIABLE = "LAUNCHER"
IDLE_EXIT_VARIABLE = "IDLE_EXIT"

# The library is served by another Papeer (exit code 3, the port is taken, is uvicorn's STARTUP_FAILURE).
EXIT_LIBRARY_IN_USE = 4
# The "code" of the 503 TrackActivity answers once the sidecar is leaving (the CLI starts another).
CLOSING_CODE = "sidecar_closing"

# How long to look for the lock to come free when nobody asked to hand it over: a sidecar that is still
# starting has not written its discovery file yet, or one that is leaving has not let go yet.
CLAIM_WAIT = 5.0
# Between two attempts to take the lock.
CLAIM_INTERVAL = 0.2
# How long a holder's answers to the verification (GET /api/instance) may take.
VERIFY_TIMEOUT = 2.0
# What a handover waits for after the request, beyond the holder's own wait for its jobs and requests.
HANDOVER_MARGIN = 5.0
# What no request reaches: how often the idle exit looks.
IDLE_POLL = 1.0
# The requests that are not activity (see the docstring).
QUIET_PATHS = frozenset({"/health", "/api/instance"})


def launcher() -> str:
    """Who started this sidecar: PAPEER_LAUNCHER if it names one, else "app" (packaged) or "dev" (source)."""
    value = app_env(LAUNCHER_VARIABLE)
    if value in discovery.LAUNCHERS:
        return str(value)
    return "app" if getattr(sys, "frozen", False) else "dev"


def idle_exit_grace(who: str | None = None) -> float | None:
    """The seconds of idleness after which this sidecar leaves, or None (it never does).

    Only a sidecar the CLI started leaves by itself, and only when asked to with PAPEER_IDLE_EXIT: a window's
    sidecar ends with the window, and a development sidecar stays up between runs of the frontend.
    """
    if (who or launcher()) != "cli":
        return None
    raw = app_env(IDLE_EXIT_VARIABLE)
    try:
        seconds = float(raw) if raw else 0.0
    except ValueError:
        return None
    return seconds if math.isfinite(seconds) and seconds > 0 else None


# --- Talking to the sidecar that holds the library ---

def _call(info: InstanceInfo, method: str, path: str, timeout: float) -> dict[str, Any]:
    """One request to the holder's sidecar on this PC; no proxy (a system proxy must not see the token)."""
    request = urllib.request.Request(f"http://127.0.0.1:{info.port}{path}", method=method,
                                     data=b"" if method == "POST" else None)
    if info.token:
        request.add_header("Authorization", f"Bearer {info.token}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        data = json.loads(response.read(64 * 1024).decode("utf-8"))
    return data if isinstance(data, dict) else {}


def verify_holder(info: InstanceInfo) -> bool:
    """Whether the sidecar at `info`'s port is the one the file says: same pid and library, token accepted.

    The file may be a dead sidecar's, its pid and port another program's by now: only this answer says the
    one to ask for a shutdown is a Papeer serving this library.
    """
    if not discovery.holder_alive_hint(info):
        return False
    try:
        data = _call(info, "GET", "/api/instance", VERIFY_TIMEOUT)
    except (OSError, ValueError):  # urllib's errors are OSErrors; ValueError: not JSON.
        return False
    return data.get("pid") == info.pid and data.get("data_dir") == info.data_dir


def request_shutdown(info: InstanceInfo, timeout: float) -> bool:
    """POST /shutdown to the holder and wait for its answer (it comes once its jobs have stopped)."""
    try:
        _call(info, "POST", "/shutdown", timeout)
    except (OSError, ValueError):
        return False
    return True


# --- Taking the library ---

# Kept for the life of the process, so the garbage collector never closes the handle that holds the lock.
_lock: LibraryLock | None = None
# What advertise wrote, and where.
_root: Path | None = None
_info: InstanceInfo | None = None
_idle_grace: float | None = None


def handover_wait() -> float:
    """What a holder may take to stop its jobs and requests (routes/system.py), and a margin."""
    from sidecar.routes import system  # Late: that module imports this one.
    return system.SHUTDOWN_JOB_TIMEOUT + system.SHUTDOWN_REQUEST_TIMEOUT + HANDOVER_MARGIN


def claim_library(
    root: Path,
    who: str,
    *,
    ask_shutdown: Callable[[InstanceInfo, float], bool] | None = None,
    verify: Callable[[InstanceInfo], bool] | None = None,
    wait: float = CLAIM_WAIT,
    handover: float | None = None,
    interval: float = CLAIM_INTERVAL,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> LibraryLock:
    """Take the lock of the library at `root`, or leave with EXIT_LIBRARY_IN_USE.

    `who` is this sidecar's launcher. While the lock is held by another process: when this is a window
    ("app" or "dev") and the holder's file names a "cli" sidecar that answers as itself, ask it once to
    shut down and wait up to `handover` seconds (default: handover_wait()); otherwise wait up to `wait`
    seconds (the holder may be starting, and has no file yet, or be leaving), then give up. A lock that cannot
    be taken at all (OSError) is logged and not insisted on.
    """
    global _lock
    ask_shutdown = ask_shutdown or request_shutdown
    verify = verify or verify_holder
    lock = LibraryLock()
    deadline = clock() + wait
    asked: set[int] = set()
    holder: InstanceInfo | None = None
    while True:
        try:
            acquired = lock.try_acquire(root)
        except OSError as exc:
            # The device folder or its file system cannot lock (read-only, a network share): that must not
            # stop the app, which ran without the lock before. Not held, so another sidecar is not shut out either.
            log.warning("ライブラリの排他ロックを取れませんでした（排他なしで続けます）: %r", exc)
            _lock = lock
            return lock
        if acquired:
            _lock = lock
            return lock
        holder = discovery.read_instance(root)
        if (holder is not None and who != "cli" and holder.launcher == "cli" and holder.pid != os.getpid()
                and holder.pid not in asked and verify(holder)):
            asked.add(holder.pid)
            log.warning("ヘッドレスの Papeer（cli, pid %d）にライブラリを渡すよう頼みます。", holder.pid)
            wait_for = handover if handover is not None else handover_wait()
            deadline = max(deadline, clock() + wait_for)
            ask_shutdown(holder, wait_for)
            continue
        if clock() >= deadline:
            break
        sleep(interval)
    detail = f"{holder.launcher}, pid {holder.pid}" if holder is not None else "起動情報なし"
    log.error("このライブラリは別の Papeer（%s）が使用中です。", detail)
    sys.exit(EXIT_LIBRARY_IN_USE)


def release() -> None:
    """Let go of the library (a clean exit that does not end the process; the OS does it otherwise)."""
    global _lock
    lock, _lock = _lock, None
    if lock is not None:
        lock.release()


# --- The discovery file ---

def advertise(root: Path, port: int, token: str | None, who: str) -> bool:
    """Write this sidecar's discovery file; False (logged) when it could not: the sidecar works all the same,
    the CLI just cannot find it."""
    global _root, _info
    info = InstanceInfo(pid=os.getpid(), port=port, token=token, launcher=who, data_dir=str(root),
                        version=__version__, started_at=time.time())
    _root, _info = root, info
    try:
        discovery.write_instance(root, info)
    except OSError as exc:
        log.warning("起動情報ファイルを書けませんでした（CLI からこの sidecar を見つけられません）: %r", exc)
        return False
    return True


def withdraw() -> bool:
    """Remove this sidecar's discovery file (only if it is this process's). Never raises."""
    if _root is None:
        return False
    try:
        return discovery.remove_instance(_root, os.getpid())
    except Exception:  # noqa: BLE001 - leaving is not to be stopped by a file.
        return False


def describe() -> dict[str, Any]:
    """The answer of GET /api/instance."""
    info = _info
    return {
        "pid": os.getpid(),
        "launcher": info.launcher if info else launcher(),
        "data_dir": str(_root) if _root is not None else str(deps.get_data_dir()),
        "port": info.port if info else None,
        "version": __version__,
        "idle_exit": _idle_grace,
    }


# --- What the sidecar is doing ---

class Activity:
    """The requests in flight, the event streams open, and when the last of them ended (guarded by one lock)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._guard = threading.Lock()
        self._clock = clock
        self._requests = 0
        self._sockets = 0
        self._last = clock()
        self._closing = False

    @property
    def closing(self) -> bool:
        return self._closing

    @property
    def requests(self) -> int:
        return self._requests

    @property
    def sockets(self) -> int:
        return self._sockets

    def idle_seconds(self) -> float:
        return self._clock() - self._last

    def touch(self) -> None:
        with self._guard:
            self._last = self._clock()

    def begin_request(self) -> bool:
        """Count a request in flight; False when the sidecar is leaving (it must be refused)."""
        with self._guard:
            if self._closing:
                return False
            self._requests += 1
            return True

    def end_request(self) -> None:
        with self._guard:
            self._requests -= 1
            self._last = self._clock()

    def open_socket(self) -> bool:
        with self._guard:
            if self._closing:
                return False
            self._sockets += 1
            return True

    def close_socket(self) -> None:
        with self._guard:
            self._sockets -= 1
            self._last = self._clock()

    def close_if_idle(self, grace: float, jobs_running: Callable[[], bool]) -> bool:
        """Decide to leave: True (and `closing` from now on) when nothing is going on and nothing has for
        `grace` seconds. Under the lock that begin_request takes, so no request is admitted meanwhile."""
        with self._guard:
            if self._closing:
                return True
            if self._requests or self._sockets or self._clock() - self._last < grace or jobs_running():
                return False
            self._closing = True
            return True


activity = Activity()


def _jobs_running() -> bool:
    return any(job.running for job in deps.job_manager.get_jobs())


class TrackActivity:
    """Count what the sidecar is asked (HTTP requests in flight, /ws/events open) and refuse once it is leaving.

    A plain ASGI middleware, like app.ProtectLibrarySnapshot and for the same reason: a streamed file
    stays counted until its last byte is sent, and a WebSocket is not wrapped in a response (a
    BaseHTTPMiddleware would break both).
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind == "http":
            await self._http(scope, receive, send)
        elif kind == "websocket":
            await self._websocket(scope, receive, send)
        else:
            await self.app(scope, receive, send)

    async def _http(self, scope: Scope, receive: Receive, send: Send) -> None:
        tracker = activity  # looked up now: a test replaces it
        if scope.get("method") == "GET" and scope.get("path") in QUIET_PATHS:
            if tracker.closing:
                await _closing_response()(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return
        if not tracker.begin_request():
            await _closing_response()(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            tracker.end_request()

    async def _websocket(self, scope: Scope, receive: Receive, send: Send) -> None:
        tracker = activity
        if not tracker.open_socket():
            # Before accept: the handshake is refused (the frontend reconnects, to the sidecar that replaces this).
            await receive()  # websocket.connect
            await send({"type": "websocket.close", "code": 1013})
            return
        try:
            await self.app(scope, receive, send)
        finally:
            tracker.close_socket()


def _closing_response() -> JSONResponse:
    return JSONResponse(status_code=503, content={
        "detail": "この sidecar は終了処理に入っています。しばらくしてからやり直してください。",
        "code": CLOSING_CODE,
    })


# --- Leaving when idle ---

def leave_if_idle(grace: float) -> bool:
    """One look: when idle for `grace` seconds, stop the work, withdraw and exit the process (True)."""
    if not activity.close_if_idle(grace, _jobs_running):
        return False
    from sidecar.routes import system  # Late: that module imports this one. Looked up now, as /shutdown does.
    log.warning("%.0f 秒間何も依頼がなかったため、終了します。", grace)
    system.stop_work()
    withdraw()
    system.exit_process()
    return True


def start_idle_exit(grace: float, *, poll: float = IDLE_POLL,
                    sleep: Callable[[float], None] = time.sleep) -> threading.Thread:
    """Look every `poll` seconds on a daemon thread, until leave_if_idle leaves. The timer starts now."""
    global _idle_grace
    _idle_grace = grace
    activity.touch()

    def watch() -> None:
        while True:
            sleep(poll)
            try:
                if leave_if_idle(grace):
                    return
            except Exception:  # noqa: BLE001 - a bug here must not leave the watch dead: look again.
                log.exception("アイドル終了の確認に失敗しました。")

    thread = threading.Thread(target=watch, name="idle-exit", daemon=True)
    thread.start()
    return thread
