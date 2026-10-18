"""Japanese reading typography, fitted to the source paper's column geometry."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import cast
import html
import io
from pathlib import Path
import re
from statistics import median
import threading
import unicodedata

import pymupdf as fitz
from fontTools.ttLib import TTFont

from papeer.layout.math_layout import MATH_TOKEN
from papeer.layout.reading_flow import resolve_unit_joins
from papeer.pdf.pdf_fonts import cache_ready, cached_truetype, subset_truetype


FONT_DIRECTORY = Path(__file__).resolve().parent.parent / "core" / "assets" / "fonts"
FONT_CSS = """
@font-face { font-family: PapeerSerif; src: url(PapeerSerif-Regular.ttf); }
@font-face { font-family: PapeerHeading; src: url(PapeerHeading-Bold.ttf); font-weight: bold; }
html, body { margin: 0; padding: 0; }
body { padding: 1pt; }
"""
_NUMBERED = re.compile(r"^(\d+(?:\.\d+)*\.?|[IVX]+\.|[A-Z]\.)\s+(.+)$", re.S)
_NAMED_HEADINGS = {"abstract", "introduction", "background", "methods", "method", "results",
                   "discussion", "conclusion", "conclusions", "references", "acknowledgments",
                   "acknowledgements", "appendix", "results and limitations"}
# "Fig. 3." / "Fig. 3.2:" / "Table II" / "TABLE I" + line break. Group 1 (the punctuation)
# tells a caption from prose that merely starts with "Table 3 shows" or "Figure 3.2 shows";
# without it only smaller type counts.
_CAPTION_LABEL = re.compile(r"^(?:(?:Fig(?:ure)?|FIG(?:URE)?)\.?|Table|TABLE|Algorithm|ALGORITHM)\s*"
                            r"(?:\d+(?:\.\d+)*|[IVX]+)[a-z]?\b(\s*[.:|](?!\d)|\s*$|\s*\n)?")
# Fitting a translation into its box, in order: the regular leading, this tighter leading,
# and only then smaller type (pdf_engine.build_translated_pdf).
TIGHT_LEADING = 1.25


# The bundled faces: the source file and the family/style that the markup (FONT_CSS) names.
# The serif comes first; it also carries the invisible text over formula images (searchable_text).
FONT_FACES = (("SourceHanSerifJP-Regular.otf", "PapeerSerif", "Regular"),
              ("SourceHanSansJP-Bold.otf", "PapeerHeading", "Bold"))


def font_subsets(text: str) -> tuple[tuple[bytes, str], ...]:
    """(TrueType data, archive file name) of each face in FONT_FACES, cut down to the characters of text.

    Only fontTools work, no MuPDF: build_translated_pdf calls it before taking PDF_LOCK.
    The first call on a PC converts the bundled faces (pdf_fonts.cached_truetype).
    """
    return _font_subsets("".join(sorted(set(text + "　 "))))


@lru_cache(maxsize=4)
def _font_subsets(characters: str) -> tuple[tuple[bytes, str], ...]:
    # Subset only our own font assets. Original PDF math fonts remain untouched.
    return tuple((subset_truetype(cached_truetype(FONT_DIRECTORY / name, family, style), characters),
                  f"{family}-{style}.ttf") for name, family, style in FONT_FACES)


def font_archive(text: str) -> fitz.Archive:
    archive = fitz.Archive()
    for font in font_subsets(text):
        archive.add(font)
    return archive


def fonts_need_conversion() -> bool:
    """Whether the next font_subsets call converts a bundled face first (the first translation on a PC)."""
    return not all(cache_ready(FONT_DIRECTORY / name, family, style) for name, family, style in FONT_FACES)


def prepare_fonts_in_background() -> None:
    """Have the bundled faces converted (pdf_fonts.cached_truetype) before the first page needs them.

    The conversion takes half a minute, once per PC; started with a translation, it runs while
    the first requests are out. Pages that need the faces sooner wait for it rather than convert twice.
    """
    threading.Thread(target=_prepare_fonts, name="papeer-fonts", daemon=True).start()


def _prepare_fonts() -> None:
    try:
        for name, family, style in FONT_FACES:
            cached_truetype(FONT_DIRECTORY / name, family, style)
    except Exception:  # noqa: BLE001, S110 - the page that needs the faces tries again and reports the error.
        pass


@lru_cache(maxsize=1)
def _serif_characters() -> frozenset[int]:
    name, family, style = FONT_FACES[0]
    with TTFont(io.BytesIO(cached_truetype(FONT_DIRECTORY / name, family, style)), lazy=True) as font:
        return frozenset(cast(dict, font.getBestCmap()))


# Math symbols the serif lacks and their nearest character in it, for searchable_text. The ceiling
# and floor brackets become box-drawing corners of the same shape, so that the two stay apart.
_MATH_STAND_INS = {
    "⟨": "〈", "⟩": "〉", "∼": "〜", "∗": "*", "∘": "○", "⋆": "☆", "⋮": "︙",
    "⋅": "·", "∙": "·", "∖": "\\", "⌈": "┌", "⌉": "┐", "⌊": "└", "⌋": "┘",
}


def searchable_text(text: str) -> str:
    """A formula's text as the invisible layer over its image writes it, in the bundled serif.

    A character the serif lacks becomes its stand-in (_MATH_STAND_INS: ⟨ → 〈, ∗ → *) or its
    compatibility form where the serif has that (mathematical italic 𝑥 → x, ℝ → R, subscript ᵢ → i);
    otherwise it is left out, since a missing glyph would be copied and found as nothing at all.
    Whitespace runs become one space.
    """
    available = _serif_characters()
    kept = []
    for character in " ".join(text.split()):
        if ord(character) in available:
            kept.append(character)
        else:
            replacement = _MATH_STAND_INS.get(character) or unicodedata.normalize("NFKC", character)
            kept.extend(c for c in replacement if ord(c) in available)
    return "".join(kept).strip()


@dataclass(frozen=True)
class TextStyle:
    role: str
    size: float
    leading: float


def body_font_size(blocks: list[dict]) -> float:
    sizes = [b["font_size"] for b in blocks if b.get("kind") not in {"formula", "table", "figure", "algorithm"} and len(b["text"]) > 150]
    return max(8.8, min(11, median(sizes) if sizes else 10))


def running_headers(document: dict) -> list[dict]:
    """Recognize repeated marginal text even when it uses body-sized type."""
    heights = {p["number"]: p["height"] for p in document["pages"]}
    groups = {}
    for block in document["blocks"]:
        rect = fitz.Rect(block["bbox"])
        height = heights[block["page"]]
        if rect.height > height * .035 or not (rect.y1 < height * .15 or rect.y0 > height * .9):
            continue
        key = re.sub(r"[\d\s]+", "", block["text"]).lower()
        if len(key) >= 12:
            groups.setdefault(key, []).append(block)
    repeated = {b["id"] for group in groups.values() if len({b["page"] for b in group}) >= 2 for b in group}
    return [dict(b, running_header=True) if b["id"] in repeated else b for b in document["blocks"]]


def text_style(block: dict, body_size: float, page_height: float, *, footnote: bool = False,
               source_body: float | None = None) -> TextStyle:
    """footnote: reading_flow.footnote_ids found the block to be a footnote.
    source_body: the page's body size before rounding (reading_flow.source_body_size); a
    caption is "smaller type" relative to it. Defaults to body_size.
    """
    if block.get("kind") == "algorithm" or block.get("algorithm_step"):
        return TextStyle("algorithm", block["font_size"], 1.05)
    text = " ".join(block["text"].split())
    rect = fitz.Rect(block["bbox"])
    if block.get("compact_title"):
        return TextStyle("title", min(17, max(12, block["font_size"] * 1.25)), 1.2)
    if block.get("running_header"):
        return TextStyle("footer", min(8, body_size * .85), 1.2)
    numbered = _NUMBERED.match(text)
    note_markers_only = all(re.fullmatch(r"[∗*†‡]", f.get("text", "").strip()) for f in block.get("formulas", []))
    short = len(text) < 160 and len(text.split()) <= 15 and not block.get("formulas")
    # A cover sheet may precede the article. Recognize prominent titles from
    # their typography and geometry rather than the physical page number.
    if (rect.y0 < page_height * .3 and rect.width > 200
            and 5 <= len(text.split()) <= 40 and len(text) < 300
            and block["font_size"] >= body_size * 1.5):
        return TextStyle("title", min(26, max(17, block["font_size"])), 1.25)
    # Some TeX journals set the paper title in small, all-capital type.
    # Its position and length distinguish it from author names and running heads.
    if (block.get("page") == 1 and rect.y0 < page_height * .3
            and rect.width > 200 and len(text.split()) >= 7 and len(text) < 240
            and text.isupper() and not numbered and note_markers_only):
        return TextStyle("title", 17, 1.25)
    if (rect.y0 > page_height * 0.93
            or (rect.y1 < page_height * 0.045 and len(text) < 180)
            or (rect.y1 < page_height * .12 and len(text) < 180
                and re.search(r"\b(?:JOURNAL|VOL\.|ISSN|IEEE TRANSACTIONS)\b", text, re.I))
            or (block.get("page", 1) > 1 and rect.y1 < page_height * .15
                and block["font_size"] <= body_size * .85 and len(text) < 180)):
        return TextStyle("footer", min(8, body_size * 0.85), 1.2)
    # Footnotes and captions are set from their own (smaller) source size, not the body size:
    # enlarged to the body size they overflow their boxes and shrink below readability.
    own_size = round(max(6, min(body_size, block["font_size"])), 2)
    if footnote:
        return TextStyle("note", own_size, TIGHT_LEADING)
    if numbered and re.match(r"\d+\.\d+", numbered[1]) and re.match(r"[^.!?]{1,45}\.\s+\w", numbered[2]):
        return TextStyle("runin", body_size, 1.4)
    if short and not re.search(r"[。!?]$", text) and (
            (numbered and not text.endswith(".")) or text.lower().rstrip(":") in _NAMED_HEADINGS):
        if numbered and ("." in numbered[1].rstrip(".")
                         or (re.fullmatch(r"[A-Z]\.", numbered[1]) and numbered[1][0] not in "IVX")):
            return TextStyle("subsection", body_size * 1.18, 1.2)
        return TextStyle("section", body_size * 1.34, 1.2)
    if short and block["font_size"] >= body_size * 1.5:
        return TextStyle("title", min(26, max(17, block["font_size"])), 1.25)
    # Checked after the headings, so that extraction (merge_wrapped_headings) sees the same roles.
    caption = _CAPTION_LABEL.match(block["text"].strip())
    if caption and (caption[1] is not None or block["font_size"] < (source_body or body_size) * .95):
        return TextStyle("caption", own_size, TIGHT_LEADING)
    return TextStyle("body", body_size, 1.4)


def readable_size(style: TextStyle) -> float:
    """Smallest type accepted without a readability warning.

    Footnotes and captions are judged against their own source size: a 7pt footnote set
    in 7pt Japanese is as readable as the original.
    """
    if style.role == "footer":
        return 6
    if style.role in {"note", "caption"}:
        return max(6, min(8, style.size * .85))
    return 8


def character_budget(rect: fitz.Rect, size: float, leading: float, math_ems: float = 0) -> int | None:
    """About how many Japanese characters fit in rect at this size: area / (size² × leading),
    counted in whole lines.

    A full-width character is one em wide and a line is size × leading high. Inline math
    takes math_ems ems of the lines, and 10% is kept for line-break losses (kinsoku etc.).
    None when not even one line (or nothing besides the math) fits at this size: no shorter
    translation would then be readable.
    """
    width, height = max(0, rect.width - 2), max(0, rect.height - 2)  # FONT_CSS pads the body by 1pt
    budget = int(int(height / (size * leading)) * int(width / size) * .9 - math_ems)
    return budget if budget > 0 else None


def merge_wrapped_headings(blocks: list[dict], page_heights: dict[int, float] | None = None) -> list[dict]:
    """Join nearby heading fragments, including centered continuation lines."""
    result = []
    page_heights = page_heights or {}
    body_sizes = {page: body_font_size([b for b in blocks if b["page"] == page])
                  for page in {b["page"] for b in blocks}}
    for block in sorted(blocks, key=lambda b: (b["page"], b["bbox"][1], b["bbox"][0])):
        target = None
        text = " ".join(block["text"].split())
        words = re.findall(r"[A-Za-z]+", text)
        heading_case = words and all(w[0].isupper() or w.lower() in {
            "and", "or", "of", "on", "in", "the", "a", "an", "to", "for", "with", "by"
        } for w in words)
        note_markers_only = all(re.fullmatch(r"[∗*†‡]", f.get("text", "").strip()) for f in block.get("formulas", []))
        if (block.get("kind", "text") == "text" and note_markers_only
                and not _NUMBERED.match(text)
                and not re.search(r"[.!?:;]$", text)):
            box = fitz.Rect(block["bbox"])
            for previous in reversed(result):
                a = fitz.Rect(previous["bbox"])
                size = min(previous["font_size"], block["font_size"])
                combined = previous["text"] + " " + text
                is_title = text_style(previous, body_sizes[previous["page"]],
                                      page_heights.get(previous["page"], 792)).role == "title"
                previous_words = re.findall(r"[A-Za-z]+", previous["text"])
                compact_title = (heading_case and previous.get("bold_heading") and block.get("bold_heading")
                                 and len(previous_words) >= 4
                                 and all(w[0].isupper() or w.lower() in {
                                     "and", "or", "of", "on", "in", "the", "a", "an", "to", "for", "with", "by"
                                 } for w in previous_words)
                                 and abs((a.x0 + a.x1 - box.x0 - box.x1) / 2) < 3)
                is_title = is_title or compact_title
                if (previous["page"] == block["page"]
                        and previous.get("kind", "text") == "text"
                        and (not previous.get("formulas") or is_title and all(
                            re.fullmatch(r"[∗*†‡]", f.get("text", "").strip()) for f in previous.get("formulas", [])))
                        and (is_title or heading_case and _NUMBERED.match(previous["text"]))
                        and not re.search(r"[.!?:;]$", previous["text"])
                        and len(combined) < (300 if is_title else 160)
                        and len(combined.split()) <= (40 if is_title else 15)
                        and abs(previous["font_size"] - block["font_size"]) <= size * .12
                        and (-size * .25 if is_title else 0) <= box.y0 - a.y1 <= size * .6
                        and (abs(a.x0 - box.x0) < 3 or abs((a.x0 + a.x1 - box.x0 - box.x1) / 2) < 3)):
                    # Any intervening content in this column is a barrier.
                    if any(other is not previous and other["page"] == block["page"]
                           and other["bbox"][3] > a.y1 and other["bbox"][1] < box.y0
                           and other["bbox"][2] > min(a.x0, box.x0)
                           and other["bbox"][0] < max(a.x1, box.x1) for other in result):
                        continue
                    target = previous
                    if compact_title:
                        target["compact_title"] = True
                    break
        if target is None:
            result.append(dict(block))
            continue
        target["bbox"] = list(fitz.Rect(target["bbox"]) | fitz.Rect(block["bbox"]))  # pyright: ignore[reportArgumentType]
        target["heading_parts"] = target.get("heading_parts", [target["id"]]) + [block["id"]]
        for key in ("translation_text", "text"):
            target[key] = target.get(key, target["text"]) + "\n" + block.get(key, block["text"])
        target["regions"] = target.get("regions", []) + block.get("regions", [])
        target["formulas"] = target.get("formulas", []) + block.get("formulas", [])
    for block in result:
        if text_style(block, body_sizes[block["page"]], page_heights.get(block["page"], 792)).role in {
                "title", "section", "subsection"}:
            # Wrapping is page geometry, not a subtitle or semantic boundary.
            # Preserve lexical hyphens such as "Chance-Constrained".
            block["translation_text"] = " ".join(block.get("translation_text", block["text"]).split())
    positions = {block["id"]: index for index, block in enumerate(blocks)}
    return sorted(result, key=lambda block: positions[block["id"]])


def heading_space(block: dict, style: TextStyle, blocks: list[dict], bounds: fitz.Rect) -> fitz.Rect:
    rect = fitz.Rect(block["bbox"]) & bounds
    if style.role not in {"title", "section", "subsection"}:
        return rect
    # Use the following paragraph to discover the width of this column.
    below = [b for b in blocks if b["id"] != block["id"] and b.get("kind") not in {"formula", "table", "figure", "algorithm"}
             and b["bbox"][1] >= rect.y1 and abs(b["bbox"][0] - rect.x0) < 8
             and b["bbox"][2] > rect.x1 and len(b["text"]) > 60]
    right = min(below, key=lambda b: b["bbox"][1])["bbox"][2] if below else rect.x1
    height = max(rect.height, style.size * style.leading + 2)
    top = max(bounds.y0 + 4, rect.y1 - height)
    # Grow only into blank space; the source text and equations keep their places.
    for other in blocks:
        if other["id"] == block["id"]:
            continue
        obstacle = fitz.Rect(other["bbox"])
        if obstacle.x1 <= rect.x0 or obstacle.x0 >= right:
            continue
        if obstacle.y1 <= rect.y0:
            top = max(top, min(rect.y0, obstacle.y1 + 3))
        elif obstacle.y0 < rect.y1 and obstacle.x0 >= rect.x1:
            right = min(right, obstacle.x0 - 3)
    return fitz.Rect(rect.x0, top, max(rect.x1, right), rect.y1) & bounds


def reading_space(block: dict, style: TextStyle, blocks: list[dict], bounds: fitz.Rect,
                  obstacles: list[fitz.Rect]) -> fitz.Rect:
    """Use nearby blank vertical space before shrinking a Japanese paragraph.

    Each gap belongs half to the block above and half to the block below,
    so independently laid out paragraphs cannot expand into each other.
    Images and vector graphics are barriers just like text and equations.
    """
    rect = heading_space(block, style, blocks, bounds)
    if style.role == "footer" and rect.y1 < bounds.height * .15:
        # Source header boxes fit Latin glyphs but can be too shallow for the
        # Japanese line plus padding. Borrow at most 3pt above, keeping the
        # baseline area and the space below the header unchanged.
        extra = min(3, max(0, style.size * style.leading + 2 - rect.height))
        top = max(bounds.y0 + 3, rect.y0 - extra)
        barriers = [fitz.Rect(b["bbox"]) for b in blocks if b["id"] != block["id"]] + obstacles
        for other in barriers:
            if other.x1 > rect.x0 and other.x0 < rect.x1 and other.y0 < rect.y0:
                top = max(top, min(rect.y0, other.y1 + 2))
        return fitz.Rect(rect.x0, min(top, rect.y0), rect.x1, rect.y1)
    if style.role in {"footer", "section", "subsection"}:
        return rect
    source = fitz.Rect(block["bbox"]) & bounds
    body_size = body_font_size([b for b in blocks if "text" in b and "font_size" in b])
    # A short equation lead-in (or a short footnote or caption) often occupies only a fraction
    # of its column. Infer the column from nearby prose, then stop at any same-row content.
    # "Short" is measured in body lines, also for the smaller type of notes.
    if style.role in {"body", "note", "caption"} and source.height < max(style.size, body_size) * 3:
        neighbors = [b for b in blocks if b["id"] != block["id"]
                     and b.get("kind", "text") == "text" and len(b.get("text", "")) > 60
                     and abs(b["bbox"][0] - source.x0) < 12
                     and b["bbox"][2] > source.x1
                     and b["bbox"][2] - b["bbox"][0] > bounds.width * .25]
        if neighbors:
            neighbor = min(neighbors, key=lambda b: min(abs(b["bbox"][1] - source.y1),
                                                       abs(b["bbox"][3] - source.y0)))
            right = neighbor["bbox"][2]
            barriers = [fitz.Rect(b["bbox"]) for b in blocks if b["id"] != block["id"]] + obstacles
            for barrier in barriers:
                if barrier.y0 < source.y1 and barrier.y1 > source.y0 and barrier.x1 > source.x1:
                    right = min(right, max(source.x1, barrier.x0 - 3))
            rect.x1 = min(bounds.x1, right)
    top, bottom = max(bounds.y0 + 6, source.y0 - 24), min(bounds.y1 - 6, source.y1 + 24)
    barriers = []
    for other in blocks:
        if other["id"] == block["id"]:
            continue
        occupied = fitz.Rect(other["bbox"])
        if "text" in other and "font_size" in other:
            other_style = text_style(other, body_size, bounds.height)
            if other_style.role in {"section", "subsection", "title"}:
                occupied = heading_space(other, other_style, blocks, bounds)
        barriers.append(occupied)
    barriers += obstacles
    fixed = [fitz.Rect(b["bbox"]) for b in blocks
             if b.get("kind") in {"formula", "table", "reference", "figure", "algorithm"}] + obstacles
    fixed_boxes = {(box.x0, box.y0, box.x1, box.y1) for box in fixed}
    for other in barriers:
        if other.x1 <= rect.x0 or other.x0 >= rect.x1:
            continue
        if other.y1 <= source.y0:
            gap = source.y0 - other.y1
            padding = max(3, gap / 2 - 3)
            top = max(top, other.y1 + padding if (other.x0, other.y0, other.x1, other.y1) in fixed_boxes
                      else (other.y1 + source.y0) / 2 + min(3, gap / 4))
        elif other.y0 >= source.y1:
            gap = other.y0 - source.y1
            padding = max(3, gap / 2 - 3)
            bottom = min(bottom, other.y0 - padding if (other.x0, other.y0, other.x1, other.y1) in fixed_boxes
                         else (source.y1 + other.y0) / 2 - min(3, gap / 4))
        else:
            # A figure or neighboring box alongside this text is not free space.
            top, bottom = max(top, source.y0), min(bottom, source.y1)
    return fitz.Rect(rect.x0, min(source.y0, top), rect.x1, max(source.y1, bottom)) & bounds


def _content(text: str, images: dict[str, str]) -> str:
    escaped = html.escape(text)
    # Keep short parenthesized terms / citations together, including inline math.
    def keep_together(match: re.Match) -> str:
        value = match[0]
        if len(MATH_TOKEN.sub("x", value)) > 12:
            return value
        return '<span style="white-space:nowrap">' + value + "</span>"
    escaped = re.sub(r"（[^（）\n]+）|\([^()\n]+\)|\[[0-9, –-]{1,25}\]", keep_together, escaped)
    for token, image in images.items():
        escaped = escaped.replace(token, image)
    return escaped


def first_line_indented(block: dict) -> bool:
    """Preserve source paragraph indentation, not PDF block boundaries.

    The placement box already preserves whole-block offsets (e.g. a one-line
    paragraph or a list). Add an em only for a first line inset within that box.
    Regions on the same row can be separate fragments around tall inline math.
    Unknown geometry deliberately does not invent a paragraph start.
    """
    if block.get("paragraph_continuation"):
        return False
    regions = [fitz.Rect(r) for r in block.get("regions", [])]
    if not regions:
        return False
    first = min(regions, key=lambda r: (r.y0, r.x0))
    row = [r for r in regions if min(r.y1, first.y1) - max(r.y0, first.y0)
           >= min(r.height, first.height) * .4]
    inset = min(r.x0 for r in row) - block["bbox"][0]
    size = max(1, block["font_size"])
    return size * .35 <= inset <= size * 2.5


# Translation text color, and the one used on a dark background (white text in a dark panel).
TEXT_COLOR = "#161c24"
LIGHT_TEXT_COLOR = "#f4f6f8"


def text_html(text: str, style: TextStyle, images: dict[str, str], *,
              first_indent: bool = False, color: str = TEXT_COLOR,
              story_canvas: bool = False) -> str:
    heading = style.role in {"title", "section", "subsection"}
    family = "PapeerHeading" if heading else "PapeerSerif"
    weight = "bold" if heading else "normal"
    paragraphs = []
    bottom_descent = 0.0
    # A block split into several translation units continues the same paragraph.
    for index, line in enumerate(resolve_unit_joins(text).splitlines()):
        if not line.strip():
            continue
        line_images = dict(images)
        bottom_descent = 0.0
        for token in MATH_TOKEN.findall(line):
            markup = images.get(token, '')
            height = re.search(r'height:([\d.]+)em', markup)
            offset = re.search(r'vertical-align:([-\d.]+)em', markup)
            if height and offset:
                descent = -float(offset[1])
                if float(height[1]) > 1.4 or descent > .45:
                    # Story ignores inline line-height, but a font strut grows
                    # just the affected row. Do not enlarge every body row.
                    strut = max(float(height[1]) + .8, 2 * descent + 1.2)
                    line_images[token] = ('<span data-papeer-tall-math="1" style="white-space:nowrap">' + markup
                        + f'<span style="font-size:{strut:.4f}em">&#8203;</span></span>')
                    bottom_descent = max(bottom_descent, descent)
        content = _content(line.strip(), line_images)
        if style.role == "algorithm":
            content = content.replace("  ", "&nbsp; ")
        if style.role == "runin" and index == 0:
            match = re.match(r"^(\d+(?:\.\d+)+\.?\s*\S+?)(?:\u3000|\s)(.+)$", line.strip())
            if match:
                content = ('<span style="font-family:PapeerHeading;font-weight:bold">'
                           + _content(match[1], images) + "</span>　" + _content(match[2], images))
        # Only the source first-line geometry authorizes automatic indentation.
        indent = "1em" if style.role == "body" and not paragraphs and first_indent else "0"
        gap = ".35em" if paragraphs and style.role == "body" else "0"
        paragraphs.append(f'<p style="margin:{gap} 0 0;padding:0;text-indent:{indent}">{content}</p>')
    if bottom_descent > .45 and not story_canvas:
        # Story's fit excludes negative vertical-align overflow from its last
        # line. A real (invisible) text row reserves that tail before clipping
        # the temporary PDF; padding/empty blocks are ignored by fit_scale.
        paragraphs.append(f'<p style="margin:0;padding:0;line-height:{bottom_descent + .2:.4f}">&#8203;</p>')
    return (f'<div lang="ja" style="font-family:{family};font-weight:{weight};font-size:{style.size}pt;'
            f'line-height:{style.leading};color:{color};margin:0;padding:0">' + "".join(paragraphs) + "</div>")
