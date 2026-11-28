"""Local summary planning and the guard against implicit full-document AI requests."""
from __future__ import annotations

from papeer.core.errors import Invalid
from papeer.core.paths import PaperFiles
from papeer.core.pdf_outline import original_outline
from papeer.core.storage import Library

SUMMARY_SELECTION_THRESHOLD = 30
SELECTION_REQUIRED = "30ページ以上の資料は、サマリーの対象を選択してください。章・ページ範囲を指定するか、全文を明示的に選択できます。"


def validate_summary_pages(document: dict, pages: set[int] | None) -> None:
    count = document["page_count"]
    if pages is None:
        if count >= SUMMARY_SELECTION_THRESHOLD:
            raise Invalid(SELECTION_REQUIRED, code="summary_scope_required")
    elif not pages or any(type(page) is not int or not 1 <= page <= count for page in pages):
        raise Invalid(f"サマリーの対象ページは1～{count}の範囲で指定してください。")


def page_ranges(pages: set[int]) -> str:
    ranges: list[str] = []
    first = last = 0
    for page in sorted(pages):
        if first and page == last + 1:
            last = page
            continue
        if first:
            ranges.append(str(first) if first == last else f"{first}-{last}")
        first = last = page
    if first:
        ranges.append(str(first) if first == last else f"{first}-{last}")
    return ", ".join(ranges)


def summary_plan(library: Library, paper_id: str) -> dict:
    """Read PDF bookmarks locally; planning never creates a provider or sends text to AI."""
    document = library.document(paper_id)
    count = document["page_count"]
    outline = original_outline(PaperFiles(library.folder(paper_id)).original_pdf) or []
    entries = [(entry, page) for entry in outline if (page := entry.get("page")) is not None and 1 <= page <= count]
    chapters = []
    for index, (entry, start) in enumerate(entries):
        end = count
        for following, next_page in entries[index + 1:]:
            if following["depth"] <= entry["depth"] and next_page >= start:
                # A chapter starting partway down a page shares that page with its predecessor.
                end = max(start, next_page - (0 if following.get("anchor_y", 0) > 0.01 else 1))
                break
        chapters.append({"title": entry["title"], "depth": entry["depth"], "start_page": start, "end_page": end})
    return {"page_count": count, "requires_selection": count >= SUMMARY_SELECTION_THRESHOLD, "chapters": chapters}
