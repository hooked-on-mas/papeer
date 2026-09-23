import json
from pathlib import Path
import tempfile
import threading
import unittest

import pymupdf as fitz

from paperdesk.layout.math_layout import LAYOUT_VERSION, MATH_TOKEN, _math_ranges, annotate_math_fonts, formula_only_block, layout_blocks, merge_overlapping_prose
from paperdesk.pdf.pdf_engine import build_translated_pdf, extract_pdf, translation_units
from paperdesk.core.service import PaperService, validate_translations
from paperdesk.core.storage import Library
from test_workflow import FakeProvider


def make_math_pdf(path, rotation=0):
    with fitz.open() as pdf:
        page = pdf.new_page(width=420, height=420)
        page.insert_text((35, 40), "Controller Design", fontname="hebo", fontsize=14)
        # All spans share a baseline but have different fonts and scripts.
        page.insert_text((35, 80), "The state ", fontname="tiro", fontsize=11)
        page.insert_text((79, 80), "x", fontname="tiit", fontsize=11)
        page.insert_text((85, 83), "k", fontname="tiit", fontsize=7)
        page.insert_text((91, 80), " evolves under feedback control.", fontname="tiro", fontsize=11)
        page.insert_text((105, 135), "x(k + 1) = A x(k) + B u(k)", fontname="tiit", fontsize=12)
        page.insert_text((355, 135), "(1)", fontname="tiro", fontsize=10)
        page.insert_text((35, 180), "The energy is defined by the following expression.", fontname="tiro", fontsize=11)
        page.insert_text((120, 225), "E(q) =", fontname="tiit", fontsize=12)
        page.insert_text((165, 218), "1", fontname="tiro", fontsize=10)
        page.draw_line((162, 222), (173, 222))
        page.insert_text((165, 233), "2", fontname="tiro", fontsize=10)
        page.insert_text((180, 225), "q", fontname="tiit", fontsize=12)
        page.insert_text((187, 219), "T", fontname="tiit", fontsize=7)
        page.insert_text((194, 225), "K q", fontname="tiit", fontsize=12)
        page.insert_text((355, 225), "(2)", fontname="tiro", fontsize=10)
        page.insert_text((35, 280), "This is a normal italic sentence, with no formula.", fontname="tiit", fontsize=11)
        page.set_rotation(rotation)
        pdf.save(path)


