"""What the reader and the library list show about a paper's translation."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from papeer.core.paths import PaperFiles
from papeer.core.service import page_translation_text
from papeer.core.storage import Library
from papeer.core.translation_review import cached_review_pages
from papeer.translation.translation_preview import read_preview, translated_page, translated_page_numbers


def translation_state(folder: Path, page_count: int) -> dict[str, Any]:
    """How much of a paper has a Japanese translation, as the library list shows it."""
    files = PaperFiles(folder)
    try:
        completed = translated_page_numbers(folder, page_count)
        preview = read_preview(folder)
    except (OSError, ValueError, json.JSONDecodeError):
        completed, preview = [], None
    review = cached_review_pages(folder, page_count)
    required = set(review["required"])
    try:
        report = json.loads(files.translation_report.read_text("utf-8"))
        has_issues = bool(report.get("skipped_blocks") or report.get("skipped_pages"))
    except (OSError, ValueError):
        has_issues = None
    return {
        "translated_count": len(completed),
        "translation_required_count": len(required),
        "translation_completed_required_count": len(required.intersection(completed)),
        # Pages kept as the original because they need OCR (partly garbled pages are translated).
        "translation_ocr_count": sum(1 for entry in review["ocr"] if entry.get("reason") != "partial"),
        "translation_has_issues": has_issues,
        "has_translated": files.translated_pdf.is_file(),
        "translation_in_progress": bool(preview and not preview["complete"]),
    }


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
    translated_pages: dict[str, dict[str, Any] | None] = {}
    for index in range(page_count):
        path, page_index = translated_page(folder, index, preview)
        if path is None or not path.is_file():
            translated_pages[str(index + 1)] = None
        else:
            translated_pages[str(index + 1)] = {
                "file": path.resolve().relative_to(folder.resolve()).as_posix(),
                "index": page_index,
                "mtime": int(path.stat().st_mtime),
            }

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
    }


def translation_text(lib: Library, paper_id: str, page: int) -> list[str]:
    """The translated blocks of one page as text, formulas included."""
    files = PaperFiles(lib.folder(paper_id))
    if not files.translation_cache.is_file() and not files.translation_md.is_file():
        return []
    return page_translation_text(files.folder, lib.document(paper_id), page)


def reading_blocks(lib: Library, paper_id: str, page: int) -> dict[str, Any]:
    """Source blocks with their positions, and the translated blocks, of one page."""
    document = lib.document(paper_id)
    if not 1 <= page <= document["page_count"]:
        raise ValueError("ページが範囲外です。")
    source = [{"id": b["id"], "text": b["text"], "bbox": b["bbox"]}
              for b in document["blocks"] if b["page"] == page]
    files = PaperFiles(lib.folder(paper_id))
    translations: list[dict[str, str]] = []
    if files.translation_md.exists():
        translations = [{"id": block_id, "text": text} for number, block_id, text in files.translation_sections()
                        if number == page and text]
    elif files.translation_cache.exists():
        translations = [{"id": f"preview-{i}", "text": value} for i, value in
                        enumerate(page_translation_text(files.folder, document, page))]
    return {"source": source, "translations": translations,
            "width": document["pages"][page - 1]["width"], "height": document["pages"][page - 1]["height"]}
