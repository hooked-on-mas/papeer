"""PDFium display rendering, independent of the PDF extraction/authoring engine."""
from __future__ import annotations

import math
from pathlib import Path
import threading

import pypdfium2 as pdfium
from PySide6.QtCore import QBuffer, QIODevice
from PySide6.QtGui import QImage


_RENDER_LOCK = threading.Lock()  # PDFium calls must not run concurrently.
_MAX_PIXELS = 24_000_000
_MAX_SIDE = 8192


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
