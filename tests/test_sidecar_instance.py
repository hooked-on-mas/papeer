"""One sidecar per library: taking the library, the discovery file, the idle exit and the handover."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from papeer import __version__
from papeer.core import instance as discovery
from papeer.core.instance import InstanceInfo, LibraryLock
from papeer.core.paths import log_directory
from sidecar import deps, instance
from sidecar.app import app
from sidecar.jobs import JobManager
from sidecar.routes import system

from _isolation import point_pc_folders

TOKEN = "instance-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ROOT = Path(__file__).resolve().parents[1]


class FakeClock:
    """A clock that only moves when the test (or a fake sleep) says so."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch) -> FakeClock:
    clock = FakeClock()
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    monkeypatch.setattr(deps, "job_manager", JobManager())
    monkeypatch.setattr(instance, "activity", instance.Activity(clock))
    for name in ("_lock", "_root", "_info", "_idle_grace"):
        monkeypatch.setattr(instance, name, None)
    return clock


@pytest.fixture
def exits(clock, monkeypatch):
    """A recorded exit instead of the real one (it would end the test run)."""
    calls: list[bool] = []
    monkeypatch.setattr(system, "exit_process", lambda: calls.append(True))
    yield calls
    instance.release()


@pytest.fixture
def root(tmp_path) -> Path:
    folder = tmp_path / "library"
    folder.mkdir()
    return folder


def holder_info(root: Path, **changes) -> InstanceInfo:
    values = dict(pid=os.getpid() + 1, port=51000, token="holder-token", launcher="cli", data_dir=str(root),
                  version="1.0.0", started_at=1_700_000_000.0)
    values.update(changes)
    return InstanceInfo(**values)


class Holder:
    """Another sidecar that holds the library: its lock (an object of its own) and the file it wrote."""

    def __init__(self, root: Path, **changes) -> None:
        self.lock = LibraryLock()
        assert self.lock.try_acquire(root)
        self.info = holder_info(root, **changes)
        discovery.write_instance(root, self.info)

    def let_go(self) -> None:
        self.lock.release()


# --- launcher and idle_exit_grace ---

def test_launcher_is_what_the_environment_names_else_where_the_code_runs_from(monkeypatch):
    monkeypatch.delenv("PAPEER_LAUNCHER", raising=False)
    monkeypatch.delenv("PAPERDESK_LAUNCHER", raising=False)
    assert instance.launcher() == "dev"  # Run from source.
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert instance.launcher() == "app"
    monkeypatch.setenv("PAPEER_LAUNCHER", "cli")
    assert instance.launcher() == "cli"
    monkeypatch.setenv("PAPEER_LAUNCHER", "nonsense")
    assert instance.launcher() == "app"
    monkeypatch.delattr(sys, "frozen")
    monkeypatch.setenv("PAPEER_LAUNCHER", "")
    assert instance.launcher() == "dev"
    # The legacy name works as for every other variable.
    monkeypatch.delenv("PAPEER_LAUNCHER")
    monkeypatch.setenv("PAPERDESK_LAUNCHER", "cli")
    assert instance.launcher() == "cli"


@pytest.mark.parametrize(("who", "value", "expected"), [
    ("cli", "10", 10.0), ("cli", "0.5", 0.5), ("cli", "0", None), ("cli", "-3", None), ("cli", "abc", None),
    ("cli", "inf", None), ("cli", "nan", None), ("cli", "", None), ("cli", None, None),
    ("app", "10", None), ("dev", "10", None),
])
def test_only_a_cli_sidecar_asked_to_leaves_when_idle(monkeypatch, who, value, expected):
    monkeypatch.delenv("PAPEER_IDLE_EXIT", raising=False)
    monkeypatch.delenv("PAPERDESK_IDLE_EXIT", raising=False)
    if value is not None:
        monkeypatch.setenv("PAPEER_IDLE_EXIT", value)
    assert instance.idle_exit_grace(who) == expected


# --- claim_library ---

def test_a_free_library_is_taken_at_once(clock, exits, root):
    asked = []
    lock = instance.claim_library(root, "app", ask_shutdown=lambda *_: asked.append(1) or True,
                                  verify=lambda _: True, clock=clock, sleep=clock.sleep)
    assert lock.held and instance._lock is lock
    assert asked == [] and clock.sleeps == []
    assert LibraryLock().try_acquire(root) is False  # Held for the life of the process.


