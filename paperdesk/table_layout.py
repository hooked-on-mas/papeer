"""Keep detected tables as original PDF regions, outside prose translation."""
from __future__ import annotations

import pymupdf as fitz


def table_regions(page: fitz.Page) -> list[fitz.Rect]:
    rotation = page.rotation
    try:
        page.set_rotation(0)
        return _table_regions(page)
    finally:
        page.set_rotation(rotation)


def _table_regions(page: fitz.Page) -> list[fitz.Rect]:
    regions = []
    words = page.get_text("words")
    # The second pass handles academic tables with horizontal rules only.
    # Do not use unconstrained text detection: it can classify prose as a table.
    options_list = [{"strategy": "lines_strict"},
                    {"vertical_strategy": "text", "horizontal_strategy": "lines_strict",
                     "intersection_y_tolerance": 20}]
    # Isolate aligned horizontal rules before text-based column inference.
    # Otherwise nearby plots can join a small table into a page-wide candidate.
    groups = {}
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            if item[0] != "l":
                continue
            a, b = item[1:3]
            if abs(a.y - b.y) < .2 and abs(a.x - b.x) > 60:
                left, right = sorted((a.x, b.x))
                key = next((k for k in groups if abs(k[0] - left) < 2 and abs(k[1] - right) < 2), (left, right))
                groups.setdefault(key, []).append(a.y)
    for (left, right), ys in groups.items():
        runs = [[]]
        for y in sorted(set(ys)):
            if runs[-1] and y - runs[-1][-1] > 80:
                runs.append([])
            if not runs[-1] or y - runs[-1][-1] > 2:
                runs[-1].append(y)
        for run in runs:
            if len(run) >= 3 and run[-1] - run[0] > 15:
                options_list.append(dict(vertical_strategy="text", horizontal_strategy="lines_strict",
                    intersection_y_tolerance=20, clip=fitz.Rect(left - 1, run[0] - 1, right + 1, run[-1] + 3)))
    for options in options_list:
        finder = page.find_tables(**options)
        for table in finder.tables:
            if table.row_count < 2 or table.col_count < 2:
                continue
            rect = fitz.Rect(table.bbox)
            if "clip" in options:
                ruled = fitz.Rect(options["clip"])
                if rect.height >= ruled.height * .7 and rect.width >= ruled.width * .35:
                    # Text alignment can miss a sparse first/last column. Once
                    # cells are confirmed, the rules define the full table.
                    rect = ruled
            # Fraction bars and diagram edges can form a spurious vertical
            # strip through a prose column. A real table boundary does not
            # repeatedly bisect words in the surrounding sentences.
            cut_words = sum(1 for word in words
                if rect.y0 < (word[1] + word[3]) / 2 < rect.y1
                and any(word[0] + 2 < edge < word[2] - 2 for edge in (rect.x0, rect.x1)))
            if cut_words >= 3:
                continue
            if "clip" in options:
                regions = [existing for existing in regions if existing not in rect]
            if any(rect.intersects(existing) for existing in regions):
                continue
            # External header inference can include a caption. Only protect
            # actual cells; text within the table is collected below.
            regions.append(rect)
    return sorted(regions, key=lambda rect: (rect.y0, rect.x0))


def separate_tables(items: list[dict], regions: list[fitz.Rect], number: int, kind: str = "table"):
    """Split at glyph boundaries so shared PDF blocks retain nearby prose."""
    if not regions:
        return items, []
    prose, cells = [], [[] for _ in regions]
    for item in items:
        if item.get("type") != 0:
            continue
        # Flush at a table line so prose above and below never forms a union
        # rectangle covering the table.
        lines = []
        for line in item["lines"]:
            spans = []
            touched = False
            for span in line["spans"]:
                chars = []
                for char in span["chars"]:
                    box = fitz.Rect(char["bbox"])
                    center = (box.tl + box.br) / 2
                    target = next((i for i, rect in enumerate(regions) if center in rect), None)
                    if target is None:
                        chars.append(char)
                    else:
                        cells[target].append((char, span["size"]))
                        touched = True
                if chars:
                    box = fitz.Rect(chars[0]["bbox"])
                    for char in chars[1:]:
                        box |= fitz.Rect(char["bbox"])
                    spans.append(dict(span, chars=chars, bbox=list(box)))
            if touched and lines:
                prose.append(dict(item, lines=lines))
                lines = []
            if spans:
                box = fitz.Rect(spans[0]["bbox"])
                for span in spans[1:]:
                    box |= fitz.Rect(span["bbox"])
                remaining = dict(line, spans=spans, bbox=list(box))
                if touched:
                    prose.append(dict(item, lines=[remaining]))
                else:
                    lines.append(remaining)
        if lines:
            prose.append(dict(item, lines=lines))
    tables = []
    for index, (rect, chars) in enumerate(zip(regions, cells)):
        # Include glyph ascenders/descenders protruding beyond a detected rule.
        box = fitz.Rect(rect)
        for char, _ in chars:
            box |= fitz.Rect(char["bbox"])
        text = " ".join("".join(char["c"] for char, _ in chars).split())
        prefix = "t" if kind == "table" else "f"
        tables.append({"id": f"p{number}{prefix}{index + 1}", "page": number,
                       "kind": kind, "bbox": list(box), "regions": [list(box)],
                       "text": text, "translation_text": text, "formulas": [],
                       "font_size": sum(size for _, size in chars) / max(1, len(chars))})
    return prose, tables
