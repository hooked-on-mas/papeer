"""What every group of Library's methods builds on: the database connection and the papers' folders and rows.

storage.Library joins the groups (library_papers, library_collections, library_annotations, library_choices,
library_conversations, item_relations); each is a mixin of LibraryBase and imports none of the others, except
that library_papers uses item_relations' functions (removing an item removes what it holds and its links).
"""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3

from papeer.core.errors import NotFound
from papeer.core.translation_status import stored_status


class LibraryBase:
    """The library at `root` (storage.Library opens it and migrates its database)."""

    root: Path

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.root / "library.sqlite3", timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def folder(self, paper_id: str) -> Path:
        if len(paper_id) != 32 or any(c not in "0123456789abcdef" for c in paper_id):
            raise ValueError("Invalid paper ID")
        return self.root / "papers" / paper_id

    def paper_folder(self, paper_id: str) -> Path:
        """The folder of a paper the library has: NotFound for any other ID, a malformed one included."""
        try:
            self.paper(paper_id)
            return self.folder(paper_id)
        except (KeyError, ValueError):
            raise NotFound("論文が見つかりません。") from None

    def paper(self, paper_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            raise NotFound("論文が見つかりません。")
        return self._paper(row)

    @staticmethod
    def _paper(row: sqlite3.Row | dict) -> dict:
        """A papers row as the API returns it, its translation state always a code (see _status_codes)."""
        return dict(row, tags=json.loads(row["tags"]), status=stored_status(row["status"]).value)
