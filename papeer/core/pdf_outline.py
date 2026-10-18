"""Read the original PDF's outline before the browser downloads or renders its pages."""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import NotRequired, TypedDict

import pymupdf
import pymupdf.mupdf as mupdf

OUTLINE_LIMIT = 1000  # Match the browser fallback (frontend/src/features/reader/pdfLinks.ts).


class PdfOutlineEntry(TypedDict):
    title: str
    depth: int
    page: NotRequired[int]
    anchor_y: NotRequired[float]


def _named_heights(doc: pymupdf.Document) -> dict[str, bool]:
    """Keep null/missing heights, which resolve_names() normalizes to zero."""
    pdf = mupdf.pdf_document_from_fz_document(doc.this)
    catalog = mupdf.pdf_dict_gets(mupdf.pdf_trailer(pdf), "Root")
    dictionaries = (
        mupdf.pdf_dict_gets(catalog, "Dests"),
        mupdf.pdf_load_name_tree(pdf, mupdf.pdf_new_name("Dests")),
    )
    heights: dict[str, bool] = {}
    for destinations in dictionaries:
        for index in range(mupdf.pdf_dict_len(destinations)):
            name = mupdf.pdf_to_name(mupdf.pdf_dict_get_key(destinations, index))
            value = mupdf.pdf_dict_get_val(destinations, index)
            if mupdf.pdf_is_dict(value):
                value = mupdf.pdf_dict_gets(value, "D")
            mode = mupdf.pdf_to_name(mupdf.pdf_array_get(value, 1))
            top_index = {"XYZ": 3, "FitH": 2, "FitBH": 2, "FitR": 5}.get(mode)
            heights[name] = top_index is not None and bool(mupdf.pdf_is_number(mupdf.pdf_array_get(value, top_index)))
    return heights


@lru_cache(maxsize=128)
def _read(path: str, mtime_ns: int, size: int) -> list[PdfOutlineEntry]:
    # Stat values identify the version: progress requests reuse the outline, replacements do not.
    with pymupdf.open(path) as doc:
        entries: list[PdfOutlineEntry] = []
        pages: dict[int, pymupdf.Page] = {}
        named_heights: dict[str, bool] | None = None
        for level, title, page, destination in doc.get_toc(simple=False)[:OUTLINE_LIMIT]:
            entry: PdfOutlineEntry = {
                "title": " ".join(title.split()) or "（無題）",
                "depth": max(0, level - 1),
            }
            # PyMuPDF also resolves internal named destinations to a page and point.
            if destination.get("kind") in (pymupdf.LINK_GOTO, pymupdf.LINK_NAMED) and 1 <= page <= doc.page_count:
                entry["page"] = page
                point = destination.get("to")
                if destination.get("kind") == pymupdf.LINK_NAMED:
                    if named_heights is None:
                        named_heights = _named_heights(doc)
                    if not named_heights.get(destination.get("nameddest", ""), False):
                        point = None
                if point is not None:
                    if page not in pages:
                        pages[page] = doc[page - 1]
                    target_page = pages[page]
                    # Named destinations retain PDF coordinates (origin at the bottom).
                    if destination.get("kind") == pymupdf.LINK_NAMED:
                        point = point * target_page.transformation_matrix * target_page.rotation_matrix
                    height = target_page.rect.height
                    if height > 0:
                        entry["anchor_y"] = max(0.0, min(1.0, point.y / height))
            entries.append(entry)
        return entries


def original_outline(path: Path) -> list[PdfOutlineEntry] | None:
    """An empty list means no outline; None means unknown, so the browser can try reading it."""
    try:
        version = path.stat()
        return deepcopy(_read(str(path.resolve()), version.st_mtime_ns, version.st_size))
    except (OSError, ValueError, RuntimeError):
        # A missing or unreadable original must not break the rest of the reading state.
        return None
