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
                    "status": "cancelled" if is_cancelled else "failed",
                    "error": str(exc),
                    "cancelled": is_cancelled,
                })

        thread = threading.Thread(target=runner, name=f"Job-{kind}-{job_id}", daemon=True)
        with self._lock:
            self._threads[job_id] = thread
        thread.start()
        return job


class ConcurrencyConflict(Exception):
    pass
