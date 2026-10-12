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
import sys
from typing import Any
import uuid


def app_env(name: str, default: str | None = None) -> str | None:
    """Prefer the new variable, including an explicitly empty value."""
    return os.environ.get(f"PAPEER_{name}", os.environ.get(f"PAPERDESK_{name}", default))


# Where Papeer keeps its files, by the platform's custom (frontend/src-tauri/src/lib.rs follows the same rules
# for the library folder):
#
#   Windows: library %LOCALAPPDATA%\Papeer; this PC's files %LOCALAPPDATA%\PapeerSync (caches and logs in it too).
#   macOS:   library ~/Library/Application Support/Papeer; this PC's files ~/Library/Application Support/PapeerSync;
#            caches ~/Library/Caches/Papeer; logs ~/Library/Logs/Papeer.
#   Linux:   library $XDG_DATA_HOME/papeer (~/.local/share/papeer); this PC's files $XDG_STATE_HOME/papeer
#            (~/.local/state/papeer, logs in it too); caches $XDG_CACHE_HOME/papeer (~/.cache/papeer).
#
# This PC's folder holds more than state that can be rebuilt: the folder-sync state (without it the next sync
# cannot tell a change from a conflict), this PC's history of the library (local_history: a safety net), the CLI
# paths and the downloaded OCR data. So on macOS it stays in Application Support (kept by Time Machine, never
# cleared as a cache), and only the converted fonts, which are rebuilt from the bundled ones, go to Caches. On
# Linux the XDG state folder is meant for exactly such files (this machine's, persistent, not worth syncing).
# The files keyed by the library's path (sync_state_path and the others below) stay in one folder, so they
# can be told apart and moved together when the library moves.


def _platform() -> str:
    """"windows", "macos" or "linux" (any other POSIX system is treated as Linux: the XDG folders)."""
    if sys.platform == "win32":
        return "windows"
    return "macos" if sys.platform == "darwin" else "linux"


def _local_appdata() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")


def _xdg(variable: str, default: str) -> Path:
    """An XDG base folder; a relative value is ignored, as the XDG Base Directory specification says."""
    value = os.environ.get(variable, "")
    return Path(value) if value and os.path.isabs(value) else Path.home() / default


def _application_support() -> Path:
    return Path.home() / "Library" / "Application Support"


def default_data_directory() -> Path:
    """The library's folder when PAPEER_DATA_DIR names none, by the platform's custom (see above)."""
    platform = _platform()
    if platform == "windows":
        return _local_appdata() / "Papeer"
    if platform == "macos":
        return _application_support() / "Papeer"
    return _xdg("XDG_DATA_HOME", ".local/share") / "papeer"


def data_directory() -> Path:
    # The folder earlier versions used while Papeer was called PaperDesk (%LOCALAPPDATA%\PaperDesk) is no longer
    # read: a library there is expected to have been moved here.
    override = app_env("DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return default_data_directory()


def device_directory() -> Path:
    """Files that belong to this PC rather than to the library: never backed up or synced.

    Holds the folder-sync state, this PC's history and the connection options that name a program or
    server on this PC (config.DEVICE_OPTION_KEYS). It stays in the platform's place (see above) even
    when PAPEER_DATA_DIR moves the library elsewhere.
    """
    platform = _platform()
    if platform == "windows":
        return _local_appdata() / "PapeerSync"
    if platform == "macos":
        return _application_support() / "PapeerSync"
    return _xdg("XDG_STATE_HOME", ".local/state") / "papeer"


def cache_directory() -> Path:
    """This PC's files that are rebuilt when missing (the converted fonts): the platform's cache folder,
    which a system or the user may clear; on Windows, the device folder as before."""
    platform = _platform()
    if platform == "windows":
        return device_directory()
    if platform == "macos":
        return Path.home() / "Library" / "Caches" / "Papeer"
    return _xdg("XDG_CACHE_HOME", ".cache") / "papeer"


def log_directory() -> Path:
    """The sidecar's log (sidecar/errors.log_to_file): this PC's, like the rest of device_directory()
    (~/Library/Logs/Papeer on macOS, where Console shows it)."""
    if _platform() == "macos":
        return Path.home() / "Library" / "Logs" / "Papeer"
    return device_directory() / "logs"


def library_key(root: Path) -> str:
    """The name this PC's files for the library at `root` go by in device_directory() (a digest of its path)."""
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()


def sync_state_path(root: Path) -> Path:
    """This PC's folder-sync state for the library at `root` (see drive_sync)."""
    return device_directory() / (library_key(root) + ".json")


def fingerprint_cache_path(root: Path) -> Path:
    """The file digests this PC remembers for the library at `root` (see drive_sync.fingerprint)."""
    return device_directory() / (library_key(root) + ".fingerprint.json")


def sync_blobs_path(root: Path) -> Path:
    """When this PC first saw each blob of the sync folder of the library at `root` (see sync_store's clean-up)."""
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".sync-blobs.json")


def history_directory(root: Path) -> Path:
    """This PC's history of the library at `root`: the states folder sync settled on (see local_history)."""
    return device_directory() / "history" / library_key(root)


def review_cache_path(root: Path) -> Path:
    """The pages needing translation this PC has worked out for the library at `root` (see translation_review)."""
    return device_directory() / (library_key(root) + ".review-pages.json")


def opened_papers_path(root: Path) -> Path:
    """When each paper of the library at `root` was last opened on this PC (see opened_papers)."""
    return device_directory() / (library_key(root) + ".opened.json")


def search_index_path(root: Path) -> Path:
    """This PC's full-text index of the library at `root` (see search_index)."""
    return device_directory() / (library_key(root) + ".search.sqlite3")



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
    # A handwritten notebook (papers.kind 'notebook'): its pages are kept here, and original.pdf is made from them.
    @property
    def notebook_json(self) -> Path: return self.folder / "notebook.json"
    # What the paper (or notebook) holds besides its own files: memos and documents (the attachments table).
    @property
    def attachments(self) -> Path: return self.folder / "attachments"

    def attachment(self, attachment_id: str, format: str) -> Path:
        """The file of one attachment: attachments/<id>.md or attachments/<id>.html."""
        return self.attachments / f"{attachment_id}.{format}"

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
    def automatic_glossary(self) -> Path: return self.folder / "automatic-glossary.json"
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
