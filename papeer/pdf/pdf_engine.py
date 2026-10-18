from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field, replace
import logging
from pathlib import Path
import re
import threading
from io import BytesIO
from typing import Callable

import pymupdf as fitz

from papeer.layout.math_layout import LAYOUT_VERSION, MATH_TOKEN, annotate_math_fonts, formula_only_block, layout_blocks, merge_inline_items, merge_overlapping_prose, merge_continued_prose
from papeer.core.bibliography import extract_bibliography
from papeer.core.fileio import atomic_output
from papeer.layout.reference_layout import mark_references
from papeer.pdf.pdf_math_crops import formula_crop, page_glyph_bounds, tighten_type3_geometry
from papeer.layout.table_layout import separate_tables, table_regions
from papeer.layout.figure_layout import diagram_regions, figure_regions, restore_plot_labels, raster_crosses_prose
from papeer.layout.algorithm_layout import separate_algorithms, unruled_algorithm_steps
from papeer.layout.ocr_engines import EngineSet, OcrError, OcrOptions
from papeer.providers.common import Cancelled
from papeer.layout.ocr_pages import ocr_check
from papeer.layout.reading_flow import (order_page, continuation_groups, footnote_ids, translation_blocks, materialize_flows,
                                        resolve_unit_joins, source_body_size)
from papeer.pdf.pdf_ocr import OcrPage, document_language, ocr_image, ocr_page_blocks, render_page
from papeer.translation.translation_context import paper_title, request_text
from papeer.pdf.pdf_typography import (FONT_CSS, LIGHT_TEXT_COLOR, TEXT_COLOR, TIGHT_LEADING, TextStyle, body_font_size,
                                       character_budget, first_line_indented, font_subsets, merge_wrapped_headings,
                                       readable_size, reading_space, running_headers, searchable_text, text_html,
                                       text_style)


logger = logging.getLogger(__name__)

# MuPDF must not be called concurrently from the UI and background jobs.
PDF_LOCK = threading.RLock()


@dataclass
class OcrRun:
    """How extract_pdf reads the pages that need OCR, and what it tells back.

    engines None reads nothing: only the readings the paper kept (saved, ocr-text.json by page number)
    are used, as when Library.document() extracts again for a new LAYOUT_VERSION inside a request.
    pages: the pages to read now, again if they were read before; None reads every page needing OCR
    that has no saved reading. progress(page, done, total) is called before each page is read.
    """
    engines: EngineSet | None = None
    pages: set[int] | None = None
    saved: dict[str, dict] = field(default_factory=dict)
    progress: Callable[[int, int, int], None] | None = None
    # A failure other than OcrError (the AI connection's: its plan, its sign-in) stops the extraction as it
    # is, for the job to report, instead of leaving the page 要OCR.
    strict: bool = False
    # Out: the readings of every page whose blocks come from OCR now (read now or saved), by page
    # number, to keep with the paper; the pages read now; and why each page to be read now could not be.
    readings: dict[str, dict] = field(default_factory=dict)
    read_now: list[int] = field(default_factory=list)
    errors: dict[int, str] = field(default_factory=dict)


def _ocr_blocks(result: OcrPage, number: int, height: float) -> list[dict] | None:
    blocks = ocr_page_blocks(result, number, height)
    return blocks if any(b.get("kind") == "text" for b in blocks) else None


def _read_by_ocr(document: fitz.Document, number: int, engines: EngineSet, lang: str | None,
                 document_lang: str | None = None, strict: bool = False) -> tuple[list[dict], OcrPage] | str:
    """The blocks of a page read by OCR and the reading, or why no engine could read it (the page stays
    "要OCR"). Only rendering the page holds PDF_LOCK: cutting it into regions and reading them (Windows
    OCR, Vision, the AI) run beside other MuPDF work; Tesseract takes the lock for each region."""
    try:
        with PDF_LOCK:
            page = document[number - 1]
            height = page.cropbox.height
            image, dpi = render_page(page, engines.options.dpi)
            # Let go of the page while still holding the lock: MuPDF frees it, which must not happen
            # beside other MuPDF work.
            del page
        read = ocr_image(image, dpi, engines, lang, document_lang)
        # Built from the reading as the paper keeps it (rounded), so that extracting again from
        # ocr-text.json gives the very same blocks.
        result = OcrPage.from_record(read.to_record())
        if result is None:
            return "OCR の結果を記録できませんでした。"
        result.seconds = read.seconds
        blocks = _ocr_blocks(result, number, height)
    except Cancelled:
        raise
    except OcrError as error:
        logger.warning("OCR of page %d failed: %s", number, error)
        return str(error)
    except Exception as error:  # noqa: BLE001 - a fault in OCR must not stop the paper from being added
        if strict:
            raise
        logger.warning("OCR of page %d failed", number, exc_info=True)
        return f"OCR で読めませんでした: {type(error).__name__}: {error}"
    logger.info("OCR of page %d: %s in %.2f s", number, result.summary(), result.seconds)
    if blocks is None:
        return "ページに文字が見つかりませんでした。"
    return blocks, result


def _saved_blocks(record: dict | None, number: int, height: float) -> tuple[list[dict], OcrPage] | None:
    """The blocks of a page from the reading the paper kept, or None when there is none it can use."""
    result = OcrPage.from_record(record)
    if result is None:
        return None
    try:
        blocks = _ocr_blocks(result, number, height)
    except Exception:  # noqa: BLE001 - a damaged reading is read again or left 要OCR, never fatal
        logger.warning("The saved OCR reading of page %d could not be used", number, exc_info=True)
        return None
    return (blocks, result) if blocks is not None else None


