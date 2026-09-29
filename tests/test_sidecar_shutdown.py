"""Stopping a sync, backup or restore, and shutting the sidecar down without leaving work half done."""
from __future__ import annotations

import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from papeer.core import drive_sync
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import Library
from papeer.providers import Cancelled, check_cancel
from sidecar import deps
from sidecar.app import app
from sidecar.jobs import ConcurrencyConflict, JobManager
from sidecar.routes import system

from _isolation import point_pc_folders

TOKEN = "correct-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
FIXTURE_PDF = Path(__file__).parent / "fixtures/sample.pdf"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def exits(monkeypatch):
    """A fresh job manager and a recorded exit instead of the real one (it would end the test run)."""
    monkeypatch.setenv("PAPEER_TOKEN", TOKEN)
    monkeypatch.setattr(deps, "job_manager", JobManager())
    calls: list[bool] = []
    monkeypatch.setattr(system, "exit_process", lambda: calls.append(True))
    return calls


@pytest.fixture
def client(exits):
    return TestClient(app)


def wait_until(condition, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.01)


def cancellable_job(started: threading.Event):
    def action(cancel, progress, _page_ready):
        started.set()
        while True:
            check_cancel(cancel)
            cancel.wait(0.01)
    return action


# --- The snapshot guard ---

@pytest.mark.parametrize(("method", "path", "expected"), [
    ("GET", "/api/jobs", 200),
    ("GET", "/api/jobs/unknown", 404),  # how a job ended: reaches the route instead of 409
    ("GET", "/api/drive", 200),
    ("POST", "/api/jobs/cancel-all", 200),
    ("POST", "/api/jobs/unknown/cancel", 404),  # reaches the route instead of 409
    ("GET", "/api/settings", 409),
    ("GET", "/api/ui-state", 409),
    ("PUT", "/api/drive", 409),  # only reading the sync state is let through
    ("GET", "/api/drive/check", 409),  # the automatic sync's check reads the library
])
def test_progress_and_stopping_answer_during_a_snapshot(client, monkeypatch, method, path, expected):
    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    body = {"auto_sync": True} if path == "/api/drive" and method == "PUT" else None
    assert client.request(method, path, headers=AUTH, json=body).status_code == expected


def test_a_refusal_during_a_snapshot_says_the_request_did_not_run(client, monkeypatch):
    """The frontend sends such a request again once a background sync is over (frontend/src/lib/libraryBusy.ts)."""
    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    response = client.patch("/api/papers/" + "0" * 32, headers=AUTH, json={"note": "x"})
    assert response.status_code == 409 and response.json()["code"] == "library_busy"


def test_a_request_admitted_just_before_a_snapshot_is_refused_the_same_way(client, monkeypatch):
    """get_library's refusal (the request was admitted, then the snapshot began) carries the code too."""
    monkeypatch.setattr(deps, "begin_library_request", lambda *_: True)
    monkeypatch.setattr(deps, "end_library_request", lambda *_: None)  # nothing was counted
    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    response = client.get("/api/papers", headers=AUTH)
    assert response.status_code == 409 and response.json()["code"] == "library_busy"


def snapshot_job(kind: str, background: bool = False):
    """A running snapshot job of `kind` (a background sync if asked), and the event that ends it."""
    gate = threading.Event()

    def action(cancel, progress, _page_ready):
        if background:
            with deps.background_sync():
                gate.wait(5)
        else:
            gate.wait(5)
    job = deps.job_manager.submit_job(kind, action)
    if background:
        wait_until(deps._background_sync.is_set)
    return job, gate


def test_the_shown_pdfs_images_and_summary_load_beside_a_background_sync(client):
    lib = Library(deps.get_data_dir())
    identity, _ = lib.import_pdf(FIXTURE_PDF)
    (lib.folder(identity) / "article.md").write_text("サマリー", "utf-8")
    (lib.folder(identity) / "media").mkdir()
    (lib.folder(identity) / "media" / "figure.png").write_bytes(b"PNG")
    reads = [f"/api/papers/{identity}/files/original.pdf", f"/api/papers/{identity}/media/figure.png",
             f"/api/papers/{identity}/article"]
    job, gate = snapshot_job("drive-sync", background=True)
    try:
        for path in reads:
            assert client.get(path, headers=AUTH).status_code == 200, path
        assert client.get(reads[0], headers={**AUTH, "Range": "bytes=0-9"}).status_code == 206
        # Everything else still waits: other reads, and every write (the sync reads what they would change).
        for method, path in [("GET", "/api/papers"), ("GET", f"/api/papers/{identity}/reading"),
                             ("PATCH", f"/api/papers/{identity}"), ("DELETE", f"/api/papers/{identity}/files/original.pdf")]:
            response = client.request(method, path, headers=AUTH, json={"note": "x"} if method == "PATCH" else None)
            assert response.status_code == 409 and response.json()["code"] == "library_busy", (method, path)
    finally:
        gate.set()
        wait_until(lambda: not job.running)
    assert not deps._background_sync.is_set()
    # Beside a sync that may take in another PC's library, or a backup or restore, nothing passes.
    for kind in ("drive-sync", "restore"):
        job, gate = snapshot_job(kind)
        try:
            assert client.get(reads[0], headers=AUTH).status_code == 409
        finally:
            gate.set()
            wait_until(lambda: not job.running)


