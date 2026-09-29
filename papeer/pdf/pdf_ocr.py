"""Read a page that needs OCR (a scan, a garbled text layer) into the blocks extraction makes.

The page is rendered (OCR_DPI, grayscale), cut into regions (papeer.layout.ocr_regions) and the text
regions are read by an OCR engine (papeer.layout.ocr_engines). Each text region (about a paragraph)
becomes a text block in the shape of PyMuPDF's rawdict (lines, spans, characters with boxes), so the
usual layout (math_layout.layout_blocks, reading_flow) handles it like any other page. Formulas and
figures are not read: they become "formula" and "figure" blocks, kept as the original image like the
display math and figures of a born-digital PDF.

OCR text has no fonts (Tesseract's GlyphLessFont), so nothing here or downstream can tell math or
bold type by font: spans carry the font name "OCR" and math_font False.

A skewed scan is read turned straight. Each OCR line is moved back to where its middle lies on the
page, not turned, so lines stay horizontal and never overlap; a block's box is then widened by the
height the skew adds across its lines, so that painting over it covers the slanted original.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
import statistics
import time
import unicodedata

import pymupdf as fitz
from PIL import Image

from papeer.layout.math_layout import layout_blocks, merge_continued_prose, merge_overlapping_prose
from papeer.layout.ocr_engines import EngineSet, OcrError, OcrLine, OcrOptions, OcrWord, recognize
from papeer.layout.ocr_regions import PageLayout, segment_page
from papeer.pdf.pdf_typography import merge_wrapped_headings

# The font name of OCR text (it has none: GlyphLessFont carries no style).
OCR_FONT = "OCR"
# Letters (Latin or Japanese) below this share of a region's characters: not text (a table of
# numbers, tick labels, a formula read as symbols); the region is kept as the original.
TEXT_LETTER_SHARE = .35
# A Latin word gap wider than this share of the line height is a space (Windows' Japanese recognizer
# gives Latin text letter by letter; Tesseract's words are split at wider gaps anyway).
SPACE_GAP = .1
# Line height (ink of ascenders and descenders) to type size; line pitch to type size.
INK_EM = .92
PITCH_EM = 1.18

_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]")
_LATIN_WORD = re.compile(r"[A-Za-z]{3,}")
_MATH_SIGN = re.compile(r"[=<>≤≥≠≈±×÷∑∏∫√∞∂∇∈⊂⊆∀∃|^_{}\\]")


def _wide(c: str) -> bool:
    return unicodedata.east_asian_width(c) in ("W", "F")


def letter_share(text: str) -> float:
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 0.0
    return sum(c.isalpha() or bool(_CJK.match(c)) for c in chars) / len(chars)


def prose_text(text: str, lang: str) -> bool:
    """Text a short region shows is words (a heading, an author line, a sentence), not a formula.

    Strict on purpose: a formula taken for prose would be translated away, a heading taken for a
    formula only stays untranslated.
    """
    text = unicodedata.normalize("NFKC", text).strip()
    if not text:
        return False
    cjk = len(_CJK.findall(text))
    words = _LATIN_WORD.findall(text)
    signs = len(_MATH_SIGN.findall(text))
    if lang == "ja" and cjk >= 2:
        return cjk >= .5 * sum(not c.isspace() for c in text) and signs == 0
    if letter_share(text) < .6:
        return False
    if signs and len(words) < 4:
        return False
    tokens = text.split()
    # A one-word heading ("Abstract", "References", "3. Model"): letters only, apart from its number.
    if len(tokens) <= 3 and any(re.fullmatch(r"[A-Za-z]{4,}[.:]?", t) for t in tokens):
        return True
    return len(words) >= 2


def document_language(texts) -> str | None:
    """"ja" or "en" by the characters of the document's text layer, None when it has too little."""
    cjk = latin = 0
    for text in texts:
        cjk += len(_CJK.findall(text))
        latin += sum(c.isascii() and c.isalpha() for c in text)
    if cjk + latin < 100:
        return None
    return "ja" if cjk >= .2 * (cjk + latin) else "en"


