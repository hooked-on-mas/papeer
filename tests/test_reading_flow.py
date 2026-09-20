import copy
from collections import Counter
from pathlib import Path
import tempfile
import unittest
import pymupdf as fitz

from paperdesk.reading_flow import (order_page, continuation_groups, translation_blocks,
    split_flow_text, materialize_flows, unit_pages, expand_pages)
from paperdesk.pdf_engine import translation_units, build_translated_pdf
from paperdesk.math_layout import MATH_TOKEN
from paperdesk.translation_context import contextual_units


def block(identity, page, box, text, size=10, kind='text'):
    return dict(id=identity, page=page, bbox=box, text=text, translation_text=text,
                font_size=size, kind=kind, formulas=[])


class ReadingFlowTests(unittest.TestCase):
    def test_three_columns_abstain_from_continuation_joining(self):
        items=[block(str(i),1,[40+180*i,100,190+180*i,700],
                     'A long paragraph with further details ' * 20) for i in range(3)]
        ordered, info=order_page(items,600,800)
        self.assertFalse(info['supported'])
        self.assertEqual(info['columns'],3)
        self.assertTrue(all(b['reading_ambiguous'] for b in ordered))
        self.assertFalse(continuation_groups(dict(blocks=ordered))[0])

    def test_columns_are_not_interleaved_and_full_width_heading_stays_first(self):
        heading = block('h', 1, [40, 30, 560, 60], 'A full width document heading', 20)
        left = block('left', 1, [40, 100, 290, 680], 'The paragraph describes a generic method ' * 20)
        right = block('right', 1, [310, 90, 560, 680], 'used for a new problem. ' * 25)
        footer = block('footer', 1, [40, 745, 560, 765], 'Journal information and copyright', 10)
        note = block('note', 1, [40, 690, 290, 730], 'Author affiliation and email address', 8)
        ordered, info = order_page([right, footer, heading, note, left], 600, 800)
        self.assertEqual(info['columns'], 2)
        self.assertEqual([b['id'] for b in ordered if not b.get('reading_margin')], ['h','left','right'])
        self.assertFalse(any('flow_lane' in b for b in [right, footer, heading, note, left]))
        groups, _ = continuation_groups(dict(blocks=ordered))
        self.assertEqual(groups[0]['blocks'], ['left','right'])

    def test_single_column_and_page_number_differ_from_equation_digits(self):
        items = [block('a',1,[50,60,550,700],'A paragraph of prose ' * 20),
                 block('n',1,[295,740,305,752],'12'),
                 block('equation',1,[470,80,480,100],'2',kind='formula')]
        ordered, info = order_page(items,600,800)
        self.assertEqual(info['columns'],1)
        lookup = {b['id']:b for b in ordered}
        self.assertTrue(lookup['n']['reading_margin'])
        self.assertFalse(lookup['equation'].get('reading_margin'))

    def test_complete_sentence_heading_caption_and_equation_are_barriers(self):
        a = block('a',1,[40,600,550,700],'The method yields the following result')
        b = block('b',2,[40,60,550,160],'under the assumptions described in this section.')
        groups, _ = continuation_groups(dict(blocks=[a,b]))
        self.assertEqual(groups[0]['pages'],[1,2])
        for other in [dict(b,text='2. A New Topic'), dict(b,kind='formula'),
                      dict(b,text='Figure 1. A plot of the results'),
                      dict(b,text='This starts a new paragraph about methods.')]:
            self.assertFalse(continuation_groups(dict(blocks=[a,other]))[0])
        self.assertFalse(continuation_groups(dict(blocks=[dict(a,text=a['text']+'.'),b]))[0])

    def test_group_context_scope_and_exact_formula_preservation(self):
        a = block('p1b1',1,[40,600,550,700],'This generic method applies to a reacha-')
        b = block('p2b1',2,[40,60,550,160],'bility problem with a prescribed state constraint.')
        token='[[PD_MATH_p2b1_0]]'
        b['translation_text'] += ' '+token
        b['formulas']=[dict(token=token,text='x',bbox=[40,60,50,70],baseline=69)]
        doc=dict(blocks=[a,b],continuations=[dict(blocks=['p1b1','p2b1'],pages=[1,2])])
        previous=copy.deepcopy(doc)
        units=translation_units(doc)
        self.assertEqual(len(units),1)
        self.assertIn('reachability',units[0]['text'])
        self.assertEqual(unit_pages(units[0]),{1,2})
        self.assertEqual(expand_pages(units,{2}),{1,2})
        self.assertEqual(contextual_units(doc,units)[0]['context']['formulas'][0]['source'],'x')
        text='状態の条件を満たす。一般的な到達可能性の問題'+token+'に適用する。'
        rendered, translated=materialize_flows(doc,{'p1b1':text})
        self.assertFalse(rendered['blocks'][0].get('paragraph_continuation', False))
        self.assertTrue(rendered['blocks'][1]['paragraph_continuation'])
        self.assertEqual(''.join(translated[b['id']] for b in rendered['blocks']),text)
        self.assertEqual(Counter(MATH_TOKEN.findall(''.join(translated.values()))),Counter([token]))
        self.assertEqual(doc,previous)
        with self.assertRaises(ValueError): materialize_flows(doc,{'p1b1':'数式なし'})

    def test_dependency_closure_and_atomic_marker_at_short_boundary(self):
        units=[dict(page=1,flow_pages=[1,2]),dict(page=2,flow_pages=[2,3]),dict(page=4)]
        self.assertEqual(expand_pages(units,{2}),{1,2,3})
        members=[block('a',1,[0,0,100,10],'a'),block('b',2,[0,0,100,10],'b')]
        token='[[PD_MATH_b_0]]'
        text='条件'+token+'が成立する'
        parts=split_flow_text(text,members,[dict(token=token,bbox=[0,0,15,10])])
        self.assertEqual(''.join(parts),text)
        self.assertEqual(sum(token in part for part in parts),1)

    def test_formula_moved_across_page_uses_its_original_page(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source.pdf'
            with fitz.open() as pdf:
                pdf.new_page(width=300,height=300).insert_text((40,80),'FIRST')
                pdf.new_page(width=300,height=300).insert_text((40,80),'SECOND')
                pdf.save(source)
            a=block('p1b1',1,[30,50,270,200],'This text continues on the next')
            b=block('p2b1',2,[30,50,270,100],'page in the source document.')
            token='[[PD_MATH_p2b1_0]]'
            b['formulas']=[dict(token=token,text='SECOND',bbox=[39,67,90,83],baseline=80)]
            doc=dict(title='Synthetic',page_count=2,blocks=[a,b],
                     pages=[dict(number=i,width=300,height=300) for i in (1,2)],
                     continuations=[dict(blocks=['p1b1','p2b1'],pages=[1,2])])
            # A short unbroken unit remains whole in the larger first region.
            report=build_translated_pdf(source,doc,{'p1b1':'条件'+token+'が成立する'},root/'out.pdf')
            self.assertEqual(report['inline_formulas'],1)
            with fitz.open(root/'out.pdf') as output,fitz.open(source) as original:
                images=output[0].get_images()
                self.assertTrue(images)
                raw=output.extract_image(images[0][0])['image']
                # Crop cannot be the same-position FIRST glyphs from page 1.
                from paperdesk.pdf_math_crops import formula_crop,page_glyph_bounds
                crop=formula_crop(b['formulas'][0],page_glyph_bounds(original[1])) & original[1].rect
                expected=original[1].get_pixmap(matrix=fitz.Matrix(4,4),clip=crop,alpha=False)
                self.assertEqual(fitz.Pixmap(raw).samples,expected.samples)
