"""Region captures of a displayed PDF page, pasted into reading notes as images."""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

from papeer.pdf.pdf_ink import annotated_page
from papeer.pdf.pdf_viewer import page_png

CAPTURE_WIDTH = 1800


def capture_png(source: Path, index: int, box: tuple[float, float, float, float],
                strokes: list[dict] | None = None) -> bytes:
    """PNG of the normalized box (x, y, width, height) of one displayed page.

    With strokes, that ink is painted in first; source is left untouched either way.
    Raises ValueError when the page cannot be rendered or the box covers no whole pixel.
    """
    if strokes is None:
        rendered = page_png(source, index, CAPTURE_WIDTH)
    else:
        rendered = page_png(annotated_page(source, index, strokes), 0, CAPTURE_WIDTH)
    if rendered is None:
        raise ValueError("ページを画像にできませんでした。")
    x, y, width, height = box
    with Image.open(io.BytesIO(rendered)) as image:
        pixels = (round(x * image.width), round(y * image.height),
                  round((x + width) * image.width), round((y + height) * image.height))
        if pixels[2] <= pixels[0] or pixels[3] <= pixels[1]:
            raise ValueError("もう少し広い範囲を選択してください。")
        buffer = io.BytesIO()
        image.crop(pixels).save(buffer, format="PNG")
        return buffer.getvalue()
