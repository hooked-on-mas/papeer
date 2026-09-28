"""Use Type 1 glyph outlines to avoid copying neighboring lines into math."""
from functools import lru_cache

import pymupdf as fitz
from fontTools import t1Lib
from fontTools.pens.boundsPen import BoundsPen


@lru_cache(maxsize=32)
def _outline_bounds(data: bytes):
    # Embedded PDF Type 1 programs omit the outer PFA trailer expected by
    # T1Font(path). Its parser accepts the embedded program directly.
    font = object.__new__(t1Lib.T1Font)
    font.data, font.encoding = data, "ascii"
    glyphs = font.getGlyphSet()
    matrix = font["FontMatrix"]
    if list(matrix) != [.001, 0, 0, .001, 0, 0]:
        return None
    bounds = []
    for glyph in glyphs.values():
        pen = BoundsPen(glyphs)
        glyph.draw(pen)
        bounds.append(pen.bounds)
    return bounds


def page_glyph_bounds(page):
    fonts = {}
    for xref, extension, _, name, *_ in page.get_fonts():
        if extension == "pfa":
            try:
                fonts[name.split("+")[-1]] = _outline_bounds(page.parent.extract_font(xref)[3])
            except Exception:  # noqa: BLE001
                # Unsupported font programs retain the original crop bounds.
                continue
    result = {}
    for span in page.get_texttrace():
        bounds = fonts.get(span["font"].split("+")[-1])
        if bounds is None or tuple(span["dir"]) != (1, 0):
            continue
        for code, glyph, origin, _ in span["chars"]:
            if glyph < 0 or glyph >= len(bounds) or bounds[glyph] is None:
                continue
            x0, y0, x1, y1 = bounds[glyph]
            scale = span["size"] / 1000
            result[(round(origin[0], 2), round(origin[1], 2))] = fitz.Rect(
                origin[0] + x0 * scale, origin[1] - y1 * scale,
                origin[0] + x1 * scale, origin[1] - y0 * scale)
    return result


def formula_crop(formula, glyph_bounds):
    original = fitz.Rect(formula["bbox"])
    origins = formula.get("glyph_origins", [])
    boxes = [glyph_bounds.get((round(x, 2), round(y, 2))) for x, y in origins]
    if not boxes or any(box is None for box in boxes):
        return original
    crop = fitz.Rect(boxes[0])
    for box in boxes[1:]:
        crop |= box
    # Keep the original horizontal advance; tighten only the contaminated
    # vertical whitespace, with room for antialiasing at the glyph edges.
    return fitz.Rect(original.x0, min(crop.y0 - .3, original.y1), original.x1, max(crop.y1 + .3, original.y0))
