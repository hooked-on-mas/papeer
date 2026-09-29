"""A full-text index of the library's pages and translations, kept on this PC (SQLite FTS5, trigram).

The library search (library_search.library_search) looked through every page and every translated section
of every paper for each query: over a second for a few hundred papers whenever little or nothing matched,
as while a word is being typed. The index tells it which papers may contain a term and how often, and
finds the places in one paper without reading its files.

Where it lives: in this PC's device directory (paths.search_index_path), not in the library database. It
holds the texts again, with their trigrams, and each change to it would change the database that
drive_sync hashes (iterdump) and uploads whole with every revision; most of what it covers, the
translations, are files rather than rows anyway. Kept apart, it is never backed up, synced or migrated (no
schema version, so PCs updating Papeer publish nothing new for it): each PC builds its own from what it
has, and a PC that took in another's library brings its index up to date on the next search.

What it covers: each page's extracted text (the library's pages table, written when the PDF is added and
again when pages are read by OCR)
and each section of translation.md (the last completed translation, which a translation, a published
review or a sync replaces). Metadata and memos are few and short, and a memo changes with every autosave,
so the search reads those from the papers table itself. Texts are stored casefolded, as the search compares
them (str.casefold, whose full folding FTS5 lacks: "ﬁ" in a PDF's text is "fi").

How it is looked up: trigrams (FTS5's trigram tokenizer) find the rows containing every trigram of a term
of TRIGRAM characters or more, in any language and without word boundaries, which a Japanese text lacks
(unicode61 would take a whole run of kana and kanji for one word). They are stored without positions
(detail='none'), half the size: rows holding the trigrams apart are found too, and bm25 would read every
text found, so the search ranks papers by how many places contain the term. The places themselves, and
any term shorter than a trigram ("推定" has two characters), are found in the stored texts of one paper
at a time (instr), which reads only that paper's rows.

How it stays current: before a search, each paper's sources are compared with the keys recorded when they
were indexed: the PDF's digest and page count for its pages (and, for a paper with pages read by OCR, the
size, time and ID of its ocr-text.json, which is written again whenever they are, also when a sync brings
it from another PC), translation.md's size, modification time and file ID for its translation. A new or changed paper is indexed again and a removed one dropped: one query
and one file status per paper. Indexing a whole library (the first search after updating Papeer, or after
this PC's index was lost: some 60 papers a second) takes longer, so a search spends at most BUILD_SECONDS
on it and looks through the papers still left over directly, as before; the following searches go on
from there. The request is counted like any other (sidecar deps), so a sync, backup or restore waits for
it; indexing in the background would hold library files open while a restore replaces the folder.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Iterator
import unicodedata

from papeer.core.paths import parse_translation_sections, search_index_path
from papeer.core.storage import Library

# Change when what is indexed or how changes: an index of another format is emptied and built again.
INDEX_FORMAT = 1
# How long one search may spend indexing before it looks through the rest of the library itself.
BUILD_SECONDS = 1.0
# The shortest term the trigram index can look up.
TRIGRAM = 3
# Papers indexed in one transaction.
PAPERS_PER_COMMIT = 20
# A translation.md written this shortly before it was read is indexed but not recorded, so it is read again
# next time: a second write within the same clock tick could leave its key unchanged (as drive_sync.RACY_NS).
RACY_NS = 2 * 10**9
_now_ns = time.time_ns  # Replaced in tests.
_monotonic = time.monotonic  # The clock BUILD_SECONDS is measured by (replaced in tests).

PAPER_ID = re.compile(r"[0-9a-f]{32}")
# The key of a translation.md that is not there (or of a paper whose ID names no folder).
NO_FILE = "none"

# An index is written by one thread at a time; SQLite keeps other processes apart.
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_LOCK = threading.Lock()


def _lock(path: Path) -> threading.Lock:
    with _LOCKS_LOCK:
        return _LOCKS.setdefault(str(path), threading.Lock())


def trigram_query(term: str) -> str:
    """An FTS5 query for the rows containing every trigram of `term` (TRIGRAM characters or more).

    Each trigram is a quoted string of its own: detail='none' has no positions to match a phrase with.
    """
    grams = dict.fromkeys(term[i:i + TRIGRAM] for i in range(len(term) - TRIGRAM + 1))
    return " AND ".join('"' + gram.replace('"', '""') + '"' for gram in grams)


class SearchIndex:
    """The index of the library at `root`; see the module's description."""

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.path = search_index_path(self.root)

    def refresh(self, lib: Library, seconds: float | None = None) -> set[str]:
        """Bring the index up to date, spending at most about `seconds` on indexing (None: no limit;
        a search gives BUILD_SECONDS).

        Returns the papers still out of date, which a search must look through itself.
        """
        deadline = None if seconds is None else _monotonic() + seconds
        _remove_orphans(self.path)
        with _lock(self.path), closing(self._open()) as db, lib.connection() as library:
            papers = {row[0]: f"{row[1]}:{row[2]}" for row in library.execute("SELECT id,sha256,pages FROM papers")}
            recorded = {(row[0], row[1]): row[2] for row in db.execute("SELECT paper_id,side,key FROM sources")}
            removed = {paper for paper, _ in recorded} - papers.keys()
            if removed:
                with _transaction(db):
                    for paper_id in removed:
                        _drop(db, paper_id)
            stale = []
            folder = str(self.root / "papers")  # Strings: pathlib would take longer than the file status itself.
            for paper_id, pages_key in papers.items():
                translation = os.path.join(folder, paper_id, "translation.md") if PAPER_ID.fullmatch(paper_id) else None
                readings = _file_key(os.path.join(folder, paper_id, "ocr-text.json") if translation else None)
                if readings != NO_FILE:  # Papers never read by OCR keep the key they were indexed with.
                    pages_key += ":ocr:" + readings
                pages_stale = recorded.get((paper_id, "original")) != pages_key
                translation_stale = recorded.get((paper_id, "translated")) != _file_key(translation)
                if pages_stale or translation_stale:
                    stale.append((paper_id, pages_key if pages_stale else None, translation_stale, translation))
            # Several papers a transaction: each commit writes a segment of the index, which merges later.
            for start in range(0, len(stale), PAPERS_PER_COMMIT):
                if deadline is not None and _monotonic() > deadline:
                    return {paper_id for paper_id, *_ in stale[start:]}
                with _transaction(db):
                    for paper_id, pages_key, translation_stale, translation in stale[start:start + PAPERS_PER_COMMIT]:
                        if pages_key is not None:
                            _drop(db, paper_id, "original")
                            for number, text in library.execute(
                                    "SELECT number,text FROM pages WHERE paper_id=? ORDER BY number", (paper_id,)):
                                _add(db, paper_id, "original", number, 0, text)
                            _record(db, paper_id, "original", pages_key)
                        if translation_stale:
                            _drop(db, paper_id, "translated")
                            key, sections = _read_translation(translation)
                            for index, (page, _block, text) in enumerate(sections):
                                _add(db, paper_id, "translated", page, index, text)
                            _record(db, paper_id, "translated", key)
        return set()

    @contextmanager
    def reader(self) -> Iterator[IndexReader]:
        with _lock(self.path):
            db = self._open()
        with closing(db):
            yield IndexReader(db)

    def forget_pages(self, paper_id: str) -> None:
        """Index a paper's pages again at the next search: their text has changed (read again by OCR).

        The pages' key names ocr-text.json, which the reading writes before the page texts: a search in
        between could record the new key with the old texts, so the record is dropped once both are written.
        """
        if not self.path.exists():
            return
        with _lock(self.path):
            try:
                with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
                    db.execute("DELETE FROM sources WHERE paper_id=? AND side='original'", (paper_id,))
            except sqlite3.Error:
                pass  # Missing tables or a damaged index: it is made again by the next search anyway.

    def discard(self) -> None:
        """Remove a damaged index (corrupt(): what a search found), to be built again by the next search.

        A file another connection still holds open (Windows) stays until a later search finds it damaged again.
        """
        with _lock(self.path):
            _remove_files(self.path)

    def _open(self) -> sqlite3.Connection:
        """A connection to the index, made or emptied first when it is missing, of another format or damaged."""
        try:
            return self._connect()
        except sqlite3.DatabaseError as exc:
            # Only a damaged file (a torn write, a disk error): it holds nothing that cannot be built again. One
            # that is locked, read-only or on a full disk (OperationalError) is left as it is.
            if not corrupt(exc):
                raise
            _remove_files(self.path)
            return self._connect()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            # Losing the last commits to a power cut only means indexing those papers again.
            db.execute("PRAGMA synchronous=NORMAL")
            # casefold follows the Unicode version of the Python running Papeer.
            expected = {"format": str(INDEX_FORMAT), "root": str(self.root), "unicode": unicodedata.unidata_version}
            info = (dict(db.execute("SELECT name,value FROM info").fetchall())
                    if db.execute("SELECT 1 FROM sqlite_master WHERE name='info'").fetchone() else {})
            if info != expected:
                with _transaction(db):
                    for table in ("texts", "entries", "sources", "info"):
                        db.execute(f"DROP TABLE IF EXISTS {table}")
                    db.execute("CREATE TABLE info (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
                    # The key each source (a paper's pages, its translation.md) had when it was indexed.
                    db.execute("CREATE TABLE sources (paper_id TEXT NOT NULL, side TEXT NOT NULL, key TEXT NOT NULL,"
                               " PRIMARY KEY(paper_id, side))")
                    # Where each indexed text comes from; texts holds it under the same rowid.
                    db.execute("CREATE TABLE entries (id INTEGER PRIMARY KEY, paper_id TEXT NOT NULL, side TEXT NOT NULL,"
                               " page INTEGER NOT NULL, section INTEGER NOT NULL)")
                    db.execute("CREATE INDEX entries_source ON entries(paper_id, side)")
                    db.execute("CREATE VIRTUAL TABLE texts USING fts5(body, tokenize='trigram', detail='none')")
                    db.executemany("INSERT INTO info VALUES(?,?)", expected.items())
        except BaseException:
            db.close()
            raise
        return db


class IndexReader:
    """Lookups in an open index (SearchIndex.reader). Terms must be casefolded, as the stored texts are."""

    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def counts(self, term: str) -> dict[str, int]:
        """How many pages and sections of each paper contain every trigram of `term` (TRIGRAM characters
        or more): a paper not listed has none containing the term."""
        return dict(self.db.execute(
            "SELECT e.paper_id,count(*) FROM texts JOIN entries e ON e.id=texts.rowid WHERE texts MATCH ?"
            " GROUP BY e.paper_id", (trigram_query(term),)).fetchall())

    def places(self, term: str, paper_id: str) -> list[tuple[str, int, int]]:
        """(side, page, section) of each page ("original") and section of translation.md ("translated") of one
        paper whose text contains `term`; section is the place among PaperFiles.translation_sections()."""
        # CROSS JOIN keeps the paper's entries outside: the texts are then read by rowid, one paper's only.
        return self.db.execute(
            "SELECT e.side,e.page,e.section FROM entries e CROSS JOIN texts ON texts.rowid=e.id"
            " WHERE e.paper_id=? AND instr(texts.body,?)>0", (paper_id, term)).fetchall()


class _transaction:
    """BEGIN IMMEDIATE … COMMIT, rolled back on any error (the connection is in autocommit mode)."""

    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def __enter__(self) -> None:
        self.db.execute("BEGIN IMMEDIATE")

    def __exit__(self, kind, _value, _traceback) -> None:
        self.db.execute("COMMIT" if kind is None else "ROLLBACK")


def corrupt(exc: BaseException) -> bool:
    """Whether an error says a database file is damaged or is not one (SQLITE_CORRUPT, SQLITE_NOTADB and their
    extended codes, as "vtable constructor failed" for a damaged FTS5 table), rather than busy or unwritable."""
    return (isinstance(exc, sqlite3.DatabaseError)
            and (getattr(exc, "sqlite_errorname", None) or "").startswith(("SQLITE_CORRUPT", "SQLITE_NOTADB")))


def _remove_files(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        try:
            Path(str(path) + suffix).unlink(missing_ok=True)
        except OSError:
            pass  # Still open elsewhere: tried again when it is found damaged again.


# The device folders whose indexes of libraries no longer there have been looked for, once a process.
_TIDIED: set[str] = set()


def _remove_orphans(current: Path) -> None:
    """Remove this PC's indexes of libraries that are no longer where they were (a data folder moved or deleted).

    Each index names its library (info's root); an index whose library has no database there is removed. A
    library on a drive not connected now loses its index too, which its next search builds again.
    """
    folder = current.parent
    with _LOCKS_LOCK:
        if str(folder) in _TIDIED:
            return
        _TIDIED.add(str(folder))
    for path in folder.glob("*.search.sqlite3"):
        if path == current:
            continue
        try:
            with closing(sqlite3.connect(path, timeout=1)) as db:
                row = db.execute("SELECT value FROM info WHERE name='root'").fetchone()
        except sqlite3.Error:
            continue  # In use by another Papeer, or not readable: left alone.
        if row and not (Path(row[0]) / "library.sqlite3").exists():
            with _lock(path):
                _remove_files(path)


def _file_key(path: str | None) -> str:
    """translation.md's size, modification time and file ID; NO_FILE when it is not there."""
    if path is None:
        return NO_FILE
    try:
        return _stat_key(os.stat(path))
    except FileNotFoundError:
        return NO_FILE


def _stat_key(stat: os.stat_result) -> str:
    # Without file IDs (st_ino 0) the size and the time in nanoseconds still tell a replaced file apart.
    return f"{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ino}"


def _read_translation(path: str | None) -> tuple[str, list[tuple[int, str, str]]]:
    """translation.md's key and sections, read as PaperFiles.translation_sections reads them.

    The key comes from the open file, so it describes the contents read even if the file is replaced
    meanwhile; it is left empty (no file's key) for a file written just now (RACY_NS).
    """
    if path is None:
        return NO_FILE, []
    try:
        with open(path, encoding="utf-8") as stream:
            stat = os.fstat(stream.fileno())
            text = stream.read()
    except FileNotFoundError:
        return NO_FILE, []
    return _stat_key(stat) if abs(stat.st_mtime_ns - _now_ns()) > RACY_NS else "", parse_translation_sections(text)


def _add(db: sqlite3.Connection, paper_id: str, side: str, page: int, section: int, text: str) -> None:
    if not text.strip():
        return
    entry = db.execute("INSERT INTO entries(paper_id,side,page,section) VALUES(?,?,?,?)", (paper_id, side, page, section))
    db.execute("INSERT INTO texts(rowid,body) VALUES(?,?)", (entry.lastrowid, text.casefold()))


def _record(db: sqlite3.Connection, paper_id: str, side: str, key: str) -> None:
    db.execute("INSERT OR REPLACE INTO sources(paper_id,side,key) VALUES(?,?,?)", (paper_id, side, key))


def _drop(db: sqlite3.Connection, paper_id: str, side: str | None = None) -> None:
    """Remove what is indexed of one paper: one side of it, or all of it."""
    where, values = ("paper_id=? AND side=?", (paper_id, side)) if side else ("paper_id=?", (paper_id,))
    db.execute(f"DELETE FROM texts WHERE rowid IN (SELECT id FROM entries WHERE {where})", values)
    db.execute(f"DELETE FROM entries WHERE {where}", values)
    db.execute(f"DELETE FROM sources WHERE {where}", values)
