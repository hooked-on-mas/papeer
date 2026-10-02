"""What the reader shows about a paper's translation (the library list: library_list)."""
from __future__ import annotations

from pathlib import Path
import stat
from typing import Any

from papeer.core.paths import PaperFiles
from papeer.core.pdf_outline import original_outline
from papeer.core.service import page_translation_text
from papeer.core.storage import Library
from papeer.translation.translation_preview import read_preview, translated_page, translated_page_numbers


def reading_state(lib: Library, paper_id: str, last_page: int = 0) -> dict[str, Any]:
    """Everything the reader needs to show the original and the translation page by page."""
    files = PaperFiles(lib.folder(paper_id))
    folder = files.folder
    info = lib.reading_info(paper_id)
    page_count = info["page_count"]
    preview = read_preview(folder)
    completed = translated_page_numbers(folder, page_count)
    report = files.read_json(files.translation_report)
    in_progress = bool(preview and not preview["complete"])
    if report and not in_progress:
        # Papers translated before page alignment may have more translated pages.
        page_count = max(page_count, int(report.get("pages") or 0))

    # Where the right pane finds each page: a per-page preview while translating,
    # the original for pages outside the request, or nothing while it waits.
    # Asked again whenever a page is ready: each file (translated.pdf for every page once complete)
    # is looked up once, not once per page.
    files_seen: dict[Path, tuple[str, int] | None] = {}
    translated_pages: dict[str, dict[str, Any] | None] = {}
    for index in range(page_count):
        path, page_index = translated_page(folder, index, preview)
        if path is not None and path not in files_seen:
            try:
                found_file = path.stat()
                files_seen[path] = ((path.relative_to(folder).as_posix(), int(found_file.st_mtime))
                                    if stat.S_ISREG(found_file.st_mode) else None)
            except (OSError, ValueError):
                files_seen[path] = None
        found = files_seen.get(path) if path is not None else None
        if found is None:
            translated_pages[str(index + 1)] = None
        else:
            translated_pages[str(index + 1)] = {"file": found[0], "index": page_index, "mtime": found[1]}

    # The translation key (TranslationKey.identity, or the code revision of older records)
    # and model that produced each page, as the old reader showed.
    page_versions: dict[str, dict[str, str]] = {}
    try:
        cache = files.read_json(files.translation_cache, {})
        for number, entry in (cache.get("completed_pages") or {}).items():
            version = entry.get("version", "")
            sha = version.rsplit("sha256-", 1)[1][:7] if "sha256-" in version else "不明"
            page_versions[number] = {"sha": sha, "model": entry.get("model") or "不明"}
    except (OSError, ValueError, AttributeError):
        pass

    return {
        "page_count": page_count,
        "source_page_count": info["page_count"],
        "empty_pages": info["empty_pages"],
        "translation_required_pages": info["translation_required_pages"],
        "ocr_pages": info["ocr_pages"],
        "ocr_applied": info["ocr_applied"],
        "completed_pages": completed,
        "preview": preview,
        "in_progress": in_progress,
        "report": report,
        "translated_pages": translated_pages,
        "page_versions": page_versions,
        "last_page": last_page,
        "has_translated": files.translated_pdf.is_file(),
        "has_article": files.article_md.is_file(),
        "has_interleaved": files.interleaved_pdf.is_file(),
        "original_mtime": int(files.original_pdf.stat().st_mtime) if files.original_pdf.is_file() else 0,
        "outline": original_outline(files.original_pdf),
    }


def translation_text(lib: Library, paper_id: str, page: int) -> list[str]:
    """The translated blocks of one page as text, formulas included."""
    files = PaperFiles(lib.folder(paper_id))
    if not files.translation_cache.is_file() and not files.translation_md.is_file():
        return []
    return page_translation_text(files.folder, lib.document(paper_id), page)
