"""Protect vector plot labels and ticks along with the plotted geometry."""
from __future__ import annotations

import re
from statistics import median
from typing import cast, Sequence

import pymupdf as fitz


def _axis_frames(drawings: list[dict]) -> list[fitz.Rect]:
    """Find plot frames even when every tick is a separate PDF path.

    Only short segments perpendicular to a frame edge count. Marker squares
    and error bars inside the plot cannot establish an axis on their own.
    """
    frames, vertical, horizontal, x_axes, y_axes = [], [], [], [], []
    for drawing in drawings:
        for item in drawing["items"]:
            if item[0] == "re":
                box = fitz.Rect(item[1])
                if box.width >= 60 and box.height >= 35:
                    frames.append(box)
            elif item[0] == "l":
                a, b = item[1:3]
                dx, dy = abs(a.x - b.x), abs(a.y - b.y)
                if dx < .1 and .5 < dy < 8:
                    vertical.append((a, b))
                elif dy < .1 and .5 < dx < 8:
                    horizontal.append((a, b))
                elif dy < .1 and dx >= 60:
                    x_axes.append((min(a.x, b.x), max(a.x, b.x), a.y))
                elif dx < .1 and dy >= 35:
                    y_axes.append((a.x, min(a.y, b.y), max(a.y, b.y)))

    # Open axes, and frames drawn one edge at a time, have no rectangle command.
    # A pair of long perpendicular edges sharing an endpoint defines the same
    # candidate bounds; it still needs distributed ticks to become a plot.
    for left, right, y in x_axes:
        for x, top, bottom in y_axes:
            if min(abs(x - left), abs(x - right)) < .5 and min(abs(y - top), abs(y - bottom)) < .5:
                frames.append(fitz.Rect(left, top, right, bottom))

    def distributed(positions: list[float], extent: float) -> bool:
        distinct = []
        for position in sorted(positions):
            if not distinct or position - distinct[-1] > 1:
                distinct.append(position)
        return len(distinct) >= 4 and distinct[-1] - distinct[0] >= extent * .7

    result = []
    for box in frames:
        xs = [a.x for a, b in vertical if box.x0 - .5 <= a.x <= box.x1 + .5
              and any(min(abs(a.y - edge), abs(b.y - edge)) < .5 for edge in (box.y0, box.y1))]
        ys = [a.y for a, b in horizontal if box.y0 - .5 <= a.y <= box.y1 + .5
              and any(min(abs(a.x - edge), abs(b.x - edge)) < .5 for edge in (box.x0, box.x1))]
        if distributed(xs, box.width) or distributed(ys, box.height):
            result.append(box)
    return result


def _plot_label(text: str) -> bool:
    sentence = (text.endswith(('。', '！', '？')) or
                (bool(re.search(r'[.!?]$', text)) and len(re.findall(r'[A-Za-z]{2,}', text)) >= 3))
    numeric_axis = (len(re.findall(r'\d', text)) >= 3
                    and len(re.findall(r'[A-Za-z]{2,}', text)) <= 4)
    return (bool(text) and not sentence and (not _prose_line(text) or numeric_axis)
            and not re.match(r"(?:Fig(?:ure)?\.?|Table)\s*(?:\d|[IVX])", text, re.I))


def figure_regions(page: fitz.Page) -> list[fitz.Rect]:
    rotation = page.rotation
    try:
        page.set_rotation(0)
        drawings = page.get_drawings()
        seeds = _axis_frames(drawings) + raster_figures(page, [])
        for drawing in drawings:
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
        lines = [(fitz.Rect(line["bbox"]), "".join(span["text"] for span in line["spans"]).strip(),
                  max(span["size"] for span in line["spans"]))
                 for block in cast(dict, page.get_text("dict"))["blocks"] for line in block.get("lines", [])]
        blockers = [box for box, text, _ in lines if text and not _plot_label(text)]
        result = []
        for rect in regions:
            # Embedded images can be invisible or stale backing objects under
            # live paragraph text. A seed that bisects a sentence is not a
            # figure boundary: never remove those prose glyphs from translation.
            cut_prose = [box for box, text, _ in lines if _prose_line(text)
                         and box.intersects(rect)
                         and (box.x0 < rect.x0 - 2 or box.x1 > rect.x1 + 2)]
            if cut_prose:
                continue
            # Label margins follow the local type size, so a scaled plot keeps
            # superscripts and axis titles just as the smaller original does.
            neighborhood = fitz.Rect(rect.x0 - rect.width * .2, rect.y0 - rect.height * .3,
                                     rect.x1 + rect.width * .2, rect.y1 + rect.height * .3)
            sizes = [size for box, text, size in lines if box.intersects(neighborhood) and _plot_label(text)]
            scale = max(1, median(sizes) / 7) if sizes else 1
            nearby = fitz.Rect(rect.x0 - 40 * scale, rect.y0 - 16 * scale,
                               rect.x1 + 8 * scale, rect.y1 + 26 * scale)
            for box, text, _ in lines:
                if box in nearby and _plot_label(text):
                    grown = rect | box
                    # Expanding a rectangular figure for a label must not cover
                    # adjacent prose or the beginning of its caption.
                    if not any((grown & barrier).get_area() > (rect & barrier).get_area() + .5
                               for barrier in blockers):
                        rect = grown
            result.append(rect & page.rect)
        return result
    finally:
        page.set_rotation(rotation)