@pytest.mark.parametrize(("method", "path"), [
    ("POST", "/api/jobs/x/cancel/extra"),
    ("POST", "/api/jobs//cancel"),
    ("POST", "/api/jobs/cancel-all/"),
    ("POST", "/prefix/api/jobs/x/cancel"),
    ("POST", "/shutdown/"),
    ("POST", "/shutdownx"),
    ("GET", "/shutdown"),
    ("PUT", "/api/jobs/x/cancel"),
    ("DELETE", "/api/jobs/cancel-all"),
    ("GET", "/api/jobs/"),
    ("GET", "/api/jobs/x/extra"),
    ("GET", "/api/drive/sync"),
    ("POST", "/api/drive"),
    ("POST", "/health"),
])
def test_only_the_listed_routes_pass_the_snapshot_guard(method, path):
    from sidecar.app import allowed_during_snapshot
    assert not allowed_during_snapshot(method, path)


def test_shutdown_answers_during_a_snapshot(client, exits, monkeypatch):
    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    assert client.post("/shutdown", headers=AUTH).status_code == 200
    wait_until(lambda: exits == [True])


def test_requests_without_the_token_are_refused_before_the_snapshot_guard(client, monkeypatch):
    """No 409 that tells a stranger a backup is running, and no count a snapshot would wait for."""
    counted: list[bool] = []
    monkeypatch.setattr(deps, "snapshot_running", lambda: True)
    monkeypatch.setattr(deps, "begin_library_request", lambda *_: counted.append(True) or False)
    for headers in ({}, {"Authorization": "Bearer wrong"}):
        assert client.get("/api/settings", headers=headers).status_code == 401
        assert client.post("/api/papers/x/translate", headers=headers).status_code == 401
    assert client.get("/api/settings", params={"token": "wrong"}).status_code == 401
    assert counted == []
    assert client.get("/api/settings", headers=AUTH).status_code == 409
    assert counted == [True]


# --- Shutdown ---

def test_shutdown_stops_jobs_before_answering_then_exits(client, exits):
    started = threading.Event()
    job = deps.job_manager.submit_job("translate", cancellable_job(started), paper_id="p")
    assert started.wait(5)
    response = client.post("/shutdown", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"status": "shutting down", "cancelled": 1, "stopped": True}
    # Already over when the answer arrives, so the caller can let the process go.
    assert deps.job_manager.get_job(job.job_id).status == "cancelled"
    wait_until(lambda: exits == [True])
    with pytest.raises(ConcurrencyConflict):
        deps.job_manager.submit_job("translate", cancellable_job(threading.Event()), paper_id="q")


def test_shutdown_gives_up_waiting_for_a_job_that_does_not_stop(client, exits, monkeypatch):
    monkeypatch.setattr(system, "SHUTDOWN_JOB_TIMEOUT", 0.1)
    release = threading.Event()
    deps.job_manager.submit_job("translate", lambda *_: release.wait(5), paper_id="p")
    try:
        response = client.post("/shutdown", headers=AUTH)
        assert response.json()["stopped"] is False
        wait_until(lambda: exits == [True])
    finally:
        release.set()


@pytest.fixture
def ended_clis(monkeypatch):
    """Records when the running CLIs are ended (providers.common.end_running_clis), and whether the jobs had
    been cancelled by then (so that none records its CLI's failure or starts it again)."""
    calls: list[bool] = []
    monkeypatch.setattr(system, "end_running_clis", lambda: calls.append(deps.job_manager._closed) or 0)
    return calls


