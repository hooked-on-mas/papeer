"""Identify pages needing translation without flagging preserved end matter."""
from copy import deepcopy
import json
from pathlib import Path
import re

from paperdesk.layout.reading_flow import unit_pages
from paperdesk.layout.reference_layout import mark_references
from paperdesk.pdf.pdf_engine import translation_units


def cached_required_translation_pages(folder: Path, page_count: int) -> list[int]:
    try:
        document = json.loads((folder / "document.json").read_text("utf-8"))
        return required_translation_pages(document)
    except (OSError, ValueError, KeyError, TypeError):
        return list(range(1, page_count + 1))


def required_translation_pages(document: dict) -> list[int]:
    # Refresh reference recognition for older caches without rewriting the
    # extraction or invalidating saved translations.
    document = deepcopy(document)
    mark_references(document)
    reference_pages = {b["page"] for b in document["blocks"] if b.get("kind") == "reference"}
    dimensions = {p["number"]: p for p in document["pages"]}
    margin_blocks = {}
    for block in document["blocks"]:
        page = dimensions[block["page"]]
        bbox = block["bbox"]
        if bbox[3] < page["height"] * .15 or bbox[1] > page["height"] * .85:
            key = re.sub(r"\d+", "", " ".join(block["text"].split())).strip()
            if key:
                margin_blocks.setdefault(key, set()).add(block["page"])
    for block in document["blocks"]:
        if block["page"] not in reference_pages:
            continue
        text = " ".join(block["text"].split())
        key = re.sub(r"\d+", "", text).strip()
        bbox = block["bbox"]
        height = dimensions[block["page"]]["height"]
        running_header = (len(text) <= 180 and key.isupper()
                          and (bbox[3] < height * .15 or bbox[1] > height * .85)
                          and len(margin_blocks.get(key, set())) >= 2)
        contact = (re.match(r"^(?:Faculty|Department|School|Institute|University)\b", text)
                   and re.search(r"\bE-?mail(?: address)?\s*:", text, re.I)
                   and re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text))
        if running_header or contact:
            block["kind"] = "reference"
    return sorted({page for unit in translation_units(document) for page in unit_pages(unit)})
