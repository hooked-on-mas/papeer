"""Build compact TrueType faces readable by both MuPDF and PDFium."""
from __future__ import annotations

import io

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen


def truetype_subset(font, family: str, style: str) -> bytes:
    # The CID-keyed CFF assets render incorrectly in a fresh MuPDF process,
    # even with glyph IDs retained. Convert only the used outlines to TrueType.
    # One font unit of curve approximation error is < .02pt at reading sizes.
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for name in font.getGlyphOrder():
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, max_err=1, reverse_direction=True))
        glyphs[name] = pen.glyph()
    builder = FontBuilder(font["head"].unitsPerEm, isTTF=True)
    builder.setupGlyphOrder(font.getGlyphOrder())
    builder.setupCharacterMap(font.getBestCmap())
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(font["hmtx"].metrics)
    builder.setupHorizontalHeader(ascent=font["hhea"].ascent, descent=font["hhea"].descent,
                                  lineGap=font["hhea"].lineGap)
    builder.font["OS/2"] = font["OS/2"]
    # Keep copyright/license metadata; derivatives must not use reserved names.
    names = {0: font["name"].getDebugName(0) or "",
             1: family, 2: style, 3: f"Papeer:{family}-{style}",
             4: f"{family} {style}", 6: f"{family}-{style}",
             13: font["name"].getDebugName(13) or "SIL Open Font License 1.1",
             14: font["name"].getDebugName(14) or "https://openfontlicense.org"}
    builder.setupNameTable(names)
    builder.setupPost()
    builder.font["head"].macStyle = font["head"].macStyle
    for tag in ("GSUB", "GPOS", "GDEF"):
        if tag in font:
            builder.font[tag] = font[tag]
    data = io.BytesIO()
    builder.save(data)
    return data.getvalue()
