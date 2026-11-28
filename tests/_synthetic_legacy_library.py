"""Synthetic schema-9 legacy Library for the B6 inventory tests (DESIGN-r161-b6-p6-inventory.md 9.1).

Everything here is made from real papeer code or the real CREATE statements, inside the caller's
temporary folders; nothing reads a real profile. Typical use:

    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()                  # raw backup of the three sources
    report, sources, notebooks = run_inventory(captured)

`Synthetic.expected` is counted straight from SQLite and notebook.json (never through the
inventory), so a test can compare the inventory with an independent count.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from dataclasses import dataclass, field
import gc
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import uuid
from typing import Any

import pymupdf
import pytest

from papeer.core import notebook, notes, paths, terminology
from papeer.core.edit_repository import initialize_edit_schema
from papeer.core.edit_storage import canonical_edit_connection, edit_storage_root
from papeer.core.migrations import legacy_backup, legacy_inventory
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.storage import Library

# Marker strings that must never appear in a report (row contents).
SENTINELS = ('SENTINEL-MESSAGE-CONTENT', 'SENTINEL-PAGE-TEXT', 'SENTINEL-QUOTE', 'SENTINEL-NOTE', 'SENTINEL-LABEL',
             'SENTINEL-MEMO-BODY')
# Real CREATE statements of the optional tables (terminology.py global_glossary, library_collections.py collection_undo; the three more below).
OPTIONAL_TABLE_SQL = {
    'global_glossary': 'CREATE TABLE IF NOT EXISTS global_glossary (id INTEGER PRIMARY KEY CHECK(id=1), terms TEXT NOT NULL)',
    'collection_undo': 'CREATE TABLE IF NOT EXISTS collection_undo (token TEXT PRIMARY KEY, snapshot TEXT NOT NULL)'}
# The three tables of B7-a. terminology.py creates the first two inside functions that also write a row (the `glossary_tables`
# variant calls those functions); cloud_annotations.import_operations creates the third inline. The statements are copied from
# there, and the test W-4 compares each with the table the product function / the product source really produces, so a change
# of the product's statement fails that test.
OPTIONAL_TABLE_SQL.update({
    'paper_glossary': 'CREATE TABLE IF NOT EXISTS paper_glossary (paper_id TEXT PRIMARY KEY, terms TEXT NOT NULL, dismissed TEXT NOT NULL, scope TEXT)',
    'paper_glossary_domains': ("CREATE TABLE IF NOT EXISTS paper_glossary_domains (paper_id TEXT PRIMARY KEY, domains TEXT NOT NULL, "
                               "new_domain TEXT, chosen_by TEXT NOT NULL CHECK(chosen_by IN ('ai','user')), known_domains TEXT NOT NULL)"),
    'web_annotation_ops': 'CREATE TABLE IF NOT EXISTS web_annotation_ops (id TEXT PRIMARY KEY, operation TEXT NOT NULL)'})
# The `rects` text of a highlight exactly as library_annotations.py writes it (floats through json.dumps, compact separators).
HIGHLIGHT_RECTS = json.dumps([[.2, .3, .25, .025], [.1, .35, .4, .03]], separators=(',', ':'))


def _strokes(count: int, prefix: str) -> str:
    return json.dumps([{'id': f'{prefix}-{index}', 'color': '#000000', 'width': .01, 'points': [[.1, .2], [.3, .4]]}
                       for index in range(count)])


def tree_hashes(root: Path) -> dict[str, str | None]:
    """Relative path -> sha256 of every file (None for a directory) under root; {} when root is missing."""
    if not root.exists():
        return {}
    return {path.relative_to(root).as_posix(): (hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
            for path in sorted(root.rglob('*'))}


def settle(path: Path, *, mode: str = 'DELETE') -> None:
    """Fold a database's WAL into the main file and leave it without -wal/-shm companions."""
    gc.collect()
    with closing(sqlite3.connect(path)) as db:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        db.execute(f'PRAGMA journal_mode={mode}')
    gc.collect()