def extract_pdf(path: Path, ocr: OcrOptions | None = None, run: OcrRun | None = None) -> dict:
    """The document's text blocks, pages and bibliography (document.json).

    Pages that need OCR are kept as the original ("ocr_pages"), unless their text comes from OCR:
    read now (run.engines; without a run, ocr: by default OcrOptions.from_env(), off unless
    PAPEER_OCR=1) or from the reading the paper kept (run.saved). Such a page is listed in
    "ocr_applied" instead. Pages are read once every page has been looked at, so that the language
    (OcrOptions.lang "auto") comes from the text of the pages that need no OCR; with too little of
    it, from a first look at each page. PDF_LOCK is let go while a page is read (_read_by_ocr).
    A cancelled run (run.engines.cancel) raises Cancelled.
    """
    if run is None:
        ocr = OcrOptions.from_env() if ocr is None else ocr
        run = OcrRun(EngineSet(ocr, PDF_LOCK) if ocr.enabled else None)
    engines = run.engines
    ocr_applied: list[dict] = []
    with PDF_LOCK:
        document = fitz.open(path)
    try:
        with PDF_LOCK:
            if document.needs_pass:
                raise ValueError("パスワード付きPDFです。解除したコピーを追加してください。")
            if not document.page_count:
                raise ValueError("PDFにページがありません。")
            page_lists, pages, empty_pages, needing = _text_pages(document)
        read_pages: set[int] = set()
        readable = [(number, needed) for number, needed in needing if needed["reason"] != "partial"]
        to_read = [number for number, _ in readable if engines is not None and (
            number + 1 in run.pages if run.pages is not None else str(number + 1) not in run.saved)]
        lang: str | None = None
        document_lang: str | None = None
        if to_read and engines is not None:
            flagged = {number for number, _ in needing}
            ocr = engines.options
            lang = (ocr.lang if ocr.lang != "auto"
                    else document_language(info["text"] for index, info in enumerate(pages) if index not in flagged))
            # An English paper can hold a scanned Japanese page (an appendix, a letter): read as English it
            # becomes noise. When Japanese can be read, each page gets a first look at its opening lines
            # (pdf_ocr._probe_language: a few lines, some 0.1-0.5 s). Japanese models read Latin letters,
            # so a Japanese document keeps its language.
            if ocr.lang == "auto" and lang == "en" and engines.order("ja"):
                lang, document_lang = None, "en"
        for number, needed in readable:
            height = pages[number]["height"]
            read: tuple[list[dict], OcrPage] | str | None = None
            if number in to_read and engines is not None:
                engines.check()
                if run.progress:
                    run.progress(number + 1, to_read.index(number) + 1, len(to_read))
                read = _read_by_ocr(document, number + 1, engines, lang, document_lang, run.strict)
                if isinstance(read, str):
                    run.errors[number + 1] = read
                    # A page read before and not now keeps its earlier reading.
                    read = _saved_blocks(run.saved.get(str(number + 1)), number + 1, height)
                else:
                    run.read_now.append(number + 1)
            else:
                read = _saved_blocks(run.saved.get(str(number + 1)), number + 1, height)
            if read is None or isinstance(read, str):
                continue
            page_lists[number], result = read
            run.readings[str(number + 1)] = result.to_record()
            pages[number]["text"] = "\n\n".join(b["text"] for b in page_lists[number])
            ocr_applied.append({"page": number + 1, "reason": needed["reason"], **result.summary()})
            read_pages.add(number)
            if number + 1 in empty_pages:
                empty_pages.remove(number + 1)
        with PDF_LOCK:
            ocr_pages = [{"page": number + 1, **needed} for number, needed in needing if number not in read_pages]
            blocks = [block for page_blocks in page_lists for block in page_blocks]
            title = (document.metadata or {}).get("title", "").strip()
            result = {**extract_bibliography(document), "layout_version": LAYOUT_VERSION, "title": title, "pages": pages,
                      "blocks": blocks, "empty_pages": empty_pages, "ocr_pages": ocr_pages, "page_count": len(pages)}
    finally:
        with PDF_LOCK:
            document.close()
    if ocr_applied:
        result["ocr_applied"] = ocr_applied
    ordered = []
    headers = running_headers(result)
    for info in pages:
        page_blocks, info['reading_order'] = order_page(
            [b for b in headers if b['page'] == info['number']], info['width'], info['height'])
        ordered.extend(page_blocks)
        info['text'] = '\n\n'.join(b['text'] for b in page_blocks)
    result['blocks'] = ordered
    result['extracted_title'] = paper_title(result)
    result['title'] = result['extracted_title'] or path.stem
    mark_references(result)
    result['continuations'], result['continuation_decisions'] = continuation_groups(result)
    return result


def _text_pages(document: fitz.Document) -> tuple[list[list[dict]], list[dict], list[int], list[tuple[int, dict]]]:
    """The blocks of each page from its text layer, the pages, the empty ones, and those needing OCR
    (page index, ocr_check's finding). The caller holds PDF_LOCK."""
    page_lists: list[list[dict]] = []
    pages, empty_pages, needing = [], [], []
    for number, page in enumerate(document):
        page_blocks = []
        block_seq = 1
        items = page.get_text("rawdict", sort=True, flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]
        annotate_math_fonts(items)
        tighten_type3_geometry(page, items)
        page_items = items
        items, algorithms, algorithm_regions = separate_algorithms(page, items)
        items = unruled_algorithm_steps(items)
        figures = figure_regions(page)
        tables = [r for r in table_regions(page) if not any(r.intersects(f) for f in figures + algorithm_regions)]
        figures += diagram_regions(page, figures + tables + algorithm_regions, embedded=figures)
        # A multi-part diagram owns embedded photos and their labels as one
        # region; nested boxes must not split it back into fragments.
        figures = [r for r in figures if not any(r != other and r in other for other in figures)]
        items, tables = separate_tables(items, tables, number + 1)
        items, figures = separate_tables(items, figures, number + 1, kind="figure")
        items = merge_inline_items(items)
        for item in items:
            if item.get("type") != 0:
                continue
            new_blocks = layout_blocks(item, number + 1, block_seq)
            block_seq += len(new_blocks)
            page_blocks.extend(new_blocks)
        page_blocks = merge_overlapping_prose(page_blocks)
        page_blocks = merge_continued_prose(page_blocks)
        for item in algorithms:
            new_blocks = layout_blocks(item, number + 1, block_seq)
            block_seq += len(new_blocks)
            page_blocks.extend(new_blocks)
        page_blocks.extend(tables + figures)
        page_blocks = merge_wrapped_headings(page_blocks, {number + 1: page.cropbox.height})
        if tables or figures or algorithms:
            page_blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
        if not page_blocks:
            empty_pages.append(number + 1)
        # A garbled or scanned page (or paragraph) keeps its original and is listed for review.
        if needed := ocr_check(page, page_items, page_blocks):
            needing.append((number, needed))
        page_lists.append(page_blocks)
        pages.append({"number": number + 1, "text": "\n\n".join(b["text"] for b in page_blocks),
                      "width": page.cropbox.width, "height": page.cropbox.height,
                      "rotation": page.rotation})
    return page_lists, pages, empty_pages, needing


# Longest source text sent as one translation unit; longer blocks are split (tests lower it).
UNIT_LIMIT = 6500
# ". " followed by a capital: a sentence end unless the word before the period is an
# abbreviation. A decimal ("3.5") has no space after the point. Group 1 is the word before
# the mark, matched from its start so that checking it stays linear in the block length.
_SENTENCE_MARK = r"""(\S*?)[.!?]["'”’)\]]*(\s+)(?=["“‘(\[]?[A-Z])"""
_SENTENCE_END = re.compile(r"(?<!\S)" + _SENTENCE_MARK)
# A unit that starts inside a word (after a cut at a math marker): the rest of that word.
_SENTENCE_END_AT = re.compile(_SENTENCE_MARK)
_ABBREVIATIONS = {
    "al", "app", "approx", "art", "ca", "cf", "ch", "chap", "co", "col", "cor", "corp", "def", "dept",
    "dr", "ed", "eds", "eq", "eqs", "est", "etc", "ex", "fig", "figs", "inc", "jr", "lem", "ltd",
    "mr", "mrs", "ms", "no", "nos", "p", "pp", "prof", "prop", "ref", "refs", "resp", "sec", "secs",
    "sect", "sr", "st", "sup", "suppl", "tab", "thm", "viz", "vol", "vols", "vs"}


