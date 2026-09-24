from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
import pymupdf as fitz

from paperdesk.pdf.pdf_typography import FONT_CSS, font_archive
from paperdesk.pdf.pdf_viewer import page_png


class PdfViewerTests(unittest.TestCase):
    def test_japanese_survives_both_fresh_viewer_processes(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source, rendered = folder / "日本語.pdf", folder / "rendered.png"
            text = "日本語の数式表示を確認 制御器の設計"
            with fitz.open() as pdf:
                page = pdf.new_page(width=360, height=180)
                page.insert_htmlbox(
                    fitz.Rect(10, 10, 350, 170),
                    '<p style="font-family:PaperDeskSerif;font-size:22pt">日本語の数式表示を確認</p>'
                    '<p style="font-family:PaperDeskHeading;font-weight:bold;font-size:24pt">制御器の設計</p>',
                    css=FONT_CSS,
                    archive=font_archive(text),
                )
                boxes = [
                    fitz.Rect(char["bbox"])
                    for block in page.get_text("rawdict")["blocks"]
                    if block["type"] == 0
                    for line in block["lines"]
                    for span in line["spans"]
                    for char in span["chars"]
                    if "\u3400" <= char["c"] <= "\u9fff"
                ]
                self.assertGreater(len(boxes), 10)
                pdf.save(source)
            renderers = {
                "pdfium": (
                    "import sys; from pathlib import Path; from paperdesk.pdf.pdf_viewer import page_png; "
                    "Path(sys.argv[2]).write_bytes(page_png(Path(sys.argv[1]),0,1080))"
                ),
                "mupdf": (
                    "import sys,pymupdf as f; d=f.open(sys.argv[1]); "
                    "d[0].get_pixmap(matrix=f.Matrix(3,3)).save(sys.argv[2])"
                ),
            }
            for engine, code in renderers.items():
                subprocess.run(
                    [sys.executable, "-X", "utf8", "-c", code, str(source), str(rendered)],
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
                with Image.open(str(rendered)) as image:
                    self.assertEqual(image.width, 1080)
                    for box in boxes:
                        with self.subTest(engine=engine, box=box):
                            glyph = image.crop((int(box.x0 * 3), int(box.y0 * 3), int(box.x1 * 3), int(box.y1 * 3)))
                            gray = glyph.convert("L")
                            pixels = list(gray.getdata())
                            self.assertGreater(
                                sum(v < 160 for v in pixels),
                                gray.width * gray.height * 0.025,
                            )

    def test_invalid_page_and_zoom(self):
        source = Path(__file__).parent / "fixtures/sample.pdf"
        self.assertIsNone(page_png(source, -1))
        self.assertIsNone(page_png(source, 999))
        png_bytes = page_png(source, 0, 300)
        self.assertIsNotNone(png_bytes)
        self.assertTrue(png_bytes.startswith(b"\x89PNG"))
        for width in [0, -1, float("nan"), float("inf")]:
            with self.subTest(width=width), self.assertRaises(ValueError):
                page_png(source, 0, width)


if __name__ == "__main__":
    unittest.main()
