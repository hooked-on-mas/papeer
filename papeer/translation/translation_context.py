"""Bounded reading context for PDF blocks, including page continuations."""
from __future__ import annotations

import json

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


def request_payload(units: list[dict]) -> dict:
    """What the first request of a batch sends: each unit's id and text, and only the context
    the model cannot read from the request itself.

    The units of a batch follow each other in reading order, so the text around a unit is mostly
    the neighboring unit of the same request. context.before and context.after are sent only where
    that neighbor is not in the request (in practice the first and last unit of a batch, and units
    next to paragraphs translated earlier). The glossary entries of all units go once at the top.
    The block, page and continuation fields of a unit are for the app and not sent.

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
    return {**({"glossary": list(glossary.values())} if glossary else {}), "blocks": blocks}


def request_text(units: list[dict]) -> str:
    """The data of the first request of a batch (request_payload), as sent."""
    return json.dumps(request_payload(units), ensure_ascii=False)


def recovery_context(unit: dict) -> dict:
    """Recovery uses integer math indices, never inject marker strings there."""
    context = unit.get("context")
    if not context:
        return {}
    return {"reading_context": {"before": context["before"], "after": context["after"]},
            "formula_meanings": [{"index": i, "source": f["source"]}
                                 for i, f in enumerate(context["formulas"])]}
