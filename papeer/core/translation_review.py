"""Identify pages needing translation without flagging preserved end matter."""
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import threading
import time

from papeer.layout.reading_flow import unit_pages
from papeer.layout.reference_layout import mark_references
from papeer.pdf.pdf_engine import translation_units
from papeer.core.code_version import loaded_version
from papeer.core.fileio import atomic_write_json
from papeer.core.paths import PaperFiles, review_cache_path


def cached_review_pages(folder: Path, page_count: int) -> dict:
    """Pages needing translation, and pages kept as the original because they need OCR
    ([{"page", "reason", "garbled_ratio"?}], see papeer.layout.ocr_pages).

    Kept on this PC (ReviewPagesCache) for the folder of a library's paper (<root>/papers/<id>).
    """
    folder = Path(folder)
    if folder.parent.name != "papers":
        return _review_pages(folder, page_count)[0]
    cache = review_pages_cache(folder.parent.parent)
    result = cache.pages(folder, page_count)
    cache.save()
    return result


def _review_pages(folder: Path, page_count: int) -> tuple[dict, list[int] | None]:
    """The pages worked out from document.json, and the key (size, time and ID) of the file read."""
    try:
        with PaperFiles(folder).document_json.open("rb") as stream:
            # From the open file, so the key and the contents describe the same file even if
            # re-extraction replaces it meanwhile.
            stat = os.fstat(stream.fileno())
            document = json.loads(stream.read())
        return ({"required": required_translation_pages(document),
                 "ocr": [dict(entry) for entry in document.get("ocr_pages", [])]},
                [stat.st_size, stat.st_mtime_ns, stat.st_ino])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {"required": list(range(1, page_count + 1)), "ocr": []}, None


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


REVIEW_CACHE_FORMAT = 1
# A document.json written this shortly before it was read is not recorded: a second write within the same
# clock tick could leave its key unchanged (as drive_sync.RACY_NS, "racily clean" in git).
RACY_NS = 2 * 10**9
_now_ns = time.time_ns  # Replaced in tests.


class ReviewPagesCache:
    """The pages needing translation of each paper of one library, as this PC worked them out.

    Working them out reads document.json and walks every block (tens of milliseconds a paper), which the
    library list did for every paper whenever it was shown. An entry is used while document.json is the
    same file (size, time and ID; extraction writes a new file) and was worked out by the same code
    (code_version.loaded_version, which covers this module, reference recognition and translation units);
    anything else is worked out again, so an update of Papeer works every paper out once more. The pages are derived data only, so they are kept in this PC's
    device directory: never backed up, synced or migrated, and a PC running another version of Papeer
    keeps its own. Safe to share between threads; a failed save only means working the pages out again.

    What the key cannot tell apart: a document.json written again in place (same ID) with the same size and
    its modification time set back to the recorded one, as only a tool restoring file times would do. A file
    written within RACY_NS of being read, or on a file system without file IDs (st_ino 0, where a file
    replaced by another of the same size and time would look the same), is used but not recorded, so it is
    worked out again each time. A file whose time lies further in the future (copied from a PC whose clock
    runs ahead) is recorded: any later write gives it the current time, which differs.
    """

    def __init__(self, root: Path):
        self.root = root
        self.path = review_cache_path(root)
        self.code = loaded_version()
        self._lock = threading.Lock()
        self._changed = False
        self._entries: dict[str, dict] = {}
        try:
            value = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        if (isinstance(value, dict) and value.get("format") == REVIEW_CACHE_FORMAT and value.get("root") == str(root)
                and value.get("code") == self.code and isinstance(value.get("papers"), dict)):
            self._entries = {paper_id: entry for paper_id, entry in value["papers"].items() if _valid_entry(entry)}

    def pages(self, folder: Path, page_count: int) -> dict:
        """cached_review_pages for one paper folder; call save() afterwards to keep what was worked out."""
        try:
            stat = os.stat(PaperFiles(folder).document_json)
            key = [stat.st_size, stat.st_mtime_ns, stat.st_ino]
        except OSError:
            key = None
        with self._lock:
            entry = self._entries.get(folder.name)
        if key is None or entry is None or entry["document"] != key:
            result, key = _review_pages(folder, page_count)
            if key is None or key[2] == 0 or abs(key[1] - _now_ns()) <= RACY_NS:
                return result
            entry = {"document": key, "required": result["required"], "ocr": result["ocr"]}
            with self._lock:
                self._entries[folder.name] = entry
                self._changed = True
        # Copies: the caller may change what it gets.
        return {"required": list(entry["required"]), "ocr": [dict(item) for item in entry["ocr"]]}

    def save(self, keep: set[str] | None = None) -> None:
        """Write the entries when any changed; `keep`: the papers the library still has (others are dropped)."""
        with self._lock:
            if keep is not None and not set(self._entries) <= keep:
                self._entries = {paper_id: entry for paper_id, entry in self._entries.items() if paper_id in keep}
                self._changed = True
            if not self._changed:
                return
            value = {"format": REVIEW_CACHE_FORMAT, "root": str(self.root), "code": self.code,
                     "papers": dict(self._entries)}
            self._changed = False
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(self.path, value, indent=None)
            except OSError:
                self._changed = True  # Tried again on the next save.


def _valid_entry(entry: object) -> bool:
    return (isinstance(entry, dict) and isinstance(entry.get("document"), list) and len(entry["document"]) == 3
            and all(type(n) is int for n in entry["document"])
            and isinstance(entry.get("required"), list) and all(type(n) is int for n in entry["required"])
            and isinstance(entry.get("ocr"), list) and all(isinstance(item, dict) for item in entry["ocr"]))


_CACHES: dict[str, ReviewPagesCache] = {}
_CACHES_LOCK = threading.Lock()


def review_pages_cache(root: Path) -> ReviewPagesCache:
    """The process's ReviewPagesCache of the library at `root`, read from disk on first use."""
    root = Path(root).resolve()
    with _CACHES_LOCK:
        cache = _CACHES.get(str(root))
        # The device directory follows LOCALAPPDATA, which each test points elsewhere.
        if cache is None or cache.path != review_cache_path(root):
            cache = _CACHES[str(root)] = ReviewPagesCache(root)
        return cache