def restore_plot_labels(page: fitz.Page, blocks: list[dict]) -> tuple[list[dict], list[str]]:
    """Repair old figure bounds for rendering without changing cached translation IDs.

    Fresh extraction uses figure_regions before splitting text. An older cache
    can instead contain an axis label as prose, partially inside its figure.
    Reconcile only existing figures with newly detected plots; preserve their
    compact labels directly from the original PDF, keeping prose translatable.
    """
    figures = [b for b in blocks if b.get("kind") == "figure"]
    if not figures:
        return blocks, []
    plots = figure_regions(page)
    replacements, protected = {}, []
    for figure in figures:
        box = fitz.Rect(figure["bbox"])
        matches = [plot for plot in plots
                   if (plot & box).get_area() >= min(plot.get_area(), box.get_area()) * .8
                   and max(plot.get_area(), box.get_area()) <= min(plot.get_area(), box.get_area()) * 3]
        if not matches:
            continue
        for plot in matches:
            box |= plot
        coordinates = [box.x0, box.y0, box.x1, box.y1]
        replacements[figure["id"]] = dict(figure, bbox=coordinates, regions=[coordinates])
        protected.append(box)
    kept, labels = [], []
    for block in blocks:
        if (block.get("kind") in {"text", "formula"} and not block.get("algorithm_step")
                and _plot_label(block["text"].strip())
                and any(fitz.Rect(block["bbox"]) in box for box in protected)):
            labels.append(block["id"])
        else:
            kept.append(replacements.get(block["id"], block))
    return kept, labels


# Drawing paths within this distance belong to the same diagram (boxes, arrows, curves).
_DIAGRAM_GAP = 6
# A diagram has at least this many separate paths; one frame or a few rules is a decorated box.
_DIAGRAM_PATHS = 6
# ... and several of them are boxes, arrows or curves (not only bullets and dots in a frame).
_DIAGRAM_SHAPES = 3


def _prose_line(text: str) -> bool:
    """A sentence rather than a diagram label: long, or several words."""
    return len(text) > 40 or len(re.findall(r"[A-Za-z]{2,}", text)) >= 6


def raster_crosses_prose(page: fitz.Page, rect: fitz.Rect) -> bool:
    """An image's metadata rectangle must not cut through live sentences."""
    for block in cast(dict, page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES))['blocks']:
        for line in block.get('lines', []):
            box = fitz.Rect(line['bbox'])
            text = ''.join(s['text'] for s in line['spans']).strip()
            if (_prose_line(text) and box.intersects(rect)
                    and (box.x0 < rect.x0 - 2 or box.x1 > rect.x1 + 2)):
                return True
    return False


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


def diagram_regions(page: fitz.Page, exclude: list[fitz.Rect], *,
                    embedded: Sequence[fitz.Rect] = ()) -> list[fitz.Rect]:
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
        drawings = page.get_drawings()
        for drawing in drawings:
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
        def fixed_overlap(rect):
            return any(rect.intersects(other) and not (
                other in embedded and (other & rect).get_area() >= other.get_area() * .98)
                for other in exclude)
        candidates = [rect for rect, count, shapes in clusters
                      if count >= _DIAGRAM_PATHS and shapes >= _DIAGRAM_SHAPES and rect.width >= 60 and rect.height >= 35
                      and not fixed_overlap(rect)]
        if not candidates:
            return []
        raw_lines = [line for block in cast(dict, page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES))["blocks"]
                     for line in block.get("lines", [])]
        lines = [(fitz.Rect(line["bbox"]), "".join(span["text"] for span in line["spans"]).strip())
                 for line in raw_lines]
        lines = [(box, text) for box, text in lines if text]
        sizes = {tuple(line['bbox']): max(s['size'] for s in line['spans']) for line in raw_lines}
        body = [sizes[(box.x0, box.y0, box.x1, box.y1)] for box,text in lines if len(text) > 60]
        body_size = median(body) if body else 10

        def labels(rect: fitz.Rect) -> list[fitz.Rect] | None:
            """The label boxes of a diagram region, or None when it is not one."""
            if fixed_overlap(rect):
                return None
            inner = fitz.Rect(rect.x0 + 1, rect.y0 + 1, rect.x1 - 1, rect.y1 - 1)
            touching = [(box, text) for box, text in lines if box.intersects(inner)]
            # A trajectory plot can have no axes, and a four-row legend looks
            # like a list. A nearby figure caption plus several long diagonal
            # segments distinguishes it from a framed list or box diagram.
            diagonal = sum(1 for drawing in drawings if fitz.Rect(drawing["rect"]).intersects(rect)
                           for item in drawing["items"] if item[0] == "l"
                           and abs(item[1].x - item[2].x) >= 10 and abs(item[1].y - item[2].y) >= 10)
            plot_legend = diagonal >= 4 and figure_caption_match(page, rect) is not None
            # Only labels: no sentence or caption may lose glyphs to the region, and a framed
            # list of short items (with icons) or a table of words is not a diagram either.
            prose = lambda box,text: (_prose_line(text) and (
                sizes[(box.x0, box.y0, box.x1, box.y1)] >= body_size * .8 or len(text) > 80 or text.endswith(('.', '。'))))
            if (not touching or any(prose(box,text) or CAPTION.match(text) for box, text in touching)
                    or (_listed(touching) and not plot_legend)):
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


