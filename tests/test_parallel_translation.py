from __future__ import annotations

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import pymupdf as fitz

from papeer.core.config import Settings
from papeer.providers import AnswerRejected, Cancelled, TransientError, create_provider
from papeer.providers.openai_compat import API_RETRIES
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.translation.translation import MAX_UNANSWERED_SENDS, RetryState, translate_batches
from papeer.translation.translation_preview import translated_page_numbers
from test_workflow import FakeProvider


BATCHES = [[{"id": name, "page": page, "text": f"Sentence {name}."}] for page, name in enumerate("abc", 1)]


def answer(units):
    return json.dumps({"translations": [{"id": u["id"], "text": f"文{u['id']}。"} for u in units]}, ensure_ascii=False)


RECOVERED = json.dumps({"parts": [{"kind": "text", "text": "段落ごとの訳文。"}]}, ensure_ascii=False)


class GatedProvider:
    """Answers first requests only once `width` of them are in flight together, and recovery requests at once."""

    def __init__(self, width, fail=None, error=None):
        self.barrier = threading.Barrier(width, timeout=5)
        self.fail = fail
        self.error = error or RuntimeError("connection failed")
        self.threads = set()
        self.seen_attempts = []
        self.persisted = {}
        self.recoveries = []

    def generate(self, instruction, data, schema=None):
        units = json.loads(data)
        if isinstance(units, dict):  # A recovery request for one paragraph.
            self.recoveries.append(units)
            return RECOVERED
        self.threads.add(threading.current_thread())
        # Each block must be recorded as sent before its request leaves.
        self.seen_attempts.append(all(self.persisted.get(u["id"]) == 1 for u in units))
        if self.fail and units[0]["id"] == self.fail:
            raise self.error
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
        # The failed block was recorded as sent but got no answer: resuming sends it with a batch again.
        self.assertEqual(self.state.attempts, {"a": 1, "b": 1, "c": 1})
        self.assertEqual(self.state.unanswered, {"b": 1})
        self.assertEqual(self.state.answered_level(BATCHES[1][0]), 0)

    def test_unusable_first_answer_goes_on_to_recovery_without_stopping_the_paper(self):
        provider = GatedProvider(2, fail="b", error=AnswerRejected("AIの回答が出力上限で途切れました。"))
        self.run_batches(provider)
        # The batch cut off is asked again paragraph by paragraph at once; the other batches go on.
        self.assertEqual(self.accepted, {"a": "文a。", "b": "段落ごとの訳文。", "c": "文c。"})
        self.assertEqual(sorted(self.finished), [0, 1, 2])
        self.assertEqual([request["source_parts"][0]["text"] for request in provider.recoveries], ["Sentence b."])
        self.assertEqual((self.state.attempts, self.state.unanswered), ({"a": 1, "b": 2, "c": 1}, {}))

    def test_timed_out_first_request_stops_and_counts_once_when_resumed(self):
        provider = GatedProvider(2, fail="b", error=TransientError("APIの応答がタイムアウトしました。", after_sending=True))
        with self.assertRaises(TransientError):
            self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "c": "文c。"})
        self.assertEqual(self.state.unanswered, {"b": MAX_UNANSWERED_SENDS})
        # Resuming (with the blocks still untranslated) charges the timeout once: the paragraph
        # goes to recovery instead of the same batch again.
        resumed = GatedProvider(1)
        accepted = {}
        state = RetryState.from_cache(self.state.to_cache())
        translate_batches(resumed, BATCHES[1:2], threading.Event(), lambda _: None, accepted.update, state,
                          concurrency=3)
        self.assertEqual(accepted, {"b": "段落ごとの訳文。"})
        self.assertEqual(len(resumed.recoveries), 1)
        self.assertEqual(resumed.seen_attempts, [])

    def test_timeout_while_connecting_is_sent_with_a_batch_again(self):
        provider = GatedProvider(2, fail="b", error=TransientError("APIに接続できません。", timed_out=True))
        with self.assertRaises(TransientError):
            self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "c": "文c。"})
        self.assertEqual(self.state.unanswered, {"b": 1})
        self.assertEqual(self.state.answered_level(BATCHES[1][0]), 0)

    def test_answers_and_timeouts_in_flight_are_recorded_when_another_request_stops_the_run(self):
        class MixedProvider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                name = json.loads(data)[0]["id"]
                if name == "a":
                    raise RuntimeError("未ログインです。")
                time.sleep(0.2)  # Still in flight when the error of "a" stops the run.
                if name == "b":
                    raise AnswerRejected("AIの回答が出力上限で途切れました。")
                raise TransientError("APIの応答がタイムアウトしました。", after_sending=True)

        with self.assertRaisesRegex(RuntimeError, "未ログイン"):
            self.run_batches(MixedProvider())
        # "a" got no answer and is sent with a batch again; "b" was answered and "c" timed out:
        # both go to recovery when translation resumes.
        self.assertEqual(self.state.unanswered, {"a": 1, "c": MAX_UNANSWERED_SENDS})
        self.assertEqual([self.state.answered_level(batch[0]) for batch in BATCHES], [0, 1, 1])

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
        self.assertEqual(Settings(provider="api", provider_options={"api": {"base_url": "https://api.openai.com/v1"}}).translation_requests(), 3)
        self.assertEqual(Settings(provider="api", provider_options={"api": {"base_url": "http://localhost:11434/v1"}}).translation_requests(), 1)
        self.assertEqual(Settings(provider="api", provider_options={"api": {"base_url": "http://127.0.0.1:1234/v1"}}).translation_requests(), 1)
        self.assertEqual(Settings(provider="api", provider_options={"api": {"base_url": "http://localhost:11434/v1"}},
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
    def setUp(self):
        # The server asks for 0.01 seconds; honour it instead of the usual minimum, to keep the tests fast.
        minimum = patch("papeer.providers.openai_compat.MIN_RETRY_AFTER", 0.0)
        minimum.start()
        self.addCleanup(minimum.stop)

    def serve(self, statuses, error_body=b""):
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
                else:
                    handler.wfile.write(error_body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        settings = Settings(provider="api", model="test-model",
                            provider_options={"api": {"base_url": f"http://127.0.0.1:{server.server_port}/v1"}})
        return create_provider(settings, threading.Event()), requests

    def test_rate_limited_request_is_retried(self):
        provider, requests = self.serve([429, 503, 200])
        self.assertEqual(provider.generate("test", "data"), "訳文")
        self.assertEqual(requests, [429, 503, 200])

    def test_persistent_rate_limit_is_reported(self):
        provider, requests = self.serve([429])
        with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
            provider.generate("test", "data")
        self.assertEqual(len(requests), API_RETRIES + 1)

    def test_server_errors_are_retried(self):
        provider, requests = self.serve([500, 502, 504, 200])
        self.assertEqual(provider.generate("test", "data"), "訳文")
        self.assertEqual(requests, [500, 502, 504, 200])

    def test_exhausted_quota_is_not_retried(self):
        body = json.dumps({"error": {"type": "insufficient_quota", "code": "insufficient_quota"}}).encode()
        provider, requests = self.serve([429], body)
        with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
            provider.generate("test", "data")
        self.assertEqual(requests, [429])

    def test_other_errors_are_not_retried(self):
        provider, requests = self.serve([401])
        with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
            provider.generate("test", "data")
        self.assertEqual(requests, [401])


if __name__ == "__main__":
    unittest.main()
