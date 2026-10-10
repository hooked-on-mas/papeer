"""Cross-process file locks (papeer.core.file_lock): exclusive between handles, processes and killed holders."""
from __future__ import annotations

import errno
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from papeer.core import file_lock

ROOT = Path(__file__).resolve().parents[1]

# A process that takes the lock on argv[2], says so, and holds it until its stdin closes.
HOLDER = """
import sys
sys.path.insert(0, sys.argv[1])
from papeer.core import file_lock
handle = file_lock.open_lock_file(__import__("pathlib").Path(sys.argv[2]))
print("held" if file_lock.try_lock(handle) else "busy", flush=True)
sys.stdin.read()
"""


class Busy(Exception):
    pass


def spawn_holder(path: Path) -> subprocess.Popen:
    process = subprocess.Popen([sys.executable, "-I", "-c", HOLDER, str(ROOT), str(path)], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, text=True)
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "held"
    return process


def stop(process: subprocess.Popen, *, kill: bool) -> None:
    if kill:
        process.kill()
    else:
        assert process.stdin is not None
        process.stdin.close()
    process.wait(timeout=10)
    for stream in (process.stdin, process.stdout):
        if stream is not None and not stream.closed:
            stream.close()


def try_until_free(path: Path, timeout: float = 5.0) -> bool:
    """Whether the lock on `path` becomes free within `timeout` (the OS lets go of a dead process's at once)."""
    deadline = time.monotonic() + timeout
    while True:
        handle = file_lock.open_lock_file(path)
        if file_lock.try_lock(handle):
            file_lock.unlock(handle)
            return True
        handle.close()
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def test_handles_of_one_process_shut_each_other_out(tmp_path):
    path = tmp_path / "x.lock"
    first, second = file_lock.open_lock_file(path), file_lock.open_lock_file(path)
    try:
        assert file_lock.try_lock(first) is True
        assert file_lock.try_lock(second) is False
        with pytest.raises(OSError):
            file_lock.lock(second)
        file_lock.unlock(first)
        assert first.closed
        assert file_lock.try_lock(second) is True
    finally:
        second.close()
        first.close()
    assert path.read_bytes() == b""  # A lock file holds no data.


def test_try_lock_raises_what_is_not_a_held_lock(tmp_path, monkeypatch):
    def broken(handle):
        raise OSError(errno.ENOLCK, "no locks available")

    monkeypatch.setattr(file_lock, "lock", broken)
    with file_lock.open_lock_file(tmp_path / "x.lock") as handle, pytest.raises(OSError) as raised:
        file_lock.try_lock(handle)
    assert raised.value.errno == errno.ENOLCK


def test_acquire_waits_for_the_holder_then_gives_up_with_the_callers_error(tmp_path, monkeypatch):
    path = tmp_path / "x.lock"
    held = file_lock.acquire(path, 0, Busy)
    started = time.monotonic()
    with pytest.raises(Busy):
        file_lock.acquire(path, 0.3, Busy)
    assert 0.25 <= time.monotonic() - started < 5

    threading.Timer(0.3, file_lock.unlock, [held]).start()
    got = file_lock.acquire(path, 10, Busy)
    file_lock.unlock(got)
    # Nothing is left held or open after a refusal: the next one can take it at once.
    assert try_until_free(path, 0.0)


def test_the_lock_is_exclusive_between_processes_and_freed_when_the_holder_exits(tmp_path):
    path = tmp_path / "x.lock"
    holder = spawn_holder(path)
    try:
        handle = file_lock.open_lock_file(path)
        try:
            assert file_lock.try_lock(handle) is False
        finally:
            handle.close()
        with pytest.raises(Busy):
            file_lock.acquire(path, 0.2, Busy)
    finally:
        stop(holder, kill=False)
    assert try_until_free(path)


def test_a_killed_holder_does_not_leave_the_lock_held(tmp_path):
    path = tmp_path / "x.lock"
    holder = spawn_holder(path)
    assert not try_until_free(path, 0.0)
    stop(holder, kill=True)
    assert try_until_free(path)
