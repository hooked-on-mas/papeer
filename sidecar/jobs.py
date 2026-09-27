from __future__ import annotations

import asyncio
from contextlib import contextmanager
import re
import threading
import time
import uuid
from typing import Any, Callable, Iterator

from papeer.core.errors import Conflict
from sidecar.errors import job_error_message
from sidecar.schemas import JobInfo

COUNTER = re.compile(r"(\d+)\s*/\s*(\d+)")
# The jobs that copy or replace the whole library (deps.SNAPSHOT_JOBS names the same ones).
SNAPSHOT_KINDS = frozenset({"backup", "restore", "drive-sync"})


class JobManager:
    def __init__(self, event_loop: asyncio.AbstractEventLoop | None = None) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, JobInfo] = {}
        self._events: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._listeners: set[asyncio.Queue] = set()
        self._loop = event_loop
        self._closed = False
        # The changes running under idle(): the paper each one waits on, None for the whole library.
        self._holds: dict[object, str | None] = {}

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def add_listener(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._listeners.add(queue)

    def remove_listener(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._listeners.discard(queue)

    def broadcast(self, data: dict[str, Any]) -> None:
        if not self._loop:
            return
        with self._lock:
            listeners = list(self._listeners)
        for queue in listeners:
            try:
                self._loop.call_soon_threadsafe(queue.put_nowait, data)
            except Exception:
                pass

    def get_jobs(self) -> list[JobInfo]:
        with self._lock:
            return list(self._jobs.values())

    def get_job(self, job_id: str) -> JobInfo | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel_job(self, job_id: str) -> bool:
        with self._lock:
            event = self._events.get(job_id)
            job = self._jobs.get(job_id)
            if not event or not job or not job.running:
                return False
            event.set()
            job.cancelled = True
            return True

    def close(self) -> int:
        """Refuse new jobs from now on and ask the running ones to stop; returns how many were running."""
        with self._lock:
            self._closed = True
            running = [job_id for job_id, job in self._jobs.items() if job.running]
        return sum(self.cancel_job(job_id) for job_id in running)

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no job thread is left running; False if some are still running after `timeout` seconds."""
        deadline = time.monotonic() + timeout
        with self._lock:
            threads = [self._threads[job_id] for job_id, job in self._jobs.items()
                       if job.running and job_id in self._threads]
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        return not any(thread.is_alive() for thread in threads)

    @contextmanager
    def idle(self, message: str, paper_id: str | None = None) -> Iterator[None]:
        """Run a change that must not overlap a job: ConcurrencyConflict(message) if one is running.

        With `paper_id`, only that paper's jobs count. Checked under the lock, and until the change is
        over no job it waits on may start (submit_job refuses it), so none starts between the check and
        the change, as it could when a route looked at get_jobs() first. A sync, backup or restore still
        starts, and waits for the request making the change to finish before it touches the library.
        """
        hold = object()
        with self._lock:
            if any(job.running and (paper_id is None or job.paper_id == paper_id) for job in self._jobs.values()):
                raise ConcurrencyConflict(message)
            self._holds[hold] = paper_id
        try:
            yield
        finally:
            with self._lock:
                del self._holds[hold]

    def submit_job(
        self,
        kind: str,
        action: Callable[[threading.Event, Callable[[str], None], Callable[[int], None]], Any],
        paper_id: str | None = None,
    ) -> JobInfo:
        with self._lock:
            if self._closed:
                raise ConcurrencyConflict("アプリを終了しています。")
            # A sync, backup or restore need not be refused: it waits for the admitted requests anyway
            # (deps.wait_for_library_requests), the one running the change included. Refusing it would
            # report an automatic sync that happened to start then as failed.
            if kind not in SNAPSHOT_KINDS and any(held is None or held == paper_id for held in self._holds.values()):
                raise ConcurrencyConflict("別の変更を処理しています。終わってからやり直してください。")
            # Check concurrency constraints
            if any(j.running and j.kind in SNAPSHOT_KINDS for j in self._jobs.values()):
                raise ConcurrencyConflict("バックアップ・復元が実行中です。")
            if kind in SNAPSHOT_KINDS and any(j.running for j in self._jobs.values()):
                raise ConcurrencyConflict("すべての処理が終わってからバックアップ・復元してください。")
            if paper_id is not None:
                if any(j.running and j.paper_id == paper_id for j in self._jobs.values()):
                    raise ConcurrencyConflict(f"この論文（{paper_id}）の処理がすでに実行中です。")
            else:
                if kind != 'import' and any(j.running and j.paper_id is None for j in self._jobs.values()):
                    raise ConcurrencyConflict("別の全体処理がすでに実行中です。")

            job_id = uuid.uuid4().hex[:12]
            cancel_event = threading.Event()
            job = JobInfo(
                job_id=job_id,
                paper_id=paper_id,
                kind=kind,
                message="準備中...",
                running=True,
                cancelled=False,
            )
            released = threading.Event()

            def begin() -> None:
                released.wait()
                runner()

            # Registered and started together with the job, so a shutdown that cancels it always waits
            # for it too; the work only begins once job.started has gone out (released below).
            thread = threading.Thread(target=begin, name=f"Job-{kind}-{job_id}", daemon=True)
            self._jobs[job_id] = job
            self._events[job_id] = cancel_event
            self._threads[job_id] = thread
            thread.start()

        def progress(message: str) -> None:
            done, total = None, None
            match = COUNTER.search(message)
            if match:
                done, total = int(match.group(1)), int(match.group(2))
            with self._lock:
                job.message = message
                job.done = done
                job.total = total
            self.broadcast({
                "type": "job.progress",
                "job_id": job_id,
                "paper_id": paper_id,
                "kind": kind,
                "message": message,
                "done": done,
                "total": total,
            })

        def page_ready(*args: Any) -> None:
            if len(args) == 2:
                p_id, page = args
            elif len(args) == 1:
                p_id, page = paper_id, args[0]
            else:
                return
            self.broadcast({
                "type": "job.page_ready",
                "paper_id": p_id,
                "page": page,
            })

        def runner() -> None:
            try:
                result = action(cancel_event, progress, page_ready)
                with self._lock:
                    job.running = False
                    job.status = "succeeded"
                    job.result = result
                self.broadcast({
                    "type": "job.finished",
                    "job_id": job_id,
                    "paper_id": paper_id,
                    "kind": kind,
                    "status": "succeeded",
                    "result": result,
                    "cancelled": False,
                })
            except Exception as exc:
                is_cancelled = cancel_event.is_set()
                error = job_error_message(exc, kind)
                with self._lock:
                    job.running = False
                    job.cancelled = is_cancelled
                    job.status = "cancelled" if is_cancelled else "failed"
                    job.error = error
                self.broadcast({
                    "type": "job.finished",
                    "job_id": job_id,
                    "paper_id": paper_id,
                    "kind": kind,
                    "status": "cancelled" if is_cancelled else "failed",
                    "error": error,
                    "cancelled": is_cancelled,
                })
            finally:
                # Cleanup job after a delay so that clients and tests can read the final status
                def cleanup():
                    time.sleep(5)
                    with self._lock:
                        self._jobs.pop(job_id, None)
                        self._events.pop(job_id, None)
                        self._threads.pop(job_id, None)
                threading.Thread(target=cleanup, daemon=True).start()

        try:
            self.broadcast({
                "type": "job.started",
                "job_id": job_id,
                "paper_id": paper_id,
                "kind": kind,
                "message": job.message,
            })
        finally:
            released.set()
        return job


class ConcurrencyConflict(Conflict):
    """A job, or a change under JobManager.idle, that would overlap one it must not run beside (409)."""


class TurnQueue:
    """Lets jobs run one at a time, in the order their tickets were taken.

    Every ticket must be released exactly once, whether or not its job got its turn,
    so a job that fails or is cancelled while waiting never holds up the jobs behind it.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._next_ticket = 0
        self._serving = 0
        self._released: set[int] = set()

    def ticket(self) -> int:
        with self._condition:
            ticket = self._next_ticket
            self._next_ticket += 1
            return ticket

    def wait(self, ticket: int, cancel: threading.Event, on_wait: Callable[[], None] | None = None) -> bool:
        """Block until it is `ticket`'s turn; False if cancelled first. `on_wait` runs once if it must wait."""
        with self._condition:
            if self._serving != ticket and on_wait:
                on_wait()
            while self._serving != ticket:
                if cancel.is_set():
                    return False
                self._condition.wait(0.2)
            return True

    def release(self, ticket: int) -> None:
        with self._condition:
            self._released.add(ticket)
            while self._serving in self._released:
                self._released.discard(self._serving)
                self._serving += 1
            self._condition.notify_all()
