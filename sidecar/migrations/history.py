"""Retain the existing selected history OS locks without a thread-owned RLock.

Normal old/new history APIs lock the same first byte of history/<key>/.lock.
These handles may be released by domestic shutdown after the worker finishes.
They do not certify arbitrary tools or unselected histories have stopped.
"""
import os
import threading
import time

from papeer.core import file_lock
from papeer.core.migrations.legacy_backup import _safe_stat


class RetainedHistories:
    def __init__(self):
        self._guard = threading.RLock()
        self._handles = []
        self._closed = False
        self._cleanup_unknown = False
        self._uncertain_count = 0

    def assert_current(self):
        with self._guard:
            if self._cleanup_unknown:
                raise ValueError('maintenance-history-cleanup-unknown')
            if self._closed:
                raise ValueError('maintenance-history-owner-closed')
            for folder, identity, path, handle in self._handles:
                value = _safe_stat(folder, directory=True)
                if (value.st_dev, value.st_ino) != identity:
                    raise ValueError('maintenance-history-identity-changed')
                current, opened = _safe_stat(path), os.fstat(handle.fileno())
                if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                    raise ValueError('maintenance-history-lock-replaced')

    def release(self):
        with self._guard:
            if self._cleanup_unknown:
                raise ValueError('maintenance-history-cleanup-unknown')
            if self._closed:
                return
            while self._handles:
                _folder, _identity, _path, handle = self._handles[-1]
                try:
                    file_lock.unlock(handle)
                except BaseException:
                    # The actual primitive closes in finally, even on error.
                    # Do NOT claim this OS lock remains held or retry a closed
                    # descriptor. Keep an explicit unknown cleanup outcome and
                    # any other still-held handles; domestic disposal refuses.
                    self._handles.pop()
                    self._uncertain_count += 1
                    self._cleanup_unknown = True
                    raise
                else:
                    self._handles.pop()
            self._closed = True


def retain_selected_histories(selection, timeout=5):
    """Called only after own drain and after retaining device authority.

    Existing folders get their actual legacy history lock. Missing histories
    are not created: supported same-Library normal writers are already excluded
    by its held LibraryLock, and current selection checks reject a late folder.
    """
    selection.assert_current()
    deadline = time.monotonic() + max(0, timeout)
    owner = RetainedHistories()
    try:
        for key, identity in selection.history_refs:
            if identity is None:
                continue
            folder = selection.device / 'history' / key
            value = _safe_stat(folder, directory=True)
            if (value.st_dev, value.st_ino) != identity:
                raise ValueError('maintenance-history-identity-changed')
            path = folder / '.lock'
            if path.exists() or path.is_symlink() or path.is_junction():
                _safe_stat(path)
            handle = file_lock.open_lock_file(path)
            try:
                while not file_lock.try_lock(handle):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError('maintenance-history-busy')
                    time.sleep(min(.025, remaining))
                opened, current = os.fstat(handle.fileno()), _safe_stat(path)
                if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
                    raise ValueError('maintenance-history-lock-replaced')
                owner._handles.append((folder, identity, path, handle))
                handle = None
            finally:
                if handle is not None:
                    handle.close()
        owner.assert_current()
        selection.assert_current()
        return owner
    except BaseException:
        owner.release()
        raise
