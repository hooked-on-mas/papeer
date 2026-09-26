"""Persistent freehand ink in normalized, displayed-page coordinates."""
from __future__ import annotations

from pathlib import Path

import pymupdf as fitz

from papeer.pdf.pdf_engine import PDF_LOCK


def _text_units(text: str) -> float:
    return sum(0.6 if ord(char) <= 255 else 1 for char in text)


def _draw_text(page, stroke, points, color, font):
    """Map the four-corner text box exactly as the SVG editor does, including rotation."""
    a, b, _, d = points
    lines = stroke["text"].split("\n")
    size = abs(d - a) / (len(lines) * 1.3)
    units = max(1, *(_text_units(line) for line in lines))
    ux, uy = (b.x - a.x) / (units * size), (b.y - a.y) / (units * size)
    vx, vy = (d.x - a.x) / (len(lines) * size * 1.3), (d.y - a.y) / (len(lines) * size * 1.3)
    page.insert_font(fontname="PapeerInk", fontbuffer=font.buffer)
    for index, line in enumerate(lines):
        if not line:
            continue
        # PDF's morph uses y-up Cartesian vectors; page and SVG coordinates use y-down.
        scale_x = _text_units(line) * size / max(0.001, font.text_length(line, fontsize=size))
        matrix = fitz.Matrix(ux * scale_x, -uy * scale_x, -vx, vy, 0, 0)
        baseline = a + fitz.Point(vx, vy) * (size * (0.9 + index * 1.3))
        page.insert_text(baseline, line, fontname="PapeerInk", fontsize=size,
                         color=color, morph=(baseline, matrix), overlay=True)


def _draw_strokes(page, strokes, font=None):
    width, height = page.rect.width, page.rect.height
    rotation, derotation = page.rotation, page.derotation_matrix
    # Shape's crop-box transform must be computed in unrotated page space.
    page.set_rotation(0)
    for stroke in strokes:
        points = [fitz.Point(x * width, y * height) * derotation
                  for x, y in stroke["points"]]
        color = tuple(int(stroke["color"][i:i + 2], 16) / 255 for i in (1, 3, 5))
        if stroke.get("kind") == "text":
            if font is None:
                font = fitz.Font("japan")
            _draw_text(page, stroke, points, color, font)
            continue
        pen_width = stroke["width"] * width
        opacity = 0.3 if stroke.get("kind") == "highlighter" else 1
        # Paint vector ink into a copy, so external viewers and printing retain it.
        shape = page.new_shape()
        if len(points) == 1 or all(point == points[0] for point in points):
            shape.draw_circle(points[0], pen_width / 2)
            shape.finish(color=color, fill=color, width=0, stroke_opacity=opacity, fill_opacity=opacity)
        else:
            shape.draw_polyline(points)
            shape.finish(color=color, width=pen_width, lineCap=1, lineJoin=1, closePath=False, stroke_opacity=opacity)
        shape.commit()
    page.set_rotation(rotation)
    return font


def annotated_pdf(source: Path, pages: dict[int, list[dict]]) -> bytes:
    """A copy of source with the ink of each page number painted in."""
    with PDF_LOCK, fitz.open(source) as pdf:
        font = None
        for number, strokes in pages.items():
            if not strokes:
                continue
            if not 1 <= number <= len(pdf):
                raise ValueError("書き込みに対応するページがありません。PDFのページ数を確認してください。")
            page = pdf[number - 1]
            font = _draw_strokes(page, strokes, font)
        if font is not None:
            pdf.subset_fonts()
        return pdf.tobytes(garbage=3, deflate=True)


def annotated_page(source: Path, index: int, strokes: list[dict]) -> bytes:
    """Paint one displayed page, including translation preview pages with a different physical index."""
    with PDF_LOCK, fitz.open(source) as original, fitz.open() as pdf:
        pdf.insert_pdf(original, from_page=index, to_page=index)
        if _draw_strokes(pdf[0], strokes) is not None:
            pdf.subset_fonts()
        return pdf.tobytes(garbage=3, deflate=True)