class MathLayoutTests(unittest.TestCase):
    def test_short_prose_row_with_tall_math_does_not_absorb_next_row(self):
        with fitz.open() as pdf:
            page = pdf.new_page()
            page.insert_text((40, 100), "over ", fontname="tiro", fontsize=10)
            page.insert_text((60, 100), "x = 1", fontname="tiit", fontsize=10)
            page.insert_text((40, 112), "Then, the variables follow a mixture.", fontname="tiro", fontsize=10)
            lines = [line for item in page.get_text("rawdict")["blocks"] for line in item.get("lines", [])]
        for line in lines:
            if line["spans"][0]["origin"][1] == 100:
                line["bbox"] = [line["bbox"][0], 92, line["bbox"][2], 110]
        blocks = layout_blocks({"lines": lines}, 1, 1)
        text = "\n".join(b["text"] for b in blocks)
        self.assertIn("over x = 1\nThen, the variables follow a mixture.", text)
        formulas = [f for b in blocks for f in b["formulas"]]
        self.assertEqual([f["text"] for f in formulas], ["x = 1"])
        self.assertTrue(all(y == 100 for f in formulas for x, y in f["glyph_origins"]))

    def test_multiple_integral_differentials_are_math_not_prose(self):
        for differential in ("dudv", "dxdy", "dudvdz", "du dv"):
            block = dict(text="integrand " + differential,
                         translation_text="[[PD_MATH_p1b1_0]]" + differential,
                         formulas=[dict(token="[[PD_MATH_p1b1_0]]")])
            self.assertTrue(formula_only_block(block))
            self.assertFalse(formula_only_block(dict(block,
                translation_text=block['translation_text'] + " is nonnegative")))

    def test_same_baseline_prose_keeps_optimal_value_and_subscript_together(self):
        # The second fragment has a tall symbol box. Its bottom edge differs
        # from the first fragment even though both sentences share a baseline.
        with fitz.open() as pdf:
            page = pdf.new_page()
            page.insert_text((40, 100), "with optimal value ", fontname="tiro", fontsize=10)
            page.insert_text((117, 100), "J", fontname="tiit", fontsize=10)
            page.insert_text((122, 96), "*", fontname="tiit", fontsize=7)
            page.insert_text((122, 103), "CP", fontname="tiro", fontsize=7)
            page.insert_text((135, 100), "and feasible set", fontname="tiro", fontsize=10)
            lines = [line for item in page.get_text("rawdict")["blocks"] for line in item.get("lines", [])]
        first = [span for line in lines for span in line["spans"] if span["origin"][0] < 130 and span["size"] != 7 or span["origin"][1] == 96]
        second = [span for line in lines for span in line["spans"] if span not in first]
        for span in first:
            if "".join(c["c"] for c in span["chars"]).strip() == "J":
                span["font"] = "CMMI10"
            elif span["origin"][1] == 96:
                span["font"] = "CMMI7"
        # Simulate the publisher's two extracted fragments, including a
        # reversed extraction order caused by the upper script bounds.
        split = [{"bbox": [122, 90, 210, 114], "spans": second},
                 {"bbox": [40, 90, 130, 104], "spans": first}]
        block = layout_blocks({"lines": split}, 1, 1)[0]
        self.assertTrue(block["text"].startswith("with optimal value"))
        self.assertEqual(len(block["formulas"]), 1)
        self.assertIn("J", block["formulas"][0]["text"])
        self.assertIn("CP", block["formulas"][0]["text"].replace("*", ""))
        self.assertNotIn("CP", block["translation_text"])

    def test_optimization_problem_label_and_min_are_display_math(self):
        with fitz.open() as pdf:
            page = pdf.new_page()
            page.insert_text((40, 100), "CP", fontname="tiro", fontsize=10)
            page.insert_text((55, 102), "e", fontname="tiit", fontsize=7)
            page.insert_text((62, 100), ": min", fontname="tiro", fontsize=10)
            lines = [line for item in page.get_text("rawdict")["blocks"] for line in item.get("lines", [])]
        self.assertTrue(all(b["kind"] == "formula" for b in layout_blocks({"lines": lines}, 1, 1)))

    def test_overlapping_paragraph_fragments_share_layout_box(self):
        a = {"id": "a", "kind": "text", "bbox": [40, 100, 280, 125], "text": "The sum",
             "translation_text": "The sum", "formulas": [], "regions": [[40, 100, 280, 125]]}
        b = dict(a, id="b", bbox=[40, 115, 280, 160], text="is bounded.", translation_text="is bounded.")
        right = dict(a, id="right", bbox=[320, 100, 560, 125])
        blocks = merge_overlapping_prose([a, right, b])
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["text"], "The sum\nis bounded.")
        self.assertEqual(blocks[0]["bbox"], [40, 100, 280, 160])
        self.assertEqual(a["text"], "The sum")

    def test_italic_articles_next_to_formulas_remain_prose(self):
        text = "Definition 1. A hybrid system has X = R a domain of states."
        chars = [{"c": c, "font": "Italic", "flags": 6, "size": 10,
                  "math_font": False} for c in text]
        protected = [text[a:b] for a, b in _math_ranges(chars)]
        self.assertEqual(protected, ["X = R"])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "math.pdf"
        make_math_pdf(self.source)

    def tearDown(self):
        self.tmp.cleanup()

    def test_display_equations_and_fraction_keep_original_pixels(self):
        document = extract_pdf(self.source)
        formulas = [b for b in document["blocks"] if b["kind"] == "formula"]
        self.assertTrue(any("x(k" in b["text"] for b in formulas))
        self.assertTrue(any("E(q)" in b["text"] for b in formulas))
        units = translation_units(document)
        self.assertFalse(set(b["id"] for b in formulas) & set(u["block"] for u in units))
        # Even a stale caller supplying a translation for math cannot erase it.
        translations = {b["id"]: "状態を制御します。" + " ".join(f["token"] for f in b["formulas"])
                        for b in document["blocks"]}
        destination = self.root / "translated.pdf"
        report = build_translated_pdf(self.source, document, translations, destination)
        self.assertGreater(report["inline_formulas"], 0)
        with fitz.open(self.source) as original, fitz.open(destination) as translated:
            self.assertEqual(translated.page_count, original.page_count)
            for rect in (fitz.Rect(100, 110, 380, 150), fitz.Rect(110, 205, 380, 240)):
                a = original[0].get_pixmap(clip=rect, matrix=fitz.Matrix(2, 2))
                b = translated[0].get_pixmap(clip=rect, matrix=fitz.Matrix(2, 2))
                self.assertEqual(a.samples, b.samples)
            self.assertIn("状態", translated[0].get_text())
            self.assertNotIn("PD_MATH", translated[0].get_text())
            self.assertTrue(translated[0].get_images())

    def test_inline_subscript_is_one_crop_and_prose_is_translatable(self):
        document = extract_pdf(self.source)
        block = next(b for b in document["blocks"] if "The state" in b["text"])
        self.assertEqual(block["kind"], "text")
        self.assertEqual(len(block["formulas"]), 1)
        self.assertEqual(block["formulas"][0]["text"].replace(" ", ""), "xk")
        self.assertIn("evolves under feedback control", block["translation_text"])
        prose = next(b for b in document["blocks"] if "normal italic" in b["text"])
        self.assertEqual(prose["kind"], "text")
        self.assertEqual(prose["formulas"], [])

    def test_mixed_pdf_block_is_split_around_display_math(self):
        with fitz.open(self.source) as pdf:
            lines = [line for b in pdf[0].get_text("rawdict")["blocks"] if b["type"] == 0
                     for line in b["lines"] if 150 < line["bbox"][1] < 240]
            blocks = layout_blocks({"lines": lines}, 1, 1)
        self.assertEqual(blocks[0]["kind"], "text")
        self.assertTrue(any(b["kind"] == "formula" for b in blocks[1:]))
        self.assertNotIn("E(q)", blocks[0]["translation_text"])

    def test_math_fonts_with_opaque_names_and_missing_italic_flags(self):
        with fitz.open(self.source) as pdf:
            items = [b for b in pdf[0].get_text("rawdict")["blocks"] if b["type"] == 0 and b["bbox"][1] < 250]
        for item in items:
            for line in item["lines"]:
                for span in line["spans"]:
                    if "Italic" in span["font"]:
                        span["font"], span["flags"] = "OpaqueSubsetA", 4
        annotate_math_fonts(items)
        blocks = []
        for item in items:
            blocks.extend(layout_blocks(item, 1, len(blocks) + 1))
        inline = next(b for b in blocks if "The state" in b["text"])
        self.assertEqual(len(inline["formulas"]), 1)
        self.assertTrue(any(b["kind"] == "formula" and "x(k" in b["text"] for b in blocks))

    def test_invalid_formula_output_does_not_overwrite_existing_pdf(self):
        document = extract_pdf(self.source)
        block = next(b for b in document["blocks"] if b["formulas"])
        destination = self.root / "existing.pdf"
        destination.write_bytes(self.source.read_bytes())
        original = destination.read_bytes()
        with self.assertRaisesRegex(ValueError, "数式"):
            build_translated_pdf(self.source, document, {block["id"]: "数式が欠落した訳文"}, destination)
        self.assertEqual(destination.read_bytes(), original)

    def test_overlapping_text_box_cannot_erase_display_math(self):
        document = extract_pdf(self.source)
        prose = next(b for b in document["blocks"] if "The energy" in b["text"])
        prose["bbox"][3] = 240
        destination = self.root / "overlap.pdf"
        build_translated_pdf(self.source, document, {prose["id"]: "エネルギーは以下で定義する。"}, destination)
        with fitz.open(self.source) as a, fitz.open(destination) as b:
            clip = fitz.Rect(110, 205, 380, 240)
            before = a[0].get_pixmap(clip=clip, matrix=fitz.Matrix(2, 2)).samples
            after = b[0].get_pixmap(clip=clip, matrix=fitz.Matrix(2, 2)).samples
            # A clipped PDF form can round antialiasing at its boundary.
            self.assertLessEqual(max(abs(x - y) for x, y in zip(before, after)), 3)
            self.assertIn("エネルギー", b[0].get_text())

    def test_tokens_must_survive_exactly_once(self):
        token = "[[PD_MATH_p1b1_0]]"
        expected = [{"id": "a", "text": "The value " + token}]
        for value in ("値", token + token, "[[PD_MATH_p1b1_1]]"):
            with self.assertRaisesRegex(ValueError, "数式"):
                validate_translations(json.dumps({"translations": [{"id": "a", "text": value}]}), expected)
        valid = "値は" + token + "である。"
        self.assertEqual(validate_translations(json.dumps({"translations": [{"id": "a", "text": valid}]}), expected)["a"], valid)

    def test_formula_union_box_enclosing_prose_uses_line_regions(self):
        document = extract_pdf(self.source)
        prose = next(b for b in document["blocks"] if "The energy" in b["text"])
        equations = [b for b in document["blocks"] if b["kind"] == "formula"]
        box = fitz.Rect(prose["bbox"])
        for equation in equations:
            box |= fitz.Rect(equation["bbox"])
        combined = dict(equations[0], bbox=list(box),
                        regions=[r for b in equations for r in b["regions"]])
        document["blocks"] = [b for b in document["blocks"] if b["kind"] != "formula"] + [combined]
        destination = self.root / "enclosed.pdf"
        build_translated_pdf(self.source, document, {prose["id"]: "エネルギーは以下で定義する。"}, destination)
        with fitz.open(self.source) as original, fitz.open(destination) as translated:
            self.assertIn("エネルギー", translated[0].get_text())
            for clip in (fitz.Rect(100, 110, 380, 150), fitz.Rect(110, 205, 380, 240)):
                self.assertEqual(original[0].get_pixmap(clip=clip).samples,
                                 translated[0].get_pixmap(clip=clip).samples)

    def test_legacy_formula_geometry_is_enriched_without_mutating_cache(self):
        document = extract_pdf(self.source)
        for block in document["blocks"]:
            block.pop("regions", None)
        before = json.dumps(document)
        prose = next(b for b in document["blocks"] if "The energy" in b["text"])
        build_translated_pdf(self.source, document, {prose["id"]: "エネルギー"}, self.root / "legacy.pdf")
        self.assertEqual(json.dumps(document), before)

    def test_chunk_boundaries_never_cut_formula_tokens(self):
        text = "English " * 5 + "[[PD_MATH_p1b1_0]]" + " ending" * 10
        units = translation_units({"blocks": [{"id": "p1b1", "page": 1, "text": text}]}, limit=50)
        self.assertEqual("".join(u["text"] for u in units), text)
        self.assertEqual(sum(len(MATH_TOKEN.findall(u["text"])) for u in units), 1)
        self.assertTrue(all(len(u["text"]) <= 50 for u in units))

    def test_inline_closing_bracket_in_prose_font_stays_with_formula(self):
        text = "The time (k = [1: Nt]) is known."
        start, end = text.index("k"), text.index("]")
        chars = [{"c": c, "font": "Times-Roman", "flags": 0, "size": 11,
                  "math_font": start <= i < end and c in "kNt="}
                 for i, c in enumerate(text)]
        ranges = _math_ranges(chars)
        self.assertEqual([text[a:b] for a, b in ranges], ["k = [1: Nt]"])

    def test_false_superscript_flags_do_not_hide_english_after_product(self):
        text = "where ς(ξ) = Q ςi(ξi) is the joint probability density"
        start, end = text.index("ς"), text.index(" is")
        chars = [{"c": c, "font": "Times-Roman", "flags": 5, "size": 10,
                  "math_font": start <= i < end} for i, c in enumerate(text)]
        protected = "".join(text[a:b] for a, b in _math_ranges(chars))
        self.assertIn("ς", protected)
        self.assertNotIn("joint", protected)
        self.assertNotIn(" is", protected)

    def test_cached_integrand_with_differential_is_preserved(self):
        block = {"id": "p3b11", "page": 3, "kind": "text", "text": "integrand",
                 "translation_text": "0\n[[PD_MATH_p3b11_0]]dt [[PD_MATH_p3b11_1]] (1a)",
                 "formulas": [{"token": "[[PD_MATH_p3b11_0]]"}, {"token": "[[PD_MATH_p3b11_1]]"}]}
        self.assertTrue(formula_only_block(block))
        self.assertEqual(translation_units({"blocks": [block]}), [])
        self.assertFalse(formula_only_block(dict(block, translation_text="The integrand is [[PD_MATH_p3b11_0]]")))

    def test_prose_ligature_in_inferred_math_font_is_not_a_formula(self):
        text = "Mathematics Subject Classiﬁcation"
        chars = [{"c": c, "font": "Subset", "flags": 4, "size": 8,
                  "math_font": c == "ﬁ"} for c in text]
        self.assertEqual(_math_ranges(chars), [])

    def test_variables_in_italic_theorem_are_kept_as_whole_expressions(self):
        text = "For every convex function f ∈ C(K) and every x, y ∈ K"
        chars = [{"c": c, "font": "Italic", "flags": 6, "size": 10,
                  "math_font": c in "∈(),"} for c in text]
        self.assertEqual([text[a:b] for a, b in _math_ranges(chars)], ["f ∈ C(K)", "x, y ∈ K"])

    def test_author_year_citation_plus_is_not_math(self):
        text = "We use [VLK+19, PA18] and the interval [x+2]."
        chars = [{"c": c, "font": "Roman", "flags": 4, "size": 10,
                  "math_font": c == "+"} for c in text]
        protected = [text[a:b] for a, b in _math_ranges(chars)]
        self.assertFalse(any("19" in value or "VLK" in value for value in protected))
        self.assertTrue(any("x+2" in value for value in protected))

    def test_legacy_extraction_is_refreshed_and_markdown_has_no_tokens(self):
        library = Library(self.root / "library")
        identity, _ = library.import_pdf(self.source)
        path = library.folder(identity) / "document.json"
        old = json.loads(path.read_text("utf-8"))
        old.pop("layout_version")
        old["blocks"] = []
        path.write_text(json.dumps(old), "utf-8")
        refreshed = library.document(identity)
        self.assertEqual(refreshed["layout_version"], LAYOUT_VERSION)
        self.assertTrue(refreshed["blocks"])
        provider = FakeProvider()
        service = PaperService(library, provider, threading.Event())
        report = service.translate(identity)
        self.assertEqual(report["pages"], 1)
        calls = provider.calls
        service.translate(identity)
        self.assertEqual(provider.calls, calls)
        markdown = (path.parent / "translation.md").read_text("utf-8")
        self.assertNotIn("PD_MATH", markdown)
        self.assertIn("E(q)", markdown)

    def test_rotated_page_uses_unrotated_inline_crop(self):
        make_math_pdf(self.root / "rotated.pdf", rotation=90)
        image_bytes = []
        for name in ("math.pdf", "rotated.pdf"):
            source = self.root / name
            document = extract_pdf(source)
            translations = {b["id"]: "状態" + " ".join(f["token"] for f in b["formulas"])
                            for b in document["blocks"] if b["kind"] == "text"}
            destination = self.root / ("out-" + name)
            build_translated_pdf(source, document, translations, destination)
            with fitz.open(destination) as pdf:
                self.assertEqual(pdf[0].rotation, 90 if name == "rotated.pdf" else 0)
                image_bytes.append([pdf.extract_image(img[0])["image"] for img in pdf[0].get_images()])
        self.assertEqual(image_bytes[0], image_bytes[1])


if __name__ == "__main__":
    unittest.main()
