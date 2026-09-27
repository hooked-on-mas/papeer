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


# Drawing paths within this distance belong to the same diagram (boxes, arrows, curves).
_DIAGRAM_GAP = 6
# A diagram has at least this many separate paths; one frame or a few rules is a decorated box.
_DIAGRAM_PATHS = 6
# ... and several of them are boxes, arrows or curves (not only bullets and dots in a frame).
_DIAGRAM_SHAPES = 3


def _prose_line(text: str) -> bool:
    """A sentence rather than a diagram label: long, or several words."""
    return len(text) > 40 or len(re.findall(r"[A-Za-z]{2,}", text)) >= 6


def _listed(lines: list[tuple[fitz.Rect, str]], count: int = 4) -> bool:
    """At least count worded lines one below another at the same left edge and evenly spaced:
    a list or a table column, not scattered diagram labels. Numbers alone (axis ticks) do not count."""
    worded = sorted((box for box, text in lines if re.search(r"[A-Za-z]{2}", text)), key=lambda box: box.x0)
    columns: list[list[fitz.Rect]] = []
    for box in worded:
        if columns and box.x0 - columns[-1][0].x0 <= 2:
            columns[-1].append(box)
        else:
            columns.append([box])
    for column in columns:
        column.sort(key=lambda box: box.y0)
        run, gap = 1, None
        for above, below in zip(column, column[1:]):
            step = below.y0 - above.y0
            if 0 < step <= max(above.height, below.height) * 3 and gap is not None and abs(step - gap) <= max(1.5, gap * .15):
                run += 1
            else:
                run = 2 if 0 < step <= max(above.height, below.height) * 3 else 1
            gap = step
            if run >= count:
                return True
    return False


def diagram_regions(page: fitz.Page, exclude: list[fitz.Rect]) -> list[fitz.Rect]:
    """Diagrams without axis ticks (flowcharts, block diagrams, bar charts): dense boxes and
    lines whose text is only short labels. Their labels keep the original like a plot's.

    Conservative on purpose, because a region taken as a figure is no longer translated: any
    sentence, caption or dense text in or across the region rejects it, and regions touching
    exclude (plots, tables, algorithms) are left to those detectors.
    """
    rotation = page.rotation
    try:
        page.set_rotation(0)
        area = page.rect.get_area()
        # [x0, y0, x1, y1, paths, paths at least 10pt long]; plain numbers, as pages can hold
        # thousands of paths.
        groups: list[list[float]] = []
        for drawing in page.get_drawings():
            rect = fitz.Rect(drawing["rect"])
            # Page backgrounds, long horizontal rules (tables, headers, footnote separators) and
            # long vertical rules (between columns).
            if (rect.get_area() > area * .5 or (rect.height < 1.5 and rect.width > 60)
                    or (rect.width < 1.5 and rect.height > 60)):
                continue
            groups.append([rect.x0, rect.y0, rect.x1, rect.y1, 1, int(max(rect.width, rect.height) >= 10)])
        # Merge until stable: a grown group can come within reach of one made earlier.
        while True:
            merged: list[list[float]] = []
            for group in groups:
                x0, y0, x1, y1 = group[0] - _DIAGRAM_GAP, group[1] - _DIAGRAM_GAP, group[2] + _DIAGRAM_GAP, group[3] + _DIAGRAM_GAP
                near = [g for g in merged if g[0] <= x1 and g[2] >= x0 and g[1] <= y1 and g[3] >= y0]
                for other in near:
                    merged.remove(other)
                    group = [min(group[0], other[0]), min(group[1], other[1]), max(group[2], other[2]),
                             max(group[3], other[3]), group[4] + other[4], group[5] + other[5]]
                merged.append(group)
            if len(merged) == len(groups):
                break
            groups = merged
        clusters = [(fitz.Rect(g[:4]), g[4], g[5]) for g in groups]
        candidates = [rect for rect, count, shapes in clusters
                      if count >= _DIAGRAM_PATHS and shapes >= _DIAGRAM_SHAPES and rect.width >= 60 and rect.height >= 35
                      and not any(rect.intersects(other) for other in exclude)]
        if not candidates:
            return []
        lines = [(fitz.Rect(line["bbox"]), "".join(span["text"] for span in line["spans"]).strip())
                 for block in page.get_text("dict")["blocks"] for line in block.get("lines", [])]
        lines = [(box, text) for box, text in lines if text]

        def labels(rect: fitz.Rect) -> list[fitz.Rect] | None:
            """The label boxes of a diagram region, or None when it is not one."""
            if any(rect.intersects(other) for other in exclude):
                return None
            inner = fitz.Rect(rect.x0 + 1, rect.y0 + 1, rect.x1 - 1, rect.y1 - 1)
            touching = [(box, text) for box, text in lines if box.intersects(inner)]
            # Only labels: no sentence or caption may lose glyphs to the region, and a framed
            # list of short items (with icons) or a table of words is not a diagram either.
            if (not touching or any(_prose_line(text) or CAPTION.match(text) for _, text in touching)
                    or _listed(touching)):
                return None
            # Text filling the boxes is not a diagram's labels.
            if sum((box & rect).get_area() for box, _ in touching) > rect.get_area() * .3:
                return None
            return [box for box, _ in touching]

        result: list[fitz.Rect] = []
        for rect in candidates:
            label_boxes = labels(rect)
            if not label_boxes:
                continue
            for box in label_boxes:
                rect |= box
            # Labels sticking out of the drawing must not bring prose, tables or plots into the
            # region, nor make its text too dense: judge the grown region again.
            if labels(rect) is None:
                continue
            for other in [r for r in result if r.intersects(rect)]:
                rect |= other
                result.remove(other)
            result.append(rect & page.rect)
        return sorted(result, key=lambda r: (r.y0, r.x0))
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
