"""Explicit schema versions: every earlier library reaches the current one, all steps or none,
and data written by a newer Papeer (its library, backups and sync revisions) is refused."""
from tests._memos import read_memo
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import threading
import time
import traceback
import zipfile

import pytest

from _legacy_library import LATER_COLUMNS, LATER_TABLES, STAGES, legacy_backup, legacy_library, mark_unversioned
from papeer import __version__
from papeer.core import storage
from papeer.core.drive_sync import fingerprint
from papeer.core.errors import Conflict
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import SCHEMA_VERSION, Library, NewerSchemaError, database_version
from papeer.core.translation_status import LEGACY_LABELS, TranslationStatus

SAMPLE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"


def columns(root: Path) -> dict[str, set[str]]:
    with closing(sqlite3.connect(root / "library.sqlite3")) as db:
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        return {table: {row[1] for row in db.execute(f"PRAGMA table_info({table})")} for table in tables}


def dump(root: Path) -> list[str]:
    with closing(sqlite3.connect(root / "library.sqlite3")) as db:
        return list(db.iterdump())


def set_version(root: Path, version: int) -> None:
    with closing(sqlite3.connect(root / "library.sqlite3")) as db:
        if version < 9:
            for table in ('note_state', 'note_legacy', 'note_operations'):
                db.execute('DROP TABLE IF EXISTS ' + table)
            if 'note_position' in {row[1] for row in db.execute('PRAGMA table_info(papers)')}:
                db.execute('ALTER TABLE papers DROP COLUMN note_position')
        if version < 8:
            # Version 8 (storage._notebook_items): items of other kinds, what they hold, and links.
            db.execute("DROP TABLE IF EXISTS item_links")
            db.execute("DROP TABLE IF EXISTS attachments")
            db.execute("DROP INDEX IF EXISTS papers_parent")
            for column in ("parent_id", "kind"):
                if column in {row[1] for row in db.execute("PRAGMA table_info(papers)")}:
                    db.execute(f"ALTER TABLE papers DROP COLUMN {column}")
        if version < 7:
            db.execute("DROP TABLE IF EXISTS paper_discovery")
        if version < 6:
            if "research" in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
                db.execute("ALTER TABLE messages DROP COLUMN research")
            db.execute("DROP TABLE IF EXISTS reference_research")
        db.execute(f"PRAGMA user_version={version:d}")
        db.commit()


def test_new_library_starts_at_the_current_version(tmp_path):
    lib = Library(tmp_path / "library")
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    with lib.connection() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


@pytest.mark.parametrize("manual", [False, True])
def test_cached_layout_titles_upgrade_existing_papers_and_keep_manual_edits(tmp_path, manual):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    cache = lib.folder(identity) / "document.json"
    document = json.loads(cache.read_text("utf-8"))
    extracted = document.pop("extracted_title")
    document["title"] = "sample"
    cache.write_text(json.dumps(document), "utf-8")
    lib.update(identity, title="My own title" if manual else "sample")
    step = storage.MIGRATIONS.index(storage._paper_titles)
    set_version(lib.root, step)
    lib = Library(lib.root)
    assert lib.paper(identity)["title"] == ("My own title" if manual else extracted)
    before = dump(lib.root)
    Library(lib.root)
    assert dump(lib.root) == before


@pytest.mark.parametrize("cache", [None, "{broken", "null", '{"title":"sample","blocks":[null]}'])
def test_title_upgrade_tolerates_missing_or_unreadable_layouts(tmp_path, cache):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    lib.update(identity, title="sample")
    path = lib.folder(identity) / "document.json"
    if cache is None:
        path.unlink()
    else:
        path.write_text(cache, "utf-8")
    set_version(lib.root, storage.MIGRATIONS.index(storage._paper_titles))
    assert Library(lib.root).paper(identity)["title"] == "sample"


