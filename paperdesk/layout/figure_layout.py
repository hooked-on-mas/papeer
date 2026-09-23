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
