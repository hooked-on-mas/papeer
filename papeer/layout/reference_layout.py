"""Conservative reference detection: a heading opens a candidate range only.

Each block must independently pass bibliographic checks. Uncertain blocks stay
translatable, including continuations lacking enough bibliographic evidence.
"""
from __future__ import annotations

import re
from typing import cast
import unicodedata

# Section numbers: 1-99 or Roman I-XXIX (not arbitrary letters such as "C.").
_NUMBER = r"(?:\d{1,2}|(?-i:(?=[IVX])X{0,2}(?:IX|IV|V?I{0,3})))"
# Section headings are always capitalised; a lower-case "references." is a
# sentence wrapped from the previous column, not the start of the list. The
# singular "Reference" is left out: it is a common plot legend label.
_HEADING = re.compile(
    r"(?:" + _NUMBER + r"(?:\.\s*|\s+))?"
    r"(?-i:(?=[A-Z]))(?:(?:selected\s+|cited\s+)?references(?:\s+(?:and|&)\s+(?:notes|further\s+reading))?"
    r"|references\s+cited|reference\s+list|list\s+of\s+references|notes\s+(?:and|&)\s+references"
    r"|bibliography(?:\s+(?:and|&)\s+references)?|works\s+cited|literature\s+cited|cited\s+literature)\s*[:.]?", re.I)
# Japanese headings are often letter-spaced ("参 考 文 献"), so whitespace is
# removed before matching.
_JA_HEADING = re.compile(r"(?:\d{1,2}\.?|第\d{1,2}章)?[\[【(]?(?:参考文献(?:一覧)?|引用文献|引用・参考文献)[\]】)]?[:.]?|文献")
_SECTION_NUMBER = re.compile(_NUMBER + r"\.?")
# Capitalised like section headings: "supplementary material, 2020." or
# "appendix B of [3]" inside an entry does not end the list.
_END = re.compile(r"^(?:(?-i:(?=[A-Z]))(?:appendix\b|appendices\b|supplementary\b|acknowledg(?:e)?ments?\b"
                  r"|author biographies\b)|付録)", re.I)
_ENTRY = re.compile(r"(?m)^[ \t]*(?:\[(\d{1,4})\]|(\d{1,4})[.)]|(\d{1,3}))[ \t]+")
_YEAR = re.compile(r"\b(?:18|19|20)\d{2}[a-z]?\b")
_AUTHOR = re.compile(r"(?:\b[A-Z]\.(?:\s*[A-Z]\.)*\s*[^\W\d_][\w’'\-]+|\b[^\W\d_][\w’'\-]+,\s*[A-Z]\.)")
_VENUE = re.compile(r"\b(?:journal|proceedings|conference|transactions|press|springer|elsevier|wiley|automatica|arxiv|vol\.|pp\.|IEEE|LNCS)\b", re.I)
_PAGES = re.compile(r"\b\d+\s*[–−-]\s*\d+\b|\b\d+\s*\(\d+\)\s*[:,]")
_DOI = re.compile(r"\b10\.\d{4,9}/\S+", re.I)
_PROSE = re.compile(r"\b(?:we (?:show|prove|use|propose|consider)|this (?:paper|section|result)|is currently|received the|research interests)\b", re.I)
_QUOTED = re.compile(r'"[^"\n]{2,}"|“[^”]{2,}”|「[^」]{2,}」')
_INSTRUCTION = re.compile(r"^(?:set|run|let|compute|repeat|return|initialize|if|for each)\b", re.I)


