"""Read a narrowly supported notebook from a registered immutable backup.

This is not a writer fence, complete migration, publication or activation.
Library database and content reads occur on NativeLegacyBackup's verified disposable
analysis copy. Backup metadata and registration are read from their stores.
The registered input set describes a source; it does not prove
that external writers or other peers were stopped during its collection.
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import closing, contextmanager
import hashlib
import json
import os
import re
import sqlite3
from typing import Any

from papeer.core.migrations.legacy_backup import NativeLegacyBackup, _check_cancel, _read_bounded_bytes
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs


# Exact current schema-9 columns. Older, newer or unclassified schemas are
# refused rather than treated as an empty set of annotations. Only the listed
# optional tables below may exist besides these.
_COLUMNS = {
    'attachments': 'id owner_id format title source position created_at updated_at',
    'bookmarks': 'id paper_id page side quote label note anchor_y created_at anchor_x kind color rects',
    'collection_glossaries': 'name terms', 'collections': 'name', 'item_links': 'a b',
    'messages': 'id paper_id role content scope created_at usage attachments research',
    'note_legacy': 'id note_id', 'note_operations': 'id operation',
    'note_state': 'id revision content source updated_at', 'note_templates': 'name content',
    'pages': 'paper_id number text', 'paper_discovery': 'source origin data',
    'papers': 'id sha256 title original_name pages status collection_name note created_at tags read_status first_author publication_year bibliography_version doi arxiv_id venue kind parent_id note_position',
    'pdf_ink': 'paper_id side page strokes', 'reading_status_choices': 'name',
    'reference_research': 'source key data', 'tag_choices': 'kind name',
}
# Tables product code creates on first use, so a schema-9 Library may or may not have them (each with the columns the
# creating statement gives it). They carry nothing a notebook needs: the extractor tolerates exactly these tables, with
# exactly these columns, and still refuses any other table. legacy_inventory.LIBRARY_TABLES classifies every one of them.
#   global_glossary          terminology.py   CREATE TABLE IF NOT EXISTS global_glossary (id INTEGER PRIMARY KEY CHECK(id=1), terms ...)
#   collection_undo          library_collections.py
#   paper_glossary           terminology.py _ensure_paper_glossary (paper_id, terms, dismissed, scope)
#   paper_glossary_domains   terminology.py _write_paper_domains (paper_id, domains, new_domain, chosen_by, known_domains)
#   web_annotation_ops       cloud_annotations.py import_operations (id, operation)
_OPTIONAL_COLUMNS = {
    'collection_undo': 'token snapshot', 'global_glossary': 'id terms',
    'paper_glossary': 'paper_id terms dismissed scope',
    'paper_glossary_domains': 'paper_id domains new_domain chosen_by known_domains',
    'web_annotation_ops': 'id operation',
}
_ID = re.compile(r'^[0-9a-f]{32}$')


def sqlite_companion_state(journal_mode: str, wal: bool, shm: bool) -> str:
    """How a database's -wal/-shm companions (as the manifest records them) fit its journal mode.

    'plain'       rollback-journal database, no companion
    'unexpected'  rollback-journal database with a companion
    'complete'    WAL database with both companions (a database that was not closed; the -wal holds its latest rows)
    'closed'      WAL database with neither companion: it was closed normally, so SQLite folded the WAL into the main
                  file and removed both (the usual state of a Papeer Library after the app exits; storage.py sets WAL)
    'incomplete'  WAL database with only one companion: part of its state is missing
    One rule for the inventory and for the extractor (DESIGN-r161-b7-staging.md section 9 item 2, decision J5).
    """
    if journal_mode == 'rollback':
        return 'unexpected' if wal or shm else 'plain'
    if wal and shm:
        return 'complete'
    return 'closed' if not wal and not shm else 'incomplete'


def _json(data: str) -> Any:
    def reject(_value: str) -> None: raise ValueError('legacy-notebook-nonfinite-json')
    return json.loads(data, parse_constant=reject)


@contextmanager
def _database(path, max_projection_bytes):
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            if max_projection_bytes is not None:
                # Bound a single SQLite value/row before it becomes a Python object.
                db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, max(4096, max_projection_bytes))
            yield db
    except sqlite3.DataError as error:
        if max_projection_bytes is None:
            raise
        raise ValueError('legacy-notebook-read-limit') from error


def _rows(cursor, maximum, budget):
    rows = []
    for row in cursor:
        if maximum is not None and len(rows) >= maximum:
            raise ValueError('legacy-notebook-read-limit')
        if budget is not None:
            for value in row:
                if isinstance(value, str):
                    budget[0] -= len(value.encode('utf8'))
                elif isinstance(value, bytes):
                    budget[0] -= len(value)
            if budget[0] < 0:
                raise ValueError('legacy-notebook-read-limit')
        rows.append(row)
    return rows


def notebook_entries(manifest: dict[str, Any], notebook_id: str, *, max_notebook_bytes=None, max_projection_bytes=None) -> dict[tuple, dict]:
    """The manifest's entries by key, after the checks that need nothing but the manifest: the three files a notebook is read
    from are there, and notebook.json is within the caps."""
    entries = {tuple(entry['key']): entry for entry in manifest['entries']}
    db_key = ('library.sqlite3',); note_key = ('papers', notebook_id, 'notebook.json'); pdf_key = ('papers', notebook_id, 'original.pdf')
    if any(key not in entries for key in (db_key, note_key, pdf_key)):
        raise ValueError('legacy-notebook-required-entry-missing')
    if ((max_notebook_bytes is not None and entries[note_key]['byteLength'] > max_notebook_bytes)
            or (max_projection_bytes is not None and entries[note_key]['byteLength'] > max_projection_bytes)):
        raise ValueError('legacy-notebook-read-limit')
    return entries


def assert_notebook_settled(entries: dict[tuple, dict], notebook_id: str) -> None:
    """No pending notebook change and no rollback journal beside the Library database (both are entries of the manifest)."""
    folder = ('papers', notebook_id)
    if any(folder + (name,) in entries for name in ('.notebook-change.json', '.notebook-before.pdf', '.notebook-after.pdf')):
        raise ValueError('legacy-notebook-recovery-pending')
    if ('library.sqlite3-journal',) in entries:
        raise ValueError('legacy-notebook-sqlite-journal-unsupported')


def notebook_projection_from_copy(db_path, manifest: dict[str, Any], notebook_id: str, read_note: Callable[[int | None], bytes], *,
                                  library_id: str, run_id: str, peer_id: str, max_notebook_bytes=None, max_pages=None,
                                  max_annotation_rows=None, max_projection_bytes=None, cancel=None) -> dict[str, Any]:
    """The extraction itself (work B7-b; the body of notebook_projection_input, unchanged), on a database copy the caller has
    verified: `db_path` is the Library database inside a disposable copy that equals the manifest's SQLite files (with its
    -wal/-shm when the manifest holds them), and `read_note(max_bytes)` returns the bytes of the notebook.json entry (the
    caller reads them from the copy, or verified from the backup object). `manifest` and the entry checks
    (notebook_entries, assert_notebook_settled) are the caller's: nothing here looks at the hold, the registered inputs or
    the other files. One verified copy can be passed here once per notebook (it is opened read only)."""
    entries = {tuple(entry['key']): entry for entry in manifest['entries']}
    note_key = ('papers', notebook_id, 'notebook.json')
    backup_id = manifest['id']
    with db_path.open('rb') as stream: raw_header = stream.read(100)
    if len(raw_header) < 100 or raw_header[:16] != b'SQLite format 3\x00' or raw_header[18] != raw_header[19] or raw_header[18] not in (1, 2):
        raise ValueError('legacy-notebook-sqlite-header-unsupported')
    wal_keys = {('library.sqlite3-wal',), ('library.sqlite3-shm',)}
    present = wal_keys.intersection(entries)
    # A WAL database needs both companions or neither (neither = closed normally); one alone, or a companion beside a
    # rollback-journal database, means part of its state is missing or foreign.
    if sqlite_companion_state('wal' if raw_header[18] == 2 else 'rollback', ('library.sqlite3-wal',) in present,
                              ('library.sqlite3-shm',) in present) in ('incomplete', 'unexpected'):
        raise ValueError('legacy-notebook-sqlite-wal-incomplete')
    note_limits = [limit for limit in (max_notebook_bytes, max_projection_bytes) if limit is not None]
    note_bytes = read_note(min(note_limits) if note_limits else None)
    if (len(note_bytes) != entries[note_key]['byteLength']
            or hashlib.sha256(note_bytes).hexdigest() != entries[note_key]['sha256']):
        raise ValueError('legacy-notebook-input-changed')
    try: notebook = _json(note_bytes.decode('utf8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc: raise ValueError('legacy-notebook-json-invalid') from exc
    if not isinstance(notebook, dict) or set(notebook) != {'version', 'revision', 'pages'} or type(notebook['version']) is not int or notebook['version'] != 1 or type(notebook['revision']) is not int or notebook['revision'] < 1 or not isinstance(notebook['pages'], list) or not notebook['pages']:
        raise ValueError('legacy-notebook-shape-unsupported')
    pages = notebook['pages']; ids = []
    if max_pages is not None and len(pages) > max_pages:
        raise ValueError('legacy-notebook-read-limit')
    for page in pages:
        if not isinstance(page, dict) or set(page) != {'id', 'size', 'orientation', 'width_mm', 'height_mm', 'template', 'color'} or not isinstance(page['id'], str) or not _ID.fullmatch(page['id']):
            raise ValueError('legacy-notebook-page-unsupported')
        ids.append(page['id'])
    if len(set(ids)) != len(ids): raise ValueError('legacy-notebook-page-duplicate')
    budget = None if max_projection_bytes is None else [max_projection_bytes - len(note_bytes)]
    with _database(db_path, max_projection_bytes) as db:
        db.row_factory = sqlite3.Row
        _check_cancel(cancel)
        db.execute('PRAGMA query_only=ON'); db.execute('BEGIN')
        if db.execute('PRAGMA user_version').fetchone()[0] != 9: raise ValueError('legacy-notebook-schema-version')
        schema = _rows(db.execute("SELECT type,name FROM sqlite_master WHERE substr(name,1,7) != 'sqlite_' ORDER BY type,name"),
                       None if budget is None else 1024, budget)
        if any(row['type'] not in ('table', 'index') for row in schema): raise ValueError('legacy-notebook-schema-unsupported')
        tables = {row['name'] for row in schema if row['type'] == 'table'}
        # Every required table, plus only the classified optional ones (any other table is refused).
        if not set(_COLUMNS) <= tables or not tables - set(_COLUMNS) <= set(_OPTIONAL_COLUMNS):
            raise ValueError('legacy-notebook-schema-unsupported')
        for name, columns in {**_COLUMNS, **{name: _OPTIONAL_COLUMNS[name] for name in tables - set(_COLUMNS)}}.items():
            actual = db.execute('PRAGMA table_xinfo("' + name + '")').fetchall()
            if [row['name'] for row in actual] != columns.split() or any(row['hidden'] != 0 for row in actual):
                raise ValueError('legacy-notebook-schema-unsupported')
        _check_cancel(cancel)
        if [tuple(row) for row in db.execute('PRAGMA quick_check')] != [('ok',)]:
            raise ValueError('legacy-notebook-sqlite-invalid')
        _check_cancel(cancel)
        if db.execute('PRAGMA foreign_key_check').fetchone() is not None: raise ValueError('legacy-notebook-foreign-key-invalid')
        _check_cancel(cancel)
        row = db.execute('SELECT id,kind,sha256,pages FROM papers WHERE id=?', (notebook_id,)).fetchone()
        if row is None or row['kind'] != 'notebook' or row['pages'] != len(pages) or row['sha256'] != f"notebook:{notebook_id}:{notebook['revision']}":
            raise ValueError('legacy-notebook-marker-or-count-mismatch')
        _check_cancel(cancel)
        page_rows = _rows(db.execute('SELECT number,text FROM pages WHERE paper_id=? ORDER BY number', (notebook_id,)),
                          max_pages, budget)
        if [r['number'] for r in page_rows] != list(range(1, len(pages) + 1)):
            raise ValueError('legacy-notebook-page-row-coverage')
        _check_cancel(cancel)
        inks = _rows(db.execute('SELECT paper_id,side,page,strokes FROM pdf_ink WHERE paper_id=? ORDER BY side,page', (notebook_id,)),
                     max_annotation_rows, budget)
        remaining_rows = None if max_annotation_rows is None else max_annotation_rows - len(inks)
        _check_cancel(cancel)
        marks = _rows(db.execute('SELECT * FROM bookmarks WHERE paper_id=? ORDER BY id', (notebook_id,)),
                      remaining_rows, budget)
        if any(r['side'] != 'original' or type(r['page']) is not int or not 1 <= r['page'] <= len(pages) for r in [*inks, *marks]):
            raise ValueError('legacy-notebook-annotation-row-unmapped')
        ink_by_page: dict[int, list[Any]] = {}
        for ink in inks:
            value = _json(ink['strokes'])
            if not isinstance(value, list) or ink['page'] in ink_by_page: raise ValueError('legacy-notebook-ink-unsupported')
            ink_by_page[ink['page']] = value
        annotations = []
        for number, page in enumerate(pages, 1):
            bookmarks = []
            for mark in marks:
                if mark['page'] == number:
                    record = dict(mark); record['id'] = str(record['id']); bookmarks.append(record)
            annotations.append({'pageId': page['id'], 'ink': ink_by_page.get(number, []), 'bookmarks': bookmarks})
    return {'libraryId': library_id, 'sourceDocumentId': notebook_id,
            'entry': {'sha256': entries[note_key]['sha256'], 'byteLength': entries[note_key]['byteLength']}, 'bytes': note_bytes,
            'annotations': annotations, 'coverage': {'runId': run_id, 'peerId': peer_id, 'backupId': backup_id,
            'inventorySha256': manifest['inventorySha256'], 'pageRows': len(page_rows), 'inkRows': len(inks), 'bookmarkRows': len(marks),
            'sqliteWalEntries': sorted('/'.join(key) for key in present), 'inkPages': [r['page'] for r in inks],
            'bookmarkIds': [str(r['id']) for r in marks], 'pageText': [r['text'] for r in page_rows]},
            'incomplete': ['whole-library-and-other-source-coverage', 'page-text-not-converted', 'original-pdf-fidelity-unverified', 'external-writer-quiescence', 'publication-and-activation']}


def notebook_projection_input(backup: NativeLegacyBackup, run_id: str, peer_id: str, notebook_id: str, *,
                              limits=None, max_notebook_bytes=None, max_pages=None,
                              max_annotation_rows=None, max_projection_bytes=None, cancel=None) -> dict[str, Any]:
    """Return projection input and coverage for one notebook, or fail closed.

    Returned notebook bytes and original-page ink/bookmark rows are for the
    existing pure projectLegacyNotebookEntry converter. No SQLite recovery is
    run on the source or on immutable objects, and no staging is published.
    This is the preview's whole-copy path: it verifies the hold, the registered inputs and the backup, takes its own
    analysis copy and hands the database to notebook_projection_from_copy.
    """
    if not isinstance(backup, NativeLegacyBackup) or backup._select is not None or backup._allow_missing:
        raise ValueError('legacy-notebook-full-native-backup-required')
    for limit in (max_notebook_bytes, max_pages, max_annotation_rows, max_projection_bytes):
        if limit is not None and (type(limit) is not int or limit < 0):
            raise ValueError('legacy-notebook-read-limit')
    if not isinstance(notebook_id, str) or not _ID.fullmatch(notebook_id):
        raise ValueError('legacy-notebook-id-invalid')
    expected_source = {'kind': 'desktop-library', 'id': hashlib.sha256(os.path.normcase(str(backup.source)).encode('utf8')).hexdigest()}
    if backup.store.source != expected_source:
        raise ValueError('legacy-notebook-source-mismatch')
    inputs = NativeLegacyInputs(backup.source)
    if inputs.startup.read() != {'version': 1, 'runId': run_id}:
        raise ValueError('legacy-notebook-hold-mismatch')
    registered = inputs.read(run_id, limits=limits)
    if registered is None:
        raise ValueError('legacy-notebook-input-set-missing')
    matches = [item for item in registered['inputs'] if item['peerId'] == peer_id and item['plan']['manifest']['source'] == expected_source]
    if len(matches) != 1:
        raise ValueError('legacy-notebook-input-not-unique')
    expected_plan = matches[0]['plan']; backup_id = expected_plan['manifest']['id']
    # Reopen the same source/destination with the default complete selection.
    cold = NativeLegacyBackup(backup.source, backup.root)
    if (cold.plan(backup_id, limits=limits) != expected_plan
            or cold.store.reference(backup_id, limits=limits) != expected_plan['manifest']):
        raise ValueError('legacy-notebook-plan-or-manifest-mismatch')
    manifest = expected_plan['manifest']
    entries = notebook_entries(manifest, notebook_id, max_notebook_bytes=max_notebook_bytes, max_projection_bytes=max_projection_bytes)
    if cold.load(backup_id, limits=limits, cancel=cancel) != manifest:
        raise ValueError('legacy-notebook-plan-or-manifest-mismatch')
    assert_notebook_settled(entries, notebook_id)
    with cold.analysis_copy(backup_id, limits=limits, cancel=cancel) as copy:
        _check_cancel(cancel)
        note_path = copy.joinpath('papers', notebook_id, 'notebook.json')
        result = notebook_projection_from_copy(
            copy / 'library.sqlite3', manifest, notebook_id,
            lambda max_bytes: note_path.read_bytes() if max_bytes is None else _read_bounded_bytes(note_path, max_bytes),
            library_id=registered['catalog']['identity']['libraryId'], run_id=run_id, peer_id=peer_id,
            max_notebook_bytes=max_notebook_bytes, max_pages=max_pages, max_annotation_rows=max_annotation_rows,
            max_projection_bytes=max_projection_bytes, cancel=cancel)
    _check_cancel(cancel)
    if (inputs.startup.read() != {'version': 1, 'runId': run_id} or inputs.read(run_id, limits=limits) != registered
            or cold.plan(backup_id, limits=limits) != expected_plan or cold.load(backup_id, limits=limits, cancel=cancel) != manifest):
        raise ValueError('legacy-notebook-input-changed')
    return result
