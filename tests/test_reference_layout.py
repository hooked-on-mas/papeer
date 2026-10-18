import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from papeer.pdf.pdf_engine import extract_pdf, translation_units, build_translated_pdf
from papeer.layout.reference_layout import mark_references, reference_evidence


REF = '[1] A. Smith and B. Jones, Robust control. IEEE Transactions, vol. 4, pp. 10-20, 2020.'
PROSE = 'The proposed controller keeps the plant stable under bounded disturbances and delays. '


def entry(number):
    return (f'[{number}] A. Author{number} and B. Writer, Study {number} of control. '
            f'IEEE Trans., vol. {number}, pp. 1{number}-2{number}, 20{10 + number}.')


def block(identity, text, page=1, x=40, y=80, right=280):
    return dict(id=identity, text=text, page=page, bbox=[x, y, right, y+20], kind='text', font_size=10)


class ReferenceLayoutTests(unittest.TestCase):
    def test_wrapped_entry_tail_and_following_entry_keep_bibliographic_evidence(self):
        tail = 'Control, F. W. Vaandrager, Ed. Lecture Notes in Computer Science, 1999, pp. 31-45.'
        self.assertTrue(reference_evidence(tail + '\n' + REF))
        self.assertTrue(reference_evidence('pp. 1021–1026.\n' + REF))
        self.assertFalse(reference_evidence('This is ordinary prose.\n' + REF))

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

    def test_follows_document_block_order(self):
        # document["blocks"] is already in reading order; coordinates must not
        # re-sort it (the right column comes after the left one here).
        blocks = [block('h', 'References', y=300), block('r', REF, y=330),
                  block('next', REF, x=320, y=80, right=570),
                  block('bio', 'A. Smith is currently a professor. ' * 4, x=320, y=130, right=570)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h','r','next'])
        blocks = [block('r', REF, y=80), block('h', 'References', y=40)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h'])

    def test_two_column_pdf_continues_into_right_column(self):
        prose = 'The proposed controller keeps the plant stable under bounded disturbances and delays. '
        entry = '[{}] A. Smith and B. Jones, Robust control. IEEE Transactions, vol. 4, pp. 10-20, 2020.'
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'source.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page()
                page.insert_textbox(fitz.Rect(40, 60, 290, 500), prose * 8, fontsize=9)
                page.insert_text((40, 540), 'References', fontsize=11)
                page.insert_textbox(fitz.Rect(40, 560, 290, 640), entry.format(1), fontsize=9)
                page.insert_textbox(fitz.Rect(320, 60, 570, 140), entry.format(2), fontsize=9)
                page.insert_textbox(fitz.Rect(320, 160, 570, 240), entry.format(3), fontsize=9)
                pdf.save(source)
            doc = extract_pdf(source)
        kinds = [(b['text'].split()[0], b['kind']) for b in doc['blocks']]
        self.assertEqual(kinds, [('The', 'text'), ('References', 'reference'), ('[1]', 'reference'),
                                 ('[2]', 'reference'), ('[3]', 'reference')])

    @staticmethod
    def _extract(build):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'source.pdf'
            with fitz.open() as pdf:
                build(pdf)
                pdf.save(source)
            return extract_pdf(source)

    @staticmethod
    def _entry_kinds(doc):
        return [b['kind'] for b in doc['blocks'] if b['text'].startswith('[')]

    def test_small_acknowledgments_at_left_foot_precede_right_column_references(self):
        # order_page moves small type near the page foot to the end of the
        # page; it must not close a reference range opened in the next column.
        def build(pdf):
            page = pdf.new_page()
            page.insert_textbox(fitz.Rect(40, 60, 290, 600), PROSE * 9, fontsize=10)
            page.insert_textbox(fitz.Rect(40, 640, 290, 760), 'Acknowledgments This work was supported by '
                                'the Foundation under grant 12345 and by the University.', fontsize=8)
            page.insert_text((320, 80), 'References', fontsize=10)
            for i in range(8):
                page.insert_textbox(fitz.Rect(320, 95 + i*50, 570, 140 + i*50), entry(i+1), fontsize=8)
            second = pdf.new_page()
            for i in range(8, 11):
                second.insert_textbox(fitz.Rect(40, 60 + (i-8)*50, 290, 105 + (i-8)*50), entry(i+1), fontsize=8)
        doc = self._extract(build)
        ack = next(b for b in doc['blocks'] if b['text'].startswith('Acknowledgments'))
        self.assertTrue(ack.get('reading_margin'))
        self.assertEqual(ack['kind'], 'text')
        self.assertEqual(self._entry_kinds(doc), ['reference'] * 11)

    def test_small_heading_at_left_foot_opens_range_before_right_column(self):
        def build(pdf):
            page = pdf.new_page()
            page.insert_textbox(fitz.Rect(40, 60, 290, 600), PROSE * 9, fontsize=10)
            page.insert_text((40, 640), 'References', fontsize=8)
            for i in range(3):
                page.insert_textbox(fitz.Rect(40, 650 + i*50, 290, 695 + i*50), entry(i+1), fontsize=8)
            for i in range(3, 9):
                page.insert_textbox(fitz.Rect(320, 60 + (i-3)*50, 570, 105 + (i-3)*50), entry(i+1), fontsize=8)
        doc = self._extract(build)
        heading = next(b for b in doc['blocks'] if b['text'] == 'References')
        self.assertTrue(heading.get('reading_margin'))
        self.assertEqual(heading['kind'], 'reference')
        self.assertEqual(self._entry_kinds(doc), ['reference'] * 9)

    def test_small_footnote_with_year_before_heading_stays_text(self):
        def build(pdf):
            page = pdf.new_page()
            page.insert_textbox(fitz.Rect(40, 60, 290, 600), PROSE * 9, fontsize=10)
            page.insert_textbox(fitz.Rect(40, 700, 290, 760), '1 Code released on GitHub in 2021 by '
                                'A. Smith, B. Jones, C. Lee.', fontsize=7)
            page.insert_textbox(fitz.Rect(320, 60, 570, 300), PROSE * 4, fontsize=10)
            page.insert_text((320, 330), 'References', fontsize=11)
            for i in range(3):
                page.insert_textbox(fitz.Rect(320, 345 + i*50, 570, 390 + i*50), entry(i+1), fontsize=8)
        doc = self._extract(build)
        footnote = next(b for b in doc['blocks'] if 'GitHub' in b['text'])
        self.assertTrue(footnote.get('reading_margin'))
        self.assertEqual(footnote['kind'], 'text')
        self.assertEqual(self._entry_kinds(doc), ['reference'] * 3)

    def _short_right_column(self, fmt, left_count, right_count):
        # Left: body text, heading and entries; right: a short final column.
        # order_page finds no gutter here, so a coordinate fallback applies.
        def build(pdf):
            page = pdf.new_page()
            page.insert_textbox(fitz.Rect(40, 60, 290, 460), PROSE * 13, fontsize=10)
            page.insert_text((40, 480), 'References', fontsize=10)
            for i in range(left_count):
                page.insert_textbox(fitz.Rect(40, 492 + i*42, 290, 532 + i*42), fmt(i+1), fontsize=8)
            for i in range(right_count):
                page.insert_textbox(fitz.Rect(320, 60 + i*42, 570, 100 + i*42),
                                    fmt(left_count+i+1), fontsize=8)
        doc = self._extract(build)
        self.assertEqual(doc['pages'][0]['reading_order']['columns'], 1)
        return doc

    def test_initial_style_entries_in_short_right_column(self):
        names = ['Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Davies']

        def initial(i):
            # Over 80 characters but under 16 words: order_page does not count
            # it as prose, so no gutter is found.
            return (f'{"ABCDEF"[i-1]}. {names[i-1]}, B. {names[-i]}, Robust delay-dependent stabilization, '
                    f'Automatica, vol. {i}, 20{10+i}.')
        doc = self._short_right_column(initial, 3, 2)
        self.assertEqual([b['kind'] for b in doc['blocks'] if 'Automatica' in b['text']], ['reference'] * 5)

    def test_single_entry_in_right_column(self):
        doc = self._short_right_column(entry, 3, 1)
        self.assertEqual(self._entry_kinds(doc), ['reference'] * 4)

    def test_heading_variants_open_the_range(self):
        headings = ['References', 'REFERENCES', 'References:', '7 References', '7. References',
                    '7.References', 'VII. REFERENCES', 'VII.\nREFERENCES', '7\nReferences', 'Bibliography',
                    'BIBLIOGRAPHY', 'REFERENCES AND NOTES', 'References and Notes', 'Notes and References',
                    'Works Cited', 'Literature Cited', 'LITERATURE CITED', 'References Cited', 'Reference List',
                    'Selected References', 'Bibliography and References', 'References and Further Reading',
                    'XII. REFERENCES', 'IX References', '参考文献', '参 考 文 献', '6. 参考文献', '【参考文献】',
                    '引用文献', '文献', '文\u3000献', '参考文献一覧', '引用・参考文献']
        for heading in headings:
            blocks = [block('before', 'Some notes (2021).'), block('h', heading, y=110),
                      block('inside', 'Some notes (2021).', y=140)]
            mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
            self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'inside'], heading)
            self.assertEqual(blocks[1]['reference_evidence'], ['heading'], heading)

    def test_heading_in_same_block_as_first_entry(self):
        for heading in ('References', 'REFERENCES', 'VII. REFERENCES', 'VII.\nREFERENCES', 'Bibliography',
                        'REFERENCES AND NOTES', 'Works Cited', 'Literature Cited', '参考文献'):
            blocks = [block('h', heading + '\n' + REF), block('r', REF.replace('[1]', '[2]'), y=140)]
            mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
            self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'r'], heading)
            self.assertEqual(blocks[0]['reference_evidence'][0], 'heading')
            self.assertIn('bracketed-entry-number', blocks[0]['reference_evidence'])
        # An uncertain first entry keeps its block translatable, but the
        # heading still opens the range for the following entries.
        blocks = [block('h', 'References\nSome words without any cue'), block('r', REF, y=140)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['r'])
        # An entry may start in lower case (surname particles).
        first = 'van der Berg, A., Smith, B.: Robust control. Journal of Control 4(2), 10-20 (2020)'
        blocks = [block('h', 'References\n' + first), block('r', REF, y=140)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'r'])

    def test_body_mentions_of_references_do_not_open_the_range(self):
        for text in ('We list the references in Section 2.', 'references.', 'references',
                     'References are listed\nbelow for completeness.', 'References\nare listed in the appendix.',
                     'Further references\n[1] give details.', 'Civil References', 'i. references', 'Reference', 'C. References', 'L. References',
                     'XXX. References', '文献リスト',
                     'See the reference list of [4] for the bibliography used in 2020.'):
            blocks = [block('p', text), block('after', 'Some notes (2021).', y=140)]
            mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
            self.assertFalse([b['id'] for b in blocks if b['kind']=='reference'], text)

    def test_end_heading_merged_with_body_closes_the_range(self):
        blocks = [block('h', 'References'), block('r', REF, y=110),
                  block('a', 'Appendix A. Proofs\nThe bound holds by the argument of Smith (2020).', y=140),
                  block('after', 'Some notes (2021).', y=200)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'r'])

    def test_lower_case_end_words_inside_entries_keep_the_range(self):
        blocks = [block('h', 'References'), block('r1', 'supplementary material, 2020.', y=110),
                  block('r2', 'appendix B of the report (2019).', y=140), block('r3', REF, y=170)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'r1', 'r2', 'r3'])

    def test_refresh_clears_stale_marks(self):
        stale = block('old', 'Some notes (2021).')
        stale.update(kind='reference', reference_evidence=['publication-year'])
        blocks = [stale, block('h', 'References', y=110), block('r', REF, y=140)]
        mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
        self.assertEqual([b['id'] for b in blocks if b['kind']=='reference'], ['h', 'r'])
        self.assertNotIn('reference_evidence', stale)

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