# The page image is kept within these (a poster or a drawing sheet would take gigabytes at OCR_DPI): an
# A3 page still gets 300 dpi, larger pages a lower resolution.
MAX_PIXELS = 25_000_000
MAX_SIDE = 10_000


def render_dpi(page: fitz.Page, dpi: int) -> int:
    """dpi, lowered as far as the page's image needs to stay within MAX_PIXELS and MAX_SIDE."""
    width, height = page.cropbox.width, page.cropbox.height
    if width <= 0 or height <= 0:
        return dpi
    dpi = max(1, min(dpi, int(min(math.sqrt(MAX_PIXELS / (width * height)) * 72, MAX_SIDE * 72 / max(width, height)))))

    def size(value: int) -> tuple[int, int]:
        # MuPDF rounds the pixmap's sides up (and can add a pixel): count the image as it will be.
        return math.ceil(width * value / 72) + 1, math.ceil(height * value / 72) + 1
    while dpi > 1 and (size(dpi)[0] * size(dpi)[1] > MAX_PIXELS or max(size(dpi)) > MAX_SIDE):
        dpi -= 1
    return dpi


def render_page(page: fitz.Page, dpi: int) -> tuple[Image.Image, int]:
    """(the page as a grayscale image in its unrotated coordinates, those of extraction; the dpi it
    was rendered at, render_dpi)."""
    dpi = render_dpi(page, dpi)
    rotation = page.rotation
    try:
        page.set_rotation(0)
        pixmap = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False, annots=False)
    finally:
        page.set_rotation(rotation)
    return Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples), dpi


@dataclass
class OcrPage:
    """A page read by OCR: its text blocks (rawdict shape, page coordinates) and what stays an image."""
    items: list[dict]
    formulas: list[fitz.Rect]
    figures: list[fitz.Rect]
    engine: str
    lang: str
    angle: float
    seconds: float
    engines_used: set[str] = field(default_factory=set)

    def summary(self) -> dict:
        """What document.json records for the page (ocr_applied): the same for the same page and engines,
        so that extracting again gives the same document (the time goes to the log only)."""
        return {"engine": "+".join(sorted(self.engines_used)) or self.engine, "lang": self.lang, "skew": self.angle}

    def to_record(self) -> dict:
        """The reading as the paper keeps it (ocr-text.json, papeer.core.ocr_readings): the text lines with
        their characters' edges, and the formula and figure areas, in page coordinates.

        Extracting the paper again (a new LAYOUT_VERSION, on this PC or another) builds the page's blocks
        from it instead of reading the page again: nothing is read twice, the AI is never asked again,
        and the text (and so the translation cache) stays the same whatever engines the PC has.
        """
        blocks = []
        for item in self.items:
            lines = []
            for line in item["lines"]:
                span = line["spans"][0]
                chars = span["chars"]
                lines.append([_round(line["bbox"][1]), _round(line["bbox"][3]), round(span["size"], 3),
                              "".join(c["c"] for c in chars),
                              [_round(v) for c in chars for v in (c["bbox"][0], c["bbox"][2])]])
            blocks.append(lines)
        return {"version": RECORD_VERSION, **self.summary(), "blocks": blocks,
                "formulas": [[_round(v) for v in rect] for rect in self.formulas],
                "figures": [[_round(v) for v in rect] for rect in self.figures]}

    @classmethod
    def from_record(cls, record: object) -> OcrPage | None:
        """The reading to_record kept, or None when it is not one this version can use."""
        try:
            if not isinstance(record, dict) or record.get("version") != RECORD_VERSION:
                return None
            items = []
            for lines in record["blocks"]:
                out_lines = []
                for top, bottom, size, text, edges in lines:
                    if len(edges) != 2 * len(text):
                        return None
                    line = _text_line(float(top), float(bottom), float(size),
                                      [(c, float(edges[2 * i]), float(edges[2 * i + 1])) for i, c in enumerate(text)])
                    if line is not None:
                        out_lines.append(line)
                if out_lines:
                    items.append(_block(out_lines, len(items)))
            formulas = [fitz.Rect(*box) for box in record["formulas"]]
            figures = [fitz.Rect(*box) for box in record["figures"]]
            engine, lang, angle = str(record["engine"]), str(record["lang"]), float(record["skew"])
        except (KeyError, TypeError, ValueError):
            return None
        return cls(items, formulas, figures, engine, lang, angle, 0.0, {name for name in engine.split("+") if name})


