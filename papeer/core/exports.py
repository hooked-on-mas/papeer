"""Saving a paper's files elsewhere: copies, and PDFs pairing the original with the translation."""
from __future__ import annotations

from pathlib import Path
import shutil
from typing import Callable

from papeer.core.fileio import atomic_output
from papeer.core.paths import PaperFiles
from papeer.pdf.pdf_engine import bilingual_pdf, interleaved_pdf
from papeer.translation.translation_preview import read_preview

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
        with atomic_output(destination) as temporary:
            shutil.copyfile(source, temporary)
    except OSError as error:
        raise ValueError(f"保存できませんでした: {error}") from error


def build_paired_pdf(files: PaperFiles, kind: str, destination: Path) -> None:
    """Write the original and translated pages alternating (interleaved) or side by side (bilingual)."""
    if kind == "interleaved" and interleaved_is_current(files):
        try:
            with atomic_output(destination) as temporary:
                shutil.copyfile(files.interleaved_pdf, temporary)
        except OSError as error:
            raise ValueError(f"保存できませんでした: {error}") from error
        return
    build = interleaved_pdf if kind == "interleaved" else bilingual_pdf
    build(files.original_pdf, files.translated_pdf, destination)


# --- interleaved.pdf: built on demand beside the paper for an external viewer, then reused ---
#
# Translation no longer writes it: it is only needed when the user opens it, and every translation
# or review would otherwise rewrite (and sync) a PDF twice the size of the paper. A copy stays valid
# while it is newer than both PDFs it pairs; whatever replaces translated.pdf also deletes it.


def interleaved_is_current(files: PaperFiles) -> bool:
    """Whether interleaved.pdf exists and was built from the current original and translation."""
    try:
        built = files.interleaved_pdf.stat().st_mtime_ns
        return built >= max(files.translated_pdf.stat().st_mtime_ns, files.original_pdf.stat().st_mtime_ns)
    except OSError:
        return False


def interleaved_cache(files: PaperFiles, progress: Callable[[str], None] = lambda _: None) -> Path:
    """interleaved.pdf, built first when it is missing or older than the translation."""
    if not interleaved_is_current(files):
        progress("原文・日本語訳の交互PDFを作成しています…")
        interleaved_pdf(files.original_pdf, files.translated_pdf, files.interleaved_pdf)
    return files.interleaved_pdf


def discard_interleaved(files: PaperFiles) -> None:
    """Delete interleaved.pdf after translated.pdf changed.

    A copy a viewer holds open cannot be deleted on Windows; being older than the new translation,
    it is rebuilt when next opened.
    """
    try:
        files.interleaved_pdf.unlink(missing_ok=True)
    except OSError:
        pass