def direct_counts(root: Path, ids: dict[str, str]) -> dict[str, Any]:
    """Counts read straight from SQLite and notebook.json, without the inventory."""
    result: dict[str, Any] = {'tables': {}, 'notebooks': {}}
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
            result['tables'][name] = db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
        for key in ('A', 'B'):
            identifier = ids[key]
            try:
                document = json.loads((root / 'papers' / identifier / 'notebook.json').read_text('utf-8'))
            except (OSError, ValueError):
                continue     # a test damaged this notebook on purpose
            ink = [(side, page, len(json.loads(strokes))) for side, page, strokes in
                   db.execute('SELECT side, page, strokes FROM pdf_ink WHERE paper_id = ? ORDER BY side, page', (identifier,))]
            marks = [(page, kind) for page, kind in
                     db.execute('SELECT page, kind FROM bookmarks WHERE paper_id = ? ORDER BY id', (identifier,))]
            result['notebooks'][identifier] = {
                'revision': document['revision'], 'pageIds': [page['id'] for page in document['pages']],
                'pages': db.execute('SELECT count(*) FROM pages WHERE paper_id = ?', (identifier,)).fetchone()[0],
                'ink': ink, 'inkRows': len(ink), 'strokes': sum(item[2] for item in ink), 'bookmarkRows': len(marks),
                'notes': sum(1 for _page, kind in marks if kind == 'note'),
                'highlights': sum(1 for _page, kind in marks if kind == 'highlight'), 'marks': marks}
    return result


@dataclass
class Capture:
    backup: Any
    plan: dict
    manifest: dict


@dataclass
class Synthetic:
    root: Path
    device: Path
    library_key: str
    ids: dict[str, str]
    wal_connection: sqlite3.Connection | None = None
    expected: dict[str, Any] = field(default_factory=dict)

    @property
    def canonical_root(self) -> Path:
        return edit_storage_root(self.root)

    def sql(self, *statements: str | tuple) -> None:
        """Change the library database (a test's mutation), then leave it settled unless it is the WAL variant."""
        connection = self.wal_connection or sqlite3.connect(self.root / 'library.sqlite3')
        try:
            for statement in statements:
                connection.execute(*([statement] if isinstance(statement, str) else statement))
            connection.commit()
        finally:
            if self.wal_connection is None:
                connection.close()
        if self.wal_connection is None:
            settle(self.root / 'library.sqlite3')

    def canonical_sql(self, *statements: str | tuple) -> None:
        with closing(sqlite3.connect(self.canonical_root / 'content.sqlite3')) as db:
            for statement in statements:
                db.execute(*([statement] if isinstance(statement, str) else statement))
            db.commit()
        settle(self.canonical_root / 'content.sqlite3')

    def tree_hashes(self) -> dict[str, dict[str, str | None]]:
        return {'library': tree_hashes(self.root), 'canonical': tree_hashes(self.canonical_root), 'device': tree_hashes(self.device)}

    def backups(self) -> dict[str, Any]:
        return {'desktop-library': NativeLegacyBackup(self.root),
                'canonical': NativeLegacyBackup(self.canonical_root, allow_missing=True),
                'device': NativeLegacyHeldDeviceBackup(self.root, device_root=self.device)}

    def capture(self, *, refresh_expected: bool = True) -> dict[str, Capture]:
        """Raw, verified backup of the three sources; the WAL variant's open connection is closed afterwards.

        refresh_expected=False skips the direct SQLite count: a test that plants a stray -wal or a journal
        must not let that count's connection touch them first.
        """
        if refresh_expected:
            self.expected = {'ids': dict(self.ids), **direct_counts(self.root, self.ids)}
        result: dict[str, Capture] = {}
        try:
            for kind, backup in self.backups().items():
                plan = backup.inventory(str(uuid.uuid4()))
                result[kind] = Capture(backup, plan, backup.capture(plan))
        finally:
            self.close()
        return result

    def close(self) -> None:
        if self.wal_connection is not None:
            self.wal_connection.close()
            self.wal_connection = None
            gc.collect()


