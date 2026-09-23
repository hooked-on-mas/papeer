import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from paperdesk.pdf_engine import extract_pdf, translation_units, build_translated_pdf
from paperdesk.algorithm_layout import separate_algorithms


class AlgorithmLayoutTests(unittest.TestCase):
    def test_indented_caption_and_case_variants(self):
        for inset in (0, 7.5, 12):
            for label in ('input:', 'output:', 'Input:', 'OUTPUT :'):
                with self.subTest(inset=inset, label=label), fitz.open() as pdf:
                    page = pdf.new_page()
                    for y in (65, 85, 170):
                        page.draw_line((40, y), (380, y))
                    page.insert_text((40 + inset, 80), 'Algorithm 3: Main procedure', fontsize=10)
                    page.insert_text((55, 100), label + ' continuous random parameters', fontsize=10)
                    page.insert_text((55, 125), 'while size(DD) > 0 do', fontsize=10)
                    page.insert_text((65, 150), 'return P;', fontsize=10)
                    _, _, regions = separate_algorithms(page, page.get_text('rawdict')['blocks'])
                    self.assertEqual(len(regions), 1)
                    self.assertEqual(tuple(regions[0]), (40, 65, 380, 170))

    def test_ruled_table_is_not_an_algorithm(self):
        for caption, body in (
                ('Table 3: Comparison', 'input: continuous parameters'),
                ('Algorithm 3: Comparison', 'Method A  |  Method B'),
                ('Algorithm 3: Comparison', 'Measured output: runtime'),
        ):
            with self.subTest(caption=caption, body=body), fitz.open() as pdf:
                page = pdf.new_page()
                for y in (65, 85, 170):
                    page.draw_line((40, y), (380, y))
                page.insert_text((47.5, 80), caption, fontsize=10)
                page.insert_text((55, 100), body, fontsize=10)
                _, _, regions = separate_algorithms(page, page.get_text('rawdict')['blocks'])
                self.assertEqual(regions, [])

    def test_preserve_complete_algorithm_and_translate_surrounding_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "output.pdf"
            with fitz.open() as pdf:
                page = pdf.new_page(width=420, height=420)
                page.insert_text((40, 40), "This paragraph introduces the procedure.")
                for y in (65, 85, 170):
                    page.draw_line((40, y), (380, y))
                page.insert_text((40, 80), "Algorithm 1 An iterative method")
                page.insert_text((40, 100), "Require: A stopping threshold")
                page.insert_text((45, 120), "1: Set t = 0")
                page.insert_text((45, 140), "2:    if t < 10 then")
                page.insert_text((45, 160), "3:        return t")
                page.insert_text((40, 200), "This paragraph explains the result.")
                pdf.save(source)
            document = extract_pdf(source)
            algorithms = [b for b in document['blocks'] if b['kind'] == 'algorithm']
            self.assertEqual(len(algorithms), 5)
            self.assertIn('return t', algorithms[-1]['text'])
            units = translation_units(document)
            self.assertFalse(any(u['block'] == algorithms[0]['id'] for u in units))
            self.assertEqual(len(units), 2)
            report = build_translated_pdf(source, document,
                {u['block']: '手順と結果について説明します。' for u in units}, output)
            self.assertEqual(report['preserved_algorithm_blocks'], 5)
            with fitz.open(source) as original, fitz.open(output) as translated:
                box = fitz.Rect(algorithms[0]['bbox'])
                for a in algorithms[1:]:
                    box |= fitz.Rect(a['bbox'])
                clip = box + (-1, -1, 1, 1)
                self.assertEqual(original[0].get_pixmap(clip=clip).samples,
                                 translated[0].get_pixmap(clip=clip).samples)
                self.assertIn('手順', translated[0].get_text())

    def test_algorithm_mention_without_frame_is_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page()
                page.insert_text((40, 80), 'Algorithm 1 is discussed in the following paragraph.')
                pdf.save(source)
            document = extract_pdf(source)
            self.assertFalse(any(b['kind'] == 'algorithm' for b in document['blocks']))
            self.assertEqual(len(translation_units(document)), 1)
