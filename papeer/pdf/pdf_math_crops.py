"""Use Type 1 glyph outlines to avoid copying neighboring lines into math."""
from functools import lru_cache
from io import BytesIO
import re
from collections import Counter
import unicodedata

import pymupdf as fitz
from fontTools import t1Lib
from fontTools.cffLib import CFFFontSet
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
    names = list(glyphs)
    # FreeType reserves glyph 0 for .notdef. In embedded Type 1 subsets it
    # swaps that glyph with the first CharString, rather than renumbering the
    # rest. MuPDF's trace uses those FreeType IDs.
    if ".notdef" in names:
        index = names.index(".notdef")
        names[0], names[index] = names[index], names[0]
    for name in names:
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        bounds.append(pen.bounds)
    return bounds


@lru_cache(maxsize=32)
def _cff_outline_bounds(data: bytes):
    font = CFFFontSet()
    font.decompile(BytesIO(data), None)
    top = font[font.fontNames[0]]
    if list(top.FontMatrix) != [.001, 0, 0, .001, 0, 0]:
        return None
    glyphs = top.CharStrings
    bounds = []
    for name in top.charset:
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        bounds.append(pen.bounds)
    return bounds


def _type3_bounds(document, xref):
    """Type 3 glyph programs declare their own ink box with d1.

    These fonts often have no extractable font file and their global FontBBox
    covers every glyph, so the text extractor's boxes include neighboring rows.
    """
    matrix = [float(n) for n in re.findall(r"[-+]?(?:\d*\.\d+|\d+)",
                                          document.xref_get_key(xref, "FontMatrix")[1])]
    if len(matrix) != 6:
        return {}
    encoding = document.xref_get_key(xref, "Encoding/Differences")[1]
    procedures = document.xref_get_key(xref, "CharProcs")[1]
    if not procedures.endswith(" R"):
        return {}
    procedures = int(procedures.split()[0])
    names, code = {}, 0
    for token in re.findall(r"/[^\s\[\]/]+|\d+", encoding):
        if token.startswith("/"):
            names[code] = token[1:]
            code += 1
        else:
            code = int(token)
    result = {}
    number = rb"([-+]?(?:\d*\.\d+|\d+))\s+"
    pattern = re.compile(number * 6 + rb"d1\b")
    for code, name in names.items():
        reference = document.xref_get_key(procedures, name)[1]
        if not reference.endswith(" R"):
            continue
        stream = document.xref_stream(int(reference.split()[0]))
        match = pattern.match(stream.lstrip()) if stream else None
        if match:
            _, _, x0, y0, x1, y1 = map(float, match.groups())
            result[code] = fitz.Rect(x0, y0, x1, y1) * fitz.Matrix(*matrix)
    return result


def page_glyph_bounds(page):
    fonts = {}
    type3 = {}
    for xref, extension, kind, name, *_ in page.get_fonts():
        if kind == "Type3":
            type3[name] = _type3_bounds(page.parent, xref)
        if extension in {"pfa", "cff"}:
            try:
                read_bounds = _outline_bounds if extension == "pfa" else _cff_outline_bounds
                bounds = read_bounds(page.parent.extract_font(xref)[3])
                # MuPDF truncates trace font names to 31 characters. Match the
                # same truncated name; otherwise long STIX operator faces lose
                # their actual outlines and use a one-em font box.
                base_name = name.split("+")[-1]
                fonts[base_name] = bounds
                fonts[base_name[:31]] = bounds
                fonts[name[:31].split("+")[-1]] = bounds
            except Exception:  # noqa: BLE001
                # Unsupported font programs retain the original crop bounds.
                continue
    result = {}
    combining = []
    for span in page.get_texttrace():
        if span["font"] in type3 and tuple(span["dir"]) == (1, 0):
            for _, glyph, origin, _ in span["chars"]:
                box = type3[span["font"]].get(glyph)
                if box is None or box.is_empty:
                    continue
                size = span["size"]
                tight = fitz.Rect(origin[0] + box.x0 * size, origin[1] - box.y1 * size,
                                  origin[0] + box.x1 * size, origin[1] - box.y0 * size)
                key = (round(origin[0], 2), round(origin[1], 2))
                result[key] = result[key] | tight if key in result else tight
            continue
        bounds = fonts.get(span["font"].split("+")[-1])
        if bounds is None or tuple(span["dir"]) != (1, 0):
            continue
        for code, glyph, origin, _ in span["chars"]:
            if glyph < 0 or glyph >= len(bounds) or bounds[glyph] is None:
                continue
            x0, y0, x1, y1 = bounds[glyph]
            scale = span["size"] / 1000
            box = fitz.Rect(
                origin[0] + x0 * scale, origin[1] - y1 * scale,
                origin[0] + x1 * scale, origin[1] - y0 * scale)
            key = (round(origin[0], 2), round(origin[1], 2))
            # A negation slash and '=' can have the same trace origin.
            result[key] = result[key] | box if key in result else box
            if unicodedata.combining(chr(code)):
                combining.append((chr(code), origin, box, span["size"]))
    if combining:
        # MuPDF's rawdict can shift a zero-advance combining mark left of
        # its texttrace origin. Alias that position to the actual outline;
        # otherwise one missing origin makes the entire crop fall back to
        # a font box tall enough to include the following prose row.
        for item in page.get_text("rawdict", flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]:
            for line in item.get("lines", []):
                for span in line["spans"]:
                    for char in span["chars"]:
                        if not unicodedata.combining(char["c"]):
                            continue
                        x, y = char["origin"]
                        candidates = [(abs(x - origin[0]), box) for code, origin, box, size in combining
                                      if char["c"] == code and abs(y - origin[1]) < .1
                                      and abs(x - origin[0]) <= size]
                        if candidates:
                            box = min(candidates, key=lambda candidate: candidate[0])[1]
                            key = (round(x, 2), round(y, 2))
                            result[key] = result[key] | box if key in result else box
    return result