def build_synthetic_library(root: Path, *, device: Path | None = None, wal: bool = False, notebook_journal: bool = False,
                            note_import: bool = True, optional_tables: tuple[str, ...] = (),
                            canonical_pending: bool = False, folder_sync_state: bool = False,
                            wal_closed: bool = False, glossary_tables: bool = False, large_pdf: int = 0) -> Synthetic:
    """The B6 main fixture (see DESIGN-r161-b6-p6-inventory.md 9.1) and, for B7-a, two variants.

    wal_closed       the Library database is left the way the product leaves it after the app exits: journal mode WAL
                     (storage.py sets it; header bytes 18/19 are 2) and neither -wal nor -shm, because the last connection
                     closed normally. The main fixture instead converts the database to DELETE mode before capture.
    glossary_tables  the three tables product code creates on use (paper_glossary, paper_glossary_domains through the
                     terminology.py functions that create them; web_annotation_ops with the statement cloud_annotations.py
                     runs) with a row each, and a legacy papers/<id>/glossary.json (terminology.py still reads it).
    large_pdf        the PDF item P is padded to about this many bytes (written and hashed in 1 MiB blocks, never held in
                     memory): a Library far over the preview's 256 MiB bound, to show the conversion input reads it (B7-b).
                     The padding is comment lines after %%EOF, so papers.sha256 and the backup entry still describe the file.
    """
    if wal and wal_closed:
        raise ValueError('wal and wal_closed are different variants')
    root = Path(root)
    device = Path(device) if device is not None else root.parent / 'device'
    root.parent.mkdir(parents=True, exist_ok=True)
    device.mkdir(parents=True, exist_ok=True)
    library = Library(root)
    ids: dict[str, str] = {}
    # Notebook A: 2 pages; ink on page 2 (2 strokes); a note on page 1 and a highlight on page 2.
    ids['A'] = notebook.create(library, 'Synthetic notebook A', {})
    notebook.change(library, ids['A'], 1, 'append')
    # Notebook B: 3 pages; ink on page 1 (1 stroke) and page 3 (2 strokes); two notes on page 2; in a folder.
    ids['B'] = notebook.create(library, 'Synthetic notebook B', {})
    notebook.change(library, ids['B'], 1, 'append')
    notebook.change(library, ids['B'], 2, 'append')
    notebook.move(library, ids['B'], None, 'Folder/Sub')
    # Markdown note M.
    ids['M'] = notes.create(library, 'Synthetic memo', kind='markdown', content='# memo\nSENTINEL-MEMO-BODY')['id']
    # PDF P: a real one-page PDF, inserted the way a PDF row looks (kind='pdf').
    ids['P'] = uuid.uuid4().hex
    with pymupdf.open() as document:
        document.new_page()
        pdf_bytes = document.tobytes()
    folder = root / 'papers' / ids['P']
    folder.mkdir(parents=True)
    pdf_sha = hashlib.sha256(pdf_bytes)
    with (folder / 'original.pdf').open('wb') as stream:
        stream.write(pdf_bytes)
        block, remaining = (b'%' + b'p' * 1022 + b'\n') * 1024, large_pdf
        while remaining > 0:
            part = block[:min(remaining, len(block))]
            stream.write(part)
            pdf_sha.update(part)
            remaining -= len(part)
    (folder / 'document.json').write_text('{"synthetic": true}', 'utf-8')
    (folder / 'translation.md').write_text('## p.1 / b1\nsynthetic translation\n', 'utf-8')
    (folder / 'article.md').write_text('synthetic summary\n', 'utf-8')
    (folder / 'media').mkdir()
    (folder / 'media' / 'figure.png').write_bytes(b'\x89PNG synthetic')
    (folder / 'translation-pages').mkdir()
    (folder / 'translation-pages' / '1.json').write_text('{}', 'utf-8')
    a, b, p = ids['A'], ids['B'], ids['P']
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        a_pages = [row[0] for row in db.execute('SELECT number FROM pages WHERE paper_id = ?', (a,))]
        assert a_pages == [1, 2]
        db.execute("UPDATE pages SET text = 'SENTINEL-PAGE-TEXT' WHERE paper_id = ? AND number = 2", (a,))
        db.execute("INSERT INTO pdf_ink VALUES(?, 'original', 2, ?)", (a, _strokes(2, 'a')))
        mark = ("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
                " VALUES(?,?,'original',?,?,?,.2,.3,?,?,?)")
        db.execute(mark, (a, 1, 'SENTINEL-QUOTE', 'SENTINEL-LABEL', 'SENTINEL-NOTE', 'note', '', '[]'))
        db.execute(mark, (a, 2, 'SENTINEL-QUOTE', '', '', 'highlight', 'yellow', HIGHLIGHT_RECTS))
        db.execute("INSERT INTO pdf_ink VALUES(?, 'original', 1, ?)", (b, _strokes(1, 'b1')))
        db.execute("INSERT INTO pdf_ink VALUES(?, 'original', 3, ?)", (b, _strokes(2, 'b3')))
        for _ in range(2):
            db.execute(mark, (b, 2, 'SENTINEL-QUOTE', 'SENTINEL-LABEL', 'SENTINEL-NOTE', 'note', '', '[]'))
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,kind)"
                   " VALUES(?,?,?,?,1,'not_translated','Folder','pdf')",
                   (p, pdf_sha.hexdigest(), 'Synthetic PDF', 'synthetic.pdf'))
        db.execute("INSERT INTO pages VALUES(?, 1, 'SENTINEL-PAGE-TEXT')", (p,))
        db.execute("INSERT INTO pdf_ink VALUES(?, 'original', 1, ?)", (p, _strokes(1, 'p')))
        db.execute(mark, (p, 1, 'SENTINEL-QUOTE', 'SENTINEL-LABEL', 'SENTINEL-NOTE', 'note', '', '[]'))
        db.executemany('INSERT INTO collections(name) VALUES(?)', [('Folder',), ('Folder / Sub',)])
        low, high = sorted((p, a))
        db.execute('INSERT INTO item_links VALUES(?, ?)', (low, high))
        for role, content in (('user', 'SENTINEL-MESSAGE-CONTENT question'), ('assistant', 'SENTINEL-MESSAGE-CONTENT answer')):
            db.execute("INSERT INTO messages(paper_id,role,content,scope) VALUES(?,?,?,'paper')", (p, role, content))
        for name in optional_tables:
            db.execute(OPTIONAL_TABLE_SQL[name])
        db.commit()
    if glossary_tables:
        terminology.save_paper_domains(root, a, ['共通'], None, 'user', ['共通'])
        terminology.save_paper_glossary(root, a, [{'source': 'synthetic', 'target': 'synthetic target'}], [],
                                        {'terms': [], 'dismissed': []})     # paper_glossary: the table and its default row exist after _ensure
        with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
            db.execute(OPTIONAL_TABLE_SQL['web_annotation_ops'])
            db.execute('INSERT INTO web_annotation_ops VALUES(?, ?)', ('synthetic-operation', json.dumps({'id': 'synthetic-operation'})))
            db.commit()
        (root / 'papers' / a / 'glossary.json').write_text(json.dumps([{'source': 'synthetic', 'target': 'legacy target'}]), 'utf-8')
    wal_connection = None
    if wal:
        wal_connection = sqlite3.connect(root / 'library.sqlite3')
        wal_connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        wal_connection.execute('PRAGMA wal_autocheckpoint=0')
        wal_connection.execute("UPDATE pages SET text = 'uncheckpointed synthetic WAL row' WHERE paper_id = ? AND number = 2", (a,))
        wal_connection.execute("INSERT INTO collections(name) VALUES('WAL only folder')")   # a row that exists only in the WAL
        wal_connection.commit()
        assert (root / 'library.sqlite3-wal').stat().st_size > 0 and (root / 'library.sqlite3-shm').is_file()
    elif wal_closed:
        settle(root / 'library.sqlite3', mode='WAL')
        assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
        assert (root / 'library.sqlite3').read_bytes()[18:20] == b''
    else:
        settle(root / 'library.sqlite3')
    # Written after the last Library() (its cloud_notes.recover would consume it) and before capture.
    if note_import:
        folder = root / '.note-imports'
        folder.mkdir(exist_ok=True)
        operation_id = uuid.uuid4()
        (folder / (operation_id.hex + '.json')).write_text(json.dumps(
            {'target': a, 'payload': {}, 'operation': {'id': str(operation_id), 'note_id': a, 'base': None}, 'bookmarks': []}), 'utf-8')
    if notebook_journal:
        (root / 'papers' / b / '.notebook-change.json').write_text(json.dumps({'marker': f'notebook:{b}:4', 'before': {}, 'after': {}}), 'utf-8')
    if canonical_pending:
        with canonical_edit_connection(root)() as db:
            initialize_edit_schema(db)
            db.execute('INSERT INTO edit_intents VALUES(?,?,?)', ('scope', 'target', '{"synthetic": true}'))
        settle(edit_storage_root(root) / 'content.sqlite3')
    key = paths.library_key(root)
    (device / 'device-settings.json').write_text('{}', 'utf-8')
    (device / (key + '.opened.json')).write_text('{}', 'utf-8')
    if folder_sync_state:
        (device / (key + '.json')).write_text('{}', 'utf-8')
        (device / (key + '.cloud-drive.json')).write_text('{}', 'utf-8')
        (device / 'history' / key).mkdir(parents=True)
        (device / 'history' / key / 'state.json').write_text('{}', 'utf-8')
    synthetic = Synthetic(root=root, device=device, library_key=key, ids=ids, wal_connection=wal_connection)
    synthetic.expected = {'ids': dict(ids), **direct_counts(root, ids)}
    return synthetic


