"""What the library's items hold and how they relate (the data layer; the routes come with the screens).

An item is a row of the papers table that the library lists: a PDF paper or a handwritten notebook
(papers.kind). Three relations tie them together, and they are the only ones:

- placement: the folder an item stands in (papers.collection_name; library_collections);
- holding: a paper or notebook holds memos and documents (the attachments table, one file each under
  papers/<owner>/attachments/) and notebooks made inside it (papers.parent_id). One level only: what is
  held holds nothing, and removing the owner removes what it holds;
- linking: two items that stand on their own are linked, many to many (the item_links table). Unlinking
  or removing either end changes nothing else.

Every function that changes these lives here, so the rules (one level, a pair stored once, a removal
taking its relations along) have one home. Library.delete_paper calls the module functions inside its
own transaction; the mixin's methods are the Library's own.
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timezone
import sqlite3
import uuid

from papeer.core.errors import Invalid, NotFound
from papeer.core.fileio import atomic_write_text
from papeer.core.library_base import LibraryBase
from papeer.core.paths import PaperFiles

# papers.kind. A new kind needs a schema version of its own (library_schema._notebook_items).
KIND_PDF = "pdf"
KIND_NOTEBOOK = "notebook"
ITEM_KINDS = (KIND_PDF, KIND_NOTEBOOK)

# WHERE conditions on the papers table: the PDF papers, and everything the library lists (a notebook
# held by another item is listed under it, not on its own).
PDF_PAPERS = "kind='pdf' AND parent_id IS NULL"
LISTED_ITEMS = "kind IN ('pdf','notebook') AND parent_id IS NULL"

ATTACHMENT_FORMATS = ("md", "html")
TITLE_LIMIT = 200

# What a row of the list says of an item's relations (library_list.paper_row), zero when it has none.
NO_RELATIONS = {"attachment_count": 0, "owned_notebook_count": 0, "link_count": 0}


def owned_ids(db: sqlite3.Connection, owner_id: str) -> list[str]:
    """The IDs of the notebooks `owner_id` holds, oldest first (their rows and folders are their own)."""
    return [row[0] for row in db.execute(
        "SELECT id FROM papers WHERE parent_id=? ORDER BY created_at, id", (owner_id,))]


def forget_relations(db: sqlite3.Connection, item_id: str) -> None:
    """Remove the links and attachment rows of an item about to be removed.

    The foreign keys would do it as the papers row goes; stated here as well, as delete_paper states
    the rows of its other tables. The attachments' files go with the item's folder.
    """
    db.execute("DELETE FROM item_links WHERE a=? OR b=?", (item_id, item_id))
    db.execute("DELETE FROM attachments WHERE owner_id=?", (item_id,))


def relation_counts(db: sqlite3.Connection, ids: Iterable[str] | None = None) -> dict[str, dict[str, int]]:
    """What each item holds and is linked to, as the keys of NO_RELATIONS: only items that have any.

    `ids` limits it to those items (None: every item). Counted from the tables, so what a row says and
    what the item shows can not differ.
    """
    wanted = None if ids is None else list(dict.fromkeys(ids))
    result: dict[str, dict[str, int]] = {}

    def add(name: str, rows: Iterable[tuple[str, int]]) -> None:
        for item_id, count in rows:
            result.setdefault(item_id, dict(NO_RELATIONS))[name] = count

    # (key of NO_RELATIONS, query with its WHERE clause as {}, the column ids are matched on, the clause without ids)
    queries = (
        ("attachment_count", "SELECT owner_id,COUNT(*) FROM attachments {} GROUP BY owner_id", "owner_id", ""),
        ("owned_notebook_count", "SELECT parent_id,COUNT(*) FROM papers {} GROUP BY parent_id", "parent_id",
         "WHERE parent_id IS NOT NULL"),
        ("link_count", "SELECT id,COUNT(*) FROM (SELECT a AS id FROM item_links UNION ALL SELECT b FROM item_links) {}"
                       " GROUP BY id", "id", ""),
    )
    for name, sql, column, unfiltered in queries:
        if wanted is None:
            add(name, db.execute(sql.format(unfiltered)).fetchall())
            continue
        for start in range(0, len(wanted), 500):
            chunk = wanted[start:start + 500]
            add(name, db.execute(sql.format(f"WHERE {column} IN ({','.join('?' * len(chunk))})"), chunk).fetchall())
    return result


class ItemRelations(LibraryBase):
    """Library's holdings and links (see the module's description)."""

    # --- Holding ---

    def owned_notebooks(self, owner_id: str) -> list[str]:
        """The IDs of the notebooks `owner_id` holds."""
        with self.connection() as db:
            return owned_ids(db, owner_id)

    def add_attachment(self, owner_id: str, format: str, title: str, content: str, source: str = "user") -> dict:
        """Add a memo (md) or a document (html) to an item, at the end of its attachments; the new row.

        `source` says where it came from ("user", "imported", "summary", "chat"...). Invalid when the owner
        is itself held by another item (one level only), NotFound when it does not exist.
        """
        if format not in ATTACHMENT_FORMATS:
            raise Invalid("メモ・資料の形式が不正です。")
        title = " ".join(title.split())
        if len(title) > TITLE_LIMIT:
            raise Invalid(f"名前は{TITLE_LIMIT}文字以内で入力してください。")
        attachment_id = uuid.uuid4().hex
        path = PaperFiles(self.folder(owner_id)).attachment(attachment_id, format)
        try:
            with self.connection() as db:
                owner = db.execute("SELECT parent_id FROM papers WHERE id=?", (owner_id,)).fetchone()
                if owner is None:
                    raise NotFound("項目が見つかりません。")
                if owner["parent_id"] is not None:
                    raise Invalid("ほかの項目に入っているノートには、メモや資料を追加できません。")
                position = db.execute("SELECT COALESCE(MAX(position)+1,0) FROM attachments WHERE owner_id=?",
                                      (owner_id,)).fetchone()[0]
                db.execute("INSERT INTO attachments(id,owner_id,format,title,source,position) VALUES(?,?,?,?,?,?)",
                           (attachment_id, owner_id, format, title, source, position))
                # Inside the transaction: a file that cannot be written leaves no row.
                path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_text(path, content)
                return dict(db.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone())
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def attachments(self, owner_id: str) -> list[dict]:
        """The memos and documents of an item, in their order."""
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM attachments WHERE owner_id=? ORDER BY position,created_at,id", (owner_id,))]

    def attachment_text(self, attachment_id: str) -> str:
        """The text of an attachment's file; NotFound when it has no row, or its file is missing."""
        with self.connection() as db:
            row = db.execute("SELECT owner_id,format FROM attachments WHERE id=?", (attachment_id,)).fetchone()
        if row is None:
            raise NotFound("メモ・資料が見つかりません。")
        try:
            return PaperFiles(self.folder(row["owner_id"])).attachment(attachment_id, row["format"]).read_text("utf-8")
        except FileNotFoundError:
            raise NotFound("メモ・資料のファイルが見つかりません。") from None

    def remove_attachment(self, attachment_id: str) -> None:
        """Remove an attachment's row and file; NotFound when it has no row."""
        with self.connection() as db:
            row = db.execute("SELECT owner_id,format FROM attachments WHERE id=?", (attachment_id,)).fetchone()
            if row is None:
                raise NotFound("メモ・資料が見つかりません。")
            PaperFiles(self.folder(row["owner_id"])).attachment(attachment_id, row["format"]).unlink(missing_ok=True)
            db.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))

    def update_attachment(self, owner_id: str, attachment_id: str, *, title: str | None = None,
                          content: str | None = None) -> dict:
        """Save a memo's name or text. A row of another owner is never accessible."""
        if title is not None:
            title = " ".join(title.split())
            if not title or len(title) > TITLE_LIMIT:
                raise Invalid(f"名前は1〜{TITLE_LIMIT}文字で入力してください。")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM attachments WHERE id=? AND owner_id=? AND format='md'",
                             (attachment_id, owner_id)).fetchone()
            if row is None:
                raise NotFound("メモが見つかりません。")
            if content is not None:
                atomic_write_text(PaperFiles(self.folder(owner_id)).attachment(attachment_id, "md"), content)
            db.execute("UPDATE attachments SET title=?,updated_at=? WHERE id=?",
                       (row["title"] if title is None else title, datetime.now(timezone.utc).isoformat(), attachment_id))
            return dict(db.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone())

    def reorder_attachments(self, owner_id: str, ids: list[str]) -> None:
        """Order all the owner's md memos, refusing a stale/incomplete/foreign list."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = [row[0] for row in db.execute("SELECT id FROM attachments WHERE owner_id=? AND format='md'", (owner_id,))]
            if len(ids) != len(set(ids)) or set(ids) != set(current):
                raise Invalid("メモの一覧が変わりました。再読み込みして並べ替えてください。")
            db.executemany("UPDATE attachments SET position=? WHERE id=?", enumerate(ids))

    # --- Linking ---

    def link_items(self, first: str, second: str) -> bool:
        """Link two items that stand on their own; whether the link is new (an existing one stays as it is).

        Invalid for an item with itself and for one held by another item; NotFound for an unknown item.
        """
        if first == second:
            raise Invalid("同じ項目どうしは紐づけられません。")
        with self.connection() as db:
            for item_id in (first, second):
                row = db.execute("SELECT parent_id FROM papers WHERE id=?", (item_id,)).fetchone()
                if row is None:
                    raise NotFound("項目が見つかりません。")
                if row["parent_id"] is not None:
                    raise Invalid("ほかの項目に入っているノートは紐づけられません。")
            a, b = sorted((first, second))
            return db.execute("INSERT OR IGNORE INTO item_links(a,b) VALUES(?,?)", (a, b)).rowcount > 0

    def unlink_items(self, first: str, second: str) -> bool:
        """Remove the link between two items; whether there was one. Nothing else changes."""
        a, b = sorted((first, second))
        with self.connection() as db:
            return db.execute("DELETE FROM item_links WHERE a=? AND b=?", (a, b)).rowcount > 0

    def linked_ids(self, item_id: str) -> list[str]:
        """The IDs of the items linked to `item_id`, in ID order."""
        with self.connection() as db:
            return [row[0] for row in db.execute(
                "SELECT b FROM item_links WHERE a=? UNION SELECT a FROM item_links WHERE b=? ORDER BY 1",
                (item_id, item_id))]

    # --- What the list shows ---

    def relation_counts(self, ids: Iterable[str] | None = None) -> dict[str, dict[str, int]]:
        """relation_counts for the library's items (see the module function)."""
        with self.connection() as db:
            return relation_counts(db, ids)