def _sentence_end(text: str, match: re.Match) -> bool:
    if text[match.end(1)] != ".":
        return True
    word = match[1]
    if match.start(1) and not text[match.start(1) - 1].isspace():
        word = re.search(r"\S*$", text[:match.end(1)])[0]
    word = word.lstrip("([{\"'“‘")
    # "e.g.", "i.e.", "U.S." and initials ("J. Smith") are not sentence ends.
    if "." in word or re.fullmatch(r"[A-Z]", word):
        return False
    return word.casefold() not in _ABBREVIATIONS


def _unit_end(text: str, start: int, limit: int) -> int:
    """End of the unit starting at start: the last sentence end within the limit, else the
    last space, else the limit itself (never inside a math marker)."""
    end = start + limit
    if end >= len(text):
        return len(text)
    matches = list(_SENTENCE_END.finditer(text, start, end + 1))
    if start and not text[start - 1].isspace() and (first := _SENTENCE_END_AT.match(text, start, end + 1)):
        matches.insert(0, first)
    sentences = [m.end() for m in matches if start < m.end() <= end and _sentence_end(text, m)]
    if sentences:
        return sentences[-1]
    spaces = [m.end() for m in re.finditer(r"\s+", text[start:end])]
    if spaces:
        return start + spaces[-1]
    for token in MATH_TOKEN.finditer(text, start):
        if token.start() >= end:
            break
        if token.start() < end < token.end():
            return token.start() if token.start() > start else token.end()
    return end


def translation_units(document: dict, limit: int | None = None) -> list[dict]:
    limit = UNIT_LIMIT if limit is None else limit
    if limit <= 0:
        raise ValueError("翻訳単位の文字数上限は正の数にしてください。")
    units = []
    for block in translation_blocks(document):
        if (block.get("kind") in {"formula", "table", "reference", "figure", "algorithm"} or block.get("needs_ocr")
                or formula_only_block(block)):
            continue
        text = block.get("translation_text", block["text"])
        # Pure page numbers and symbol-only blocks are retained verbatim.
        if re.fullmatch(r"\(\d+[a-z]?\)", text.strip()) or not re.search(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff]", text):
            continue
        start, index = 0, 0
        while start < len(text):
            end = _unit_end(text, start, limit)
            units.append({"id": f"{block['id']}_{index}", "block": block["id"],
                          "page": block["page"], "text": text[start:end],
                          **({k: block[k] for k in ("flow_pages", "flow_blocks")} if "flow_pages" in block else {})})
            start, index = end, index + 1
    return units


def batches(units: list[dict], limit: int = 9000, size: Callable[[list[dict]], int] | None = None):
    """Split `units` into requests of at most `limit` characters, a unit larger than that alone.

    `size` measures a request; by default the data of a translation request as sent (request_text),
    so that the context and glossary a request leaves out make room for more text.
    """
    measure = size or (lambda batch: len(request_text(batch)))
    batch: list[dict] = []
    for unit in units:
        if batch and measure(batch + [unit]) > limit:
            yield batch
            batch = []
        batch.append(unit)
    if batch:
        yield batch


def _reading_order(images: list[dict]) -> list[dict]:
    """Images placed by insert_htmlbox, line by line and left to right."""
    lines: list[list[dict]] = []
    for image in sorted(images, key=lambda img: (img['bbox'][1] + img['bbox'][3]) / 2):
        middle = (image['bbox'][1] + image['bbox'][3]) / 2
        # Same line when its middle falls within the line's first image.
        if lines and lines[-1][0]['bbox'][1] <= middle <= lines[-1][0]['bbox'][3]:
            lines[-1].append(image)
        else:
            lines.append([image])
    return [image for line in lines for image in sorted(line, key=lambda img: img['bbox'][0])]


def _space_without_formulas(rect: fitz.Rect, formulas: list[fitz.Rect]) -> fitz.Rect:
    """Find space for prose when a publisher's text box overlaps display math."""
    candidates = [rect]
    for formula in formulas:
        available = []
        for candidate in candidates:
            cut = candidate & formula
            if cut.is_empty:
                available.append(candidate)
                continue
            pieces = [fitz.Rect(candidate.x0, candidate.y0, cut.x0, candidate.y1),
                      fitz.Rect(cut.x1, candidate.y0, candidate.x1, candidate.y1),
                      fitz.Rect(candidate.x0, candidate.y0, candidate.x1, cut.y0),
                      fitz.Rect(candidate.x0, cut.y1, candidate.x1, candidate.y1)]
            available.extend(piece for piece in pieces if piece.width > 4 and piece.height > 4)
        candidates = available
    if not candidates:
        raise ValueError("本文と数式・表の領域を分離できませんでした。未完成のPDFは保存していません。")
    return max(candidates, key=lambda candidate: candidate.get_area())


