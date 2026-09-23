"""Send real Qt key events through the reader's focused widgets."""
import os
from pathlib import Path
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from paperdesk.gui import Window


class PageKeyboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.window = Window(Path(self.temporary.name))
        self.window.show()
        self.window.activateWindow()
        identity, _ = self.window.library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
        self.window.refresh_list()
        self.window.select_paper(identity)
        self.window.paper_list.setCurrentItem(self.window._paper_tree_item(identity))
        self.app.processEvents()

    def tearDown(self):
        self.window.close()
        self.window.render_timer.stop()
        self.app.processEvents()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, 0)
        if hasattr(self.window, "page_renderer"):
            self.window.page_renderer.stop()
            self.window.page_renderer._thread.join(5)
        self.temporary.cleanup()

    def press(self, widget, key, modifier=Qt.KeyboardModifier.NoModifier):
        widget.setFocus()
        self.app.processEvents()
        QTest.keyClick(widget, key, modifier)
        self.app.processEvents()

    def test_arrows_after_selecting_a_paper_and_in_both_pdf_panes(self):
        for widget in [self.window.paper_list, *self.window.pdf_scrolls]:
            with self.subTest(widget=widget):
                self.press(widget, Qt.Key.Key_Right)
                self.assertEqual(self.window.current_page, 1)
                self.press(widget, Qt.Key.Key_Left)
                self.assertEqual(self.window.current_page, 0)
                self.press(widget, Qt.Key.Key_Left)
                self.assertEqual(self.window.current_page, 0)

    def test_folder_arrows_still_expand_and_collapse(self):
        tree = self.window.paper_list
        folder = tree.currentItem().parent()
        tree.setCurrentItem(folder)
        folder.setExpanded(False)
        self.press(tree, Qt.Key.Key_Right)
        self.assertTrue(folder.isExpanded())
        self.assertEqual(self.window.current_page, 0)
        self.press(tree, Qt.Key.Key_Left)
        self.assertFalse(folder.isExpanded())

    def test_text_controls_modifiers_and_other_tabs_do_not_turn_pages(self):
        window = self.window
        window.search.setText("sample")
        window.search.setCursorPosition(1)
        self.press(window.search, Qt.Key.Key_Right)
        self.assertEqual(window.search.cursorPosition(), 2)
        for widget in [window.page_input, window.zoom, window.page_filter]:
            self.press(widget, Qt.Key.Key_Right)
            self.assertEqual(window.current_page, 0)
        self.press(window.pdf_scrolls[0], Qt.Key.Key_Right, Qt.KeyboardModifier.ControlModifier)
        self.assertEqual(window.current_page, 0)
        window.tabs.setCurrentIndex(1)
        self.press(window.paper_list, Qt.Key.Key_Right)
        self.assertEqual(window.current_page, 0)


if __name__ == "__main__":
    unittest.main()
