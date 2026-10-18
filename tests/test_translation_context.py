import json
import unittest

from papeer.translation.translation_context import contextual_units, recovery_context
from papeer.translation.translation import validate_translations


class ContextTests(unittest.TestCase):
    def test_english_paragraph_cannot_be_accepted_as_japanese(self):
        source = "This method is used to calculate the probability that a system reaches the unsafe region."
        with self.assertRaisesRegex(ValueError, "日本語"):
            validate_translations(json.dumps({"translations": [{"id": "a", "text": source}]}),
                                  [{"id": "a", "text": source}])
        name = "Ulrich Abel"
        self.assertEqual(validate_translations(json.dumps({"translations": [{"id": "a", "text": name}]}),
                                               [{"id": "a", "text": name}]), {"a": name})
    def test_page_break_context_skips_page_number_and_describes_math(self):
        token = "[[PD_MATH_p2b1_0]]"
        blocks = [{"id": "p1b1", "text": "Previous prose " * 9 + "chance-"},
                  {"id": "p1b2", "text": "89"},
                  {"id": "p2b1", "text": "constrained optimization " * 6 + token,
                   "formulas": [{"token": token, "text": "x ∈ K"}]}]
        units = [{"id": b["id"] + "_0", "block": b["id"], "page": 1 if i < 2 else 2, "text": b["text"]}
                 for i, b in enumerate(blocks)]
        result = contextual_units({"blocks": blocks}, units)
        self.assertTrue(result[2]["context"]["before"].endswith("chance-"))
        self.assertTrue(result[0]["context"]["after"].startswith("constrained"))
        self.assertIn("x ∈ K", result[0]["context"]["after"])
        self.assertNotIn("context", units[0])
        recovery = recovery_context(result[2])
        self.assertEqual(recovery["formula_meanings"], [{"index": 0, "source": "x ∈ K"}])
        self.assertNotIn("PD_MATH", str(recovery))

    def test_context_is_bounded(self):
        blocks = [{"id": str(i), "text": "word " * 1000} for i in range(3)]
        units = [{"id": str(i), "block": str(i), "page": i + 1, "text": b["text"]}
                 for i, b in enumerate(blocks)]
        context = contextual_units({"blocks": blocks}, units, limit=200)[1]["context"]
        self.assertLessEqual(len(context["before"]), 200)
        self.assertLessEqual(len(context["after"]), 200)