@contextmanager
def analysis(captured: dict[str, Capture], kind: str, **options):
    entry = captured[kind]
    with entry.backup.analysis_copy(entry.manifest['id'], **options) as copy:
        yield copy


def run_inventory(synthetic: Synthetic, captured: dict[str, Capture], *, cancel=None, budget=None):
    """Inventory all three sources (one analysis copy open at a time) and build the report."""
    sources, notebooks = [], []
    for kind in legacy_inventory.KINDS:
        with analysis(captured, kind) as copy:
            sources.append(legacy_inventory.inventory_source(
                kind, captured[kind].manifest, copy, library_key=synthetic.library_key, cancel=cancel, budget=budget))
            # Only a database the inventory opened, with the tables it reads in their known shape, can list notebooks.
            if legacy_inventory.notebooks_listable(sources[-1]):
                for identifier in legacy_inventory.notebook_ids(copy, cancel=cancel, budget=budget):
                    notebooks.append(legacy_inventory.notebook_row_table(
                        copy, captured[kind].manifest, identifier, cancel=cancel, budget=budget))
    return legacy_inventory.build_report(sources, notebooks, budget=budget), sources, notebooks


def sqlite_names(kind: str, manifest: dict) -> tuple[str, ...]:
    """The SQLite files (database, -wal, -shm) of one source that its manifest holds; none for a device."""
    name = {'desktop-library': 'library.sqlite3', 'canonical': 'content.sqlite3'}.get(kind)
    keys = {tuple(entry['key']) for entry in manifest['entries']}
    return () if name is None else tuple(item for item in legacy_backup.sqlite_family(name) if (item,) in keys)


