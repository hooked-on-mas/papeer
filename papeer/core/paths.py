"""Where the library keeps its files: the data directory and each paper's folder.

Code that needs a paper's file asks PaperFiles for it instead of spelling the name,
so the on-disk layout is written down once.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any
import uuid


def app_env(name: str, default: str | None = None) -> str | None:
    """Prefer the new variable, including an explicitly empty value."""
    return os.environ.get(f"PAPEER_{name}", os.environ.get(f"PAPERDESK_{name}", default))


def data_directory() -> Path:
    override = app_env("DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
    current, legacy = base / "Papeer", base / "PaperDesk"
    # A stray, empty Papeer folder must not hide a PaperDesk library that holds papers.
    if (not current.exists() and legacy.is_dir()) or (_has_papers(legacy) and not _has_papers(current)):
        return legacy
    return current


def device_directory() -> Path:
    """Files that belong to this PC rather than to the library: never backed up or synced.

    Holds the folder-sync state and the connection options that name a program or server on
    this PC (config.DEVICE_OPTION_KEYS). It stays under LOCALAPPDATA even when PAPEER_DATA_DIR
    moves the library elsewhere.
    """
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "PapeerSync"


def log_directory() -> Path:
    """The sidecar's log (sidecar/errors.log_to_file): this PC's, like the rest of device_directory()."""
    return device_directory() / "logs"


def sync_state_path(root: Path) -> Path:
    """This PC's folder-sync state for the library at `root` (see drive_sync)."""
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".json")


def fingerprint_cache_path(root: Path) -> Path:
    """The file digests this PC remembers for the library at `root` (see drive_sync.fingerprint)."""
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".fingerprint.json")


def history_directory(root: Path) -> Path:
    """This PC's history of the library at `root`: the states folder sync settled on (see local_history)."""
    return device_directory() / "history" / hashlib.sha256(str(root.resolve()).encode()).hexdigest()


def review_cache_path(root: Path) -> Path:
    """The pages needing translation this PC has worked out for the library at `root` (see translation_review)."""
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".review-pages.json")


def opened_papers_path(root: Path) -> Path:
    """When each paper of the library at `root` was last opened on this PC (see opened_papers)."""
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".opened.json")


def search_index_path(root: Path) -> Path:
    """This PC's full-text index of the library at `root` (see search_index)."""
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".search.sqlite3")


def _has_papers(root: Path) -> bool:
    papers = root / "papers"
    return papers.is_dir() and any(papers.iterdir())


# translation.md is a sequence of "## p.<page> / <block id>" sections holding the Japanese text.
TRANSLATION_SECTION = re.compile(r"^## p\.(\d+) / (\S+)[ \t]*$", re.M)


def parse_translation_sections(markdown: str) -> list[tuple[int, str, str]]:
    """(page, block id, text) for every section of a translation.md, text stripped."""
    parts = TRANSLATION_SECTION.split(markdown)
    return [(int(page), block, body.strip()) for page, block, body in zip(parts[1::3], parts[2::3], parts[3::3])]


CAPTURE_PREFIX = "ink-capture-"


class PaperFiles:
    """The files in one paper's folder (papers/<id>/)."""

    def __init__(self, folder: Path):
        self.folder = Path(folder)

    # Source and extraction
    @property
    def original_pdf(self) -> Path: return self.folder / "original.pdf"
    @property
    def document_json(self) -> Path: return self.folder / "document.json"
    @property
    def note_md(self) -> Path: return self.folder / "note.md"
    # What OCR read on the pages that needed it (papeer.core.ocr: kept so that extracting again reads nothing).
    @property
    def ocr_text(self) -> Path: return self.folder / "ocr-text.json"

    # Translation
    @property
    def translated_pdf(self) -> Path: return self.folder / "translated.pdf"
    @property
    def interleaved_pdf(self) -> Path: return self.folder / "interleaved.pdf"
    @property
    def bilingual_pdf(self) -> Path: return self.folder / "bilingual.pdf"
    @property
    def translation_md(self) -> Path: return self.folder / "translation.md"
    @property
    def translation_cache(self) -> Path: return self.folder / "translation-cache.json"
    @property
    def translation_report(self) -> Path: return self.folder / "translation-report.json"
    @property
    def translation_preview(self) -> Path: return self.folder / "translation-preview.json"
    @property
    def translation_revisions(self) -> Path: return self.folder / "translation-revisions.json"
    @property
    def translation_pages(self) -> Path: return self.folder / "translation-pages"

    # Summary
    @property
    def article_md(self) -> Path: return self.folder / "article.md"
    @property
    def article_usage(self) -> Path: return self.folder / "article-usage.json"
    @property
    def media(self) -> Path: return self.folder / "media"

    # media/ holds two kinds of image, told apart by name. Region captures that the reader pastes into
    # notes ("media/ink-capture-<hex>.png") belong to the user; every other PNG is a figure cut out for
    # article.md and is replaced whenever the summary is regenerated.
    def new_capture(self) -> Path:
        """An unused file name in media/ for a region capture."""
        return self.media / f"{CAPTURE_PREFIX}{uuid.uuid4().hex}.png"

    def summary_images(self) -> list[Path]:
        """The figure images of the summary, never the captures that notes refer to."""
        if not self.media.is_dir():
            return []
        return [path for path in self.media.glob("*.png") if not path.name.startswith(CAPTURE_PREFIX)]

    def translation_sections(self) -> list[tuple[int, str, str]]:
        """Sections of the last completed translation; empty when there is none."""
        if not self.translation_md.is_file():
            return []
        return parse_translation_sections(self.translation_md.read_text("utf-8"))

    @staticmethod
    def read_json(path: Path, default: Any = None) -> Any:
        """A JSON file's value, or default when it is missing."""
        return json.loads(path.read_text("utf-8")) if path.exists() else default
