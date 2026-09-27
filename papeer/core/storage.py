from __future__ import annotations

from contextlib import closing, contextmanager
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import threading
import uuid

from papeer.core.fileio import atomic_write_json, atomic_write_text
from papeer.pdf.pdf_engine import PDF_LOCK, extract_pdf
from papeer.core.translation_review import cached_review_pages
from papeer.core.bibliography import clean_arxiv_id, extract_bibliography, extract_identifiers, typed_doi
import pymupdf as fitz
from papeer.layout.math_layout import LAYOUT_VERSION
from papeer.core.paths import PaperFiles, sync_state_path


def normalize_collection_name(value: str) -> str:
    """Return a stable, display-friendly virtual folder path."""
    return " / ".join(part.strip() for part in re.split(r"[\\/]", value) if part.strip())


class NewerSchemaError(ValueError):
    """Data written by a newer Papeer: this version must neither read nor overwrite it."""


def newer_papeer(app_version: object) -> str:
    """Name the newer Papeer, with the version a backup or sync revision states when it looks like one."""
    if isinstance(app_version, str) and re.fullmatch(r"[0-9A-Za-z.+-]{1,40}", app_version):
        return f"新しいバージョンのPapeer（{app_version}）"
    return "新しいバージョンのPapeer"


NEWER_LIBRARY = "このライブラリは新しいバージョンのPapeerで更新されています。Papeerを最新版に更新してください。"


class LibraryMissingError(ValueError):
    """The data folder of a library this PC has synced is gone: an empty one must not replace it."""


