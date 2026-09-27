"""Identify pages needing translation without flagging preserved end matter."""
import json
from pathlib import Path
import re
import threading

from papeer.layout.reading_flow import unit_pages
from papeer.layout.reference_layout import mark_references
from papeer.pdf.pdf_engine import translation_units
from papeer.core.paths import PaperFiles
from papeer.core.shared_json import signature

# The review pages of each document.json, while its signature stays the same: the reader asks for
# them whenever a translated page is ready, and the library list for every paper.
_REQUIRED_LOCK = threading.Lock()
_REQUIRED: dict[Path, tuple[tuple[int, int, int], list[int], list[dict]]] = {}
_REQUIRED_LIMIT = 1024


def cached_review_pages(folder: Path, page_count: int) -> dict:
    """Pages needing translation, and pages kept as the original because they need OCR
    ([{"page", "reason", "garbled_ratio"?}], see papeer.layout.ocr_pages)."""
    path = PaperFiles(folder).document_json
    try:
        stamp = signature(path)
        with _REQUIRED_LOCK:
            known = _REQUIRED.get(path)
        if known is None or known[0] != stamp:
            document = json.loads(path.read_text("utf-8"))
            known = (stamp, required_translation_pages(document),
                     [dict(entry) for entry in document.get("ocr_pages", [])])
            with _REQUIRED_LOCK:
                if len(_REQUIRED) >= _REQUIRED_LIMIT:
                    _REQUIRED.clear()
                _REQUIRED[path] = known
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {"required": list(range(1, page_count + 1)), "ocr": []}
    return {"required": list(known[1]), "ocr": [dict(entry) for entry in known[2]]}


def required_translation_pages(document: dict) -> list[int]:
    # Refresh reference recognition for older caches without rewriting the
    # extraction or invalidating saved translations. mark_references only sets
    # keys of blocks, so copies of the blocks keep the document as it was.
    document = dict(document, blocks=[dict(block) for block in document["blocks"]])
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
