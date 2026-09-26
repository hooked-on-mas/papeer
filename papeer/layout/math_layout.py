"""Conservative, local math detection using the PDF's glyphs and typography.

PDFs contain positioned glyphs, not necessarily TeX source. Keep display math
on the original page and describe inline crops with tokens for the translator.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

import pymupdf as fitz


LAYOUT_VERSION = 20
MATH_TOKEN = re.compile(r"\[\[PD_MATH_[A-Za-z0-9_]+\]\]")
_MATH_FONT = re.compile(r"(?:CMMI|CMSY|CMEX|MSAM|MSBM|CMBSY|CMMIB|Math|Symbol|MTMI|MTSY|MTEX|rsfs|AdvPSMP)", re.I)
_SYMBOL = re.compile(r"[=+−×÷∑∏∫√∞≤≥≠≈∂∇∈∉⊂⊆∀∃∥⊤⊥α-ωΑ-Ω]|[\U0001d400-\U0001d7ff]")
_FUNCTIONS = {"sin", "cos", "tan", "log", "ln", "exp", "min", "max", "arg", "argmin", "argmax", "lim", "sup", "inf", "det", "diag", "conv"}
_DIFFERENTIALS = {"dt", "dx", "dy", "dz", "ds", "du", "dv"}
_MATH_LABELS = _FUNCTIONS | _DIFFERENTIALS | {"subject", "to", "state", "constraints", "s.t", "lb", "ub", "ref", "or", "and", "cp", "pp", "rp", "lp", "qp", "sdp", "milp", "miqp"}
_ATOM = r"(?:[A-Za-zα-ωΑ-Ω](?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+)?(?:\([^()\n]{1,22}\))?|\d+(?:\.\d+)?)"
_EXPRESSION = re.compile(rf"(?<![A-Za-z]){_ATOM}(?:\s*[=+−×÷≤≥≠≈*/^_]\s*{_ATOM})+(?![A-Za-z])")


def formula_only_block(block: dict) -> bool:
    """Recognize old cached equation fragments mislabeled as prose (e.g. dt)."""
    if not block.get("formulas"):
        return False
    remaining = MATH_TOKEN.sub("", block.get("translation_text", block["text"]))
    remaining = re.sub(r"\(\s*\d+[a-z]?\s*\)", "", remaining)
    remaining = re.sub(r"\b(?:dt|dx|dy|dz|ds|du|dv)+\b", "", remaining)
    return not re.search(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff]", remaining)


def _chars(line: dict) -> list[dict]:
    chars = [dict(c, font=s["font"], flags=s["flags"], size=s["size"],
                  math_font=s.get("math_font", bool(_MATH_FONT.search(s["font"]))))
             for s in line["spans"] for c in s["chars"]]
    if not line.get("merged"):
        return chars
    result = []
    for char in sorted(chars, key=lambda c: c["bbox"][0]):
        if (result and not result[-1]["c"].isspace() and not char["c"].isspace()
                and char["bbox"][0] - result[-1]["bbox"][2] > char["size"] * 0.18):
            result.append(dict(char, c=" "))
        result.append(char)
    return result


def annotate_math_fonts(items: list[dict]) -> None:
    """Recognize subset fonts with opaque names by their use on this page."""
    fonts = defaultdict(list)
    for item in items:
        for line in item.get("lines", []):
            for span in line["spans"]:
                fonts[span["font"]].append(span)
    for name, spans in fonts.items():
        text = " ".join("".join(c["c"] for c in s["chars"]) for s in spans)
        words = re.findall(r"[A-Za-z]{3,}", text)
        prose = [w for w in words if w.lower() not in _FUNCTIONS]
        # Repeated short identifiers / unmapped symbols, with virtually no prose.
        inferred = (len(spans) >= 3 and len(text.strip()) >= 6
                    and sum(map(len, prose)) < len(text) * 0.05)
        for span in spans:
            span["math_font"] = inferred or bool(_MATH_FONT.search(name))


def _prose_words(line: dict) -> list[str]:
    chars = _chars(line)
    size = max((c["size"] for c in chars), default=1)
    text = "".join(c["c"] if not c["math_font"] and c["size"] >= size * 0.85 else " " for c in chars)
    return [w for w in re.findall(r"[A-Za-z]{2,}", text) if w.lower() not in _MATH_LABELS]


def _prose_baseline(line: dict) -> float:
    chars = _chars(line)
    size = max(c["size"] for c in chars)
    prose = [c for c in chars if not c["math_font"] and c["c"].isalpha() and c["size"] >= size * .85]
    return Counter(round(c["origin"][1], 1) for c in (prose or chars)).most_common(1)[0][0]


def _merge_inline_fragments(lines: list[dict]) -> list[dict]:
    # Some publishers put parentheses / tall brackets in separate PDF lines,
    # even inside a sentence. Attach them to that sentence before classification.
    # Join adjacent sentence fragments on the same baseline first.
    rows = []
    for line in lines:
        target = next((row for row in rows
                       if (bool(_prose_words(row)) and bool(_prose_words(line))
                           and abs(_prose_baseline(row) - _prose_baseline(line)) < 1)
                       or (abs(row["bbox"][3] - line["bbox"][3]) < 2
                       and abs(row["bbox"][1] - line["bbox"][1]) < 2
                       and fitz.Rect(row["bbox"]).height < max(s["size"] for s in line["spans"]) * 1.6)), None)
        if target is None:
            rows.append(dict(line, spans=list(line["spans"]), regions=[list(line["bbox"])]))
        else:
            target["spans"].extend(line["spans"])
            target["regions"].append(list(line["bbox"]))
            target["bbox"] = list(fitz.Rect(target["bbox"]) | fitz.Rect(line["bbox"]))
            target["merged"] = True
    lines = rows
    anchors = [line for line in lines if len(_prose_words(line)) >= 2]
    if not anchors:
        return lines
    merged = {id(line): dict(line, spans=list(line["spans"])) for line in anchors}
    standalone = []
    for line in lines:
        if id(line) in merged:
            continue
        rect = fitz.Rect(line["bbox"])
        candidates = []
        for anchor in anchors:
            # A short prose row (e.g. "over [interval]") is still its own
            # sentence row. Tall symbol boxes can touch the following row;
            # never interleave their glyphs merely because those boxes overlap.
            if _prose_words(line) and abs(_prose_baseline(line) - _prose_baseline(anchor)) >= 1:
                continue
            target = fitz.Rect(anchor["bbox"])
            size = max(s["size"] for s in anchor["spans"])
            overlap = min(rect.y1, target.y1) - max(rect.y0, target.y0)
            # Require vertical contact; never absorb a separate display equation.
            if overlap > 0 and abs((rect.y0 + rect.y1 - target.y0 - target.y1) / 2) < size:
                candidates.append((abs(rect.y1 - target.y1), anchor))
        if candidates:
            anchor = min(candidates, key=lambda pair: pair[0])[1]
            target = merged[id(anchor)]
            target["spans"].extend(line["spans"])
            target["regions"].extend(line["regions"])
            target["bbox"] = list(fitz.Rect(target["bbox"]) | rect)
            target["merged"] = True
        else:
            standalone.append(line)
    return sorted([*merged.values(), *standalone], key=lambda line: (line["bbox"][1], line["bbox"][0]))


def _math_ranges(chars: list[dict]) -> list[tuple[int, int]]:
    text = "".join(c["c"] for c in chars)
    selected = [False] * len(chars)
    size = max((c["size"] for c in chars), default=1)
    italic_prose = (len(re.findall(r"[A-Za-z]{3,}", text)) >= 3
                    and sum(bool(c["flags"] & 2) for c in chars) > len(chars) * 0.8)
    for word in re.finditer(r"[A-Za-z]+|[^A-Za-z\s]", text):
        # A prose ligature can live in a tiny subset font otherwise used only
        # for symbols. Do not turn the middle of "classification" into math.
        if word[0] in "ﬀﬁﬂﬃﬄﬅﬆ" and (
                word.start() > 0 and text[word.start() - 1].isalpha()
                or word.end() < len(text) and text[word.end()].isalpha()):
            continue
        glyphs = chars[word.start():word.end()]
        font_math = any(c["math_font"] for c in glyphs)
        short_italic = ((not italic_prose or word[0] not in {"a", "A", "I"})
                        and len(word[0]) == 1 and word[0].isalpha()
                        and any(c["flags"] & 2 for c in glyphs))
        # An italic sentence is prose; ordinary italic words are never math.
        math_word = font_math and (len(word[0]) <= 2 or word[0] in _FUNCTIONS
                                  or all(c["math_font"] or c["size"] < size * 0.85 for c in glyphs))
        if math_word or short_italic or _SYMBOL.search(word[0]):
            selected[word.start():word.end()] = [True] * len(word[0])
    for match in _EXPRESSION.finditer(text):
        selected[match.start():match.end()] = [True] * len(match[0])
    # Include scripts and the punctuation / roman glyphs inside math expressions.
    changed = True
    while changed:
        changed = False
        for match in re.finditer(r"[A-Za-z0-9α-ωΑ-Ω_^]+(?:\([^()\n]{1,22}\))?", text):
            a, b = match.span()
            if any(selected[a:b]) and not all(selected[a:b]):
                # Do not swallow function arguments that are actually prose.
                if not re.search(r"[A-Za-z]{4,}", match[0]):
                    selected[a:b] = [True] * (b - a)
                    changed = True
        for i, c in enumerate(chars):
            script = (c["flags"] & 1 or c["size"] < size * 0.85)
            # MuPDF can mark the entire rest of a line as superscript after
            # a tall operator. Require mathematical typography or reduced size,
            # and never propagate selection through whitespace into prose.
            if (script and i and selected[i - 1] and not selected[i]
                    and not c["c"].isspace() and (c["math_font"] or c["size"] < size * .85)):
                selected[i] = True
                changed = True
    # Author/year citation keys are prose even when '+' has a symbol font.
    # Roman/italic articles beside formulas are still prose. In theorem
    # typography MuPDF may label the article as an italic or script glyph.
    for match in re.finditer(r"\b[aA]\s+([a-z]{3,})\b", text):
        i = match.start()
        previous = text[:i].rstrip()
        if (match[1] not in {"and", "are", "has", "was", "for", "can"}
                and not _MATH_FONT.search(chars[i]["font"])
                and (not previous or previous[-1] in ".:;" or any(selected[:i]))):
            selected[i] = False

    # Require a two-to-four digit year, so intervals such as [x+2] stay math.
    for match in re.finditer(r"\[[A-Za-z][A-Za-z0-9+., –-]{0,60}\d{2,4}[a-z]?\]", text):
        selected[match.start():match.end()] = [False] * len(match[0])
    indices = [i for i, value in enumerate(selected) if value]
    ranges = []
    for i in indices:
        if ranges and re.fullmatch(r"[\s\d()\[\]{},.;:+*/^_<>|−-]*", text[ranges[-1][1]:i]):
            ranges[-1] = (ranges[-1][0], i + 1)
        else:
            ranges.append((i, i + 1))
    balanced = []
    for a, b in ranges:
        # A closing delimiter is often in the prose font. Protect it with its
        # formula so the translator cannot discard it as stray punctuation.
        while b < len(text) and text[b] in ")]}":
            opener = {")": "(", "]": "[", "}": "{"}[text[b]]
            if text[a:b].count(opener) <= text[a:b].count(text[b]):
                break
            b += 1
        balanced.append((a, b))
    return balanced


def _display(line: dict) -> bool:
    chars = _chars(line)
    text = "".join(c["c"] for c in chars).strip()
    prose = _prose_words(line)
    math = bool(_SYMBOL.search(text) or any(c["math_font"] for c in chars))
    if re.search(r"[\u3040-\u30ff\u3400-\u9fff]", text):
        return False
    return text.lower() in _FUNCTIONS or (math and not prose) or (
        not prose and any(c["flags"] & 2 for c in chars) and len(text) < 90)


def layout_blocks(item: dict, page_number: int, first_index: int) -> list[dict]:
    """Split mixed text/display blocks at line boundaries, retaining all glyphs."""
    lines = [line for line in item["lines"] if any(c["c"].strip() for c in _chars(line))]
    if not item.get("algorithm"):
        lines = _merge_inline_fragments(lines)
    kinds = [_display(line) for line in lines]
    if any(kinds) and not any(_prose_words(line) for line in lines):
        kinds = [True] * len(lines)
    # Matrix brackets, limits, and equation numbers may be separate PDF lines.
    for i, line in enumerate(lines):
        text = "".join(c["c"] for c in _chars(line)).strip()
        if re.fullmatch(r"[\s\d()\[\]{}.,;:|a-z\u2212-]+", text) and len(text) < 20:
            if (i and kinds[i - 1]) or (i + 1 < len(lines) and kinds[i + 1]):
                kinds[i] = True
    if item.get("algorithm"):
        kinds = [False] * len(lines)
    groups = []
    for line, kind in zip(lines, kinds):
        if not groups or groups[-1][0] != kind:
            groups.append((kind, []))
        groups[-1][1].append(line)
    blocks = []
    for kind, group in groups:
        identity = f"p{page_number}b{first_index + len(blocks)}"
        rect = fitz.Rect(group[0]["bbox"])
        for line in group[1:]:
            rect |= fitz.Rect(line["bbox"])
        all_chars = [c for line in group for c in _chars(line)]
        size = sum(c["size"] for c in all_chars) / len(all_chars)
        original, protected, formulas = [], [], []
        for line in group:
            chars = _chars(line)
            text = "".join(c["c"] for c in chars)
            original.append(text)
            offset, parts = 0, []
            for a, b in ([] if kind else _math_ranges(chars)):
                crop = fitz.Rect(chars[a]["bbox"])
                for c in chars[a + 1:b]:
                    crop |= fitz.Rect(c["bbox"])
                token = f"[[PD_MATH_{identity}_{len(formulas)}]]"
                formulas.append({"token": token, "bbox": list(crop), "text": text[a:b],
                                 "glyph_origins": [list(c["origin"]) for c in chars[a:b] if not c["c"].isspace()],
                                 "baseline": max(chars, key=lambda c: c["size"])["origin"][1]})
                parts.extend((text[offset:a], token))
                offset = b
            protected.append("".join(parts) + text[offset:])
        blocks.append({"id": identity, "page": page_number, "bbox": list(rect),
                       "regions": [region for line in group for region in line["regions"]],
                       "text": "\n".join(original).strip(), "font_size": size,
                       "kind": "formula" if kind else "text", "formulas": formulas,
                       "translation_text": "\n".join(protected).strip()})
        if item.get("algorithm"):
            blocks[-1].update(kind="algorithm", font_size=item["algorithm_size"])
            blocks[-1]["bbox"][2] = item["algorithm_right"]
    return blocks


def restore_formula_text(text: str, block: dict) -> str:
    for formula in block.get("formulas", []):
        text = text.replace(formula["token"], formula["text"])
    return text


def merge_overlapping_prose(blocks: list[dict]) -> list[dict]:
    """Keep overlapping fragments of one column in a single layout box."""
    result = []
    for block in blocks:
        box = fitz.Rect(block["bbox"])
        target = next((b for b in result if b.get("kind") == block.get("kind") == "text"
                       and min(b["bbox"][3], box.y1) - max(b["bbox"][1], box.y0) > 2
                       and abs(b["bbox"][0] - box.x0) < 8
                       and abs(b["bbox"][2] - box.x1) < 8), None)
        if target is None:
            result.append(dict(block))
            continue
        target["bbox"] = list(fitz.Rect(target["bbox"]) | box)
        for key in ("text", "translation_text"):
            target[key] += "\n" + block[key]
        target["formulas"] = target["formulas"] + block["formulas"]
        target["regions"] = target["regions"] + block["regions"]
    return result


def merge_continued_prose(blocks: list[dict]) -> list[dict]:
    """Reunite adjacent sentence fragments before translation, not after it.

    A tall inline symbol can split a paragraph into separate PDF blocks, even
    leaving a preposition in one block and its mathematical object in the next.
    Keep display equations, column boundaries and paragraph gaps as barriers.
    """
    result = []
    for block in blocks:
        previous = result[-1] if result else None
        join = False
        if (previous and previous["page"] == block["page"]
                and previous.get("kind") == block.get("kind") == "text"
                and not formula_only_block(previous) and not formula_only_block(block)):
            a, b = fitz.Rect(previous["bbox"]), fitz.Rect(block["bbox"])
            aligned = abs(a.x0 - b.x0) < 8
            overlap = min(a.y1, b.y1) - max(a.y0, b.y0) > 0
            unfinished = len(previous["text"]) > 60 and re.search(
                r"\b(?:on|in|of|for|with|to|from|by|and|or|the|a|an|each|every|any|all)\s*$",
                previous["text"], re.I)
            gap = b.y0 - a.y1
            join = aligned and (overlap or (unfinished and 0 <= gap <= min(
                previous["font_size"], block["font_size"]) * .45))
        if not join:
            result.append(dict(block))
            continue
        previous["bbox"] = list(a | b)
        for key in ("text", "translation_text"):
            previous[key] += "\n" + block[key]
        previous["formulas"] = previous["formulas"] + block["formulas"]
        previous["regions"] = previous["regions"] + block["regions"]
    return result

