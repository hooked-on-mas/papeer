from pathlib import Path
import tempfile
import unittest
import pymupdf as fitz
from papeer.pdf.pdf_engine import extract_pdf, translation_units, build_translated_pdf
from papeer.layout.figure_layout import diagram_regions, figure_caption, raster_figures


def _flowchart(page, top=60, labels=("Input", "Encoder", "Decoder", "Output")):
    """Four labelled boxes joined by arrows, as in a model overview figure."""
    for index, label in enumerate(labels):
        box = fitz.Rect(40 + index * 85, top, 105 + index * 85, top + 40)
        page.draw_rect(box, color=(0, 0, 0), width=.8)
        page.insert_text((box.x0 + 6, box.y0 + 24), label, fontsize=9)
        if index:
            page.draw_line((box.x0 - 20, top + 20), (box.x0, top + 20), color=(0, 0, 0))
            page.draw_polyline([(box.x0 - 4, top + 17), (box.x0, top + 20), (box.x0 - 4, top + 23)], color=(0, 0, 0))


class FigureLayoutTests(unittest.TestCase):
    def test_a_diagram_of_boxes_and_short_labels_keeps_the_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page(width=400, height=400)
                _flowchart(page)
                page.insert_text((40, 125), 'Fig. 2. Overview of the proposed model.', fontsize=9)
                page.insert_text((40, 160), 'The encoder compresses the input into a short code for the decoder.', fontsize=9)
                pdf.save(source)
            document = extract_pdf(source)
            figures = [b for b in document['blocks'] if b['kind'] == 'figure']
            self.assertEqual(len(figures), 1)
            self.assertIn('Encoder', figures[0]['text'])
            texts = [u['text'] for u in translation_units(document)]
            self.assertFalse(any('Encoder' in t or 'Output' in t for t in texts))
            self.assertTrue(any('Fig. 2.' in t for t in texts))
            self.assertTrue(any('compresses' in t for t in texts))

    def test_boxes_with_sentences_or_captions_are_not_diagrams(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            # A framed list with drawn bullets, of short items or of sentences.
            for left, item in ((20, 'Finding {}: faster'), (210, 'Finding {}: the method improves the accuracy.')):
                page.draw_rect(fitz.Rect(left, 40, left + 170, 140), color=(0, 0, 0))
                for index in range(6):
                    page.draw_circle((left + 12, 58 + index * 14), 2, color=(0, 0, 0), fill=(0, 0, 0))
                    page.insert_text((left + 20, 61 + index * 14), item.format(index), fontsize=6)
            # A diagram whose caption sits inside its frame.
            _flowchart(page, top=200)
            page.insert_text((40, 255), 'Figure 3', fontsize=9)
            page.draw_rect(fitz.Rect(30, 190, 370, 262), color=(0, 0, 0))
            # A diagram placed across the lines of a paragraph.
            _flowchart(page, top=300, labels=("A", "B", "C", "D"))
            page.insert_text((20, 322), 'This sentence runs straight through the boxes of the drawing here.', fontsize=9)
            self.assertEqual([], diagram_regions(page, []))

    def test_diagrams_leave_tables_and_plots_to_their_detectors(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=500, height=400)
            _flowchart(page)
            self.assertEqual(1, len(diagram_regions(page, [])))
            self.assertEqual([], diagram_regions(page, [fitz.Rect(100, 70, 120, 80)]))
            # A label sticking out of the drawing must not carry the region into a table.
            page.insert_text((300, 97), 'Output of the last stage', fontsize=9)
            self.assertEqual(1, len(diagram_regions(page, [])))
            self.assertEqual([], diagram_regions(page, [fitz.Rect(385, 90, 395, 96)]))

    def test_a_framed_list_with_icons_is_not_a_diagram(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            page.draw_rect(fitz.Rect(30, 40, 330, 150), color=(0, 0, 0))
            for index in range(5):
                top = 50 + index * 19
                # A 12pt icon (two paths) before each short item of five words.
                page.draw_rect(fitz.Rect(40, top, 52, top + 12), color=(0, 0, 0))
                page.draw_line((42, top + 6), (50, top + 6), color=(0, 0, 0))
                page.insert_text((60, top + 9), f'Fast inference on edge device {index}', fontsize=8)
            self.assertEqual([], diagram_regions(page, []))

    def test_a_column_rule_does_not_join_a_diagram_to_the_prose(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            _flowchart(page, labels=("A", "B", "C", "D"))
            # The rule between the columns starts just below the diagram.
            page.draw_line((200, 104), (200, 380), color=(0, 0, 0), width=.5)
            for index in range(10):
                page.insert_text((20, 150 + index * 12), 'Left column text runs on here.', fontsize=8)
                page.insert_text((210, 150 + index * 12), 'Right column text runs on here.', fontsize=8)
            self.assertEqual([fitz.Rect(40, 60, 360, 100)], diagram_regions(page, []))

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

    def test_raster_figures_merge_panels_and_find_their_caption(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 40), False)
            pixmap.clear_with(128)
            for rect in (fitz.Rect(50, 50, 150, 130), fitz.Rect(152, 50, 252, 130), fitz.Rect(10, 10, 30, 26)):
                page.insert_image(rect, pixmap=pixmap)
            page.insert_text((50, 145), 'Fig. 2. Panels (a) and (b).', fontsize=9)
            page.insert_text((50, 160), 'Figure 2 shows the panels in detail.', fontsize=9)
            regions = raster_figures(page, [])
            self.assertEqual([fitz.Rect(50, 50, 252, 130)], regions)
            self.assertEqual('Fig. 2. Panels (a) and (b).',
                             figure_caption(page, regions[0]))
            self.assertEqual([], raster_figures(page, [fitz.Rect(100, 60, 120, 70)]))
