"""Explicit schema versions: every earlier library reaches the current one, all steps or none,
and data written by a newer Papeer (its library, backups and sync revisions) is refused."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import threading
import time
import zipfile

from fastapi import HTTPException
import pytest

from _legacy_library import LATER_COLUMNS, STAGES, legacy_backup, legacy_library
from papeer import __version__
from papeer.core import storage
from papeer.core.drive_sync import fingerprint
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
        db.execute(f"PRAGMA user_version={version:d}")


def test_new_library_starts_at_the_current_version(tmp_path):
    lib = Library(tmp_path / "library")
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    with lib.connection() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


@pytest.mark.parametrize("stage", sorted(STAGES))
def test_libraries_from_before_versioning_reach_the_current_schema(tmp_path, stage):
    expected = columns(Library(tmp_path / "fresh").root)
    root = tmp_path / "legacy"
    identity = legacy_library(root, stage)
    lib = Library(root)
    assert database_version(root / "library.sqlite3") == SCHEMA_VERSION
    assert columns(root) == expected
    paper = lib.paper(identity)
    assert (paper["title"], paper["note"], paper["bibliography_version"]) == ("Legacy paper", "古いメモ", 1)
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
    at_first_version(monkeypatch)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    with lib.connection() as db:
        db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,anchor_x) VALUES(?,1,'original','quote',.5)", (identity,))
    lib.create_collection("A / B")
    lib.delete_collection("A", undo_token="undo")
    set_version(lib.root, 0)
    before = fingerprint(lib.root)
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
    assert {table: names for table, names in added.items() if names} == expected


def test_sticky_notes_of_the_first_version_become_notes_beside_highlights(tmp_path, monkeypatch):
    at_first_version(monkeypatch)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE_PDF)
    with lib.connection() as db:
        db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note) VALUES(?,1,'original','quote','引用','memo')",
                   (identity,))
    assert "kind" not in columns(lib.root)["bookmarks"]
    monkeypatch.undo()
    reopened = Library(lib.root)
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    assert columns(lib.root) == columns(Library(tmp_path / "fresh").root)
    [note] = reopened.bookmarks(identity)
    assert (note["kind"], note["color"], note["rects"], note["label"], note["note"]) == ("note", "", [], "引用", "memo")
    highlight = reopened.add_bookmark(identity, 1, "original", "passage", "", kind="highlight", color="green",
                                      rects=[[.1, .2, .3, .02]])
    assert [item["kind"] for item in reopened.bookmarks(identity)] == ["note", "highlight"]
    assert highlight["rects"] == [[.1, .2, .3, .02]]


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
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=open_library) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == [] and calls == [root]
    assert database_version(root / "library.sqlite3") == SCHEMA_VERSION


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
    with pytest.raises(HTTPException) as error:
        deps.get_library()
    assert error.value.status_code == 409 and "Papeerを最新版に更新" in error.value.detail


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
