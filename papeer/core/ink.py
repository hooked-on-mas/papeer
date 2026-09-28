"""Freehand ink beyond its strokes (stored by Library.ink): the PDF page it is drawn on, regions captured
as images beside the paper, and PDFs with the ink (and highlights) painted in."""
from __future__ import annotations

from pathlib import Path

from papeer.core.destinations import inside_library
from papeer.core.errors import Invalid
from papeer.core.fileio import atomic_write_bytes
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.pdf.pdf_capture import capture_png
from papeer.pdf.pdf_ink import annotated_pdf
from papeer.pdf.pdf_viewer import pdf_page_count
from papeer.translation.translation_preview import read_preview, translated_page


def _paper_folder(lib: Library, paper_id: str) -> Path:
    lib.paper(paper_id)  # NotFound for a paper the library does not have
    return lib.folder(paper_id)


def check_page(lib: Library, paper_id: str, side: str, page: int) -> tuple[Path, int]:
    """The PDF that page `page` (from 1) of `side` is on and its index there; Invalid when ink cannot go on it."""
    folder = _paper_folder(lib, paper_id)
    if page < 1:
        raise Invalid("ページが範囲外です。")
    source, index = (PaperFiles(folder).original_pdf, page - 1) if side == "original" else translated_page(folder, page - 1)
    if source is None or not source.is_file() or index >= (pdf_page_count(source) or 0):
        raise Invalid("書き込めるPDFページがありません。")
    return source, index


def save_capture(lib: Library, paper_id: str, side: str, page: int, box: tuple[float, float, float, float],
                 include_ink: bool = False) -> dict:
    """Save a region of a page, `box` = (x, y, width, height) as fractions of it, as a PNG beside the paper.

    Notes refer to the capture by the returned "file", its path relative to the paper folder.
    """
    source, index = check_page(lib, paper_id, side, page)
    strokes = lib.ink(paper_id, side, page) if include_ink else None
    data = capture_png(source, index, box, strokes)
    files = PaperFiles(_paper_folder(lib, paper_id))
    target = files.new_capture()
    target.parent.mkdir(exist_ok=True)
    atomic_write_bytes(target, data)
    return {"file": target.relative_to(files.folder).as_posix(), "page": page, "side": side}


def export_annotated(lib: Library, paper_id: str, side: str, destination: str | None) -> tuple[bytes, Path | None]:
    """The PDF of `side` with the ink and highlights painted in, and where it was saved (None: not saved).

    A destination must be a .pdf outside the library; it is written in one step (atomic_write_bytes).
    Without one, only the data is returned (the window then offers it as a download).
    """
    folder = _paper_folder(lib, paper_id)
    if side == "translated":
        preview = read_preview(folder)
        if preview and not preview["complete"]:
            raise Invalid("翻訳が完了してから書き込み付きPDFを保存してください。")
    files = PaperFiles(folder)
    source = files.original_pdf if side == "original" else files.translated_pdf
    if not source.is_file():
        raise Invalid("保存するPDFがありません。")
    target = Path(destination).resolve() if destination else None
    if target and (inside_library(target, lib.root) or target.suffix.lower() != ".pdf"):
        raise Invalid("ライブラリの外に、拡張子 .pdf の保存先を選んでください。")
    try:
        # Highlights of selected text travel with the ink: both are marks the reader made on the page.
        data = annotated_pdf(source, lib.ink_by_page(paper_id, side), lib.highlights_by_page(paper_id, side))
        if target:
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(target, data)
    except (OSError, ValueError, RuntimeError) as exc:
        raise Invalid(f"書き込み付きPDFを保存できませんでした：{exc}") from exc
    return data, target
