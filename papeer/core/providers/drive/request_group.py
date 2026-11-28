"""Host-private bounded HTTP cancellation. No credential or authority mutation.

One timer per active pass, no worker pool. Socket shutdown interrupts active
headers/body reads. OS DNS resolution itself is not synchronously cancellable;
registration and post-connect checks reject a late connection after cancellation.
"""
from contextlib import contextmanager
import socket
import threading
import time


class ProviderRequestCancelled(ValueError):
    pass


def _interrupt(target, sock):
    connection_socket = sock if sock is not None else getattr(target, 'sock', None)
    if connection_socket is not None:
        try: connection_socket.shutdown(socket.SHUT_RDWR)
        except OSError: pass
        try:
            descriptor = connection_socket.detach()
            if descriptor >= 0: socket.close(descriptor)
        except (OSError, ValueError): pass
    # Never close any response OR HTTPConnection from the cancelling thread:
    # HTTPConnection.close can close its attached buffered response and wait for
    # that reader's lock. Shutdown every tracked socket; owner finally closes.



class ProviderRequestGroup:
    def __init__(self, timeout=120):
        self._lock = threading.Lock(); self._cancelled = threading.Event()
        self._deadline = time.monotonic() + timeout
        self._timed_out = False; self._closed = False; self._entries = {}
        self._timer = threading.Timer(timeout, self._expire)
        self._timer.daemon = True; self._timer.start()

    def _expire(self):
        self.cancel(deadline=True)

    def check(self):
        if self._cancelled.is_set():
            raise ProviderRequestCancelled('provider-io-deadline' if self._timed_out else 'provider-io-cancelled')
        if time.monotonic() >= self._deadline:
            self.cancel(deadline=True); self.check()

    def remaining(self):
        self.check(); return max(.001, self._deadline - time.monotonic())

    def cancel(self, *, deadline=False):
        with self._lock:
            if deadline: self._timed_out = True
            self._cancelled.set()
            # Serialize exact socket retirement against owning-thread cleanup.
            for target, sock in tuple(self._entries.values()):
                try: _interrupt(target, sock)
                except (OSError, ValueError): pass

    def close(self):
        with self._lock:
            if self._closed: return
            self._closed = True
        self.cancel(); self._timer.cancel()
        if threading.current_thread() is not self._timer: self._timer.join(timeout=1)

    @contextmanager
    def request(self):
        self.check(); entries = []
        class Ticket:
            def check(ticket): self.check()
            def remaining(ticket): return self.remaining()
            def register(ticket, target, sock=None):
                key = object()
                with self._lock:
                    cancelled = self._cancelled.is_set()
                    if not cancelled:
                        self._entries[key] = (target, sock); entries.append(key)
                if cancelled:
                    _interrupt(target, sock); target.close(); self.check()
                self.check()
        try: yield Ticket()
        finally:
            with self._lock:
                values = [self._entries.pop(key) for key in entries if key in self._entries]
                for target, _sock in values:
                    try: target.close()
                    except (OSError, ValueError): pass
