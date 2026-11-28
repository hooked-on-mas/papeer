"""One-way conversion of note.md/papers.note into md attachments, including already opened v8 data.

The schema stays at 8. Deterministic IDs and the existing row protect retries after interruption;
legacy contents are cleared only after files and rows are durable. Normal reading/writing uses only
attachments. Different database/file contents are both preserved rather than guessing which is newer.
"""
from __future__ import annotations

from pathlib import Path
from contextlib import closing
import sqlite3
import uuid

from papeer.core.fileio import atomic_write_text
from papeer.core.paths import PaperFiles


def migrate_memos(root: Path) -> None:
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db:
        db.row_factory = sqlite3.Row
        pending = {row[0] for row in db.execute("SELECT id FROM papers WHERE note<>''")}
        pending.update(path.parent.name for path in (root / "papers").glob("*/note.md"))
        has_kind = 'kind' in {row[1] for row in db.execute('PRAGMA table_info(papers)')}
        markdown_ids = {row[0] for row in db.execute("SELECT id FROM papers WHERE kind='markdown'")} if has_kind else set()
        pending -= markdown_ids
        if not pending:
            return
        db.execute("BEGIN IMMEDIATE")
        old_files = []
        has_legacy = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='note_legacy'").fetchone())

        def converted(identity):
            # Converted once it is an attachment, or after Library.__init__ moved it into the notes (note_legacy).
            return bool(db.execute("SELECT 1 FROM attachments WHERE id=?", (identity,)).fetchone()
                        or (has_legacy and db.execute("SELECT 1 FROM note_legacy WHERE id=?", (identity,)).fetchone()))
        for owner in sorted(pending):
            row = db.execute("SELECT note,created_at FROM papers WHERE id=?", (owner,)).fetchone()
            if row is None:
                continue
            files = PaperFiles(root / "papers" / owner)
            legacy = files.folder / "note.md"
            contents = [("database", row["note"])] if row["note"] else []
            converted_database = uuid.uuid5(uuid.NAMESPACE_URL, f"papeer:legacy-memo:{owner}:database").hex
            converted_file = uuid.uuid5(uuid.NAMESPACE_URL, f"papeer:legacy-memo:{owner}:file").hex
            # Crash after COMMIT, before unlink: the remaining file is the already migrated memo,
            # even if that attachment was edited since. Do not recreate it as a second 'file' memo.
            completed = converted(converted_database)
            file_converted = converted(converted_file)
            disk = ""
            # Read the old file only when it can still add a memo. A converted owner's file is left alone, so an
            # opener finishing the same conversion (the sidecar opens a Library per request, and the first opens
            # after an update overlap) never has the file open while another one removes it.
            if not file_converted and not (not row["note"] and completed):
                try:
                    disk = legacy.read_text("utf-8")
                except FileNotFoundError:
                    pass  # No file, or another opener converting the same memo removed it meanwhile.
            if disk and disk != row["note"] and not (not row["note"] and completed):
                contents.append(("file", disk))
            for origin, content in contents:
                identity = uuid.uuid5(uuid.NAMESPACE_URL, f"papeer:legacy-memo:{owner}:{origin}").hex
                if converted(identity):
                    continue  # Already converted; never overwrite later edits on a retry.
                target = files.attachment(identity, "md")
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_text(target, content)
                position = db.execute("SELECT COALESCE(MAX(position)+1,0) FROM attachments WHERE owner_id=?", (owner,)).fetchone()[0]
                db.execute("INSERT INTO attachments(id,owner_id,format,title,source,position,created_at,updated_at)"
                           " VALUES(?,?,'md',?,'user',?,?,?)",
                           (identity, owner, "メモ.md" if origin == "database" or not row["note"] else "メモ（旧ファイル）.md",
                            position, row["created_at"], row["created_at"]))
            db.execute("UPDATE papers SET note='' WHERE id=?", (owner,))
            old_files.append(legacy)
        db.commit()
        for legacy in old_files:
            try:
                legacy.unlink(missing_ok=True)
            except OSError:
                # Best effort: the memo is already committed. Windows refuses to delete a file another opener has
                # open. What stays is removed by the next open, which finds both memos converted and adds nothing.
                pass
