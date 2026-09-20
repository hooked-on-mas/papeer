"""Conservative reference detection: a heading opens a candidate range only.

Each block must independently pass bibliographic checks. Uncertain blocks stay
translatable, including continuations lacking enough bibliographic evidence.
"""
from __future__ import annotations

import re
import unicodedata

_HEADING = re.compile(r"^(?:(?:\d+|[IVX]+)[.\s]+)?(?:references|bibliography|literature cited|参考文献)\s*[:.]?$", re.I)
_END = re.compile(r"^(?:appendix\b|appendices\b|supplementary\b|acknowledg(?:e)?ments?\b|author biographies\b|付録)", re.I)
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


def _reading_order(document: dict):
    for page in document["pages"]:
        blocks = [b for b in document["blocks"] if b["page"] == page["number"]]
        middle = page["width"] / 2
        left = [b for b in blocks if b["bbox"][2] <= middle + 12 and len(b["text"]) > 80]
        right = [b for b in blocks if b["bbox"][0] >= middle - 12 and len(b["text"]) > 80]
        if left and right:
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
        else:
            yield from sorted(blocks, key=lambda b: (b["bbox"][1], b["bbox"][0]))


def mark_references(document: dict) -> None:
    active = False
    for block in _reading_order(document):
        text = " ".join(block["text"].split())
        if block.get("kind") in {"formula", "table", "figure"}:
            continue
        if _HEADING.fullmatch(text):
            active = True
            block.update(kind="reference", reference_evidence=["heading"])
        elif len(text) < 160 and _END.match(text):
            active = False
        elif active:
            evidence = reference_evidence(block["text"])
            if evidence:
                block.update(kind="reference", reference_evidence=evidence)
