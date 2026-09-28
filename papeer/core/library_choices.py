"""Library's choices offered in the UI (paper tags, sticky-note labels, reading statuses) and note templates."""
from __future__ import annotations

import json

from papeer.core.library_base import LibraryBase


class Choices(LibraryBase):
    """The saved choices (and removing a paper tag from every paper) and the user's note templates."""

    # --- Choices offered in the UI: paper tags, sticky-note labels, reading statuses ---

    def tag_choices(self, kind: str) -> list[str]:
        """Choices of one kind ('paper' or 'sticky'), in the order they were added."""
        with self.connection() as db:
            return [row[0] for row in db.execute("SELECT name FROM tag_choices WHERE kind=? ORDER BY rowid", (kind,))]

    def add_tag_choice(self, kind: str, name: str) -> None:
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO tag_choices VALUES(?,?)", (kind, name))

    def delete_tag_choice(self, kind: str, name: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM tag_choices WHERE kind=? AND name=?", (kind, name))

    def remove_tag(self, name: str) -> int:
        """Remove an exact tag across the library without replacing other paper data."""
        if not name.strip() or len(name) > 80:
            raise ValueError("タグ名は1〜80文字で指定してください。")
        affected = 0
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM tag_choices WHERE kind='paper' AND name=?", (name,))
            for row in db.execute("SELECT id,tags FROM papers").fetchall():
                tags = json.loads(row["tags"])
                if name in tags:
                    db.execute("UPDATE papers SET tags=? WHERE id=?",
                               (json.dumps([tag for tag in tags if tag != name], ensure_ascii=False), row["id"]))
                    affected += 1
        return affected

    def reading_statuses(self) -> list[str]:
        with self.connection() as db:
            return [row[0] for row in db.execute("SELECT name FROM reading_status_choices ORDER BY rowid")]

    def add_reading_status(self, name: str) -> None:
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO reading_status_choices VALUES(?)", (name,))

    def delete_reading_status(self, name: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM reading_status_choices WHERE name=?", (name,))

    # --- Note templates ---

    def note_templates(self) -> list[dict]:
        with self.connection() as db:
            return [dict(row) for row in db.execute("SELECT * FROM note_templates ORDER BY name")]

    def save_note_template(self, name: str, content: str) -> None:
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO note_templates(name,content) VALUES(?,?)", (name, content))

    def delete_note_template(self, name: str) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM note_templates WHERE name=?", (name,))
