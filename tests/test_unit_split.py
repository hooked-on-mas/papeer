"""Splitting long blocks into translation units, and joining their translations again."""
import time
import unittest

from papeer.layout.math_layout import MATH_TOKEN
from papeer.layout.reading_flow import UNIT_JOINER, join_unit_translations, resolve_unit_joins
from papeer.pdf.pdf_engine import translation_units
from papeer.pdf.pdf_typography import TextStyle, text_html


def units_of(text, limit):
    return [u["text"] for u in translation_units({"blocks": [{"id": "p1b1", "page": 1, "text": text}]}, limit=limit)]


class UnitSplitTests(unittest.TestCase):
    def test_long_block_is_cut_after_the_last_sentence_before_the_limit(self):
        text = "The first sentence is short. The second sentence is a little longer. The third one ends here."
        parts = units_of(text, 80)
        self.assertEqual("".join(parts), text)
        self.assertEqual(parts[0], "The first sentence is short. The second sentence is a little longer. ")
        self.assertTrue(all(len(p) <= 80 for p in parts))
        # Short enough blocks stay whole.
        self.assertEqual(units_of(text, len(text)), [text])

    def test_question_marks_and_closing_quotes_end_sentences(self):
        text = 'Does it converge? "Yes." We prove it in the next section of the paper.'
        self.assertEqual(units_of(text, 30)[0], 'Does it converge? "Yes." ')

    def test_mid_sentence_periods_are_not_sentence_ends(self):
        # Abbreviations, initials, decimals and formulas followed by a capital: the only
        # candidates are spaces, so the cut is the last space within the limit, never after them.
        for text in ("Controllers are compared, e.g. Fig. 3 and Eq. 4 show Results beyond the limit",
                     "The method of J. Smith and Smith et al. Improved results were obtained later on",
                     "The gain was 3.5 Nm and the error was 0.82 Percent over the whole horizon",
                     "Data from the U.S. Army and i.e. Other sources were collected over many years"):
            parts = units_of(text, 60)
            self.assertEqual("".join(parts), text)
            self.assertEqual(parts[0], text[:text.rindex(" ", 0, 60) + 1], text)
        # The same periods followed by a lowercase word or a digit never match either.
        text = "See Fig. 3 for details, cf. the appendix. Then Sec. 2 gives more. Finally we conclude the paper."
        self.assertEqual(units_of(text, 70)[0], "See Fig. 3 for details, cf. the appendix. Then Sec. 2 gives more. ")

    def test_sentence_ending_with_a_formula_is_a_sentence_end(self):
        token = "[[PD_MATH_p1b1_0]]"
        text = f"The state evolves as {token}. Then the controller responds to the error signal quickly."
        parts = units_of(text, 60)
        self.assertEqual(parts[0], f"The state evolves as {token}. ")
        self.assertEqual(sum(len(MATH_TOKEN.findall(p)) for p in parts), 1)

    def test_without_sentence_end_the_cut_is_at_a_space_and_never_inside_a_formula(self):
        text = "word " * 30
        parts = units_of(text, 42)
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(p.endswith(" ") and len(p) <= 42 for p in parts))
        token = "[[PD_MATH_p1b1_0]]"
        text = "x" * 10 + token + "y" * 40
        parts = units_of(text, 20)
        self.assertEqual("".join(parts), text)
        self.assertEqual(sum(len(MATH_TOKEN.findall(p)) for p in parts), 1)

    def test_unit_starting_inside_a_word_still_finds_the_sentence_end(self):
        # The cut after a math marker longer than the limit leaves ". Then" at the next start.
        token = "[[PD_MATH_p1b1_0]]"
        parts = units_of(f"{token}. Then the next part follows. And one more sentence here", 18)
        self.assertEqual(parts[:2], [token, ". "])

    def test_very_long_block_is_split_in_linear_time(self):
        sentence = "The controller e.g. Fig. 3 reduces the error by 3.5 percent in J. Smith et al. Results hold. "
        text = sentence * (100_000 // len(sentence) + 1)
        started = time.perf_counter()
        parts = units_of(text, 6500)
        self.assertLess(time.perf_counter() - started, 1.0)
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(len(p) <= 6500 and p.endswith("Results hold. ") for p in parts[:-1]))
        # A block without any space (e.g. Japanese source) as well.
        started = time.perf_counter()
        parts = units_of("これは文です。" * 15_000, 6500)
        self.assertLess(time.perf_counter() - started, 1.0)
        self.assertEqual(len(parts), 17)

    def test_joined_translations_continue_the_paragraph(self):
        joined = join_unit_translations(["第一の文である。", "第二の文である。"])
        self.assertIn(UNIT_JOINER, joined)
        self.assertEqual(resolve_unit_joins(joined), "第一の文である。第二の文である。")
        # An untranslated (source) part keeps a space between English words only.
        self.assertEqual(resolve_unit_joins(join_unit_translations(["end of it. ", "Next part"])), "end of it. Next part")
        self.assertEqual(resolve_unit_joins(join_unit_translations(["using PyTorch", "BERT は"])), "using PyTorch BERT は")
        self.assertEqual(resolve_unit_joins(join_unit_translations(["訳文。", "BERT は"])), "訳文。BERT は")
        self.assertEqual(resolve_unit_joins(join_unit_translations(["(see", ")"])), "(see)")
        self.assertEqual(resolve_unit_joins(UNIT_JOINER + "訳" + UNIT_JOINER), "訳")
        # Real line breaks in a translation are kept.
        self.assertEqual(resolve_unit_joins("一行目\n二行目"), "一行目\n二行目")

    def test_split_point_is_not_typeset_as_a_paragraph(self):
        style = TextStyle("body", 10, 1.4)
        markup = text_html(join_unit_translations(["第一の文である。", "第二の文である。"]), style, {}, first_indent=True)
        self.assertEqual(markup.count("<p "), 1)
        self.assertIn("第一の文である。第二の文である。", markup)
        self.assertNotIn(UNIT_JOINER, markup)
        self.assertEqual(text_html("段落一。\n段落二。", style, {}).count("<p "), 2)


if __name__ == "__main__":
    unittest.main()
