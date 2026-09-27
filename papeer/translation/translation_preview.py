"""Locate completed page previews without presenting unfinished pages as translations."""
import json
from pathlib import Path
import re
import shutil
from papeer.core.paths import PaperFiles

RUN_NAME = re.compile(r"[0-9a-f]{32}")
# The translation cache a run replaced, kept in its folder until the next run as a way back.
PREVIOUS_CACHE = "previous-translation-cache.json"


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
    files = PaperFiles(folder)
    has_translated = preview is None and files.translated_pdf.is_file()
    report = files.read_json(files.translation_report, {}) if has_translated else None
    return completed_page_numbers(preview, report, has_translated, page_count)


def completed_page_numbers(preview: dict | None, report: dict | None, has_translated: bool, page_count: int) -> list[int]:
    """The pages with a translation, from what translated_page_numbers reads (the library list reads them itself).

    An unfinished or finished run's preview names them; without one, translated.pdf holds the pages the
    report lists (all of them when it does not say, or there is no report). `report` may be None then.
    """
    if preview is not None:
        numbers = preview["pages"]
    elif has_translated:
        numbers = (report or {}).get("translated_pages", range(1, page_count + 1))
    else:
        numbers = []
    return sorted({n for n in numbers if type(n) is int and 1 <= n <= page_count})


def _remove(path: Path) -> None:
    # A file a viewer or a scan holds open on Windows stays; the next cleanup removes it.
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def remove_unused_runs(folder: Path, tidy_complete: bool = True) -> None:
    """Delete the page previews under translation-pages/ that nothing shows any more.

    Only an unfinished translation shows pages from its run folder (see translated_page), and a
    later run takes over the pages it still needs by copying them. So the run the preview names is
    kept whole while it is unfinished (the reader and resuming need it); once it is complete the
    reader shows translated.pdf and only the translation cache the run replaced is kept. Runs the
    preview does not name are left over from a stopped, failed or crashed run and are removed.
    With tidy_complete=False only those orphan runs go and a complete run is left as it is.

    Call it only while no translation of this paper runs: a starting run writes its folder before
    the preview names it. Nothing is removed when the preview cannot be read. Never raises OSError:
    what cannot be removed now (a file held open on Windows) is removed by a later call.
    """
    pages = PaperFiles(folder).translation_pages
    if not pages.is_dir():
        return
    try:
        preview = read_preview(folder)
        current, complete = (preview["run_id"], preview.get("complete") is True) if preview else (None, False)
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return
    try:
        for run in list(pages.iterdir()):
            if not run.is_dir() or not RUN_NAME.fullmatch(run.name):
                continue
            if run.name != current:
                _remove(run)
            elif complete and tidy_complete:
                for item in list(run.iterdir()):
                    if item.name != PREVIOUS_CACHE:
                        _remove(item)
        for directory in [*(run for run in pages.iterdir() if run.is_dir()), pages]:
            try:
                directory.rmdir()  # Only when empty.
            except OSError:
                pass
    except OSError:
        pass


def remove_unused_translation_runs(root: Path) -> None:
    """Remove the orphan runs of every paper of the library at `root`; for startup, before any job runs.

    Complete runs are tidied by each paper's next translation instead: tidying them all at once on
    the first launch after an update would delete page PDFs across the whole library, making the
    next sync see a changed library (and a conflict with other devices) and delaying the start.
    """
    papers = root / "papers"
    if not papers.is_dir():
        return
    for folder in papers.iterdir():
        if RUN_NAME.fullmatch(folder.name) and (folder / "translation-pages").is_dir():
            remove_unused_runs(folder, tidy_complete=False)
