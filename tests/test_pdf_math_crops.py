import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pymupdf as fitz

from papeer.pdf.pdf_math_crops import (formula_crop, page_glyph_bounds, _type3_bounds, _rebuild_type3_rows,
                                     _attach_unmapped_math_images)


class MathCropTests(unittest.TestCase):
    def test_unmapped_inline_math_image_is_kept_but_unrelated_icon_is_not(self):
        script = dict(font='T7', flags=0, size=6, math_font=True,
                      chars=[dict(c='f', origin=(62, 102), bbox=(62, 96, 66, 103))])
        prose = dict(font='Times-Roman', flags=0, size=10, math_font=False,
                     chars=[dict(c='a', origin=(70, 100), bbox=(70, 92, 75, 102)),
                            dict(c='n', origin=(75, 100), bbox=(75, 92, 80, 102))])
        items = [dict(type=0, bbox=(62, 92, 80, 103), lines=[dict(bbox=(62, 92, 80, 103), spans=[script, prose])])]
        page = SimpleNamespace(rect=fitz.Rect(0, 0, 400, 400), get_image_info=lambda: [
            dict(bbox=(53, 93, 60, 100)), dict(bbox=(300, 150, 310, 160))])
        _attach_unmapped_math_images(page, items, {})
        virtual = [c for line in items[0]['lines'] for span in line['spans'] for c in span['chars'] if c.get('ink_bbox')]
        self.assertEqual(len(virtual), 1)
        self.assertEqual(virtual[0]['ink_bbox'], [53, 93, 60, 100])
        crop = formula_crop(dict(bbox=[53, 93, 60, 100], glyph_origins=[], extra_ink=[[53, 93, 60, 100]]), {})
        self.assertAlmostEqual(crop.y0, 92.7)
        self.assertAlmostEqual(crop.y1, 100.3)

    def test_type3_d1_boxes_follow_compact_encoding_and_font_matrix(self):
        keys = {(1, 'FontMatrix'): ('array', '[.01 0 0 .01 0 0]'),
                (1, 'Encoding/Differences'): ('array', '[0/A/B 8/C]'),
                (1, 'CharProcs'): ('xref', '2 0 R'),
                (2, 'A'): ('xref', '3 0 R'), (2, 'B'): ('xref', '4 0 R'), (2, 'C'): ('xref', '5 0 R')}
        doc = SimpleNamespace(xref_get_key=lambda ref, key: keys[(ref, key)],
                              xref_stream=lambda ref: b'15 0 2 -3 12 20 d1\nq\nQ')
        bounds = _type3_bounds(doc, 1)
        self.assertEqual(set(bounds), {0, 1, 8})
        self.assertAlmostEqual(bounds[0].x0, .02)
        self.assertAlmostEqual(bounds[0].y1, .20)

    def test_type3_row_rebuild_separates_mixed_baselines(self):
        with fitz.open() as pdf:
            page = pdf.new_page()
            page.insert_text((40, 100), 'The first row is ready.', fontsize=10)
            page.insert_text((40, 112), 'The second row stays intact.', fontsize=10)
            lines = [line for b in page.get_text('rawdict')['blocks'] for line in b['lines']]
        item = dict(lines=[dict(lines[0], spans=[s for line in lines for s in line['spans']])])
        _rebuild_type3_rows(item)
        text = [''.join(c['c'] for s in line['spans'] for c in s['chars']) for line in item['lines']]
        self.assertEqual(text, ['The first row is ready.', 'The second row stays intact.'])

    def test_cff_subset_fonts_use_glyph_outlines(self):
        page = SimpleNamespace(
            get_fonts=lambda: [(1, "cff", "Type1", "ABCDEF+CMSY10")],
            parent=SimpleNamespace(extract_font=lambda _: ("font", "cff", "Type1", b"test")),
            get_texttrace=lambda: [{"font": "CMSY10", "dir": (1, 0), "size": 10,
                                   "chars": [(123, 0, (40, 100), (40, 92, 45, 111))]}])
        with patch("papeer.pdf.pdf_math_crops._cff_outline_bounds", return_value=[(72, -250, 427, 750)]):
            bounds = page_glyph_bounds(page)
        self.assertEqual(bounds[(40, 100)], fitz.Rect(40.72, 92.5, 44.27, 102.5))

    def test_shifted_combining_negation_uses_outline_and_keeps_both_overlays(self):
        page = SimpleNamespace(
            get_fonts=lambda: [(1, "pfa", "Type1", "CMSY10")],
            parent=SimpleNamespace(extract_font=lambda _: ("font", "pfa", "Type1", b"test")),
            get_texttrace=lambda: [{"font": "CMSY10", "dir": (1, 0), "size": 10,
                                   "chars": [(824, 0, (45, 100), (45, 92, 45, 111)),
                                             (61, 1, (45, 100), (45, 92, 52, 111))]}],
            get_text=lambda *args, **kwargs: {"blocks": [{"lines": [{"spans": [{"chars": [
                {"c": "\u0338", "origin": (40, 100)}, {"c": "=", "origin": (45, 100)}]}]}]}]})
        with patch("papeer.pdf.pdf_math_crops._outline_bounds",
                   return_value=[(-500, -200, 100, 750), (0, 100, 700, 500)]):
            bounds = page_glyph_bounds(page)
        self.assertEqual(bounds[(40, 100)], fitz.Rect(40, 92.5, 46, 102))
        self.assertEqual(bounds[(45, 100)], fitz.Rect(40, 92.5, 52, 102))
        crop = formula_crop({"bbox": [40, 92, 52, 111], "glyph_origins": [[40, 100], [45, 100]]}, bounds)
        self.assertAlmostEqual(crop.y1, 102.3)

    def test_outline_crop_excludes_neighbor_line_but_keeps_descender(self):
        page = SimpleNamespace(
            get_fonts=lambda: [(1, "pfa", "Type1", "ABCDEF+CMSY10")],
            parent=SimpleNamespace(extract_font=lambda _: ("font", "pfa", "Type1", b"test")),
            get_texttrace=lambda: [{"font": "CMSY10", "dir": (1, 0), "size": 10,
                                   "chars": [(123, 0, (40, 100), (40, 92, 45, 111))]}])
        with patch("papeer.pdf.pdf_math_crops._outline_bounds", return_value=[(72, -250, 427, 750)]):
            bounds = page_glyph_bounds(page)
        formula = {"bbox": [40, 92, 45, 111], "glyph_origins": [[40, 100]]}
        crop = formula_crop(formula, bounds)
        self.assertAlmostEqual(crop.y0, 92.2)
        self.assertAlmostEqual(crop.y1, 102.8)
        self.assertLess(crop.y1, 104)  # next prose row begins at 104
        self.assertEqual(formula_crop(formula, {}), fitz.Rect(formula["bbox"]))

