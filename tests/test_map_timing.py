"""Map timing measures elapsed time without changing results, errors or job isolation."""
import io
import threading

import pytest

from papeer.core import discovery, map_timing, scholarly_lookup
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar.schemas.discovery import MapTiming
from test_citations import add_paper
from tools.profile_paper_map import snapshot


class Clock:
    def __init__(self): self.value = 0.0
    def __call__(self): return self.value
    def advance(self, seconds): self.value += seconds


def test_nested_active_and_repeated_steps_are_not_double_counted():
    clock = Clock()
    trace = map_timing.Trace(clock)
    with map_timing.session(trace):
        with map_timing.measure("build", "構築"):
            clock.advance(1)
            for _ in range(2):
                with map_timing.measure("match", "照合"):
                    clock.advance(2)
                    running = trace.snapshot()
                    assert sum(row["elapsed_ms"] for row in running["steps"]) == running["total_ms"]
                    assert not running["finished_at"]
            clock.advance(1)
        with map_timing.paused():
            with map_timing.measure("excluded", "保存"):
                clock.advance(.5)
    report = trace.snapshot("completed")
    MapTiming.model_validate(report)
    parent, child = report["steps"]
    assert (parent["total_ms"], parent["elapsed_ms"], parent["count"]) == (6000, 2000, 1)
    assert (child["total_ms"], child["elapsed_ms"], child["count"]) == (4000, 4000, 2)
    assert report["other_ms"] == 500
    assert map_timing.snapshot() is None


def test_sessions_do_not_leak_to_reader_threads_or_after_errors():
    reports = []
    with map_timing.session() as trace:
        thread = threading.Thread(target=lambda: reports.append(map_timing.snapshot()))
        thread.start(); thread.join()
        with pytest.raises(Cancelled):
            with map_timing.measure("cancel", "中止"): raise Cancelled()
        with pytest.raises(ValueError):
            with map_timing.measure("failure", "失敗"): raise ValueError("original")
    assert reports == [None]
    assert not trace.stack
    assert trace.snapshot()["steps"][0]["canceled"] == 1
    assert trace.snapshot()["steps"][1]["errors"] == 1
    assert map_timing.snapshot() is None


@pytest.mark.parametrize("status", ["completed", "partial", "canceled", "failed"])
def test_discovery_preserves_report_and_original_outcome(tmp_path, monkeypatch, status):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Measured source")
    discovery.write_cache(lib, source, source, {"nodes": [{"id": "saved"}]})
    def run(*args):
        with map_timing.measure("work", "取得"):
            if status == "canceled": raise Cancelled()
            if status == "failed": raise RuntimeError("original failure")
            return {"warnings": ["partial"] if status == "partial" else []}
    monkeypatch.setattr(discovery, "_discover", run)
    if status in {"canceled", "failed"}:
        with pytest.raises(Cancelled if status == "canceled" else RuntimeError):
            discovery.discover(lib, source, None, threading.Event(), lambda _: None)
    else:
        result = discovery.discover(lib, source, None, threading.Event(), lambda _: None)
        assert result["timing"]["status"] == status
    cache = discovery.read_cache(lib, source, source)
    assert cache["nodes"] == [{"id": "saved"}]
    MapTiming.model_validate(cache["timing"])
    assert cache["timing"]["status"] == status
    assert map_timing.snapshot() is None


def test_diagnostic_save_failure_does_not_replace_cancellation(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source")
    def cancel(*args): raise Cancelled()
    def broken(*args): raise OSError("Cannot save report")
    monkeypatch.setattr(discovery, "_discover", cancel)
    monkeypatch.setattr(discovery, "write_cache", broken)
    with pytest.raises(Cancelled): discovery.discover(lib, source, source, threading.Event(), lambda _: None)


def test_api_wait_http_and_cache_are_separate_and_do_not_record_urls(monkeypatch):
    clock = Clock()
    host = "api.semanticscholar.org"
    monkeypatch.setattr(scholarly_lookup.time, "monotonic", clock)
    monkeypatch.setattr(scholarly_lookup, "_NEXT", {host: 3})
    monkeypatch.setattr(scholarly_lookup, "_COOLDOWN", {})
    monkeypatch.setattr(scholarly_lookup, "_CACHE", {})
    class Event:
        def wait(self, delay): clock.advance(delay)
        def is_set(self): return False
    class Opener:
        def open(self, request, timeout):
            clock.advance(2)
            return io.BytesIO(b'{"results": []}')
    monkeypatch.setattr(scholarly_lookup, "build_opener", lambda *_: Opener())
    url = "https://api.semanticscholar.org/graph/v1/paper/search?query=private-paper-title"
    with map_timing.session(map_timing.Trace(clock)) as trace:
        assert scholarly_lookup._request(url, Event()) == {"results": []}
        assert scholarly_lookup._request(url, Event()) == {"results": []}
    steps = {row["key"]: row for row in trace.snapshot()["steps"]}
    assert steps["/api_interval:" + host]["total_ms"] == 3000
    assert steps["/api_http:" + host]["total_ms"] == 2000
    assert steps["/api_http:" + host]["count"] == 1
    assert steps["/api_cache:" + host]["count"] == 1
    assert trace.snapshot()["total_ms"] == 5000
    assert "private-paper-title" not in str(trace.snapshot())


def test_profile_snapshot_cannot_change_the_original_library(tmp_path):
    original = Library(tmp_path / "original")
    source = add_paper(original, 1, "Original paper")
    discovery.write_cache(original, source, source, {"nodes": [], "checked_at": "original"})
    copied_root = tmp_path / "copied"
    snapshot(original.root, copied_root)
    copied = Library(copied_root)
    copied.update(source, title="Changed only in snapshot")
    discovery.write_cache(copied, source, source, {"checked_at": "changed"})
    assert original.paper(source)["title"] == "Original paper"
    assert discovery.read_cache(original, source, source)["checked_at"] == "original"
    assert (copied.folder(source) / "document.json").read_bytes() == (original.folder(source) / "document.json").read_bytes()