def raster_figures(page: fitz.Page, exclude: list[fitz.Rect], *, include_strips: bool = False) -> list[fitz.Rect]:
    """Regions of embedded raster images large enough to be figures (expects rotation 0)."""
    regions = []
    for info in page.get_image_info():
        rect = fitz.Rect(info["bbox"]) & page.rect
        # Skip icons and logos, and full-page scans where the image is the page itself.
        if (rect.width < (4 if include_strips else 60) or rect.height < (4 if include_strips else 40)
                or rect.get_area() > page.rect.get_area() * .8):
            continue
        if raster_crosses_prose(page, rect):
            continue
        # Panels (a), (b), ... of one figure are often separate images placed edge to edge.
        grown = fitz.Rect(rect.x0 - 4, rect.y0 - 4, rect.x1 + 4, rect.y1 + 4)
        for other in [r for r in regions if r.intersects(grown)]:
            rect |= other
            regions.remove(other)
        regions.append(rect)
    regions = [rect for rect in regions if rect.width >= 60 and rect.height >= 40
               and not any(rect.intersects(other) for other in exclude)]
    return sorted(regions, key=lambda r: (r.y0, r.x0))


def figure_caption(page: fitz.Page, rect: fitz.Rect, limit: int = 200) -> str:
    """The "Fig. N ..." or "Table N ..." caption just below or above a region (expects rotation 0)."""
    match = figure_caption_match(page, rect)
    if match is None:
        return ""
    text = match[1]
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def figure_caption_match(page: fitz.Page, rect: fitz.Rect,
                         pattern: re.Pattern = CAPTION, *, prefer_placement: bool = False) -> tuple[fitz.Rect, str] | None:
    """Return the caption's location and full text, so panels can share one identity."""
    best = None
    blocks = cast(dict, page.get_text("dict"))["blocks"]
    for block in blocks:
        lines = block.get("lines", [])
        for index, line in enumerate(lines):
            text = "".join(span["text"] for span in line["spans"]).strip()
            box = fitz.Rect(line["bbox"])
            if not pattern.match(text):
                continue
            baseline = line["spans"][0]["origin"][1]
            caption_lines = list(lines[index:])
            for following in lines[index + 1:]:
                start = fitz.Rect(following["bbox"])
                if abs(following["spans"][0]["origin"][1] - baseline) <= 2:
                    box |= start
            # Bind the caption using the whole first row, including a separately positioned description.
            for other in blocks:
                following = other.get("lines", [])
                if (following and other is not block
                        and abs(following[0]["spans"][0]["origin"][1] - baseline) <= 2):
                    start = fitz.Rect(following[0]["bbox"])
                    if 0 <= start.x0 - box.x1 <= 40:
                        caption_lines.extend(following)
                        box |= start
            if box.x1 < rect.x0 or box.x0 > rect.x1:
                continue
            gap = box.y0 - rect.y1 if box.y0 >= rect.y1 - 2 else rect.y0 - box.y1
            # Raw plot paths omit axis labels: the previous figure's caption may be closer than
            # this figure's own caption. For summaries prefer figures below and tables above.
            preferred = (box.y1 <= rect.y0 + 2) if text.lower().startswith("table") else (box.y0 >= rect.y1 - 2)
            if prefer_placement and not text.lower().startswith("table") and not preferred:
                continue  # A top panel belongs to its following shared caption, not the preceding figure.
            score = (int(prefer_placement and not preferred), gap)
            if -2 <= gap <= 40 and (best is None or score < best[0]):
                best = score, caption_lines, box
    if best is None:
        return None
    text = " ".join("".join(span["text"] for span in line["spans"]) for line in best[1])
    text = " ".join(text.split())
    return best[2], text