@pytest.mark.parametrize("stage", sorted(STAGES))
def test_libraries_from_before_versioning_reach_the_current_schema(tmp_path, stage):
    expected = columns(Library(tmp_path / "fresh").root)
    root = tmp_path / "legacy"
    identity = legacy_library(root, stage)
    lib = Library(root)
    assert database_version(root / "library.sqlite3") == SCHEMA_VERSION
    assert columns(root) == expected
    paper = lib.paper(identity)
    assert (paper["title"], read_memo(lib, identity), paper["bibliography_version"]) == ("Legacy paper", "古いメモ", 1)
    assert lib.messages(identity) == [{"role": "user", "content": "古い質問"}]
    assert lib.bookmarks(identity)[0]["quote"] == "quote"
    assert (lib.bookmarks(identity)[0]["anchor_x"], lib.bookmarks(identity)[0]["anchor_y"]) == (0, 0)
    assert "引用" in lib.tag_choices("sticky")
    # The label stored then is a code now.
    assert paper["status"] == {"oldest": "not_translated", "middle": "partial"}[stage]
    if stage == "middle":
        # The user's own choices and values are kept, not replaced by the defaults.
        assert lib.reading_statuses() == ["未読", "積読"]
        assert (paper["tags"], paper["read_status"]) == (["古いタグ"], "積読")
        assert lib.tag_choices("paper") == ["古いタグ"]
    else:
        assert lib.reading_statuses() == ["未読", "読書中", "読了", "再読したい"]
    # Idempotent: reopening, or migrating again explicitly, changes nothing.
    before = dump(root)
    Library(root)
    storage.migrate_database(root)
    assert dump(root) == before


def at_first_version(monkeypatch) -> None:
    """Libraries opened from here on stop at version 1 (the baseline), as the first versioned Papeer made them."""
    monkeypatch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:1])
    monkeypatch.setattr(storage, "SCHEMA_VERSION", 1)


def test_last_library_before_versioning_upgrades_without_changing_its_contents(tmp_path, monkeypatch):
    # Such a library already has every table and column of the baseline; only the version number is new.
    # Its sync fingerprint must not change, or every PC would publish a revision after updating.
    # (A later step that changes the schema does change it, once: see the comment above MIGRATIONS.)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    lib.create_collection("A / B")
    lib.delete_collection("A", undo_token="undo")
    with lib.connection() as db:
        db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,anchor_x) VALUES(?,1,'original','quote',.5)", (identity,))
        mark_unversioned(db)
    before = fingerprint(lib.root)
    at_first_version(monkeypatch)
    Library(lib.root)
    assert database_version(lib.root / "library.sqlite3") == 1
    assert fingerprint(lib.root) == before


def test_later_columns_lists_what_the_steps_after_the_baseline_add(tmp_path, monkeypatch):
    # Tests that make a current database look unversioned drop these (_legacy_library.mark_unversioned).
    latest = columns(Library(tmp_path / "latest").root)
    at_first_version(monkeypatch)
    first = columns(Library(tmp_path / "first").root)
    added = {table: names - first.get(table, set()) for table, names in latest.items()}
    expected = {table: set(names) for table, names in LATER_COLUMNS.items()}
    expected.update(LATER_TABLES)
    assert {table: names for table, names in added.items() if names} == expected