class _Background:
    """Color under the source text, sampled from a low-resolution image of the original page.

    A translated block is painted over (to hide its glyphs and the vector parts of inline math)
    with the most frequent color just around it: the paper, a shaded box or a colored panel.
    Where no color prevails (a gradient, a photo) the average around the block is closer than
    any single shade or white. The page is rendered only when a block on it needs the color.
    """

    ZOOM = 1  # pixels per point
    MARGIN = 3  # width of the sampled ring around the block, in points
    PREVAILING = .3  # share of the ring the most frequent color needs to be used as is

    def __init__(self, page: fitz.Page):
        self.page = page
        self.pixmap: fitz.Pixmap | None = None
        self.samples = b""

    def color(self, rect: fitz.Rect) -> tuple[float, float, float]:
        if self.pixmap is None:
            # Annotations (highlights, notes) are not part of the page the translation replaces.
            self.pixmap = self.page.get_pixmap(matrix=fitz.Matrix(self.ZOOM, self.ZOOM),
                                               colorspace=fitz.csRGB, alpha=False, annots=False)
            self.samples = self.pixmap.samples
        pixmap, zoom, margin = self.pixmap, self.ZOOM, self.MARGIN
        inner = rect * zoom
        outer = fitz.IRect(int((rect.x0 - margin) * zoom), int((rect.y0 - margin) * zoom),
                           int((rect.x1 + margin) * zoom + 1), int((rect.y1 + margin) * zoom + 1))
        outer &= fitz.IRect(0, 0, pixmap.width, pixmap.height)
        counts: Counter[bytes] = Counter()
        stride, n, samples = pixmap.stride, pixmap.n, self.samples
        # Pixels are taken by their centers; beside the block only the left and right parts count.
        beside = [x for x in range(outer.x0, outer.x1) if not inner.x0 <= x + .5 <= inner.x1]
        for y in range(outer.y0, outer.y1):
            row = y * stride
            for x in beside if inner.y0 <= y + .5 <= inner.y1 else range(outer.x0, outer.x1):
                offset = row + x * n
                counts[samples[offset:offset + 3]] += 1
        if not counts:
            return (1, 1, 1)
        # Group near shades (anti-aliasing, halftones), then take the commonest exact color of
        # the commonest group, so that the paper stays exactly white.
        groups: Counter[tuple[int, int, int]] = Counter()
        for value, count in counts.items():
            groups[value[0] >> 4, value[1] >> 4, value[2] >> 4] += count
        group, share = groups.most_common(1)[0]
        total = sum(counts.values())
        if share < total * self.PREVAILING:
            red, green, blue = (sum(v[i] * c for v, c in counts.items()) / total / 255 for i in range(3))
            return (red, green, blue)
        value = max((v for v in counts if (v[0] >> 4, v[1] >> 4, v[2] >> 4) == group), key=counts.__getitem__)
        return (value[0] / 255, value[1] / 255, value[2] / 255)


def _luminance(color: tuple[float, float, float]) -> float:
    """WCAG relative luminance of an sRGB color (components 0..1)."""
    red, green, blue = (c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in color)
    return .2126 * red + .7152 * green + .0722 * blue


def _hex_color(value: str) -> tuple[float, float, float]:
    return (int(value[1:3], 16) / 255, int(value[3:5], 16) / 255, int(value[5:7], 16) / 255)


def _light_text(fill: tuple[float, float, float]) -> bool:
    """Whether the light translation color contrasts more with fill than the usual dark one
    (WCAG contrast ratio of relative luminances)."""
    background = _luminance(fill)

    def contrast(text: str) -> float:
        foreground = _luminance(_hex_color(text))
        return (max(foreground, background) + .05) / (min(foreground, background) + .05)
    return contrast(LIGHT_TEXT_COLOR) > contrast(TEXT_COLOR)


def _fit(placement: fitz.Rect, markup: str, archive: fitz.Archive, bounds: fitz.Rect) -> tuple[float, float]:
    """(remaining, scale) of the markup laid out in placement, shrunk as far as needed."""
    if 'data-papeer-tall-math' in markup:
        remaining, scale, _ = _fit_story_canvas(placement, markup, archive, bounds)
        return remaining, scale
    with fitz.open() as probe:
        candidate = probe.new_page(width=bounds.width, height=bounds.height)
        return candidate.insert_htmlbox(placement, markup, archive=archive, css=FONT_CSS, scale_low=0)


def _fit_story_canvas(placement, markup, archive, bounds):
    """Fit and draw directly on a page, preserving ink below Story's last row.

    insert_htmlbox clips its intermediate page at the reported text height;
    negative image alignment can extend below that height. Measuring the
    drawn images avoids a blank tail paragraph that shrinks the whole block.
    """
    story = fitz.Story(markup, user_css=FONT_CSS, archive=archive)
    rect = fitz.Rect(0, 0, placement.width, placement.height)
    def fits(scale):
        story.reset()
        more, _ = story.place(rect * (1 / scale))
        return not more
    if fits(1):
        scale = 1.0
    else:
        low, high = .05, 1.0
        if not fits(low):
            return -1, 0, None
        for _ in range(11):
            middle = (low + high) / 2
            if fits(middle): low = middle
            else: high = middle
        scale = low
    for _ in range(6):
        stream = BytesIO()
        writer = fitz.DocumentWriter(stream)
        device = writer.begin_page(bounds)
        story.reset()
        more, _ = story.place(rect * (1 / scale))
        story.draw(device, fitz.Matrix(scale, scale) * fitz.Matrix(1, 0, 0, 1, placement.x0, placement.y0))
        writer.end_page(); writer.close()
        data = stream.getvalue()
        with fitz.open(stream=data, filetype='pdf') as drawn:
            bottom = max((info['bbox'][3] for info in drawn[0].get_image_info()), default=placement.y0)
        if bottom <= placement.y1 + .05 and not more:
            return 0, scale, data
        scale *= min(.98, placement.height / max(placement.height + .1, bottom - placement.y0))
    return -1, scale, None


def _without_images(rect: fitz.Rect, images: list[fitz.Rect]) -> list[fitz.Rect]:
    """Paint text without painting photographs inside a wraparound box."""
    pieces = [rect]
    for image in images:
        remaining = []
        for box in pieces:
            cut = box & image
            if cut.is_empty:
                remaining.append(box)
                continue
            remaining.extend(part for part in (
                fitz.Rect(box.x0, box.y0, box.x1, cut.y0),
                fitz.Rect(box.x0, cut.y1, box.x1, box.y1),
                fitz.Rect(box.x0, cut.y0, cut.x0, cut.y1),
                fitz.Rect(cut.x1, cut.y0, box.x1, cut.y1)) if not part.is_empty)
        pieces = remaining
    return pieces


def _fit_around_images(placement, markup, archive, bounds, images):
    """Flow one story through horizontal bands around fixed photographs.

    MuPDF Story does not implement CSS floats. Separate placement rectangles
    keep both the source image footprint and the text's reading order intact.
    """
    cuts = sorted({placement.y0, placement.y1, *(max(placement.y0, min(placement.y1, y))
                   for image in images for y in (image.y0 - 2, image.y1 + 2))})
    regions = []
    for top, bottom in zip(cuts, cuts[1:]):
        if bottom - top < 2:
            continue
        band = fitz.Rect(placement.x0, top, placement.x1, bottom)
        pieces = _without_images(band, [image + (-3, -2, 3, 2) for image in images])
        usable = [r for r in pieces if r.width >= 30 and r.height >= 2]
        if usable:
            region = max(usable, key=lambda r: r.width)
            # Story's glyph ink can rise above its reported placed rectangle.
            # Keep the first ink of a new band below the photograph above it.
            region.y0 += 4
            if region.height > 2:
                regions.append(region)
    if not regions:
        return -1, 0, None
    story = fitz.Story(markup, user_css=FONT_CSS, archive=archive)
    def fits(scale):
        story.reset()
        for region in regions:
            more, filled = story.place(region * (1 / scale))
            story.draw(None)
            if not more:
                return True
        return False
    if fits(1):
        scale = 1.0
    else:
        low, high = .1, 1.0
        if not fits(low):
            return -1, 0, None
        for _ in range(11):
            middle = (low + high) / 2
            if fits(middle):
                low = middle
            else:
                high = middle
        scale = low
    stream = BytesIO()
    writer = fitz.DocumentWriter(stream)
    device = writer.begin_page(bounds)
    story.reset()
    for region in regions:
        more, filled = story.place(region * (1 / scale))
        story.draw(device, fitz.Matrix(scale, scale))
        if not more:
            break
    writer.end_page()
    writer.close()
    return 0, scale, stream.getvalue()


