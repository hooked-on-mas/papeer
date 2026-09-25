"""PDFium rendering, independent of GUI framework."""
from __future__ import annotations

import io
import math
from pathlib import Path
import threading

import pypdfium2 as pdfium


_RENDER_LOCK = threading.Lock()  # PDFium calls must not run concurrently.
_MAX_PIXELS = 24_000_000
_MAX_SIDE = 8192


def pdf_page_count(path: Path) -> int | None:
    """Page count, or None when PDFium cannot open the file.

    PDFium rather than MuPDF, so this need not wait for a long text extraction to release PDF_LOCK.
    """
    try:
        with _RENDER_LOCK, pdfium.PdfDocument(path) as document:
            return len(document) or None
    except (OSError, pdfium.PdfiumError):
        return None


def page_png(path: Path, index: int, width: int = 650) -> bytes | None:
    if not math.isfinite(width) or width <= 0:
        raise ValueError("PDFの描画幅は正の数で指定してください。")
    with _RENDER_LOCK, pdfium.PdfDocument(path) as document:
        if not 0 <= index < len(document):
            return None
        page = document[index]
        try:
            page_width, page_height = page.get_size()
            scale = min(
                width / page_width,
                _MAX_SIDE / max(page_width, page_height),
                math.sqrt(_MAX_PIXELS / (page_width * page_height)),
            )
            bitmap = page.render(scale=scale, rev_byteorder=False)
            try:
                pil_image = bitmap.to_pil()
                buffer = io.BytesIO()
                pil_image.save(buffer, format="PNG")
                return buffer.getvalue()
            finally:
                bitmap.close()
        finally:
            page.close()