# The shape of OcrPage.to_record: raise it when the record changes, and readings kept before are read again.
RECORD_VERSION = 1


def _round(value: float) -> float:
    return round(float(value), 2)


def _text_line(top: float, bottom: float, size: float, chars: list[tuple[str, float, float]]) -> dict | None:
    """A rawdict line of OCR text: characters (text, left, right) between top and bottom (page points)."""
    if not chars:
        return None
    baseline = bottom - .2 * (bottom - top)
    out = [{"c": c, "bbox": (a, top, b, bottom), "origin": (a, baseline), "synthetic": c == " "} for c, a, b in chars]
    bbox = (out[0]["bbox"][0], top, out[-1]["bbox"][2], bottom)
    span = {"font": OCR_FONT, "flags": 0, "size": size, "color": 0, "alpha": 255,
            "ascender": .8, "descender": -.2, "bbox": bbox, "origin": out[0]["origin"],
            "chars": out, "math_font": False}
    return {"bbox": bbox, "wmode": 0, "dir": (1.0, 0.0), "spans": [span]}


def _block(lines: list[dict], number: int) -> dict:
    return {"type": 0, "number": number, "ocr": True, "lines": lines,
            "bbox": (min(ln["bbox"][0] for ln in lines), min(ln["bbox"][1] for ln in lines),
                     max(ln["bbox"][2] for ln in lines), max(ln["bbox"][3] for ln in lines))}


def _join(line: OcrLine, height: float) -> list[tuple[str, tuple[float, float, float, float]]]:
    """(text, box) pieces of a line in the engine's order, with a (" ", gap box) between Latin words."""
    pieces: list[tuple[str, tuple[float, float, float, float]]] = []
    previous = None
    for word in line.words:
        text = word.text.strip()
        if not text:
            continue
        if previous is not None:
            a, b = previous.text.strip()[-1], text[0]
            gap = word.box[0] - previous.box[2]
            if not (_wide(a) or _wide(b)) and (line.spaced or gap > SPACE_GAP * height):
                pieces.append((" ", (previous.box[2], word.box[1], max(previous.box[2], word.box[0]), word.box[3])))
        pieces.append((text, word.box))
        previous = word
    return pieces


def _extent(line: OcrLine) -> tuple[float, float, float, float]:
    """A line's box with its top and bottom the medians of its words': an engine can give a word a
    box two rows tall (Tesseract's Japanese model through MuPDF), which the union would take in."""
    return (min(w.box[0] for w in line.words), statistics.median(w.box[1] for w in line.words),
            max(w.box[2] for w in line.words), statistics.median(w.box[3] for w in line.words))