def test_a_library_before_notebooks_gets_kinds_and_empty_relations(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    lib.update(identity, collection_name="研究")
    with lib.connection() as db:
        db.execute("UPDATE papers SET note=? WHERE id=?", ("読書メモ", identity))
    set_version(lib.root, storage.MIGRATIONS.index(storage._notebook_items))
    assert not {"kind", "parent_id"} & columns(lib.root)["papers"]
    assert {"attachments", "item_links"}.isdisjoint(columns(lib.root))
    reopened = Library(lib.root)
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    assert columns(lib.root) == columns(Library(tmp_path / "fresh").root)
    # Every row that was there is a PDF paper that stands on its own, listed as before.
    paper = reopened.paper(identity)
    assert (paper["kind"], paper["parent_id"], read_memo(reopened, identity), paper["collection_name"]) == ("pdf", None, "読書メモ", "研究")
    assert [row["id"] for row in reopened.papers()] == [row["id"] for row in reopened.items()] == [identity]
    assert len(reopened.attachments(identity)) == 1 and reopened.linked_ids(identity) == []
    with reopened.connection() as db:
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    before = dump(lib.root)
    Library(lib.root)
    assert dump(lib.root) == before


def test_sticky_notes_of_the_first_version_become_notes_beside_highlights(tmp_path):
    # Made with the latest version, then taken back to the first one (the baseline, version 1).
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    with lib.connection() as db:
        db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note) VALUES(?,1,'original','quote','引用','memo')",
                   (identity,))
        mark_unversioned(db)
        db.execute("PRAGMA user_version=1")
    assert "kind" not in columns(lib.root)["bookmarks"]
    reopened = Library(lib.root)
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    assert columns(lib.root) == columns(Library(tmp_path / "fresh").root)
    [note] = reopened.bookmarks(identity)
    assert (note["kind"], note["color"], note["rects"], note["label"], note["note"]) == ("note", "", [], "引用", "memo")
    highlight = reopened.add_bookmark(identity, 1, "original", "passage", "", kind="highlight", color="green",
                                      rects=[[.1, .2, .3, .02]])
    assert [item["kind"] for item in reopened.bookmarks(identity)] == ["note", "highlight"]
    assert highlight["rects"] == [[.1, .2, .3, .02]]


def test_bibliographic_ids_of_earlier_papers_come_from_their_first_page(tmp_path):
    lib = Library(tmp_path / "library")
    found, _ = lib.import_pdf(SAMPLE_PDF)
    first_page = ("arXiv:2101.00001v2 [cs.LG] 4 Jan 2021\nPublished as a conference paper at ICLR 2021\n"
                  "Deep things\nhttps://doi.org/10.1234/abc.def.")
    with lib.connection() as db:
        db.execute("UPDATE pages SET text=? WHERE paper_id=? AND number=1", (first_page, found))
        # Another paper, with nothing to find on its first page.
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages) VALUES(?,?,?,?,1)", ("b" * 32, "x", "Plain", "b.pdf"))
        db.execute("INSERT INTO pages VALUES(?,1,'no identifiers here')", ("b" * 32,))
        mark_unversioned(db)
    lib = Library(lib.root)
    paper = lib.paper(found)
    assert (paper["doi"], paper["arxiv_id"], paper["venue"]) == ("10.1234/abc.def", "2101.00001", "ICLR 2021")
    assert [lib.paper("b" * 32)[name] for name in ("doi", "arxiv_id", "venue")] == ["", "", ""]
    # Edited by hand, they stay: the step runs once.
    lib.update(found, doi="", venue="International Conference on Learning Representations")
    storage.migrate_database(lib.root)
    paper = Library(lib.root).paper(found)
    assert (paper["doi"], paper["venue"]) == ("", "International Conference on Learning Representations")


def test_a_failed_step_leaves_the_database_as_it_was(tmp_path, monkeypatch):
    root = tmp_path / "legacy"
    identity = legacy_library(root, "oldest")
    before = dump(root)

    def broken(db, _root):
        db.execute("ALTER TABLE papers ADD COLUMN half_done TEXT")
        raise RuntimeError("migration failed")

    migrations = storage.MIGRATIONS
    monkeypatch.setattr(storage, "MIGRATIONS", [*migrations, broken])
    monkeypatch.setattr(storage, "SCHEMA_VERSION", len(migrations) + 1)
    with pytest.raises(RuntimeError):
        Library(root)
    # Neither the baseline that ran before it nor its own change was kept.
    assert database_version(root / "library.sqlite3") == 0
    assert dump(root) == before
    assert "anchor_x" not in columns(root)["bookmarks"]
    # Fixed, it runs from the start again.
    monkeypatch.setattr(storage, "MIGRATIONS", migrations)
    monkeypatch.setattr(storage, "SCHEMA_VERSION", len(migrations))
    assert Library(root).paper(identity)["bibliography_version"] == 1