@pytest.mark.parametrize("who", ["app", "dev"])
def test_a_window_takes_the_library_over_from_a_cli_sidecar_by_asking_it_to_shut_down(clock, exits, root, who):
    holder = Holder(root, launcher="cli")
    asked: list[tuple[int, float]] = []

    def ask_shutdown(info: InstanceInfo, timeout: float) -> bool:
        asked.append((info.pid, timeout))
        clock.now += 1.0  # The holder stops its jobs, answers...
        holder.let_go()   # ...and is gone.
        return True

    lock = instance.claim_library(root, who, ask_shutdown=ask_shutdown, verify=lambda info: info.pid == holder.info.pid,
                                  clock=clock, sleep=clock.sleep, handover=30.0)
    assert lock.held
    assert asked == [(holder.info.pid, 30.0)]


def test_a_holder_is_asked_once_and_waited_for_the_whole_handover_then_given_up_on(clock, exits, root):
    holder = Holder(root, launcher="cli")
    asked = []
    try:
        with pytest.raises(SystemExit) as stopped:
            instance.claim_library(root, "app", ask_shutdown=lambda info, timeout: asked.append(info.pid) or True,
                                   verify=lambda _: True, clock=clock, sleep=clock.sleep, handover=30.0, wait=5.0)
    finally:
        holder.let_go()
    assert stopped.value.code == instance.EXIT_LIBRARY_IN_USE == 4
    assert asked == [holder.info.pid]  # Once, though the lock stayed held.
    assert 30.0 <= clock.now - 1000.0 < 31.0


def test_a_window_waits_the_system_routes_time_by_default(clock, exits, root):
    assert instance.handover_wait() == system.SHUTDOWN_JOB_TIMEOUT + system.SHUTDOWN_REQUEST_TIMEOUT + 5


@pytest.mark.parametrize("who", ["app", "dev", "cli"])
def test_a_window_holder_is_never_asked_to_shut_down(clock, exits, root, who):
    holder = Holder(root, launcher="app")
    asked = []
    try:
        with pytest.raises(SystemExit) as stopped:
            instance.claim_library(root, who, ask_shutdown=lambda *_: asked.append(1) or True,
                                   verify=lambda _: True, clock=clock, sleep=clock.sleep, wait=5.0)
    finally:
        holder.let_go()
    assert stopped.value.code == 4
    assert asked == []
    assert 5.0 <= clock.now - 1000.0 < 5.5  # The short deadline: it may be a holder that is still starting.


def test_a_cli_sidecar_does_not_take_over_from_another(clock, exits, root):
    holder = Holder(root, launcher="cli")
    asked = []
    try:
        with pytest.raises(SystemExit) as stopped:
            instance.claim_library(root, "cli", ask_shutdown=lambda *_: asked.append(1) or True,
                                   verify=lambda _: True, clock=clock, sleep=clock.sleep, wait=5.0)
    finally:
        holder.let_go()
    assert stopped.value.code == 4 and asked == []


def test_a_file_that_does_not_check_out_is_not_asked(clock, exits, root):
    # The pid and port in the file may be another program's by now, or the sidecar may not be listening yet.
    holder = Holder(root, launcher="cli")
    asked = []
    try:
        with pytest.raises(SystemExit):
            instance.claim_library(root, "app", ask_shutdown=lambda *_: asked.append(1) or True,
                                   verify=lambda _: False, clock=clock, sleep=clock.sleep, wait=5.0)
    finally:
        holder.let_go()
    assert asked == []


def test_a_holder_that_has_no_file_yet_is_waited_for_a_moment(clock, exits, root):
    holder = LibraryLock()
    assert holder.try_acquire(root)
    seconds = []

    def sleep(duration: float) -> None:
        seconds.append(duration)
        clock.sleep(duration)
        if len(seconds) == 3:
            holder.release()  # It was starting (or leaving): the lock comes free.

    lock = instance.claim_library(root, "app", verify=lambda _: True, clock=clock, sleep=sleep, wait=5.0)
    assert lock.held and len(seconds) == 3 and seconds == [instance.CLAIM_INTERVAL] * 3


