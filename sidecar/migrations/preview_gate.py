"""Lifetime gate for the read-only Native Notebook preview worker.

The preview extraction runs on a thread owned by this gate (not asyncio.to_thread),
so an HTTP disconnect or a cancelled route never hides a still-running reader.
Shutdown closes the gate stickily (no new preview until the process ends), cancels
the running preview and waits for the real thread, not just for a flag.

This module depends on no other sidecar module so that it can be imported by the
preparation coordinator, the preview reader, the routes and the shutdown path
without an import cycle. Other modules must reference `preview_gate.gate` as a
module attribute (never `from ... import gate`) so tests can replace it.
"""
from __future__ import annotations

from concurrent.futures import Future
import threading
import time


class PreviewToken:
    """One admitted preview. `owner` is the preparation coordinator seen at admission (identity only)."""
    def __init__(self, run_id, kind, owner):
        self.run_id = run_id
        self.kind = kind
        self.owner = owner
        self.cancel = threading.Event()
        self.done = threading.Event()
        self.thread = None


class PreviewGate:
    def __init__(self):
        self._lock = threading.Lock()
        self._closed = False
        self._token = None

    def admit(self, run_id, kind, owner):
        with self._lock:
            if self._closed:
                raise ValueError('preview-shutdown-pending')
            if self._token is not None:
                raise ValueError('preview-busy')
            token = PreviewToken(run_id, kind, owner)
            self._token = token
            return token

    def start(self, token, target):
        """Run target(token) on a named daemon thread; the Future carries its result or exception."""
        future = Future()
        # Mark it running now: cancelling the awaiting asyncio wrapper must not
        # cancel this Future, because the thread keeps running and reports into it.
        future.set_running_or_notify_cancel()

        def run():
            try:
                future.set_result(target(token))
            except BaseException as error:  # noqa: BLE001 - delivered to the waiting route
                future.set_exception(error)
            finally:
                # The target's own finally normally calls finish() after its
                # working directory is gone; this is idempotent and only
                # prevents a target that forgot from keeping the gate busy.
                self.finish(token)

        thread = threading.Thread(target=run, name='Native-notebook-preview', daemon=True)
        token.thread = thread
        try:
            thread.start()
        except BaseException:
            # Thread.start can fail after the native thread already exists. An
            # unknown start stays busy (never reopen on unknown state).
            if thread.ident is None or not thread.is_alive():
                self.finish(token)
            raise
        return future

    def finish(self, token):
        """Mark the worker finished. Call only at the very end of the worker's finally."""
        with self._lock:
            token.done.set()
            if self._token is token:
                self._token = None

    def close(self):
        """Sticky: no new preview is admitted until the process ends; the running one is cancelled."""
        with self._lock:
            self._closed = True
            token = self._token
        if token is not None:
            token.cancel.set()

    @property
    def closed(self):
        with self._lock:
            return self._closed

    def inflight(self):
        with self._lock:
            return self._token is not None

    def wait_idle(self, timeout):
        """True when no preview worker thread exists any more (done flag and real thread join)."""
        deadline = time.monotonic() + max(0, timeout)
        with self._lock:
            token = self._token
        if token is None:
            return True
        if not token.done.wait(max(0, deadline - time.monotonic())):
            return False
        thread = token.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(max(0, deadline - time.monotonic()))
            if thread.is_alive():
                return False
        return True


gate = PreviewGate()