def run_inventory_shared(synthetic: Synthetic, captured: dict[str, Capture], *, cancel=None, budget=None, extract=None):
    """run_inventory, the shared way of work B7-b: one SQLite-only working copy per source (none for a device), the inventory
    first (it checks the tree), then the row tables on the same copy, every other file read from its verified backup object.

    extract(copy, manifest, table, read_entry) may be given to use the copy once more per notebook (the extractor does).
    """
    sources, notebooks = [], []
    for kind in legacy_inventory.KINDS:
        capture = captured[kind]
        manifest = capture.manifest
        names = sqlite_names(kind, manifest)

        def read_entry(entry, max_bytes, _backup=capture.backup, _id=manifest['id']):
            return _backup.read_object(_id, entry, max_bytes=max_bytes)

        def work(copy):
            sources.append(legacy_inventory.inventory_source(
                kind, manifest, copy, library_key=synthetic.library_key, cancel=cancel, budget=budget,
                copied=frozenset((name,) for name in names), read_entry=read_entry))
            if legacy_inventory.notebooks_listable(sources[-1]):
                for identifier in legacy_inventory.notebook_ids(copy, cancel=cancel, budget=budget):
                    notebooks.append(legacy_inventory.notebook_row_table(
                        copy, manifest, identifier, cancel=cancel, budget=budget, read_entry=read_entry))
                    if extract is not None:
                        extract(copy, manifest, notebooks[-1], read_entry)

        if names:
            with capture.backup.sqlite_working_copy(manifest['id'], names) as copy:
                work(copy)
        else:
            work(None)
    return legacy_inventory.build_report(sources, notebooks, budget=budget), sources, notebooks