def test_concurrent_first_opens_migrate_once(tmp_path, monkeypatch):
    # The sidecar opens a Library per request; the first requests after an update arrive together.
    root = tmp_path / "legacy"
    identity = legacy_library(root, "oldest")
    calls = []
    migrations = storage.MIGRATIONS

    def slow_baseline(db, root):
        calls.append(root)
        time.sleep(.2)  # Let the other threads reach the lock meanwhile.
        migrations[0](db, root)

    monkeypatch.setattr(storage, "MIGRATIONS", [slow_baseline, *migrations[1:]])
    start = threading.Barrier(8)
    errors = []

    def open_library():
        start.wait()
        try:
            assert Library(root).paper(identity)["bibliography_version"] == 1
        except BaseException:  # noqa: BLE001 - reported below, as a thread cannot fail the test
            errors.append(traceback.format_exc())  # The traceback, not only the exception: where it was raised.

    threads = [threading.Thread(target=open_library) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == [] and calls == [root]
    assert database_version(root / "library.sqlite3") == SCHEMA_VERSION


def test_memo_conversion_survives_the_old_file_vanishing_under_it(tmp_path, monkeypatch):
    # Two openers can convert the same legacy memo at once: the one that finished removes note.md after the other
    # saw it exist and before it read it. That opener must carry on, not fail with FileNotFoundError.
    root = tmp_path / "legacy"
    identity = legacy_library(root, "oldest")
    read_text = Path.read_text

    def read_after_the_other_opener_removed_it(self, *args, **kwargs):
        if self.name == "note.md":
            self.unlink(missing_ok=True)
        return read_text(self, *args, **kwargs)

    with monkeypatch.context() as patched:
        patched.setattr(Path, "read_text", read_after_the_other_opener_removed_it)
        lib = Library(root)
    assert read_memo(lib, identity) == "古いメモ"
    assert len([row for row in lib.attachments(identity) if row["format"] == "md"]) == 1
    assert not (root / "papers" / identity / "note.md").exists()


def memos(lib, identity):
    return [lib.attachment_text(row["id"]) for row in lib.attachments(identity) if row["format"] == "md"]


def test_memo_conversion_survives_another_opener_holding_the_old_file(tmp_path):
    # The mirror of the vanishing file: an opener still has note.md open when the one that finished converting
    # removes it. Windows refuses that delete (WinError 32); the memo is already committed, so the open must go on.
    root = tmp_path / "legacy"
    identity = legacy_library(root, "oldest")
    note = root / "papers" / identity / "note.md"
    with note.open(encoding="utf-8") as held:
        lib = Library(root)
        assert held.read() == "古いメモ"
    assert memos(lib, identity) == ["古いメモ"]
    lib = Library(root)  # What the locked delete left is removed here, and nothing is added.
    assert memos(lib, identity) == ["古いメモ"] and not note.exists()


@pytest.mark.parametrize("variant, expected", [("same", ["古いメモ"]), ("file-only", ["古いメモ"]),
                                               ("different", ["古いメモ", "別の内容"])])
def test_an_old_file_that_could_not_be_removed_is_neither_read_nor_converted_again(tmp_path, monkeypatch, variant, expected):
    root = tmp_path / "legacy"
    identity = legacy_library(root, "oldest")
    note = root / "papers" / identity / "note.md"
    if variant == "file-only":
        with closing(sqlite3.connect(root / "library.sqlite3")) as db, db:
            db.execute("UPDATE papers SET note='' WHERE id=?", (identity,))
    if variant == "different":
        note.write_text("別の内容", "utf-8")
    unlink, read_text = Path.unlink, Path.read_text

    def locked(self, *args, **kwargs):
        if self.name == "note.md":
            raise PermissionError(13, "The process cannot access the file because it is being used by another process")
        return unlink(self, *args, **kwargs)

    def must_not_read(self, *args, **kwargs):
        assert self.name != "note.md", "a converted memo's old file was read"
        return read_text(self, *args, **kwargs)

    with monkeypatch.context() as patched:
        patched.setattr(Path, "unlink", locked)
        lib = Library(root)
    assert sorted(memos(lib, identity)) == sorted(expected) and note.exists()
    with monkeypatch.context() as patched:
        patched.setattr(Path, "read_text", must_not_read)
        lib = Library(root)
    assert sorted(memos(lib, identity)) == sorted(expected)
    assert not note.exists()  # Removed by that open.


@pytest.mark.parametrize("variant, expected", [("same", ["移行後の編集"]), ("file-only", ["移行後の編集"]),
                                               ("different", ["移行後の編集", "別の内容"])])
def test_a_crash_between_commit_and_removing_the_old_file_does_not_convert_again(tmp_path, monkeypatch, variant, expected):
    # The process dies (power loss, kill) right after the memos are committed, before note.md is removed and before
    # Library.__init__ moves them into the notes. They are still attachments then, so the next open must recognise
    # them by their deterministic IDs: no second copy, no IntegrityError, and an edit made meanwhile survives.
    class Crash(BaseException):
        pass

    root = tmp_path / "legacy"
    identity = legacy_library(root, "oldest")
    note = root / "papers" / identity / "note.md"
    if variant == "file-only":
        with closing(sqlite3.connect(root / "library.sqlite3")) as db, db:
            db.execute("UPDATE papers SET note='' WHERE id=?", (identity,))
    if variant == "different":
        note.write_text("別の内容", "utf-8")
    unlink = Path.unlink

    def die(self, *args, **kwargs):
        if self.name == "note.md":
            raise Crash
        return unlink(self, *args, **kwargs)

    with monkeypatch.context() as patched:
        patched.setattr(Path, "unlink", die)
        with pytest.raises(Crash):
            Library(root)
    assert note.exists()
    with closing(sqlite3.connect(root / "library.sqlite3")) as db:
        rows = db.execute("SELECT id FROM attachments WHERE owner_id=? AND format='md' ORDER BY position", (identity,)).fetchall()
    assert len(rows) == len(expected)  # Committed as attachments; not yet moved into the notes.
    (root / "papers" / identity / "attachments" / (rows[0][0] + ".md")).write_text("移行後の編集", "utf-8")
    lib = Library(root)
    assert sorted(memos(lib, identity)) == sorted(expected)
    assert not note.exists()
    assert sorted(memos(Library(root), identity)) == sorted(expected)  # And a further open changes nothing.


def test_a_later_step_runs_once_on_top_of_the_current_version(tmp_path, monkeypatch):
    # How a later change (a new column, a search index, converted values) is added.
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    calls = []

    def opened_at(db, root):
        calls.append(root)
        db.execute("ALTER TABLE papers ADD COLUMN opened_at TEXT NOT NULL DEFAULT ''")
        db.execute("UPDATE papers SET opened_at='never'")

    monkeypatch.setattr(storage, "MIGRATIONS", [*storage.MIGRATIONS, opened_at])
    monkeypatch.setattr(storage, "SCHEMA_VERSION", len(storage.MIGRATIONS))
    Library(lib.root)
    Library(lib.root)
    assert calls == [lib.root]
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION + 1
    assert Library(lib.root).paper(identity)["opened_at"] == "never"


def before_status_codes(monkeypatch) -> None:
    """Libraries opened from here on stop before storage._status_codes, keeping the labels as stored."""
    step = storage.MIGRATIONS.index(storage._status_codes)
    monkeypatch.setattr(storage, "MIGRATIONS", storage.MIGRATIONS[:step])
    monkeypatch.setattr(storage, "SCHEMA_VERSION", step)


def test_translation_states_stored_as_labels_become_codes(tmp_path, monkeypatch):
    before_status_codes(monkeypatch)
    lib = Library(tmp_path / "library")
    # Each label Papeer stored, a code already written (tools/review_publish writes the database directly),
    # and a hand-edited value.
    values = [*LEGACY_LABELS, "translated", "謎の状態"]
    with lib.connection() as db:
        for number, value in enumerate(values):
            db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status) VALUES(?,?,'T','t.pdf',1,?)",
                       (f"{number:032x}", f"sha-{number}", value))
    monkeypatch.undo()
    lib = Library(lib.root)
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    assert [lib.paper(f"{number:032x}")["status"] for number in range(len(values))] == [
        "not_translated", "translating", "partial", "resumable", "incomplete", "translated",
        "translated", "not_translated"]
    assert {paper["status"] for paper in lib.papers()} <= set(TranslationStatus)


