"""Locate complete ruled algorithms for lossless preservation."""
from __future__ import annotations

import re
from collections import Counter
import pymupdf as fitz

from paperdesk.layout.table_layout import _horizontal_rules


def separate_algorithms(page, items):
    rules = _horizontal_rules(page)
    regions = []
    for item in items:
        for line in item.get("lines", []):
            text = "".join(c["c"] for s in line["spans"] for c in s["chars"])
            if not re.match(r"\s*Algorithm\s+\d+\b", text, re.I):
                continue
            box = fitz.Rect(line["bbox"])
            # 罫線より内側に字下げされた見出しに対応。 (Support arbitrary indentation inside the rule)
            below = [(l, r, y) for l, r, y in rules
                     if l - 2 <= box.x0 and r >= box.x1 - 2 and y > box.y1]
            if len(below) < 2:
                continue
            l, r, top = min(below, key=lambda rule: rule[2])
            bottoms = [y for a, b, y in below if y > top + 20 and abs(a-l) < 2 and abs(b-r) < 2]
            if bottoms:
                upper = [y for a, b, y in rules if abs(a-l) < 2 and abs(b-r) < 2
                         and box.y0 - 20 < y <= box.y0]
                if not upper:
                    continue
                region = fitz.Rect(l, max(upper), r, min(bottoms))
                body = page.get_text("text", clip=region)
                if not re.search(r"^\s*(?:(?:Require|Ensure|Input|Output)\s*:|1:\s)", body, re.I | re.M):
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
            start = re.match(r"^(\d+:|(?:Require|Ensure|Input|Output)\s*:)", text, re.I)
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
