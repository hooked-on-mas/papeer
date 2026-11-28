"""Synchronous cooperative device-writer authority shared by all Libraries.

The OS lock excludes updated cooperating processes, not arbitrary filesystem
tools or old binaries. Lock ownership never certifies external writer absence.
No credential, Library content or caller-supplied root is stored in this file.
"""
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import wraps
import os
from pathlib import Path
import stat
import threading
import time
from typing import IO, ParamSpec, TypeVar

from papeer.core import file_lock, paths
from papeer.core.errors import Conflict

PROTOCOL = 1
LOCK_NAME = '.device-writer-v1.lock'
DEFAULT_TIMEOUT = 5.0
_gate = threading.RLock()
_local = threading.local()
_retained: 'MaintenanceLease | None' = None
_P = ParamSpec('_P')
_R = TypeVar('_R')


class DeviceWriterBusy(Conflict):
    """No write was admitted; never an OSError that migration fallback swallows."""
    def __init__(self, code: str):
        super().__init__('この端末の保存処理は保守処理中です。終了してから再試行してください。', code=code)


class DeviceWriterUnavailable(Conflict):
    """Unsafe identity/unsupported lock error: refuse the write, never unlocked fallback."""
    def __init__(self, code: str):
        super().__init__('この端末の保存先の安全性を確認できないため、保存を保留しています。', code=code)


def _directory(*, create: bool = True) -> Path:
    root = paths.device_directory().absolute()
    # Check existing ancestors BEFORE creating the app-owned directory. Inspect
    # the raw path, not resolve(), which would erase a junction/symlink identity.
    for path in reversed((root, *root.parents)):
        try:
            value = path.lstat()
        except FileNotFoundError:
            continue
        if (not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode)
                or getattr(value, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise DeviceWriterUnavailable('device-writer-unsafe-root')
    if create:
        root.mkdir(parents=True, exist_ok=True)
    else:
        _identity(root)
    return root


def _identity(root: Path) -> tuple[int, int]:
    value = root.lstat()
    if (not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode)
            or getattr(value, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
        raise DeviceWriterUnavailable('device-writer-root-changed')
    return value.st_dev, value.st_ino


def _open(root: Path, deadline: float) -> IO[bytes]:
    path = root / LOCK_NAME
    # Do not follow an already-present link for the lock itself.
    if path.exists() or path.is_symlink() or path.is_junction():
        value = path.lstat()
        if (not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode)
                or getattr(value, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise DeviceWriterUnavailable('device-writer-unsafe-lock')
    handle = file_lock.open_lock_file(path)
    try:
        while not file_lock.try_lock(handle):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DeviceWriterBusy('device-writer-busy')
            time.sleep(min(.025, remaining))
        opened, current = os.fstat(handle.fileno()), path.lstat()
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise DeviceWriterUnavailable('device-writer-lock-replaced')
        return handle
    except BaseException:
        # Closing releases any acquired OS lock, including an interrupted claim.
        handle.close()
        raise


@contextmanager
def writer(*, timeout: float = DEFAULT_TIMEOUT) -> Iterator[None]:
    """Short synchronous mutation; acquire before module/history credential locks.

    Nested calls on this thread reuse the exact handle and root. There is no
    asynchronous lifetime, no background worker and no network wait here.
    """
    deadline = time.monotonic() + max(0, timeout)
    if not _gate.acquire(timeout=max(0, deadline - time.monotonic())):
        raise DeviceWriterBusy('device-writer-busy')
    handle = None
    try:
        root = _directory()
        depth = getattr(_local, 'depth', 0)
        if depth:
            if root != _local.root or _identity(root) != _local.identity:
                raise DeviceWriterUnavailable('device-writer-root-changed')
            _local.depth = depth + 1
        else:
            if _retained is not None:
                raise DeviceWriterBusy('device-maintenance-active')
            before = _identity(root)
            handle = _open(root, deadline)
            if _identity(root) != before:
                raise DeviceWriterUnavailable('device-writer-root-changed')
            _local.root, _local.identity, _local.depth = root, before, 1
            _local.handle = handle
        try:
            yield
        finally:
            _local.depth -= 1
    finally:
        try:
            if handle is not None:
                _local.handle = None
                file_lock.unlock(handle)
        finally:
            _gate.release()


def device_writer(function: Callable[_P, _R]) -> Callable[_P, _R]:
    """Keep each read/modify/write unit under one lease, not only its final rename."""
    @wraps(function)
    def guarded(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        with writer():
            return function(*args, **kwargs)
    return guarded


def assert_writer() -> None:
    if not getattr(_local, 'depth', 0):
        raise DeviceWriterUnavailable('device-writer-not-held')


class MaintenanceLease:
    """Exact-owner retained handle; may release on another domestic shutdown thread.

    No RLock remains owned by the capture worker after it returns. The process
    reservation rejects local writers and the retained file handle excludes
    cooperating external writers until explicit drained-lifetime disposal.
    """
    def __init__(self, root: Path, identity: tuple[int, int], handle: IO[bytes]):
        self.root, self.identity = root, identity
        self._handle: IO[bytes] | None = handle

    def assert_current(self) -> None:
        with _gate:
            if (_retained is not self or self._handle is None
                    or _directory(create=False) != self.root or _identity(self.root) != self.identity):
                raise DeviceWriterUnavailable('device-maintenance-lost')
            current = (self.root / LOCK_NAME).lstat()
            opened = os.fstat(self._handle.fileno())
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise DeviceWriterUnavailable('device-maintenance-lock-replaced')

    def release(self) -> None:
        global _retained
        with _gate:
            if self._handle is None:
                return
            if _retained is not self:
                raise DeviceWriterUnavailable('device-maintenance-owner-mismatch')
            # Do not clear the local fence if unlock/close itself fails.
            file_lock.unlock(self._handle)
            self._handle = None
            _retained = None


def reserve_maintenance(*, timeout: float = DEFAULT_TIMEOUT) -> MaintenanceLease:
    global _retained
    deadline = time.monotonic() + max(0, timeout)
    if not _gate.acquire(timeout=max(0, deadline - time.monotonic())):
        raise DeviceWriterBusy('device-writer-busy')
    handle = None
    try:
        if _retained is not None or getattr(_local, 'depth', 0):
            raise DeviceWriterBusy('device-maintenance-active')
        root = _directory()
        identity = _identity(root)
        handle = _open(root, deadline)
        if _identity(root) != identity:
            raise DeviceWriterUnavailable('device-writer-root-changed')
        lease = MaintenanceLease(root, identity, handle)
        _retained = lease
        handle = None
        return lease
    finally:
        if handle is not None:
            handle.close()
        _gate.release()


def _after_fork() -> None:
    # A forked child must never reuse inherited reentrant ownership. Close its
    # descriptor copies without LOCK_UN (POSIX flock shares the description).
    global _gate, _local, _retained
    if _retained is not None and _retained._handle is not None:
        _retained._handle.close()
    inherited = getattr(_local, 'handle', None)
    if inherited is not None:
        inherited.close()
    _gate, _local, _retained = threading.RLock(), threading.local(), None


_register_at_fork = getattr(os, 'register_at_fork', None)
if callable(_register_at_fork):
    _register_at_fork(after_in_child=_after_fork)