def test_giving_up_says_who_holds_the_library_in_the_log(clock, exits, root, monkeypatch):
    holder = Holder(root, launcher="app", pid=4321)
    messages = []
    monkeypatch.setattr(instance.log, "error", lambda message, *args: messages.append(message % args))
    try:
        with pytest.raises(SystemExit):
            instance.claim_library(root, "app", verify=lambda _: True, clock=clock, sleep=clock.sleep, wait=1.0)
    finally:
        holder.let_go()
    assert messages == ["このライブラリは別の Papeer（app, pid 4321）が使用中です。"]


def test_a_lock_that_cannot_be_taken_at_all_does_not_stop_the_sidecar(clock, exits, root, monkeypatch):
    def refuse(self, path):
        raise PermissionError(13, "read-only")
    monkeypatch.setattr(LibraryLock, "try_acquire", refuse)
    lock = instance.claim_library(root, "app", clock=clock, sleep=clock.sleep)
    assert not lock.held


# --- The discovery file ---

def test_advertise_writes_where_the_sidecar_is_and_withdraw_removes_only_its_own_file(clock, exits, root):
    assert instance.withdraw() is False  # Nothing advertised.
    assert instance.advertise(root, 51234, "secret", "cli") is True
    info = discovery.read_instance(root)
    assert info is not None
    assert (info.pid, info.port, info.token, info.launcher, info.data_dir, info.version) == (
        os.getpid(), 51234, "secret", "cli", str(root), __version__)
    assert instance.describe() == {"pid": os.getpid(), "launcher": "cli", "data_dir": str(root), "port": 51234,
                                   "version": __version__, "idle_exit": None}
    # Another sidecar has replaced the file: it is not removed.
    discovery.write_instance(root, holder_info(root))
    assert instance.withdraw() is False
    assert discovery.read_instance(root) is not None
    instance.advertise(root, 51234, "secret", "cli")
    assert instance.withdraw() is True
    assert discovery.read_instance(root) is None
    assert instance.withdraw() is False


def test_a_discovery_file_that_cannot_be_written_does_not_stop_the_sidecar(clock, exits, root, monkeypatch):
    def refuse(*_args):
        raise PermissionError(13, "denied")
    monkeypatch.setattr(discovery, "write_instance", refuse)
    assert instance.advertise(root, 51234, None, "app") is False
    assert instance.describe()["port"] == 51234  # /api/instance still says where it is.
    assert instance.withdraw() is False


# --- /api/instance ---

@pytest.fixture
def client(clock, exits):
    return TestClient(app)


def test_instance_answers_who_this_sidecar_is(client, root):
    instance.advertise(root, 51234, TOKEN, "app")
    assert client.get("/api/instance").status_code == 401
    answer = client.get("/api/instance", headers=AUTH)
    assert answer.status_code == 200
    assert answer.json() == {"pid": os.getpid(), "launcher": "app", "data_dir": str(root), "port": 51234,
                             "version": __version__, "idle_exit": None}


def test_instance_without_a_discovery_file_still_answers(client):
    answer = client.get("/api/instance", headers=AUTH).json()
    assert answer["pid"] == os.getpid() and answer["port"] is None
    assert answer["data_dir"] == str(deps.get_data_dir())


def test_instance_is_answered_during_a_snapshot(client, monkeypatch):
    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    assert client.get("/api/instance", headers=AUTH).status_code == 200
    assert client.get("/api/settings", headers=AUTH).status_code == 409


def test_exit_process_withdraws_the_discovery_file_before_the_exit(root, monkeypatch):
    calls = []
    monkeypatch.setattr(system, "end_running_clis", lambda: calls.append("clis"))
    monkeypatch.setattr(system.instance, "withdraw", lambda: calls.append("withdraw"))
    monkeypatch.setattr(system.os, "_exit", lambda code: calls.append(code))
    system.exit_process()
    assert calls == ["withdraw", "clis", 0]


# --- TrackActivity ---

def http_scope(path: str, method: str = "GET") -> dict:
    return {"type": "http", "method": method, "path": path, "headers": [], "query_string": b""}


async def run_asgi(application, scope: dict) -> list[dict]:
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    await application(scope, receive, send)
    return sent


def test_requests_in_flight_are_counted_and_the_timer_restarts_when_one_ends(clock):
    release = asyncio.Event()

    async def inner(scope, receive, send):
        await release.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def scenario():
        tracked = instance.TrackActivity(inner)
        task = asyncio.create_task(run_asgi(tracked, http_scope("/api/papers")))
        await asyncio.sleep(0)
        assert instance.activity.requests == 1
        clock.now += 100
        release.set()
        await task
        assert instance.activity.requests == 0

    asyncio.run(scenario())
    assert instance.activity.idle_seconds() == 0  # The end of the request is the last activity.


