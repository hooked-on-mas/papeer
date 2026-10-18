"""papeer-cli as a real process: it starts a headless sidecar, reuses a running one, and the sidecar leaves by
itself. The in-process parts are in tests/test_cli.py.

`python -m sidecar` runs through the virtual environment's python.exe, a launcher on Windows that starts the
interpreter as a child: Popen.pid is not the sidecar's pid, the discovery file's is (as in
tests/test_sidecar_instance.py), and that is the pid cleaned up here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

from papeer.core import instance as discovery
from papeer.core.instance import LibraryLock

from _isolation import point_pc_folders

ROOT = Path(__file__).resolve().parents[1]


def cli_environment(tmp_path: Path, monkeypatch) -> dict[str, str]:
    """The environment of the CLI (and of the sidecar it starts) on this test's own PC folders and library;
    the test process itself, which reads the discovery file, is pointed at the same ones."""
    env = {name: value for name, value in os.environ.items()
           if not name.upper().startswith(("PAPEER_", "PAPERDESK_", "VIRTUAL_ENV"))}
    point_pc_folders(env.__setitem__, tmp_path / "pc")
    point_pc_folders(monkeypatch.setenv, tmp_path / "pc")
    env.update(PAPEER_DATA_DIR=str(tmp_path / "data"), PYTHONUTF8="1")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "data"))
    return env


def run_cli(env: dict[str, str], *args: str, timeout: float = 120.0) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "papeer.cli", *args], cwd=ROOT, env=env, capture_output=True,
                          text=True, encoding="utf-8", timeout=timeout)


def end_sidecar(root: Path) -> None:
    """Whatever sidecar the discovery file names is ended (the test failed before it left)."""
    info = discovery.read_instance(root)
    if info is not None and discovery.holder_alive_hint(info):
        try:
            os.kill(info.pid, signal.SIGTERM)  # Windows: TerminateProcess.
        except OSError:
            pass


def wait_for(condition, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while True:
        value = condition()
        if value:
            return value
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.1)


def assert_lock_is_free(root: Path, timeout: float = 5.0) -> None:
    """The library's lock can be taken (a sidecar that has just left may hold it a moment longer: on Windows
    the handle goes when the process has really ended), within `timeout` seconds."""
    deadline = time.monotonic() + timeout
    attempts = 0
    while True:
        attempts += 1
        lock = LibraryLock()
        if lock.try_acquire(root):
            lock.release()
            return
        if time.monotonic() >= deadline:
            info = discovery.read_instance(root)
            holder = (f"discovery file: pid {info.pid} ({info.launcher}), "
                      f"{'alive' if discovery.holder_alive_hint(info) else 'gone'}" if info else "no discovery file")
            pytest.fail(f"the library's lock was still held after {attempts} tries in {timeout:g} s; {holder}")
        time.sleep(0.1)


def test_the_cli_starts_a_headless_sidecar_and_it_leaves_by_itself(tmp_path, monkeypatch):
    env = cli_environment(tmp_path, monkeypatch)
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    try:
        result = run_cli(env, "--json", "--idle", "2", "folder", "list")
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {"folders": [], "unfiled": 0}  # stdout is the document and nothing else.
        assert "起動しています" in result.stderr
        info = discovery.read_instance(root)
        assert info is not None and info.launcher == "cli" and info.token and len(info.token) == 64
        # Nothing is asked of it any more: it removes its file and frees the library on its own.
        wait_for(lambda: discovery.read_instance(root) is None, 40, "the sidecar to leave")
        wait_for(lambda: not discovery.holder_alive_hint(info), 20, "its process to end")
        assert_lock_is_free(root)
    finally:
        end_sidecar(root)


def test_a_second_command_reuses_the_running_sidecar_and_server_stop_ends_it(tmp_path, monkeypatch):
    env = cli_environment(tmp_path, monkeypatch)
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    try:
        first = run_cli(env, "--json", "--idle", "30", "folder", "create", "試験")
        assert first.returncode == 0, first.stderr
        started = discovery.read_instance(root)
        assert started is not None
        second = run_cli(env, "--json", "--idle", "1", "folder", "list")
        assert second.returncode == 0, second.stderr
        assert json.loads(second.stdout)["folders"] == [{"name": "試験", "papers": 0}]
        assert "起動しています" not in second.stderr  # Not started again.
        status = run_cli(env, "--json", "--no-spawn", "status")
        assert status.returncode == 0, status.stderr
        data = json.loads(status.stdout)
        assert data["instance"]["pid"] == started.pid and data["instance"]["launcher"] == "cli"
        assert data["instance"]["idle_exit"] == 30.0  # The first command's --idle: the one that started it.
        assert discovery.read_instance(root) == started
        stopped = run_cli(env, "--json", "server", "stop")
        assert stopped.returncode == 0, stopped.stderr
        assert json.loads(stopped.stdout)["stopped"] is True
        wait_for(lambda: discovery.read_instance(root) is None, 20, "the discovery file to go")
        assert_lock_is_free(root)
        # With nothing running, stop is a no-op that starts nothing.
        again = run_cli(env, "--json", "server", "stop")
        assert again.returncode == 0 and json.loads(again.stdout)["running"] is False
    finally:
        end_sidecar(root)


def test_the_cli_talks_to_a_window_sidecar_that_took_over_from_its_own(tmp_path, monkeypatch):
    env = cli_environment(tmp_path, monkeypatch)
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    window = None
    try:
        first = run_cli(env, "--json", "--idle", "60", "folder", "create", "試験")
        assert first.returncode == 0, first.stderr
        headless = discovery.read_instance(root)
        assert headless is not None and headless.launcher == "cli"
        # The window starts: its sidecar asks the headless one to shut down and takes the library over.
        window = subprocess.Popen([sys.executable, "-m", "sidecar"], cwd=ROOT, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  env={**env, "PAPEER_LAUNCHER": "app", "PAPEER_PORT": "0", "PAPEER_TOKEN": "window-token"})
        info = wait_for(lambda: (i := discovery.read_instance(root)) is not None and i.pid != headless.pid and i, 90,
                        "the window's discovery file")
        assert info.launcher == "app" and info.token == "window-token"
        # The CLI follows the file to it (verified with its token), starts nothing, and sees the same library.
        result = run_cli(env, "--json", "--no-spawn", "folder", "list", timeout=60)
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["folders"] == [{"name": "試験", "papers": 0}]
        status = json.loads(run_cli(env, "--json", "--no-spawn", "status").stdout)
        assert status["instance"]["launcher"] == "app" and status["instance"]["pid"] == info.pid
        # It does not stop a window's sidecar.
        stop = run_cli(env, "--json", "server", "stop")
        assert stop.returncode == 1 and "ウィンドウ" in stop.stderr
        assert discovery.read_instance(root) == info
    finally:
        end_sidecar(root)
        if window is not None:
            try:
                window.wait(30)
            except subprocess.TimeoutExpired:
                window.kill()
                window.wait(30)


@pytest.mark.slow
def test_an_import_goes_on_when_the_window_takes_the_library_over_mid_job(tmp_path, monkeypatch):
    """The reconnect of run_job against real processes: the window's sidecar shuts the headless one down while
    it imports (the import is cancelled, not by the user), and the CLI starts the import again on the window's."""
    import pymupdf

    env = cli_environment(tmp_path, monkeypatch)
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    pdfs = tmp_path / "pdfs"
    pdfs.mkdir()
    count = 150
    for number in range(count):
        document = pymupdf.open()
        page = document.new_page()
        for line in range(30):
            page.insert_text((72, 72 + line * 20), f"Paper {number} line {line}: adaptive control {number * line}", fontsize=10)
        document.save(pdfs / f"p{number:03d}.pdf")
    window = None
    cli = subprocess.Popen([sys.executable, "-m", "papeer.cli", "--json", "--idle", "5", "add", str(pdfs), "-r"], cwd=ROOT,
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        headless = wait_for(lambda: discovery.read_instance(root), 60, "the headless sidecar's file")
        time.sleep(2)  # Some PDFs are in.
        window = subprocess.Popen([sys.executable, "-m", "sidecar"], cwd=ROOT, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  env={**env, "PAPEER_LAUNCHER": "app", "PAPEER_PORT": "0", "PAPEER_TOKEN": "window-token"})
        stdout, stderr = cli.communicate(timeout=240)
        assert cli.returncode == 0, stderr
        assert "接続し直して同じ処理をやり直します" in stderr, "the import was over before the window took the library"
        data = json.loads(stdout)
        assert len(data["papers"]) == count and all(item["paper_id"] for item in data["papers"])
        info = discovery.read_instance(root)
        assert info is not None and info.launcher == "app" and info.pid != headless.pid
    finally:
        if cli.poll() is None:
            cli.kill()
            cli.communicate()
        end_sidecar(root)
        if window is not None:
            try:
                window.wait(30)
            except subprocess.TimeoutExpired:
                window.kill()
                window.wait(30)


def test_no_spawn_without_a_sidecar_exits_3_and_starts_nothing(tmp_path, monkeypatch):
    env = cli_environment(tmp_path, monkeypatch)
    root = Path(env["PAPEER_DATA_DIR"]).resolve()
    try:
        result = run_cli(env, "--no-spawn", "--json", "ls")
        assert result.returncode == 3
        assert result.stdout == "" and "Papeer が起動していません。" in result.stderr
        assert discovery.read_instance(root) is None
        assert_lock_is_free(root)
    finally:
        end_sidecar(root)


@pytest.mark.skipif(os.name != "nt", reason="the Windows console code page")
def test_output_to_a_pipe_is_utf8(tmp_path, monkeypatch):
    # PYTHONUTF8 off: a pipe's encoding is then the ANSI code page (cp932 on a Japanese Windows).
    env = cli_environment(tmp_path, monkeypatch)
    env.pop("PYTHONUTF8")
    result = subprocess.run([sys.executable, "-m", "papeer.cli", "--no-spawn", "ls"], cwd=ROOT, env=env,
                            capture_output=True)
    assert result.returncode == 3
    assert "Papeer が起動していません。" in result.stderr.decode("utf-8")