def _search_text(writer: fitz.TextWriter, font: fitz.Font | None, rect: fitz.Rect, text: str) -> None:
    """Invisible text over a formula image, so that the formula can be found and copied:
    one line of the bundled serif (searchable_text), as large as fits in the image's box."""
    if font is None or not text or rect.is_empty:
        return
    width, height = font.text_length(text, fontsize=1), font.ascender - font.descender
    if width <= 0 or height <= 0:
        return
    size = min(rect.height / height, rect.width / width)
    baseline = rect.y0 + (rect.height - height * size) / 2 + font.ascender * size
    writer.append((rect.x0, baseline), text, font=font, fontsize=size)


def _restore_source_region(page: fitz.Page, source: fitz.Page, rect: fitz.Rect) -> None:
    """Restore opaque source pixels, including clipped images and white gaps.

    A sampled border color is not the background of an entire protected region.
    PDF forms also retain transparent gaps, so placing them over a guessed fill
    can introduce colored rectangles that never existed in the original.
    """
    # Keep the original text searchable beneath the opaque appearance.
    page.show_pdf_page(rect, source.parent, source.number, clip=rect)
    pixels = source.get_pixmap(matrix=fitz.Matrix(4, 4), clip=rect, alpha=False, annots=False)
    # Pixmap clips round outwards to device pixels. Preserve that exact mapping.
    target = fitz.Rect(pixels.x / 4, pixels.y / 4,
                       (pixels.x + pixels.width) / 4, (pixels.y + pixels.height) / 4)
    page.insert_image(target, stream=pixels.tobytes('png'), overlay=True)