def test_a_library_from_a_newer_papeer_is_refused(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    set_version(lib.root, SCHEMA_VERSION + 1)
    before = dump(lib.root)
    with pytest.raises(NewerSchemaError, match="新しいバージョンのPapeer"):
        Library(lib.root)
    assert dump(lib.root) == before
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION + 1
    from sidecar import deps
    monkeypatch.setattr(deps, "get_data_dir", lambda: lib.root)
    with pytest.raises(Conflict) as error:
        deps.get_library()
    assert error.value.status_code == 409 and "Papeerを最新版に更新" in error.value.message


def test_backup_records_the_schema_and_app_versions(tmp_path):
    lib = Library(tmp_path / "library")
    create_backup(lib, tmp_path / "backup.zip")
    with zipfile.ZipFile(tmp_path / "backup.zip") as archive:
        manifest = json.loads(archive.read("papeer-backup.json"))
    assert manifest == {"version": 1, "schema_version": SCHEMA_VERSION, "app_version": __version__}


def newer_backup(source: Path, destination: Path, *, database: bool, manifest: bool) -> None:
    """A copy of `source` as a newer Papeer would write it (in its database, its manifest, or both)."""
    folder = destination.with_suffix("")
    with zipfile.ZipFile(source) as archive:
        archive.extractall(folder)
    if database:
        set_version(folder, SCHEMA_VERSION + 1)
    if manifest:
        (folder / "papeer-backup.json").write_text(json.dumps(
            {"version": 1, "schema_version": SCHEMA_VERSION + 1, "app_version": "9.9.9"}))
    with zipfile.ZipFile(destination, "w") as archive:
        for path in folder.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(folder).as_posix())


