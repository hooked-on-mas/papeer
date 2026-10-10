"""Cross-process locks on a file: the OS releases one when its holder exits or is killed.

A lock is taken on the first byte of a file that is kept open for as long as the lock is held:
msvcrt.locking (LK_NBLCK) on Windows, flock (LOCK_EX | LOCK_NB) elsewhere. Both fail at once when another
handle holds it, in this process as well as in others, so the callers see one rule everywhere.

A lock file must never hold data. On Windows a locked byte range cannot be read by other handles (not even
for a look at what the holder wrote), and the lock sits on byte 0 whether or not the file has one. What
the holder wants to publish goes into another file (see papeer.core.instance).

Used by papeer.core.local_history (the history of a library, waited for) and papeer.core.instance (the
library's single running Papeer, never waited for).
"""
from __future__ import annotations

from collections.abc import Callable
import errno
from pathlib import Path
import sys
import time
from typing import IO

# How long acquire sleeps between two attempts.
RETRY_INTERVAL = 0.1
# What failing to take a lock that another handle holds raises: EACCES (msvcrt and flock on some systems),
# EAGAIN / EWOULDBLOCK (flock), EDEADLK (msvcrt after its own retries; the same number as EDEADLOCK on Windows).
_BUSY = frozenset({errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK})


def lock(handle: IO[bytes]) -> None:
    """Take the lock on `handle` at once; OSError when another handle (of any process) holds it."""
    handle.seek(0)
    if sys.platform == "win32":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def try_lock(handle: IO[bytes]) -> bool:
    """Take the lock on `handle` at once: whether it was free.

    Only "another handle holds it" is False; any other OSError (a file system that cannot lock, say) is
    raised, so that it never passes for a second Papeer.
    """
    try:
        lock(handle)
    except OSError as error:
        if error.errno in _BUSY:
            return False
        raise
    return True


def unlock(handle: IO[bytes]) -> None:
    """Release the lock on `handle` and close it (closing alone would release it too; this is explicit)."""
    try:
        handle.seek(0)
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def open_lock_file(path: Path) -> IO[bytes]:
    """Open (creating if need be) the lock file at `path` for locking; the folder must exist."""
    return open(path, "a+b")  # noqa: SIM115 - kept open while the lock is held, closed by unlock


def acquire(path: Path, wait_seconds: float, on_timeout: Callable[[], BaseException]) -> IO[bytes]:
    """The lock file at `path`, opened and locked; waits up to `wait_seconds` for another handle to let go.

    Gives up by raising what `on_timeout()` returns (the caller's own error, with its own message). The
    handle is returned still open: release it with unlock.
    """
    handle = open_lock_file(path)
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            lock(handle)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise on_timeout() from None
            time.sleep(RETRY_INTERVAL)
