"""Exercise the reader's actual scrollbar connections without a display."""
import os
from pathlib import Path
import shutil
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPoint, QPointF, Qt
from PySide6.QtGui import QNativeGestureEvent, QPointingDevice, QWheelEvent
from PySide6.QtWidgets import QApplication, QGestureEvent, QPinchGesture
from PySide6.QtTest import QSignalSpy, QTest

from paperdesk.gui import Window


class ScrollSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.window = Window(Path(self.temporary.name))
        self.window.show()
        self.app.processEvents()

    def tearDown(self):
        self.window.close()
        self.app.processEvents()
        self.temporary.cleanup()

    def wait_for_pages(self):
        self.window.render_timer.stop()
        spy = QSignalSpy(self.window.page_renderer.ready)
        self.window.render_pages()
        for _ in range(300):
            QTest.qWait(10)
            current = [spy.at(i) for i in range(spy.count())
                       if spy.at(i)[0] == self.window.render_generation]
            if len(current) == 2:
                # The worker can emit while qWait returns, before queued UI slots run.
                self.app.processEvents()
                return
        self.fail("PDF rendering did not finish")

    def test_bidirectional_scroll_with_different_ranges_and_resizing(self):
        for getter in ("verticalScrollBar", "horizontalScrollBar"):
            with self.subTest(axis=getter):
                left, right = [getattr(area, getter)() for area in self.window.pdf_scrolls]
                left.setRange(0, 1000)
                right.setRange(0, 600)
                left.setValue(750)
                self.assertEqual(right.value(), 450)
                right.setValue(150)
                self.assertEqual(left.value(), 250)
                # Range changes must preserve the position, including temporary
                # non-scrollable placeholders while a translation is loading.
                right.setRange(0, 0)
                self.assertEqual(left.value(), 250)
                left.setValue(800)
                right.setRange(0, 200)
                self.assertEqual(right.value(), 160)
                left.setRange(0, 400)
                self.assertEqual(left.value(), 320)
                self.assertEqual(right.value(), 160)
                right.setValue(right.maximum())
                self.assertEqual(left.value(), left.maximum())
                left.setValue(0)
                self.assertEqual(right.value(), 0)

    def test_pdf_zoom_resize_and_page_navigation(self):
        window = self.window
        identity, _ = window.library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
        folder = window.library.folder(identity)
        shutil.copyfile(folder / "original.pdf", folder / "translated.pdf")
        window.refresh_list()
        window.select_paper(identity)
        window.zoom_in_button.click()
        self.assertEqual(window.zoom.currentData(), 1.25)
        self.wait_for_pages()
        widths_before = [label.pixmap().deviceIndependentSize().width() for label in window.pdf_labels]
        for area in window.pdf_scrolls:
            event = QWheelEvent(QPointF(20, 20), QPointF(20, 20), QPoint(), QPoint(0, 120),
                                Qt.MouseButton.NoButton, Qt.KeyboardModifier.ControlModifier,
                                Qt.ScrollPhase.NoScrollPhase, False)
            QApplication.sendEvent(area.viewport(), event)
            self.assertTrue(event.isAccepted())
        self.assertEqual(window.zoom.currentData(), 2)
        self.wait_for_pages()
        widths_after = [label.pixmap().deviceIndependentSize().width() for label in window.pdf_labels]
        self.assertEqual(widths_after[0], widths_after[1])
        self.assertTrue(all(after > before for before, after in zip(widths_before, widths_after)))
        window.zoom_out_button.click()
        self.assertEqual(window.zoom.currentData(), 1.5)
        event = QWheelEvent(QPointF(20, 20), QPointF(20, 20), QPoint(), QPoint(0, -120),
                            Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier,
                            Qt.ScrollPhase.NoScrollPhase, False)
        QApplication.sendEvent(window.pdf_scrolls[0].viewport(), event)
        self.assertEqual(window.zoom.currentData(), 1.5)
        window.change_zoom(100)
        self.assertEqual(window.zoom.currentData(), 4)
        window.zoom_in_button.click()
        self.assertEqual(window.zoom.currentData(), 4)
        window.change_zoom(-100)
        window.zoom_out_button.click()
        self.assertEqual(window.zoom.currentIndex(), 0)
        window.zoom.setCurrentIndex(3)
        self.app.processEvents()
        window.render_pages()
        self.wait_for_pages()
        left, right = [area.verticalScrollBar() for area in window.pdf_scrolls]
        self.assertGreater(left.maximum(), 0)
        self.assertGreater(right.maximum(), 0)
        right.setValue(round(right.maximum() * .7))
        self.assertAlmostEqual(left.value() / left.maximum(), .7, delta=.005)
        window.zoom.setCurrentIndex(2)
        self.app.processEvents()
        self.wait_for_pages()
        self.assertAlmostEqual(left.value() / left.maximum(), right.value() / right.maximum(), delta=.005)
        window.move_page(1)
        self.app.processEvents()
        self.wait_for_pages()
        self.assertEqual(window.current_page, 1)
        self.assertEqual((left.value(), right.value()), (0, 0))

    def test_native_pinch_accumulates_and_resets_on_both_panes(self):
        window = self.window

        def send(area, kind, value=0):
            event = QNativeGestureEvent(kind, QPointingDevice.primaryPointingDevice(), 2,
                                        QPointF(20, 20), QPointF(20, 20), QPointF(20, 20),
                                        value, QPointF())
            QApplication.sendEvent(area.viewport(), event)
            self.assertTrue(event.isAccepted())

        for area in window.pdf_scrolls:
            window.zoom.setCurrentIndex(0)
            send(area, Qt.NativeGestureType.BeginNativeGesture)
            for _ in range(10):
                send(area, Qt.NativeGestureType.ZoomNativeGesture, .03)
            self.assertEqual(window.zoom.currentData(), 1.25)
            send(area, Qt.NativeGestureType.EndNativeGesture)
            self.assertIsNone(window._native_pinch_zoom)
            send(area, Qt.NativeGestureType.BeginNativeGesture)
            send(area, Qt.NativeGestureType.ZoomNativeGesture, -.2)
            self.assertEqual(window.zoom.currentIndex(), 0)
            send(area, Qt.NativeGestureType.ZoomNativeGesture, 10)
            self.assertEqual(window.zoom.currentData(), 4)
            send(area, Qt.NativeGestureType.ZoomNativeGesture, -.25)
            self.assertEqual(window.zoom.currentData(), 3)
            send(area, Qt.NativeGestureType.EndNativeGesture)

    def test_touch_pinch_uses_total_scale_and_handles_cancel(self):
        class Pinch(QPinchGesture):
            gesture_state = Qt.GestureState.GestureStarted

            def state(self):
                return self.gesture_state

        window = self.window
        for area in window.pdf_scrolls:
            window.zoom.setCurrentIndex(1)
            pinch = Pinch()

            def send(state, scale):
                pinch.gesture_state = state
                pinch.setTotalScaleFactor(scale)
                event = QGestureEvent([pinch])
                self.assertTrue(window.eventFilter(area.viewport(), event))
                self.assertTrue(event.isAccepted(pinch))

            send(Qt.GestureState.GestureStarted, 1)
            send(Qt.GestureState.GestureUpdated, 1.6)
            self.assertEqual(window.zoom.currentData(), 2)
            # Total scale is relative to the start, not to the last update.
            send(Qt.GestureState.GestureUpdated, 2)
            self.assertEqual(window.zoom.currentData(), 2.5)
            send(Qt.GestureState.GestureFinished, 2)
            self.assertIsNone(window._pinch_start_zoom)
            send(Qt.GestureState.GestureStarted, 1)
            send(Qt.GestureState.GestureUpdated, .5)
            self.assertEqual(window.zoom.currentData(), 1.25)
            send(Qt.GestureState.GestureCanceled, .5)
            self.assertEqual(window.zoom.currentData(), 2.5)
            self.assertIsNone(window._pinch_start_zoom)


if __name__ == "__main__":
    unittest.main()
