"""Bounded reading context for PDF blocks, including page continuations."""
from __future__ import annotations

import json
import re
from statistics import median

from papeer.layout.math_layout import restore_formula_text
from papeer.layout.reading_flow import translation_blocks


def contextual_units(document: dict, units: list[dict], limit: int = 700) -> list[dict]:
    blocks = {block["id"]: block for block in translation_blocks(document)}
    readable = [restore_formula_text(unit["text"], blocks[unit["block"]]) for unit in units]

    def neighbor(indices):
        # Follow the geometry-derived reading order, retaining short fragments.
        # Explicit marginal metadata, rather than length, excludes running heads.
        return next((i for i in indices
                     if readable[i].strip() and not readable[i].strip().isdigit()
                     and not blocks[units[i]["block"]].get("reading_margin")
                     and not blocks[units[i]["block"]].get("running_header")), None)

    result = []
    for index, unit in enumerate(units):
        block = blocks[unit["block"]]
        # Running heads and margin notes stand on their own; the prose around them is not theirs.
        marginal = block.get("reading_margin") or block.get("running_header")
        before = None if marginal else neighbor(range(index - 1, -1, -1))
        after = None if marginal else neighbor(range(index + 1, len(units)))
        formulas = [{"token": f["token"], "source": f["text"]}
                    for f in block.get("formulas", []) if f["token"] in unit["text"]]
        context = {"before": readable[before][-limit:] if before is not None else "",
                   "after": readable[after][:limit] if after is not None else "",
                   "formulas": formulas,
                   # Which units the text came from, so that a request holding that unit
                   # as well leaves the text out (request_payload).
                   "before_unit": units[before]["id"] if before is not None else None,
                   "after_unit": units[after]["id"] if after is not None else None}
        result.append(dict(unit, context=context))
    return result


# The title and abstract sent with every translation request, in characters (paper_context).
PAPER_CONTEXT_LIMIT = 800
_TITLE_LIMIT = 200
# "Abstract", "ABSTRACT", Elsevier's spaced "a b s t r a c t", or "Summary", with the text after it
# in the same block ("Abstract—We ...", "Abstract. We ...") or alone as a heading.
_ABSTRACT = re.compile(r"\s*(?:a ?b ?s ?t ?r ?a ?c ?t|summary)\b\s*(?:[.:\-–—]\s*)?", re.I)
# What follows an abstract: keywords, classifications, the copyright line, or the first section.
_AFTER_ABSTRACT = re.compile(
    r"\s*(?:(?:key ?words?|index terms|ccs concepts|acm reference format|categories and subject descriptors"
    r"|general terms|msc|copyright)\b|©|(?:(?:1|I)\.?\s+)?introduction\b)", re.I)
# The identifier arXiv prints along the left edge of its versions ("arXiv:1706.03762v7 [cs.CL] ...").
_ARXIV_STAMP = re.compile(r"\s*arXiv:\d", re.I)


def _prose(block: dict) -> bool:
    return (block.get("kind", "text") == "text" and not block.get("reading_margin")
            and not block.get("running_header") and bool(block.get("text", "").strip()))


def _plain(text: str) -> str:
    # Line-end hyphenation of prose joins again; other line breaks are spaces.
    return " ".join(re.sub(r"(?<=[a-z])-\n(?=[a-z])", "", text).split())


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit * 0.8 else cut).rstrip() + "…"


