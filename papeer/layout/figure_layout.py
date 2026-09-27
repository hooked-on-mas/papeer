"""Protect vector plot labels and ticks along with the plotted geometry."""
from __future__ import annotations

import re
import pymupdf as fitz


def figure_regions(page: fitz.Page) -> list[fitz.Rect]:
    rotation = page.rotation
    try:
        page.set_rotation(0)
        seeds = []
        for drawing in page.get_drawings():
            rect = fitz.Rect(drawing["rect"])
            if rect.width < 60 or rect.height < 35:
                continue
            ticks = []
            for item in drawing["items"]:
                if item[0] != "l":
                    continue
                a, b = item[1:3]
                dx, dy = abs(a.x - b.x), abs(a.y - b.y)
                if (.5 < dx < 8 and dy < .1) or (.5 < dy < 8 and dx < .1):
                    ticks.append(a)
            if len(ticks) < 8:
                continue
            if (max(p.x for p in ticks) - min(p.x for p in ticks) < rect.width * .7
                    and max(p.y for p in ticks) - min(p.y for p in ticks) < rect.height * .7):
                continue
            seeds.append(rect)
        # Multiple axis paths, inset axes, and data curves share one plot.
        regions = []
        for rect in seeds:
            overlaps = [r for r in regions if r.intersects(rect)]
            for other in overlaps:
                rect |= other
                regions.remove(other)
            regions.append(rect)
        lines = [line for block in page.get_text("dict")["blocks"]
                 for line in block.get("lines", [])]
        result = []
        for rect in regions:
            nearby = fitz.Rect(rect.x0 - 40, rect.y0 - 16, rect.x1 + 8, rect.y1 + 26)
            for line in lines:
                text = "".join(span["text"] for span in line["spans"]).strip()
                if re.match(r"(?:Fig(?:ure)?\.?|Table)\s*\d", text, re.I):
                    continue
                box = fitz.Rect(line["bbox"])
                if box in nearby and len(text) < 100:
                    rect |= box
            result.append(rect & page.rect)
        return result
    finally:
        page.set_rotation(rotation)


# "Fig. 3", "Figure 3:" or "TABLE II." but not prose such as "Figure 6 shows ...".
CAPTION = re.compile(r"(?:Fig(?:ure)?|Table)\.?\s*(?:\d+|[IVX]+)(?:[.:]|$)", re.I)


def raster_figures(page: fitz.Page, exclude: list[fitz.Rect]) -> list[fitz.Rect]:
    """Regions of embedded raster images large enough to be figures (expects rotation 0)."""
    regions = []
    for info in page.get_image_info():
        rect = fitz.Rect(info["bbox"]) & page.rect
        # Skip icons and logos, and full-page scans where the image is the page itself.
        if rect.width < 60 or rect.height < 40 or rect.get_area() > page.rect.get_area() * .8:
            continue
        # Panels (a), (b), ... of one figure are often separate images placed edge to edge.
        grown = fitz.Rect(rect.x0 - 4, rect.y0 - 4, rect.x1 + 4, rect.y1 + 4)
        for other in [r for r in regions if r.intersects(grown)]:
            rect |= other
            regions.remove(other)
        regions.append(rect)
    regions = [rect for rect in regions if not any(rect.intersects(other) for other in exclude)]
    return sorted(regions, key=lambda r: (r.y0, r.x0))


def figure_caption(page: fitz.Page, rect: fitz.Rect, limit: int = 200) -> str:
    """The "Fig. N ..." or "Table N ..." caption just below or above a region (expects rotation 0)."""
    match = figure_caption_match(page, rect)
    if match is None:
        return ""
    text = match[1]
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def figure_caption_match(page: fitz.Page, rect: fitz.Rect) -> tuple[fitz.Rect, str] | None:
    """Return the caption's location and full text, so panels can share one identity."""
    best = None
    for block in page.get_text("dict")["blocks"]:
        lines = block.get("lines", [])
        for index, line in enumerate(lines):
            text = "".join(span["text"] for span in line["spans"]).strip()
            box = fitz.Rect(line["bbox"])
            if not CAPTION.match(text) or box.x1 < rect.x0 or box.x0 > rect.x1:
                continue
            gap = box.y0 - rect.y1 if box.y0 >= rect.y1 - 2 else rect.y0 - box.y1
            if -2 <= gap <= 40 and (best is None or gap < best[0]):
                best = gap, lines[index:], box
    if best is None:
        return None
    text = " ".join("".join(span["text"] for span in line["spans"]) for line in best[1])
    text = " ".join(text.split())
    return best[2], text
