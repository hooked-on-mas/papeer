"""The one Papeer sidecar that serves a library at a time, and the file that tells others where it is.

Two files per library, in this PC's device folder (paths.device_directory()/instances: never synced or
backed up, as it names a process and a port of this PC only):

    <key>.lock   held (a lock on its first byte, see file_lock) by the process that serves the library, for
                 as long as it lives: the OS frees it when the process dies, however it dies. It never
                 holds data, as Windows lets no other handle read a locked byte range.
    <key>.json   what that process wrote once it listened: its pid, port and token, who started it, and
                 the library's folder (InstanceInfo). Written by the lock's holder only, replaced whole.

<key> is a digest of the library's resolved folder (instance_key), so two Papeers pointed at one library
by different spellings of its path still meet at the same lock.

Readers (the CLI, a second app) find the holder through the .json file but must not trust it: a process
killed hard leaves the file behind (remove_instance runs on a clean exit only), and its pid may belong to
another program by now. They check the file's claim with the sidecar itself (its /api/instance answering
with the same token, pid and data_dir), or by taking the lock (LibraryLock.try_acquire), which is the
only proof that nobody serves the library. holder_alive_hint is a cheap way to skip the wait for a
connection to a pid that is certainly gone; it proves nothing in the other direction.

The token on disk can be read by the OS user who runs Papeer, and by no other (0600 where the platform
has modes, the user's own folder on Windows). That user can already read the library and the settings
file holding the AI keys, so who may talk to the sidecar is unchanged: this file adds no one.

Standard library and papeer.core.paths / fileio / file_lock only: the CLI imports it without the app's
heavy packages. No network code here.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
from typing import IO

from papeer.core import file_lock
from papeer.core.fileio import atomic_write_json
from papeer.core.paths import device_directory

FORMAT = 1
# Who started the sidecar: the installed app, the dev recipe (just dev-sidecar), or the CLI (headless).
LAUNCHERS = ("app", "dev", "cli")
# A file larger than this is not ours (it holds a few hundred bytes).
_MAX_BYTES = 64 * 1024
# No pid is larger (Windows pids are 32-bit unsigned, POSIX ones signed): a bigger number is garbage, which
# os.kill and OpenProcess would not take.
_MAX_PID = 2**31


@dataclass
class InstanceInfo:
    """What the process serving a library tells about itself."""
    pid: int
    port: int
    token: str | None
    launcher: str
    data_dir: str
    version: str
    started_at: float
    format: int = FORMAT

    def to_dict(self) -> dict:
        data = asdict(self)
        return {"format": data.pop("format"), **data}


def instance_folder() -> Path:
    """Where the instance files of every library of this PC are (created when written to)."""
    return device_directory() / "instances"


def instance_key(root: Path) -> str:
    """The name the instance files of the library at `root` go by: a digest of its resolved folder.

    Computed as paths.library_key is, except that the path is case-normalised first (os.path.normcase:
    Windows ignores case and the library's folder may not exist yet when it is spelled two ways), as
    two keys for one library would let two sidecars serve it. On macOS and Linux it is paths.library_key.
    """
    resolved = os.path.normcase(str(Path(root).resolve()))
    return hashlib.sha256(resolved.encode()).hexdigest()


def lock_path(root: Path) -> Path:
    return instance_folder() / (instance_key(root) + ".lock")


def info_path(root: Path) -> Path:
    return instance_folder() / (instance_key(root) + ".json")


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def read_instance(root: Path) -> InstanceInfo | None:
    """What the process serving the library at `root` wrote, or None.

    Never raises: a missing, unreadable, garbled, half-written, oversized or other-format file, and one
    whose fields are not of the types they should be, all give None. Unknown extra fields are ignored.
    A value read is a claim only (see the module's docstring): whether anyone is there is not known.
    """
    try:
        with open(info_path(root), "rb") as stream:
            raw = stream.read(_MAX_BYTES + 1)
        if len(raw) > _MAX_BYTES:
            return None
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or not _is_int(data.get("format")) or data["format"] != FORMAT:
        return None
    if not all(key in data for key in ("pid", "port", "token", "launcher", "data_dir", "version", "started_at")):
        return None
    pid, port, token = data["pid"], data["port"], data["token"]
    launcher, data_dir, version, started_at = data["launcher"], data["data_dir"], data["version"], data["started_at"]
    if not (_is_int(pid) and 0 < pid < _MAX_PID and _is_int(port) and 0 < port < 65536):
        return None
    if not (token is None or isinstance(token, str)):
        return None
    if launcher not in LAUNCHERS or not isinstance(data_dir, str) or not isinstance(version, str):
        return None
    if not _is_number(started_at):
        return None
    return InstanceInfo(pid=pid, port=port, token=token, launcher=launcher, data_dir=data_dir, version=version,
                        started_at=float(started_at))


def _ensure_folder() -> Path:
    folder = instance_folder()
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        try:
            os.chmod(folder, 0o700)
        except OSError:
            pass  # Not ours to change (a shared mount, say): the files keep their own 0600.
    return folder


def write_instance(root: Path, info: InstanceInfo) -> None:
    """Publish `info` for the library at `root`, whole or not at all.

    Written through fileio.atomic_write_json: a temporary file made with mode 0600 beside the target
    (tempfile.mkstemp), flushed, then os.replace (retried for some seconds: a Windows reader that has the
    file open at that moment makes the replace fail). Only the process holding the library's lock calls it.
    """
    if info.launcher not in LAUNCHERS:
        raise ValueError(f"unknown launcher: {info.launcher!r}")
    _ensure_folder()
    atomic_write_json(info_path(root), info.to_dict(), indent=None)


def remove_instance(root: Path, pid: int) -> bool:
    """Delete the info file of the library at `root` if it holds `pid`; whether it did.

    The holder calls it on a clean exit, before releasing the lock (so that no successor's file is
    removed by mistake: a file of another pid is left alone). Never raises: on Windows a reader that
    has the file open makes the unlink fail (PermissionError), and the exit goes on all the same (the
    stale file is told apart by whoever reads it: see the module's docstring), so that is False too.
    """
    info = read_instance(root)
    if info is None or info.pid != pid:
        return False
    try:
        info_path(root).unlink()
    except OSError:  # FileNotFoundError (removed meanwhile) included.
        return False
    return True


def holder_alive_hint(info: InstanceInfo) -> bool:
    """Whether a process with the pid of `info` exists: False means certainly gone, True only "maybe".

    A pid can be reused by another program, so a True still has to be checked with the sidecar itself.
    """
    pid = info.pid
    if not 0 < pid < _MAX_PID:
        return False
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        process = kernel32.OpenProcess(0x1000, 0, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not process:
            # Access denied: it exists (another user's, or protected); anything else: no such process.
            return ctypes.get_last_error() == 5
        try:
            code = ctypes.c_uint32()
            if not kernel32.GetExitCodeProcess(ctypes.c_void_p(process), ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(process)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError, ValueError):  # An absurd pid that os.kill refuses.
        return False
    return True


class LibraryLock:
    """The right to serve a library: held from try_acquire until release or until the process ends.

    The handle stays open for the life of the process (closing it, or the process dying, frees the OS
    lock). Handles of other processes and of other LibraryLock objects of this process are shut out too.
    """

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._handle: IO[bytes] | None = None
        self._key: str | None = None

    @property
    def held(self) -> bool:
        return self._handle is not None

    def try_acquire(self, root: Path) -> bool:
        """Take the library's lock without waiting: False when another process (or object) holds it.

        Taking it again while this object holds it for the same library is True at once; for another
        library it is a ValueError (one object stands for one library).
        """
        key = instance_key(root)
        with self._guard:
            if self._handle is not None:
                if key != self._key:
                    raise ValueError("this lock already holds another library")
                return True
            _ensure_folder()
            handle = file_lock.open_lock_file(lock_path(root))
            try:
                acquired = file_lock.try_lock(handle)
            except BaseException:
                handle.close()
                raise
            if not acquired:
                handle.close()
                return False
            self._handle, self._key = handle, key
            return True

    def release(self) -> None:
        """Let go of the lock (a no-op when not held). The info file is removed first, by remove_instance."""
        with self._guard:
            handle, self._handle, self._key = self._handle, None, None
        if handle is not None:
            file_lock.unlock(handle)