def library_missing(root: Path) -> bool:
    """True when folder sync is on for `root` and has synced it, but its database is not there.

    A moved or deleted data folder (or a drive that is not mounted) would otherwise be recreated
    empty, and the next automatic sync would publish the empty library over the synced one.
    """
    if (root / "library.sqlite3").exists():
        return False
    try:
        state = json.loads(sync_state_path(root).read_text("utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(state, dict) and bool(state.get("connected")) and bool(state.get("base") or state.get("hash"))


def missing_library_message(root: Path) -> str:
    return (f"データフォルダー（{root}）が見つかりません。移動・削除した場合は元の場所に戻してください。"
            "新しいライブラリとして始める場合は、設定 → 保存先・同期で「新しいライブラリとして始める」を選んでください。")


def _baseline(db: sqlite3.Connection, root: Path) -> None:
    """Version 1: the schema as it was before versioning.

    Every library made before then is at user_version 0 with whatever tables and columns
    its version created, so each statement here checks first and is safe to repeat.
    """
    db.execute("""CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL, original_name TEXT NOT NULL,
        pages INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '追加済み',
        collection_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS pages (
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(paper_id, number)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'paper',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS collections (
        name TEXT PRIMARY KEY
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        page INTEGER NOT NULL,
        side TEXT NOT NULL,
        quote TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '重要',
        note TEXT NOT NULL DEFAULT '',
        anchor_y REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS pdf_ink (
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        side TEXT NOT NULL,
        page INTEGER NOT NULL,
        strokes TEXT NOT NULL,
        PRIMARY KEY(paper_id, side, page)
    )""")
    if "anchor_y" not in {row[1] for row in db.execute("PRAGMA table_info(bookmarks)")}:
        db.execute("ALTER TABLE bookmarks ADD COLUMN anchor_y REAL NOT NULL DEFAULT 0")
    if "anchor_x" not in {row[1] for row in db.execute("PRAGMA table_info(bookmarks)")}:
        db.execute("ALTER TABLE bookmarks ADD COLUMN anchor_x REAL NOT NULL DEFAULT 0")
    if "usage" not in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
        db.execute("ALTER TABLE messages ADD COLUMN usage TEXT")
    if "scope" not in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
        db.execute("ALTER TABLE messages ADD COLUMN scope TEXT NOT NULL DEFAULT 'paper'")
    if "attachments" not in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
        db.execute("ALTER TABLE messages ADD COLUMN attachments TEXT")
    columns = {row[1] for row in db.execute("PRAGMA table_info(papers)")}
    if "tags" not in columns:
        db.execute("ALTER TABLE papers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    if "read_status" not in columns:
        db.execute("ALTER TABLE papers ADD COLUMN read_status TEXT NOT NULL DEFAULT '未読'")
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_status_choices'").fetchone():
        db.execute("CREATE TABLE reading_status_choices (name TEXT PRIMARY KEY)")
        db.executemany("INSERT INTO reading_status_choices VALUES(?)",
                       [(name,) for name in ("未読", "読書中", "読了", "再読したい")])
    db.execute("CREATE TABLE IF NOT EXISTS note_templates (name TEXT PRIMARY KEY, content TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS collection_glossaries (name TEXT PRIMARY KEY, terms TEXT NOT NULL)")
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tag_choices'").fetchone():
        db.execute("CREATE TABLE tag_choices (kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(kind,name))")
        db.executemany("INSERT INTO tag_choices VALUES('sticky',?)",
                       [(name,) for name in ("重要", "疑問", "あとで確認", "引用", "確認済み")])
        db.execute("INSERT OR IGNORE INTO tag_choices SELECT 'sticky',label FROM bookmarks WHERE label<>''")
        for row in db.execute("SELECT tags FROM papers").fetchall():
            db.executemany("INSERT OR IGNORE INTO tag_choices VALUES('paper',?)",
                           [(name,) for name in json.loads(row[0])])
    for name in ("first_author", "publication_year"):
        if name not in columns:
            db.execute(f"ALTER TABLE papers ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
    if "bibliography_version" not in columns:
        db.execute("ALTER TABLE papers ADD COLUMN bibliography_version INTEGER NOT NULL DEFAULT 0")
    for (paper_id,) in db.execute("SELECT id FROM papers WHERE bibliography_version=0").fetchall():
        try:
            with PDF_LOCK, fitz.open(PaperFiles(root / "papers" / paper_id).original_pdf) as document:
                info = extract_bibliography(document)
        except (OSError, ValueError, RuntimeError):
            continue
        db.execute("UPDATE papers SET first_author=?,publication_year=?,bibliography_version=1 WHERE id=?",
                   (info["first_author"], info["publication_year"], paper_id))


# The colours a passage can be highlighted in (frontend features/reader/highlights.ts), and how an
# exported PDF paints them (pdf_ink.annotated_pdf).
HIGHLIGHT_COLORS = {"yellow": "#facc15", "green": "#4ade80", "blue": "#60a5fa", "pink": "#f472b6", "purple": "#c084fc"}
# Rectangles of one highlight: a passage over a page or two of lines, with room to spare.
MAX_HIGHLIGHT_RECTS = 400


def _highlight_rects(rects: list) -> list[list[float]]:
    """A highlight's rectangles checked to lie on the page, rounded to keep the database small."""
    if not rects or len(rects) > MAX_HIGHLIGHT_RECTS:
        raise ValueError("ハイライトする範囲が不正です。")
    result = []
    for rect in rects:
        if not isinstance(rect, (list, tuple)) or len(rect) != 4 \
                or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in rect):
            raise ValueError("ハイライトする範囲が不正です。")
        x, y, width, height = (float(value) for value in rect)
        # NaN fails every comparison, so it is refused here too.
        if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < width <= 1 and 0 < height <= 1
                and x + width <= 1.00002 and y + height <= 1.00002):
            raise ValueError("ハイライトする範囲がページの外にはみ出しています。")
        # Kept on the page once rounded: the edges are rounded, and the size taken from them.
        left, top = round(x, 5), round(y, 5)
        right, bottom = min(1.0, round(x + width, 5)), min(1.0, round(y + height, 5))
        if right <= left or bottom <= top:
            raise ValueError("ハイライトする範囲が小さすぎます。")
        result.append([left, top, round(right - left, 5), round(bottom - top, 5)])
    return result


def _highlights(db: sqlite3.Connection, _root: Path) -> None:
    """Version 2: highlights of selected text, kept with the sticky notes.

    A highlight is a sticky note (kind 'highlight') without a marker: its colour and the rectangles it
    covers, as fractions of the displayed page ([x, y, width, height], like the ink), with the selected
    text as its quote. So it is listed, searched, deleted and undone, exported to the memo, synced and
    counted (drive_sync's "stickies") with the sticky notes, and can be given a memo and a label too.
    """
    db.execute("ALTER TABLE bookmarks ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'")
    db.execute("ALTER TABLE bookmarks ADD COLUMN color TEXT NOT NULL DEFAULT ''")
    db.execute("ALTER TABLE bookmarks ADD COLUMN rects TEXT NOT NULL DEFAULT '[]'")


def _bibliographic_ids(db: sqlite3.Connection, _root: Path) -> None:
    """Version 3: DOI, arXiv ID and venue of each paper, for citing it (BibTeX).

    Filled from the first page's text the library already holds (pages.text). An import reads the PDF
    itself instead (its metadata, and the page's text as MuPDF gives it), so the two may find different
    values for the same paper; opening every PDF here would hold this transaction too long. Each PC
    derives the same values from the same text, so two PCs that both update agree when they next sync.
    """
    for name in ("doi", "arxiv_id", "venue"):
        db.execute(f"ALTER TABLE papers ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
    # Read row by row: only papers is written meanwhile, not the pages being read.
    for paper_id, text in db.execute("SELECT paper_id,text FROM pages WHERE number=1"):
        found = extract_identifiers(text[:20000])
        if any(found.values()):
            db.execute("UPDATE papers SET doi=?,arxiv_id=?,venue=? WHERE id=?",
                       (found["doi"], found["arxiv_id"], found["venue"], paper_id))


# Schema migrations. PRAGMA user_version counts the steps a library database has been through.
# To change the schema or convert stored values (a column, a table, an FTS index, status codes, ...),
# append a function taking (db, library root) to MIGRATIONS. It runs once, on a database at exactly
# the previous version, in one transaction with the other pending steps and the version update, so it
# may assume that state (no "if not exists" checks) and a failure leaves the database as it was.
# Use db.execute only: executescript commits, and PRAGMA foreign_keys is off and cannot change here.
# A newer database (a later Papeer, its backups or sync revisions) is refused, never migrated down.
# Changing the stored contents also changes drive_sync.fingerprint, so each PC publishes a new sync
# revision once after updating; tables needed only when used (collection_undo, global_glossary) are
# therefore still created on first use rather than here. They may be missing at any version: a later
# step that touches them must check whether they exist first (sqlite_master), unlike other tables.
# Add a test in tests/test_schema_migration.py, and list any new columns in LATER_COLUMNS in
# tests/_legacy_library.py (tests that make a current database look unversioned drop them).
MIGRATIONS = [_baseline, _highlights, _bibliographic_ids]
SCHEMA_VERSION = len(MIGRATIONS)

# The sidecar opens a Library per request; concurrent first requests after an upgrade wait here
# rather than on SQLite's busy timeout while one of them migrates.
_SCHEMA_LOCK = threading.Lock()


def database_version(path: Path) -> int:
    """PRAGMA user_version of a library database file, without migrating it."""
    with closing(sqlite3.connect(path, timeout=30)) as db:
        return db.execute("PRAGMA user_version").fetchone()[0]


def migrate_database(root: Path) -> None:
    """Bring the library database to SCHEMA_VERSION: every pending step or none."""
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30, isolation_level=None)) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("BEGIN IMMEDIATE")
        try:
            # Read again under the write lock: another process may have migrated meanwhile.
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise NewerSchemaError(NEWER_LIBRARY)
            if version == SCHEMA_VERSION:
                db.execute("ROLLBACK")  # Nothing to write.
                return
            for step in MIGRATIONS[version:]:
                step(db, root)
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION:d}")
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise


class Library:
    def __init__(self, root: Path):
        self.root = root
        if library_missing(root):
            raise LibraryMissingError(missing_library_message(root))
        self.root.mkdir(parents=True, exist_ok=True)
        (root / "papers").mkdir(exist_ok=True)
        # One pragma per open, so a database a restore or sync put in place is migrated on first use.
        version = database_version(root / "library.sqlite3")
        if version > SCHEMA_VERSION:
            raise NewerSchemaError(NEWER_LIBRARY)
        if version < SCHEMA_VERSION:
            with _SCHEMA_LOCK:
                migrate_database(root)

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

    def import_pdf(self, source: Path, collection_name: str = "", original_name: str = "") -> tuple[str, bool]:
        if source.stat().st_size > 300 * 1024 * 1024:
            raise ValueError("300MB以下のPDFを追加してください。")
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        with self.connection() as db:
            duplicate = db.execute("SELECT id FROM papers WHERE sha256=?", (digest,)).fetchone()
            if duplicate:
                return duplicate["id"], False
        info = extract_pdf(source)
        if not info["blocks"]:
            raise ValueError("文字を抽出できませんでした。スキャンPDFはOCR済みのコピーを追加してください。")
        paper_id = uuid.uuid4().hex
        folder = self.folder(paper_id)
        folder.mkdir()
        try:
            shutil.copyfile(source, PaperFiles(folder).original_pdf)
            atomic_write_json(PaperFiles(folder).document_json, info)
            with self.connection() as db:
                db.execute("""INSERT INTO papers(id,sha256,title,original_name,pages,collection_name,first_author,publication_year,
                           doi,arxiv_id,venue,bibliography_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)""",
                           (paper_id, digest, info["title"], original_name or source.name, info["page_count"],
                            normalize_collection_name(collection_name), info["first_author"], info["publication_year"],
                            info.get("doi", ""), info.get("arxiv_id", ""), info.get("venue", "")))
                if not db.execute("SELECT 1 FROM reading_status_choices WHERE name='未読'").fetchone():
                    db.execute("UPDATE papers SET read_status='' WHERE id=?", (paper_id,))
                db.executemany("INSERT INTO pages(paper_id,number,text) VALUES(?,?,?)",
                               [(paper_id, p["number"], p["text"]) for p in info["pages"]])
        except Exception:
            shutil.rmtree(folder)
            raise
        return paper_id, True

    def papers(self, query: str = "") -> list[dict]:
        sql = "SELECT p.* FROM papers p WHERE 1=1"
        arguments = []
        if query.strip():
            sql += """ AND (instr(lower(p.title),lower(?))>0 OR instr(lower(p.note),lower(?))>0
                OR instr(lower(p.first_author),lower(?))>0 OR instr(p.publication_year,?)>0
                OR instr(lower(p.collection_name),lower(?))>0 OR instr(lower(p.original_name),lower(?))>0
                OR instr(lower(p.tags),lower(?))>0 OR EXISTS
                (SELECT 1 FROM pages x WHERE x.paper_id=p.id AND instr(lower(x.text),lower(?))>0))"""
            arguments += [query.strip()] * 8
        sql += " ORDER BY created_at DESC, id"
        with self.connection() as db:
            return [dict(row, tags=json.loads(row["tags"])) for row in db.execute(sql, arguments)]

    @staticmethod
    def _oldest_first(rows: list[sqlite3.Row]) -> list[dict]:
        """Papers in the order they were added (as BibTeX keys are told apart): created_at counts whole
        seconds, so papers added within one second keep the order they were inserted in (rowid)."""
        rows = sorted(rows, key=lambda row: (row["created_at"], row["insert_order"]))
        return [{**{k: row[k] for k in row.keys() if k != "insert_order"}, "tags": json.loads(row["tags"])} for row in rows]

    def papers_by_id(self, paper_ids: list[str]) -> list[dict]:
        """The papers `paper_ids`, oldest first (_oldest_first); raises KeyError for a missing one."""
        wanted = list(dict.fromkeys(paper_ids))
        for paper_id in wanted:
            self.folder(paper_id)  # Checks the ID's form.
        rows = []
        with self.connection() as db:
            for start in range(0, len(wanted), 500):
                chunk = wanted[start:start + 500]
                rows += db.execute(f"SELECT rowid AS insert_order,* FROM papers WHERE id IN ({','.join('?' * len(chunk))})",
                                   chunk).fetchall()
        if len(rows) != len(wanted):
            raise KeyError("論文が見つかりません。")
        return self._oldest_first(rows)

    def collection_papers(self, path: str) -> list[dict]:
        """The papers in folder `path` and its subfolders, oldest first (_oldest_first)."""
        path = normalize_collection_name(path)
        if not path:
            raise ValueError("フォルダーを指定してください。")
        with self.connection() as db:
            rows = db.execute("SELECT rowid AS insert_order,* FROM papers").fetchall()
        return self._oldest_first([row for row in rows if (name := normalize_collection_name(row["collection_name"])) == path
                                   or name.startswith(path + " / ")])

    def paper(self, paper_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            raise KeyError("論文が見つかりません。")
        return dict(row, tags=json.loads(row["tags"]))

    def collections(self) -> list[str]:
        with self.connection() as db:
            names = [row[0] for row in db.execute(
                "SELECT name FROM collections UNION SELECT collection_name FROM papers")]
        paths = set()
        for name in names:
            parts = normalize_collection_name(name).split(" / ")
            paths.update(" / ".join(parts[:depth]) for depth in range(1, len(parts) + 1))
        return sorted(paths - {""}, key=str.casefold)

    def create_collection(self, name: str) -> str:
        name = normalize_collection_name(name)
        if not name:
            raise ValueError("フォルダー名を入力してください。")
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO collections(name) VALUES(?)", (name,))
        return name

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

    def update(self, paper_id: str, **values) -> None:
        if not values or not set(values) <= {"title", "status", "collection_name", "note", "first_author", "publication_year",
                                             "tags", "read_status", "doi", "arxiv_id", "venue"}:
            raise ValueError("Invalid fields")
        if "tags" in values:
            tags = list(dict.fromkeys(tag.strip() for tag in values["tags"] if tag.strip()))
            if len(tags) > 100 or any(len(tag) > 80 for tag in tags):
                raise ValueError("タグは100件まで、名前は80文字までです。")
            values["tags"] = json.dumps(tags, ensure_ascii=False)
        for name in ("first_author", "publication_year"):
            if name in values:
                values[name] = values[name].strip()
        if values.get("publication_year") and not re.fullmatch(r"[0-9]{4}", values["publication_year"]):
            raise ValueError("出版年は半角数字4桁で入力してください。")
        # A DOI or arXiv ID may be pasted as a link ("https://doi.org/…", "arXiv:…"); it is kept bare.
        if "doi" in values:
            values["doi"] = typed_doi(values["doi"])
        if values.get("arxiv_id", "").strip():
            values["arxiv_id"] = clean_arxiv_id(values["arxiv_id"])
            if not values["arxiv_id"]:
                raise ValueError("arXiv IDは「2101.00001」のような形式で入力してください。")
        elif "arxiv_id" in values:
            values["arxiv_id"] = ""
        if "venue" in values:
            values["venue"] = " ".join(values["venue"].split())
            if len(values["venue"]) > 300:
                raise ValueError("掲載誌は300文字以内で入力してください。")
        if "collection_name" in values:
            values["collection_name"] = normalize_collection_name(values["collection_name"])
        with self.connection() as db:
            if values.get("read_status") and not db.execute(
                "SELECT 1 FROM reading_status_choices WHERE name=?", (values["read_status"],)
            ).fetchone():
                raise ValueError("読書状態が不正です。")
            fields = ",".join(f"{name}=?" for name in values)
            db.execute(f"UPDATE papers SET {fields} WHERE id=?", [*values.values(), paper_id])
            if "tags" in values:
                db.executemany("INSERT OR IGNORE INTO tag_choices VALUES('paper',?)", [(name,) for name in tags])
        if "note" in values:
            atomic_write_text(PaperFiles(self.folder(paper_id)).note_md, values["note"])

    def rename_collection(self, path: str, leaf: str) -> str:
        path = normalize_collection_name(path)
        leaf = leaf.strip()
        if not path or not leaf or "/" in leaf or "\\" in leaf:
            raise ValueError("区切り文字を含まないフォルダー名を入力してください。")
        names = self.collections()
        if path not in names:
            raise ValueError("フォルダーが見つかりません。")
        destination = " / ".join(path.split(" / ")[:-1] + [leaf])
        if destination == path:
            return path
        if destination in names:
            raise ValueError("同じ名前のフォルダーが既にあります。")
        def mapped(name):
            return destination + name[len(path):] if name == path or name.startswith(path + " / ") else name
        with self.connection() as db:
            # Materialize implicit parents too, so renaming their last child keeps them.
            glossary_rows = db.execute("SELECT name,terms FROM collection_glossaries").fetchall()
            db.execute("DELETE FROM collection_glossaries")
            db.executemany("INSERT INTO collection_glossaries(name,terms) VALUES(?,?)",
                           [(mapped(row["name"]), row["terms"]) for row in glossary_rows])
            db.execute("DELETE FROM collections")
            db.executemany("INSERT INTO collections(name) VALUES(?)", [(mapped(name),) for name in names])
            for row in db.execute("SELECT id,collection_name FROM papers").fetchall():
                name = normalize_collection_name(row["collection_name"])
                if mapped(name) != name:
                    db.execute("UPDATE papers SET collection_name=? WHERE id=?", (mapped(name), row["id"]))
        return destination

    def delete_collection(self, path: str, *, undo_token: str | None = None) -> list[str]:
        """Remove a folder subtree, preserving every paper and its files."""
        path = normalize_collection_name(path)
        if not path:
            raise ValueError("未分類は削除できません。")
        def inside(name):
            name = normalize_collection_name(name)
            return name == path or name.startswith(path + " / ")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            names = [row[0] for row in db.execute("SELECT name FROM collections")]
            papers = db.execute("SELECT id,collection_name FROM papers").fetchall()
            if not any(inside(name) for name in names) and not any(inside(row["collection_name"]) for row in papers):
                raise ValueError("フォルダーが見つかりません。")
            if undo_token:
                db.execute("CREATE TABLE IF NOT EXISTS collection_undo (token TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
                snapshot = {"path": path, "names": [name for name in names if inside(name)],
                            "papers": [dict(row) for row in papers if inside(row["collection_name"])],
                            "glossaries": [dict(row) for row in db.execute("SELECT name,terms FROM collection_glossaries") if inside(row["name"])]}
                db.execute("INSERT INTO collection_undo VALUES(?,?)", (undo_token, json.dumps(snapshot)))
            # Keep implicit ancestors when their last descendant is removed.
            parent = " / ".join(path.split(" / ")[:-1])
            if parent:
                db.execute("INSERT OR IGNORE INTO collections(name) VALUES(?)", (parent,))
            identities = [row["id"] for row in papers if inside(row["collection_name"])]
            db.executemany("UPDATE papers SET collection_name='' WHERE id=?", [(identity,) for identity in identities])
            db.executemany("DELETE FROM collections WHERE name=?", [(name,) for name in names if inside(name)])
            db.executemany("DELETE FROM collection_glossaries WHERE name=?",
                           [(row[0],) for row in db.execute("SELECT name FROM collection_glossaries").fetchall() if inside(row[0])])
        return identities

    def restore_collection(self, token: str) -> str:
        """Restore a deleted subtree atomically, refusing to overwrite later edits."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_undo'").fetchone():
                raise ValueError("復元できるフォルダーが見つかりません。")
            row = db.execute("SELECT snapshot FROM collection_undo WHERE token=?", (token,)).fetchone()
            if not row:
                raise ValueError("復元できるフォルダーが見つかりません。")
            saved = json.loads(row[0])
            path = saved["path"]
            names = [r[0] for r in db.execute("SELECT name FROM collections UNION SELECT collection_name FROM papers UNION SELECT name FROM collection_glossaries")]
            if any(n == path or n.startswith(path + " / ") for n in names):
                raise ValueError("同じ場所にフォルダーが作成されています。名前を変更してから復元してください。")
            for paper in saved["papers"]:
                current = db.execute("SELECT collection_name FROM papers WHERE id=?", (paper["id"],)).fetchone()
                if not current or current[0]:
                    raise ValueError("削除後に論文が移動または削除されています。先にその操作を確認してください。")
            db.executemany("INSERT OR IGNORE INTO collections(name) VALUES(?)", [(n,) for n in [path, *saved["names"]]])
            db.executemany("UPDATE papers SET collection_name=? WHERE id=?", [(p["collection_name"], p["id"]) for p in saved["papers"]])
            db.executemany("INSERT INTO collection_glossaries(name,terms) VALUES(?,?)", [(g["name"], g["terms"]) for g in saved["glossaries"]])
            db.execute("DELETE FROM collection_undo WHERE token=?", (token,))
        return path

    def rename_paper(self, paper_id: str, name: str) -> str:
        name = name.strip()
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        stem = name[:-4]
        if (not stem.strip() or stem.endswith((" ", ".")) or
                re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or len(name) > 255 or
                stem.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}):
            raise ValueError("Windowsで使用できるファイル名を入力してください。")
        with self.connection() as db:
            if not db.execute("SELECT id FROM papers WHERE id=?", (paper_id,)).fetchone():
                raise KeyError("論文が見つかりません。")
            db.execute("UPDATE papers SET original_name=?,title=? WHERE id=?", (name, stem, paper_id))
        return name

    def reading_info(self, paper_id: str) -> dict:
        """Read display metadata without migrating the extraction cache."""
        with self.connection() as db:
            paper = db.execute("SELECT pages FROM papers WHERE id=?", (paper_id,)).fetchone()
            if paper is None:
                raise KeyError("論文が見つかりません。")
            empty = [row[0] for row in db.execute(
                "SELECT number FROM pages WHERE paper_id=? AND trim(text)='' ORDER BY number",
                (paper_id,))]
        # Use the same units as translation: references, formulas and other
        # deliberately preserved content do not require a translated page, nor does a
        # page needing OCR (garbled text or a scanned image), which is listed instead.
        review = cached_review_pages(self.folder(paper_id), paper[0])
        return {"page_count": paper[0], "empty_pages": empty, "translation_required_pages": review["required"],
                "ocr_pages": review["ocr"]}

    def document(self, paper_id: str) -> dict:
        folder = self.folder(paper_id)
        path = PaperFiles(folder).document_json
        document = json.loads(path.read_text("utf-8"))
        if document.get("layout_version") != LAYOUT_VERSION:
            refreshed = extract_pdf(PaperFiles(folder).original_pdf)
            refreshed["title"] = document["title"]
            atomic_write_json(path, refreshed)
            document = refreshed
        return document

    def messages(self, paper_id: str, with_usage: bool = False, scope: str | None = None) -> list[dict]:
        with self.connection() as db:
            condition = " WHERE paper_id=?" + (" AND scope=?" if scope is not None else "")
            values = (paper_id, scope) if scope is not None else (paper_id,)
            rows = db.execute("SELECT role,content,usage,attachments FROM messages" + condition + " ORDER BY id", values)
            result = []
            for row in rows:
                item = {"role": row["role"], "content": row["content"]}
                if row["attachments"]:
                    item["attachments"] = json.loads(row["attachments"])
                if with_usage:
                    item["usage"] = json.loads(row["usage"]) if row["usage"] else None
                result.append(item)
            return result

    def add_exchange(self, paper_id: str, question: str, answer: str, usage: dict | None = None,
                     scope: str = "paper", attachments: list[dict] | None = None) -> None:
        with self.connection() as db:
            db.executemany("INSERT INTO messages(paper_id,role,content,usage,scope,attachments) VALUES(?,?,?,?,?,?)",
                           [(paper_id, "user", question, None, scope,
                             json.dumps(attachments, ensure_ascii=False) if attachments else None),
                            (paper_id, "assistant", answer, json.dumps(usage) if usage else None, scope, None)])

    def search_pages(self, question: str, paper_id: str | None = None, limit: int = 10,
                     paper_ids: set[str] | None = None) -> list[dict]:
        import re
        terms = re.findall(r"[a-zA-Z0-9_-]{2,}|[\u3040-\u30ff\u3400-\u9fff]{2,}", question.lower())
        with self.connection() as db:
            sql = "SELECT x.*, p.title FROM pages x JOIN papers p ON p.id=x.paper_id"
            rows = db.execute(sql + (" WHERE x.paper_id=?" if paper_id else ""), (paper_id,) if paper_id else ()).fetchall()
        scored = []
        for row in rows:
            data = dict(row)
            if paper_ids is not None and data["paper_id"] not in paper_ids:
                continue
            data["score"] = sum(data["text"].lower().count(term) for term in terms)
            scored.append(data)
        scored.sort(key=lambda x: (-x["score"], x["paper_id"], x["number"]))
        return scored[:limit]

    @staticmethod
    def _bookmark(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["rects"] = json.loads(item.get("rects") or "[]")
        return item

    def bookmarks(self, paper_id: str) -> list[dict]:
        """The paper's sticky notes and highlights (kind 'note' or 'highlight')."""
        self.paper(paper_id)
        with self.connection() as db:
            return [self._bookmark(row) for row in db.execute(
                "SELECT * FROM bookmarks WHERE paper_id=? ORDER BY page,id", (paper_id,))]

    def sticky_notes(self) -> list[dict]:
        with self.connection() as db:
            return [self._bookmark(row) for row in db.execute(
                "SELECT b.*, p.title AS paper_title, p.original_name AS paper_name "
                "FROM bookmarks b JOIN papers p ON p.id=b.paper_id ORDER BY b.id DESC")]

    def add_bookmark(self, paper_id: str, page: int, side: str, quote: str,
                     label: str = "重要", note: str = "", anchor_y: float = 0, anchor_x: float = 0,
                     *, kind: str = "note", color: str = "", rects: list | None = None) -> dict:
        """A sticky note, or with kind='highlight' a highlight of `quote` over `rects` (see _highlights)."""
        paper = self.paper(paper_id)
        if not 1 <= page <= paper["pages"] or side not in {"original", "translated"} or not 0 <= anchor_y <= 1 or not 0 <= anchor_x <= 1:
            raise ValueError("ページまたは原文・訳文の指定が不正です。")
        quote = quote.strip()[:2000]
        if kind == "highlight":
            boxes = _highlight_rects(rects or [])
            if color not in HIGHLIGHT_COLORS or not quote:
                raise ValueError("ハイライトの色または文章の指定が不正です。")
        elif kind == "note":
            color, boxes = "", []
        else:
            raise ValueError("付箋の種類が不正です。")
        with self.connection() as db:
            cursor = db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
                                " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                                (paper_id, page, side, quote, label[:40], note[:1000], anchor_y, anchor_x,
                                 kind, color, json.dumps(boxes, separators=(",", ":"))))
            return self._bookmark(db.execute("SELECT * FROM bookmarks WHERE id=?", (cursor.lastrowid,)).fetchone())

    def update_bookmark(self, paper_id: str, bookmark_id: int, label: str | None = None, note: str | None = None,
                        *, anchor_x: float | None = None, anchor_y: float | None = None,
                        color: str | None = None) -> dict:
        """Edits a sticky note or highlight; what is None stays as it is (a PATCH of the colour alone keeps the
        label and memo). A highlight may have no label, and changes colour with `color`."""
        self.paper(paper_id)
        if color is not None and color not in HIGHLIGHT_COLORS:
            raise ValueError("ハイライトの色の指定が不正です。")
        label = None if label is None else label.strip()[:40]
        with self.connection() as db:
            updated = db.execute("UPDATE bookmarks SET label=CASE WHEN ? IS NULL THEN label WHEN kind='highlight' THEN ? ELSE ? END,"
                                 "note=COALESCE(?,note),anchor_x=COALESCE(?,anchor_x),anchor_y=COALESCE(?,anchor_y),"
                                 "color=CASE WHEN kind='highlight' THEN COALESCE(?,color) ELSE color END"
                                 " WHERE paper_id=? AND id=?",
                                 (label, label, (label or "重要") if label is not None else None,
                                  None if note is None else note[:1000], anchor_x, anchor_y, color, paper_id, bookmark_id))
            if not updated.rowcount:
                raise ValueError("付箋が見つかりません。")
            return self._bookmark(db.execute("SELECT * FROM bookmarks WHERE id=?", (bookmark_id,)).fetchone())

    def highlights_by_page(self, paper_id: str, side: str) -> dict[int, list[dict]]:
        """Each page's highlights on one side, as an exported PDF paints them: colour (#rrggbb) and rectangles."""
        pages: dict[int, list[dict]] = {}
        with self.connection() as db:
            for row in db.execute("SELECT page,color,rects FROM bookmarks WHERE paper_id=? AND side=? AND kind='highlight'"
                                  " ORDER BY page,id", (paper_id, side)):
                pages.setdefault(row["page"], []).append(
                    {"color": HIGHLIGHT_COLORS.get(row["color"], HIGHLIGHT_COLORS["yellow"]), "rects": json.loads(row["rects"])})
        return pages

    def delete_paper(self, paper_id: str) -> None:
        """Remove a paper, its records and its folder."""
        folder = self.folder(paper_id)
        with self.connection() as db:
            db.execute("DELETE FROM messages WHERE paper_id=?", (paper_id,))
            db.execute("DELETE FROM pages WHERE paper_id=?", (paper_id,))
            db.execute("DELETE FROM papers WHERE id=?", (paper_id,))
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)

    def page_texts(self, paper_id: str) -> list[tuple[int, str]]:
        """(page number, extracted text) of every page, in order."""
        with self.connection() as db:
            return [(row["number"], row["text"]) for row in db.execute(
                "SELECT number,text FROM pages WHERE paper_id=? ORDER BY number", (paper_id,))]

    def page_text(self, paper_id: str, number: int) -> str:
        with self.connection() as db:
            row = db.execute("SELECT text FROM pages WHERE paper_id=? AND number=?", (paper_id, number)).fetchone()
        return row[0] if row else ""

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

    # --- Freehand ink, per paper, side ("original"/"translated") and page ---

    def ink(self, paper_id: str, side: str, page: int) -> list[dict]:
        with self.connection() as db:
            row = db.execute("SELECT strokes FROM pdf_ink WHERE paper_id=? AND side=? AND page=?",
                             (paper_id, side, page)).fetchone()
        return json.loads(row["strokes"]) if row else []

    def save_ink(self, paper_id: str, side: str, page: int, strokes: list[dict]) -> None:
        with self.connection() as db:
            db.execute("INSERT INTO pdf_ink(paper_id,side,page,strokes) VALUES(?,?,?,?) "
                       "ON CONFLICT(paper_id,side,page) DO UPDATE SET strokes=excluded.strokes",
                       (paper_id, side, page, json.dumps(strokes, separators=(",", ":"))))

    def ink_by_page(self, paper_id: str, side: str) -> dict[int, list[dict]]:
        with self.connection() as db:
            return {row["page"]: json.loads(row["strokes"]) for row in db.execute(
                "SELECT page,strokes FROM pdf_ink WHERE paper_id=? AND side=?", (paper_id, side))}

    def ink_pages(self, paper_id: str) -> list[dict]:
        """Pages that have ink, with the number of strokes on each."""
        with self.connection() as db:
            rows = db.execute("SELECT side,page,strokes FROM pdf_ink WHERE paper_id=? ORDER BY page,side",
                              (paper_id,)).fetchall()
        return [{"side": row["side"], "page": row["page"], "count": len(value)}
                for row in rows if (value := json.loads(row["strokes"]))]

    def delete_bookmark(self, paper_id: str, bookmark_id: int) -> bool:
        self.paper(paper_id)
        with self.connection() as db:
            return db.execute("DELETE FROM bookmarks WHERE paper_id=? AND id=?",
                              (paper_id, bookmark_id)).rowcount > 0