def reference_evidence(text: str) -> list[str]:
    """Broad OR cues, used only inside a heading-gated candidate range."""
    text = unicodedata.normalize("NFKC", text)
    entries = list(_ENTRY.finditer(text))
    # In a punctuated list, a wrapped journal volume ("59 (2014)") is
    # continuation text, not a new unpunctuated reference number.
    if any(m.group(1) or m.group(2) for m in entries):
        entries = [m for m in entries if m.group(1) or m.group(2)]
    if entries and text[:entries[0].start()].strip():
        return []  # A mixed prose/reference block must not hide its prose.
    parts = [text[m.end():entries[i + 1].start() if i + 1 < len(entries) else len(text)]
             for i, m in enumerate(entries)] if entries else [text]
    numbers = [int(next(g for g in m.groups() if g is not None)) for m in entries]
    sequential = len(numbers) >= 3 and all(b == a + 1 for a, b in zip(numbers, numbers[1:]))
    reasons = set()
    for index, part in enumerate(parts):
        flat = " ".join(part.split())
        if _PROSE.search(flat) or _INSTRUCTION.match(flat):
            return []
        author = bool(_AUTHOR.search(flat[:140]))
        year = bool(_YEAR.search(flat))
        venue = bool(_VENUE.search(flat))
        pages = bool(_PAGES.search(flat))
        doi = bool(_DOI.search(flat))
        cues = {
            "publication-year": year,
            "bracketed-entry-number": bool(entries and entries[index].group(1)),
            "sequential-entry-numbers": sequential,
            "quoted-title": bool(_QUOTED.search(flat)),
            "doi": doi,
            "publication-pages": venue and pages,
            "author-punctuation": author and (flat.count('.') >= 3 or flat.count(',') >= 3),
            "numbered-author": bool(entries) and author,
        }
        matched = {name for name, present in cues.items() if present}
        if not matched:
            return []
        reasons.update(matched)
    return sorted(reasons)


def _is_heading(line: str) -> bool:
    line = " ".join(unicodedata.normalize("NFKC", line).split())
    return bool(_HEADING.fullmatch(line) or _JA_HEADING.fullmatch(line.replace(" ", "")))


def _split_heading(lines: list[str]) -> str | None:
    """Return the text after a leading heading line, or None without one.

    A heading is often extracted into the same block as the first entry, and a
    section number can sit on its own line ("VII." / "REFERENCES").
    """
    for size in (1, 2):
        if len(lines) < size or (size == 2 and not _SECTION_NUMBER.fullmatch(lines[0])):
            continue
        if _is_heading(" ".join(lines[:size])):
            rest = "\n".join(lines[size:])
            # "References are listed ..." wrapped after one word is prose,
            # unlike an entry by "van der Berg, A. (2020)".
            return None if rest[:1].islower() and not reference_evidence(rest) else rest
    return None


def _reading_sequence(document: dict) -> list[dict]:
    """``document["blocks"]`` with margin blocks put back into their column.

    ``order_page`` resolves columns and bands, but moves small type near the
    page foot (footnotes, and also small "References"/"Acknowledgments"
    headings or entries) to the end of the page. Here each such block follows
    the last main-flow block above it in the same page and column instead.
    Pages where ``order_page`` found a single column are re-read with a
    coordinate-based two-column fallback. Neither change affects the reading
    order or translation units.
    """
    sequence = list(document["blocks"])
    gutters = {page["number"]: (page.get("reading_order") or {}).get("gutter") for page in document["pages"]}
    margins = sorted((b for b in sequence if b.get("reading_margin") and gutters.get(b["page"]) is not None),
                     key=lambda b: (b["page"], b["bbox"][1]))
    for block in margins:
        gutter = cast(float, gutters[block["page"]])  # margins holds only pages with a gutter
        x0, y0, x1, _ = block["bbox"]
        lane = 0 if x1 <= gutter + 3 else 1 if x0 >= gutter - 3 else None
        if lane is None:
            continue  # A full-width footer stays at the end of the page.
        anchor = next((i for i in range(len(sequence) - 1, -1, -1)
                       if sequence[i]["page"] == block["page"] and not sequence[i].get("reading_margin")
                       and sequence[i].get("flow_lane") == lane and sequence[i]["bbox"][1] < y0), None)
        if anchor is None:
            continue  # Nothing above it in this column: keep order_page's place.
        position = next(i for i, b in enumerate(sequence) if b is block)
        del sequence[position]
        index = anchor + (position > anchor)
        # Keep margin blocks already moved below the same anchor in y order.
        while (index < len(sequence) and sequence[index].get("reading_margin")
               and sequence[index]["page"] == block["page"] and sequence[index]["bbox"][1] <= y0):
            index += 1
        sequence.insert(index, block)
    result = []
    for page in document["pages"]:
        blocks = [b for b in sequence if b["page"] == page["number"]]
        if (page.get("reading_order") or {}).get("columns") == 1:
            blocks = list(_coordinate_columns(page, blocks))
        result.extend(blocks)
    return result


