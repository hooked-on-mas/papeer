"""Pages whose text layer cannot be translated: garbled extraction or a scanned image.

Without a usable ToUnicode map MuPDF returns what the font gives it: U+FFFD, raw
glyph IDs (a subset font's glyphs 1, 2, 3... become control characters) or
private-use codes. Such a page is kept as the original ("要OCR") instead of being
sent to the translator. OCR itself is not implemented.

Math is the false-positive risk. Symbol and math fonts legitimately use the
private-use area (Symbol's U+F0xx, MT Extra, STIX's math faces), and old dvips Type3
math fonts extract as control characters (CMSY's minus is code 0). Named math and
symbol fonts are ignored, and characters in math context (a font annotate_math_fonts
recognized as math, or a detected formula) do not count, unless several garbled
characters in a row of a long span show a garbled word.
"""
from __future__ import annotations

import re
import unicodedata

import pymupdf as fitz

from papeer.layout.math_layout import _MATH_FONT, MATH_TOKEN

# Share of garbled prose above which the page needs OCR. Garbling follows the font,
# so a garbled page is usually garbled in 80-100% of its body text, while a readable
# page stays in the low percents: ligatures of Type3 TeX fonts (fi = code 12) mark a
# few words, and the symbols of math-heavy pages are not counted (see tests/test_ocr_pages.py).
GARBLED_RATIO = 0.5
# Between this share and GARBLED_RATIO the page is partly garbled: it is listed for review,
# its garbled paragraphs are kept as the original and the rest is translated. Readable
# pages of 11 papers (about 380 pages) measured at most 0.003 without their margins; one
# paper's download stamp, garbled in the bottom margin of every page, reached 0.064.
PARTIAL_RATIO = 0.2
# Consecutive garbled characters in one span (adjacent spans of one font joined) counted
# as a garbled word even in math context, when the span is at least TEXT_SPAN characters
# long: a garbled text font fills whole lines, while dvips math fonts give short spans
# (a Greek run such as "\x0b\x0c\x0d").
GARBLED_RUN = 3
TEXT_SPAN = 10
# A paragraph with fewer garbled characters (an icon font's glyphs, a stray symbol) is kept
# as the original without listing its page, like a garbled stamp in the margins.
LISTED_GARBLED_CHARS = 10
# OT1 ligatures of Type3 TeX fonts without glyph names: ff, fi, fl, ffi, ffl. A word whose
# only garbled characters are these, next to letters ("e\x0ecient"), is a readable word.
_LIGATURES = frozenset("\x0b\x0c\x0d\x0e\x0f")
# Fewer prose characters give no reliable ratio (a page number, a page of formulas).
MIN_CHARS = 50
# A page with almost no text whose images cover most of it is a scan. Text in the top
# and bottom margins (running headers, a download stamp on each page) is not counted,
# neither here nor in the garbled share.
IMAGE_COVERAGE = 0.5
IMAGE_PAGE_TEXT = 50
IMAGE_PAGE_MARGIN = 0.1
# Fonts whose private-use and control codes are symbols, not garbling (in addition to
# math_layout's math fonts): Word's MT Extra and Wingdings, the math parts of STIX (its
# text face STIXGeneral is prose), and the TeX symbol fonts (esint, wasy, stmary,
# txfonts/pxfonts, Fraktur, blackboard bold).
_SYMBOL_FONT = re.compile(
    r"MT ?Extra|STIX(?:Math|Size|NonUnicode|Integrals|Variants)|XITSMath|Euclid|Wingding|Webding|Dingbat|Marlett"
    r"|esint|wasy|stmary"
    r"|[tp]x(?:sy|ex|mi)|eufm|eusm|bbold|dsrom|MnSymbol|Fourier|Mathematica", re.I)


def _symbol_font(name: str) -> bool:
    return bool(_MATH_FONT.search(name) or _SYMBOL_FONT.search(name))


def _separator(c: str) -> bool:
    return c in "\t\n\r" or unicodedata.category(c) in ("Zs", "Zl", "Zp")


def _garbled(c: str) -> bool:
    # Control characters other than tabs and line breaks, private use, lone surrogates.
    return c == "\ufffd" or unicodedata.category(c) in ("Cc", "Co", "Cs")


def _wide(c: str) -> bool:
    return unicodedata.east_asian_width(c) in ("W", "F")


def _garbled_word(word: str) -> bool:
    wrong = {c for c in word if _garbled(c)}
    return bool(wrong) and not (wrong <= _LIGATURES and any(c.isascii() and c.isalpha() for c in word))


Box = tuple[float, float, float, float]


