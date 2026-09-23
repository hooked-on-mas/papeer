import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pymupdf as fitz

from paperdesk.pdf.pdf_math_crops import formula_crop, page_glyph_bounds


class MathCropTests(unittest.TestCase):
    def test_outline_crop_excludes_neighbor_line_but_keeps_descender(self):
        page = SimpleNamespace(
            get_fonts=lambda: [(1, "pfa", "Type1", "ABCDEF+CMSY10")],
            parent=SimpleNamespace(extract_font=lambda _: ("font", "pfa", "Type1", b"test")),
            get_texttrace=lambda: [{"font": "CMSY10", "dir": (1, 0), "size": 10,
                                   "chars": [(123, 0, (40, 100), (40, 92, 45, 111))]}])
        with patch("paperdesk.pdf.pdf_math_crops._outline_bounds", return_value=[(72, -250, 427, 750)]):
            bounds = page_glyph_bounds(page)
        formula = {"bbox": [40, 92, 45, 111], "glyph_origins": [[40, 100]]}
        crop = formula_crop(formula, bounds)
        self.assertAlmostEqual(crop.y0, 92.2)
        self.assertAlmostEqual(crop.y1, 102.8)
        self.assertLess(crop.y1, 104)  # next prose row begins at 104
        self.assertEqual(formula_crop(formula, {}), fitz.Rect(formula["bbox"]))

