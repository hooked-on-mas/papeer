"""Conservative, local math detection using the PDF's glyphs and typography.

PDFs contain positioned glyphs, not necessarily TeX source. Keep display math
on the original page and describe inline crops with tokens for the translator.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

import pymupdf as fitz


LAYOUT_VERSION = 32
MATH_TOKEN = re.compile(r"\[\[PD_MATH_[A-Za-z0-9_]+\]\]")
_MATH_FONT = re.compile(r"(?:CMMI|CMSY|CMEX|MSAM|MSBM|CMBSY|CMMIB|Math|Symbol|MTMI|MTSY|MTEX|rsfs|LCIRCLE|AdvPSMP)", re.I)
_SYMBOL = re.compile(r"[=+−×÷∑∏∫√∞≤≥≠≈≡∼∝∂∇∆∈∉⊂⊆⊃⊇∀∃∥⊤⊥∧∨∩∪∅±¬ℝℕℤℚℂα-ωΑ-Ω]|[\U0001d400-\U0001d7ff]")
_FUNCTIONS = {"sin", "cos", "tan", "log", "ln", "exp", "min", "max", "arg", "argmin", "argmax", "lim", "sup", "inf", "det", "diag", "conv", "var", "cov", "prob", "pr", "tr", "vec", "col", "erf", "erfc", "pid", "nan", "minimize", "maximize"}
_DIFFERENTIALS = {"dt", "dx", "dy", "dz", "ds", "du", "dv"}
_MATH_LABELS = _FUNCTIONS | _DIFFERENTIALS | {"subject", "to", "state", "constraints", "s.t", "lb", "ub", "ref", "or", "and", "for", "if", "not", "otherwise", "else", "when", "then", "with", "cp", "pp", "rp", "lp", "qp", "sdp", "milp", "miqp"}
_ATOM = r"(?:[A-Za-zα-ωΑ-Ω](?:_[A-Za-z0-9]+|\^[A-Za-z0-9]+)?(?:\([^()\n]{1,22}\))?|\d+(?:\.\d+)?)"
_EXPRESSION = re.compile(rf"(?<![A-Za-z]){_ATOM}(?:\s*[=+−×÷≤≥≠≈*/^_]\s*{_ATOM})+(?![A-Za-z])")
_PROSE_LABEL = re.compile(r"^(?:(?:Assumption|Remark|Theorem|Lemma|Proposition|Corollary|Definition)\s+\d+(?:\.\d+)*\s*:|Proof\s*:)", re.I)
_SHORT_PROSE = {"an", "as", "at", "be", "by", "do", "he", "if", "in", "is", "it", "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we"}


def _italic_identifier(glyphs: list[dict], word: str) -> bool:
    return (1 <= len(word) <= 2 and word.isalpha() and word.lower() not in _SHORT_PROSE
            and all(c["flags"] & 2 or c["math_font"] for c in glyphs))


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
            space = dict(char, c=" ")
            space.pop("ink_bbox", None)
            result.append(space)
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
    # A publisher may emit a named exponent/subscript as a separate roman
    # span/line. Its nearby larger mathematical base establishes the context.
    spans = [s for group in fonts.values() for s in group]
    bases = [s for s in spans if s["math_font"] and s["chars"]]
    for span in spans:
        text = "".join(c["c"] for c in span["chars"])
        if span["math_font"] or not re.fullmatch(r"[A-Za-z]{2,12}", text):
            continue
        box = fitz.Rect(span["bbox"])
        for base in bases:
            size = base["size"]
            target = fitz.Rect(base["bbox"])
            if (span["size"] < size * .85
                    and (target + (-size * .6, -size * .7, size * .6, size * .7)).intersects(box)):
                span["math_font"] = True
                break


def _prose_words(line: dict) -> list[str]:
    chars = _chars(line)
    size = _text_size(chars)
    text = "".join(c["c"] if not c["math_font"] and c["size"] >= size * 0.85 else " " for c in chars)
    text = re.sub(r"[A-Za-z]+", lambda m: " " * len(m[0])
                  if _italic_identifier(chars[m.start():m.end()], m[0]) else m[0], text)
    # Roman function names are not restricted to a vocabulary (Si, Range,
    # width, user-defined predicates, ...). Their argument list supplies the
    # mathematical context, while the rest of the sentence remains prose.
    text = re.sub(r"\b[A-Za-z]{2,}(?=\s*\()", " ", text)
    return [w for w in re.findall(r"[A-Za-z]{2,}", text) if w.lower() not in _MATH_LABELS]


def _text_size(chars: list[dict]) -> float:
    # A large bullet/operator must not make all the ordinary prose look like
    # superscripts. Use the prose's type size when the row contains prose.
    overall = max((c["size"] for c in chars), default=1)
    ordinary = [c for c in chars if not c["math_font"] and c["c"].isalpha()]
    words = re.findall(r'[A-Za-z]{2,}', ''.join(c['c'] if not c['math_font'] else ' ' for c in chars))
    if len(ordinary) >= 3 and len(words) >= 2 and max(c['size'] for c in ordinary) < overall * .8:
        # A 20pt extension glyph can sit in a 10pt sentence. The sentence's
        # words, even when much smaller than that operator, set its baseline.
        return Counter(round(c['size'], 2) for c in ordinary).most_common(1)[0][0]
    prose = max((c["size"] for c in chars if not c["math_font"]), default=overall)
    # The only roman letters in a vector may be a long subscript (e.g. a
    # component name). Do not promote that script to the main type size.
    return prose if prose >= overall * .8 else overall


def _prose_baseline(line: dict) -> float:
    chars = _chars(line)
    size = _text_size(chars)
    prose = [c for c in chars if not c["math_font"] and c["c"].isalpha() and c["size"] >= size * .85]
    base = [c for c in chars if c["size"] >= size * .85]
    return Counter(round(c["origin"][1], 1) for c in (prose or base or chars)).most_common(1)[0][0]


def _has_content(line: dict) -> bool:
    # CMEX maps some visible matrix delimiters to control codes (including CR).
    # Ordinary spaces, however, must never connect unrelated paragraphs through
    # a page-sized invisible PDF block.
    return any(c["size"] >= 1 and (c["c"].strip() or (c["math_font"] and ord(c["c"]) < 32))
               for c in _chars(line))


def _merge_inline_fragments(lines: list[dict]) -> list[dict]:
    # Some publishers put parentheses / tall brackets in separate PDF lines,
    # even inside a sentence. Attach them to that sentence before classification.
    # Join adjacent sentence fragments on the same baseline first.
    rows = []
    for line in lines:
        if not _has_content(line):
            continue
        target = next((row for row in rows
                       if (_prose_words(row) or _prose_words(line))
                       and abs(_prose_baseline(row) - _prose_baseline(line)) < 1
                       and max(row["bbox"][0], line["bbox"][0]) - min(row["bbox"][2], line["bbox"][2])
                           < max(s["size"] for s in row["spans"] + line["spans"]) * 2), None)
        if target is None:
            rows.append(dict(line, spans=list(line["spans"]), regions=[list(line["bbox"])]))
        else:
            target["spans"].extend(line["spans"])
            target["regions"].append(list(line["bbox"]))
            target["bbox"] = list(fitz.Rect(target["bbox"]) | fitz.Rect(line["bbox"]))
            target["merged"] = True
    lines = rows
    # Extension faces put brackets/operators on a displaced font baseline.
    # Associate their ink with a real row before looking only at prose rows;
    # otherwise a bracket on a mathematical continuation is pulled into the
    # preceding sentence while its matching bracket stays behind.
    removed = set()
    for line in lines:
        chars = [c for c in _chars(line) if c['c'].strip() or c['math_font'] and ord(c['c']) < 32]
        if not chars or not all(re.search(r'CMEX|MTEX|MathExtensions', c['font'], re.I) for c in chars):
            continue
        rect = fitz.Rect(line['bbox'])
        candidates = []
        for row in lines:
            if row is line or id(row) in removed:
                continue
            base = [c for c in _chars(row) if c['c'].strip()
                    and not re.search(r'CMEX|MTEX|MathExtensions', c['font'], re.I)]
            if not base:
                continue
            size = _text_size(_chars(row))
            if max(c['size'] for c in base) < max(c['size'] for c in chars) * .8:
                continue
            target = fitz.Rect(row['bbox'])
            dx = max(rect.x0 - target.x1, target.x0 - rect.x1, 0)
            center = (rect.y0 + rect.y1) / 2 + size * .25
            dy = abs(_prose_baseline(row) - center)
            if dx < size * 2 and dy < size * .8:
                candidates.append((dy + dx * .1, row))
        if candidates:
            row = min(candidates, key=lambda pair: pair[0])[1]
            row['spans'].extend(line['spans'])
            row['regions'].extend(line['regions'])
            row['bbox'] = list(fitz.Rect(row['bbox']) | rect)
            row['merged'] = True
            removed.add(id(line))
    lines = [line for line in lines if id(line) not in removed]
    anchors = [line for line in lines if _prose_words(line)]
    if not anchors:
        return lines
    merged = {id(line): dict(line, spans=list(line["spans"])) for line in anchors}
    standalone = []
    for line in lines:
        if id(line) in merged:
            continue
        rect = fitz.Rect(line["bbox"])
        candidates = []
        plain = "".join(c["c"] if not c["math_font"] else " " for c in _chars(line))
        worded = any(w.lower() not in _FUNCTIONS for w in re.findall(r"[A-Za-z]{2,}", plain))
        for anchor in anchors:
            # A short prose row (e.g. "over [interval]") is still its own
            # sentence row. Tall symbol boxes can touch the following row;
            # never interleave their glyphs merely because those boxes overlap.
            # Connectives such as "and" are excluded from mathematical prose
            # scoring, but still pin a mixed formula/prose row to its baseline.
            if (_prose_words(line) or worded) and abs(_prose_baseline(line) - _prose_baseline(anchor)) >= 1:
                continue
            target = fitz.Rect(anchor["bbox"])
            size = max(s["size"] for s in anchor["spans"])
            baseline_gap = abs(_prose_baseline(line) - _prose_baseline(anchor))
            tall_operator = any(c["math_font"] and (c["c"].strip() or ord(c["c"]) < 32)
                                and (fitz.Rect(c["bbox"]).height > size * 1.1
                                     or re.search(r'CMEX|MTEX|MathExtensions', c['font'], re.I)
                                     and fitz.Rect(c['bbox']).height > size * .8)
                                for c in _chars(line))
            small_script = (not worded and max(c["size"] for c in _chars(line)) < size * .85
                            and target.contains((rect.tl + rect.br) / 2) and baseline_gap < size * 1.3)
            if baseline_gap >= size * .6 and not tall_operator and not small_script:
                continue
            overlap = min(rect.y1, target.y1) - max(rect.y0, target.y0)
            # Require vertical contact; never absorb a separate display equation.
            if overlap > 0 and abs((rect.y0 + rect.y1 - target.y0 - target.y1) / 2) < size:
                candidates.append((baseline_gap if not tall_operator else abs(rect.y1 - target.y1), anchor))
            elif (rect.height < size * .35 and not worded
                  and max(rect.y0 - target.y1, target.y0 - rect.y1, 0) < size * .3
                  and min(rect.x1, target.x1) > max(rect.x0, target.x0)
                  and abs(_prose_baseline(line) - _prose_baseline(anchor)) < size * .6):
                # A detached hat/tilde has no vertical ink contact with its
                # base glyph. Its baseline still identifies the correct row.
                candidates.append((abs(_prose_baseline(line) - _prose_baseline(anchor)), anchor))
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


def merge_inline_items(items: list[dict]) -> list[dict]:
    """Reach closure after newly attached math reveals another adjacent row."""
    items = _piecewise_items(items)
    while True:
        merged = _merge_inline_items_once(items)
        if len(merged) == len(items):
            return _attach_inline_limits(merged)
        items = merged


def _piecewise_items(items: list[dict]) -> list[dict]:
    """Keep a multi-row case definition, including its conditions, intact.

    The opening extension glyph spans the rows; the mathematical left-hand
    side and a right-hand column bound the definition. Treating its conditions
    as a paragraph would put a tall brace into a single inline image.
    """
    result = list(items)
    for bracket in list(items):
        chars = [c for line in bracket.get('lines', []) for c in _chars(line) if c['c'].strip()]
        if len(chars) != 1:
            continue
        char = chars[0];size = char['size'];box = fitz.Rect(char['bbox'])
        if (char['c'] not in '{(' or not re.search(r'CMEX|MTEX|MathExtensions', char['font'], re.I)
                or box.height < size * 1.8):
            continue
        left = [item for item in result if item is not bracket and item.get('type') == 0
                and box.x0 - size * 12 <= item['bbox'][0] < item['bbox'][2] <= box.x0 + size * .3
                and abs((item['bbox'][1]+item['bbox'][3])/2 - (box.y0+box.y1)/2) < size
                and all(_display(line) for line in item['lines'])
                and '=' in ''.join(c['c'] for line in item['lines'] for c in _chars(line))]
        right = [item for item in result if item is not bracket and item.get('type') == 0
                 and box.x1 - size * .4 <= item['bbox'][0] <= box.x1 + size * 4
                 and box.y0 - size * .35 <= item['bbox'][1]
                 and item['bbox'][3] <= box.y1 + size * .35]
        if not left or not right or not any(len(item['lines']) >= 2 for item in right):
            continue
        members = [max(left,key=lambda item:item['bbox'][2]), bracket, *right]
        if not all(any(item is member for item in result) for member in members):
            continue
        whole = fitz.Rect(members[0]['bbox'])
        for item in members[1:]:whole |= fitz.Rect(item['bbox'])
        replacement = dict(members[0], bbox=list(whole), display_math=True,
                           lines=[dict(line, regions=line.get('regions', [list(line['bbox'])]))
                                  for item in members for line in item['lines']])
        result = [item for item in result if all(item is not member for member in members)] + [replacement]
    return result


def _attach_inline_limits(items: list[dict]) -> list[dict]:
    """Attach detached operator/limit rows using mathematical glyph contact.

    A large operator's baseline can be more than one em away from the prose
    baseline. Its limits must travel with the inline image, not survive as a
    second display equation after the prose has been moved.
    """
    items = [dict(item, lines=_merge_inline_fragments(item.get('lines', [])))
             if item.get('type') == 0 and not item.get('algorithm') and not item.get('algorithm_step') and not item.get('display_math')
             else dict(item, lines=list(item.get('lines', []))) for item in items]
    anchors = [(item, line) for item in items if not item.get('display_math')
               for line in item['lines'] if _prose_words(line)]
    detached = [(item, line) for item in items if not item.get('display_math') for line in item['lines']
                if _has_content(line) and not _prose_words(line)]
    for item, line in detached:
        chars = [c for c in _chars(line) if c['c'].strip()]
        if not chars:
            continue
        choices = []
        for _, anchor in anchors:
            size = _text_size(_chars(anchor))
            plain = ''.join(c['c'] if not c['math_font'] else ' ' for c in chars)
            worded = any(w.lower() not in _FUNCTIONS for w in re.findall(r'[A-Za-z]{2,}', plain))
            if worded and abs(_prose_baseline(line) - _prose_baseline(anchor)) >= 1:
                continue
            small = max(c['size'] for c in chars) < size * .85
            operator = any(c['math_font'] and (fitz.Rect(c['bbox']).height > size * 1.1
                           or re.search(r'CMEX|MTEX', c['font'], re.I)
                           and fitz.Rect(c['bbox']).height > size * .8) for c in chars)
            if not (small or operator) or abs(_prose_baseline(line) - _prose_baseline(anchor)) > size * 1.8:
                continue
            # Limits attach to an operator, not to a variable in the previous
            # sentence whose descenders happen to touch the raised limit.
            bases = [c for c in _chars(anchor) if c['math_font'] and c['c'].strip()
                     and (not small or c['c'] in '∑∏∫⋃⋂'
                          or re.search(r'CMEX|MTEX|MathExtensions', c['font'], re.I))]
            operator_boxes = [fitz.Rect(c['bbox']) for c in chars
                              if re.search(r'CMEX|MTEX|MathExtensions', c['font'], re.I)]
            row_y = (sum((box.y0 + box.y1) / 2 for box in operator_boxes) / len(operator_boxes)
                     if operator_boxes else _prose_baseline(line))
            for base in bases:
                a, b = fitz.Rect(line['bbox']), fitz.Rect(base['bbox'])
                dx = max(a.x0 - b.x1, b.x0 - a.x1, 0)
                dy = max(a.y0 - b.y1, b.y0 - a.y1, 0)
                if dx < size * .35 and dy < size * .35:
                    choices.append((dx + dy + abs(_prose_baseline(anchor) - row_y) * .25, anchor))
        if not choices:
            continue
        anchor = min(choices, key=lambda pair: pair[0])[1]
        anchor['spans'].extend(line['spans'])
        anchor['bbox'] = list(fitz.Rect(anchor['bbox']) | fitz.Rect(line['bbox']))
        anchor['merged'] = True
        item['lines'].remove(line)
    result = []
    for item in items:
        if item.get('type') == 0 and not item['lines']:
            continue
        if item['lines']:
            box = fitz.Rect(item['lines'][0]['bbox'])
            for line in item['lines'][1:]:
                box |= fitz.Rect(line['bbox'])
            item['bbox'] = list(box)
        result.append(item)
    return result


def _merge_inline_items_once(items: list[dict]) -> list[dict]:
    """Reunite PDF blocks split in the middle of a row by tall inline math.

    Classifying each item first can mistake a formula-only prefix of a prose
    row for display math. Require overlapping column boxes and adjacent glyphs
    on the same baseline; vertical overlap alone also occurs between paragraphs.
    """
    boxes = [fitz.Rect(item["bbox"]) for item in items if item.get("type") == 0]
    extent = max((box.x1 for box in boxes), default=0) - min((box.x0 for box in boxes), default=0)
    # A short row can be split into disjoint prose/math/prose PDF items.
    # Nearby long paragraphs establish the column so joining those fragments
    # cannot accidentally connect the two columns across their narrow gutter.
    columns = [fitz.Rect(item["bbox"]) for item in items if item.get("type") == 0
               and extent * .25 < fitz.Rect(item["bbox"]).width < extent * .65
               and sum(len(_prose_words(line)) for line in item.get("lines", [])) >= 6]
    if len(columns) < 4:
        columns.extend(fitz.Rect(item['bbox']) for item in items if item.get('type') == 0
                       and fitz.Rect(item['bbox']).width >= extent * .65
                       and sum(bool(_prose_words(line)) for line in item.get('lines', [])) >= 4)
    result = []
    rows = []
    for item in items:
        if item.get("type") == 0:
            content = [line for line in item["lines"] if _has_content(line)]
            if not content:
                continue
            box = fitz.Rect(content[0]["bbox"])
            for line in content[1:]:
                box |= fitz.Rect(line["bbox"])
            item = dict(item, lines=content, bbox=list(box))
        lines = None if item.get("type") == 0 and not item.get("algorithm") and not item.get('display_math') else []
        matches = []
        for index, previous in enumerate(result):
            if lines == [] or rows[index] == []:
                continue
            if item.get("algorithm_step") != previous.get("algorithm_step"):
                continue
            overlap = fitz.Rect(previous["bbox"]) & fitz.Rect(item["bbox"])
            if overlap.is_empty:
                a, b = fitz.Rect(previous["bbox"]), fitz.Rect(item["bbox"])
                if min(a.y1, b.y1) <= max(a.y0, b.y0) or not any(
                        col.x0 - 4 <= min(a.x0, b.x0) and max(a.x1, b.x1) <= col.x1 + 4 for col in columns):
                    continue
            # Most items never overlap. Normalize only candidate pairs, so
            # ordinary pages do not pay for a second pass over every glyph.
            if lines is None:
                lines = _merge_inline_fragments(item["lines"])
            if rows[index] is None:
                rows[index] = _merge_inline_fragments(previous["lines"])
            for a in rows[index]:
                for b in lines:
                    size = max(s["size"] for s in a["spans"] + b["spans"])
                    gap = max(a["bbox"][0], b["bbox"][0]) - min(a["bbox"][2], b["bbox"][2])
                    prose_a, prose_b = _prose_words(a), _prose_words(b)
                    baseline_gap = abs(_prose_baseline(a) - _prose_baseline(b))
                    contact = min(a["bbox"][3], b["bbox"][3]) - max(a["bbox"][1], b["bbox"][1])
                    tall_symbol = any(c["math_font"] and (c["c"].strip() or ord(c["c"]) < 32)
                                      and fitz.Rect(c["bbox"]).height > size * 1.1
                                      for row in (a, b) if not _prose_words(row) for c in _chars(row))
                    small_script = any(not _prose_words(row)
                                       and max(c["size"] for c in _chars(row)) < size * .85
                                       and fitz.Rect(other["bbox"]).contains(
                                           (fitz.Rect(row["bbox"]).tl + fitz.Rect(row["bbox"]).br) / 2)
                                       for row, other in ((a, b), (b, a)))
                    inline_script = (bool(prose_a) != bool(prose_b)
                                     and (baseline_gap < size * .4 or tall_symbol or small_script)
                                     and contact > min(fitz.Rect(a["bbox"]).height, fitz.Rect(b["bbox"]).height) * .4)
                    if (gap < size * 1.5
                            and (baseline_gap < 1 or inline_script)
                            and (prose_a or prose_b or baseline_gap < 1)):
                        matches.append(index)
                        break
                if matches and matches[-1] == index:
                    break
        if not matches:
            result.append(dict(item))
            rows.append(lines)
            continue
        first = matches[0]
        members = [result[index] for index in matches] + [item]
        box = fitz.Rect(item["bbox"])
        for member in members:
            box |= fitz.Rect(member["bbox"])
        result[first] = dict(result[first], bbox=list(box),
                             lines=[line for member in members for line in member["lines"]])
        rows[first] = _merge_inline_fragments(result[first]["lines"])
        for index in reversed(matches[1:]):
            del result[index]
            del rows[index]
    return result


def _math_ranges(chars: list[dict]) -> list[tuple[int, int]]:
    text = "".join(c["c"] for c in chars)
    # Type3 mathematical glyphs can map to CR / FF / TAB. They are visible
    # symbols in the PDF, despite Python treating those codes as whitespace.
    selected = [bool(c["math_font"] and ord(c["c"]) < 32) for c in chars]
    size = _text_size(chars)
    italic_prose = (len(re.findall(r"[A-Za-z]{3,}", text)) >= 3
                    and sum(bool(c["flags"] & 2) for c in chars) > len(chars) * 0.8)
    for word in re.finditer(r"[A-Za-zﬀﬁﬂﬃﬄﬅﬆ]+|[^A-Za-zﬀﬁﬂﬃﬄﬅﬆ\s]", text):
        # A prose ligature can live in a tiny subset font otherwise used only
        # for symbols. Do not turn the middle of "classification" into math.
        if word[0] in "ﬀﬁﬂﬃﬄﬅﬆ" and (
                word.start() > 0 and text[word.start() - 1].isalpha()
                or word.end() < len(text) and text[word.end()].isalpha()):
            continue
        glyphs = chars[word.start():word.end()]
        font_math = any(c["math_font"] for c in glyphs)
        short_italic = ((not italic_prose or word[0] not in {"a", "A", "I"})
                        and _italic_identifier(glyphs, word[0]))
        # An italic sentence is prose; ordinary italic words are never math.
        math_word = font_math and (len(word[0]) <= 2 or word[0] in _FUNCTIONS
                                  or all(c["math_font"] or c["size"] < size * 0.85 for c in glyphs))
        if math_word or short_italic or _SYMBOL.search(word[0]):
            selected[word.start():word.end()] = [True] * len(word[0])
    for match in _EXPRESSION.finditer(text):
        selected[match.start():match.end()] = [True] * len(match[0])
    for match in re.finditer(r'\d+(?:\.\d+)?(?:[eE][+-]?\d+)?', text):
        a, b = match.span()
        # Upright numeric powers may use only the prose font. Keep the base
        # and exponent as one image whenever their size/baseline changes.
        glyphs = chars[a:b]
        sizes = [c['size'] for c in glyphs]
        baselines = [c.get('origin', (0, 0))[1] for c in glyphs]
        raised = (len(glyphs) > 1 and min(sizes) < max(sizes) * .85
                  and max(baselines) - min(baselines) > max(sizes) * .15)
        if any(selected[a:b]) or raised:
            selected[a:b] = [True] * (b - a)
    # Keep numeric values adjacent to a selected operator. Otherwise the
    # translator can move the 0 in "f(x) = 0" outside its definition.
    for match in re.finditer(r"[=+−×÷≤≥≠≈<>-]\s*[+-]?\d+(?:\.\d+)?", text):
        if selected[match.start()]:
            selected[match.start():match.end()] = [True] * len(match[0])
    for match in re.finditer(r"\b\d+(?:\.\d+)?(?=\s+(?:if|otherwise)\b)", text):
        selected[match.start():match.end()] = [True] * len(match[0])
    # Upright constants before an operator belong to that expression too.
    # Selecting only the minus sign in "1 − Σ ..." lets translation move 1
    # into a different clause, changing the mathematical statement.
    for match in re.finditer(r"(?<![A-Za-z0-9])\d+(?:\.\d+)?\s*[+−-]\s*", text):
        if match.end() < len(selected) and selected[match.end()]:
            selected[match.start():match.end()] = [True] * len(match[0])
    # Blackboard sets can be encoded as an upright ASCII R/N/etc. in a prose
    # font. Preserve that base after membership; the script pass adds dimensions.
    for match in re.finditer(r"[∈∉⊂⊆]\s*[RNCQZ]", text):
        selected[match.start():match.end()] = [True] * len(match[0])
    # A roman digit or closing bracket can be outside the math font. Preserve
    # the complete numeric interval once any of its contents is mathematical.
    for match in re.finditer(r"[\[({][^()\[\]{}\n]{1,45}[\])}]", text):
        a, b = match.span()
        words = re.findall(r"[A-Za-z]{3,}", match[0])
        if any(selected[a:b]) and all(w.lower() in _FUNCTIONS for w in words):
            selected[a:b] = [True] * (b - a)
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

    # An italic subsection label ("A. Partitioning scheme") is text, not
    # a mathematical variable. Keep actual expressions such as "A. x = 2".
    if (re.fullmatch(r"[A-Z]\.\s+[A-Z][A-Za-z]+(?:[ -][A-Za-z]+)*\s*", text)
            and not _MATH_FONT.search(chars[0]["font"])):
        selected[0] = False

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
    optimization_label = bool(re.fullmatch(r'[A-Z]{1,5}\s*:\s*(?:min|max|inf|sup)', text)
                              or re.match(r"[A-Z]{1,5}\s*:", text) and math
                              and all(len(w) <= 3 or w.lower() in _FUNCTIONS for w in prose))
    subscript_fragment = bool(re.fullmatch(r'[A-Za-z]\d{1,3}', text))
    return optimization_label or subscript_fragment or text.lower() in _FUNCTIONS or (math and not prose) or (
        not prose and any(c["flags"] & 2 for c in chars) and len(text) < 90)


def layout_blocks(item: dict, page_number: int, first_index: int) -> list[dict]:
    """Split mixed text/display blocks at line boundaries, retaining all glyphs."""
    lines = [line for line in item["lines"] if _has_content(line)]
    if not item.get("algorithm") and not item.get('display_math'):
        lines = _merge_inline_fragments(lines)
    kinds = [bool(item.get('display_math')) or _display(line) for line in lines]
    if any(kinds) and not any(_prose_words(line) for line in lines):
        kinds = [True] * len(lines)
    # Matrix brackets, limits, and equation numbers may be separate PDF lines.
    for i, line in enumerate(lines):
        text = "".join(c["c"] for c in _chars(line)).strip()
        if not _prose_words(line) and re.fullmatch(r"[\s\d()\[\]{}.,;:|a-z\u2212-]+", text) and len(text) < 20:
            if (i and kinds[i - 1]) or (i + 1 < len(lines) and kinds[i + 1]):
                kinds[i] = True
    if item.get("algorithm") or item.get("algorithm_step"):
        kinds = [False] * len(lines)
    groups = []
    for line, kind in zip(lines, kinds):
        text = "".join(c["c"] for c in _chars(line)).strip()
        if not groups or groups[-1][0] != kind or (not kind and _PROSE_LABEL.match(text)):
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
                                 "glyph_origins": [list(c["origin"]) for c in chars[a:b]
                                                   if (not c["c"].isspace() or c["math_font"] and ord(c["c"]) < 32)
                                                   and not c.get("ink_bbox")],
                                 "extra_ink": [c["ink_bbox"] for c in chars[a:b] if c.get("ink_bbox")],
                                 "baseline": _prose_baseline(line)})
                parts.extend((text[offset:a], token))
                offset = b
            protected.append("".join(parts) + text[offset:])
        blocks.append({"id": identity, "page": page_number, "bbox": list(rect),
                       "regions": [region for line in group for region in line["regions"]],
                       "text": "\n".join(original).strip(), "font_size": size,
                       "kind": "formula" if kind else "text", "formulas": formulas,
                       "translation_text": "\n".join(protected).strip()})
        letters = [c for c in all_chars if c["c"].isalpha()]
        if letters and sum(bool(c["flags"] & 16) for c in letters) >= len(letters) * .9:
            blocks[-1]["bold_heading"] = True
        if item.get("algorithm_step"):
            blocks[-1]["algorithm_step"] = item["algorithm_step"]
            blocks[-1]["font_size"] = item["algorithm_size"]
            blocks[-1]["bbox"][2] = item["algorithm_right"]
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
                       and not _PROSE_LABEL.match(block["text"])
                       and not b.get("algorithm_step") and not block.get("algorithm_step")
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
        box = fitz.Rect(block["bbox"])
        previous = next((b for b in reversed(result) if b["page"] == block["page"]
                         and b["bbox"][1] <= box.y0 + 1
                         and min(b["bbox"][2], box.x1) > max(b["bbox"][0], box.x0)), None)
        join = False
        if (previous and previous["page"] == block["page"]
                and previous.get("kind") == block.get("kind") == "text"
                and not previous.get("algorithm_step") and not block.get("algorithm_step")
                and not _PROSE_LABEL.match(block["text"])
                and not formula_only_block(previous) and not formula_only_block(block)):
            a, b = fitz.Rect(previous["bbox"]), fitz.Rect(block["bbox"])
            aligned = abs(a.x0 - b.x0) < 8
            wrapped_word = bool(re.search(r"[a-z]-\s*$", previous["text"]) and re.match(r"[a-z]", block["text"]))
            if wrapped_word:
                aligned = abs(a.x0 - b.x0) < min(previous["font_size"], block["font_size"]) * 2
            overlap = min(a.y1, b.y1) - max(a.y0, b.y0) > 0
            unfinished = len(previous["text"]) > 60 and re.search(
                r"\b(?:on|in|of|for|with|to|from|by|and|or|the|a|an|each|every|any|all)\s*$",
                previous["text"], re.I)
            sentence_tail = (len(previous["text"]) > 60 and not re.search(r"[.!?:;]\s*$", previous["text"])
                             and re.match(r"(?:is|are|denotes?|represents?)\b", block["text"]))
            gap = b.y0 - a.y1
            join = aligned and (overlap or ((unfinished or sentence_tail or wrapped_word) and 0 <= gap <= min(
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

