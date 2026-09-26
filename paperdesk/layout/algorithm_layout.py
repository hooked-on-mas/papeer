"""Locate complete ruled algorithms for lossless preservation."""
from __future__ import annotations

import re
from collections import Counter
import pymupdf as fitz

from paperdesk.layout.table_layout import _horizontal_rules


_CAPTION = re.compile(r"\s*Algorithm\s*\d+", re.I)
_STEP = re.compile(r"^\s*(\d+\s*[:.)]|(?:Require|Ensure|Input|Output)\s*:)", re.I)


def _has_algorithm_body(page, region):
    # PDF extraction may separate a line number from its text, omit the
    # following space, or start numbering at zero/on a continuation page.
    body = page.get_text("text", clip=region)
    if any(_STEP.match(line) for line in body.splitlines()):
        return True
    # Unnumbered pseudocode is also common. Require multiple control lines
    # so a single prose mention or a table column called "output" is not enough.
    controls = re.findall(r"^\s*(?:for\b[^\n]*\bdo\b|while\b[^\n]*\bdo\b|"
                          r"if\b[^\n]*\bthen\b|return\b|end\s+(?:if|for|while)\b)",
                          body, re.I | re.M)
    return len(controls) >= 2


def separate_algorithms(page, items):
    rules = _horizontal_rules(page)
    regions = []
    for item in items:
        for line in item.get("lines", []):
            text = "".join(c["c"] for s in line["spans"] for c in s["chars"])
            caption = _CAPTION.match(text)
            if not caption:
                continue
            # Measure only "Algorithm N". A formula in the title can extend
            # beyond the rule or use a different baseline from the label.
            label = [c for s in line["spans"] for c in s["chars"]][:caption.end()]
            label_box = fitz.Rect(label[0]["bbox"])
            for char in label[1:]:
                label_box |= fitz.Rect(char["bbox"])
            # Font boxes include unused ascent/descent space and can overlap
            # either caption rule. Anchor on the dominant text baseline instead
            # (small superscripts must not move the anchor).
            baseline = Counter(round(c["origin"][1], 2) for c in label
                               if c["c"].strip()).most_common(1)[0][0]
            caption_center = (label_box.y0 + baseline) / 2
            # 罫線より内側に字下げされた見出しに対応。 (Support arbitrary indentation inside the rule)
            below = [(l, r, y) for l, r, y in rules
                     if l - 6 <= label_box.x0 and r >= label_box.x1 - 6 and y > baseline]
            if not below:
                continue
            l, r, first = min(below, key=lambda rule: rule[2])
            tolerance = max(6, (r - l) * .02)
            aligned = [(a, b, y) for a, b, y in rules
                       if abs(a-l) <= tolerance and abs(b-r) <= tolerance]
            upper = [y for a, b, y in aligned if label_box.y0 - 24 < y < caption_center]
            # Accept a frame with only top/bottom rules. A nearby rule below
            # the caption is a separator, rather than the algorithm's bottom.
            separator = first - baseline <= max(24, label_box.height * 2)
            bottoms = [y for a, b, y in aligned
                       if y > first + 12] if separator else [first]
            if not bottoms and upper:
                bottoms = [first]
            if not bottoms or (not upper and not separator):
                continue
            top = max(upper) if upper else label_box.y0 - 1
            bottom = min(bottoms)
            frame = [(a, b) for a, b, y in aligned if top <= y <= bottom]
            region = fitz.Rect(min(a for a, b in frame), top, max(b for a, b in frame), bottom)
            if not _has_algorithm_body(page, region):
                continue
            if not any(region.intersects(existing) for existing in regions):
                regions.append(region)

    remaining = []
    extracted = [[] for _ in regions]
    for item in items:
        lines = []
        for line in item.get("lines", []):
            box = fitz.Rect(line["bbox"])
            index = next((i for i, region in enumerate(regions)
                          if region.contains((box.tl + box.br) / 2)), None)
            if index is None:
                lines.append(line)
            else:
                extracted[index].extend(dict(c, font=s["font"], flags=s["flags"], size=s["size"],
                                             math_font=s.get("math_font", False))
                                        for s in line["spans"] for c in s["chars"])
        if lines:
            remaining.append(dict(item, lines=lines))

    algorithms = []
    for region, chars in zip(regions, extracted):
        if not chars:
            continue
        size = Counter(round(c["size"], 1) for c in chars).most_common(1)[0][0]
        baselines = sorted({round(c["origin"][1], 1) for c in chars
                            if c["size"] >= size * .8 and c["c"].strip()})
        rows = []
        for baseline in baselines:
            if not rows or baseline - rows[-1][0] > 2:
                rows.append((baseline, []))
        for char in chars:
            min(rows, key=lambda row: abs(row[0] - char["origin"][1]))[1].append(char)
        steps = []
        for _, row in rows:
            row.sort(key=lambda c: c["bbox"][0])
            text = "".join(c["c"] for c in row).strip()
            start = _STEP.match(text)
            if start and start[1][0].isdigit():
                for c in row[:len(start[1])]:
                    c.update(math_font=False, flags=0, size=size)
            if start or not steps:
                steps.append([])
            spans = [dict(font=c["font"], flags=c["flags"], size=c["size"],
                          math_font=c["math_font"], chars=[c]) for c in row]
            box = fitz.Rect(row[0]["bbox"])
            for c in row[1:]:
                box |= fitz.Rect(c["bbox"])
            steps[-1].append(dict(bbox=list(box), spans=spans, merged=True, regions=[list(box)]))
        for step in steps:
            algorithms.append(dict(type=0, lines=step, algorithm=True,
                                   algorithm_right=region.x1, algorithm_size=size))
    return remaining, algorithms, regions
