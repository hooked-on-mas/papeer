from __future__ import annotations

import json
import threading
import unittest

from papeer.core import prompts
from papeer.providers import AnswerRejected, Cancelled
from papeer.providers.common import TransientError
from papeer.translation.translation import (MAX_BLOCK_RETRIES, MAX_UNANSWERED_SENDS, RetryState,
                                   _assemble_parts, translate_batch, validate_translations)
from papeer.translation.translation_context import request_payload


A = "[[PD_MATH_p1b1_0]]"
B = "[[PD_MATH_p1b1_1]]"
UNITS = [{"id": "good", "page": 1, "text": "A normal sentence."},
         {"id": "bad", "page": 1, "text": f"For {A}, use {B}."}]


def translations(**values):
    return {"translations": [{"id": key, "text": value} for key, value in values.items()]}


class ScriptedProvider:
    def __init__(self, *answers):
        self.answers = iter(answers)
        self.calls = []

    def generate(self, instruction, data, schema=None):
        self.calls.append((instruction, json.loads(data), schema))
        answer = next(self.answers)
        if isinstance(answer, Exception):
            raise answer
        if callable(answer):
            answer = answer()
        return json.dumps(answer, ensure_ascii=False)


class TranslationRecoveryTests(unittest.TestCase):
    def run_batch(self, provider, units=UNITS, cancel=None):
        saved = []
        translate_batch(provider, units, cancel or threading.Event(), lambda _: None, saved.append)
        return saved

    def test_only_failed_block_retried_and_original_formulas_reassembled(self):
        provider = ScriptedProvider(translations(good="正常な文章。", bad="数式が欠落。"),
            {"parts": [{"kind": "math", "index": 1}, {"kind": "text", "text": "を"},
                       {"kind": "math", "index": 0}, {"kind": "text", "text": "に使う。"}]})
        saved = self.run_batch(provider)
        self.assertEqual(saved, [{"good": "正常な文章。"}, {"bad": B + "を" + A + "に使う。"}])
        self.assertEqual(len(provider.calls), 2)
        recovery_input = json.dumps(provider.calls[1][1])
        self.assertNotIn("PD_MATH", recovery_input)
        self.assertNotIn("normal sentence", recovery_input)

    def test_harmless_marker_typography_is_repaired_without_retry(self):
        provider = ScriptedProvider(translations(bad="［［ｐｄ＿ｍａｔｈ＿ｐ１ｂ１＿０］］と[[ PD_MATH_p1b1_1 ]]。"))
        self.assertEqual(self.run_batch(provider, UNITS[1:]), [{"bad": A + "と" + B + "。"}])
        self.assertEqual(len(provider.calls), 1)

    def test_unknown_marker_is_never_guessed(self):
        provider = ScriptedProvider(translations(bad=A.replace("b1", "b9") + B),
            {"parts": [{"kind": "math", "index": 0}, {"kind": "text", "text": "と"},
                       {"kind": "math", "index": 1}]})
        self.assertEqual(self.run_batch(provider, UNITS[1:]), [{"bad": A + "と" + B}])
        self.assertEqual(len(provider.calls), 2)

    def test_invalid_indices_and_embedded_markers_are_rejected(self):
        for parts in [[], [{"kind": "math", "index": 0}],
                      [{"kind": "math", "index": 0}] * 2,
                      [{"kind": "math", "index": 2}],
                      [{"kind": "math", "index": True}],
                      [{"kind": "text", "text": A}],
                      [{"kind": "math", "index": 0, "text": "extra"}]]:
            with self.subTest(parts=parts), self.assertRaises(ValueError):
                _assemble_parts(json.dumps({"parts": parts}), [A, B])

    LONG = {"id": "long", "page": 1,
            "text": f"For {A} we use the proposed estimator which is applied in all of the experiments that are reported below with {B}."}
    ENGLISH = [{"kind": "text", "text": "For "}, {"kind": "math", "index": 0},
               {"kind": "text", "text": " we use the proposed estimator which is applied in all of the experiments that are reported below with "},
               {"kind": "math", "index": 1}, {"kind": "text", "text": "."}]

    def test_untranslated_structured_retry_falls_back_to_fixed_positions(self):
        fragments = {"text0": "日本語", "text2": "日本語"}
        provider = ScriptedProvider(translations(long="欠落"), {"parts": self.ENGLISH}, translations(**fragments))
        saved = self.run_batch(provider, [self.LONG])
        self.assertEqual(saved, [{"long": "日本語" + A + "日本語" + B + "."}])
        self.assertEqual(len(provider.calls), 3)

    def test_untranslated_last_retry_skips_only_that_paragraph(self):
        english = {"text0": "For ", "text2": self.ENGLISH[2]["text"]}
        provider = ScriptedProvider(translations(long="欠落", good="正常な文章。"), {"parts": self.ENGLISH},
                                    *[translations(**english)] * (MAX_BLOCK_RETRIES - 1))
        saved = self.run_batch(provider, [self.LONG, UNITS[0]])
        self.assertEqual(saved, [{"good": "正常な文章。"}])
        self.assertEqual(len(provider.calls), 1 + MAX_BLOCK_RETRIES)

    def test_final_fallback_keeps_formula_positions_locally(self):
        provider = ScriptedProvider(translations(bad="欠落"), {"parts": []},
                                    translations(text0="条件", text2="では、使用するのは"))
        self.assertEqual(self.run_batch(provider, UNITS[1:]),
                         [{"bad": "条件" + A + "では、使用するのは" + B + "."}])
        self.assertEqual(len(provider.calls), 3)
        self.assertEqual(len({call[0] for call in provider.calls}), 3)
        self.assertIn("source_parts", provider.calls[1][1])
        self.assertIn("context_parts", provider.calls[2][1])
        self.assertEqual([x["id"] for x in provider.calls[-1][1]["texts"]], ["text0", "text2"])
        self.assertNotIn("PD_MATH", json.dumps(provider.calls[-1][1]))

    def test_good_items_saved_before_transport_failure(self):
        provider = ScriptedProvider(translations(good="保存する訳文。", bad="欠落"), RuntimeError("offline"))
        saved = []
        with self.assertRaisesRegex(RuntimeError, "offline"):
            translate_batch(provider, UNITS, threading.Event(), lambda _: None, saved.append)
        self.assertEqual(saved, [{"good": "保存する訳文。"}])

    def test_cancel_does_not_start_recovery_and_keeps_good_items(self):
        cancel = threading.Event()
        def answer():
            cancel.set()
            return translations(good="保存済み。", bad="欠落")
        provider = ScriptedProvider(answer)
        saved = []
        with self.assertRaises(Cancelled):
            translate_batch(provider, UNITS, cancel, lambda _: None, saved.append)
        self.assertEqual(saved, [{"good": "保存済み。"}])
        self.assertEqual(len(provider.calls), 1)

    def test_recovery_is_bounded_and_continues_to_next_failed_block(self):
        later = dict(UNITS[0], id="later")
        provider = ScriptedProvider(translations(good="保存済み。", bad="欠落"),
            {"parts": []}, translations(text0="一部のみ"), translations(text0="一部のみ"),
            {"parts": [{"kind": "text", "text": "次のブロック。"}]})
        saved, progress = [], []
        state = RetryState()
        translate_batch(provider, UNITS + [later], threading.Event(), progress.append, saved.append, state)
        self.assertEqual(saved, [{"good": "保存済み。"}, {"later": "次のブロック。"}])
        self.assertEqual(len(provider.calls), 5)
        self.assertEqual(state.attempts["bad"], 1 + MAX_BLOCK_RETRIES)
        self.assertTrue(any("bad" in message and "スキップ" in message for message in progress))

    def test_third_retry_can_succeed(self):
        provider = ScriptedProvider(translations(bad="欠落"), {"parts": []},
            translations(text0="一部のみ"), translations(text0="条件", text2="を使う"))
        self.assertEqual(self.run_batch(provider, UNITS[1:]), [{"bad": "条件" + A + "を使う" + B + "."}])
        self.assertEqual(len(provider.calls), 4)

    def test_paper_retries_are_unlimited_across_batches_and_reload(self):
        state = RetryState()
        for index in range(10):
            unit = dict(UNITS[1], id=f"unit{index}")
            provider = ScriptedProvider(translations(**{unit['id']: "欠落"}),
                {"parts": [{"kind": "math", "index": 0}, {"kind": "math", "index": 1}]})
            saved = []
            translate_batch(provider, [unit], threading.Event(), lambda _: None, saved.append, state)
            self.assertEqual(saved, [{unit["id"]: A + B}])
            self.assertEqual(len(provider.calls), 2)
            state = RetryState.from_cache(state.to_cache())
        self.assertEqual(state.retry_calls, 10)

    def test_interrupted_retry_is_recorded_before_call_and_resent_up_to_a_limit(self):
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(translations(bad="欠落"), TransientError("offline"))
        with self.assertRaises(TransientError):
            translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        # The retry is on record before it goes out, so even a crash mid-request cannot lose it.
        self.assertEqual(journal[-1], {"attempts": {"bad": 2}, "retry_calls": 1, "unanswered": {"bad": 1}})
        # It got no answer: resuming sends the same retry again instead of moving on to the next one.
        for sends in range(2, MAX_UNANSWERED_SENDS + 1):
            state = RetryState.from_cache(journal[-1])
            failing = ScriptedProvider(TransientError("offline"))
            with self.assertRaises(TransientError):
                translate_batch(failing, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
            self.assertIn("source_parts", failing.calls[0][1])
            self.assertEqual(journal[-1], {"attempts": {"bad": 2}, "retry_calls": sends, "unanswered": {"bad": sends}})
        # Past the limit it counts as a failed answer, so a request that never answers is not sent forever.
        resumed = ScriptedProvider(translations(text0="条件", text2="を使う"))
        saved = []
        state = RetryState.from_cache(journal[-1])
        translate_batch(resumed, UNITS[1:], threading.Event(), lambda _: None, saved.append, state, persist)
        self.assertEqual(len(resumed.calls), 1)
        self.assertIn("context_parts", resumed.calls[0][1])
        self.assertEqual((state.attempts, state.unanswered), ({"bad": 3}, {}))
        self.assertEqual(state.retry_calls, MAX_UNANSWERED_SENDS + 1)
        self.assertEqual(saved, [{"bad": "条件" + A + "を使う" + B + "."}])

    def test_request_errors_without_an_answer_stay_unanswered(self):
        # No answer came back: a dropped connection, but also a sign-in or a missing model name.
        for error in (TransientError("offline"), RuntimeError("未ログインです。"), ValueError("モデル名を設定してください。")):
            with self.subTest(error=error):
                state = RetryState()
                with self.assertRaises(type(error)):
                    translate_batch(ScriptedProvider(error), UNITS[1:], threading.Event(), lambda _: None,
                                    lambda _: None, state)
                self.assertEqual(state.to_cache(), {"attempts": {"bad": 1}, "retry_calls": 0, "unanswered": {"bad": 1}})
                self.assertEqual(state.answered_level(UNITS[1]), 0)

    def test_unusable_first_answer_goes_on_to_paragraph_recovery_at_once(self):
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(AnswerRejected("AIの回答が出力上限で途切れました。"),
                                    {"parts": [{"kind": "text", "text": "正常な文章。"}]},
                                    {"parts": [{"kind": "math", "index": 0}, {"kind": "math", "index": 1}]})
        saved, progress = [], []
        translate_batch(provider, UNITS, threading.Event(), progress.append, saved.append, state, persist)
        # Paid for and answered: on record before the first retry goes out, then each paragraph is asked alone.
        self.assertEqual(journal[1], {"attempts": {"good": 1, "bad": 1}, "retry_calls": 0, "unanswered": {}})
        self.assertEqual([("source_parts" in call[1]) for call in provider.calls[1:]], [True, True])
        self.assertEqual(saved, [{"good": "正常な文章。"}, {"bad": A + B}])
        self.assertEqual(state.to_cache(), {"attempts": {"good": 2, "bad": 2}, "retry_calls": 2, "unanswered": {}})
        self.assertTrue(any("出力上限" in message and "段落ごと" in message for message in progress))

    def test_unusable_recovery_answer_after_an_unusable_first_answer_stops_the_run(self):
        # A service that keeps cutting answers off is not asked again for every paragraph of the paper.
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(AnswerRejected("AIの回答が出力上限で途切れました。"),
                                    AnswerRejected("AIの回答が出力上限で途切れました。"))
        with self.assertRaises(AnswerRejected):
            translate_batch(provider, UNITS, threading.Event(), lambda _: None, lambda _: None, state, persist)
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(journal[-1], {"attempts": {"good": 2, "bad": 1}, "retry_calls": 1, "unanswered": {}})
        # Resuming moves on: the next retry for the first paragraph, the first retry for the second.
        resumed = ScriptedProvider(translations(text0="正常な文章。"),
                                   {"parts": [{"kind": "math", "index": 0}, {"kind": "math", "index": 1}]})
        saved = self.run_batch_with_state(resumed, UNITS, RetryState.from_cache(journal[-1]))
        self.assertEqual([("context_parts" in call[1], "source_parts" in call[1]) for call in resumed.calls],
                         [(True, False), (False, True)])
        self.assertEqual(saved, [{"good": "正常な文章。"}, {"bad": A + B}])

    def test_timed_out_first_request_counts_once_when_resumed(self):
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(TransientError("APIの応答がタイムアウトしました。", after_sending=True))
        with self.assertRaises(TransientError):
            translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        # A timeout may have used tokens up to then: resuming does not send the same batch again.
        self.assertEqual(journal[-1], {"attempts": {"bad": 1}, "retry_calls": 0,
                                       "unanswered": {"bad": MAX_UNANSWERED_SENDS}})
        resumed = ScriptedProvider({"parts": [{"kind": "math", "index": 1}, {"kind": "math", "index": 0}]})
        state = RetryState.from_cache(journal[-1])
        self.assertEqual(self.run_batch_with_state(resumed, UNITS[1:], state), [{"bad": B + A}])
        self.assertIn("source_parts", resumed.calls[0][1])
        self.assertEqual(state.to_cache(), {"attempts": {"bad": 2}, "retry_calls": 1, "unanswered": {}})

    def test_timeout_while_connecting_stays_an_ordinary_unanswered_request(self):
        # Sleep or a VPN dropping: the request never reached the service and used no tokens,
        # so resuming sends it again as it was.
        for error in (TransientError("APIに接続できません。", timed_out=True), TransientError("接続断")):
            with self.subTest(error=error):
                state = RetryState()
                with self.assertRaises(TransientError):
                    translate_batch(ScriptedProvider(error), UNITS[1:], threading.Event(), lambda _: None,
                                    lambda _: None, state)
                self.assertEqual(state.to_cache(), {"attempts": {"bad": 1}, "retry_calls": 0, "unanswered": {"bad": 1}})
                self.assertEqual(state.answered_level(UNITS[1]), 0)

    def test_timed_out_retry_moves_on_to_the_next_retry_when_resumed(self):
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(translations(bad="欠落"), TransientError("タイムアウト", after_sending=True))
        with self.assertRaises(TransientError):
            translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        self.assertEqual(journal[-1], {"attempts": {"bad": 2}, "retry_calls": 1,
                                       "unanswered": {"bad": MAX_UNANSWERED_SENDS}})
        resumed = ScriptedProvider(translations(text0="条件", text2="を使う"))
        state = RetryState.from_cache(journal[-1])
        self.assertEqual(self.run_batch_with_state(resumed, UNITS[1:], state), [{"bad": "条件" + A + "を使う" + B + "."}])
        self.assertIn("context_parts", resumed.calls[0][1])
        self.assertEqual((state.attempts, state.unanswered, state.retry_calls), ({"bad": 3}, {}, 2))

    def test_unusable_retry_answer_moves_on_to_the_next_retry(self):
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(translations(bad="欠落"), AnswerRejected("APIからテキストの回答が返りませんでした。"))
        with self.assertRaises(AnswerRejected):
            translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        self.assertEqual(journal[-1], {"attempts": {"bad": 2}, "retry_calls": 1, "unanswered": {}})
        resumed = ScriptedProvider(translations(text0="条件", text2="を使う"))
        saved = self.run_batch_with_state(resumed, UNITS[1:], RetryState.from_cache(journal[-1]))
        self.assertIn("context_parts", resumed.calls[0][1])
        self.assertEqual(saved, [{"bad": "条件" + A + "を使う" + B + "."}])

    def test_cancel_after_a_failed_retry_answer_keeps_it_on_record(self):
        cancel = threading.Event()
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        def invalid_then_cancel():
            cancel.set()
            return {"parts": []}
        provider = ScriptedProvider(translations(bad="欠落"), invalid_then_cancel)
        with self.assertRaises(Cancelled):
            translate_batch(provider, UNITS[1:], cancel, lambda _: None, lambda _: None, state, persist)
        self.assertEqual(journal[-1], {"attempts": {"bad": 2}, "retry_calls": 1, "unanswered": {}})

    def test_unanswered_retry_answered_on_resume_keeps_its_strategy(self):
        state = RetryState.from_cache({"attempts": {"bad": 2}, "retry_calls": 1, "unanswered": {"bad": 1}})
        provider = ScriptedProvider({"parts": [{"kind": "math", "index": 0}, {"kind": "text", "text": "と"},
                                               {"kind": "math", "index": 1}]})
        saved = self.run_batch_with_state(provider, UNITS[1:], state)
        self.assertEqual(saved, [{"bad": A + "と" + B}])
        self.assertIn("source_parts", provider.calls[0][1])
        self.assertEqual((state.attempts, state.unanswered, state.retry_calls), ({"bad": 2}, {}, 2))

    def test_unanswered_first_request_goes_back_to_a_normal_batch(self):
        cancel = threading.Event()
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        def cancelled():
            cancel.set()
            raise Cancelled()
        provider = ScriptedProvider(cancelled)
        with self.assertRaises(Cancelled):
            translate_batch(provider, UNITS, cancel, lambda _: None, lambda _: None, state, persist)
        self.assertEqual(journal[-1], {"attempts": {"good": 1, "bad": 1}, "retry_calls": 0,
                                       "unanswered": {"good": 1, "bad": 1}})
        resumed = ScriptedProvider(translations(good="正常な文章。", bad=A + "には" + B + "を使う。"))
        state = RetryState.from_cache(journal[-1])
        saved = self.run_batch_with_state(resumed, UNITS, state, persist)
        # One normal request for both blocks, no recovery request and no retry spent.
        self.assertEqual([call[1] for call in resumed.calls], [request_payload(UNITS)])
        self.assertEqual(saved, [{"good": "正常な文章。", "bad": A + "には" + B + "を使う。"}])
        self.assertEqual(journal[-1]["unanswered"], {"good": 2, "bad": 2})  # Recorded before the request went out.
        self.assertEqual(state.to_cache(), {"attempts": {"good": 1, "bad": 1}, "retry_calls": 0, "unanswered": {}})

    def test_first_request_without_answers_counts_once_the_limit_is_reached(self):
        state = RetryState.from_cache({"attempts": {"bad": 1}, "retry_calls": 0,
                                       "unanswered": {"bad": MAX_UNANSWERED_SENDS}})
        provider = ScriptedProvider({"parts": [{"kind": "math", "index": 1}, {"kind": "math", "index": 0}]})
        self.assertEqual(self.run_batch_with_state(provider, UNITS[1:], state), [{"bad": B + A}])
        self.assertIn("source_parts", provider.calls[0][1])
        self.assertEqual((state.attempts, state.unanswered), ({"bad": 2}, {}))

    def test_cache_without_unanswered_record_counts_sent_blocks_as_answered(self):
        # Written before the unanswered record: a block sent once goes to recovery, as it did then.
        state = RetryState.from_cache({"attempts": {"bad": 1}, "retry_calls": 0})
        provider = ScriptedProvider({"parts": [{"kind": "math", "index": 0}, {"kind": "math", "index": 1}]})
        self.assertEqual(self.run_batch_with_state(provider, UNITS[1:], state), [{"bad": A + B}])
        self.assertIn("source_parts", provider.calls[0][1])
        self.assertEqual(state.to_cache(), {"attempts": {"bad": 2}, "retry_calls": 1, "unanswered": {}})

    def test_request_error_during_recovery_does_not_spend_retries(self):
        # A ValueError of the request itself (here a missing model name) is no failed answer.
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(translations(bad="欠落"), {"parts": []}, ValueError("モデル名を設定してください。"))
        with self.assertRaisesRegex(ValueError, "モデル名"):
            translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        self.assertEqual(len(provider.calls), 3)
        self.assertEqual(journal[-1], {"attempts": {"bad": 3}, "retry_calls": 2, "unanswered": {"bad": 1}})

    def test_last_retry_without_answer_is_sent_again(self):
        state = RetryState.from_cache({"attempts": {"bad": 4}, "retry_calls": 3, "unanswered": {"bad": 1}})
        self.assertFalse(state.exhausted(UNITS[1]))
        provider = ScriptedProvider(translations(text0="条件", text2="を使う"))
        self.assertEqual(self.run_batch_with_state(provider, UNITS[1:], state), [{"bad": "条件" + A + "を使う" + B + "."}])
        self.assertEqual((state.attempts, state.unanswered), ({"bad": 4}, {}))

    def test_skipped_block_records_its_last_answer(self):
        # The last retry was answered (and failed): the record says so, and reopening skips the block.
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(translations(bad="欠落"), {"parts": []},
                                    *[translations(text0="一部のみ")] * (MAX_BLOCK_RETRIES - 1))
        translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        self.assertEqual(journal[-1], {"attempts": {"bad": 4}, "retry_calls": 3, "unanswered": {}})
        self.assertTrue(RetryState.from_cache(journal[-1]).exhausted(UNITS[1]))

    def run_batch_with_state(self, provider, units, state, save=lambda: None):
        saved = []
        translate_batch(provider, units, threading.Event(), lambda _: None, saved.append, state, save)
        return saved

    def test_exhausted_block_is_skipped_and_fresh_blocks_are_sent(self):
        state = RetryState.from_cache(RetryState({"bad": 4}, 3).to_cache())
        provider = ScriptedProvider(translations(good="正常。"))
        saved = []
        translate_batch(provider, UNITS, threading.Event(), lambda _: None, saved.append, state)
        self.assertEqual(saved, [{"good": "正常。"}])
        self.assertEqual(provider.calls[0][1], request_payload(UNITS[:1]))
        self.assertEqual(state.attempts["bad"], 4)

    def test_old_exhausted_record_gets_one_more_retry(self):
        state = RetryState.from_cache({"attempts": {"bad": 3}, "retry_calls": 6})
        provider = ScriptedProvider(translations(text0="条件", text2="を使う"))
        saved = []
        translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, saved.append, state)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(state.attempts["bad"], 4)
        self.assertEqual(len(saved), 1)

    def test_corrupt_retry_record_is_not_silently_reset(self):
        for value in [{}, {"attempts": {}, "retry_calls": -1},
                      {"attempts": {"bad": True}, "retry_calls": 1},
                      {"attempts": {"bad": 1}, "retry_calls": 0, "unanswered": []},
                      {"attempts": {}, "retry_calls": 0, "unanswered": {"bad": 1}},
                      {"attempts": {"bad": 1}, "retry_calls": 0, "unanswered": {"bad": 0}},
                      {"attempts": {"bad": 1}, "retry_calls": 0, "unanswered": {"bad": MAX_UNANSWERED_SENDS + 1}}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                RetryState.from_cache(value)

    def test_duplicate_ids_are_not_salvaged(self):
        provider = ScriptedProvider({"translations": [{"id": "good", "text": "甲"}, {"id": "good", "text": "乙"}]},
                                    {"parts": [{"kind": "text", "text": "再翻訳。"}]})
        self.assertEqual(self.run_batch(provider, UNITS[:1]), [{"good": "再翻訳。"}])

    def test_valid_markers_plus_malformed_extra_marker_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "数式"):
            validate_translations(json.dumps(translations(bad=A + B + "[PD_MATH_p1b1_0]")), UNITS[1:])


def test_edited_translation_prompt_applies_without_restart():
    # The settings dialog saves overrides into the data folder while the app keeps running.
    # conftest.py gives this test its own empty data folder, so the override stays here.
    builtin = prompts.defaults()["translation"]
    first = ScriptedProvider(translations(good="訳文。"))
    translate_batch(first, UNITS[:1], threading.Event(), lambda _: None, lambda _: None)
    assert first.calls[0][0] == builtin

    prompts.save_overrides({"translation": "編集した翻訳指示"})
    edited = ScriptedProvider(translations(good="訳文。"))
    translate_batch(edited, UNITS[:1], threading.Event(), lambda _: None, lambda _: None)
    assert edited.calls[0][0] == "編集した翻訳指示"


if __name__ == "__main__":
    unittest.main()