def build_translated_pdf(source: Path, document: dict, translations: dict[str, str], output: Path,
                         page_numbers: set[int] | None = None,
                         translate_page_numbers: set[int] | None = None) -> dict:
    """Preserve tables and display math; reinsert inline math in the translation."""
    output.parent.mkdir(parents=True, exist_ok=True)
    scaled_blocks = 0
    inline_formulas = 0
    readability_warnings = []
    preserved_margin_blocks = []
    compact_blocks = []
    tight_leading_blocks = []
    note_blocks = []
    preserved_label_blocks = []
    # The cached translation blocks each laid-out block takes its text from (a warning's
    # "source_blocks": the paragraphs to shorten). A flow member shows part of its first block.
    sources = {member: [group["blocks"][0]] for group in document.get("continuations", [])
               if group["blocks"][0] in translations for member in group["blocks"]}
    document, translations = materialize_flows(document, translations)
    # Correct figure boundaries in old caches without re-extracting paragraphs
    # or discarding their saved translations. Labels retain the original glyphs.
    if any(b.get("kind") == "figure" for b in document["blocks"]):
        with PDF_LOCK, fitz.open(source) as geometry_source:
            by_page = {}
            for block in document["blocks"]:
                by_page.setdefault(block["page"], []).append(block)
            kept = {}
            for number, blocks in by_page.items():
                restored, labels = restore_plot_labels(geometry_source[number - 1], blocks)
                kept.update((b["id"], b) for b in restored)
                preserved_label_blocks.extend(labels)
            document = dict(document, blocks=[kept[b["id"]] for b in document["blocks"] if b["id"] in kept])
    document = dict(document, blocks=running_headers(document))
    document = dict(document, blocks=[dict(b, kind="formula", formulas=[]) if formula_only_block(b) else b
                                     for b in document["blocks"]])
    # Legacy extraction can split the beginning of a line (with tall inline
    # math) from its continuation. Lay out overlapping translated fragments
    # together, without changing persisted IDs or invalidating the cache.
    translations = dict(translations)
    heading_blocks = merge_wrapped_headings(document["blocks"], {p["number"]: p["height"] for p in document["pages"]})
    original_blocks = {b["id"]: b for b in document["blocks"]}
    restored = []
    for block in heading_blocks:
        parts = block.get("heading_parts", [])
        # Fresh extraction already translated the complete heading under one ID.
        # Legacy caches may still have a separate translation for every line.
        if len(parts) > 1 and all(part in original_blocks for part in parts):
            if all(part in translations for part in parts):
                translations[block["id"]] = " ".join(translations[part] for part in parts)
                sources[block["id"]] = [s for part in parts for s in sources.get(part, [part])]
            else:
                restored.extend(original_blocks[part] for part in parts)
                continue
        restored.append(block)
    document = dict(document, blocks=restored)
    page_heights = {p["number"]: p["height"] for p in document["pages"]}
    page_body = {number: body_font_size([b for b in document["blocks"] if b["page"] == number])
                 for number in page_heights}
    roles = {b["id"]: text_style(b, page_body[b["page"]], page_heights[b["page"]]).role
             for b in document["blocks"]}
    protected = [b for b in document["blocks"] if b.get("kind") in {"formula", "table", "reference", "figure", "algorithm"}]
    def adjacent_body(a, b):
        gap = b["bbox"][1] - a["bbox"][3]
        if (not 0 <= gap <= 4 or abs(a["bbox"][2] - b["bbox"][2]) > 8
                or roles[a["id"]] not in {"body", "runin"} or roles[b["id"]] not in {"body", "runin"}
                or a.get("reading_margin") or b.get("reading_margin")):
            return False
        return not any(p["page"] == b["page"] and p["bbox"][1] < b["bbox"][1]
                       and p["bbox"][3] > a["bbox"][3]
                       and min(p["bbox"][2], b["bbox"][2]) > max(p["bbox"][0], b["bbox"][0]) for p in protected)
    with PDF_LOCK, fitz.open(source) as image_source:
        wrap_images = {n + 1: [fitz.Rect(image['bbox']) for image in page.get_image_info()
                              if fitz.Rect(image['bbox']).width >= 20
                              and fitz.Rect(image['bbox']).height >= 20
                              and not raster_crosses_prose(page, fitz.Rect(image['bbox']))]
                       for n, page in enumerate(image_source)}
    def same_wrapped_paragraph(a, b):
        if (not 0 <= b['bbox'][1] - a['bbox'][3] <= max(a['font_size'], b['font_size']) * 1.5
                or abs(a['bbox'][2] - b['bbox'][2]) > 8
                or roles[a['id']] not in {'body', 'runin'} or roles[b['id']] not in {'body', 'runin'}):
            return False
        return any(fitz.Rect(a['bbox']).intersects(image) or fitz.Rect(b['bbox']).intersects(image)
                   for image in wrap_images.get(b['page'], []))
    merged = []
    for block in document["blocks"]:
        box = fitz.Rect(block["bbox"])
        target = next((b for b in reversed(merged)
                       if b["page"] == block["page"]
                       and b.get("kind") == block.get("kind") == "text"
                       and not b.get("algorithm_step") and not block.get("algorithm_step")
                       and b["id"] in translations and block["id"] in translations
                       and (abs(b["bbox"][0] - box.x0) < 8 or same_wrapped_paragraph(b, block))
                       and (min(b["bbox"][3], box.y1) > max(b["bbox"][1], box.y0)
                            or adjacent_body(b, block) or same_wrapped_paragraph(b, block))), None)
        if target is None:
            merged.append(dict(block))
        else:
            paragraph = (first_line_indented(block) or bool(re.match(
                r"^(?:Remark|Assumption|Theorem|Lemma|Proposition|Corollary|Definition)\b", block["text"]))
                         or bool(re.search(r"[.!?]\s*$", target["text"])))
            separator = "\n" if paragraph else " "
            target["bbox"] = list(fitz.Rect(target["bbox"]) | box)
            if target.get("regions") and block.get("regions"):
                target["regions"] = target["regions"] + block["regions"]
            else:
                target.pop("regions", None)
            target["text"] += separator + block["text"]
            target["formulas"] = target.get("formulas", []) + block.get("formulas", [])
            translations[target["id"]] += separator + translations[block["id"]]
            sources[target["id"]] = list(dict.fromkeys(sources.get(target["id"], [target["id"]])
                                                       + sources.get(block["id"], [block["id"]])))
    document = dict(document, blocks=merged)
    selected = set(range(1, document["page_count"] + 1)) if page_numbers is None else set(page_numbers)
    if not selected or not selected <= set(range(1, document["page_count"] + 1)):
        raise ValueError("生成するページ番号が不正です。")
    # Older caches have only the union box, which can include prose between
    # equation lines. Enrich geometry without changing IDs or translation tokens.
    if any(b.get("kind") == "formula" and "regions" not in b for b in document["blocks"]):
        # Geometry/text are stable even if newer extraction adds table blocks
        # and renumbers the other blocks. Never associate crops by ID alone.
        fresh = {}
        with PDF_LOCK, fitz.open(source) as geometry_source:
            for number, page in enumerate(geometry_source, 1):
                items = page.get_text("rawdict", sort=True,
                    flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]
                annotate_math_fonts(items)
                # Recreate pre-table grouping for legacy caches. Table extraction
                # can split an old formula group even when the PDF is identical.
                for item in items:
                    if item.get("type") == 0:
                        for b in layout_blocks(item, number, 1):
                            fresh[(number, b["text"], tuple(b["bbox"]))] = b
        enriched = []
        for block in document["blocks"]:
            match = fresh.get((block["page"], block["text"], tuple(block["bbox"])), {})
            if (block.get("kind") == "formula" and "regions" not in block
                    and match.get("text") == block["text"] and match.get("bbox") == block["bbox"]):
                block = dict(block, regions=match["regions"])
            enriched.append(block)
        document = dict(document, blocks=enriched)
    # Subsetting the bundled faces is fontTools work only (and, the first time on a PC, their
    # conversion): done before PDF_LOCK so that it never holds up the viewer or another job.
    # The serif also carries the invisible text over the formula images.
    math_text = "".join(searchable_text(formula.get("text", "")) for block in document["blocks"]
                        if block["id"] in translations for formula in block.get("formulas", []))
    subsets = font_subsets("".join(translations.values()) + math_text) if translations else ()
    with PDF_LOCK, fitz.open(source) as pdf, fitz.open(source) as original:
        fonts = fitz.Archive()
        for face in subsets:
            fonts.add(face)
        math_font = fitz.Font(fontbuffer=subsets[0][0]) if subsets else None
        by_page: dict[int, list] = {}
        for block in document["blocks"]:
            if block["id"] in translations and block.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}:
                by_page.setdefault(block["page"], []).append(block)
        for number in range(document["page_count"]):
            if number + 1 not in selected or (translate_page_numbers is not None and number + 1 not in translate_page_numbers):
                continue
            page = pdf[number]
            rotation = page.rotation
            page.set_rotation(0)
            original[number].set_rotation(0)
            glyph_bounds = page_glyph_bounds(original[number])
            background = _Background(original[number])
            planned = []
            # Text extraction coordinates are unrotated; the media box uses the same coordinates.
            bounds = fitz.Rect(0, 0, page.cropbox.width, page.cropbox.height)
            page_blocks = [b for b in document["blocks"] if b["page"] == number + 1]
            # Old caches may contain only block boxes. Recover line geometry
            # from the source without re-extracting IDs or invalidating translations.
            source_lines = None
            inline_ink = [fitz.Rect(formula["bbox"]) for b in document["blocks"] for formula in b.get("formulas", [])
                          if formula.get("source_page", b["page"]) == number + 1]
            # Bitmap math belongs to the text being replaced. Treating its
            # source image as a separate figure blocks all whitespace growth.
            obstacles = []
            raster_images = []
            for item in page.get_image_info():
                image = fitz.Rect(item["bbox"])
                if raster_crosses_prose(page, image):
                    continue
                if not any((image & rect).get_area() >= image.get_area() * .95 for rect in inline_ink):
                    obstacles.append(image)
                    if image.width >= 20 and image.height >= 20:
                        raster_images.append(image)
            obstacles.extend(fitz.Rect(item["rect"]) for item in page.get_drawings())
            body_size = body_font_size(page_blocks)
            footnotes = footnote_ids(page_blocks, bounds.height)
            source_body = source_body_size(page_blocks)
            # Preserve the full box for isolated math (including fraction bars).
            # Where it encloses prose, protect the actual equation lines instead.
            prose_rects = [fitz.Rect(b["bbox"]) for b in page_blocks if b.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}]
            prose_lines = [fitz.Rect(region) for b in page_blocks
                           if b.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}
                           for region in b.get("regions", [b["bbox"]])]
            full_boxes = [fitz.Rect(b["bbox"]) & bounds for b in page_blocks if b.get("kind") == "formula"]
            enclosed_prose = []
            for rect in prose_rects:
                try:
                    _space_without_formulas(rect & bounds, full_boxes)
                except ValueError:
                    enclosed_prose.append(rect)
            display_rects = []
            for block in page_blocks:
                if block.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}:
                    continue
                box = fitz.Rect(block["bbox"])
                mixed_math = block.get("kind") == "formula" and any(box.intersects(line) for line in prose_lines)
                regions = (block.get("regions", [block["bbox"]])
                           if mixed_math or any(box.intersects(rect) for rect in enclosed_prose) else [block["bbox"]])
                display_rects.extend(fitz.Rect(region) & bounds for region in regions)
            restore_rects = []
            painted_ids = set()
            painted_rects = []
            for block in by_page.get(number + 1, []):
                rect = fitz.Rect(block["bbox"]) & bounds
                if (re.fullmatch(r"[A-Za-z]{1,4}", block["text"].strip())
                        and rect.width < block["font_size"] * 2
                        and rect.height < block["font_size"] * 3):
                    preserved_label_blocks.append(block["id"])
                    continue
                if rect.width < 45 and rect.height > rect.width * 4 and len(block["text"]) > 25:
                    preserved_margin_blocks.append(block["id"])
                    continue
                style = text_style(block, body_size, bounds.height, footnote=block["id"] in footnotes,
                                   source_body=source_body)
                if style.role in {"note", "caption"}:
                    note_blocks.append(block["id"])
                overlapping = [formula for formula in display_rects if rect.intersects(formula)]
                fill = background.color(rect)
                light = _light_text(fill)
                color = LIGHT_TEXT_COLOR if light else TEXT_COLOR
                # Light text is readable only on the painted box, not on the paper around it.
                space = rect if light else reading_space(block, style, page_blocks, bounds, obstacles)
                placement = _space_without_formulas(space, display_rects)
                restore_rects.extend(overlapping)
                text = translations[block["id"]]
                formulas = block.get("formulas", [])
                if Counter(MATH_TOKEN.findall(text)) != Counter(f["token"] for f in formulas):
                    raise ValueError("訳文中の数式の目印が欠落・重複しています。再翻訳してください。")
                archive = fitz.Archive()
                archive.add(fonts)
                images = {}
                math_ems = 0.0
                for index, formula in enumerate(formulas):
                    source_number = formula.get('source_page', number + 1) - 1
                    source_page = original[source_number]
                    source_page.set_rotation(0)
                    source_glyphs = glyph_bounds if source_number == number else page_glyph_bounds(source_page)
                    crop = formula_crop(formula, source_glyphs) & source_page.rect
                    name = f"{block['id']}-{index}.png"
                    pixels = source_page.get_pixmap(matrix=fitz.Matrix(4, 4), clip=crop, alpha=False)
                    archive.add((pixels.tobytes("png"), name))
                    em = max(1, block["font_size"])
                    math_ems += crop.width / em
                    descent = (crop.y1 - formula["baseline"]) / em
                    image_markup = (
                        f'<img src="{name}" style="width:{crop.width / em:.4f}em;'
                        f'height:{crop.height / em:.4f}em;vertical-align:{-descent:.4f}em">')
                    images[formula["token"]] = image_markup
                if not block.get("regions"):
                    if source_lines is None:
                        source_lines = [fitz.Rect(line["bbox"])
                            for item in original[number].get_text("dict")["blocks"]
                            if item.get("type") == 0 for line in item["lines"]]
                    regions = [list(line & rect) for line in source_lines
                               if rect.contains((line.tl + line.br) / 2)]
                    block = dict(block, regions=regions)
                first_indent = first_line_indented(block)
                markup = text_html(text, style, images, first_indent=first_indent, color=color, story_canvas=True)
                remaining, scale = _fit(placement, markup, archive, bounds)
                role, regular_scale = style.role, scale
                # Before shrinking the type, tighten the leading of running text.
                if scale < 1 and style.leading > TIGHT_LEADING and role in {"body", "runin"}:
                    tight = replace(style, leading=TIGHT_LEADING)
                    tight_markup = text_html(text, tight, images, first_indent=first_indent, color=color, story_canvas=True)
                    tight_remaining, tight_scale = _fit(placement, tight_markup, archive, bounds)
                    if tight_remaining >= 0 and tight_scale > scale:
                        style, markup, remaining, scale = tight, tight_markup, tight_remaining, tight_scale
                        tight_leading_blocks.append(block["id"])
                # Tight, short lead-ins around equations (and short notes) should keep readable
                # glyphs before sacrificing font size. Never compact paragraphs. The box height
                # is measured in body lines, also for the smaller type of notes.
                if (regular_scale < .85 and role in {"body", "note", "caption"}
                        and placement.height < max(style.size, body_size) * 3 and len(MATH_TOKEN.sub("x", text)) < 160):
                    compact_style = TextStyle("compact", style.size, 1.15)
                    compact = text_html(text, compact_style, images, color=color, story_canvas=True)
                    compact_remaining, compact_scale = _fit(placement, compact, archive, bounds)
                    if compact_remaining >= 0 and compact_scale > scale:
                        style, markup, remaining, scale = compact_style, compact, compact_remaining, compact_scale
                        compact_blocks.append(block["id"])
                if remaining < 0:
                    raise RuntimeError("訳文を元のページ内に配置できませんでした。未完成のPDFは保存していません。")
                flow_pdf = None
                if 'data-papeer-tall-math' in markup:
                    remaining, scale, flow_pdf = _fit_story_canvas(placement, markup, archive, bounds)
                wrapped_images = [image for image in raster_images
                                  if (image & rect).get_area() > 1]
                if wrapped_images:
                    remaining, scale, flow_pdf = _fit_around_images(
                        placement, markup, archive, bounds, wrapped_images)
                    if remaining < 0:
                        raise RuntimeError("図版を避けて訳文を配置できませんでした。")
                scaled_blocks += int(scale < 0.60)
                minimum = readable_size(TextStyle(role, style.size, style.leading))
                if style.size * scale < minimum:
                    # With a rough length that would fit at the smallest readable size, so that a
                    # shorter translation can be requested (translation review, AI 修正案);
                    # None when the box is too small for any translation at that size.
                    readability_warnings.append({"page": number + 1, "block": block["id"],
                        "font_size": round(style.size * scale, 2), "scale": round(scale, 3), "role": role,
                        "chars": len(re.sub(r"\s", "", MATH_TOKEN.sub("", resolve_unit_joins(text)))),
                        "char_budget": character_budget(placement, minimum, style.leading, math_ems),
                        "source_blocks": sources.get(block["id"], [block["id"]])})
                inline_formulas += len(formulas)
                for paint in _without_images(rect, raster_images):
                    page.add_redact_annot(paint, fill=fill, cross_out=False)
                painted_ids.add(block["id"])
                painted_rects.append(rect)
                # In the translation's order, which the laid-out images follow; word order may differ from the source.
                by_token = {}
                for formula in formulas:
                    by_token.setdefault(formula["token"], []).append(formula)
                planned.append((placement, markup, archive,
                                [by_token[token].pop(0) for token in MATH_TOKEN.findall(text)], flow_pdf))
            if planned:
                search_layer = fitz.TextWriter(page.rect)
                page.apply_redactions(images=0, graphics=0, text=0)
                # Some embedded PDF forms lose unrelated glyphs when MuPDF
                # redacts a paragraph. Restore every protected region, including
                # equations in the other column, when its glyphs actually went
                # missing. Leave intact regions alone to avoid changing their
                # antialiasing at a crop boundary.
                def glyph_key(span, char):
                    return span["font"], char[0], char[1], tuple(round(v, 3) for v in char[2])
                surviving = {glyph_key(span, char) for span in page.get_texttrace() for char in span["chars"]}
                original_glyphs = [(glyph_key(span, char), fitz.Rect(char[3]))
                                   for span in original[number].get_texttrace() for char in span["chars"]]
                missing = [box for key, box in original_glyphs if key not in surviving]
                nonlocal_loss = any(not any(box.intersects(rect) for rect in painted_rects) for box in missing)
                if nonlocal_loss:
                    # A corrupt rewrite can also move surviving source text to
                    # the page edge. Clear that text layer and reconstruct only
                    # the regions that should remain original before typesetting.
                    page.add_redact_annot(bounds, fill=None, cross_out=False)
                    page.apply_redactions(images=0, graphics=0, text=0)
                    restore_rects = list(display_rects)
                    restore_rects.extend(fitz.Rect(b["bbox"]) & bounds for b in page_blocks
                                         if b.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}
                                         and b["id"] not in painted_ids)
                else:
                    restore_rects.extend(rect for rect in display_rects if rect not in restore_rects
                                         and any(rect.intersects(glyph) for glyph in missing))
                for rect in restore_rects:
                    if any(b.get('kind') == 'figure' and fitz.Rect(b['bbox']).contains(rect)
                           for b in page_blocks):
                        _restore_source_region(page, original[number], rect)
                    else:
                        page.draw_rect(rect, color=None, fill=background.color(rect), overlay=True)
                        page.show_pdf_page(rect, original, number, clip=rect)
                # Image boxes on the page so far (each listing costs a text page); only markup
                # with formulas adds images.
                images_before: set[tuple] | None = None
                for rect, markup, archive, formulas, flow_pdf in planned:
                    if formulas and images_before is None:
                        images_before = {tuple(img['bbox']) for img in page.get_image_info()}
                    if flow_pdf:
                        with fitz.open(stream=flow_pdf, filetype='pdf') as flow:
                            page.show_pdf_page(bounds, flow, 0)
                        remaining = 0
                    else:
                        remaining, _ = page.insert_htmlbox(rect, markup, archive=archive, css=FONT_CSS, scale_low=0)
                    if remaining < 0:
                        raise RuntimeError("訳文の描画に失敗しました。未完成のPDFは保存していません。")
                    if formulas and images_before is not None:
                        images_after = page.get_image_info()
                        new_images = [img for img in images_after if tuple(img['bbox']) not in images_before]
                        images_before = {tuple(img['bbox']) for img in images_after}
                        for img, formula in zip(_reading_order(new_images), formulas):
                            _search_text(search_layer, math_font, fitz.Rect(img['bbox']), searchable_text(formula["text"]))
                if not search_layer.text_rect.is_empty:
                    search_layer.write_text(page, render_mode=3)
            page.set_rotation(rotation)
        if page_numbers is not None:
            pdf.select([number - 1 for number in sorted(selected)])
        pdf.set_metadata({"title": document["title"] + " - 日本語訳", "creator": "Papeer"})
        with atomic_output(output) as temporary:
            pdf.save(temporary, garbage=4, deflate=True)
        return {"overflow_blocks": 0, "pages": pdf.page_count, "supplements": [],
                "scaled_blocks": scaled_blocks, "inline_formulas": inline_formulas,
                "readability_warnings": readability_warnings, "preserved_margin_blocks": preserved_margin_blocks,
                "compact_blocks": compact_blocks,
                "tight_leading_blocks": tight_leading_blocks,
                "note_blocks": note_blocks,
                "preserved_label_blocks": preserved_label_blocks,
                "preserved_reference_blocks": [b["id"] for b in document["blocks"]
                                               if b.get("kind") == "reference" and b["page"] in selected],
                "preserved_algorithm_blocks": sum(b.get("kind") == "algorithm" and b["page"] in selected for b in document["blocks"]),
                "preserved_figure_blocks": sum(b.get("kind") == "figure" and b["page"] in selected for b in document["blocks"]),
                "preserved_table_blocks": sum(b.get("kind") == "table" and b["page"] in selected for b in document["blocks"]),
                "preserved_formula_blocks": sum(b.get("kind") == "formula" and b["page"] in selected for b in document["blocks"])}


