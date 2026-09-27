"""Library folders as Papeer left them before schema versioning (PRAGMA user_version 0).

Each stage is a database some earlier version created; later versions added columns and tables
to it in place. Used by the migration, backup and sync tests.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import uuid
import zipfile

SAMPLE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"

# The first released schema: no tags, reading status, bibliography, sticky-note positions or ink.
OLDEST = [
    """CREATE TABLE papers (
        id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL, original_name TEXT NOT NULL,
        pages INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '追加済み',
        collection_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    """CREATE TABLE pages (
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        number INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(paper_id, number)
    )""",
    """CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
    "CREATE TABLE collections (name TEXT PRIMARY KEY)",
    """CREATE TABLE bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        page INTEGER NOT NULL, side TEXT NOT NULL, quote TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '重要', note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""",
]

# Some of the later additions: tags, chat usage and scope, one sticky-note coordinate, ink,
# templates and the user's own reading statuses, but no bibliography or tag choices yet.
MIDDLE = OLDEST + [
    "ALTER TABLE bookmarks ADD COLUMN anchor_y REAL NOT NULL DEFAULT 0",
    "ALTER TABLE messages ADD COLUMN usage TEXT",
    "ALTER TABLE messages ADD COLUMN scope TEXT NOT NULL DEFAULT 'paper'",
    "ALTER TABLE papers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE papers ADD COLUMN read_status TEXT NOT NULL DEFAULT '未読'",
    "CREATE TABLE reading_status_choices (name TEXT PRIMARY KEY)",
    "INSERT INTO reading_status_choices VALUES('未読'),('積読')",
    """CREATE TABLE pdf_ink (
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        side TEXT NOT NULL, page INTEGER NOT NULL, strokes TEXT NOT NULL,
        PRIMARY KEY(paper_id, side, page)
    )""",
    "CREATE TABLE note_templates (name TEXT PRIMARY KEY, content TEXT NOT NULL)",
]

STAGES = {"oldest": OLDEST, "middle": MIDDLE}


def legacy_library(root: Path, stage: str = "oldest") -> str:
    """Create a library folder with one paper at an old schema stage; returns the paper's ID."""
    identity = uuid.uuid4().hex
    folder = root / "papers" / identity
    folder.mkdir(parents=True)
    shutil.copyfile(SAMPLE_PDF, folder / "original.pdf")
    (folder / "note.md").write_text("古いメモ", "utf-8")
    digest = hashlib.sha256(SAMPLE_PDF.read_bytes()).hexdigest()
    with closing(sqlite3.connect(root / "library.sqlite3")) as db, db:
        db.execute("PRAGMA journal_mode=WAL")
        for statement in STAGES[stage]:
            db.execute(statement)
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,note) VALUES(?,?,?,?,?,?)",
                   (identity, digest, "Legacy paper", "legacy.pdf", 1, "古いメモ"))
        db.execute("INSERT INTO pages VALUES(?,1,'legacy text')", (identity,))
        db.execute("INSERT INTO messages(paper_id,role,content) VALUES(?,'user','古い質問')", (identity,))
        db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label) VALUES(?,1,'original','quote','引用')",
                   (identity,))
        db.execute("INSERT INTO collections VALUES('研究')")
        if stage == "middle":
            db.execute("UPDATE papers SET tags=?, read_status='積読' WHERE id=?",
                       (json.dumps(["古いタグ"], ensure_ascii=False), identity))
    return identity


def legacy_backup(root: Path, destination: Path) -> None:
    """Zip a library folder the way create_backup did before schema versioning."""
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(root / "library.sqlite3", "library.sqlite3")
        archive.writestr("papeer-backup.json", json.dumps({"version": 1}))
        for path in root.rglob("*"):
            if path.is_file() and not path.name.startswith("library.sqlite3"):
                archive.write(path, path.relative_to(root).as_posix())


# Columns that schema versions after the baseline add (storage.MIGRATIONS[1:]), by table. A database
# saved before schema versioning never had them; add a later step's columns here (test_schema_migration
# checks that this list is complete).
LATER_COLUMNS = {"papers": ("doi", "arxiv_id", "venue")}


def mark_unversioned(db: sqlite3.Connection) -> None:
    """Make a current library database look saved before schema versioning: user_version 0, without the
    columns later versions added (a test drops the baseline's own columns it wants migrated first)."""
    for table, names in LATER_COLUMNS.items():
        for name in names:
            db.execute(f"ALTER TABLE {table} DROP COLUMN {name}")
    db.execute("PRAGMA user_version=0")