def _formula_regions(blocks: list[dict]) -> list[Box]:
    regions = []
    for block in blocks:
        if block.get("kind") == "formula":
            regions.extend(block.get("regions") or [block["bbox"]])
        regions.extend(f["bbox"] for f in block.get("formulas", []))
    return [tuple(fitz.Rect(r)) for r in regions]  # pyright: ignore[reportArgumentType]


def _line_chars(line: dict, regions: list[Box]) -> list[tuple[str, bool] | None]:
    """(character, math context) per character of a line; None separates words."""
    # Only the formulas meeting this line can contain its characters: comparing every
    # character with every formula of the page made math-heavy papers several times slower.
    if regions and "bbox" in line:
        x0, y0, x1, y1 = line["bbox"]
        regions = [r for r in regions if r[0] <= x1 and r[2] >= x0 and r[1] <= y1 and r[3] >= y0]
    # Adjacent spans of one font are one: a PDF drawing each glyph in its own BT..ET gives
    # MuPDF spans of a character or two. dvips math still alternates CMMI and CMSY spans.
    spans: list[dict] = []
    for span in line["spans"]:
        if spans and spans[-1]["font"] == span["font"] and spans[-1].get("math_font") == span.get("math_font"):
            spans[-1] = dict(spans[-1], chars=spans[-1]["chars"] + span["chars"])
        else:
            spans.append(span)
    result: list[tuple[str, bool] | None] = []
    for span in spans:
        if _symbol_font(span["font"]):
            result.extend(None for _ in span["chars"])
            continue
        entries: list[tuple[str, bool] | None] = []
        math_font = bool(span.get("math_font"))
        for char in span["chars"]:
            c = char["c"]
            if _separator(c):
                entries.append(None)
                continue
            math = math_font
            if not math and regions:
                b = char["bbox"]
                x, y = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                # The same test as fitz.Point in fitz.Rect (x0 <= x < x1).
                math = any(r[0] <= x < r[2] and r[1] <= y < r[3] for r in regions)
            entries.append((c, math))
        # A run of garbled characters in a long span has the shape of a garbled word, not
        # of a symbol: count it as prose even where the font looks like math (a garbled
        # font has no English words, so annotate_math_fonts takes it for math and layout
        # makes its lines formulas). Runs never cross fonts: dvips math fonts put Greek
        # letters and operators in separate short spans (three spans for alpha-minus-beta).
        if sum(entry is not None for entry in entries) >= TEXT_SPAN:
            index = 0
            while index < len(entries):
                end = index
                while end < len(entries) and (entry := entries[end]) is not None and _garbled(entry[0]):
                    end += 1
                if end - index >= GARBLED_RUN:
                    entries[index:end] = [(entry[0], False) for entry in entries[index:end] if entry]
                index = end + 1
        result.extend(entries)
    return result


def garbled_ratio(items: list[dict], blocks: list[dict]) -> float | None:
    """Share of garbled text on a page, or None when too little text to judge.

    items are the page's rawdict text blocks after annotate_math_fonts; blocks are the
    page's layout blocks, whose formulas mark math context.
    """
    return _measure(items, blocks)


def _measure(items: list[dict], blocks: list[dict], body: tuple[float, float] | None = None) -> float | None:
    """The garbled share of the page's prose.

    body (top, bottom) leaves out the lines in the margins: a garbled download stamp or
    running header on a short page is not a partly garbled page.
    """
    regions = _formula_regions(blocks)
    # Prose is measured by word: a font whose space glyph became a control character
    # garbles whole lines although most of its codes are letters.
    words: list[str] = []
    for item in items:
        for line in item.get("lines", []):
            if body and "bbox" in line and not body[0] <= (line["bbox"][1] + line["bbox"][3]) / 2 <= body[1]:
                continue
            word = ""
            for entry in _line_chars(line, regions):
                if entry is None:
                    if word:
                        words.append(word)
                    word = ""
                    continue
                c, math = entry
                # Math context and CJK characters (no spaces between words) are
                # words of their own, so one symbol never marks a whole line.
                if math or _wide(c):
                    if word:
                        words.append(word)
                    word = ""
                    if not math:
                        words.append(c)
                else:
                    word += c
            if word:
                words.append(word)
    prose = sum(map(len, words))
    # Math context never counts, not even on a page of formulas: dvips math fonts give
    # control characters for Greek letters and operators. A garbled font taken for math
    # is prose through its runs of garbled characters.
    if prose >= MIN_CHARS:
        return sum(len(w) for w in words if _garbled_word(w)) / prose
    return None


