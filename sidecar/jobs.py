from __future__ import annotations

import asyncio
import re
import threading
import uuid
from typing import Any, Callable

from sidecar.schemas import JobInfo

COUNTER = re.compile(r"(\d+)\s*/\s*(\d+)")


class JobManager:
    def __init__(self, event_loop: asyncio.AbstractEventLoop | None = None) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, JobInfo] = {}
        self._events: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._listeners: set[asyncio.Queue] = set()
        self._loop = event_loop

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

    def submit_job(
        self,
        kind: str,
        action: Callable[[threading.Event, Callable[[str], None], Callable[[int], None]], Any],
        paper_id: str | None = None,
    ) -> JobInfo:
        with self._lock:
            # Check concurrency constraints
            if any(j.running and j.kind in {"backup", "restore", "drive-sync"} for j in self._jobs.values()):
                raise ConcurrencyConflict("バックアップ・復元が実行中です。")
            if kind in {"backup", "restore", "drive-sync"} and any(j.running for j in self._jobs.values()):
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
            self._jobs[job_id] = job
            self._events[job_id] = cancel_event
        self.broadcast({
            "type": "job.started",
            "job_id": job_id,
            "paper_id": paper_id,
            "kind": kind,
            "message": job.message,
        })

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
                with self._lock:
                    job.running = False
                    job.cancelled = is_cancelled
                    job.status = "cancelled" if is_cancelled else "failed"
                    job.error = str(exc)
                self.broadcast({
                    "type": "job.finished",
                    "job_id": job_id,
                    "paper_id": paper_id,
                    "kind": kind,
                    "status": "cancelled" if is_cancelled else "failed",
                    "error": str(exc),
                    "cancelled": is_cancelled,
                })
            finally:
                # Cleanup job after a delay so that clients and tests can read the final status
                def cleanup():
                    import time
                    time.sleep(5)
                    with self._lock:
                        self._jobs.pop(job_id, None)
                        self._events.pop(job_id, None)
                        self._threads.pop(job_id, None)
                threading.Thread(target=cleanup, daemon=True).start()

        thread = threading.Thread(target=runner, name=f"Job-{kind}-{job_id}", daemon=True)
        with self._lock:
            self._threads[job_id] = thread
        thread.start()
        return job


class ConcurrencyConflict(Exception):
    pass


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
