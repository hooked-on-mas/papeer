import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from papeer.pdf.pdf_engine import extract_pdf, translation_units, build_translated_pdf
from papeer.layout.algorithm_layout import separate_algorithms


class AlgorithmLayoutTests(unittest.TestCase):
    def test_unruled_indented_algorithm_translates_each_step_and_stops_at_remark(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page()
                for x, y, text in [(52, 80, 'Algorithm 4.1: Iterative controller'),
                                    (40, 100, '(Initialization) Choose the initial control sequence.'),
                                    (45, 120, '1) Observe the current state.'),
                                    (45, 140, '2) Solve the optimization problem.'),
                                    (45, 160, '3) Evaluate the following cases.'),
                                    (65, 180, '3.a) If the state is feasible, apply the input.'),
                                    (45, 200, '4) Apply the selected input and repeat.'),
                                    (40, 225, 'Remark 4.1: This paragraph is ordinary prose.')]:
                    page.insert_text((x, y), text, fontsize=10)
                pdf.save(source)
            document = extract_pdf(source)
        steps = [b for b in document['blocks'] if b.get('algorithm_step')]
        self.assertEqual(len(steps), 7)
        self.assertTrue(all(b['kind'] == 'text' for b in steps))
        self.assertTrue(any(u['text'].startswith('3.a)') for u in translation_units(document)))
        remark = next(b for b in document['blocks'] if b['text'].startswith('Remark'))
        self.assertNotIn('algorithm_step', remark)

    def test_relaxed_numbering_and_frames(self):
        for marker in ('1:', '0:', '4:', '1.', '1)', '1 :'):
            for rules in ((65, 85, 170), (65, 170), (85, 170)):
                with self.subTest(marker=marker, rules=rules), fitz.open() as pdf:
                    page = pdf.new_page()
                    for index, y in enumerate(rules):
                        # Publishers do not always align rule endpoints exactly.
                        page.draw_line((40 + index * 2, y), (380 - index * 2, y))
                    page.insert_text((40, 80), 'Algorithm11 [Lsave, Lelim] = CleanL(bounds)', fontsize=10)
                    # No Require/Ensure and no space after the line number.
                    page.insert_text((45, 100), marker + 'Initialize lists of patches', fontsize=10)
                    page.insert_text((45, 125), '2: Append patch to the list', fontsize=10)
                    page.insert_text((45, 150), '3: return the list', fontsize=10)
                    page.insert_text((40, 200), 'This paragraph explains the algorithm.', fontsize=10)
                    remaining, algorithms, regions = separate_algorithms(page, page.get_text('rawdict')['blocks'])
                    self.assertEqual(len(regions), 1)
                    self.assertEqual(len(algorithms), 4)
                    text = ''.join(c['c'] for b in remaining for line in b['lines']
                                   for span in line['spans'] for c in span['chars'])
                    self.assertEqual(text, 'This paragraph explains the algorithm.')

    def test_split_number_and_long_math_caption(self):
        with fitz.open() as pdf:
            page = pdf.new_page()
            for y in (65, 85, 170):
                page.draw_line((40, y), (300, y))
            page.insert_text((40, 80), 'Algorithm 11 ' + '[Lsave, Lelim] = CleanL(bounds) ' * 2, fontsize=10)
            page.insert_text((45, 100), '1:', fontsize=10)
            page.insert_text((80, 100), 'Initialize lists for patches', fontsize=10)
            page.insert_text((45, 150), '2: return the list', fontsize=10)
            _, algorithms, regions = separate_algorithms(page, page.get_text('rawdict')['blocks'])
            self.assertEqual(len(regions), 1)
            self.assertEqual(len(algorithms), 3)

    def test_unnumbered_control_flow(self):
        with fitz.open() as pdf:
            page = pdf.new_page()
            for y in (65, 170):
                page.draw_line((40, y), (380, y))
            page.insert_text((40, 80), 'Algorithm 2 Clean patches', fontsize=10)
            page.insert_text((45, 100), 'for each patch do', fontsize=10)
            page.insert_text((55, 125), 'Append patch to the list', fontsize=10)
            page.insert_text((45, 150), 'return the list', fontsize=10)
            _, algorithms, regions = separate_algorithms(page, page.get_text('rawdict')['blocks'])
            self.assertEqual(len(regions), 1)
            self.assertTrue(algorithms)

    def test_caption_font_bounds_can_cross_rules(self):
        # Font ascent/descent boxes extend beyond visible ink. Real publishers
        # place rules closer to captions than these boxes allow.
        for top, separator in ((65, 82), (70, 85), (70, 82)):
            with self.subTest(top=top, separator=separator), fitz.open() as pdf:
                page = pdf.new_page()
                for y in (top, separator, 170):
                    page.draw_line((40, y), (380, y))
                page.insert_text((40, 80), 'Algorithm 1 An iterative implementation of GAPM', fontsize=11)
                page.insert_text((40, 100), 'Require: A stopping threshold', fontsize=10)
                page.insert_text((40, 120), 'Ensure: An optimal partition', fontsize=10)
                page.insert_text((45, 140), '1: Solve the problem', fontsize=10)
                page.insert_text((45, 160), '2: return the optimal solution', fontsize=10)
                page.insert_text((40, 200), 'Algorithm 1 is discussed in this paragraph.', fontsize=10)
                remaining, algorithms, regions = separate_algorithms(page, page.get_text('rawdict')['blocks'])
                self.assertEqual([tuple(r) for r in regions], [(40, top, 380, 170)])
                self.assertEqual(len(algorithms), 5)
                text = ''.join(c['c'] for b in remaining for line in b['lines']
                               for span in line['spans'] for c in span['chars'])
                self.assertEqual(text, 'Algorithm 1 is discussed in this paragraph.')
                with tempfile.TemporaryDirectory() as directory:
                    source = Path(directory) / 'source.pdf'
                    output = Path(directory) / 'output.pdf'
                    pdf.save(source)
                    document = extract_pdf(source)
                    units = translation_units(document)
                    self.assertEqual([u['text'] for u in units], [text])
                    report = build_translated_pdf(source, document,
                        {u['block']: 'この段落で手順を説明します。' for u in units}, output)
                    self.assertEqual(report['preserved_algorithm_blocks'], 5)
                    with fitz.open(output) as translated:
                        clip = regions[0] + (-1, -3, 1, 1)
                        self.assertEqual(page.get_pixmap(clip=clip).samples,
                                         translated[0].get_pixmap(clip=clip).samples)

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