@pytest.mark.parametrize("database,manifest", [(True, True), (True, False), (False, True)])
def test_backup_from_a_newer_papeer_is_refused(tmp_path, database, manifest):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    create_backup(lib, tmp_path / "backup.zip")
    newer_backup(tmp_path / "backup.zip", tmp_path / "newer.zip", database=database, manifest=manifest)
    with pytest.raises(NewerSchemaError, match="新しいバージョンのPapeer.*読み込めません") as error:
        restore_backup(lib, tmp_path / "newer.zip")
    assert ("9.9.9" in str(error.value)) == manifest
    assert Library(lib.root).paper(identity)
    assert not list(tmp_path.glob("library-before-restore-*"))


def test_backup_from_before_versioning_restores_and_is_migrated(tmp_path):
    legacy = tmp_path / "legacy"
    identity = legacy_library(legacy, "oldest")
    legacy_backup(legacy, tmp_path / "old.zip")
    lib = Library(tmp_path / "library")
    restore_backup(lib, tmp_path / "old.zip")
    assert database_version(lib.root / "library.sqlite3") == 0  # Migrated when next opened.
    reopened = Library(lib.root)
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    assert reopened.paper(identity)["read_status"] == "未読"
    assert columns(lib.root) == columns(Library(tmp_path / "fresh").root)
