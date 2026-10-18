"""Text, formula and figure regions of a scanned page, in reading order (Pillow only).

OCR engines read a whole page line by line across both columns of a two-column paper, so the
page is cut into regions first and each run of text is read on its own:

1. Background and ink: the paper's color is estimated locally (a max filter over a coarse copy of
   the page, so that uneven lighting is not ink) and pixels clearly darker than it are ink.
2. Skew: the ink, reduced to about one cell per point, is turned by small angles until its row
   profiles are sharpest. The left and right halves are scored separately, so that two columns
   whose lines are out of step do not pull the angle. The page is turned back by that angle.
3. Connected components of the ink dilated along the lines (words -> lines) and across them
   (lines -> paragraphs).
4. Figures: graphics much taller than a text line (or dense fills) are figure cores; the small
   labels around them (ticks, legends) and the ends of their frame lines join them.
5. X-Y cut of the rest. Horizontal bands that share a column gutter are merged first, so a
   two-column body is read column by column even where the paragraph gaps of both columns line
   up, and a band on one side of the gutter (the end of a longer column) stays in its column.
6. Each leaf is "text", "math" (a block of at most three rows with a symbol much taller than a
   line: a sum, an integral, a tall bracket) or "figure". A short line off the column edge is a
   display formula or an equation number, but also a centered heading or author line: it is
   "math" with `uncertain` set, and the OCR text decides (papeer.pdf.pdf_ocr).

Coordinates are pixels of PageLayout.image, the page turned back by PageLayout.angle.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import math
import statistics

from PIL import Image, ImageChops, ImageFilter

Box = tuple[int, int, int, int]

# Ink is darker than the local paper color by at least this much (0-255), scaled down on
# low-contrast scans (a share of the contrast between the paper and the darkest ink).
INK_DELTA_MAX = 60
INK_DELTA_MIN = 30
INK_CONTRAST_SHARE = .35
# Dilation, in cells of about one point: bridges the gaps between words (x) and the leading (y).
RX, RY = 2, 1
# A column gutter is at least this many cells wide after the dilation.
GX_MIN = 6
# Skew search range and the smallest angle that is corrected (degrees).
SKEW_LIMIT = 3.0
SKEW_MIN = .15
# Text regions are padded by this many cells, so that the OCR sees the whole glyphs.
PAD = 2


@dataclass
class Region:
    kind: str  # "text", "math" or "figure"
    box: Box
    rows: int = 0
    # "math" judged by shape only (a short line off the column edge): a centered heading, an author
    # line or a display formula. The OCR text decides (papeer.pdf.pdf_ocr.prose_text).
    uncertain: bool = False


@dataclass
class TextBlock:
    """A unit for the OCR engine: consecutive text regions of one column."""
    box: Box
    members: list[int] = field(default_factory=list)  # indices into PageLayout.regions


@dataclass
class PageLayout:
    image: Image.Image  # the page in grayscale, turned back by angle
    angle: float  # degrees the scan was turned (Image.rotate convention: counterclockwise)
    cell: int  # pixels per cell of the masks
    line_height: float  # median height of a text line, in pixels
    background: int  # the paper's gray level
    regions: list[Region]  # text and math in reading order, then the figures
    blocks: list[TextBlock]  # the text regions grouped for OCR, in reading order

    def unrotate(self, x: float, y: float) -> tuple[float, float]:
        """Where a point of the turned-back image lies on the original page image."""
        return unrotate_point(x, y, self.angle, self.image.size)


def unrotate_point(x: float, y: float, angle: float, size: tuple[int, int]) -> tuple[float, float]:
    """The point of the original image that Image.rotate(angle) moved to (x, y) (same size, no expand)."""
    if not angle:
        return x, y
    cx, cy = size[0] / 2, size[1] / 2
    a = math.radians(angle)
    dx, dy = x - cx, y - cy
    # Image.rotate turns counterclockwise as seen, i.e. with y pointing down (dx, dy) -> (dx cos + dy sin,
    # -dx sin + dy cos); this is the inverse.
    return cx + dx * math.cos(a) - dy * math.sin(a), cy + dx * math.sin(a) + dy * math.cos(a)


# ---------------------------------------------------------------- masks

def _background(image: Image.Image) -> tuple[int, int]:
    """(paper gray level, ink threshold): the commonest level, and how much darker ink is."""
    histogram = image.histogram()
    background = max(range(256), key=histogram.__getitem__)
    total, seen, dark = sum(histogram), 0, 0
    for level, count in enumerate(histogram):
        seen += count
        if seen >= total * .002:
            dark = level
            break
    delta = int(max(INK_DELTA_MIN, min(INK_DELTA_MAX, (background - dark) * INK_CONTRAST_SHARE)))
    return background, delta


def _ink(image: Image.Image, dpi: float, background: int, delta: int) -> Image.Image:
    """Ink pixels (255) of a grayscale page, against the paper color around them."""
    step = max(1, round(dpi / 36))  # cells of about 2 pt
    coarse = image.reduce(step) if step > 1 else image
    # The lightest level within some 18 pt is the paper there (text never fills such a window). A
    # dark area larger than the window (a photo) is not paper: the page's paper color is used there.
    paper = coarse.filter(ImageFilter.MaxFilter(9))
    floor = background - 2 * delta
    paper = paper.point([v if v >= floor else background for v in range(256)])
    paper = paper.resize(image.size, Image.Resampling.BILINEAR)
    darker = ImageChops.subtract(paper, image)
    return darker.point([255 if v > delta else 0 for v in range(256)])


def _cells(ink: Image.Image, cell: int) -> Image.Image:
    """The ink reduced to cells: a cell is ink when it holds at least two ink pixels (no specks)."""
    if cell <= 1:
        return ink
    threshold = 255 * 1.5 / (cell * cell)
    return ink.reduce(cell).point([255 if v > threshold else 0 for v in range(256)])


def _dilate(mask: Image.Image, rx: int, ry: int) -> Image.Image:
    """Box dilation of a 0/255 mask by rx cells across and ry cells down (shifted copies, no wrap)."""
    if rx <= 0 and ry <= 0:
        return mask
    w, h = mask.size
    padded = Image.new("L", (w + 2 * rx, h + 2 * ry), 0)
    padded.paste(mask, (rx, ry))
    out = padded
    for dx in range(-rx, rx + 1):
        if dx:
            out = ImageChops.lighter(out, ImageChops.offset(padded, dx, 0))
    across = out
    for dy in range(-ry, ry + 1):
        if dy:
            out = ImageChops.lighter(out, ImageChops.offset(across, 0, dy))
    return out.crop((rx, ry, rx + w, ry + h))


def components(mask: Image.Image) -> list[tuple[int, int, int, int, int]]:
    """8-connected components of a 0/255 mask as (x0, y0, x1, y1, cells): union-find over row runs."""
    w, h = mask.size
    data = mask.tobytes()
    parent: list[int] = []
    runs: list[tuple[int, int, int]] = []

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    previous: list[tuple[int, int, int]] = []
    for y in range(h):
        row = data[y * w:(y + 1) * w]
        current: list[tuple[int, int, int]] = []
        x = row.find(b"\xff")
        j = 0
        while x >= 0:
            end = row.find(b"\x00", x)
            if end < 0:
                end = w
            index = len(runs)
            runs.append((y, x, end))
            parent.append(index)
            # Runs of the row above that touch this one (diagonals included).
            while j < len(previous) and previous[j][2] < x:
                j += 1
            k = j
            while k < len(previous) and previous[k][1] <= end:
                a, b = find(previous[k][0]), find(index)
                if a != b:
                    parent[b] = a
                k += 1
            current.append((index, x, end))
            x = row.find(b"\xff", end) if end < w else -1
        previous = current
    boxes: dict[int, list[int]] = {}
    for index, (y, start, end) in enumerate(runs):
        root = find(index)
        box = boxes.get(root)
        if box is None:
            boxes[root] = [start, y, end, y + 1, end - start]
        else:
            box[0] = min(box[0], start)
            box[2] = max(box[2], end)
            box[3] = y + 1
            box[4] += end - start
    return [(b[0], b[1], b[2], b[3], b[4]) for b in boxes.values()]


def _zero_runs(profile, min_len: int) -> list[tuple[int, int]]:
    """Internal runs of zeros (not touching either end) at least min_len long."""
    runs, start = [], None
    for i, value in enumerate(profile):
        if not value:
            if start is None:
                start = i
        elif start is not None:
            if start > 0 and i - start >= min_len:
                runs.append((start, i))
            start = None
    return runs


def _trim(mask: Image.Image, box: Box) -> Box | None:
    found = mask.crop(box).getbbox()
    if not found:
        return None
    return box[0] + found[0], box[1] + found[1], box[0] + found[2], box[1] + found[3]


def _ink_count(mask: Image.Image, box: Box) -> int:
    return mask.crop(box).histogram()[255]


# ---------------------------------------------------------------- skew

def estimate_skew(cells: Image.Image, limit: float = SKEW_LIMIT) -> float:
    """The angle (degrees, Image.rotate convention) that makes the text rows horizontal.

    Maximizes the variance of the row profiles of the left and right half of the page, each on its
    own: 0.25 degree steps, then 0.05 around the best.
    """
    w, h = cells.size
    if w < 8 or h < 8:
        return 0.0
    halves = ((0, 0, w // 2, h), (w // 2, 0, w, h))

    def score(angle: float) -> float:
        turned = cells.rotate(angle, resample=Image.Resampling.NEAREST) if angle else cells
        total = 0.0
        for half in halves:
            profile = turned.crop(half).resize((1, h), Image.Resampling.BOX).tobytes()
            mean = sum(profile) / h
            total += sum((v - mean) ** 2 for v in profile) / h
        return total

    steps = int(round(limit / .25))
    coarse = max((i * .25 for i in range(-steps, steps + 1)), key=lambda a: (score(a), -abs(a)))
    fine = max((coarse + i * .05 for i in range(-5, 6)), key=lambda a: (score(a), -abs(a)))
    return round(fine, 2)


# ---------------------------------------------------------------- X-Y cut

def _xy_cut(mask: Image.Image, box: Box, out: list[Box], gap: int, depth: int = 0) -> None:
    """Leaves of the recursive X-Y cut; gap is the smallest vertical gap between bands (cells)."""
    trimmed = _trim(mask, box)
    if trimmed is None:
        return
    x0, y0, x1, y1 = trimmed
    sub = mask.crop(trimmed)
    xprofile, yprofile = sub.getprojection()
    width = x1 - x0
    gutters = [g for g in _zero_runs(xprofile, GX_MIN) if g[0] > .1 * width and g[1] < .9 * width]
    if gutters and depth < 30:
        g = max(gutters, key=lambda g: g[1] - g[0])
        _xy_cut(mask, (x0, y0, x0 + g[0], y1), out, gap, depth + 1)
        _xy_cut(mask, (x0 + g[1], y0, x1, y1), out, gap, depth + 1)
        return
    gaps = _zero_runs(yprofile, gap)
    if not gaps or depth >= 30:
        out.append(trimmed)
        return
    cuts = [0] + [c for g in gaps for c in g] + [y1 - y0]
    bands = [(y0 + cuts[i], y0 + cuts[i + 1]) for i in range(0, len(cuts), 2)]

    def band_gutters(a: int, b: int) -> list[tuple[int, int]]:
        found = _trim(mask, (x0, a, x1, b))
        if found is None:
            return []
        xs, _ = mask.crop(found).getprojection()
        return [(found[0] + g0, found[0] + g1) for g0, g1 in _zero_runs(xs, GX_MIN)]

    # Merge consecutive bands that share a column gutter (overlapping internal x gaps).
    merged: list[tuple[int, int, list[tuple[int, int]]]] = []
    for a, b in bands:
        if merged:
            pa, pb, pg = merged[-1]
            g = band_gutters(a, b)
            common = [(max(p[0], q[0]), min(p[1], q[1])) for p in pg for q in g
                      if min(p[1], q[1]) - max(p[0], q[0]) >= GX_MIN]
            if common:
                merged[-1] = (pa, b, common)
                continue
            # A band on one side of the previous gutter: the end of the longer column.
            found = _trim(mask, (x0, a, x1, b))
            if pg and found is not None and any(found[2] <= p[0] + 1 or found[0] >= p[1] - 1 for p in pg):
                merged[-1] = (pa, b, pg)
                continue
        merged.append((a, b, band_gutters(a, b)))
    if len(merged) == 1 and len(bands) > 1 and merged[0][2]:
        # The whole node shares a gutter without a clean gap across it (a line crossing it): cut there.
        g = merged[0][2][0]
        _xy_cut(mask, (x0, y0, g[0], y1), out, gap, depth + 1)
        _xy_cut(mask, (g[1], y0, x1, y1), out, gap, depth + 1)
        return
    for a, b, _ in merged:
        if (a, b) == (y0, y1):
            out.append((x0, y0, x1, y1))
        else:
            _xy_cut(mask, (x0, a, x1, b), out, gap, depth + 1)



def _merge_boxes(boxes: list[list[int]], margin: int) -> list[list[int]]:
    boxes = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] - margin < b[2] and b[0] - margin < a[2] and a[1] - margin < b[3] and b[1] - margin < a[3]:
                    boxes[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    del boxes[j]
                    changed = True
                    break
            if changed:
                break
    return boxes


def _overlap(a, b) -> bool:
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _starts_at_column(leaves: list[Box], x0: int, line: float, tol: int = 4) -> bool:
    """x0 is the left edge of a column: two other leaves start there, or a paragraph does."""
    same = [leaf for leaf in leaves if abs(leaf[0] - x0) <= tol]
    return len(same) >= 3 or any((leaf[3] - leaf[1]) > 2 * line for leaf in same)


def _rows(mask: Image.Image, box: Box) -> int:
    _, profile = mask.crop(box).getprojection()
    rows, inside = 0, False
    for value in profile:
        if value and not inside:
            rows += 1
        inside = bool(value)
    return rows


# ---------------------------------------------------------------- figures

def _figures(line_cc, raw: Image.Image, line: float) -> list[list[int]]:
    """Figure regions (cells): graphics much taller than a text line or dense fills, with the small
    labels around them and the ends of their frame lines."""
    seeds = []
    for c in line_cc:
        cw, ch = c[2] - c[0], c[3] - c[1]
        if not cw or not ch:
            continue
        density = _ink_count(raw, c[:4]) / (cw * ch)
        if (ch > 2.6 * line and cw > 2 * line) or (ch > 1.6 * line and cw > 1.6 * line and density > .4):
            seeds.append(list(c[:4]))
    margin = int(1.5 * line)
    figures = _merge_boxes(seeds, margin)
    grown = []
    for fb in figures:
        for _ in range(2):  # labels first, then what the grown box now reaches
            for c in line_cc:
                cw, ch = c[2] - c[0], c[3] - c[1]
                label = ch <= 1.6 * line and cw < .5 * (fb[2] - fb[0])
                inside = (c[0] >= fb[0] - margin and c[2] <= fb[2] + margin
                          and c[1] >= fb[1] - margin and c[3] <= fb[3] + margin)
                # The end of a frame or axis line sticking out of the core.
                sliver = _overlap(c, fb) and (ch <= .6 * line or cw <= .6 * line)
                if (label and inside) or sliver:
                    fb = [min(fb[0], c[0]), min(fb[1], c[1]), max(fb[2], c[2]), max(fb[3], c[3])]
        grown.append(fb)
    return _merge_boxes(grown, 0)


def _join_graphics(regions: list[Region], boxes: list[Box], line: float) -> tuple[list[Region], list[Box]]:
    """Figures take in what overlaps them: a formula or another figure overlapping or nearly touching
    (parts of one plot the X-Y cut split), and text lying mostly inside (labels). A figure and a formula
    are both kept as the original, so which of the two a graphic is does not matter; text must not be
    left in them, and they must not cover text."""
    margin = max(1, int(.5 * line))
    kinds = [r.kind for r in regions]
    boxes = list(boxes)
    alive = [True] * len(regions)
    changed = True
    while changed:
        changed = False
        for i in range(len(regions)):
            if not alive[i] or kinds[i] != "figure":
                continue
            f = boxes[i]
            for j in range(len(regions)):
                if j == i or not alive[j]:
                    continue
                b = boxes[j]
                if kinds[j] == "text" or regions[j].uncertain:
                    ix = max(0, min(f[2], b[2]) - max(f[0], b[0]))
                    iy = max(0, min(f[3], b[3]) - max(f[1], b[1]))
                    area = max(1, (b[2] - b[0]) * (b[3] - b[1]))
                    take = ix * iy > .3 * area
                else:
                    take = _overlap((f[0] - margin, f[1] - margin, f[2] + margin, f[3] + margin), b)
                if take:
                    f = (min(f[0], b[0]), min(f[1], b[1]), max(f[2], b[2]), max(f[3], b[3]))
                    alive[j] = False
                    changed = True
            boxes[i] = f
    kept = [i for i in range(len(regions)) if alive[i]]
    # Figures after the text and formulas, as before.
    kept.sort(key=lambda i: kinds[i] == "figure")
    out = []
    for i in kept:
        region = regions[i]
        if kinds[i] == "figure":
            region = Region("figure", boxes[i])
        out.append(region)
    return out, [boxes[i] for i in kept]


# ---------------------------------------------------------------- segmentation

def segment_page(image: Image.Image, dpi: float, deskew: bool = True) -> PageLayout:
    """Regions of a scanned page (any mode; converted to grayscale), in reading order."""
    image = image.convert("L")
    cell = max(1, round(dpi / 72))
    background, delta = _background(image)
    angle = 0.0
    ink = _ink(image, dpi, background, delta)
    raw = _cells(ink, cell)
    if deskew:
        angle = estimate_skew(raw)
        if abs(angle) >= SKEW_MIN:
            image = image.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=background)
            ink = _ink(image, dpi, background, delta)
            raw = _cells(ink, cell)
        else:
            angle = 0.0
    del ink
    lines_mask = _dilate(raw, RX, 0)  # words -> lines
    fine = _dilate(raw, RX, RY)  # lines -> paragraphs, for the X-Y cut
    line_cc = components(lines_mask)
    lineish = [c for c in line_cc if (c[2] - c[0]) >= 4 * (c[3] - c[1]) and (c[3] - c[1]) >= 3]
    line = float(statistics.median(c[3] - c[1] for c in lineish)) if lineish else 10.0

    figures = _figures(line_cc, raw, line)
    rest = fine.copy()
    for fb in figures:
        # The dilation reaches RX, RY cells beyond the figure's ink: clear that too, or the ends of
        # its frame come back as thin leaves.
        rest.paste(0, (max(0, fb[0] - RX - 1), max(0, fb[1] - RY - 1), fb[2] + RX + 1, fb[3] + RY + 1))

    leaves: list[Box] = []
    _xy_cut(rest, (0, 0, rest.width, rest.height), leaves, max(1, int(.35 * line)))
    # Leaves without real ink (a speck, what a dilation left of a rule) are dropped.
    leaves = [leaf for leaf in leaves
              if _ink_count(raw, leaf) >= 3 and max(leaf[2] - leaf[0], leaf[3] - leaf[1]) >= .3 * line]
    widths = sorted(leaf[2] - leaf[0] for leaf in leaves if (leaf[3] - leaf[1]) > 3 * line)
    column = widths[len(widths) // 2] if widths else rest.width
    regions: list[Region] = []
    cells_regions: list[Box] = []
    for x0, y0, x1, y1 in leaves:
        rows = _rows(lines_mask, (x0, y0, x1, y1))
        glyphs = components(raw.crop((x0, y0, x1, y1)))
        heights = sorted(g[3] - g[1] for g in glyphs if (g[3] - g[1]) >= .3 * line)
        median_glyph = heights[len(heights) // 2] if heights else line
        # A symbol much taller than both a text line and the other glyphs of this block (a title in
        # a large type has uniformly large glyphs).
        tall = [g for g in glyphs if (g[3] - g[1]) > max(1.35 * line, 1.5 * median_glyph)
                and (g[2] - g[0]) < 2 * (g[3] - g[1])]
        kind, uncertain = "text", False
        width, height = x1 - x0, y1 - y0
        if (any((g[3] - g[1]) > 2.6 * line
                    or ((g[3] - g[1]) > max(1.6 * line, 1.5 * median_glyph) and (g[2] - g[0]) > 3 * line)
                    for g in glyphs)
                or (width < 2 * line and height > 2 * line and height > 2 * width)):
            # Graphics taller than any symbol, or a stroke both taller and much wider than a glyph (a line
            # plot the figure cores missed, a tall rule), or
            # a narrow upright strip: vertical text (an arXiv stamp) or a rule. Kept as the original.
            kind = "figure"
        elif rows <= 3 and tall:
            kind = "math"
        elif (rows <= 3 and (x1 - x0) < .9 * column and (y1 - y0) < 4 * line
              and not _starts_at_column(leaves, x0, line)):
            # A display formula, an equation number, a centered heading or author line, or a short
            # paragraph whose first line is indented: the OCR text tells them apart.
            kind, uncertain = "math", True
        regions.append(Region(kind, (x0, y0, x1, y1), rows, uncertain))
        cells_regions.append((x0, y0, x1, y1))
    for fb in figures:
        regions.append(Region("figure", (fb[0], fb[1], fb[2], fb[3])))
        cells_regions.append((fb[0], fb[1], fb[2], fb[3]))
    regions, cells_regions = _join_graphics(regions, cells_regions, line)

    # OCR blocks: consecutive text leaves of one column (x overlap), nothing else in between.
    blocks: list[tuple[list[int], set[int]] | None] = []
    for i, region in enumerate(regions):
        if region.kind != "text":
            blocks.append(None)
            continue
        c = cells_regions[i]
        last = blocks[-1] if blocks else None
        if last is not None:
            b, members = last
            overlap = min(b[2], c[2]) - max(b[0], c[0])
            union = [min(b[0], c[0]), b[1], max(b[2], c[2]), c[3]]
            # The merged box must not reach into another region (a title merged with the left column
            # would cover the top of the right column).
            clash = any(j not in members and j != i and _overlap(union, other)
                        for j, other in enumerate(cells_regions))
            if (overlap > .7 * min(b[2] - b[0], c[2] - c[0]) and c[1] >= b[3] - 1 and c[1] - b[3] < 3 * line
                    and not clash):
                b[:] = union
                members.add(i)
                continue
        blocks.append((list(c), {i}))

    w, h = image.size

    def pixels(box) -> Box:
        x0, y0, x1, y1 = box
        return (max(0, (x0 - PAD) * cell), max(0, (y0 - PAD) * cell),
                min(w, (x1 + PAD) * cell), min(h, (y1 + PAD) * cell))

    for region in regions:
        region.box = pixels(region.box)
    text_blocks = [TextBlock(pixels(b), sorted(members)) for entry in blocks if entry is not None
                   for b, members in [entry]]
    return PageLayout(image, angle, cell, line * cell, background, regions, text_blocks)
