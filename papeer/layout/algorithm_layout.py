"""Locate complete ruled algorithms for lossless preservation."""
from __future__ import annotations

import re
from collections import Counter
import pymupdf as fitz

from papeer.layout.table_layout import _horizontal_rules
from papeer.layout.math_layout import _prose_baseline


_CAPTION = re.compile(r"\s*Algorithm\s*\d+", re.I)
_STEP = re.compile(r"^\s*(\d+\s*[:.)]|(?:Require|Ensure|Input|Output)\s*:)", re.I)


def unruled_algorithm_steps(items):
    """Split unframed, numbered pseudocode into translation/layout steps.

    A caption and at least three numbered steps are required, and the next
    theorem/remark/heading is a hard boundary in the same column.
    """
    def text(line):
        return "".join(c["c"] for s in line["spans"] for c in s["chars"]).strip()
    lines = [line for item in items for line in item.get("lines", [])]
    captions = [line for line in lines if re.match(r"Algorithm\s+\d+(?:\.\d+)*\s*[:.]", text(line), re.I)]
    ranges = []
    step = re.compile(r"^(?:\d+(?:[.][a-z])?[.)]|\(Initialization\))\s*", re.I)
    def is_step(line):
        if not step.match(text(line)):
            return False
        first = next((s for s in line["spans"] if any(c["c"].strip() for c in s["chars"])), None)
        return first is not None and not first.get("math_font")
    end = re.compile(r"^(?:Remark|Theorem|Lemma|Proposition|Corollary|Proof|Algorithm)\b", re.I)
    for caption in captions:
        box = fitz.Rect(caption["bbox"])
        following = sorted((line for line in lines if line["bbox"][1] >= box.y0
                            and box.x0 - 24 <= line["bbox"][0] < box.x1), key=lambda line: line["bbox"][1])
        bottom = next((line["bbox"][1] for line in following
                       if line is not caption and line["bbox"][1] > box.y1 and end.match(text(line))), None)
        if bottom is None:
            continue  # No justified end: leave it to the ordinary layout.
        body = [line for line in following if line["bbox"][1] < bottom]
        if sum(bool(is_step(line) and re.match(r"\d+[.)]\s*", text(line))) for line in body) < 3:
            continue
        markers = sorted({_prose_baseline(line) for line in body
                          if is_step(line) or line is caption})
        ranges.append((min(line["bbox"][0] for line in body), max(line["bbox"][2] for line in body),
                       box.y0, bottom, markers))
    if not ranges:
        return items
    result = []
    for item in items:
        chunks = []
        for line in item.get("lines", []):
            x0, y0, _, _ = line["bbox"]
            region = next((i for i, (left, right, top, bottom, _) in enumerate(ranges)
                           if left - 4 <= x0 < right and top <= y0 < bottom), None)
            identity = None
            if region is not None:
                ordinal = sum(y <= _prose_baseline(line) + 2 for y in ranges[region][4]) - 1
                identity = f"a{region}s{ordinal}"
            if not chunks or chunks[-1][0] != identity:
                chunks.append((identity, []))
            chunks[-1][1].append(line)
        for identity, chunk in chunks:
            box = fitz.Rect(chunk[0]["bbox"])
            for line in chunk[1:]:
                box |= fitz.Rect(line["bbox"])
            value = dict(item, lines=chunk, bbox=list(box))
            if identity is not None:
                value["algorithm_step"] = identity
                value["algorithm_right"] = ranges[int(identity.split("s")[0][1:])][1]
            result.append(value)
    grouped, output = {}, []
    for item in result:
        identity = item.get("algorithm_step")
        if identity is None:
            output.append(item)
            continue
        if identity not in grouped:
            grouped[identity] = dict(item, lines=list(item["lines"]))
            output.append(grouped[identity])
        else:
            target = grouped[identity]
            target["lines"].extend(item["lines"])
            target["bbox"] = list(fitz.Rect(target["bbox"]) | fitz.Rect(item["bbox"]))
    for item in grouped.values():
        item["algorithm_size"] = Counter(round(s["size"], 1) for line in item["lines"]
                                         for s in line["spans"] for c in s["chars"] if c["c"].strip()).most_common(1)[0][0]
    return output


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
            steps[-1].append(dict(bbox=list(box), spans=spans, merged=True, regions=[list(box)]))  # pyright: ignore[reportArgumentType]
        for step in steps:
            algorithms.append(dict(type=0, lines=step, algorithm=True,
                                   algorithm_right=region.x1, algorithm_size=size))
    return remaining, algorithms, regions
