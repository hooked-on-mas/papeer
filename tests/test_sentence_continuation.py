import copy
import unittest
from collections import Counter
from paperdesk.math_layout import MATH_TOKEN, merge_continued_prose
from paperdesk.pdf_engine import translation_units


def block(identity, text, bbox, kind='text', formulas=None):
    return dict(id=identity,page=2,kind=kind,text=text,translation_text=text,
                bbox=bbox,regions=[bbox],font_size=10,formulas=formulas or [])


class SentenceContinuationTests(unittest.TestCase):
    def fragments(self):
        return [block('p2b22', 'Let T be a Markov operator satisfying T(h) = h, for each affine continuous function h on', [40,425,422,470]),
                block('p2b23', '[[PD_MATH_p2b23_0]]. Moreover, let the measure', [40.5,470.2,135,483],
                      formulas=[dict(token='[[PD_MATH_p2b23_0]]',text='K')]),
                block('p2b24', 'be the continuous selection of probability Borel measures on K.', [40,471.2,422,493])]

    def test_sentence_and_inline_continuation_are_one_translation_unit(self):
        fragments=self.fragments(); snapshot=copy.deepcopy(fragments)
        merged=merge_continued_prose(fragments)
        self.assertEqual(len(merged),1)
        units=translation_units(dict(blocks=merged))
        self.assertEqual(len(units),1)
        self.assertIn('on\n[[PD_MATH_p2b23_0]]. Moreover',units[0]['text'])
        self.assertIn('Borel measures',units[0]['text'])
        self.assertEqual(merged[0]['bbox'],[40,425,422,493])
        self.assertEqual(Counter(MATH_TOKEN.findall(units[0]['text'])),Counter(['[[PD_MATH_p2b23_0]]']))
        self.assertEqual(fragments,snapshot)

    def test_does_not_join_across_equations_columns_pages_or_paragraph_gaps(self):
        first,second,_=self.fragments()
        for other in [dict(second,bbox=[310,470.2,422,483]), dict(second,page=3),
                      dict(second,bbox=[40,490,422,503])]:
            with self.subTest(other=other):
                self.assertEqual(len(merge_continued_prose([first,other])),2)
        equation=block('eq','x = y',[40,470,422,471],kind='formula')
        self.assertEqual(len(merge_continued_prose([first,equation,second])),3)
        finished=dict(first,text=first['text']+' K.')
        self.assertEqual(len(merge_continued_prose([finished,second])),2)
