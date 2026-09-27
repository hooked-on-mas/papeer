from __future__ import annotations

from collections import Counter
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
    """Answers first requests (or fails the one of `fail`) only once `width` of them are in flight
    together, and recovery requests at once."""

    def __init__(self, width, fail=None, error=None):
        self.barrier = threading.Barrier(width, timeout=5)
        self.fail = fail
        self.error = error or RuntimeError("connection failed")
        self.lock = threading.Lock()
        self.threads = set()
        self.seen_attempts = []
        self.persisted = {}
        self.recoveries = []

    def generate(self, instruction, data, schema=None):
        units = json.loads(data)
        if "blocks" not in units:  # A recovery request for one paragraph.
            with self.lock:
                self.recoveries.append(units)
            return RECOVERED
        units = units["blocks"]
        with self.lock:
            self.threads.add(threading.current_thread())
            # Each block must be recorded as sent before its request leaves.
            self.seen_attempts.append(all(self.persisted.get(u["id"]) == 1 for u in units))
        self.barrier.wait()
        if self.fail and units[0]["id"] == self.fail:
            raise self.error
        return answer(units)


class OwnedLock:
    """An RLock that tells whether the calling thread holds it, given to translate_batches as `lock`."""

    def __init__(self):
        self._lock = threading.RLock()
        self._owner, self._depth = None, 0

    def __enter__(self):
        self._lock.acquire()
        self._owner = threading.get_ident()
        self._depth += 1
        return self

    def __exit__(self, *_):
        self._depth -= 1
        if not self._depth:
            self._owner = None
        self._lock.release()

    def held(self):
        return self._owner == threading.get_ident()


def unit_batches(count):
    return [[{"id": f"u{n}", "page": n + 1, "text": f"Sentence u{n}."}] for n in range(count)]


