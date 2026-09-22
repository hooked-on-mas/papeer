"""PDFium display rendering, independent of the PDF extraction/authoring engine."""
from __future__ import annotations

import math
from pathlib import Path
import threading

import fitz
import pypdfium2 as pdfium
from PySide6.QtCore import QBuffer, QIODevice, QObject, Signal
from PySide6.QtGui import QImage


_TEXT_CACHE: dict[tuple[str, int, float], dict] = {}


_RENDER_LOCK = threading.Lock()  # PDFium calls must not run concurrently.
_MAX_PIXELS = 24_000_000
_MAX_SIDE = 8192


class PageRenderer(QObject):
    """One background renderer with a single replaceable pending request."""

    ready = Signal(int, int, object, int, str)

    def __init__(self):
        super().__init__()
        self._condition = threading.Condition()
        self._generation = 0
        self._pending = None
        self._stopped = False
        self._thread = threading.Thread(target=self._run, daemon=True, name="PDF display")
        self._thread.start()

    def invalidate(self):
        with self._condition:
            self._generation += 1
            self._pending = None
            return self._generation

    def submit(self, generation, pages):
        with self._condition:
            if not self._stopped and generation == self._generation:
                self._pending = (generation, pages)
                self._condition.notify()

    def stop(self):
        with self._condition:
            self._stopped = True
            self._pending = None
            self._condition.notify()

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._stopped or self._pending is not None)
                if self._stopped:
                    return
                generation, pages = self._pending
                self._pending = None
            for pane, path, index, pixels, width in pages:
                with self._condition:
                    if self._stopped or generation != self._generation:
                        break
                try:
                    result, error = page_image(path, index, pixels), ""
                except Exception as exc:
                    result, error = None, str(exc)
                with self._condition:
                    if not self._stopped and generation == self._generation:
                        self.ready.emit(generation, pane, result, width, error)


def page_image(path: Path, index: int, width: int = 650) -> QImage | None:
    if not math.isfinite(width) or width <= 0:
        raise ValueError("PDFの描画幅は正の数で指定してください。")
    with _RENDER_LOCK, pdfium.PdfDocument(path) as document:
        if not 0 <= index < len(document):
            return None
        page = document[index]
        try:
            page_width, page_height = page.get_size()
            scale = min(width / page_width, _MAX_SIDE / max(page_width, page_height),
                        math.sqrt(_MAX_PIXELS / (page_width * page_height)))
            bitmap = page.render(scale=scale, rev_byteorder=True,
                                 force_bitmap_format=pdfium.raw.FPDFBitmap_BGR)
            try:
                # Copy before the bitmap closes: Qt must own the returned pixels.
                return QImage(bytes(bitmap.buffer), bitmap.width, bitmap.height, bitmap.stride,
                              QImage.Format.Format_RGB888).copy()
            finally:
                bitmap.close()
        finally:
            page.close()


def page_png(path: Path, index: int, width: int = 650) -> bytes | None:
    image = page_image(path, index, width)
    if image is None:
        return None
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    if not image.save(buffer, "PNG"):
        raise RuntimeError("PDFの表示画像を作成できませんでした。")
    return bytes(buffer.data())


def page_text_info(path: Path, index: int) -> dict:
    """Return word coordinates and page dimensions in PDF points.

    Returns:
        {
            "pdf_size": (width, height),
            "words": [(x0, y0, x1, y1, text, block_no, line_no, word_no), ...],
        }
    """
    if not path.exists():
        return {"pdf_size": (0.0, 0.0), "words": []}
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    key = (str(path.resolve()), index, mtime)
    if key in _TEXT_CACHE:
        return _TEXT_CACHE[key]
    try:
        with fitz.open(path) as doc:
            if not 0 <= index < len(doc):
                res = {"pdf_size": (0.0, 0.0), "words": []}
            else:
                page = doc[index]
                rect = page.rect
                words = page.get_text("words")
                res = {
                    "pdf_size": (float(rect.width), float(rect.height)),
                    "words": words,
                }
    except Exception:
        res = {"pdf_size": (0.0, 0.0), "words": []}
    if len(_TEXT_CACHE) > 100:
        _TEXT_CACHE.clear()
    _TEXT_CACHE[key] = res
    return res


def extract_selected_text(path: Path, index: int, clip_rect: tuple[float, float, float, float]) -> str:
    """Extract formatted text within the specified PDF coordinates (x0, y0, x1, y1)."""
    if not path.exists():
        return ""
    try:
        with fitz.open(path) as doc:
            if not 0 <= index < len(doc):
                return ""
            page = doc[index]
            rect = fitz.Rect(*clip_rect)
            return page.get_text("text", clip=rect).strip()
    except Exception:
        return ""

