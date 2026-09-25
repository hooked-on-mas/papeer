from __future__ import annotations

import threading
import time

from sidecar.jobs import TurnQueue


def _run(queue: TurnQueue, ticket: int, cancel: threading.Event, log: list[str], name: str) -> threading.Thread:
    def body() -> None:
        try:
            if queue.wait(ticket, cancel):
                log.append(name)
                time.sleep(0.05)
            else:
                log.append(f"{name} gave up")
        finally:
            queue.release(ticket)

    thread = threading.Thread(target=body)
    thread.start()
    return thread


def test_turns_follow_ticket_order_even_when_threads_start_late():
    queue, log = TurnQueue(), []
    tickets = [queue.ticket() for _ in range(3)]
    # Threads start in reverse; each still waits for the tickets taken before its own.
    threads = [_run(queue, t, threading.Event(), log, f"job{t}") for t in reversed(tickets)]
    for thread in threads:
        thread.join(5)
    assert log == ["job0", "job1", "job2"]


def test_cancelled_waiter_does_not_hold_up_later_jobs():
    queue, log = TurnQueue(), []
    first, second, third = queue.ticket(), queue.ticket(), queue.ticket()
    hold = threading.Event()
    waiting: list[str] = []

    def slow_first() -> None:
        assert queue.wait(first, threading.Event())
        hold.wait(5)
        log.append("first")
        queue.release(first)

    runner = threading.Thread(target=slow_first)
    runner.start()
    cancel = threading.Event()
    cancelled = threading.Thread(target=lambda: (
        log.append("second" if queue.wait(second, cancel, lambda: waiting.append("second")) else "second gave up"),
        queue.release(second)))
    cancelled.start()
    last = _run(queue, third, threading.Event(), log, "third")

    cancel.set()
    cancelled.join(5)
    hold.set()
    for thread in (runner, last):
        thread.join(5)
    assert waiting == ["second"]
    assert log == ["second gave up", "first", "third"]