def test_health_and_instance_do_not_count_as_activity(clock):
    seen = []

    async def inner(scope, receive, send):
        seen.append(instance.activity.requests)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def scenario():
        tracked = instance.TrackActivity(inner)
        clock.now += 50
        for path in ("/health", "/api/instance"):
            await run_asgi(tracked, http_scope(path))
        assert instance.activity.idle_seconds() == 50 and seen == [0, 0]
        # The same path with another method is a request like the others.
        await run_asgi(tracked, http_scope("/health", "POST"))
        assert instance.activity.idle_seconds() == 0 and seen == [0, 0, 1]

    asyncio.run(scenario())


def test_once_closing_every_request_is_answered_503_and_the_app_is_not_reached(clock):
    reached = []

    async def inner(scope, receive, send):
        reached.append(scope["path"])

    async def scenario():
        tracked = instance.TrackActivity(inner)
        assert instance.activity.close_if_idle(0, lambda: False) is True
        for path in ("/api/papers", "/health"):
            sent = await run_asgi(tracked, http_scope(path))
            assert sent[0]["status"] == 503
            body = json.loads(sent[1]["body"])
            assert body["code"] == "sidecar_closing" and body["detail"]
        assert instance.activity.requests == 0

    asyncio.run(scenario())
    assert reached == []


def test_the_event_stream_is_counted_while_it_is_open(client):
    with client.websocket_connect(f"/ws/events?token={TOKEN}"):
        deadline = time.monotonic() + 5
        while instance.activity.sockets != 1:
            assert time.monotonic() < deadline
            time.sleep(0.01)
    deadline = time.monotonic() + 5
    while instance.activity.sockets != 0:
        assert time.monotonic() < deadline
        time.sleep(0.01)


def test_a_closing_sidecar_refuses_http_and_the_event_stream(client):
    assert instance.activity.close_if_idle(0, lambda: False)
    for path in ("/health", "/api/jobs"):
        answer = client.get(path, headers=AUTH)
        assert answer.status_code == 503 and answer.json()["code"] == "sidecar_closing"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/events?token={TOKEN}"):
            pass


def test_a_real_request_through_the_app_is_counted_and_a_health_check_is_not(client, clock):
    clock.now += 30
    assert client.get("/health").status_code == 200
    assert client.get("/api/instance", headers=AUTH).status_code == 200
    assert instance.activity.idle_seconds() == 30
    assert client.get("/api/jobs", headers=AUTH).status_code == 200
    assert instance.activity.idle_seconds() == 0


# --- The idle exit ---

def job_running(monkeypatch, running: bool):
    jobs = [type("Job", (), {"running": running})()]
    monkeypatch.setattr(deps.job_manager, "get_jobs", lambda: jobs)


def test_an_idle_sidecar_stops_its_work_withdraws_and_exits_once_the_grace_has_passed(clock, exits, root, monkeypatch):
    calls = []
    instance.advertise(root, 51234, "t", "cli")
    monkeypatch.setattr(system, "stop_work", lambda *a, **k: calls.append("stop_work") or (0, True))
    exit_now = system.exit_process
    monkeypatch.setattr(system, "exit_process", lambda: calls.append("exit") or exit_now())
    clock.now += 9.9
    assert instance.leave_if_idle(10) is False and calls == []
    assert not instance.activity.closing
    clock.now += 0.2
    assert instance.leave_if_idle(10) is True
    assert calls == ["stop_work", "exit"] and exits == [True]
    assert discovery.read_instance(root) is None  # Withdrawn before the exit.
    assert instance.activity.closing


def test_a_running_job_a_request_or_an_open_stream_keeps_the_sidecar(clock, exits, monkeypatch):
    clock.now += 100
    job_running(monkeypatch, True)
    assert instance.leave_if_idle(10) is False
    job_running(monkeypatch, False)
    assert instance.activity.begin_request()
    assert instance.leave_if_idle(10) is False
    instance.activity.end_request()  # Its end is activity: the timer starts over.
    assert instance.leave_if_idle(10) is False
    clock.now += 10
    assert instance.activity.open_socket()
    assert instance.leave_if_idle(10) is False
    instance.activity.close_socket()
    assert instance.leave_if_idle(10) is False
    clock.now += 10
    assert exits == []
    assert instance.leave_if_idle(10) is True and exits == [True]


