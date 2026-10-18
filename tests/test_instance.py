"""The library's single sidecar and its discovery file (papeer.core.instance)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from papeer.core import fileio, instance
from papeer.core.instance import InstanceInfo, LibraryLock
from papeer.core.paths import device_directory, library_key

ROOT = Path(__file__).resolve().parents[1]

# A process that serves the library at argv[2] (takes its lock), says so, and holds it until stdin closes.
SERVER = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from papeer.core.instance import LibraryLock
lock = LibraryLock()
print("held" if lock.try_acquire(Path(sys.argv[2])) else "busy", flush=True)
sys.stdin.read()
"""


def make_info(**changes) -> InstanceInfo:
    values = dict(pid=os.getpid(), port=8765, token="secret-token", launcher="cli", data_dir="D:/lib",
                  version="1.2.3", started_at=1_700_000_000.5)
    values.update(changes)
    return InstanceInfo(**values)


@pytest.fixture
def root(tmp_path) -> Path:
    folder = tmp_path / "library"
    folder.mkdir()
    return folder


def spawn_server(root: Path) -> subprocess.Popen:
    process = subprocess.Popen([sys.executable, "-I", "-c", SERVER, str(ROOT), str(root)], stdin=subprocess.PIPE,
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


def acquires_within(root: Path, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        lock = LibraryLock()
        if lock.try_acquire(root):
            lock.release()
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def test_the_files_are_two_per_library_in_the_device_folder(root):
    assert instance.instance_folder() == device_directory() / "instances"
    lock, info = instance.lock_path(root), instance.info_path(root)
    assert lock.parent == info.parent == instance.instance_folder()
    assert lock.suffix == ".lock" and info.suffix == ".json" and lock.stem == info.stem


def test_keys_are_stable_and_differ_per_library(tmp_path):
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir(), second.mkdir()
    assert instance.instance_key(first) == instance.instance_key(first)
    assert instance.instance_key(first) != instance.instance_key(second)
    assert instance.lock_path(first) != instance.lock_path(second)
    # A relative or dotted spelling of the same folder meets at the same files.
    assert instance.instance_key(first / ".." / "a") == instance.instance_key(first)
    if os.name != "nt":
        assert instance.instance_key(first) == library_key(first)


@pytest.mark.skipif(os.name != "nt", reason="Windows ignores the case of a path")
def test_a_windows_library_has_one_key_whatever_the_case_of_its_path(tmp_path):
    folder = tmp_path / "Library"  # Not created: resolve() cannot tell its case then.
    assert instance.instance_key(folder) == instance.instance_key(Path(str(folder).swapcase()))


def test_discovery_round_trip(root):
    assert instance.read_instance(root) is None
    info = make_info()
    instance.write_instance(root, info)
    assert instance.read_instance(root) == info
    # Another library's file is not this one's.
    other = root.parent / "other"
    other.mkdir()
    assert instance.read_instance(other) is None
    # Replaced whole by the next write.
    newer = make_info(port=9000, token=None, launcher="app")
    instance.write_instance(root, newer)
    assert instance.read_instance(root) == newer
    assert json.loads(instance.info_path(root).read_text("utf-8"))["format"] == 1


def test_an_unknown_launcher_is_not_written(root):
    with pytest.raises(ValueError):
        instance.write_instance(root, make_info(launcher="other"))
    assert not instance.info_path(root).exists()


@pytest.mark.parametrize("content", [
    pytest.param(b"", id="empty"), pytest.param(b"{", id="cut"), pytest.param(b'{"format": 1, "pid": 4', id="partial"),
    pytest.param(b"[]", id="list"), pytest.param(b"null", id="null"), pytest.param(b"\xff\xfe\x00", id="binary"),
    pytest.param(b"[" * 100000, id="deeply-nested"), pytest.param(b" " * (100 * 1024) + b"{}", id="oversized"),
])
def test_a_garbled_or_partial_file_reads_as_none(root, content):
    instance.instance_folder().mkdir(parents=True)
    instance.info_path(root).write_bytes(content)
    assert instance.read_instance(root) is None


def test_a_wrong_format_or_wrong_typed_field_reads_as_none(root):
    good = make_info().to_dict()
    instance.instance_folder().mkdir(parents=True)
    path = instance.info_path(root)
    path.write_text(json.dumps(good), "utf-8")
    assert instance.read_instance(root) == make_info()
    # Fields a later version adds are ignored.
    path.write_text(json.dumps({**good, "extra": [1]}), "utf-8")
    assert instance.read_instance(root) == make_info()
    for change in ({"format": 2}, {"format": "1"}, {"format": True}, {"pid": "1"}, {"pid": 0}, {"pid": True},
                   {"port": 0}, {"port": 70000}, {"port": "80"}, {"token": 5}, {"launcher": "x"},
                   {"data_dir": None}, {"version": 1}, {"started_at": "now"}, {"started_at": None}):
        path.write_text(json.dumps({**good, **change}), "utf-8")
        assert instance.read_instance(root) is None, change
    for missing in good:
        path.write_text(json.dumps({key: value for key, value in good.items() if key != missing}), "utf-8")
        assert instance.read_instance(root) is None, missing


@pytest.mark.skipif(os.name == "nt", reason="file modes are POSIX")
def test_the_file_and_its_folder_are_private(root):
    instance.write_instance(root, make_info())
    assert instance.info_path(root).stat().st_mode & 0o777 == 0o600
    assert instance.instance_folder().stat().st_mode & 0o777 == 0o700
    # Still 0600 when replaced.
    instance.write_instance(root, make_info(port=9))
    assert instance.info_path(root).stat().st_mode & 0o777 == 0o600


def test_no_temporary_file_is_left_beside_the_info(root):
    instance.write_instance(root, make_info())
    instance.write_instance(root, make_info(port=1234))
    assert sorted(path.name for path in instance.instance_folder().iterdir()) == [instance.info_path(root).name]


def test_write_retries_while_windows_holds_the_file(root, monkeypatch):
    instance.write_instance(root, make_info(port=1111))
    real_replace = os.replace
    attempts = []

    def held_once(source, target):
        attempts.append(1)
        if len(attempts) == 1:
            raise PermissionError("in use")
        real_replace(source, target)

    monkeypatch.setattr(fileio.os, "replace", held_once)
    monkeypatch.setattr(fileio.time, "sleep", lambda _: None)
    instance.write_instance(root, make_info(port=2222))
    assert len(attempts) == 2
    assert instance.read_instance(root).port == 2222


def test_a_failed_write_leaves_the_old_file_and_no_temporary(root, monkeypatch):
    instance.write_instance(root, make_info(port=1111))

    def always(source, target):
        raise PermissionError("in use")

    with monkeypatch.context() as patched:
        patched.setattr(fileio.os, "replace", always)
        patched.setattr(fileio.time, "sleep", lambda _: None)
        with pytest.raises(PermissionError):
            instance.write_instance(root, make_info(port=2222))
    assert instance.read_instance(root).port == 1111
    assert [path.name for path in instance.instance_folder().iterdir()] == [instance.info_path(root).name]


def test_remove_deletes_only_the_file_of_that_pid(root):
    assert instance.remove_instance(root, 123) is False  # Nothing there.
    instance.write_instance(root, make_info(pid=500))
    assert instance.remove_instance(root, 501) is False
    assert instance.read_instance(root).pid == 500
    assert instance.remove_instance(root, 500) is True
    assert instance.read_instance(root) is None
    assert not instance.info_path(root).exists()


def test_the_library_lock_is_exclusive_between_objects_of_one_process(root):
    first, second = LibraryLock(), LibraryLock()
    assert first.try_acquire(root) is True and first.held
    assert first.try_acquire(root) is True  # Idempotent.
    assert second.try_acquire(root) is False and not second.held
    with pytest.raises(ValueError):
        first.try_acquire(root.parent)
    # Another library is its own.
    other = root.parent / "other"
    other.mkdir()
    third = LibraryLock()
    assert third.try_acquire(other) is True
    third.release()
    first.release()
    first.release()  # No-op.
    assert not first.held
    assert second.try_acquire(root) is True
    second.release()


def test_the_library_lock_is_exclusive_between_processes_and_freed_on_exit(root):
    server = spawn_server(root)
    try:
        assert LibraryLock().try_acquire(root) is False
    finally:
        stop(server, kill=False)
    assert acquires_within(root)


def test_the_library_lock_is_freed_when_the_holder_is_killed(root):
    server = spawn_server(root)
    assert not acquires_within(root, 0.0)
    # The file the killed holder would have left behind is still there: the lock is what counts.
    instance.write_instance(root, make_info(pid=server.pid, launcher="cli"))
    stop(server, kill=True)
    assert instance.read_instance(root) is not None
    assert acquires_within(root)
    assert instance.holder_alive_hint(make_info(pid=server.pid)) is False


def test_the_holder_of_a_lock_does_not_make_the_info_unreadable(root):
    # A lock file and an info file are separate: the holder's lock must not block readers of the info.
    lock = LibraryLock()
    assert lock.try_acquire(root)
    try:
        instance.write_instance(root, make_info())
        assert instance.read_instance(root) == make_info()
        # Not read: Windows lets no other handle read a locked byte range, and a lock file holds nothing.
        assert instance.lock_path(root).stat().st_size == 0
    finally:
        lock.release()


def test_holder_alive_hint():
    assert instance.holder_alive_hint(make_info(pid=os.getpid())) is True
    assert instance.holder_alive_hint(make_info(pid=-1)) is False
    process = subprocess.Popen([sys.executable, "-I", "-c", "pass"])
    process.wait(timeout=30)
    assert instance.holder_alive_hint(make_info(pid=process.pid)) is False


def test_a_file_that_cannot_be_deleted_is_left_and_reported_not_raised(root, monkeypatch):
    # Windows: a reader that has the JSON open makes unlink raise PermissionError. The exit goes on.
    instance.write_instance(root, make_info(pid=500))

    def refuse(self, *args, **kwargs):
        raise PermissionError(13, "in use")
    with monkeypatch.context() as patched:
        patched.setattr(Path, "unlink", refuse)
        assert instance.remove_instance(root, 500) is False
    assert instance.read_instance(root).pid == 500
    assert instance.remove_instance(root, 500) is True


@pytest.mark.parametrize("pid", [2**31, 2**63, 2**64 + 5])
def test_an_absurd_pid_is_not_a_holder(root, pid):
    assert instance.holder_alive_hint(make_info(pid=pid)) is False
    path = instance.info_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(make_info().to_dict() | {"pid": pid}), "utf-8")
    assert instance.read_instance(root) is None
