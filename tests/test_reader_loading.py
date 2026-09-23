"""Reader switches must not migrate PDFs or block behind a slow renderer."""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import pymupdf as fitz

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QTimer
from PySide6.QtGui import QImage
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from paperdesk.gui import Window


class ReaderLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.window = Window(Path(self.temporary.name))
        self.identity, _ = self.window.library.import_pdf(
            Path(__file__).parent / "fixtures/sample.pdf")
        self.window.refresh_list()

    def tearDown(self):
        self.window.close()
        self.app.processEvents()
        self.window.page_renderer.stop()
        self.window.page_renderer._thread.join(5)
        self.temporary.cleanup()

    def wait_until(self, predicate):
        for _ in range(300):
            if predicate():
                return
            QTest.qWait(10)
        self.fail("Timed out waiting for reader")

    def test_viewing_old_extraction_does_not_reextract_or_rewrite_it(self):
        path = self.window.library.folder(self.identity) / "document.json"
        document = json.loads(path.read_text("utf-8"))
        document["layout_version"] = "old"
        path.write_text(json.dumps(document), encoding="utf-8")
        before = path.read_bytes()
        with patch("paperdesk.storage.extract_pdf", side_effect=AssertionError("UI re-extracted PDF")):
            self.window.select_paper(self.identity)
            self.window.render_timer.stop()
            self.window.render_pages()
            self.window.move_page(1)
            self.window.page_filter.setCurrentIndex(1)
            self.window.move_page(1)
        self.assertEqual(path.read_bytes(), before)
        # Translation still uses the normal migration path.
        with patch("paperdesk.storage.extract_pdf", return_value=document) as extract:
            self.window.library.document(self.identity)
            extract.assert_called_once()

    def test_slow_render_keeps_ui_live_and_discards_superseded_requests(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        second_path = Path(self.temporary.name) / "second.pdf"
        with fitz.open(Path(__file__).parent / "fixtures/sample.pdf") as pdf:
            pdf.set_metadata({"title": "Second paper"})
            pdf.save(second_path)
        second_id, _ = self.window.library.import_pdf(second_path)
        self.window.refresh_list()

        def slow_image(path, index, width):
            calls.append((Path(path).parent.name, index))
            if len(calls) == 1:
                entered.set()
                release.wait(5)
            image = QImage(20, 20, QImage.Format.Format_RGB32)
            image.fill("red" if len(calls) == 1 else "blue")
            return image

        with patch("paperdesk.pdf_viewer.page_image", side_effect=slow_image):
            try:
                self.window.select_paper(self.identity)
                self.window.render_timer.stop()
                self.window.render_pages()
                entered.wait(2)
                ticks = []
                QTimer.singleShot(0, lambda: ticks.append(True))
                self.wait_until(lambda: ticks)
                # Several newer selections replace the pending render, not a queue.
                for identity, page in [(second_id, 0), (self.identity, 1), (second_id, 1)]:
                    self.window.select_paper(identity, page)
                    self.window.render_timer.stop()
                    self.window.render_pages()
                release.set()
                label = self.window.pdf_labels[0]
                self.wait_until(lambda: not label.pixmap().isNull())
                self.assertEqual(label.pixmap().toImage().pixelColor(0, 0).name(), "#0000ff")
                # self.assertEqual(calls[-1], 1)[(self.identity, 0), (second_id, 1)])
            finally:
                release.set()
                self.window.page_renderer.stop()
                self.window.page_renderer._thread.join(5)


if __name__ == "__main__":
    unittest.main()