def _title(document: dict, first_page: list[dict]) -> str:
    """The metadata title when the first page shows it, else the largest text of the first page.

    Of texts in nearly the largest size (90% or more), the longest is taken: a journal's name
    set a little larger than the title is shorter than the title. Vertical text (the arXiv
    identifier along the left edge) is left out. A title set over several blocks takes the blocks
    of the same size right below it.
    """
    shown = _plain(" ".join(block["text"] for block in first_page)).casefold()
    metadata = _plain(document.get("title") or "")
    # A title not on the page is often a file name or a word processor's placeholder.
    if len(metadata.split()) >= 2 and metadata.casefold() in shown:
        return metadata
    sized = [block for block in first_page if isinstance(block.get("font_size"), (int, float))]
    if not sized:
        return ""
    body = median(block["font_size"] for block in sized for _ in range(max(1, len(block["text"]) // 100)))
    candidates = [block for block in sized if 2 <= len(_plain(block["text"]).split()) and len(block["text"]) <= 300
                  and not _vertical(block) and not _ARXIV_STAMP.match(block["text"])
                  and block["font_size"] >= body * 1.2]
    if not candidates:
        return ""
    largest = max(block["font_size"] for block in candidates)
    best = max((block for block in candidates if block["font_size"] >= largest * 0.9),
               key=lambda block: len(_plain(block["text"])))
    parts, previous = [_plain(best["text"])], best.get("bbox")
    if not previous:
        return parts[0]
    for block in sorted((b for b in first_page if b.get("bbox") and b is not best), key=lambda b: b["bbox"][1]):
        box = block["bbox"]
        # Only blocks below the title and overlapping its width; the first other one ends it.
        if box[1] < previous[1] + 1 or not (box[0] < previous[2] and box[2] > previous[0]):
            continue
        if (abs((block.get("font_size") or 0) - best["font_size"]) > 0.5 or box[1] - previous[3] > best["font_size"]
                or sum(map(len, parts)) + len(block["text"]) > _TITLE_LIMIT):
            break
        parts.append(_plain(block["text"]))
        previous = box
    return " ".join(parts)


def _vertical(block: dict) -> bool:
    box = block.get("bbox")
    return bool(box) and box[3] - box[1] > 2 * (box[2] - box[0])


def _abstract(blocks: list[dict]) -> str:
    """The text after the first "Abstract" of the first two pages: in the same block, or the
    blocks below the heading in its column (the next ones in reading order without positions)."""
    for index, block in enumerate(blocks):
        match = _ABSTRACT.match(block["text"])
        # Prose that happens to begin with the word ("Abstract algebra is ...") goes on in lower case.
        if not match or block["page"] > 2 or block["text"][match.end():match.end() + 1].islower():
            continue
        rest = block["text"][match.end():]
        if len(_plain(rest)) >= 40:
            return _plain(rest)
        following = [b for b in blocks[index + 1:] if b["page"] == block["page"]]
        heading = block.get("bbox")
        if heading and all(b.get("bbox") for b in following):
            # Blocks below the heading and overlapping its width, top to bottom. Reading order may
            # put the heading of the next column first when the headings sit side by side.
            following = sorted((b for b in following if b["bbox"][1] >= heading[1] + 1
                                and b["bbox"][0] < heading[2] and b["bbox"][2] > heading[0]),
                               key=lambda b: b["bbox"][1])
        parts: list[str] = []
        previous = heading
        for candidate in following:
            if _AFTER_ABSTRACT.match(candidate["text"]) or sum(map(len, parts)) >= PAPER_CONTEXT_LIMIT:
                break
            # Stop at a gap wider than a few lines: what comes next is no longer the abstract.
            size = candidate.get("font_size") or 10
            if parts and previous and candidate.get("bbox") and candidate["bbox"][1] - previous[3] > 3 * size:
                break
            parts.append(_plain(candidate["text"]))
            previous = candidate.get("bbox")
        return " ".join(parts)
    return ""


def paper_context(document: dict) -> dict | None:
    """The title and abstract of the paper, at most PAPER_CONTEXT_LIMIT characters, or None when
    neither is found. Sent with every translation request to help choose terminology; the
    translation key does not hold it (it is request-only, like the context of each unit)."""
    blocks = [block for block in document.get("blocks", []) if _prose(block)]
    if not blocks:
        return None
    title = _clip(_title(document, [b for b in blocks if b["page"] == blocks[0]["page"]]), _TITLE_LIMIT)
    abstract = _clip(_abstract(blocks), PAPER_CONTEXT_LIMIT - len(title))
    context = {key: value for key, value in (("title", title), ("abstract", abstract)) if value}
    return context or None


def request_payload(units: list[dict], paper: dict | None = None) -> dict:
    """What the first request of a batch sends: each unit's id and text, and only the context
    the model cannot read from the request itself.

    The units of a batch follow each other in reading order, so the text around a unit is mostly
    the neighboring unit of the same request. context.before and context.after are sent only where
    that neighbor is not in the request (in practice the first and last unit of a batch, and units
    next to paragraphs translated earlier). The glossary entries of all units go once at the top.
    The block, page and continuation fields of a unit are for the app and not sent.

    The paper's title and abstract (paper_context) go first, so that the start of every request
    of a paper is the same and a service can reuse it (prompt caching); the batch follows.

    This shapes the request only: the units themselves (and so page_fingerprint and
    TranslationKey, which hash them with their glossary) stay as they are.
    """
    glossary: dict[str, dict] = {}
    blocks = []
    for index, unit in enumerate(units):
        item = {"id": unit["id"], "text": unit["text"]}
        context = unit.get("context") or {}
        shown = {}
        previous = units[index - 1]["id"] if index else None
        following = units[index + 1]["id"] if index + 1 < len(units) else None
        if context.get("before") and previous != context.get("before_unit"):
            shown["before"] = context["before"]
        if context.get("after") and following != context.get("after_unit"):
            shown["after"] = context["after"]
        if context.get("formulas"):
            shown["formulas"] = context["formulas"]
        if shown:
            item["context"] = shown
        blocks.append(item)
        for term in unit.get("glossary", []):
            glossary.setdefault(json.dumps(term, ensure_ascii=False, sort_keys=True), term)
    return {**({"paper": paper} if paper else {}),
            **({"glossary": list(glossary.values())} if glossary else {}), "blocks": blocks}


def request_text(units: list[dict], paper: dict | None = None) -> str:
    """The data of the first request of a batch (request_payload), as sent."""
    return json.dumps(request_payload(units, paper), ensure_ascii=False)


def recovery_context(unit: dict) -> dict:
    """Recovery uses integer math indices, never inject marker strings there."""
    context = unit.get("context")
    if not context:
        return {}
    return {"reading_context": {"before": context["before"], "after": context["after"]},
            "formula_meanings": [{"index": i, "source": f["source"]}
                                 for i, f in enumerate(context["formulas"])]}
