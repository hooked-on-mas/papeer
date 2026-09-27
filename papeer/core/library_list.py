"""The library list: each paper's row with its folder and translation progress, in the order chosen."""
from __future__ import annotations

from enum import IntEnum
import json
from pathlib import Path
from typing import Any

from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.core.translation_review import ReviewPagesCache, cached_review_pages, review_pages_cache
from papeer.translation.translation_preview import completed_page_numbers, read_preview


class LibrarySort(IntEnum):
    """The orders the library offers (frontend features/library/LibrarySidebar.tsx, SORT_LABELS)."""
    NEWEST = 0
    OLDEST = 1
    TITLE = 2
    TITLE_DESCENDING = 3


def translation_state(folder: Path, page_count: int, review: ReviewPagesCache | None = None) -> dict[str, Any]:
    """How much of a paper has a Japanese translation, as the library list shows it.

    Reads the preview and the report once each; the pages needing translation come from `review`
    (the library's ReviewPagesCache, which the caller saves), or from cached_review_pages.
    """
    files = PaperFiles(folder)
    has_translated = files.translated_pdf.is_file()
    report, unreadable_report = None, False
    try:
        report = json.loads(files.translation_report.read_text("utf-8"))
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        unreadable_report = True
    try:
        preview = read_preview(folder)
        if preview is None and has_translated and unreadable_report:
            raise ValueError("翻訳レポートを読めません。")  # As translated_page_numbers fails on it.
        completed = completed_page_numbers(preview, report, has_translated, page_count)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        completed, preview = [], None
    pages = review.pages(folder, page_count) if review is not None else cached_review_pages(folder, page_count)
    required = set(pages["required"])
    return {
        "translated_count": len(completed),
        "translation_required_count": len(required),
        "translation_completed_required_count": len(required.intersection(completed)),
        # Pages kept as the original because they need OCR (partly garbled pages are translated).
        "translation_ocr_count": sum(1 for entry in pages["ocr"] if entry.get("reason") != "partial"),
        "translation_has_issues": (bool(report.get("skipped_blocks") or report.get("skipped_pages"))
                                   if isinstance(report, dict) else None),
        "has_translated": has_translated,
        "translation_in_progress": bool(preview and not preview["complete"]),
    }


def paper_row(lib: Library, paper: dict[str, Any], review: ReviewPagesCache | None = None,
              papers_folder: Path | None = None) -> dict[str, Any]:
    """A paper (Library.paper or Library.papers) with its folder and translation progress.

    The memo stays out: the list does not show it, and it is the largest part of a row
    (GET /api/papers/{id} keeps it for the memo pane).
    """
    folder = lib.folder(paper["id"])
    row = {name: value for name, value in paper.items() if name != "note"}
    row["folder_path"] = str((papers_folder or (lib.root / "papers").resolve()) / paper["id"])
    row["has_article"] = PaperFiles(folder).article_md.is_file()
    row.update(translation_state(folder, paper["pages"], review))
    return row


def library_rows(lib: Library, query: str = "", sort: int = LibrarySort.NEWEST) -> list[dict[str, Any]]:
    """The rows of GET /api/papers: every paper matching `query`, in the `sort` order (a LibrarySort)."""
    order = LibrarySort(sort)
    review = review_pages_cache(lib.root)
    papers_folder = (lib.root / "papers").resolve()
    papers = lib.papers(query=query)
    rows = []
    for paper in papers:
        try:
            rows.append(paper_row(lib, paper, review, papers_folder))
        except ValueError:  # Not a paper folder's name (a hand-edited database): listed without its state.
            rows.append({name: value for name, value in paper.items() if name != "note"})
    # Entries of removed papers go once the whole library has been listed.
    review.save(keep={paper["id"] for paper in papers} if not query.strip() else None)
    if order is LibrarySort.OLDEST:
        rows.reverse()
    elif order in (LibrarySort.TITLE, LibrarySort.TITLE_DESCENDING):
        rows.sort(key=lambda row: (row.get("title") or "").casefold(), reverse=order is LibrarySort.TITLE_DESCENDING)
    return rows
