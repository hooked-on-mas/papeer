from pathlib import Path
from copy import deepcopy
import tempfile
import unittest
from unittest.mock import patch
import pymupdf as fitz
from papeer.pdf.pdf_engine import extract_pdf, translation_units, build_translated_pdf
from papeer.layout.figure_layout import diagram_regions, figure_caption, figure_regions, raster_figures


def _flowchart(page, top=60, labels=("Input", "Encoder", "Decoder", "Output")):
    """Four labelled boxes joined by arrows, as in a model overview figure."""
    for index, label in enumerate(labels):
        box = fitz.Rect(40 + index * 85, top, 105 + index * 85, top + 40)
        page.draw_rect(box, color=(0, 0, 0), width=.8)
        page.insert_text((box.x0 + 6, box.y0 + 24), label, fontsize=9)
        if index:
            page.draw_line((box.x0 - 20, top + 20), (box.x0, top + 20), color=(0, 0, 0))
            page.draw_polyline([(box.x0 - 4, top + 17), (box.x0, top + 20), (box.x0 - 4, top + 23)], color=(0, 0, 0))


def _split_tick_plot(page, scale=1, labels=True, open_axes=False):
    """A plotting backend can emit its frame and every tick as separate paths."""
    frame = fitz.Rect(80 * scale, 100 * scale, 300 * scale, 210 * scale)
    if open_axes:
        page.draw_line(frame.tl, frame.bl)
        page.draw_line(frame.bl, frame.br)
    else:
        page.draw_rect(frame)
    for step in range(6):
        x = frame.x0 + frame.width * step / 5
        for y, direction in (((frame.y1, -1),) if open_axes else ((frame.y0, 1), (frame.y1, -1))):
            page.draw_line((x, y), (x, y + direction * 3 * scale))
    for step in range(5):
        y = frame.y0 + frame.height * step / 4
        for x, direction in (((frame.x0, 1),) if open_axes else ((frame.x0, 1), (frame.x1, -1))):
            page.draw_line((x, y), (x + direction * 3 * scale, y))
    if labels:
        page.insert_text((80 * scale, 99 * scale), 'x 10', fontsize=7 * scale)
        page.insert_text((94 * scale, 94 * scale), '-3', fontsize=5 * scale)
        page.insert_text((170 * scale, 225 * scale), 'Time', fontsize=8 * scale)
    return frame