def test_a_request_cannot_be_admitted_once_the_sidecar_decided_to_leave(clock, exits):
    clock.now += 100
    assert instance.activity.close_if_idle(10, lambda: False)
    assert instance.activity.begin_request() is False
    assert instance.activity.open_socket() is False
    assert instance.activity.requests == 0 and instance.activity.sockets == 0


def test_the_watch_thread_leaves_by_itself(clock, exits, root, monkeypatch):
    instance.advertise(root, 51234, "t", "cli")
    left = threading.Event()
    monkeypatch.setattr(system, "exit_process", lambda: left.set())
    monkeypatch.setattr(instance, "activity", instance.Activity())  # The real clock.
    thread = instance.start_idle_exit(0.3, poll=0.05)
    assert instance.describe()["idle_exit"] == 0.3
    assert left.wait(10)
    thread.join(5)
    assert not thread.is_alive()
    assert discovery.read_instance(root) is None


def test_the_watch_thread_does_not_leave_while_requests_come(clock, exits, root, monkeypatch):
    left = threading.Event()
    monkeypatch.setattr(system, "exit_process", lambda: left.set())
    monkeypatch.setattr(instance, "activity", instance.Activity())
    thread = instance.start_idle_exit(0.5, poll=0.05)
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        assert instance.activity.begin_request()
        instance.activity.end_request()
        time.sleep(0.05)
    assert not left.is_set()
    assert left.wait(10)
    thread.join(5)


# --- Real sidecars ---
#
# `python -m sidecar` is started through the virtual environment's python.exe, a launcher (on Windows) that
# runs the real interpreter as a child: Popen.pid is not the sidecar's pid, the discovery file's is.

def sidecar_environment(tmp_path: Path, monkeypatch, **extra: str) -> dict[str, str]:
    """The environment of a sidecar subprocess on this test's own PC folders and library (and this test
    process, which reads the discovery file, on the same ones)."""
    env = {name: value for name, value in os.environ.items()
           if not name.upper().startswith(("PAPEER_", "PAPERDESK_", "VIRTUAL_ENV"))}
    point_pc_folders(env.__setitem__, tmp_path / "pc")
    point_pc_folders(monkeypatch.setenv, tmp_path / "pc")
    env.update(PAPEER_DATA_DIR=str(tmp_path / "data"), PAPEER_TOKEN="subprocess-token", PYTHONUTF8="1", **extra)
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "data"))
    return env


