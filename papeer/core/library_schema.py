"""The steps of the library database's schema migrations (storage.MIGRATIONS lists them in order).

storage.py keeps MIGRATIONS, SCHEMA_VERSION and migrate_database, which run these steps; see the
comment above MIGRATIONS there for how to add one.
"""
from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import unicodedata

import pymupdf as fitz

from papeer.core.bibliography import extract_bibliography, extract_identifiers
from papeer.core.paths import PaperFiles
from papeer.core.translation_status import stored_status
from papeer.pdf.pdf_engine import PDF_LOCK


def _paper_discovery(db: sqlite3.Connection, _root: Path) -> None:
    db.execute("""CREATE TABLE paper_discovery (
        source TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        origin TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,origin)
    )""")


def _web_research(db: sqlite3.Connection, _root: Path) -> None:
    """Version 6: research provenance belongs to the saved exchange, not today's switch."""
    db.execute("ALTER TABLE messages ADD COLUMN research TEXT")
    db.execute("""CREATE TABLE reference_research (
        source TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source,key)
    )""")


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


def _status_codes(db: sqlite3.Connection, _root: Path) -> None:
    """Version 4: papers.status holds a TranslationStatus code instead of the Japanese label shown then.

    Converted as translation_status.stored_status reads them, so a value that is neither (hand-edited)
    becomes NOT_TRANSLATED. Rows are read through stored_status afterwards too: Papeer up to 0.2.0 opens
    this database without checking its version and may still write a label. The column's default stays
    the old label, as a column default cannot change in place; import_pdf states the code instead. The
    same database always converts the same way, so PCs that synced it before updating publish the same
    contents afterwards (drive_sync.sync: no conflict).
    """
    for (value,) in db.execute("SELECT DISTINCT status FROM papers").fetchall():
        if (code := stored_status(value).value) != value:
            db.execute("UPDATE papers SET status=? WHERE status=?", (code, value))


def _paper_titles(db: sqlite3.Connection, root: Path) -> None:
    """Version 5: titles from cached layouts, preserving manually changed titles.

    No PDF or OCR work inside the migration. Missing or unreadable caches leave their rows alone.
    document.json is upgraded separately on its next read, after this transaction commits.
    """
    from papeer.translation.translation_context import paper_title

    for paper_id, current, filename in db.execute("SELECT id,title,original_name FROM papers").fetchall():
        try:
            document = json.loads(PaperFiles(root / "papers" / paper_id).document_json.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if (not isinstance(document, dict) or not isinstance(document.get("blocks"), list)
                or not isinstance(document.get("title", ""), str)):
            continue
        fallback = Path(filename).stem
        if current not in {document.get("title"), fallback}:
            continue
        try:
            title = paper_title(document) or fallback
        except (TypeError, KeyError, IndexError, AttributeError):
            # A malformed cached block must not prevent the library from opening.
            continue
        if title != current:
            db.execute("UPDATE papers SET title=? WHERE id=?", (unicodedata.normalize("NFC", title), paper_id))