def tighten_type3_geometry(page, items):
    """Use actual mathematical ink, including tall Type 1 operators.

    MTEX/CMEX can declare a one-em box for an integral three ems tall.
    Conversely, a Type 3 font-wide box can overlap several prose rows.
    Both must be corrected before classification and protected-region clipping.
    """
    names = {name for _, _, kind, name, *_ in page.get_fonts() if kind == "Type3"}
    bounds = page_glyph_bounds(page)
    for item in items:
        boxes = []
        for line in item.get("lines", []):
            chars = []
            for span in line["spans"]:
                for char in span["chars"]:
                    if span["font"] in names or span.get("math_font"):
                        x, y = char["origin"]
                        box = bounds.get((round(x, 2), round(y, 2)))
                        if box is not None:
                            char["bbox"] = (box.x0, box.y0, box.x1, box.y1)
                    if char["c"].strip() or span.get("math_font") and ord(char["c"]) < 32:
                        chars.append(fitz.Rect(char["bbox"]))
            if chars:
                box = fitz.Rect(chars[0])
                for other in chars[1:]:
                    box |= other
                line["bbox"] = (box.x0, box.y0, box.x1, box.y1)
                boxes.append(box)
        if boxes:
            box = fitz.Rect(boxes[0])
            for other in boxes[1:]:
                box |= other
            item["bbox"] = (box.x0, box.y0, box.x1, box.y1)
    if names:
        _attach_unmapped_math_images(page, items, bounds)
    for item in items:
        mixed = False
        for line in item.get("lines", []):
            prose = [(c["origin"][1], s["size"]) for s in line["spans"] if not s.get("math_font")
                     for c in s["chars"] if c["c"].isalpha()]
            size = max((size for _, size in prose), default=1)
            baselines = [y for y, s in prose if s >= size * .85]
            if baselines and max(baselines) - min(baselines) > size * .65:
                mixed = True
        if (names or mixed) and item.get("lines") and all(
                tuple(line.get("dir", (1, 0))) == (1, 0) for line in item["lines"]):
            _rebuild_type3_rows(item)


