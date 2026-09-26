"""Japanese reading typography, fitted to the source paper's column geometry."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import html
from pathlib import Path
import re
from statistics import median

import pymupdf as fitz
from fontTools import subset
from fontTools.ttLib import TTFont

from papeer.layout.math_layout import MATH_TOKEN
from papeer.pdf.pdf_fonts import truetype_subset


FONT_DIRECTORY = Path(__file__).resolve().parent.parent / "core" / "assets" / "fonts"
FONT_CSS = """
@font-face { font-family: PapeerSerif; src: url(PapeerSerif-Regular.ttf); }
@font-face { font-family: PapeerHeading; src: url(PapeerHeading-Bold.ttf); font-weight: bold; }
html, body { margin: 0; padding: 0; }
body { padding: 1pt; }
"""
_NUMBERED = re.compile(r"^(\d+(?:\.\d+)*\.?|[IVX]+\.)\s+(.+)$", re.S)
_NAMED_HEADINGS = {"abstract", "introduction", "background", "methods", "method", "results",
                   "discussion", "conclusion", "conclusions", "references", "acknowledgments",
                   "acknowledgements", "appendix", "results and limitations"}


@lru_cache(maxsize=4)
def _font_subsets(characters: str) -> tuple[tuple[bytes, str], ...]:
    fonts = []
    for name in ("SourceHanSerifJP-Regular.otf", "SourceHanSansJP-Bold.otf"):
        with TTFont(FONT_DIRECTORY / name, recalcTimestamp=False) as font:
            options = subset.Options()
            options.layout_features = ["*"]
            options.desubroutinize = True
            subsetter = subset.Subsetter(options=options)
            subsetter.populate(text=characters)
            subsetter.subset(font)
            family, style = ("PapeerSerif", "Regular") if "Serif" in name else ("PapeerHeading", "Bold")
            fonts.append((truetype_subset(font, family, style), f"{family}-{style}.ttf"))
    return tuple(fonts)


def font_archive(text: str) -> fitz.Archive:
    # Subset only our own font assets. Original PDF math fonts remain untouched.
    characters = "".join(sorted(set(text + "　 ")))
    archive = fitz.Archive()
    for font in _font_subsets(characters):
        archive.add(font)
    return archive


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


def text_style(block: dict, body_size: float, page_height: float) -> TextStyle:
    if block.get("kind") == "algorithm":
        return TextStyle("algorithm", block["font_size"], 1.05)
    text = " ".join(block["text"].split())
    rect = fitz.Rect(block["bbox"])
    if block.get("running_header"):
        return TextStyle("footer", min(8, body_size * .85), 1.2)
    numbered = _NUMBERED.match(text)
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
            and rect.width > 200 and len(text.split()) >= 8 and len(text) < 240
            and text.isupper() and not block.get("formulas")):
        return TextStyle("title", 17, 1.25)
    if (rect.y0 > page_height * 0.93
            or (rect.y1 < page_height * 0.045 and len(text) < 180)
            or (rect.y1 < page_height * .12 and len(text) < 180
                and re.search(r"\b(?:JOURNAL|VOL\.|ISSN|IEEE TRANSACTIONS)\b", text, re.I))
            or (block.get("page", 1) > 1 and rect.y1 < page_height * .15
                and block["font_size"] <= body_size * .85 and len(text) < 180)):
        return TextStyle("footer", min(8, body_size * 0.85), 1.2)
    if numbered and re.match(r"\d+\.\d+", numbered[1]) and re.match(r"[^.!?]{1,45}\.\s+\w", numbered[2]):
        return TextStyle("runin", body_size, 1.4)
    if short and not re.search(r"[。!?]$", text) and (
            (numbered and not text.endswith(".")) or text.lower().rstrip(":") in _NAMED_HEADINGS):
        if numbered and "." in numbered[1].rstrip("."):
            return TextStyle("subsection", body_size * 1.18, 1.2)
        return TextStyle("section", body_size * 1.34, 1.2)
    if short and block["font_size"] >= body_size * 1.5:
        return TextStyle("title", min(26, max(17, block["font_size"])), 1.25)
    return TextStyle("body", body_size, 1.4)


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
    # A short equation lead-in often occupies only a fraction of its column.
    # Infer the column from nearby prose, then stop at any same-row content.
    if style.role == "body" and source.height < style.size * 3:
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
    body_size = body_font_size([b for b in blocks if "text" in b and "font_size" in b])
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
    for other in barriers:
        if other.x1 <= rect.x0 or other.x0 >= rect.x1:
            continue
        if other.y1 <= source.y0:
            top = max(top, (other.y1 + source.y0) / 2 + 3)
        elif other.y0 >= source.y1:
            bottom = min(bottom, (source.y1 + other.y0) / 2 - 3)
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


def text_html(text: str, style: TextStyle, images: dict[str, str], *,
              first_indent: bool = False) -> str:
    heading = style.role in {"title", "section", "subsection"}
    family = "PapeerHeading" if heading else "PapeerSerif"
    weight = "bold" if heading else "normal"
    color = "#161c24"
    paragraphs = []
    for index, line in enumerate(text.splitlines()):
        if not line.strip():
            continue
        content = _content(line.strip(), images)
        if style.role == "algorithm":
            content = content.replace("  ", "&nbsp; ")
        if style.role == "runin" and index == 0:
            match = re.match(r"^(\d+(?:\.\d+)+\.?\s*\S+?)(?:\u3000|\s)(.+)$", line.strip())
            if match:
                content = ('<span style="font-family:PapeerHeading;font-weight:bold">'
                           + _content(match[1], images) + "</span>　" + _content(match[2], images))
        # A newline can be a translation-unit split, not a new paragraph.
        # Only the source first-line geometry authorizes automatic indentation.
        indent = "1em" if style.role == "body" and not paragraphs and first_indent else "0"
        gap = ".35em" if paragraphs and style.role == "body" else "0"
        paragraphs.append(f'<p style="margin:{gap} 0 0;padding:0;text-indent:{indent}">{content}</p>')
    return (f'<div lang="ja" style="font-family:{family};font-weight:{weight};font-size:{style.size}pt;'
            f'line-height:{style.leading};color:{color};margin:0;padding:0">' + "".join(paragraphs) + "</div>")

