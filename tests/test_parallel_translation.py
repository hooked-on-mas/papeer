from __future__ import annotations

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

import pymupdf as fitz

from paperdesk.core.config import Settings
from paperdesk.core.providers import API_RETRIES, Cancelled, Provider
from paperdesk.core.service import PaperService
from paperdesk.core.storage import Library
from paperdesk.translation.translation import RetryState, translate_batches
from paperdesk.translation.translation_preview import translated_page_numbers
from test_workflow import FakeProvider


BATCHES = [[{"id": name, "page": page, "text": f"Sentence {name}."}] for page, name in enumerate("abc", 1)]


def answer(units):
    return json.dumps({"translations": [{"id": u["id"], "text": f"文{u['id']}。"} for u in units]}, ensure_ascii=False)


class GatedProvider:
    """Answers first requests only once `width` of them are in flight together."""

    def __init__(self, width, fail=None):
        self.barrier = threading.Barrier(width, timeout=5)
        self.fail = fail
        self.threads = set()
        self.seen_attempts = []
        self.persisted = {}

    def generate(self, instruction, data, schema=None):
        units = json.loads(data)
        self.threads.add(threading.current_thread())
        # Each block must be recorded as sent before its request leaves.
        self.seen_attempts.append(all(self.persisted.get(u["id"]) == 1 for u in units))
        if self.fail and units[0]["id"] == self.fail:
            raise RuntimeError("connection failed")
        self.barrier.wait()
        return answer(units)


class TranslateBatchesTests(unittest.TestCase):
    def run_batches(self, provider, concurrency=3, cancel=None):
        state = RetryState()
        accepted, events = {}, []
        main = threading.current_thread()

        def on_main(name):
            self.assertIs(threading.current_thread(), main, f"{name} must run on the calling thread")

        def accept(values):
            on_main("accept")
            accepted.update(values)

        def save():
            on_main("save")
            provider.persisted = dict(state.attempts)

        def finished(index):
            on_main("finished")
            events.append(index)

        try:
            translate_batches(provider, BATCHES, cancel or threading.Event(), lambda _: on_main("progress"),
                              accept, state, save, concurrency=concurrency, finished=finished)
        finally:
            self.state, self.accepted, self.finished = state, accepted, events

    def test_first_requests_overlap_and_bookkeeping_stays_on_calling_thread(self):
        provider = GatedProvider(3)
        self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "b": "文b。", "c": "文c。"})
        self.assertEqual(sorted(self.finished), [0, 1, 2])
        self.assertEqual(len(provider.threads), 3)
        self.assertEqual(provider.seen_attempts, [True, True, True])

    def test_concurrency_is_bounded(self):
        in_flight, peak, lock = 0, 0, threading.Lock()

        class CountingProvider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                nonlocal in_flight, peak
                with lock:
                    in_flight += 1
                    peak = max(peak, in_flight)
                time.sleep(0.05)
                with lock:
                    in_flight -= 1
                return answer(json.loads(data))

        self.run_batches(CountingProvider(), concurrency=2)
        self.assertEqual(len(self.accepted), 3)
        self.assertEqual(peak, 2)

    def test_failure_keeps_answers_already_in_flight(self):
        provider = GatedProvider(2, fail="b")
        with self.assertRaisesRegex(RuntimeError, "connection failed"):
            self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "c": "文c。"})
        # The failed block was recorded as sent, so resuming goes through recovery.
        self.assertEqual(self.state.attempts, {"a": 1, "b": 1, "c": 1})

    def test_cancel_stops_requests_in_flight(self):
        cancel = threading.Event()

        class WaitingProvider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                while not cancel.wait(0.02):
                    pass
                raise Cancelled()

        threading.Timer(0.1, cancel.set).start()
        started = time.monotonic()
        with self.assertRaises(Cancelled):
            self.run_batches(WaitingProvider(), cancel=cancel)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(self.accepted, {})


class ConcurrencySettingTests(unittest.TestCase):
    def test_automatic_is_serial_only_for_local_models(self):
        self.assertEqual(Settings().translation_requests(), 3)
        self.assertEqual(Settings(provider="claude").translation_requests(), 3)
        self.assertEqual(Settings(provider="api", base_url="https://api.openai.com/v1").translation_requests(), 3)
        self.assertEqual(Settings(provider="api", base_url="http://localhost:11434/v1").translation_requests(), 1)
        self.assertEqual(Settings(provider="api", base_url="http://127.0.0.1:1234/v1").translation_requests(), 1)
        self.assertEqual(Settings(provider="api", base_url="http://localhost:11434/v1",
                                  translation_concurrency=2).translation_requests(), 2)
        self.assertEqual(Settings(translation_concurrency=1).translation_requests(), 1)

    def test_out_of_range_values_are_rejected(self):
        for value in (-1, 9, True, 2.0):
            with self.subTest(value=value), self.assertRaises(ValueError):
                Settings(translation_concurrency=value)


class ParallelPaperTranslationTests(unittest.TestCase):
    def test_pages_translate_concurrently_and_publish_completely(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            with fitz.open() as pdf:
                for number in range(1, 4):
                    pdf.new_page().insert_text((40, 70), f"Original content on page {number}.", fontsize=12)
                pdf.save(source)
            library = Library(root / "library")
            identity, _ = library.import_pdf(source)

            class ParallelProvider(FakeProvider):
                def __init__(self):
                    super().__init__()
                    self.settings = Settings(translation_concurrency=3)
                    self.barrier = threading.Barrier(3, timeout=5)
                    self.lock = threading.Lock()

                def generate(inner, instruction, data, schema=None):
                    # One request per page: all three must be in flight together.
                    inner.barrier.wait()
                    with inner.lock:
                        return super().generate(instruction, data, schema)

            messages = []
            provider = ParallelProvider()
            report = PaperService(library, provider, threading.Event(), progress=messages.append).translate(identity)
            self.assertEqual(provider.calls, 3)
            self.assertEqual(report["translated_pages"], [1, 2, 3])
            self.assertEqual(library.paper(identity)["status"], "翻訳済み")
            self.assertEqual(translated_page_numbers(library.folder(identity), 3), [1, 2, 3])
            self.assertIn("翻訳 3/3（同時3件） — 指定ページの完了 3/3 ブロック", messages)


class ApiRateLimitTests(unittest.TestCase):
    def serve(self, statuses):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                handler.rfile.read(int(handler.headers["Content-Length"]))
                status = statuses[min(len(requests), len(statuses) - 1)]
                requests.append(status)
                handler.send_response(status)
                handler.send_header("Content-Type", "application/json")
                handler.send_header("Retry-After", "0.01")
                handler.end_headers()
                if status == 200:
                    handler.wfile.write(json.dumps({"choices": [{"finish_reason": "stop",
                                                                 "message": {"content": "訳文"}}]}).encode())

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        settings = Settings(provider="api", model="test-model", base_url=f"http://127.0.0.1:{server.server_port}/v1")
        return Provider(settings, threading.Event()), requests

    def test_rate_limited_request_is_retried(self):
        provider, requests = self.serve([429, 503, 200])
        self.assertEqual(provider.generate("test", "data"), "訳文")
        self.assertEqual(requests, [429, 503, 200])

    def test_persistent_rate_limit_is_reported(self):
        provider, requests = self.serve([429])
        with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
            provider.generate("test", "data")
        self.assertEqual(len(requests), API_RETRIES + 1)

    def test_other_errors_are_not_retried(self):
        provider, requests = self.serve([401])
        with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
            provider.generate("test", "data")
        self.assertEqual(requests, [401])


if __name__ == "__main__":
    unittest.main()
