from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import threading

from papeer.core.paths import sync_state_path
# The folder path rules and the migration steps live in their own modules; they are imported here under
# the same names (private ones included: tests name storage._status_codes and look it up in MIGRATIONS).
from papeer.core.collection_paths import collection_ancestors as collection_ancestors
from papeer.core.collection_paths import in_collection as in_collection
from papeer.core.collection_paths import normalize_collection_name as normalize_collection_name
from papeer.core.library_schema import _baseline, _bibliographic_ids, _highlights, _paper_titles, _status_codes, _web_research
# The methods of Library, one mixin per group (see Library). Names other modules take from here stay here.
from papeer.core.library_annotations import Annotations
from papeer.core.library_annotations import HIGHLIGHT_COLORS as HIGHLIGHT_COLORS
from papeer.core.library_annotations import MAX_HIGHLIGHT_RECTS as MAX_HIGHLIGHT_RECTS
from papeer.core.library_annotations import _highlight_rects as _highlight_rects
from papeer.core.library_choices import Choices
from papeer.core.library_collections import Collections
from papeer.core.library_conversations import Conversations
from papeer.core.library_papers import PaperRecords
from papeer.core.library_papers import write_document as write_document


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


# Schema migrations. PRAGMA user_version counts the steps a library database has been through.
# To change the schema or convert stored values (a column, a table, an FTS index, status codes, ...),
# write a function taking (db, library root) in library_schema.py and append it to MIGRATIONS. It runs
# once, on a database at exactly the previous version, in one transaction with the other pending steps
# and the version update, so it may assume that state (no "if not exists" checks) and a failure leaves
# the database as it was.
# Use db.execute only: executescript commits, and PRAGMA foreign_keys is off and cannot change here.
# A newer database (a later Papeer, its backups or sync revisions) is refused, never migrated down.
# Changing the stored contents also changes drive_sync.fingerprint, so each PC publishes a new sync
# revision once after updating; tables needed only when used (collection_undo, global_glossary) are
# therefore still created on first use rather than here. They may be missing at any version: a later
# step that touches them must check whether they exist first (sqlite_master), unlike other tables.
# Add a test in tests/test_schema_migration.py, and list any new columns in LATER_COLUMNS in
# tests/_legacy_library.py (tests that make a current database look unversioned drop them).
MIGRATIONS = [_baseline, _highlights, _bibliographic_ids, _status_codes, _paper_titles, _web_research]
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


class Library(PaperRecords, Collections, Annotations, Choices, Conversations):
    """A library folder: its database (library.sqlite3, migrated when opened) and the papers' folders.

    The methods are grouped by what they keep, one mixin each: papers (library_papers), folders
    (library_collections), sticky notes, highlights and ink (library_annotations), choices and note
    templates (library_choices), chat messages (library_conversations); LibraryBase has the connection.
    """

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
