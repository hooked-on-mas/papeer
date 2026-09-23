from pathlib import Path
import tempfile
import unittest
import pymupdf as fitz
from paperdesk.pdf.pdf_engine import extract_pdf, translation_units, build_translated_pdf


class FigureLayoutTests(unittest.TestCase):
    def test_plot_ticks_rotated_labels_and_legend_are_preserved(self):
        for rotation in (0, 90):
            with self.subTest(rotation=rotation), tempfile.TemporaryDirectory() as temporary:
                source, output = Path(temporary)/'source.pdf', Path(temporary)/'out.pdf'
                with fitz.open() as pdf:
                    page = pdf.new_page(width=400, height=400)
                    shape = page.new_shape()
                    shape.draw_rect(fitz.Rect(70, 80, 320, 180))
                    for x in range(70, 321, 25):
                        shape.draw_line((x, 80), (x, 84))
                        shape.draw_line((x, 176), (x, 180))
                    shape.finish(color=(0,0,0)); shape.commit()
                    page.insert_text((50, 175), 'Temperature', fontsize=9, rotate=90)
                    page.insert_text((170, 195), 'Time slot', fontsize=9)
                    page.insert_text((230, 100), 'Forecast', fontsize=9)
                    for x in range(70, 321, 25):
                        page.insert_text((x-2, 190), str(x//25), fontsize=7)
                    page.insert_text((45, 225), 'Fig. 1. Forecast and test temperature.', fontsize=10)
                    page.insert_text((45, 265), 'The proposed method improves accuracy.', fontsize=10)
                    page.set_rotation(rotation)
                    pdf.save(source)
                document = extract_pdf(source)
                figures = [b for b in document['blocks'] if b['kind']=='figure']
                self.assertEqual(len(figures), 1)
                units = translation_units(document)
                self.assertTrue(any('Fig. 1.' in u['text'] for u in units))
                self.assertFalse(any('Time slot' in u['text'] or 'Temperature' in u['text'] for u in units))
                translations = {u['block']:'予測結果を示す。' for u in units}
                translations[figures[0]['id']] = 'must not replace the plot'
                report = build_translated_pdf(source, document, translations, output)
                self.assertEqual(report['preserved_figure_blocks'], 1)
                with fitz.open(source) as before, fitz.open(output) as after:
                    before[0].set_rotation(0); after[0].set_rotation(0)
                    clip=fitz.Rect(figures[0]['bbox'])
                    self.assertEqual(before[0].get_pixmap(clip=clip).samples, after[0].get_pixmap(clip=clip).samples)
