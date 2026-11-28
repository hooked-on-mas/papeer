from __future__ import annotations

import threading
import time

import pytest

from sidecar.lifecycle.jobs import ConcurrencyConflict, JobManager, TurnQueue


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


def test_reference_research_runs_five_at_once_and_keeps_conflicting_mutations_exclusive():
    manager = JobManager()
    gates = [threading.Event() for _ in range(6)]
    entered = [threading.Event() for _ in range(6)]

    def action(index):
        def run(cancel, progress, page_ready):
            entered[index].set()
            assert gates[index].wait(5)
            return {"key": str(index), "title": "Reference", "raw": "Reference"}
        return run

    try:
        jobs = [manager.submit_job("reference-research", action(i), paper_id="paper") for i in range(5)]
        assert all(event.wait(2) for event in entered[:5])
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("reference-research", action(5), paper_id="paper")
        for kind in ("reference-import", "ocr", "backup", "restore", "drive-sync"):
            with pytest.raises(ConcurrencyConflict):
                manager.submit_job(kind, lambda *_: {}, paper_id=None if kind in ("backup", "restore", "drive-sync") else "paper")
        gates[0].set()
        deadline = time.monotonic() + 2
        while manager.get_job(jobs[0].job_id).running and time.monotonic() < deadline:
            time.sleep(0.01)
        assert manager.get_job(jobs[0].job_id).status == "succeeded"
        manager.submit_job("reference-research", action(5), paper_id="paper")
        assert entered[5].wait(2)
    finally:
        for gate in gates:
            gate.set()
        assert manager.wait_idle(5)

    gate = threading.Event()
    try:
        manager.submit_job("ocr", lambda *_: gate.wait(5), paper_id="paper")
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("reference-research", action(0), paper_id="paper")
    finally:
        gate.set()
        assert manager.wait_idle(5)


@pytest.mark.parametrize("kind", ["article", "ask", "translate", "glossary-draft", "glossary-select",
                                 "glossary-split", "revision", "revision-draft", "export", "interleaved"])
@pytest.mark.parametrize("research_first", [True, False])
def test_reference_research_overlaps_independent_work_in_either_order(kind, research_first):
    manager = JobManager()
    gate = threading.Event()
    entered = [threading.Event() for _ in range(6)]
    translation = {"pages": 1, "requested_pages": [1], "selected_pages": [1], "already_translated_pages": [],
                   "preserved_pages": [], "translated_pages": [1], "untranslated_pages": [], "skipped_pages": [],
                   "skipped_blocks": [], "skipped_block_pages": [], "page_errors": {}, "model": "test"}
    results = {"article": {"content": "Summary"}, "ask": {"answer": "Answer"}, "translate": translation,
               "revision": translation, "revision-draft": {"text": "Translation", "unit_id": "u1"},
               "glossary-draft": {"terms": []}, "glossary-select": {"domains": []},
               "glossary-split": {"moved": 0, "domains": []},
               "export": {"kind": "interleaved", "destination": "out.pdf"},
               "interleaved": {"kind": "interleaved", "path": "out.pdf"}}

    def action(index):
        def run(*_):
            entered[index].set()
            assert gate.wait(5)
            return {"key": str(index), "title": "Reference", "raw": "Reference"} if index else results[kind]
        return run

    try:
        if not research_first:
            manager.submit_job(kind, action(0), paper_id="paper")
        for i in range(1, 6):
            manager.submit_job("reference-research", action(i), paper_id="paper")
        if research_first:
            manager.submit_job(kind, action(0), paper_id="paper")
        assert all(event.wait(2) for event in entered)
        # The independent job consumes no lookup slot, and no second ordinary job can overlap it.
        for blocked in ("reference-research", kind, "article", "reference-import", "ocr", "backup"):
            with pytest.raises(ConcurrencyConflict):
                manager.submit_job(blocked, lambda *_: {}, paper_id=None if blocked == "backup" else "paper")
    finally:
        gate.set()
        assert manager.wait_idle(5)
    assert all(job.status == "succeeded" for job in manager.get_jobs())


def test_dictionary_save_can_ignore_lookup_but_delete_and_other_jobs_still_wait():
    from sidecar.lifecycle.job_types import JobKind

    manager = JobManager()
    gate = threading.Event()
    try:
        manager.submit_job("reference-research", lambda *_: gate.wait(5), paper_id="paper")
        with pytest.raises(ConcurrencyConflict), manager.idle("delete", "paper"):
            pass
        with manager.idle("dictionary", ignore=frozenset({JobKind.REFERENCE_RESEARCH})):
            with pytest.raises(ConcurrencyConflict):
                manager.submit_job("article", lambda *_: {}, paper_id="paper")
        manager.submit_job("article", lambda *_: gate.wait(5), paper_id="paper")
        with pytest.raises(ConcurrencyConflict), manager.idle("dictionary", ignore=frozenset({JobKind.REFERENCE_RESEARCH})):
            pass
    finally:
        gate.set()
        assert manager.wait_idle(5)


@pytest.mark.parametrize('fails', [False, True])
def test_close_waits_for_finishing_job_event_delivery(monkeypatch, fails):
    from sidecar.lifecycle.job_types import JobFinishedEvent

    manager = JobManager()
    entered, release = threading.Event(), threading.Event()
    broadcast = manager.broadcast
    def blocked_broadcast(event):
        if isinstance(event, JobFinishedEvent):
            entered.set()
            assert release.wait(5)
        broadcast(event)
    monkeypatch.setattr(manager, 'broadcast', blocked_broadcast)
    def action(*_):
        if fails:
            raise RuntimeError('synthetic job failure')
        return {'content': 'synthetic summary'}
    try:
        job = manager.submit_job('article', action, paper_id='synthetic')
        assert entered.wait(3)
        assert not job.running
        assert job.status == ('failed' if fails else 'succeeded')
        manager.close()
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job('article', action, paper_id='another')
        assert manager.wait_idle(0) is False
        release.set()
        assert manager.wait_idle(5) is True
        assert not manager._threads
    finally:
        release.set()
        assert manager.wait_idle(5)


def test_shutdown_does_not_report_stopped_while_finished_event_is_in_flight(monkeypatch):
    from sidecar import deps
    from sidecar.lifecycle.job_types import JobFinishedEvent
    from sidecar.routes import provider_owner, system

    manager = JobManager()
    entered, release = threading.Event(), threading.Event()
    original = manager.broadcast
    def broadcast(event):
        if isinstance(event, JobFinishedEvent):
            entered.set()
            assert release.wait(5)
        original(event)
    monkeypatch.setattr(manager, 'broadcast', broadcast)
    monkeypatch.setattr(deps, 'job_manager', manager)
    monkeypatch.setattr(deps, 'wait_for_library_requests', lambda *_: True)
    monkeypatch.setattr(provider_owner, 'stop_if_created', lambda: None)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', 0)
    try:
        manager.submit_job('article', lambda *_: {'content': 'synthetic'}, paper_id='synthetic')
        assert entered.wait(3)
        assert system.stop_work() == (0, False)
        release.set()
        monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', 5)
        assert system.stop_work() == (0, True)
    finally:
        release.set()
        assert manager.wait_idle(5)