def _attach_unmapped_math_images(page, items, bounds):
    """A few publishers embed mathematical letters as images with no text glyph.

    Only small images beside known math are eligible. The virtual glyph exists
    solely to preserve that ink in a formula crop, never to guess its meaning.
    """
    chars = [(index, dict(c, size=s["size"], math_font=s.get("math_font", False)))
             for index, item in enumerate(items) for line in item.get("lines", [])
             for s in line["spans"] for c in s["chars"] if c["c"].strip() or s.get("math_font")]
    if not chars:
        return
    size = Counter(round(c["size"], 1) for _, c in chars).most_common(1)[0][0]
    ink = list(bounds.values())
    math = [(index, c) for index, c in chars if c["math_font"] and c["c"] != " "]
    bases = [(index, c) for index, c in chars if c["size"] >= size * .85 and c["c"] != " "]
    columns = [fitz.Rect(item["bbox"]) for item in items if fitz.Rect(item["bbox"]).width > 150]
    for info in page.get_image_info():
        box = fitz.Rect(info["bbox"])
        center = (box.tl + box.br) / 2
        if (box.width > size * 2.5 or box.height > size * 3 or box.is_empty
                or any(glyph.contains(center) for glyph in ink)):
            continue
        neighbors = [(index, c) for index, c in math
                     if abs(center.y - (c["bbox"][1] + c["bbox"][3]) / 2) < size * .8
                     and max(box.x0, c["bbox"][0]) - min(box.x1, c["bbox"][2]) < size * 1.5]
        if not neighbors:
            continue
        column = min((col for col in columns if col.x0 - 3 <= center.x <= col.x1 + 3),
                     key=lambda col: col.width, default=page.rect)
        baseline_candidates = [c for _, c in bases
                               if column.x0 - 3 <= c["origin"][0] <= column.x1 + 3
                               and box.y0 < c["origin"][1] + size * .3
                               and box.y1 > c["origin"][1] - size * .85]
        if not baseline_candidates:
            continue
        base = min(baseline_candidates, key=lambda c: abs(box.y1 - c["origin"][1])
                   + max(box.x0 - c["bbox"][2], c["bbox"][0] - box.x1, 0) * .1)
        index, _ = min(neighbors, key=lambda value: abs(center.y - value[1]["origin"][1])
                       + max(box.x0 - value[1]["bbox"][2], value[1]["bbox"][0] - box.x1, 0))
        coordinates = (box.x0, box.y0, box.x1, box.y1)
        char = dict(c='\ufffc', origin=(box.x0, base["origin"][1]), bbox=coordinates, ink_bbox=list(coordinates))
        span = dict(font='PD-MathImage', flags=0, size=size, math_font=True, chars=[char])
        items[index]["lines"].append(dict(bbox=coordinates, spans=[span], dir=(1, 0)))


def _rebuild_type3_rows(item):
    # The PDF text extractor has already used the font-wide Type3 box to
    # build lines. Tightening those boxes alone cannot undo mixed baselines.
    chars = [dict(c, font=s["font"], flags=s["flags"], size=s["size"], math_font=s.get("math_font", False))
             for line in item["lines"] for s in line["spans"] for c in s["chars"]]
    if not chars:
        return
    size = Counter(round(c["size"], 1) for c in chars if c["c"].strip()).most_common(1)
    if not size:
        return
    size = size[0][0]
    rows = []
    base = [c for c in chars if c["size"] >= size * .8 and c["c"].strip()]
    rest = [c for c in chars if c["size"] < size * .8 or not c["c"].strip()]
    for char in sorted(base, key=lambda c: c["origin"][1]):
        y = char["origin"][1]
        row = next((row for row in rows if abs(row[0] - y) < 1), None)
        if row is None:
            rows.append((y, [char]))
        else:
            row[1].append(char)
    for char in rest:
        if not rows:
            rows.append((char["origin"][1], [char]))
            continue
        row = min(rows, key=lambda row: abs(row[0] - char["origin"][1]))
        if abs(row[0] - char["origin"][1]) > size * .65 and char["c"].strip():
            rows.append((char["origin"][1], [char]))
        else:
            row[1].append(char)
    lines = []
    for _, row in sorted(rows):
        row.sort(key=lambda c: c["bbox"][0])
        visible = [c for c in row if c["c"].strip() or c["math_font"] and ord(c["c"]) < 32]
        if not visible:
            continue
        box = fitz.Rect(visible[0]["bbox"])
        for char in visible[1:]:
            box |= fitz.Rect(char["bbox"])
        spans = [dict(font=c["font"], flags=c["flags"], size=c["size"], math_font=c["math_font"], chars=[c])
                 for c in row]
        coordinates = (box.x0, box.y0, box.x1, box.y1)
        lines.append(dict(bbox=list(coordinates), spans=spans, dir=(1, 0), merged=True, regions=[list(coordinates)]))
    item["lines"] = lines


def formula_crop(formula, glyph_bounds):
    original = fitz.Rect(formula["bbox"])
    origins = formula.get("glyph_origins", [])
    boxes = [glyph_bounds.get((round(x, 2), round(y, 2))) for x, y in origins]
    boxes.extend(fitz.Rect(box) for box in formula.get("extra_ink", []))
    if not boxes or any(box is None for box in boxes):
        return original
    crop = fitz.Rect(boxes[0])
    for box in boxes[1:]:
        crop |= box
    # Keep the original horizontal advance; tighten only the contaminated
    # vertical whitespace, with room for antialiasing at the glyph edges.
    return fitz.Rect(min(original.x0, crop.x0 - .3), crop.y0 - .3,
                     max(original.x1, crop.x1 + .3), crop.y1 + .3)
