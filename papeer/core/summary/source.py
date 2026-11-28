"""Preserve table cell boundaries in the text supplied to summary generation and review."""
from __future__ import annotations

import re
from collections import Counter
from typing import cast

import pymupdf as fitz


def summary_source_text(page: fitz.Page, cached: str, blocks: list[dict], number: int,
                        figures: list[dict]) -> str:
    """Keep reading order/OCR prose, replacing flattened table runs with original PDF text.

    Translation stores table spans without cell separators (35.58 and 3.8 can become
    35.583.8). A summarizer must not infer numbers from that representation. Native PDF
    text inside the complete table crop preserves their spatial separation. A scanned
    table with no usable native text retains its OCR instead.
    """
    crops = {figure["id"]: figure["rect"] for figure in figures}
    for block in blocks:
        if block["page"] != number or block.get("kind") != "table":
            continue
        original = block.get("text", "")
        if len(original.strip()) < 20 or original not in cached:
            continue
        rect = crops.get(block["id"], fitz.Rect(block["bbox"]))
        native = cast(str, page.get_text("text", clip=rect, sort=True))
        native = re.sub(r"[^\S\n]+", " ", native)
        native = "\n".join(line.strip() for line in native.splitlines()).strip()
        # Incomplete/outdated crops must not replace the more complete cached/OCR text.
        if len(re.sub(r"\s", "", native)) < len(re.sub(r"\s", "", original)) * .6:
            continue
        cached = cached.replace(original, native, 1)
    # The extraction cache is for layout/translation, not TeX. PDF writers often
    # put a small raised letter in the same text run: (a+b)^a becomes (a+b)a.
    # Recover only single-baseline expressions with clearly positioned scripts.
    # Never infer a script from the character itself (x2 need not mean x squared).
    for block in blocks:
        if block["page"] != number:
            continue
        formulas = [block] if block.get("kind") == "formula" else block.get("formulas", [])
        for formula in formulas:
            original = formula.get("text", "")
            if not original or cached.count(original) != 1 or not formula.get("bbox"):
                continue
            restored = _positioned_equation(page, formula)
            if restored:
                cached = cached.replace(original, restored, 1)
    return cached


def _positioned_equation(page: fitz.Page, formula: dict) -> str | None:
    """Restore clear super/subscripts; refuse fractions, stacked rows and lost glyphs."""
    raw = cast(dict, page.get_text("dict", clip=fitz.Rect(formula["bbox"]),
                                   flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES))
    spans = [span for block in raw["blocks"] for line in block.get("lines", [])
             for span in line["spans"] if span["text"].strip()]
    if not spans:
        return None
    size = max(span["size"] for span in spans)
    main = [span for span in spans if span["size"] >= size * .85]
    baselines = Counter(round(span["origin"][1] * 2) / 2 for span in main)
    if not main or max(baselines) - min(baselines) > 1:
        return None  # A fraction/matrix/multi-line equation is not a single script expression.
    baseline = baselines.most_common(1)[0][0]
    spans.sort(key=lambda span: span["bbox"][0])
    plain = "".join(span["text"] for span in spans)
    compact = lambda text: re.sub(r"\s", "", text)
    if compact(plain) != compact(formula["text"]):
        return None  # Incomplete crop or different PDF glyph order: leave cached/OCR text intact.
    result, script, previous = [], "", None
    changed = False
    for span in spans:
        offset = span["origin"][1] - baseline
        raised = span["size"] <= size * .85 and offset < -size * .18
        lowered = span["size"] <= size * .85 and offset > size * .12
        marker = "^" if raised else "_" if lowered else ""
        if marker:
            if previous is None or span["bbox"][0] - previous["bbox"][2] > size * .6:
                return None  # Detached footnote/label, not an attached mathematical script.
            if marker != script:
                if script:
                    result.append("}")
                result.append(marker + "{")
            result.append(span["text"].strip())
            changed = True
        else:
            if script:
                result.append("}")
            if previous and span["bbox"][0] - previous["bbox"][2] > size * .18:
                result.append(" ")
            result.append(span["text"])
        script, previous = marker, span
    if script:
        result.append("}")
    return "".join(result) if changed else None
