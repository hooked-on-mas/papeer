"""Where the library keeps its files: the data directory and each paper's folder.

Code that needs a paper's file asks PaperFiles for it instead of spelling the name,
so the on-disk layout is written down once.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any


def data_directory() -> Path:
    override = os.environ.get("PAPERDESK_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
    return base / "PaperDesk"


# translation.md is a sequence of "## p.<page> / <block id>" sections holding the Japanese text.
TRANSLATION_SECTION = re.compile(r"^## p\.(\d+) / (\S+)[ \t]*$", re.M)


def parse_translation_sections(markdown: str) -> list[tuple[int, str, str]]:
    """(page, block id, text) for every section of a translation.md, text stripped."""
    parts = TRANSLATION_SECTION.split(markdown)
    return [(int(page), block, body.strip()) for page, block, body in zip(parts[1::3], parts[2::3], parts[3::3])]


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

    def translation_sections(self) -> list[tuple[int, str, str]]:
        """Sections of the last completed translation; empty when there is none."""
        if not self.translation_md.is_file():
            return []
        return parse_translation_sections(self.translation_md.read_text("utf-8"))

    @staticmethod
    def read_json(path: Path, default: Any = None) -> Any:
        """A JSON file's value, or default when it is missing."""
        return json.loads(path.read_text("utf-8")) if path.exists() else default
