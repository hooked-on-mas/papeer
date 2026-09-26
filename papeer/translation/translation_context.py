"""Bounded reading context for PDF blocks, including page continuations."""
from __future__ import annotations

from papeer.layout.math_layout import restore_formula_text
from papeer.layout.reading_flow import translation_blocks


def contextual_units(document: dict, units: list[dict], limit: int = 700) -> list[dict]:
    blocks = {block["id"]: block for block in translation_blocks(document)}
    readable = [restore_formula_text(unit["text"], blocks[unit["block"]]) for unit in units]
    result = []
    for index, unit in enumerate(units):
        # Follow the geometry-derived reading order, retaining short fragments.
        # Explicit marginal metadata, rather than length, excludes running heads.
        before = next((readable[i][-limit:] for i in range(index - 1, -1, -1)
                       if readable[i].strip() and not readable[i].strip().isdigit()
                       and not blocks[units[i]["block"]].get("reading_margin")
                       and not blocks[units[i]["block"]].get("running_header")), "")
        after = next((readable[i][:limit] for i in range(index + 1, len(units))
                      if readable[i].strip() and not readable[i].strip().isdigit()
                       and not blocks[units[i]["block"]].get("reading_margin")
                       and not blocks[units[i]["block"]].get("running_header")), "")
        block = blocks[unit["block"]]
        formulas = [{"token": f["token"], "source": f["text"]}
                    for f in block.get("formulas", []) if f["token"] in unit["text"]]
        context = {"before": before, "after": after, "formulas": formulas}
        result.append(dict(unit, context=context))
    return result


def recovery_context(unit: dict) -> dict:
    """Recovery uses integer math indices, never inject marker strings there."""
    context = unit.get("context")
    if not context:
        return {}
    return {"reading_context": {"before": context["before"], "after": context["after"]},
            "formula_meanings": [{"index": i, "source": f["source"]}
                                 for i, f in enumerate(context["formulas"])]}
