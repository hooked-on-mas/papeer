"""Locate completed page previews without presenting unfinished pages as translations."""
import json
from pathlib import Path
import re
from paperdesk.core.paths import PaperFiles


def read_preview(folder: Path) -> dict | None:
    path = PaperFiles(folder).translation_preview
    if not path.exists():
        return None
    value = json.loads(path.read_text("utf-8"))
    if not re.fullmatch(r"[0-9a-f]{32}", value.get("run_id", "")):
        raise ValueError("翻訳ページの表示情報が不正です。")
    return value


def preview_page(folder: Path, preview: dict, number: int) -> Path:
    return PaperFiles(folder).translation_pages / preview["run_id"] / f"page-{number}.pdf"


_UNREAD = object()


def translated_page(folder: Path, index: int, preview: dict | None | object = _UNREAD) -> tuple[Path | None, int]:
    """(file, page index in it) shown for a page; pass read_preview()'s result when calling for many pages."""
    if preview is _UNREAD:
        preview = read_preview(folder)
    if preview and not preview["complete"]:
        if index + 1 not in preview["pages"]:
            if index + 1 in preview.get("skipped_pages", []):
                return PaperFiles(folder).original_pdf, index
            if index + 1 not in preview.get("target_pages", range(1, preview["total_pages"] + 1)):
                return PaperFiles(folder).original_pdf, index
            return None, 0
        return preview_page(folder, preview, index + 1), 0
    return PaperFiles(folder).translated_pdf, index


def translated_page_numbers(folder: Path, page_count: int) -> list[int]:
    preview = read_preview(folder)
    if preview is not None:
        numbers = preview["pages"]
    elif PaperFiles(folder).translated_pdf.is_file():
        report_path = PaperFiles(folder).translation_report
        report = json.loads(report_path.read_text("utf-8")) if report_path.exists() else {}
        numbers = report.get("translated_pages", range(1, page_count + 1))
    else:
        numbers = []
    return sorted({n for n in numbers if type(n) is int and 1 <= n <= page_count})
