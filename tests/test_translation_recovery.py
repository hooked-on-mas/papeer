from __future__ import annotations

import json
import threading
import unittest

from papeer.providers import Cancelled
from papeer.translation.translation import (MAX_BLOCK_RETRIES, RetryState,
                                   _assemble_parts, translate_batch, validate_translations)


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

    def test_interrupted_request_is_charged_before_call_and_resume_changes_strategy(self):
        state = RetryState()
        journal = []
        def persist():
            journal.append(state.to_cache())
        provider = ScriptedProvider(translations(bad="欠落"), RuntimeError("offline"))
        with self.assertRaises(RuntimeError):
            translate_batch(provider, UNITS[1:], threading.Event(), lambda _: None, lambda _: None, state, persist)
        self.assertEqual(journal[-1], {"attempts": {"bad": 2}, "retry_calls": 1})
        resumed = ScriptedProvider(translations(text0="条件", text2="を使う"))
        saved = []
        state = RetryState.from_cache(journal[-1])
        translate_batch(resumed, UNITS[1:], threading.Event(), lambda _: None, saved.append, state, persist)
        self.assertEqual(len(resumed.calls), 1)
        self.assertIn("context_parts", resumed.calls[0][1])
        self.assertEqual(state.retry_calls, 2)
        self.assertEqual(saved, [{"bad": "条件" + A + "を使う" + B + "."}])

    def test_exhausted_block_is_skipped_and_fresh_blocks_are_sent(self):
        state = RetryState.from_cache(RetryState({"bad": 4}, 3).to_cache())
        provider = ScriptedProvider(translations(good="正常。"))
        saved = []
        translate_batch(provider, UNITS, threading.Event(), lambda _: None, saved.append, state)
        self.assertEqual(saved, [{"good": "正常。"}])
        self.assertEqual(provider.calls[0][1], UNITS[:1])
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
                      {"attempts": {"bad": True}, "retry_calls": 1}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                RetryState.from_cache(value)

    def test_duplicate_ids_are_not_salvaged(self):
        provider = ScriptedProvider({"translations": [{"id": "good", "text": "甲"}, {"id": "good", "text": "乙"}]},
                                    {"parts": [{"kind": "text", "text": "再翻訳。"}]})
        self.assertEqual(self.run_batch(provider, UNITS[:1]), [{"good": "再翻訳。"}])

    def test_valid_markers_plus_malformed_extra_marker_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "数式"):
            validate_translations(json.dumps(translations(bad=A + B + "[PD_MATH_p1b1_0]")), UNITS[1:])


if __name__ == "__main__":
    unittest.main()