def _coordinate_columns(page: dict, blocks: list[dict]):
    """Two-column fallback for pages where ``order_page`` found one column.

    A short final column, or short initial-style entries ("E. Wilson, ...")
    that ``order_page`` does not count as prose, leave a reference page
    without a detected gutter. Only reference detection uses this order.
    """
    middle = page["width"] / 2
    left = [b for b in blocks if b["bbox"][2] <= middle + 12 and len(b["text"]) > 80]
    right = [b for b in blocks if b["bbox"][0] >= middle - 12 and len(b["text"]) > 80]
    if not (left and right):
        yield from blocks
        return
    # Full-width blocks delimit horizontal bands, then read each column.
    wide = sorted([b for b in blocks if b["bbox"][0] < middle - 12
                   and b["bbox"][2] > middle + 12], key=lambda b: b["bbox"][1])
    remaining = [b for b in blocks if b not in wide]
    for separator in wide + [None]:
        band = [b for b in remaining if separator is None or b["bbox"][1] < separator["bbox"][1]]
        yield from sorted(band, key=lambda b: (b["bbox"][0] >= middle - 12, b["bbox"][1]))
        remaining = [b for b in remaining if b not in band]
        if separator is not None:
            yield separator


def mark_references(document: dict) -> None:
    """Mark reference-list blocks, following the extracted reading order.

    ``document["blocks"]`` is already in reading order (columns and bands are
    resolved by ``order_page``); see ``_reading_sequence`` for the exceptions.
    """
    active = False
    for block in _reading_sequence(document):
        if block.get("kind") == "reference":
            # Re-evaluate older marks so a refresh can also un-mark blocks.
            block["kind"] = "text"
            block.pop("reference_evidence", None)
        if block.get("kind") in {"formula", "table", "figure", "algorithm"}:
            continue
        lines = [line.strip() for line in block["text"].splitlines() if line.strip()]
        rest = _split_heading(lines)
        if rest is not None:
            active = True
            if not rest:
                block.update(kind="reference", reference_evidence=["heading"])
            elif evidence := reference_evidence(rest):
                # The remainder is judged like any block: an uncertain first
                # entry keeps the whole block (and its heading) translatable.
                block.update(kind="reference", reference_evidence=["heading", *evidence])
        elif lines and len(lines[0]) < 160 and _END.match(lines[0]):
            active = False
        elif active:
            evidence = reference_evidence(block["text"])
            if evidence:
                block.update(kind="reference", reference_evidence=evidence)


def reference_text_blocks(document: dict) -> list[tuple[int, str]]:
    """Reference text in column order, without headings; pages are one-based.

    Read the existing marks and heading-gated evidence without changing the shared extraction.
    A heading is retained as an empty separator so separate bibliographies never merge.
    """
    result = []
    active = False
    for block in _reading_sequence(document):
        if block.get("kind") in {"formula", "table", "figure", "algorithm"}:
            continue
        lines = [line.strip() for line in block["text"].splitlines() if line.strip()]
        rest = _split_heading(lines)
        if rest is not None:
            active = True
            result.append((block["page"], ""))
        elif lines and len(lines[0]) < 160 and _END.match(lines[0]):
            active = False
        if not active:
            continue
        text = rest if rest is not None else "\n".join(lines)
        if not text:
            continue
        if block.get("kind") == "reference" or reference_evidence(text):
            result.append((block["page"], text))
            continue
        # The translation deliberately leaves a mixed continuation/new-entry block translatable.
        # For navigation, keep it if both parts independently have bibliographic evidence.
        entry = _ENTRY.search(text)
        if entry and text[:entry.start()].strip() and reference_evidence(text[:entry.start()]) and reference_evidence(text[entry.start():]):
            result.append((block["page"], text))
    return result
