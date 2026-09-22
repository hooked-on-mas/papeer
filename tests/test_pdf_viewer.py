from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import pymupdf as fitz
from PySide6.QtGui import QImage

from paperdesk.pdf_typography import FONT_CSS, font_archive
from paperdesk.pdf_viewer import extract_selected_text, page_image, page_png, page_text_info


class PdfViewerTests(unittest.TestCase):
    def test_japanese_survives_both_fresh_viewer_processes(self):
        # Opening in the authoring process can conceal the broken font decoding
        # through native font caches. Always test a genuinely fresh viewer.
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source, rendered = folder / "日本語.pdf", folder / "rendered.png"
            text = "日本語の数式表示を確認 制御器の設計"
            with fitz.open() as pdf:
                page = pdf.new_page(width=360, height=180)
                page.insert_htmlbox(fitz.Rect(10, 10, 350, 170),
                    '<p style="font-family:PaperDeskSerif;font-size:22pt">日本語の数式表示を確認</p>'
                    '<p style="font-family:PaperDeskHeading;font-weight:bold;font-size:24pt">制御器の設計</p>',
                    css=FONT_CSS, archive=font_archive(text))
                boxes = [fitz.Rect(char['bbox']) for block in page.get_text('rawdict')['blocks']
                         if block['type'] == 0 for line in block['lines'] for span in line['spans']
                         for char in span['chars'] if '\u3400' <= char['c'] <= '\u9fff']
                self.assertGreater(len(boxes), 10)
                pdf.save(source)
            renderers = {
                "pdfium": 'import sys; from pathlib import Path; from paperdesk.pdf_viewer import page_png; '
                          'Path(sys.argv[2]).write_bytes(page_png(Path(sys.argv[1]),0,1080))',
                "mupdf": 'import sys,pymupdf as f; d=f.open(sys.argv[1]); '
                         'd[0].get_pixmap(matrix=f.Matrix(3,3)).save(sys.argv[2])',
            }
            for engine, code in renderers.items():
                subprocess.run([sys.executable, '-X', 'utf8', '-c', code, str(source), str(rendered)],
                               check=True, capture_output=True, timeout=30)
                image = QImage(str(rendered))
                self.assertEqual(image.width(), 1080)
                for box in boxes:
                    with self.subTest(engine=engine, box=box):
                        glyph = image.copy(int(box.x0 * 3), int(box.y0 * 3), int(box.width * 3), int(box.height * 3))
                        gray = glyph.convertToFormat(QImage.Format.Format_Grayscale8)
                        pixels = bytes(gray.constBits())
                        self.assertGreater(sum(v < 160 for v in pixels), gray.width() * gray.height() * .025)

    def test_rotation_color_and_buffer_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rotation.pdf"
            with fitz.open() as pdf:
                page = pdf.new_page(width=100, height=200)
                page.draw_rect(page.rect, color=None, fill=(1, 0, 0))
                page.set_rotation(90)
                pdf.save(path)
            image = page_image(path, 0, 600)
            self.assertEqual((image.width(), image.height()), (600, 300))
            # All native handles are closed; returned image still owns its data.
            path.unlink()
            self.assertEqual(image.pixelColor(200, 100).name(), '#ff0000')

    def test_invalid_page_and_zoom_beyond_old_render_limit(self):
        source = Path(__file__).parent / "fixtures/sample.pdf"
        self.assertIsNone(page_image(source, -1))
        self.assertIsNone(page_image(source, 999))
        self.assertEqual(page_image(source, 0, 2200).width(), 2200)
        self.assertTrue(page_png(source, 0, 300).startswith(b'\x89PNG'))
        for width in [0, -1, float('nan'), float('inf')]:
            with self.subTest(width=width), self.assertRaises(ValueError):
                page_image(source, 0, width)

    def test_page_text_info_and_selection(self):
        source = Path(__file__).parent / "fixtures/sample.pdf"
        info = page_text_info(source, 0)
        self.assertGreater(info["pdf_size"][0], 0)
        self.assertGreater(info["pdf_size"][1], 0)
        self.assertTrue(len(info["words"]) > 0)
        first_word = info["words"][0]
        # (x0, y0, x1, y1, text, block, line, word)
        self.assertEqual(len(first_word), 8)
        self.assertTrue(isinstance(first_word[4], str))

        # Test extraction with bounding box around first word
        clip_rect = (first_word[0] - 1, first_word[1] - 1, first_word[2] + 1, first_word[3] + 1)
        text = extract_selected_text(source, 0, clip_rect)
        self.assertIn(first_word[4], text)

        # Invalid page and nonexistent path
        self.assertEqual(page_text_info(source, 999)["words"], [])
        self.assertEqual(page_text_info(Path("nonexistent.pdf"), 0)["words"], [])
        self.assertEqual(extract_selected_text(Path("nonexistent.pdf"), 0, (0, 0, 10, 10)), "")



if __name__ == '__main__':
    unittest.main()