def test_the_sidecar_stops_its_jobs_and_exits_when_the_apps_pipe_closes(exits, ended_clis):
    # The app's process ended (a crash, a kill): its end of the stdin pipe closes (system.watch_stdin).
    started = threading.Event()
    job = deps.job_manager.submit_job("translate", cancellable_job(started), paper_id="p")
    assert started.wait(5)
    read_end, write_end = os.pipe()
    watcher = threading.Thread(target=system.watch_stdin, args=(read_end,), daemon=True)
    watcher.start()
    try:
        os.write(write_end, b"anything the app might write is read and ignored")
        time.sleep(0.1)
        assert deps.job_manager.get_job(job.job_id).running and exits == []
    finally:
        os.close(write_end)
    watcher.join(5)
    os.close(read_end)
    assert deps.job_manager.get_job(job.job_id).status == "cancelled"
    assert exits == [True]
    # The CLIs are ended at once, once the jobs are cancelled (not when each job gets to it).
    assert ended_clis == [True]
    with pytest.raises(ConcurrencyConflict):
        deps.job_manager.submit_job("translate", cancellable_job(threading.Event()), paper_id="q")


def test_the_stdin_pipe_is_watched_only_when_the_app_asks(exits, monkeypatch):
    # `just dev-sidecar` and the tests start the sidecar without it (its stdin is a console or nothing).
    started = []
    monkeypatch.setattr(system.threading, "Thread", lambda **kwargs: Mock(start=lambda: started.append(kwargs)))
    monkeypatch.setattr(system.sys, "stdin", Mock(fileno=lambda: 7))
    monkeypatch.delenv("PAPEER_WATCH_STDIN", raising=False)
    assert system.start_watching_stdin() is False
    monkeypatch.setenv("PAPEER_WATCH_STDIN", "1")
    assert system.start_watching_stdin() is True
    assert [(kwargs["target"], kwargs["args"]) for kwargs in started] == [(system.watch_stdin, (7,))]
    monkeypatch.setattr(system.sys, "stdin", None)  # pythonw, or a closed stdin: nothing to watch.
    assert system.start_watching_stdin() is False


def test_a_sidecar_that_cannot_start_exits_with_its_code_while_watching_its_stdin(tmp_path):
    # The port is taken: uvicorn gives up and the sidecar exits with its code, while the watcher thread is still
    # blocked reading the app's pipe. A blocked buffered read (sys.stdin.buffer) aborted Python instead
    # ("Fatal Python error: _enter_buffered_busy").
    env = {name: value for name, value in os.environ.items()
           if not name.upper().startswith(("PAPEER_", "PAPERDESK_", "VIRTUAL_ENV"))}
    point_pc_folders(env.__setitem__, tmp_path / "pc")
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        env.update(PAPEER_DATA_DIR=str(tmp_path / "data"), PAPEER_TOKEN="t", PAPEER_WATCH_STDIN="1",
                   PAPEER_PORT=str(taken.getsockname()[1]), PYTHONUTF8="1")
        process = subprocess.Popen([sys.executable, "-m", "sidecar"], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            # The pipe stays open, as while the app runs (communicate() would close it).
            process.wait(60)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            assert process.stdin is not None and process.stdout is not None
            process.stdin.close()
            output = process.stdout.read()
    # uvicorn exits with 3 (its STARTUP_FAILURE) when it cannot bind the port.
    assert process.returncode == 3, output.decode("utf-8", "replace")
    assert b"Fatal Python error" not in output


@pytest.mark.skipif(os.name == "nt", reason="SIGTERM: macOS and Linux (Windows ends the sidecar through its job object)")
def test_sigterm_stops_the_jobs_before_the_exit(exits, ended_clis, monkeypatch):
    handlers = {}
    monkeypatch.setattr(system.signal, "signal", lambda signum, handler: handlers.__setitem__(signum, handler))
    system.stop_on_terminate()
    started = threading.Event()
    job = deps.job_manager.submit_job("translate", cancellable_job(started), paper_id="p")
    assert started.wait(5)
    handlers[signal.SIGTERM](signal.SIGTERM, None)
    assert deps.job_manager.get_job(job.job_id).status == "cancelled"
    assert exits == [True] and ended_clis == [True]


def test_exit_ends_the_clis_that_are_still_running(monkeypatch):
    # A job that did not stop in time: its CLI, in a session of its own, must not outlive the sidecar.
    calls = []
    monkeypatch.setattr(system, "end_running_clis", lambda: calls.append("clis"))
    monkeypatch.setattr(system.os, "_exit", lambda code: calls.append(code))
    system.exit_process()
    assert calls == ["clis", 0]


def test_a_job_closed_right_after_it_was_submitted_is_waited_for():
    manager = JobManager()
    job = manager.submit_job("translate", cancellable_job(threading.Event()), paper_id="p")
    assert manager.close() == 1
    assert manager.wait_idle(5) is True
    assert manager.get_job(job.job_id).status == "cancelled"


def test_wait_idle_is_true_without_jobs():
    assert JobManager().wait_idle(0) is True


# --- Cancelling a snapshot leaves the library and the destination as they were ---

@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(FIXTURE_PDF)
    return lib, identity


def test_cancelled_backup_leaves_no_file(library, tmp_path):
    lib, _ = library
    cancel = threading.Event()
    cancel.set()
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(Cancelled):
        create_backup(lib, out / "backup.zip", cancel)
    assert list(out.iterdir()) == []


def test_cancelled_restore_keeps_the_library(library, tmp_path):
    lib, identity = library
    archive = tmp_path / "backup.zip"
    create_backup(lib, archive)
    lib.update(identity, note="after backup")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        restore_backup(lib, archive, cancel)
    assert lib.paper(identity)["note"] == "after backup"
    assert sorted(p.name for p in lib.root.parent.iterdir()) == ["backup.zip", "library"]


def test_cancelled_sync_records_no_error(library, tmp_path, client, monkeypatch):
    """Stopping a sync is not a failure: the next automatic sync must not be held back by an error."""
    lib, _ = library
    monkeypatch.setattr(deps, "get_data_dir", lambda: lib.root)
    drive_sync.save_state(lib.root, {"connected": True, "folder": str(tmp_path)})
    listed, release = threading.Event(), threading.Event()

    class SlowDrive:
        def __init__(self, _folder):
            pass

        def revisions(self):
            listed.set()
            release.wait(5)
            return []

    monkeypatch.setattr(drive_sync, "FolderDrive", SlowDrive)
    job_id = client.post("/api/drive/sync", headers=AUTH, json={}).json()["job_id"]
    assert listed.wait(5)
    # The sync holds the library, yet the cancel request gets through.
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=AUTH).status_code == 200
    release.set()
    wait_until(lambda: not deps.job_manager.get_job(job_id).running)
    job = deps.job_manager.get_job(job_id)
    assert (job.status, job.error) == ("cancelled", "同期を中止しました。")
    assert drive_sync.read_state(lib.root).get("error") is None
    assert not drive_sync.read_state(lib.root).get("last_sync")


