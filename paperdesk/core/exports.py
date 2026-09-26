"""Saving a paper's files elsewhere: copies, and PDFs pairing the original with the translation."""
from __future__ import annotations

from pathlib import Path
import shutil

from paperdesk.core.paths import PaperFiles
from paperdesk.pdf.pdf_engine import bilingual_pdf, interleaved_pdf
from paperdesk.translation.translation_preview import read_preview

KINDS = ("translated", "original", "interleaved", "bilingual", "markdown")
# Built from the original and the translation; can take a while on long papers.
PAIRED_KINDS = ("interleaved", "bilingual")


def check_export(files: PaperFiles, kind: str, destination: Path) -> Path:
    """The resolved destination, after checking the export can be made; raises ValueError otherwise."""
    if kind not in KINDS:
        raise ValueError("不明なエクスポート形式です。")
    destination = destination.resolve()
    library_files = {p.resolve() for p in (files.original_pdf, files.translated_pdf, files.interleaved_pdf, files.article_md)}
    if destination in library_files:
        raise ValueError("別の保存先を選んでください。")
    if kind in ("translated", *PAIRED_KINDS):
        preview = read_preview(files.folder)
        if preview and not preview["complete"]:
            raise ValueError("指定したページの翻訳が終わると書き出せます。完了したページはアプリ内で確認できます。")
        if not files.translated_pdf.is_file():
            raise ValueError("先に日本語訳を作成してください。")
    return destination


def copy_export(files: PaperFiles, kind: str, destination: Path) -> None:
    """Copy a file that already exists: the original, the translation or the summary."""
    source = {"translated": files.translated_pdf, "original": files.original_pdf, "markdown": files.article_md}[kind]
    if not source.is_file():
        raise ValueError("先に解説を作成してください。" if kind == "markdown" else "ファイルが存在しません。")
    try:
        shutil.copyfile(source, destination)
    except OSError as error:
        raise ValueError(f"保存できませんでした: {error}") from error


def build_paired_pdf(files: PaperFiles, kind: str, destination: Path) -> None:
    """Write the original and translated pages alternating (interleaved) or side by side (bilingual)."""
    build = interleaved_pdf if kind == "interleaved" else bilingual_pdf
    build(files.original_pdf, files.translated_pdf, destination)
