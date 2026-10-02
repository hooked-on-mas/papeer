"""Per-map wall-clock timings, isolated from other jobs and HTTP reader threads."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import time
from typing import Callable
import uuid

_CURRENT: ContextVar[Trace | None] = ContextVar("paper_map_timing", default=None)


class Trace:
    def __init__(self, clock: Callable[[], float] = time.perf_counter):
        self.clock = clock
        self.start = clock()
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.id = uuid.uuid4().hex
        self.steps: dict[str, dict] = {}
        self.stack: list[dict] = []

    @contextmanager
    def measure(self, name: str, label: str):
        parent = self.stack[-1]["key"] if self.stack else ""
        key = parent + "/" + name
        row = self.steps.setdefault(key, dict(key=key, parent=parent, label=label, elapsed_ms=0.0,
                                             total_ms=0.0, count=0, errors=0, canceled=0))
        frame: dict = dict(key=key, start=self.clock(), children=0.0)
        self.stack.append(frame)
        try:
            yield
        except BaseException as error:
            from papeer.providers import Cancelled
            row["canceled" if isinstance(error, Cancelled) else "errors"] += 1
            raise
        finally:
            elapsed = max(0, self.clock() - frame["start"])
            self.stack.pop()
            row["total_ms"] += elapsed * 1000
            row["elapsed_ms"] += max(0, elapsed - frame["children"]) * 1000
            row["count"] += 1
            if self.stack: self.stack[-1]["children"] += elapsed

    def snapshot(self, status: str = "running") -> dict:
        now = self.clock()
        steps = {key: dict(row) for key, row in self.steps.items()}
        for index, frame in enumerate(self.stack):
            elapsed = max(0, now - frame["start"])
            active_child = max(0, now - self.stack[index + 1]["start"]) if index + 1 < len(self.stack) else 0
            row = steps[frame["key"]]
            row["total_ms"] += elapsed * 1000
            row["elapsed_ms"] += max(0, elapsed - frame["children"] - active_child) * 1000
            row["count"] += 1
        total = max(0, now - self.start) * 1000
        return dict(id=self.id, started_at=self.started_at, finished_at="" if status == "running" else datetime.now(timezone.utc).isoformat(),
                    status=status, total_ms=total, other_ms=max(0, total - sum(r["elapsed_ms"] for r in steps.values())), steps=list(steps.values()))


@contextmanager
def session(trace: Trace | None = None):
    trace = trace or Trace()
    token = _CURRENT.set(trace)
    try:
        yield trace
    finally:
        _CURRENT.reset(token)


@contextmanager
def measure(name: str, label: str):
    trace = _CURRENT.get()
    if trace is None:
        yield
    else:
        with trace.measure(name, label): yield


@contextmanager
def paused():
    token = _CURRENT.set(None)
    try:
        yield
    finally:
        _CURRENT.reset(token)


def timed(name: str, label: str):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with measure(name, label): return function(*args, **kwargs)
        return wrapped
    return decorate


def call(name: str, label: str, function, *args, **kwargs):
    with measure(name, label): return function(*args, **kwargs)


def batches(name: str, label: str, iterator):
    with measure(name, label): yield from iterator


def snapshot() -> dict | None:
    trace = _CURRENT.get()
    return trace.snapshot() if trace else None
