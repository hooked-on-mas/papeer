import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from papeer.pdf.pdf_engine import extract_pdf, translation_units, build_translated_pdf
from papeer.layout.reference_layout import mark_references, reference_evidence


REF = '[1] A. Smith and B. Jones, Robust control. IEEE Transactions, vol. 4, pp. 10-20, 2020.'


def block(identity, text, page=1, x=40, y=80, right=280):
    return dict(id=identity, text=text, page=page, bbox=[x, y, right, y+20], kind='text', font_size=10)


class ReferenceLayoutTests(unittest.TestCase):
    def test_relaxed_or_cues(self):
        cases = {
            'Collected research notes (2021).': 'publication-year',
            '[2] Collected research notes.': 'bracketed-entry-number',
            'Someone, "Collected research notes".': 'quoted-title',
            'Someone, “Collected research notes”.': 'quoted-title',
            '1. Alpha\nwrapped title\n2. Beta\n3. Gamma': 'sequential-entry-numbers',
            '1 Alpha\n2 Beta\n3 Gamma\n4 Delta\n5 Epsilon': 'sequential-entry-numbers',
            '1) Alpha\n2) Beta\n3) Gamma': 'sequential-entry-numbers',
        }
        for text, cue in cases.items():
            self.assertIn(cue, reference_evidence(text), text)
        for text in ('1 Alpha\n3 Beta\n2 Gamma', 'Numbers 12, 34, 56.',
                     'Some words. More words. Other words.', '1. Alpha\n1. Beta\n1. Gamma'):
            self.assertFalse(reference_evidence(text), text)

    def test_loose_cues_require_reference_heading(self):
        blocks = [block('before', 'Some notes (2021).'), block('h', 'References', y=110),
                  block('inside', 'Some notes (2021).', y=140), block('a', 'Appendix', y=170),
                  block('after', '[2] Some notes.', y=200)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'inside'])

    def test_compound_patterns_and_prose(self):
        for text in (REF, 'Smith, A., Jones, B.: Robust control. Journal of Control 4(2), 10-20 (2020)',
                     REF + '\n' + REF.replace('[1]', '[2]')):
            self.assertTrue(reference_evidence(text), text)
        for text in ('[1] We show that x = 2020. This result holds in [2].',
                     '1. Set x = 2020. 2. Run 30 iterations.',
                     'Smith received the B.Sc. degree in 2020. His research interests include IEEE systems.',
                     REF + '\n[2] This section proves our result.',
                     'This is ordinary prose.\n' + REF):
            self.assertFalse(reference_evidence(text), text)

    def test_multipage_appendix_and_uncertain_blocks(self):
        blocks = [block('h', 'References'), block('r1', REF, y=110),
                  block('r2', REF, page=2), block('p', 'This result follows from [1], pp. 10-20 (2020).', page=2, y=120),
                  block('a', 'Appendix A', page=3), block('r3', REF, page=3, y=120)]
        doc = dict(blocks=blocks, pages=[dict(number=n, width=600) for n in (1,2,3)])
        mark_references(doc)
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h','r1','r2'])
        self.assertEqual({u['block'] for u in translation_units(doc)}, {'p','a','r3'})

    def test_two_columns_read_left_before_right(self):
        blocks = [block('h', 'References', y=300), block('r', REF, y=330),
                  block('next', REF, x=320, y=80, right=570),
                  block('bio', 'A. Smith is currently a professor. ' * 4, x=320, y=130, right=570)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1,width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h','r','next'])

    def test_pdf_preserves_references_even_with_stale_translation(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp)/'source.pdf', Path(tmp)/'output.pdf'
            with fitz.open() as pdf:
                for n in range(3):
                    page = pdf.new_page()
                    if n == 0:
                        page.insert_text((40,50), 'Ordinary prose to translate.')
                        page.insert_text((40,100), 'References')
                    if n < 2:
                        page.insert_text((40,140), REF, fontsize=9)
                    else:
                        page.insert_text((40,50), 'Appendix A')
                        page.insert_text((40,100), 'We prove the result in [1].')
                pdf.save(source)
            doc = extract_pdf(source)
            refs = [b for b in doc['blocks'] if b['kind']=='reference']
            self.assertEqual(len(refs), 3)
            translations = {b['id']: '翻訳した本文です。' for b in doc['blocks']}
            report = build_translated_pdf(source, doc, translations, output)
            self.assertEqual(len(report['preserved_reference_blocks']), 3)
            with fitz.open(source) as before, fitz.open(output) as after:
                for b in refs:
                    clip = fitz.Rect(b['bbox'])
                    self.assertEqual(before[b['page']-1].get_pixmap(clip=clip).samples,
                                     after[b['page']-1].get_pixmap(clip=clip).samples)
                self.assertIn('翻訳した本文', after[2].get_text())


if __name__ == '__main__':
    unittest.main()