def _type_size(lines: list[OcrLine]) -> float:
    """Type size (pixels) of a paragraph's lines: from the line pitch when it has several lines, else
    from the ink height of its lines."""
    extents = [_extent(line) for line in lines]
    heights = sorted(e[3] - e[1] for e in extents)
    size = statistics.median(heights) / INK_EM
    tops = sorted(e[1] for e in extents)
    steps = [b - a for a, b in zip(tops, tops[1:]) if b - a > .5 * heights[len(heights) // 2]]
    if steps:
        size = min(size, statistics.median(steps) / PITCH_EM)
    return size


def _rows(lines: list[OcrLine]) -> list[OcrLine]:
    """The lines of a region with the parts of one row joined, in the engine's order.

    An engine can split a row (Tesseract's Japanese model often returns the end of a line, or a word
    of it, on its own), and a part may sit a little higher or lower than the rest; the engine's order
    is still the reading order. A line joins the one before it when they overlap in height by more
    than half a usual line.
    """
    lines = [line for line in lines if any(w.text.strip() for w in line.words)]
    if not lines:
        return []
    height = statistics.median(e[3] - e[1] for e in map(_extent, lines))
    rows: list[OcrLine] = []
    for line in lines:
        if rows:
            _, a0, _, a1 = _extent(rows[-1])
            _, b0, _, b1 = _extent(line)
            if min(a1, b1) - max(a0, b0) > .5 * height:
                rows[-1] = OcrLine(rows[-1].words + line.words, rows[-1].spaced and line.spaced)
                continue
        rows.append(line)
    return rows


def _item(lines: list[OcrLine], layout: PageLayout, scale: float, number: int) -> dict | None:
    """A rawdict text block from OCR lines (pixels of layout.image) in page coordinates."""
    lines = _rows(lines)
    if not lines:
        return None
    size = _type_size(lines)
    out_lines = []
    for line in lines:
        x0, y0, x1, y1 = _extent(line)
        # Move the line to where its middle lies on the page (the scan was turned straight).
        mx, my = layout.unrotate((x0 + x1) / 2, (y0 + y1) / 2)
        dx, dy = mx - (x0 + x1) / 2, my - (y0 + y1) / 2
        top, bottom = (y0 + dy) * scale, (y1 + dy) * scale
        chars: list[tuple[str, float, float]] = []
        edge = -math.inf
        for text, box in _join(line, y1 - y0):
            # Characters always move right: an engine's word box can reach over the next word (a
            # Japanese word read with a box to the end of the line), and layout sorts merged lines by x.
            left = max((box[0] + dx) * scale, edge)
            right = max((box[2] + dx) * scale, left + .1 * len(text))
            edge = right
            step = (right - left) / len(text)
            chars += [(c, left + i * step, left + (i + 1) * step) for i, c in enumerate(text)]
        out_line = _text_line(top, bottom, size * scale, chars)
        if out_line is not None:
            out_lines.append(out_line)
    if not out_lines:
        return None
    return _block(out_lines, number)


def _page_rect(box, layout: PageLayout, scale: float) -> fitz.Rect:
    """The page area (points) a region of the straightened image came from: its turned corners."""
    x0, y0, x1, y1 = box
    corners = [layout.unrotate(x, y) for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    return fitz.Rect(min(p[0] for p in corners) * scale, min(p[1] for p in corners) * scale,
                     max(p[0] for p in corners) * scale, max(p[1] for p in corners) * scale)


def _offset(lines: list[OcrLine], x: float, y: float) -> list[OcrLine]:
    return [OcrLine(tuple(OcrWord((w.box[0] + x, w.box[1] + y, w.box[2] + x, w.box[3] + y), w.text)
                          for w in line.words), line.spaced) for line in lines]


def _cjk_share(lines: list[OcrLine]) -> tuple[int, float]:
    text = "".join(w.text for line in lines for w in line.words)
    chars = [c for c in text if not c.isspace()]
    cjk = len(_CJK.findall(text))
    return cjk, cjk / len(chars) if chars else 0.0


# Lines of the largest text block read to tell Japanese from English.
PROBE_LINES = 4


# Share of Japanese characters in the Japanese reading of the first lines: at or above JA_SURE the page is
# Japanese; below JA_LEAST (JA_LEAST_IN_ENGLISH in a document whose text is English) it is English. The
# Japanese recognizers turn English into kana and kanji: Windows' read the first page of an English scan
# (ResNet) with 36% of them, while Japanese papers read with 85-90%. In between, an English reading decides.
JA_SURE = .6
JA_LEAST = .45
JA_LEAST_IN_ENGLISH = .6
# Share of an English reading in Latin words of three letters or more above which the lines are English:
# English papers read 0.8-0.9, Japanese text read by the English model 0.55 (letter salad).
EN_WORDS = .7


def _latin_word_share(lines: list[OcrLine]) -> float:
    text = " ".join(w.text for line in lines for w in line.words)
    chars = sum(not c.isspace() for c in text)
    return sum(len(word) for word in _LATIN_WORD.findall(text)) / chars if chars else 0.0


def _probe_language(layout: PageLayout, engines: EngineSet, document_lang: str | None = None) -> str:
    """"ja" when the first lines of the page's largest text block read as Japanese, else "en".

    The Japanese models read Latin letters too, while the English ones turn Japanese into noise; a
    few lines are enough and keep the cost of the look small. The Japanese recognizers also read an
    English scan as kana and kanji at times, so the share must be high (JA_SURE), all the more in a
    document whose text is English (document_lang "en"); a share in between is settled by reading the
    same lines as English.
    """
    order = engines.order("ja")
    if not layout.blocks or not order:
        return "en"
    box = max((b.box for b in layout.blocks), key=_area)
    sample = (box[0], box[1], box[2], min(box[3], box[1] + int(PROBE_LINES * 1.6 * layout.line_height)))
    crop = layout.image.crop(sample)
    try:
        lines, _ = recognize(crop, "ja", order)
    except OcrError:
        return "en"
    count, share = _cjk_share(lines)
    if count < 5 or share < (JA_LEAST_IN_ENGLISH if document_lang == "en" else JA_LEAST):
        return "en"
    if share >= JA_SURE:
        return "ja"
    english = engines.order("en")
    if not english:
        return "ja"
    try:
        lines, _ = recognize(crop, "en", english)
    except OcrError:
        return "ja"
    return "en" if _latin_word_share(lines) >= EN_WORDS else "ja"


def ocr_page(page: fitz.Page, engines: EngineSet, lang: str | None = None, document_lang: str | None = None) -> OcrPage:
    """Read a page by OCR. lang None: Japanese when a first look at its largest text region finds
    mostly Japanese characters, else English. Raises OcrError when no engine can read the page.

    Renders the page and reads it at once: extract_pdf renders under PDF_LOCK and calls ocr_image
    outside it instead."""
    image, dpi = render_page(page, engines.options.dpi)
    return ocr_image(image, dpi, engines, lang, document_lang)


def _prefetch(layout: PageLayout, engines: EngineSet, lang: str | None) -> tuple[dict, str | None]:
    """The regions an engine reads all at once (recognize_many: the AI, one request a page), by box, and
    the language their text shows when lang was None. Empty when the first engine reads one at a time."""
    order = engines.order(lang or "en")
    many = getattr(order[0], "recognize_many", None) if order else None
    if many is None:
        return {}, lang
    boxes = [block.box for block in layout.blocks]
    boxes += [region.box for region in layout.regions if region.kind == "math" and region.uncertain]
    if not boxes:
        return {}, lang
    found = many([layout.image.crop(box) for box in boxes], lang)
    read = {tuple(box): (lines, order[0].name) for box, lines in zip(boxes, found)}
    if lang is None:
        count, share = _cjk_share([line for lines, _ in read.values() for line in lines])
        lang = "ja" if count >= 5 and share >= .3 else "en"
    return read, lang


def ocr_image(image: Image.Image, dpi: int, engines: EngineSet, lang: str | None = None,
              document_lang: str | None = None) -> OcrPage:
    """Read a rendered page (render_page) by OCR: ocr_page without MuPDF, apart from Tesseract, which
    takes PDF_LOCK itself (EngineSet.lock) for each region. engines.cancel stops it between regions.
    lang None: found by a first look at the page (_probe_language), strict when document_lang, the
    language of the document's text layer, is English."""
    start = time.perf_counter()
    layout = segment_page(image, dpi)
    del image
    scale = 72 / dpi
    used: set[str] = set()
    engines.check()
    prefetched, lang = _prefetch(layout, engines, lang)

    def read_box(box, language: str) -> tuple[list[OcrLine], str]:
        engines.check()
        if tuple(box) in prefetched:
            return prefetched[tuple(box)]
        order = engines.order(language)
        if not order:
            raise OcrError(f"{language} を読める OCR エンジンがありません（言語データが未取得）。")
        return recognize(layout.image.crop(box), language, order)

    def read_block(index: int, language: str) -> list[OcrLine]:
        box = layout.blocks[index].box
        lines, name = read_box(box, language)
        used.add(name)
        return _offset(lines, box[0], box[1])

    if lang is None:
        lang = _probe_language(layout, engines, document_lang)
    read = [read_block(index, lang) for index in range(len(layout.blocks))]

    # Each line goes to the text region holding its middle (else the nearest region of its block).
    by_region: dict[int, list[OcrLine]] = {}
    for index, block in enumerate(layout.blocks):
        for line in read[index]:
            x0, y0, x1, y1 = _extent(line)
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            members = block.members
            target = next((m for m in members if _contains(layout.regions[m].box, cx, cy)), None)
            if target is None:
                target = min(members, key=lambda m: _distance(layout.regions[m].box, cx, cy))
            by_region.setdefault(target, []).append(line)

    items, formulas, figures = [], [], []
    for index, region in enumerate(layout.regions):
        if region.kind == "figure":
            figures.append(_page_rect(region.box, layout, scale))
            continue
        lines = by_region.get(index, [])
        if region.kind == "math":
            if region.uncertain:
                try:
                    found, name = read_box(region.box, lang)
                except OcrError:
                    found, name = [], ""
                text = " ".join(w.text for line in found for w in line.words)
                if found and prose_text(text, lang):
                    used.add(name)
                    lines = _offset(found, region.box[0], region.box[1])
                else:
                    formulas.append(_page_rect(region.box, layout, scale))
                    continue
            else:
                formulas.append(_page_rect(region.box, layout, scale))
                continue
        text = " ".join(w.text for line in lines for w in line.words)
        if lines and letter_share(text) < TEXT_LETTER_SHARE:
            formulas.append(_page_rect(region.box, layout, scale))
            continue
        item = _item(lines, layout, scale, len(items))
        if item is not None:
            items.append(item)
    return OcrPage(items, formulas, figures, "+".join(sorted(used)), lang, layout.angle,
                   time.perf_counter() - start, used)


def _area(box) -> int:
    return (box[2] - box[0]) * (box[3] - box[1])


def _contains(box, x: float, y: float) -> bool:
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def _distance(box, x: float, y: float) -> float:
    dx = max(box[0] - x, 0, x - box[2])
    dy = max(box[1] - y, 0, y - box[3])
    return math.hypot(dx, dy)


def _box(rect: fitz.Rect) -> list[float]:
    return [rect.x0, rect.y0, rect.x1, rect.y1]


def ocr_page_blocks(result: OcrPage, number: int, page_height: float) -> list[dict]:
    """The layout blocks of a page read by OCR, as extract_pdf makes them for other pages."""
    blocks: list[dict] = []
    # Numbered on like extract_pdf's block_seq: the merges below drop numbers, so counting the blocks
    # left would give a formula the id of a text block.
    seq = 1
    for item in result.items:
        new_blocks = layout_blocks(item, number, seq)
        seq += len(new_blocks)
        blocks.extend(new_blocks)
    blocks = merge_overlapping_prose(blocks)
    blocks = merge_continued_prose(blocks)
    # The skew slants each line across its box: widen the box by the height that adds.
    slope = abs(math.sin(math.radians(result.angle)))
    if slope:
        for block in blocks:
            rect = fitz.Rect(block["bbox"])
            for region in block.get("regions") or []:
                r = fitz.Rect(region)
                rise = r.width / 2 * slope
                rect |= fitz.Rect(r.x0, r.y0 - rise, r.x1, r.y1 + rise)
            block["bbox"] = _box(rect)
    body = statistics.median([b["font_size"] for b in blocks]) if blocks else 10.0
    for rect in result.formulas:
        blocks.append({"id": f"p{number}b{seq}", "page": number, "kind": "formula", "bbox": _box(rect),
                       "regions": [_box(rect)], "text": "", "translation_text": "", "formulas": [],
                       "font_size": body})
        seq += 1
    for index, rect in enumerate(result.figures):
        blocks.append({"id": f"p{number}f{index + 1}", "page": number, "kind": "figure", "bbox": _box(rect),
                       "regions": [_box(rect)], "text": "", "translation_text": "", "formulas": [],
                       "font_size": body})
    blocks = merge_wrapped_headings(blocks, {number: page_height})
    blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
    for block in blocks:
        block["ocr"] = True
    return blocks


__all__ = ["OcrOptions", "OcrPage", "document_language", "ocr_image", "ocr_page", "ocr_page_blocks", "prose_text",
           "render_page"]