class FigureLayoutTests(unittest.TestCase):
    def test_open_axes_are_recognized_across_separate_tick_and_edge_paths(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            frame = _split_tick_plot(page, open_axes=True)
            regions = figure_regions(page)
            self.assertEqual(len(regions), 1)
            self.assertTrue(frame in regions[0])
            self.assertTrue(fitz.Point(90, 95) in regions[0])

    def test_separate_tick_paths_keep_axis_labels_at_different_scales_and_rotations(self):
        for scale in (.7, 1, 1.5):
            for rotation in (0, 90):
                with self.subTest(scale=scale, rotation=rotation), tempfile.TemporaryDirectory() as temporary:
                    source = Path(temporary) / 'source.pdf'
                    with fitz.open() as pdf:
                        page = pdf.new_page(width=400 * scale, height=400 * scale)
                        _split_tick_plot(page, scale)
                        page.insert_text((45 * scale, 260 * scale), 'Fig. 1. The measured response.', fontsize=9 * scale)
                        page.insert_text((45 * scale, 300 * scale), 'The method approximates the stochastic response.', fontsize=9 * scale)
                        labels = [fitz.Rect(line['bbox']) for block in page.get_text('dict')['blocks']
                                  for line in block.get('lines', [])
                                  if ''.join(s['text'] for s in line['spans']).strip() in {'x 10', '-3', 'Time'}]
                        self.assertEqual(len(labels), 3)
                        page.set_rotation(rotation)
                        pdf.save(source)
                    document = extract_pdf(source)
                    figures = [b for b in document['blocks'] if b['kind'] == 'figure']
                    self.assertEqual(len(figures), 1)
                    self.assertTrue(all(box in fitz.Rect(figures[0]['bbox']) for box in labels))
                    texts = [u['text'] for u in translation_units(document)]
                    self.assertFalse(any('x 10' in t or 'Time' in t for t in texts))
                    self.assertTrue(any('Fig. 1.' in t for t in texts))
                    self.assertTrue(any('approximates' in t for t in texts))

    def test_plot_frame_does_not_absorb_nearby_prose_or_caption(self):
        for text in ('This paragraph explains the calculation in detail.', 'The estimate is stable.'):
            with self.subTest(text=text), fitz.open() as pdf:
                page = pdf.new_page(width=400, height=400)
                frame = _split_tick_plot(page, labels=False)
                # Both lines fit the label search margin but are ordinary prose / a caption.
                page.insert_text((85, 95), text, fontsize=6)
                page.insert_text((80, 225), 'Fig. 1. Response of the controlled system.', fontsize=8)
                self.assertEqual(figure_regions(page), [frame])

    def test_plain_frames_and_interior_short_segments_do_not_establish_axes(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            page.draw_rect(fitz.Rect(80, 100, 300, 210))
            for index in range(12):
                page.draw_line((110 + index * 12, 130), (113 + index * 12, 130))
            self.assertEqual(figure_regions(page), [])

    def test_old_cached_axis_label_is_repaired_without_changing_saved_blocks(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / 'source.pdf', Path(temporary) / 'out.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page(width=400, height=400)
                _split_tick_plot(page)
                page.insert_text((45, 260), 'Fig. 1. The measured response.', fontsize=9)
                page.insert_text((45, 300), 'The method approximates the stochastic response.', fontsize=9)
                label = next(line for block in page.get_text('dict')['blocks'] for line in block.get('lines', [])
                             if ''.join(s['text'] for s in line['spans']).strip() == 'x 10')
                pdf.save(source)
            document = extract_pdf(source)
            figure = next(b for b in document['blocks'] if b['kind'] == 'figure')
            clip = fitz.Rect(figure['bbox'])
            # Reproduce an old cache whose top tick grew a truncated plot region,
            # leaving only 3.5pt of space for a separately classified multiplier.
            figure['bbox'][1] = label['bbox'][1] + 3.5
            figure['regions'] = [list(figure['bbox'])]
            document['blocks'].append(dict(id='old-label', page=1, kind='text', text='x 10',
                                          translation_text='x 10', bbox=list(label['bbox']),
                                          regions=[list(label['bbox'])], font_size=7, formulas=[]))
            translations = {u['block']: '確率的な応答の近似結果を示す。' for u in translation_units(document)}
            translations['old-label'] = '倍率'
            before = deepcopy(document)
            with patch('papeer.pdf.pdf_engine.restore_plot_labels', side_effect=lambda page, blocks: (blocks, [])):
                with self.assertRaisesRegex(ValueError, '本文と数式・表の領域を分離'):
                    build_translated_pdf(source, document, translations, output)
            report = build_translated_pdf(source, document, translations, output)
            self.assertEqual(document, before)
            self.assertIn('old-label', report['preserved_label_blocks'])
            self.assertEqual(report['preserved_figure_blocks'], 1)
            with fitz.open(source) as original, fitz.open(output) as translated:
                self.assertEqual(original[0].get_pixmap(clip=clip).samples, translated[0].get_pixmap(clip=clip).samples)
                self.assertNotIn('倍率', translated[0].get_text())
                self.assertIn('確率的な応答', translated[0].get_text())

    def test_captioned_trajectory_plot_with_four_row_legend_is_preserved(self):
        with fitz.open() as pdf:
            page = pdf.new_page(width=400, height=400)
            for offset in range(8):
                page.draw_line((60 + offset, 70), (130 + offset, 150))
                page.draw_line((130 + offset, 150), (240 + offset, 80))
            for index, label in enumerate(("Mean", "Variance", "Bounds", "True state")):
                page.insert_text((220, 110 + index * 10), label, fontsize=8)
            page.insert_text((40, 170), 'Fig. 4: Constrained state trajectories.', fontsize=9)
            regions = diagram_regions(page, [])
            self.assertEqual(len(regions), 1)
            self.assertTrue(regions[0].contains(fitz.Point(240, 138)))

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