class Reported:
    """A stat result with some fields replaced; every other field is the real one."""

    def __init__(self, value, **fields):
        self._value, self._fields = value, fields

    def __getattr__(self, name):
        return self._fields[name] if name in self._fields else getattr(self._value, name)


class FolderScan:
    """The state of one NativeLegacyBackup._scan (one source tree, one pass)."""

    def __init__(self, number: int):
        self.number = number
        self.listed: set[str] = set()    # folders whose children this scan has listed so far
        self.first: dict[str, Any] = {}  # the first stat of each folder in this scan


class FolderScans:
    """How a scan sees the folders of its source, and what a test may change while it reads them.

    cold=True models a folder that NTFS has not cached when a scan starts: the by-name stat that CPython 3.12
    takes reports st_size 0 until the scan has listed the folder, and the real allocation (4096) afterwards
    (REVIEW-r161-b6c.md aspect 6, DESIGN-r161-b6f-stamp.md 1.2). Every scan starts cold again, the worst case.
    Only folder stats taken by legacy_backup._safe_stat inside a scan are touched; files, stats outside a scan
    and other modules' stat calls are not. Hooks:
      size(path) -> int          replaces st_size of every folder stat (cold is not applied then)
      freeze                     a folder keeps its first stat for the whole scan (a clock tick that never moves)
      rewrite(scan, path, directory, value) -> stat-like   may return a changed stat (see Reported)
    """

    def __init__(self, patch, *, cold=False, size=None, freeze=False, rewrite=None):
        self.cold, self.size, self.freeze, self.rewrite = cold, size, freeze, rewrite
        self.scans, self.cold_stats = 0, 0
        self._lock, self._local = threading.Lock(), threading.local()
        real_scan, real_stat, real_iterdir = legacy_backup.NativeLegacyBackup._scan, legacy_backup._safe_stat, Path.iterdir
        model = self

        def scan(backup, identity):
            with model._lock:
                model.scans += 1
                number = model.scans
            model._local.scan = FolderScan(number)
            try:
                return real_scan(backup, identity)
            finally:
                model._local.scan = None

        def iterdir(path):
            current = getattr(model._local, 'scan', None)
            if current is not None:
                current.listed.add(str(path))
            return real_iterdir(path)

        def safe_stat(path, directory=False):
            value = real_stat(path, directory=directory)
            current = getattr(model._local, 'scan', None)
            if current is None:
                return value
            key = str(path)
            if directory:
                if model.freeze:
                    value = current.first.setdefault(key, value)
                if model.size is not None:
                    value = Reported(value, st_size=model.size(path))
                elif model.cold:
                    listed = key in current.listed
                    value = Reported(value, st_size=4096 if listed else 0)
                    if not listed:
                        with model._lock:
                            model.cold_stats += 1
            if model.rewrite is not None:
                value = model.rewrite(current, Path(path), directory, value)
            return value

        patch.setattr(legacy_backup.NativeLegacyBackup, '_scan', scan)
        patch.setattr(legacy_backup, '_safe_stat', safe_stat)
        patch.setattr(Path, 'iterdir', iterdir)


@contextmanager
def folder_scans(**options):
    """Context manager around FolderScans; everything is undone on exit."""
    with pytest.MonkeyPatch.context() as patch:
        yield FolderScans(patch, **options)