def interleaved_pdf(source: Path, translated: Path, output: Path) -> None:
    """Alternate original / translated pages, retaining each page's geometry."""
    if output.resolve() in {source.resolve(), translated.resolve()}:
        raise ValueError("原文・日本語訳とは別の保存先を選んでください。")
    output.parent.mkdir(parents=True, exist_ok=True)
    with PDF_LOCK, fitz.open(source) as original, fitz.open(translated) as japanese, fitz.open() as result:
        if original.page_count != japanese.page_count:
            raise ValueError("原文と日本語訳のページ数が一致しません。再翻訳してから交互PDFを作成してください。")
        for index in range(original.page_count):
            result.insert_pdf(original, from_page=index, to_page=index)
            result.insert_pdf(japanese, from_page=index, to_page=index)
        result.set_metadata({"title": (original.metadata.get("title") or source.stem) + " - 原文・日本語訳（交互）",
                             "creator": "Papeer"})
        with atomic_output(output) as temporary:
            result.save(temporary, garbage=4, deflate=True)


def bilingual_pdf(source: Path, translated: Path, output: Path) -> None:
    with PDF_LOCK, fitz.open(source) as original, fitz.open(translated) as japanese, fitz.open() as result:
        for index in range(japanese.page_count):
            right = japanese[index]
            if index < original.page_count:
                left = original[index]
                height = max(left.rect.height, right.rect.height)
                page = result.new_page(width=left.rect.width + right.rect.width + 16, height=height)
                page.show_pdf_page(fitz.Rect(0, 0, left.rect.width, left.rect.height), original, index)
                page.show_pdf_page(fitz.Rect(left.rect.width + 16, 0, page.rect.width, right.rect.height), japanese, index)
            else:
                result.insert_pdf(japanese, from_page=index, to_page=index)
        with atomic_output(output) as temporary:
            result.save(temporary, garbage=4, deflate=True)


def page_png(path: Path, index: int, width: int = 650) -> bytes | None:
    from papeer.pdf.pdf_viewer import page_png as render_png
    return render_png(path, index, width)
