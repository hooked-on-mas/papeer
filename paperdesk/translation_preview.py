"""Locate completed page previews without presenting unfinished pages as translations."""
import json
from pathlib import Path
import re


def read_preview(folder: Path) -> dict | None:
    path = folder / "translation-preview.json"
    if not path.exists():
        return None
    value = json.loads(path.read_text("utf-8"))
    if not re.fullmatch(r"[0-9a-f]{32}", value.get("run_id", "")):
        raise ValueError("翻訳ページの表示情報が不正です。")
    return value


def preview_page(folder: Path, preview: dict, number: int) -> Path:
    return folder / "translation-pages" / preview["run_id"] / f"page-{number}.pdf"


def translated_page(folder: Path, index: int) -> tuple[Path | None, int]:
    preview = read_preview(folder)
    if preview and not preview["complete"]:
        if index + 1 not in preview["pages"]:
            if index + 1 in preview.get("skipped_pages", []):
                return folder / "original.pdf", index
            if index + 1 not in preview.get("target_pages", range(1, preview["total_pages"] + 1)):
                return folder / "original.pdf", index
            return None, 0
        return preview_page(folder, preview, index + 1), 0
    return folder / "translated.pdf", index


def translated_page_numbers(folder: Path, page_count: int) -> list[int]:
    preview = read_preview(folder)
    if preview is not None:
        numbers = preview["pages"]
    elif (folder / "translated.pdf").is_file():
        report_path = folder / "translation-report.json"
        report = json.loads(report_path.read_text("utf-8")) if report_path.exists() else {}
        numbers = report.get("translated_pages", range(1, page_count + 1))
    else:
        numbers = []
    return sorted({n for n in numbers if type(n) is int and 1 <= n <= page_count})