class Sidecars:
    """The sidecar processes of a test, all ended (with the interpreters under their launchers) at its end."""

    def __init__(self) -> None:
        self.processes: list[subprocess.Popen] = []

    def start(self, env: dict[str, str]) -> subprocess.Popen:
        process = subprocess.Popen([sys.executable, "-m", "sidecar"], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def end(self, root: Path) -> None:
        info = discovery.read_instance(root)
        for process in self.processes:
            if process.poll() is None:
                if info is not None and discovery.holder_alive_hint(info):
                    try:
                        os.kill(info.pid, signal.SIGTERM)  # Windows: TerminateProcess.
                    except OSError:
                        pass
                process.kill()
            process.wait(30)


@pytest.fixture
def sidecars():
    started = Sidecars()
    yield started
    assert all(process.poll() is not None for process in started.processes), "a sidecar was left running"


def wait_for(condition, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while True:
        value = condition()
        if value:
            return value
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.05)


def file_other_than(root: Path, earlier: InstanceInfo | None = None):
    """The discovery file once there is one that is not `earlier`."""
    def look():
        info = discovery.read_instance(root)
        return info if info is not None and (earlier is None or info.pid != earlier.pid) else None
    return look


def get(info: InstanceInfo, path: str, token: str | None = None) -> dict | list:
    request = urllib.request.Request(f"http://127.0.0.1:{info.port}{path}")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        return json.loads(response.read())


def healthy(info: InstanceInfo):
    try:
        return get(info, "/health")
    except (OSError, ValueError):
        return None


def assert_lock_is_free(root: Path) -> None:
    lock = LibraryLock()
    assert lock.try_acquire(root)
    lock.release()


def test_a_cli_sidecar_advertises_itself_and_leaves_when_idle(tmp_path, monkeypatch, sidecars):
    env = sidecar_environment(tmp_path, monkeypatch, PAPEER_LAUNCHER="cli", PAPEER_PORT="0", PAPEER_IDLE_EXIT="3")
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    process = sidecars.start(env)
    try:
        info = wait_for(file_other_than(root), 60, "the discovery file")
        assert (info.launcher, info.token, info.data_dir, info.version) == ("cli", "subprocess-token", str(root), __version__)
        assert info.port > 0 and info.port != 8000
        assert wait_for(lambda: healthy(info), 30, "/health")["status"] == "ok"
        answer = get(info, "/api/instance", info.token)
        assert (answer["pid"], answer["launcher"], answer["port"], answer["idle_exit"]) == (info.pid, "cli", info.port, 3.0)
        # Polling /health and /api/instance is not activity: nothing else is asked, so it leaves on its own.
        started = time.monotonic()
        while process.poll() is None and time.monotonic() - started < 25:
            healthy(info)
            time.sleep(0.1)
        assert process.poll() == 0
    finally:
        sidecars.end(root)
    assert discovery.read_instance(root) is None
    assert_lock_is_free(root)


def test_a_request_keeps_a_cli_sidecar_and_the_next_idle_period_ends_it(tmp_path, monkeypatch, sidecars):
    env = sidecar_environment(tmp_path, monkeypatch, PAPEER_LAUNCHER="cli", PAPEER_PORT="0", PAPEER_IDLE_EXIT="3")
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    process = sidecars.start(env)
    try:
        info = wait_for(file_other_than(root), 60, "the discovery file")
        wait_for(lambda: healthy(info), 30, "/health")
        for _ in range(6):  # Some 4.5 seconds of requests, longer than the grace period.
            assert get(info, "/api/jobs", info.token) == []
            time.sleep(0.75)
            assert process.poll() is None
        assert process.wait(30) == 0
    finally:
        sidecars.end(root)


def test_a_window_takes_over_from_a_cli_sidecar(tmp_path, monkeypatch, sidecars):
    cli_env = sidecar_environment(tmp_path, monkeypatch, PAPEER_LAUNCHER="cli", PAPEER_PORT="0")
    root = Path(cli_env["PAPEER_DATA_DIR"]).resolve()
    cli = sidecars.start(cli_env)
    try:
        cli_info = wait_for(file_other_than(root), 60, "the cli sidecar's file")
        wait_for(lambda: healthy(cli_info), 30, "/health")
        window = sidecars.start(dict(cli_env, PAPEER_LAUNCHER="app", PAPEER_TOKEN="window-token"))
        info = wait_for(file_other_than(root, cli_info), 90, "the window's sidecar's file")
        assert (info.launcher, info.token) == ("app", "window-token")
        assert cli.wait(30) == 0  # Told to shut down, and gone.
        assert get(info, "/api/instance", info.token)["launcher"] == "app"
        assert window.poll() is None
    finally:
        sidecars.end(root)


def test_a_second_window_sidecar_gives_up_with_exit_code_4_and_leaves_the_first_alone(tmp_path, monkeypatch, sidecars):
    env = sidecar_environment(tmp_path, monkeypatch, PAPEER_LAUNCHER="app", PAPEER_PORT="0")
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    sidecars.start(env)
    try:
        info = wait_for(file_other_than(root), 60, "the first sidecar's file")
        wait_for(lambda: healthy(info), 30, "/health")
        second = sidecars.start(dict(env, PAPEER_LAUNCHER="dev", PAPEER_TOKEN="other-token"))
        assert second.wait(60) == 4
        # Its file, its answers and its lock are still the first's.
        assert discovery.read_instance(root) == info
        assert get(info, "/api/instance", "subprocess-token")["pid"] == info.pid
        log = (log_directory() / "sidecar.log").read_text("utf-8")
        assert f"このライブラリは別の Papeer（app, pid {info.pid}）が使用中です。" in log
    finally:
        sidecars.end(root)


def test_the_port_taken_still_exits_with_3_and_leaves_no_file(tmp_path, monkeypatch, sidecars):
    import socket
    env = sidecar_environment(tmp_path, monkeypatch, PAPEER_LAUNCHER="app")
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        env["PAPEER_PORT"] = str(taken.getsockname()[1])
        process = sidecars.start(env)
        try:
            assert process.wait(60) == 3
        finally:
            sidecars.end(root)
    assert discovery.read_instance(root) is None
    assert_lock_is_free(root)