def test_a_request_stays_counted_until_its_file_is_sent(exits, monkeypatch):
    """A snapshot waits for the whole response: pdf.js may still be reading a file after the headers went out."""
    import asyncio
    from sidecar.app import ProtectLibrarySnapshot

    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.delenv("PAPEER_TOKEN", raising=False)
    counted: list[bool] = []

    async def streaming_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"%PDF", "more_body": True})
        counted.append(not deps.wait_for_library_requests(0))  # the body is not finished yet
        await send({"type": "http.response.body", "body": b"...", "more_body": False})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(_message):
        pass

    for path in (f"/api/papers/{'0' * 32}/files/original.pdf", "/api/papers"):
        scope = {"type": "http", "method": "GET", "path": path, "raw_path": path.encode(), "root_path": "",
                 "scheme": "http", "server": ("127.0.0.1", 8000), "query_string": b"", "headers": []}
        asyncio.run(ProtectLibrarySnapshot(streaming_app)(scope, receive, send))
    assert counted == [True, True]
    assert deps.wait_for_library_requests(0)


def test_a_background_sync_does_not_wait_for_the_reads_beside_it(exits):
    """A stream of pdf.js range requests must not keep it from starting; any other snapshot waits for them."""
    admitted = deps.begin_library_request(read_only=True)
    assert admitted == deps.SIDE_READ
    try:
        assert deps.wait_for_library_requests(0, side_reads=False)
        assert not deps.wait_for_library_requests(0)
    finally:
        deps.end_library_request(admitted)
    assert deps.wait_for_library_requests(0)


def test_a_snapshot_waiting_for_a_slow_request_can_be_stopped(client, tmp_path, monkeypatch):
    """中止 works while a backup (or a sync, or a restore) still waits for requests admitted before it."""
    monkeypatch.setattr(deps, "CANCEL_POLL", 0.05)
    Library(deps.get_data_dir())
    admitted = deps.begin_library_request()  # a request that does not finish
    try:
        job_id = client.post("/api/backup", headers=AUTH, json={"path": str(tmp_path / "backup.zip")}).json()["job_id"]
        job = deps.job_manager.get_job(job_id)
        time.sleep(0.1)
        assert job.running
        assert client.post(f"/api/jobs/{job_id}/cancel", headers=AUTH).status_code == 200
        wait_until(lambda: not job.running, timeout=2)
        assert job.status == "cancelled" and job.error == "バックアップを中止しました。"
        assert not (tmp_path / "backup.zip").exists()
    finally:
        deps.end_library_request(admitted)