class TranslateBatchesTests(unittest.TestCase):
    def run_batches(self, provider, concurrency=3, cancel=None, batches=BATCHES, state=None, on_finished=None):
        """translate_batches as the service calls it: accept saves, the callbacks record what they see."""
        state = state if state is not None else RetryState()
        accepted, events, violations = {}, [], []
        lock = OwnedLock()
        main = threading.current_thread()
        inside = []

        def locked(name):
            if not lock.held():
                violations.append(f"{name} without the lock")

        def accept(values):
            locked("accept")
            accepted.update(values)
            save()

        def save():
            locked("save")
            inside.append(1)
            if len(inside) > 1:
                violations.append("two saves at once")
            provider.persisted = dict(state.attempts)
            self.saved = state.to_cache()
            time.sleep(0.001)  # A save takes a while: another one starting now would overlap it.
            inside.pop()

        def finished(index):
            if threading.current_thread() is not main or lock.held():
                violations.append("finished off the calling thread or holding the lock")
            events.append(index)
            if on_finished:
                on_finished(index)

        self.saved = None
        try:
            translate_batches(provider, batches, cancel or threading.Event(), lambda _: locked("progress"),
                              accept, state, save, concurrency=concurrency, finished=finished, lock=lock)
        finally:
            self.state, self.accepted, self.finished = state, accepted, events
            self.assertEqual(violations, [])

    def test_batches_overlap_and_their_records_are_made_one_at_a_time(self):
        provider = GatedProvider(3)
        self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "b": "文b。", "c": "文c。"})
        self.assertEqual(sorted(self.finished), [0, 1, 2])
        self.assertEqual(len(provider.threads), 3)
        self.assertEqual(provider.seen_attempts, [True, True, True])
        self.assertEqual(self.saved, self.state.to_cache())

    def test_every_request_counts_toward_the_concurrency(self):
        # Recovery requests too, now that they run on the workers beside the first requests.
        in_flight, peak, lock = 0, 0, threading.Lock()

        class CountingProvider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                nonlocal in_flight, peak
                with lock:
                    in_flight += 1
                    peak = max(peak, in_flight)
                time.sleep(0.03)
                with lock:
                    in_flight -= 1
                request = json.loads(data)
                if "blocks" not in request:
                    return RECOVERED
                # Every other batch fails the checks and is recovered paragraph by paragraph.
                units = request["blocks"]
                return answer(units) if int(units[0]["id"][1:]) % 2 else json.dumps({"translations": []})

        self.run_batches(CountingProvider(), concurrency=2, batches=unit_batches(8))
        self.assertEqual(len(self.accepted), 8)
        self.assertEqual(peak, 2)

    def test_recovery_runs_beside_the_next_batches(self):
        c_sent = threading.Event()
        waited = []

        class Provider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                request = json.loads(data)
                if "blocks" not in request:
                    # The recovery of "a" answers once "c" has gone out: "c" must not wait for it.
                    waited.append(c_sent.wait(5))
                    return RECOVERED
                units = request["blocks"]
                if units[0]["id"] == "c":
                    c_sent.set()
                return json.dumps({"translations": []}) if units[0]["id"] == "a" else answer(units)

        self.run_batches(Provider(), concurrency=2)
        self.assertEqual(waited, [True])
        self.assertEqual(self.accepted, {"a": "段落ごとの訳文。", "b": "文b。", "c": "文c。"})
        self.assertEqual(sorted(self.finished), [0, 1, 2])

    def test_making_pages_does_not_hold_back_the_next_batch(self):
        c_sent = threading.Event()
        waited = []

        class Provider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                units = json.loads(data)["blocks"]
                if units[0]["id"] == "c":
                    c_sent.set()
                return answer(units)

        def make_pages(index):
            # The service makes the pages of a finished batch here; "c" goes out meanwhile.
            if not waited:
                waited.append(c_sent.wait(5))

        self.run_batches(Provider(), concurrency=2, on_finished=make_pages)
        self.assertEqual(waited, [True])
        self.assertEqual(len(self.accepted), 3)

    def test_no_request_is_sent_twice_and_the_record_stays_in_step(self):
        sent = Counter()
        lock = threading.Lock()

        class Provider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                request = json.loads(data)
                if "blocks" in request:
                    keys = [("first", u["id"]) for u in request["blocks"]]
                else:
                    keys = [("recovery", request["source_parts"][0]["text"])]
                with lock:
                    sent.update(keys)
                time.sleep(0.005)
                if "blocks" not in request:
                    return RECOVERED
                units = request["blocks"]
                return answer(units) if int(units[0]["id"][1:]) % 3 else json.dumps({"translations": []})

        self.run_batches(Provider(), concurrency=3, batches=unit_batches(24))
        self.assertEqual(len(self.accepted), 24)
        self.assertTrue(all(count == 1 for count in sent.values()), sent)
        self.assertEqual(sum(kind == "recovery" for kind, _ in sent), 8)
        self.assertEqual(self.saved, self.state.to_cache())
        self.assertEqual(self.state.unanswered, {})

    def test_a_stop_leaves_the_saved_record_in_step_and_resuming_sends_nothing_twice(self):
        for stop in ("error", "cancel"):
            with self.subTest(stop=stop):
                cancel = threading.Event()
                first = Counter()
                lock = threading.Lock()

                class Provider:
                    persisted = {}

                    def __init__(self, failing):
                        self.failing = failing

                    def generate(self, instruction, data, schema=None):
                        request = json.loads(data)
                        time.sleep(0.01)
                        if "blocks" not in request:
                            return RECOVERED
                        units = request["blocks"]
                        number = int(units[0]["id"][1:])
                        with lock:
                            first[units[0]["id"]] += 1
                        if self.failing and number == 7:
                            if stop == "cancel":
                                cancel.set()
                                raise Cancelled()
                            raise RuntimeError("未ログインです。")
                        return answer(units) if number % 3 else json.dumps({"translations": []})

                with self.assertRaises(Cancelled if stop == "cancel" else RuntimeError):
                    self.run_batches(Provider(True), cancel=cancel, batches=unit_batches(16))
                self.assertEqual(self.saved, self.state.to_cache())
                self.assertLess(len(self.accepted), 16)
                self.assertIn("u7", self.state.unanswered)
                # Resuming as the service does: the paragraphs not translated yet, from the saved record.
                done = dict(self.accepted)
                state = RetryState.from_cache(self.saved)
                answered = {u for u in state.attempts if not state.resendable({"id": u})}
                before = Counter(first)
                self.run_batches(Provider(False), state=state,
                                 batches=[b for b in unit_batches(16) if b[0]["id"] not in done])
                self.assertEqual(len(done) + len(self.accepted), 16)
                # Paragraphs answered before go to recovery; only those never sent, or sent without
                # an answer, go out with a batch again.
                resent = first - before
                self.assertFalse(set(resent) & answered)
                self.assertTrue(all(count == 1 for count in resent.values()))
                self.assertIn("u7", resent)
                self.assertEqual(self.state.unanswered, {})

    def test_failure_keeps_answers_already_in_flight(self):
        provider = GatedProvider(3, fail="b")
        with self.assertRaisesRegex(RuntimeError, "connection failed"):
            self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "c": "文c。"})
        # The failed block was recorded as sent but got no answer: resuming sends it with a batch again.
        self.assertEqual(self.state.attempts, {"a": 1, "b": 1, "c": 1})
        self.assertEqual(self.state.unanswered, {"b": 1})
        self.assertEqual(self.state.answered_level(BATCHES[1][0]), 0)
        self.assertEqual(self.saved, self.state.to_cache())

    def test_the_error_that_stopped_the_run_is_raised_not_the_stop_of_another_batch(self):
        b_failed = threading.Event()

        class Provider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                request = json.loads(data)
                if "blocks" not in request:
                    # The recovery of "a" is answered (unusably) after "b" failed: "a" meets the stop.
                    b_failed.wait(5)
                    time.sleep(0.05)
                    return json.dumps({"parts": []})
                name = request["blocks"][0]["id"]
                if name == "a":
                    return json.dumps({"translations": []})
                if name == "c":
                    return answer(request["blocks"])
                time.sleep(0.1)
                b_failed.set()
                raise RuntimeError("未ログインです。")

        # "c" finishes first and its page takes a while: meanwhile "b" fails and "a" stops, so the
        # calling thread finds the batches ended in index order, "a" (Cancelled) before "b".
        batches = [[{"id": name, "page": page, "text": f"Sentence {name}."}] for page, name in enumerate("cab", 1)]
        with self.assertRaisesRegex(RuntimeError, "未ログイン"):
            self.run_batches(Provider(), batches=batches, on_finished=lambda _: time.sleep(0.6))
        self.assertEqual(self.accepted, {"c": "文c。"})
        self.assertEqual(self.saved, self.state.to_cache())

    def test_failure_drops_the_batches_not_begun(self):
        provider = GatedProvider(2, fail="a")
        with self.assertRaisesRegex(RuntimeError, "connection failed"):
            self.run_batches(provider, concurrency=2)
        self.assertEqual(self.accepted, {"b": "文b。"})
        # "c" was never recorded as sent: the worker of "a" stopped the run before taking it.
        self.assertEqual(self.state.attempts, {"a": 1, "b": 1})
        self.assertNotIn(2, self.finished)

    def test_unusable_first_answer_goes_on_to_recovery_without_stopping_the_paper(self):
        provider = GatedProvider(3, fail="b", error=AnswerRejected("AIの回答が出力上限で途切れました。"))
        self.run_batches(provider)
        # The batch cut off is asked again paragraph by paragraph at once; the other batches go on.
        self.assertEqual(self.accepted, {"a": "文a。", "b": "段落ごとの訳文。", "c": "文c。"})
        self.assertEqual(sorted(self.finished), [0, 1, 2])
        self.assertEqual([request["source_parts"][0]["text"] for request in provider.recoveries], ["Sentence b."])
        self.assertEqual((self.state.attempts, self.state.unanswered), ({"a": 1, "b": 2, "c": 1}, {}))

    def test_timed_out_first_request_stops_and_counts_once_when_resumed(self):
        provider = GatedProvider(3, fail="b", error=TransientError("APIの応答がタイムアウトしました。", after_sending=True))
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
        provider = GatedProvider(3, fail="b", error=TransientError("APIに接続できません。", timed_out=True))
        with self.assertRaises(TransientError):
            self.run_batches(provider)
        self.assertEqual(self.accepted, {"a": "文a。", "c": "文c。"})
        self.assertEqual(self.state.unanswered, {"b": 1})
        self.assertEqual(self.state.answered_level(BATCHES[1][0]), 0)

    def test_answers_and_timeouts_in_flight_are_recorded_when_another_request_stops_the_run(self):
        barrier = threading.Barrier(3, timeout=5)

        class MixedProvider:
            persisted = {}

            def generate(self, instruction, data, schema=None):
                name = json.loads(data)["blocks"][0]["id"]
                barrier.wait()
                if name == "a":
                    raise RuntimeError("未ログインです。")
                time.sleep(0.2)  # Still in flight when the error of "a" stops the run.
                if name == "b":
                    raise AnswerRejected("AIの回答が出力上限で途切れました。")
                raise TransientError("APIの応答がタイムアウトしました。", after_sending=True)

        with self.assertRaisesRegex(RuntimeError, "未ログイン"):
            self.run_batches(MixedProvider())
        # "a" got no answer and is sent with a batch again; "b" was answered and "c" timed out:
        # both go to recovery when translation resumes (not now: the run is stopping).
        self.assertEqual(self.state.unanswered, {"a": 1, "c": MAX_UNANSWERED_SENDS})
        self.assertEqual([self.state.answered_level(batch[0]) for batch in BATCHES], [0, 1, 1])
        self.assertEqual(self.saved, self.state.to_cache())

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

    def test_a_stopped_run_leaves_the_cache_in_step_and_resumes_without_sending_twice(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            with fitz.open() as pdf:
                for number in range(1, 6):
                    pdf.new_page().insert_text((40, 70), f"Original content on page {number}.", fontsize=12)
                pdf.save(source)
            library = Library(root / "library")
            identity, _ = library.import_pdf(source)
            sent = []

            class StoppingProvider(FakeProvider):
                def __init__(self, fail):
                    super().__init__()
                    self.settings = Settings(translation_concurrency=3)
                    self.barrier = threading.Barrier(3, timeout=5)
                    self.fail = fail
                    self.lock = threading.Lock()

                def generate(inner, instruction, data, schema=None):
                    text = json.loads(data)["blocks"][0]["text"]
                    with inner.lock:
                        sent.append(text)
                    if inner.fail:
                        # Pages 1-3 are in flight together; page 2 fails and stops the run.
                        inner.barrier.wait()
                        if "page 2" in text:
                            raise RuntimeError("未ログインです。")
                        time.sleep(0.1)
                    with inner.lock:
                        return super().generate(instruction, data, schema)

            with self.assertRaisesRegex(RuntimeError, "未ログイン"):
                PaperService(library, StoppingProvider(True), threading.Event()).translate(identity)
            cache = json.loads((library.folder(identity) / "translation-cache.json").read_text("utf-8"))
            state = RetryState.from_cache(cache["retry_state"])
            # Pages 1 and 3 were answered and saved; page 2 was sent without an answer; 4 and 5 never went out.
            self.assertEqual(sorted(cache["completed_pages"]), ["1", "3"])
            self.assertEqual(len(state.unanswered), 1)
            self.assertEqual(len(state.attempts), 3)
            self.assertEqual(library.paper(identity)["status"], "翻訳途中・再開可")
            # Their pages are shown although their batches ended after the error.
            self.assertEqual(translated_page_numbers(library.folder(identity), 5), [1, 3])

            sent.clear()
            report = PaperService(library, StoppingProvider(False), threading.Event()).translate(identity)
            self.assertEqual(sorted(text.rsplit(" ", 1)[-1] for text in sent), ["2.", "4.", "5."])
            self.assertEqual(report["translated_pages"], [1, 2, 3, 4, 5])
            cache = json.loads((library.folder(identity) / "translation-cache.json").read_text("utf-8"))
            self.assertEqual(cache["retry_state"]["unanswered"], {})


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