def _image_coverage(page: fitz.Page) -> float:
    area = abs(page.rect)
    if not area:
        return 0
    covered = sum(abs(fitz.Rect(info["bbox"]) & page.rect) for info in page.get_image_info())
    return min(1.0, covered / area)


def _words(text: str) -> list[str]:
    r"""Words split as a page is measured: at _separator (\s would also split at the OT1
    ligature codes fi and ff and at \x1c-\x1f), each CJK character a word of its own."""
    words, word = [], ""
    for c in text:
        if _separator(c) or _wide(c):
            if word:
                words.append(word)
            word = ""
            if not _separator(c):
                words.append(c)
        else:
            word += c
    if word:
        words.append(word)
    return words


def _garbled_chars(block: dict) -> int:
    """Garbled characters of a text block whose words are mostly garbled, else 0
    (formulas are markers in its translation text)."""
    if block.get("kind", "text") != "text":
        return 0
    words = _words(MATH_TOKEN.sub(" ", block.get("translation_text", block["text"])))
    garbled = [w for w in words if _garbled_word(w)]
    count = sum(sum(map(_garbled, w)) for w in garbled)
    if count < GARBLED_RUN or sum(map(len, garbled)) * 2 < sum(map(len, words)):
        return 0
    return count


def garbled_block(block: dict) -> bool:
    """A text block whose words are mostly garbled."""
    return _garbled_chars(block) > 0


def ocr_check(page: fitz.Page, items: list[dict], blocks: list[dict]) -> dict | None:
    """Why the page needs OCR, or None; marks the blocks kept as the original ("needs_ocr").

    "garbled" and "image" keep the whole page; "partial" keeps only its garbled
    paragraphs, and the rest of the page is translated.
    """
    top, bottom = page.cropbox.height * IMAGE_PAGE_MARGIN, page.cropbox.height * (1 - IMAGE_PAGE_MARGIN)
    body_text = sum(1 for item in items for line in item.get("lines", []) for span in line["spans"]
                    for char in span["chars"]
                    if not char["c"].isspace() and top <= (char["bbox"][1] + char["bbox"][3]) / 2 <= bottom)
    result, ratio = None, None
    # A full-page figure has a caption; a scan has no text at all (or a few stray glyphs).
    if body_text < IMAGE_PAGE_TEXT and _image_coverage(page) >= IMAGE_COVERAGE:
        result = {"reason": "image"}
    else:
        ratio = _measure(items, blocks, (top, bottom))
        if ratio is not None and ratio >= GARBLED_RATIO:
            result = {"reason": "garbled", "garbled_ratio": round(ratio, 3)}
    if result:
        for block in blocks:
            block["needs_ocr"] = True
        return result
    listed = 0
    for block in blocks:
        if count := _garbled_chars(block):
            block["needs_ocr"] = True
            # A garbled download stamp or running header in the margins, or a few icon
            # glyphs, is kept as the original without listing the page.
            listed += (count >= LISTED_GARBLED_CHARS
                       and top <= (block["bbox"][1] + block["bbox"][3]) / 2 <= bottom)
    if listed or (ratio is not None and ratio >= PARTIAL_RATIO):
        # Without a garbled paragraph the garbled text is in formulas, tables or mostly
        # readable paragraphs, which the review asks to compare with the original.
        return {"reason": "partial", **({"garbled_ratio": round(ratio, 3)} if ratio is not None else {}),
                "garbled_paragraphs": listed}
    return None


def ocr_markdown_note(document: dict) -> list[str]:
    """Lines under the title of translation.md naming the pages left untranslated for OCR."""
    whole = [e["page"] for e in document.get("ocr_pages", []) if e.get("reason") != "partial"]
    partial = [e["page"] for e in document.get("ocr_pages", [])
               if e.get("reason") == "partial" and e.get("garbled_paragraphs", 1)]
    lines = []
    if whole:
        lines += ["要OCRのため未翻訳のページ（文字化け・画像だけ）: " + ", ".join(f"p.{n}" for n in whole), ""]
    if partial:
        lines += ["文字化けした段落を要OCRのため未翻訳にしたページ: " + ", ".join(f"p.{n}" for n in partial), ""]
    return lines


def needs_ocr_message(document: dict) -> str | None:
    """Why a paper without translatable text cannot be translated, when pages need OCR."""
    if any(e.get("reason") != "partial" for e in document.get("ocr_pages", [])):
        return "文字化けや画像だけのページ（要OCR）のため、翻訳できる文字が見つかりませんでした。OCR済みのPDFを追加してください。"
    return None
