"""Read-only inventory of a verified analysis copy of a Native legacy backup (work B6-b).

Pure: no sidecar, no route, no startup path calls this module. It writes nothing of the source or
of the backup; it reads the disposable `.analysis-*` copy that NativeLegacyBackup.analysis_copy hands
out (the caller owns, verifies and removes that copy). The one exception is inside that copy: opening
a WAL-mode database there makes SQLite write its own `-shm` even for a read-only connection, and for a
cleanly closed WAL database (no `-wal`/`-shm` in the manifest) SQLite creates both. After a database
has been opened the copy therefore no longer equals the manifest, so open each copy once (the tree
check `_scan_copy` runs when inventory_source starts; notebook_ids and notebook_row_table come after it). Since work B7-b one
verified copy of only the database files (NativeLegacyBackup.sqlite_working_copy) is shared by the inventory, the row tables
and the extractor: inventory_source is the one that checks its tree, and it must be the first to use the copy.
Everything is enumerated from the real thing: the manifest's entries and containers, the copy's directory tree, sqlite_master, every
table's PRAGMA table_xinfo, and per-table row counts. Nothing is derived from a name guess.

Three categories (DESIGN-r161-b6-p6-inventory.md 3.1):
  supported          an existing converter can take it, rows and bytes accounted for
  retained-blocking  known, but no converter/target yet; it stays raw in the backup and,
                     when it holds a row or a file, blocks a whole-Library conversion
  unknown            not in the tables below, shaped unexpectedly, or inconsistent; always
                     blocks, even with zero rows. Unknown is never treated as empty.
Anything absent from the classification tables is unknown. There is no branch that falls back
to `supported`; every `supported` verdict comes from an explicit rule below.

Report contents: names, keys, counts and reason codes only. No row content (message text, page
text, quotes, notes, labels, strokes), no absolute path, no exception text. A notebook's stroke
arrays are read only to count them, under a byte budget.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
from typing import Any

from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.fileio import is_temporary
from papeer.core.migrations.legacy_backup import _read_bounded_bytes, _safe_stat, assert_backup_manifest
from papeer.core.migrations.legacy_notebook_backup import _COLUMNS as _SCHEMA9_COLUMNS
from papeer.core.migrations.legacy_notebook_backup import _OPTIONAL_COLUMNS, sqlite_companion_state

SCOPE = 'native-legacy-inventory-v1'
VERSION = 1
SCHEMA_VERSION = 9
KINDS = ('desktop-library', 'canonical', 'device')
S, R, U = 'supported', 'retained-blocking', 'unknown'
_ORDER = {S: 0, R: 1, U: 2}
# Interval (SQLite virtual-machine steps) of the progress handler that checks `cancel`. Tests lower it.
PROGRESS_INTERVAL = 1000
_ID = re.compile(r'^[0-9a-f]{32}$')
_HEX32_JSON = re.compile(r'^[0-9a-f]{32}\.json$')
_HASH64 = re.compile(r'^[0-9a-f]{64}$')
_TRANSLATION_JSON = re.compile(r'^translation-[^/]+\.json$')
_AUTOINDEX = re.compile(r'^sqlite_autoindex_(.+)_([0-9]+)$')
MIB = 1024 * 1024


@dataclass(frozen=True)
class InventoryBudget:
    """Bounds of one inventory. Overrunning one is a refusal, never a truncation."""
    max_objects: int = 1024            # sqlite_master rows of one database
    max_columns_per_table: int = 256
    max_value_bytes: int = 6 * MIB     # one stored value / a notebook's stroke JSON in total
    max_report_bytes: int = 8 * MIB

    def __post_init__(self):
        for value in (self.max_objects, self.max_columns_per_table, self.max_value_bytes, self.max_report_bytes):
            if type(value) is not int or value < 0:
                raise ValueError('inventory-budget-invalid')


# ----- classification tables --------------------------------------------------------------------
# Library schema 9. Columns come from legacy_notebook_backup._COLUMNS (storage.MIGRATIONS 1-9). The optional
# tables (legacy_notebook_backup._OPTIONAL_COLUMNS, with the creating statement of each) are created on first use and
# may exist at any version. Rule lists are [(columns or None for all, category, reason)] per row group.
# Groups: notebook / pdf / markdown (papers.kind), notebook-unmapped (annotation not on an original page),
# '*' (every kind). other-kind and orphan rows are always unknown (see _row_group).
_BASE = ((None, R, 'messages-not-converted'),)
LIBRARY_TABLES: dict[str, dict[str, Any]] = {
    'papers': {'owner': 'id', 'groups': {
        'notebook': [(('id', 'kind', 'sha256', 'pages'), S, 'notebook-entry'), (None, R, 'library-metadata-not-converted')],
        'pdf': [(None, R, 'pdf-document-not-converted')],
        'markdown': [(None, R, 'markdown-not-converted')]}},
    'pages': {'owner': 'paper_id', 'groups': {
        'notebook': [(('paper_id', 'number'), S, 'notebook-page-coverage'), (('text',), R, 'page-text-not-converted')],
        'pdf': [(None, R, 'pdf-document-not-converted')],
        'markdown': [(None, U, 'row-owner-unexpected')]}},
    'pdf_ink': {'owner': 'paper_id', 'annotation': True, 'groups': {
        'notebook': [(None, S, 'notebook-annotation')], 'notebook-unmapped': [(None, R, 'notebook-annotation-unmapped')],
        'pdf': [(None, R, 'pdf-annotation-not-converted')]}},
    'bookmarks': {'owner': 'paper_id', 'annotation': True, 'groups': {
        'notebook': [(None, S, 'notebook-annotation')], 'notebook-unmapped': [(None, R, 'notebook-annotation-unmapped')],
        'pdf': [(None, R, 'pdf-annotation-not-converted')]}},
    'messages': {'owner': 'paper_id', 'groups': {'*': [(None, R, 'messages-not-converted')]}},
    'reference_research': {'owner': 'source', 'groups': {'*': [(None, R, 'reference-data-not-converted')]}},
    'paper_discovery': {'owner': 'source', 'groups': {'*': [(None, R, 'reference-data-not-converted')]}},
    'attachments': {'owner': 'owner_id', 'groups': {'*': [(None, R, 'attachment-not-converted')]}},
    'note_state': {'owner': 'id', 'groups': {'*': [(None, R, 'markdown-not-converted')]}},
    'note_legacy': {'owner': 'id', 'groups': {'*': [(None, R, 'markdown-not-converted')]}},
    'note_operations': {'owner': None, 'groups': {'*': [(None, R, 'note-operation-history-not-converted')]}},
    'collections': {'owner': None, 'groups': {'*': [(('name',), R, 'folder-not-converted')]}},
    'item_links': {'owner': None, 'groups': {'*': [(('a', 'b'), R, 'item-link-not-converted')]}},
    'note_templates': {'owner': None, 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'collection_glossaries': {'owner': None, 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'tag_choices': {'owner': None, 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'reading_status_choices': {'owner': None, 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'global_glossary': {'owner': None, 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'collection_undo': {'owner': None, 'groups': {'*': [(None, R, 'undo-state-not-converted')]}},
    # Glossary choices per paper (terminology.py) and the record of imported Web annotation operations (cloud_annotations.py).
    # A row of the first two belongs to a paper (library_papers.py deletes it with the paper); a row without one is unknown.
    'paper_glossary': {'owner': 'paper_id', 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'paper_glossary_domains': {'owner': 'paper_id', 'groups': {'*': [(None, R, 'library-metadata-not-converted')]}},
    'web_annotation_ops': {'owner': None, 'groups': {'*': [(None, R, 'web-annotation-ops-not-converted')]}},
}
# Index names created by library_schema.py (papers_parent, attachments_owner, item_links_b); the automatic
# sqlite_autoindex_<table>_<n> of a known table is accepted separately.
LIBRARY_INDEXES = {'papers_parent': 'papers', 'attachments_owner': 'attachments', 'item_links_b': 'item_links'}
# canonical content.sqlite3: every table the product creates in that one file, 21 tables and 2 named indexes (the
# test `test_the_canonical_classification_is_exactly_what_the_product_creates` runs the creating functions and compares):
#   edit_repository.initialize_edit_schema              11 edit_* tables, index edit_batch_target
#   bootstrap/canonical_local_grant_sqlite.py            canonical_local_owner_grants (host provision, canonical_host.py)
#   bootstrap/canonical_initialization_sqlite.py         canonical_peers/_profiles/_initial_intents/_initial_artifacts,
#                                                        index canonical_intent_library (initialize_canonical_metadata)
#   edits/provider/activation.py                         5 canonical_provider_* tables (upgrade_provider_metadata, created lazily)
# Every one is raw-preserved (retained-blocking when it holds a row), none is mapped: no converter exists for any of them.
CANONICAL_COLUMNS = {
    'edit_roots': 'scope target payload', 'edit_batches': 'scope id target payload receipt history',
    'edit_projections': 'scope target version payload', 'edit_projection_pages': 'scope id payload',
    'edit_publications': 'scope id payload', 'edit_resources': 'scope id payload',
    'edit_resource_bytes': 'scope sha256 payload', 'edit_checkpoints': 'scope sha256',
    'edit_intents': 'scope target payload', 'edit_datasets': 'scope id payload',
    'edit_dataset_controls': 'identity payload active_epoch staging_epoch frozen epochs',
    'canonical_local_owner_grants': 'key payload',
    'canonical_peers': 'account payload', 'canonical_profiles': 'identity account library request_id payload',
    'canonical_initial_intents': 'account request_id library retired payload', 'canonical_initial_artifacts': 'identity payload',
    'canonical_provider_bindings': 'owner identity payload', 'canonical_provider_intents': 'owner request_id payload',
    'canonical_provider_artifacts': 'owner request_id payload',
    'canonical_provider_resource_bytes': 'owner request_id resource_id payload',
    'canonical_provider_acknowledgements': 'owner request_id'}
CANONICAL_INDEXES = {'edit_batch_target': 'edit_batches', 'canonical_intent_library': 'canonical_initial_intents'}
# Tables that hold an unprocessed request: a row blocks as `canonical-pending-intent` (initial intents only while not
# retired). Every other canonical table: canonical-store-present.
CANONICAL_ROW_REASON = {'edit_intents': 'canonical-pending-intent', 'canonical_initial_intents': 'canonical-pending-intent',
                        'canonical_provider_intents': 'canonical-pending-intent'}
# (location, table, row group counted or None for every row, reason). The first two are created with the edit schema; the
# last two are created by later steps, so a canonical store that never ran them simply has no such table (= no rows).
CANONICAL_PENDING_STORES = (
    ('canonical:edit_intents', 'edit_intents', None, 'canonical-pending-intent'),
    ('canonical:edit_batches(pending upload)', 'edit_batches', 'pending-upload', 'canonical-pending-upload'),
    ('canonical:canonical_initial_intents', 'canonical_initial_intents', 'pending', 'canonical-pending-intent'),
    ('canonical:canonical_provider_intents', 'canonical_provider_intents', None, 'canonical-pending-intent'))
CANONICAL_LAZY_TABLES = ('canonical_initial_intents', 'canonical_provider_intents')
_SQLITE_INTERNAL = ('sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4')
# Device files (paths.py, config.py, local_history.py, ocr.py; legacy_device.GLOBAL_FILES).
DEVICE_GLOBAL = ('device-settings.json', 'history-settings.json', 'ocr-settings.json', 'storage-location.json')
UNCOLLECTED = ('native-webview-storage', 'drive-remote', 'other-peers', 'web-browser-storage')


# ----- small helpers ----------------------------------------------------------------------------
def _cancelled(cancel) -> bool:
    return cancel is not None and cancel.is_set()


def _check(cancel) -> None:
    if _cancelled(cancel):
        raise ValueError('inventory-cancelled')


def _worst(values) -> str:
    return max(values, key=lambda value: _ORDER[value], default=S)


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _item(category: str, reason: str) -> dict[str, Any]:
    return {'category': category, 'reason': reason}


@contextmanager
def _database(path: Path, cancel, budget: InventoryBudget):
    """The analysis copy's database, read only; cancel is polled by SQLite itself, values are length-bounded."""
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, max(4096, budget.max_value_bytes))
            db.set_progress_handler(lambda: 1 if _cancelled(cancel) else 0, max(1, PROGRESS_INTERVAL))
            db.execute('PRAGMA query_only=ON')
            yield db
    except sqlite3.DataError as error:
        raise ValueError('inventory-capacity-exceeded') from error
    except sqlite3.OperationalError as error:
        if 'interrupt' in str(error).lower():
            raise ValueError('inventory-cancelled') from error
        raise


def _scan_copy(copy: Path | None, manifest: dict, cancel, copied: frozenset | None = None) -> None:
    """The copy's real tree must equal the manifest's entries (with sizes) and containers; links are refused.

    `copied` (a set of manifest keys) says the copy is a partial one (NativeLegacyBackup.sqlite_working_copy): its tree must
    equal exactly those entries, with no folder. It is empty when nothing was copied, and then `copy` may be None.
    """
    if copied is not None:
        sizes = {tuple(entry['key']): entry['byteLength'] for entry in manifest['entries']}
        if not copied <= set(sizes) or (copy is None) != (not copied):
            raise ValueError('inventory-copy-mismatch')
        if copy is None:
            return
        expected_files = {key: sizes[key] for key in copied}
        expected_dirs: set[tuple] = set()
    else:
        if copy is None:
            raise ValueError('inventory-copy-mismatch')       # a whole copy is a folder
        expected_files = {tuple(entry['key']): entry['byteLength'] for entry in manifest['entries']}
        expected_dirs = {tuple(key) for key in manifest['containers']}
    limit = len(expected_files) + len(expected_dirs)
    files: dict[tuple, int] = {}
    dirs: set[tuple] = set()
    count = 0
    stack: list[tuple[Path, tuple]] = [(copy, ())]
    while stack:
        folder, key = stack.pop()
        _check(cancel)
        with os.scandir(folder) as names:
            for item in names:
                count += 1
                if count > limit:
                    raise ValueError('inventory-copy-mismatch')
                path = Path(item.path)
                directory = stat.S_ISDIR(path.lstat().st_mode)
                value = _safe_stat(path, directory=directory)
                child = (*key, item.name)
                if directory:
                    dirs.add(child)
                    stack.append((path, child))
                else:
                    files[child] = value.st_size
    if files != expected_files or dirs != expected_dirs:
        raise ValueError('inventory-copy-mismatch')


def _json(data: str) -> Any:
    def reject(_value: str) -> None:
        raise ValueError('inventory-nonfinite-json')
    return json.loads(data, parse_constant=reject)


def assert_copy_unchanged(copy: Path | None, manifest: dict, names, *, cancel=None) -> None:
    """After the LAST use of a shared working copy: its database (and its -wal, when the manifest holds one) must still be
    byte-identical to the manifest's entries (work B7-d; REVIEW-r161-b7b low 3).

    The copy is checked once before it is opened (`_scan_copy`: names and sizes, after `sqlite_working_copy` hashed every file
    it wrote); after that the inventory, the row tables, the extraction and the staging rows all read it, and nothing looked at it
    again, so a change inside `.analysis-*` in between would have made the row table and the extraction agree on altered rows.
    Opening a database read only writes neither the database nor its -wal (it may create or rewrite the -shm, and for a cleanly
    closed WAL database creates an empty -wal and a -shm, which is why the -shm is not compared here and an absent -wal is not
    required to stay absent). `names` are the top-level SQLite files the copy was made of (NativeLegacyBackup.sqlite_working_copy).
    Raises ValueError('inventory-copy-mismatch') (and 'inventory-cancelled'); never an exception text or a path.
    """
    entries = {tuple(entry['key']): entry for entry in manifest['entries']}
    for name in names:
        if name.endswith('-shm'):
            continue
        entry = entries.get((name,))
        if copy is None or entry is None:
            raise ValueError('inventory-copy-mismatch')
        _check(cancel)
        path = copy / name
        value = _safe_stat(path)
        if value.st_size != entry['byteLength']:
            raise ValueError('inventory-copy-mismatch')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(MIB), b''):
                _check(cancel)
                digest.update(block)
        if digest.hexdigest() != entry['sha256']:
            raise ValueError('inventory-copy-mismatch')


# ----- SQLite -----------------------------------------------------------------------------------
class _Profile:
    """What a database kind is expected to contain."""
    def __init__(self, kind: str, db_name: str):
        self.kind, self.db_name = kind, db_name
        if kind == 'desktop-library':
            self.columns = {name: columns.split() for name, columns in {**_SCHEMA9_COLUMNS, **_OPTIONAL_COLUMNS}.items()}
            self.indexes = LIBRARY_INDEXES
            self.version: int | None = SCHEMA_VERSION
        else:
            self.columns = {name: columns.split() for name, columns in CANONICAL_COLUMNS.items()}
            self.indexes = CANONICAL_INDEXES
            self.version = None

    def known(self, name: str) -> bool:
        # The library rule table is the authority: a table removed from it is unknown even if its columns are listed.
        if self.kind == 'desktop-library':
            return name in LIBRARY_TABLES and name in self.columns
        return name in self.columns


def _header(path: Path) -> tuple[str | None, str | None]:
    """(journal mode, problem). The first 100 bytes; byte 18/19 is the file format version (1 rollback, 2 WAL)."""
    with path.open('rb') as stream:
        data = stream.read(100)
    if len(data) < 100 or data[:16] != b'SQLite format 3\x00' or data[18] != data[19] or data[18] not in (1, 2):
        return None, 'sqlite-invalid'
    return ('wal' if data[18] == 2 else 'rollback'), None


def _rule_result(rules: dict, group: str) -> tuple[str, str]:
    """Worst category of a row group's rules, with the reason of its first worst rule."""
    items = rules.get(group) or rules.get('*')
    if items is None:
        return U, 'row-owner-unexpected'
    worst = _worst(category for _columns, category, _reason in items)
    return worst, next(reason for _columns, category, reason in items if category == worst)


def _column_results(spec: dict, actual: list[str]) -> list[dict[str, Any]]:
    """Column categories of the convertible (notebook) row group, or of every row when there is no split."""
    rules = spec['groups'].get('notebook') or spec['groups'].get('*') or []
    result = []
    for name in actual:
        match = next(((category, reason) for columns, category, reason in rules if columns is None or name in columns),
                     (U, 'unknown-column'))
        result.append({'name': name, **_item(*match)})
    return result


def _row_group(kind: str | None, orphan: bool, mapped: int | None, annotation: bool) -> str:
    if orphan:
        return 'orphan'
    if kind not in ('notebook', 'pdf', 'markdown'):
        return 'other-kind'
    if annotation and kind == 'notebook' and not mapped:
        return 'notebook-unmapped'
    return kind


_GROUP_ORDER = ('notebook', 'notebook-unmapped', 'all', 'pdf', 'markdown', 'pending-upload', 'pending', 'retired', 'other',
                'receipt-unreadable', 'other-kind', 'orphan')


def _group_rank(group: str) -> int:
    return _GROUP_ORDER.index(group) if group in _GROUP_ORDER else len(_GROUP_ORDER)


def _library_groups(db, name: str, spec: dict, cancel) -> list[tuple[str, int, str, str]]:
    owner, annotation, table = spec['owner'], bool(spec.get('annotation')), _quote(name)
    if owner is None:
        count = db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
        category, reason = _rule_result(spec['groups'], '*')
        return [('all', count, category, reason)] if count else []
    if name == 'papers':
        query = f'SELECT kind, 0, 1, count(*) FROM {table} GROUP BY kind'
    else:
        mapped = ("(t.side='original' AND typeof(t.page)='integer' AND t.page BETWEEN 1 AND p.pages)"
                  if annotation else '1')
        query = (f'SELECT p.kind, p.id IS NULL, {mapped}, count(*) FROM {table} t '
                 f'LEFT JOIN papers p ON p.id = t.{_quote(owner)} GROUP BY 1, 2, 3')
    merged: dict[str, int] = {}
    for kind, orphan, mapped_flag, count in db.execute(query).fetchall():
        _check(cancel)
        group = _row_group(kind, bool(orphan), mapped_flag, annotation)
        merged[group] = merged.get(group, 0) + count
    result = []
    for group, count in sorted(merged.items()):
        if group == 'orphan':
            category, reason = U, 'row-owner-missing'
        elif group == 'other-kind':
            category, reason = U, 'item-kind-unknown'
        else:
            category, reason = _rule_result(spec['groups'], group)
        result.append((group, count, category, reason))
    return result


def _canonical_groups(db, name: str) -> list[tuple[str, int, str, str]]:
    table = _quote(name)
    if name == 'edit_batches':
        # edit_repository.py: receipt is JSON text; {"upload": "pending"} means the batch was not uploaded yet.
        query = ("SELECT CASE WHEN NOT json_valid(receipt) THEN 'receipt-unreadable' "
                 "WHEN json_extract(receipt, '$.upload') = 'pending' THEN 'pending-upload' ELSE 'other' END, count(*) "
                 f"FROM {table} GROUP BY 1")
        meanings = {'receipt-unreadable': (U, 'canonical-receipt-unreadable'),
                    'pending-upload': (R, 'canonical-pending-upload'), 'other': (R, 'canonical-store-present')}
        return [(group, count, *meanings[group]) for group, count in sorted(db.execute(query).fetchall())]
    if name == 'canonical_initial_intents':
        # initialize_canonical_metadata: retired=1 is a finished request kept as its receipt; anything else counts as pending.
        query = f"SELECT CASE WHEN retired = 1 THEN 'retired' ELSE 'pending' END, count(*) FROM {table} GROUP BY 1"
        meanings = {'pending': (R, 'canonical-pending-intent'), 'retired': (R, 'canonical-store-present')}
        return [(group, count, *meanings[group]) for group, count in sorted(db.execute(query).fetchall())]
    count = db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
    return [('all', count, R, CANONICAL_ROW_REASON.get(name, 'canonical-store-present'))] if count else []


def _object_rows(db, name: str) -> dict[str, Any]:
    """Row total and groups of one table. A table that cannot be counted is reported, not skipped."""
    try:
        total = db.execute(f'SELECT count(*) FROM {_quote(name)}').fetchone()[0]
    except sqlite3.OperationalError as error:
        if 'interrupt' in str(error).lower():
            raise ValueError('inventory-cancelled') from error
        return {'total': None, 'groups': [], 'unavailable': True}
    return {'total': total, 'groups': [], 'unavailable': False}


def _inspect_database(path: Path, profile: _Profile, cancel, budget: InventoryBudget) -> dict[str, Any]:
    """Open the copy read only and classify every object, column and row group. Raises only on cancel/capacity."""
    with _database(path, cancel, budget) as db:
        state: dict[str, Any] = {'userVersion': None, 'quickCheck': 'ok', 'foreignKeyCheck': 'ok', 'objects': [], 'reasons': [],
                                 'counted': {'objects': 0, 'columns': 0}}
        try:
            state['userVersion'] = db.execute('PRAGMA user_version').fetchone()[0]
            quick = [tuple(row) for row in db.execute('PRAGMA quick_check')]
        except sqlite3.OperationalError as error:
            if 'interrupt' in str(error).lower():
                raise ValueError('inventory-cancelled') from error
            quick = [('failed',)]
        except sqlite3.DatabaseError:
            quick = [('failed',)]
        if quick != [('ok',)]:
            state['quickCheck'] = 'not-ok'
            state['reasons'].append('sqlite-invalid')
            return state
        _check(cancel)
        if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
            state['foreignKeyCheck'] = 'violations'
            state['reasons'].append('sqlite-foreign-key-invalid')
        version_ok = profile.version is None or state['userVersion'] == profile.version
        if not version_ok:
            state['reasons'].append('schema-version-unsupported')
        master = db.execute('SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name').fetchmany(budget.max_objects + 1)
        if len(master) > budget.max_objects:
            raise ValueError('inventory-capacity-exceeded')
        # Independent counts for the self check (a different query from the listing above).
        state['counted']['objects'] = db.execute('SELECT count(*) FROM sqlite_master').fetchone()[0]
        state['counted']['columns'] = db.execute(
            "SELECT count(*) FROM sqlite_master AS m, pragma_table_xinfo(m.name) WHERE m.type = 'table'").fetchone()[0]
        for kind, name, table in master:
            _check(cancel)
            state['objects'].append(_classify_object(db, profile, kind, name, table, version_ok, cancel, budget))
        return state


def _classify_object(db, profile: _Profile, kind: str, name: str, table: str, version_ok: bool, cancel,
                     budget: InventoryBudget) -> dict[str, Any]:
    base: dict[str, Any] = {'type': kind, 'name': name, 'columns': [], 'rows': None}
    if not version_ok and kind != 'table':
        return {**base, **_item(U, 'schema-version-unsupported')}     # every object, not only tables (3.2)
    if kind == 'index':
        if profile.indexes.get(name) == table and profile.known(table):
            return {**base, **_item(S, 'index-no-content')}
        match = _AUTOINDEX.fullmatch(name)
        if match and match.group(1) == table and profile.known(table):
            return {**base, **_item(S, 'index-no-content')}
        return {**base, **_item(U, 'unknown-index')}
    if kind in ('view', 'trigger'):
        return {**base, **_item(U, 'unknown-' + kind)}
    if kind != 'table':
        return {**base, **_item(U, 'unknown-object')}
    xinfo = db.execute(f'PRAGMA table_xinfo({_quote(name)})').fetchall()
    if len(xinfo) > budget.max_columns_per_table:
        raise ValueError('inventory-capacity-exceeded')
    actual = [row[1] for row in xinfo]
    hidden = [row[1] for row in xinfo if row[6] != 0]
    rows = _object_rows(db, name)
    result = {**base, 'rows': {'total': rows['total'], 'groups': []}}
    if not version_ok:
        result['columns'] = [{'name': column, **_item(U, 'schema-version-unsupported')} for column in actual]
        return {**result, **_item(U, 'schema-version-unsupported')}
    if name.startswith('sqlite_'):
        if name in _SQLITE_INTERNAL:
            result['columns'] = [{'name': column, **_item(S, 'sqlite-internal-no-content')} for column in actual]
            return {**result, **_item(S, 'sqlite-internal-no-content')}
        result['columns'] = [{'name': column, **_item(U, 'unknown-table')} for column in actual]
        return {**result, **_item(U, 'unknown-table')}
    if not profile.known(name):
        result['columns'] = [{'name': column, **_item(U, 'unknown-table')} for column in actual]
        return {**result, **_item(U, 'count-unavailable' if rows['unavailable'] else 'unknown-table')}
    if actual != profile.columns[name] or hidden:
        result['columns'] = [{'name': column, **_item(U, 'generated-or-hidden-column' if column in hidden else 'unknown-column')}
                             for column in actual]
        return {**result, **_item(U, 'generated-or-hidden-column' if hidden else 'unknown-column')}
    if rows['unavailable']:
        result['columns'] = [{'name': column, **_item(U, 'count-unavailable')} for column in actual]
        return {**result, **_item(U, 'count-unavailable')}
    if profile.kind == 'desktop-library':
        spec = LIBRARY_TABLES[name]
        result['columns'] = _column_results(spec, actual)
        groups = _library_groups(db, name, spec, cancel)
        nominal = next((reason for group in ('notebook', '*', 'pdf', 'markdown') for _c, category, reason in spec['groups'].get(group, [])
                        if category == R), 'library-metadata-not-converted')
    else:
        result['columns'] = [{'name': column, **_item(R, CANONICAL_ROW_REASON.get(name, 'canonical-store-present'))}
                             for column in actual]
        groups = _canonical_groups(db, name)
        nominal = CANONICAL_ROW_REASON.get(name, 'canonical-store-present')
    if sum(count for _group, count, _category, _reason in groups) != rows['total']:
        raise ValueError('inventory-self-check-failed')
    groups = sorted(groups, key=lambda value: (_group_rank(value[0]), value[0]))
    result['rows']['groups'] = [{'group': group, 'count': count, **_item(category, reason)}
                                for group, count, category, reason in groups]
    present = [(category, reason) for _group, count, category, reason in groups if count > 0]
    if not present:
        return {**result, **_item(R, nominal)}       # known, empty: reported, does not block
    worst = _worst(category for category, _reason in present)
    return {**result, **_item(worst, next(reason for category, reason in present if category == worst))}


def _database_state(kind: str, entries: dict, copy: Path, cancel, budget: InventoryBudget) -> dict[str, Any]:
    """Journal mode, companion files and (when safe) the opened database's inventory (3.2 steps 1-7)."""
    name = 'library.sqlite3' if kind == 'desktop-library' else 'content.sqlite3'
    profile = _Profile(kind, name)
    state: dict[str, Any] = {'key': [name], 'journalMode': None, 'walComplete': False, 'userVersion': None,
                             'quickCheck': None, 'foreignKeyCheck': None, 'objects': [], 'reasons': [],
                             'counted': {'objects': 0, 'columns': 0}, 'opened': False}
    entry = {'category': U, 'reason': 'sqlite-invalid'}
    wal = (name + '-wal',) in entries
    shm = (name + '-shm',) in entries
    companions = {'category': U, 'reason': 'sqlite-wal-unexpected'}
    mode, problem = _header(copy / name)
    state['journalMode'] = mode
    companion = sqlite_companion_state(mode, wal, shm) if mode is not None else None
    if (name + '-journal',) in entries:
        entry = {'category': R, 'reason': 'sqlite-rollback-journal-pending'}
        state['reasons'].append('sqlite-rollback-journal-pending')
        state['walComplete'] = mode == 'rollback' and not wal and not shm
    elif problem is not None:
        state['reasons'].append(problem)
    elif companion == 'unexpected':
        entry = {'category': U, 'reason': 'sqlite-wal-unexpected'}
        state['reasons'].append('sqlite-wal-unexpected')
    elif companion == 'incomplete':
        # A WAL database with exactly one companion in the manifest: part of its state is missing (the one with neither is
        # `closed`, below; DESIGN-r161-b7-staging.md section 9 item 2 and decision J5).
        entry = {'category': U, 'reason': 'sqlite-wal-incomplete'}
        companions = {'category': U, 'reason': 'sqlite-wal-incomplete'}
        state['reasons'].append('sqlite-wal-incomplete')
    else:
        state['walComplete'] = True
        state['opened'] = True
        # `closed`: header 2 and neither -wal nor -shm was captured, i.e. nothing held the database when it was captured
        # and the last connection folded the WAL into the main file. Complete by itself, so it is read like any other.
        entry = {'category': S, 'reason': 'sqlite-wal-closed' if companion == 'closed' else 'sqlite-database-inventoried'}
        companions = {'category': S, 'reason': 'sqlite-wal-complete'}
        inspected = _inspect_database(copy / name, profile, cancel, budget)
        for key in ('userVersion', 'quickCheck', 'foreignKeyCheck', 'objects', 'counted'):
            state[key] = inspected[key]
        state['reasons'].extend(inspected['reasons'])
        if 'sqlite-invalid' in inspected['reasons']:
            entry = {'category': U, 'reason': 'sqlite-invalid'}
            state['opened'] = False
        elif 'schema-version-unsupported' in inspected['reasons']:
            entry = {'category': U, 'reason': 'schema-version-unsupported'}
    state['entry'], state['companions'] = entry, companions
    return state


# ----- file and directory classification --------------------------------------------------------
_NOTEBOOK_TABLES = ('papers', 'pages', 'pdf_ink', 'bookmarks', 'messages', 'attachments', 'note_state', 'item_links',
                    'reference_research', 'paper_discovery')


def _tables_readable(db_state: dict | None, names: tuple[str, ...]) -> bool:
    """The database was opened and each named table has exactly its expected columns (row groups may still be unknown)."""
    if db_state is None or not db_state['opened']:
        return False
    tables = {item['name']: item for item in db_state['objects'] if item['type'] == 'table'}
    return all(name in tables and tables[name]['rows'] is not None and tables[name]['rows']['total'] is not None
               and all(column['category'] != U for column in tables[name]['columns']) for name in names)


def notebooks_listable(source: dict) -> bool:
    """True when notebook_ids and notebook_row_table can read this desktop-library source's tables."""
    return source['kind'] == 'desktop-library' and _tables_readable(source['sqlite'], _NOTEBOOK_TABLES)


def _library_items(db_state: dict | None, copy: Path, cancel, budget: InventoryBudget) -> tuple[dict | None, set | None]:
    """papers.id -> kind and the (owner, id, format) set of attachments, read from the opened database."""
    if not _tables_readable(db_state, ('papers', 'attachments')):
        return None, None
    with _database(copy / 'library.sqlite3', cancel, budget) as db:
        kinds = {row[0]: row[1] for row in db.execute('SELECT id, kind FROM papers')}
        attachments = {(row[0], row[1], row[2]) for row in db.execute('SELECT owner_id, id, format FROM attachments')}
    return kinds, attachments


def _library_entry(key: tuple[str, ...], db_state: dict | None, kinds: dict | None, attachments: set | None) -> tuple[str, str]:
    """Top-down rules, first match wins (DESIGN 3.4). Source of each name is given beside the rule."""
    name, top, solo = key[-1], key[0], len(key) == 1
    if solo and name == 'library.sqlite3':                           # storage.py
        entry = (db_state or {}).get('entry', _item(U, 'sqlite-invalid'))
        return entry['category'], entry['reason']
    if solo and name in ('library.sqlite3-wal', 'library.sqlite3-shm'):   # SQLite WAL companions
        companions = (db_state or {}).get('companions', _item(U, 'sqlite-wal-unexpected'))
        return companions['category'], companions['reason']
    if solo and name == 'library.sqlite3-journal':
        return R, 'sqlite-rollback-journal-pending'
    if solo and name == 'settings.json':                             # config.py (library settings)
        return R, 'library-settings-not-converted'
    if top == 'prompts' and len(key) == 2 and name.endswith('.txt'):   # prompts.py: data_directory()/prompts/<name>.txt
        return R, 'library-settings-not-converted'
    if (solo and name == 'before-unified-notes.sqlite3') or top == 'before-unified-notes-files':   # storage.py migrate_database
        return R, 'pre-migration-backup-retained'
    if top == '.note-imports' and len(key) == 2 and _HEX32_JSON.fullmatch(name):   # cloud_notes.py apply()
        return R, 'note-import-pending'
    if top == 'papers' and len(key) >= 3:
        if kinds is None:
            return U, 'item-index-unavailable'
        known = key[1] in kinds
        kind = kinds.get(key[1])
        rest = key[2:]
        if known and len(rest) == 1:
            file = rest[0]
            if file == 'notebook.json' and kind == 'notebook':       # paths.py PaperFiles.notebook_json
                return S, 'notebook-entry'
            if file == 'original.pdf':
                if kind == 'notebook':
                    return R, 'derived-file-retained'
                if kind == 'pdf':
                    return R, 'pdf-document-not-converted'
            if file in ('.notebook-change.json', '.notebook-before.pdf', '.notebook-after.pdf'):   # notebook.py
                return R, 'notebook-recovery-pending'
            if file == 'note.md':
                return (R, 'markdown-not-converted') if kind == 'markdown' else (R, 'legacy-memo-not-converted')
            if file == 'glossary.json':                              # terminology.py global_glossary(): glob papers/*/glossary.json
                return R, 'library-metadata-not-converted'           # old per-paper dictionary, kept intact beside the merged one
            if kind == 'pdf':
                if file in ('document.json', 'ocr-text.json'):       # paths.py, ocr.py
                    return R, 'derived-file-retained'
                if file in ('translated.pdf', 'interleaved.pdf', 'bilingual.pdf', 'translation.md', 'automatic-glossary.json') \
                        or _TRANSLATION_JSON.fullmatch(file):        # paths.py translation group
                    return R, 'translation-not-converted'
                if file in ('article.md', 'article-usage.json', 'article-review.json'):   # paths.py summary group
                    return R, 'summary-not-converted'
        if known and rest[0] == 'media' and len(rest) >= 2:
            if kind == 'markdown':
                return R, 'markdown-not-converted'
            if kind == 'pdf':
                return R, 'summary-not-converted'
        if known and kind == 'pdf' and rest[0] == 'translation-pages' and len(rest) >= 2:
            return R, 'translation-not-converted'
        if known and len(rest) == 2 and rest[0] == 'attachments' and attachments is not None:
            stem, _dot, extension = rest[1].rpartition('.')
            if extension in ('md', 'html') and (key[1], stem, extension) in attachments:   # PaperFiles.attachment
                return R, 'attachment-not-converted'
    if is_temporary(Path(name)):                                      # fileio.py: .<name>.<random>.tmp
        return R, 'interrupted-atomic-output'
    if top == 'papers' and len(key) >= 3 and kinds is not None and key[1] not in kinds:
        return U, 'orphan-item-folder'
    return U, 'unknown-file'


def _library_container(key: tuple[str, ...], kinds: dict | None) -> tuple[str, str]:
    if (len(key) == 1 and key[0] in ('papers', '.note-imports', 'prompts')) or key[0] == 'before-unified-notes-files':
        return S, 'directory-no-content'
    if key[0] == 'papers' and len(key) >= 2:
        if kinds is None:
            return U, 'item-index-unavailable'
        if key[1] not in kinds:
            return U, 'orphan-item-folder'
        if len(key) == 2 or (key[2] in ('attachments', 'media', 'translation-pages')):
            return S, 'directory-no-content'
    return U, 'unknown-directory'


def _canonical_entry(key: tuple, db_state: dict | None) -> tuple[str, str]:
    if key == ('content.sqlite3',):
        entry = (db_state or {}).get('entry', _item(U, 'sqlite-invalid'))
        return entry['category'], entry['reason']
    if key in (('content.sqlite3-wal',), ('content.sqlite3-shm',)):
        companions = (db_state or {}).get('companions', _item(U, 'sqlite-wal-unexpected'))
        return companions['category'], companions['reason']
    if key == ('content.sqlite3-journal',):
        return R, 'sqlite-rollback-journal-pending'
    if is_temporary(Path(key[-1])):
        return R, 'interrupted-atomic-output'
    return U, 'unknown-file'


def _device_entry(key: tuple, library_key: str) -> tuple[str, str]:
    name = key[-1]
    if key[0] == 'history' and len(key) >= 3:                         # local_history.py: history/<key>/...
        return R, 'legacy-history-not-converted'
    if len(key) == 1:
        if name in DEVICE_GLOBAL:                                     # legacy_device.GLOBAL_FILES
            return R, 'device-local-undecided'
        if name == library_key + '.json':                             # paths.sync_state_path
            return R, 'folder-sync-state-pending'
        if name == library_key + '.sync-blobs.json':                  # paths.sync_blobs_path
            return R, 'folder-sync-state-pending'
        if name == library_key + '.cloud-drive.json':                 # cloud_drive.py
            return R, 'drive-binding-undecided'
        if name in tuple(library_key + suffix for suffix in ('.fingerprint.json', '.review-pages.json', '.opened.json')):
            return R, 'device-local-undecided'                        # paths.py
        if name in tuple(library_key + '.search.sqlite3' + suffix for suffix in ('', '-wal', '-shm', '-journal')):
            return R, 'derived-file-retained'                         # paths.search_index_path
    if is_temporary(Path(name)):
        return R, 'interrupted-atomic-output'
    return U, 'unknown-file'


def _device_container(key: tuple) -> tuple[str, str]:
    if key[0] == 'history':
        return S, 'directory-no-content'
    return U, 'unknown-directory'


def _storage_location(copy: Path | None, entries: dict, budget: InventoryBudget, read_entry=None) -> dict[str, Any]:
    key = ('storage-location.json',)
    if key not in entries:
        return {'present': False, 'readable': True, 'pending': False}
    # Only a file over the size bound and a content that is not a JSON text are "unreadable" (a fact about the file, which stays in
    # the report as `storage-location-unreadable`). Every other failure of the read itself (an object whose hash or size no longer
    # matches, a source that changed, a missing entry, a cancel, an OS error) says the backup is not what the manifest claims:
    # it is raised, never turned into "unreadable" (work B7-d; REVIEW-r161-b7b low 1).
    try:
        if read_entry is not None:
            data = read_entry(entries[key], 65_536)
        elif copy is not None:
            data = _read_bounded_bytes(copy / key[0], 65_536)
        else:
            raise ValueError('inventory-copy-mismatch')       # nothing to read it from: a refusal, not "unreadable"
    except ValueError as error:
        if error.args != ('backup-read-limit',):
            raise
        return {'present': True, 'readable': False, 'pending': None}
    try:
        value = _json(data.decode('utf-8'))
    except ValueError:                                         # UnicodeError, JSONDecodeError and a non-finite number are ValueErrors
        return {'present': True, 'readable': False, 'pending': None}
    if not isinstance(value, dict):
        return {'present': True, 'readable': False, 'pending': None}
    return {'present': True, 'readable': True, 'pending': value.get('pending') is not None}


# ----- public: one source -----------------------------------------------------------------------
def notebook_ids(copy: Path, *, cancel=None, budget: InventoryBudget | None = None) -> list[str]:
    """papers.id of every kind='notebook' row of the copy's library database, sorted."""
    budget = budget or InventoryBudget()
    with _database(copy / 'library.sqlite3', cancel, budget) as db:
        return sorted(row[0] for row in db.execute("SELECT id FROM papers WHERE kind = 'notebook'"))


def inventory_source(kind: str, manifest: dict, copy: Path | None, *, library_key: str | None = None,
                     cancel: threading.Event | None = None, budget: InventoryBudget | None = None,
                     copied: frozenset | None = None, read_entry=None) -> dict[str, Any]:
    """Classify every entry, container, table, column and row group of one source (report 3.7 `sources[i]`).

    `kind` is the role: 'desktop-library', 'canonical' or 'device' (the manifest's own source kind does not
    tell a library from a canonical store). `copy` is the analysis copy of exactly this manifest.

    Shared partial copy (work B7-b): with `copied` (the manifest keys that `copy` holds: a database and its companions, from
    NativeLegacyBackup.sqlite_working_copy; `copy` is None when that set is empty) the copy's tree is required to equal those
    entries only, and the one other file this function reads (a device's storage-location.json) comes from
    `read_entry(entry, max_bytes)`, which returns the verified bytes of a manifest entry (NativeLegacyBackup.read_object).
    This function checks the tree first, before it opens the database: a copy must be fresh when it gets here, because opening
    a database changes the copy (module docstring).
    """
    budget = budget or InventoryBudget()
    if kind not in KINDS:
        raise ValueError('inventory-kind-invalid')
    if kind == 'device' and not (isinstance(library_key, str) and _HASH64.fullmatch(library_key)):
        raise ValueError('inventory-library-key-required')
    assert_backup_manifest(manifest)
    _check(cancel)
    if copied is not None and not isinstance(copied, frozenset):
        raise ValueError('inventory-copy-mismatch')
    _scan_copy(copy, manifest, cancel, copied)
    entries = {tuple(entry['key']): entry for entry in manifest['entries']}
    containers = sorted(tuple(key) for key in manifest['containers'])
    db_state = None
    database = ('library.sqlite3',) if kind == 'desktop-library' else ('content.sqlite3',) if kind == 'canonical' else None
    if database is not None and database in entries:
        if copied is not None and database not in copied:
            raise ValueError('inventory-copy-mismatch')       # the database is in the manifest but was not copied
        if copy is None:
            raise ValueError('inventory-copy-mismatch')
        db_state = _database_state(kind, entries, copy, cancel, budget)
    kinds, attachments = (_library_items(db_state, copy, cancel, budget) if kind == 'desktop-library' and copy is not None
                          else (None, None))
    classified_entries, classified_containers = [], []
    for key in sorted(entries):
        _check(cancel)
        if kind == 'desktop-library':
            category, reason = _library_entry(key, db_state, kinds, attachments)
        elif kind == 'canonical':
            category, reason = _canonical_entry(key, db_state)
        else:
            category, reason = _device_entry(key, library_key or '')
        classified_entries.append({'key': list(key), 'byteLength': entries[key]['byteLength'], **_item(category, reason)})
    for key in containers:
        if kind == 'desktop-library':
            category, reason = _library_container(key, kinds)
        elif kind == 'device':
            category, reason = _device_container(key)
        else:
            category, reason = U, 'unknown-directory'
        classified_containers.append({'key': list(key), **_item(category, reason)})
    missing = []
    if kind == 'desktop-library' and kinds is not None:
        for identifier, item_kind in sorted(kinds.items()):
            required = {'notebook': ('notebook.json', 'original.pdf'), 'pdf': ('original.pdf',)}.get(item_kind, ())
            for file in required:
                if ('papers', identifier, file) not in entries:
                    missing.append({'key': ['papers', identifier, file], **_item(U, 'item-file-missing')})
    sqlite_part = None
    if db_state is not None:
        sqlite_part = {key: db_state[key] for key in ('key', 'journalMode', 'walComplete', 'userVersion', 'quickCheck',
                                                      'foreignKeyCheck', 'objects', 'reasons', 'counted', 'opened')}
    source: dict[str, Any] = {
        'kind': kind, 'sourceId': manifest['source']['id'], 'backupId': manifest['id'],
        'inventorySha256': manifest['inventorySha256'], 'entryCount': len(entries), 'containerCount': len(containers),
        'totalBytes': sum(entry['byteLength'] for entry in entries.values()),
        'present': bool(entries or containers), 'entries': classified_entries, 'containers': classified_containers,
        'missing': missing, 'sqlite': sqlite_part}
    if kind == 'device':
        source['storageLocation'] = _storage_location(copy, entries, budget, read_entry)
        if source['storageLocation']['present'] and not source['storageLocation']['readable']:
            for item in classified_entries:
                if item['key'] == ['storage-location.json']:
                    item.update(_item(U, 'storage-location-unreadable'))
    return source


# ----- public: one notebook ---------------------------------------------------------------------
def notebook_row_table(copy: Path, manifest: dict, notebook_id: str, *, cancel=None,
                       budget: InventoryBudget | None = None, read_entry=None) -> dict[str, Any]:
    """SQLite rows of one notebook mapped to its page IDs (report 3.6), independent of the extractor.

    Row contents (text, quote, note, label, strokes) are never copied out; only numbers, sides, kinds and the
    stroke-array length. A notebook.json that is missing, altered or malformed gives `problem` and counts every
    row as unmapped, so such a notebook is never offered to the extractor.
    """
    budget = budget or InventoryBudget()
    if not isinstance(notebook_id, str) or not _ID.fullmatch(notebook_id):
        raise ValueError('inventory-notebook-id-invalid')
    _check(cancel)
    entry = next((item for item in manifest['entries'] if item['key'] == ['papers', notebook_id, 'notebook.json']), None)
    table: dict[str, Any] = {'sourceDocumentId': notebook_id, 'notebookEntry': None, 'revision': None, 'pageIds': [],
                             'pages': [], 'ink': [], 'bookmarks': [], 'relatedRows': {}, 'unmapped': 0, 'problem': None}
    document: dict | None = None
    if entry is None:
        table['problem'] = 'notebook-entry-missing'
    else:
        table['notebookEntry'] = {'sha256': entry['sha256'], 'byteLength': entry['byteLength']}
        if entry['byteLength'] > budget.max_value_bytes:
            raise ValueError('inventory-capacity-exceeded')
        # With a shared partial copy (B7-b) the notebook.json is not in the copy: read_entry(entry, max_bytes) gives its verified bytes.
        data = (read_entry(entry, budget.max_value_bytes) if read_entry is not None
                else _read_bounded_bytes(copy / 'papers' / notebook_id / 'notebook.json', budget.max_value_bytes))
        if len(data) != entry['byteLength'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            table['problem'] = 'notebook-entry-mismatch'
        else:
            try:
                document = _json(data.decode('utf-8'))
            except (UnicodeError, ValueError):
                table['problem'] = 'notebook-json-invalid'
    if document is not None:
        pages = document.get('pages') if isinstance(document, dict) else None
        if (not isinstance(document, dict) or set(document) != {'version', 'revision', 'pages'} or type(document['revision']) is not int
                or not isinstance(pages, list) or not pages
                or any(not isinstance(page, dict) or not isinstance(page.get('id'), str) or not _ID.fullmatch(page['id']) for page in pages)
                or len({page['id'] for page in pages}) != len(pages)):
            table['problem'] = 'notebook-shape-unsupported'
        else:
            table['revision'] = document['revision']
            table['pageIds'] = [page['id'] for page in pages]
    ids: list[str] = table['pageIds']

    def page_id(value: Any) -> str | None:
        return ids[value - 1] if type(value) is int and 1 <= value <= len(ids) else None

    with _database(copy / 'library.sqlite3', cancel, budget) as db:
        row = db.execute('SELECT kind, sha256, pages FROM papers WHERE id = ?', (notebook_id,)).fetchone()
        if row is None or row[0] != 'notebook':
            raise ValueError('inventory-notebook-not-found')
        if table['problem'] is None and (row[1] != f"notebook:{notebook_id}:{table['revision']}" or row[2] != len(ids)):
            table['problem'] = 'notebook-marker-or-count-mismatch'
        table['pages'] = [{'number': number, 'pageId': page_id(number)}
                          for (number,) in db.execute('SELECT number FROM pages WHERE paper_id = ? ORDER BY number', (notebook_id,))]
        budget_left = budget.max_value_bytes
        for side, page, strokes in db.execute('SELECT side, page, strokes FROM pdf_ink WHERE paper_id = ? ORDER BY side, page', (notebook_id,)):
            _check(cancel)
            count = None
            if isinstance(strokes, str):
                budget_left -= len(strokes.encode('utf-8'))
                if budget_left < 0:
                    raise ValueError('inventory-capacity-exceeded')
                try:
                    value = _json(strokes)
                    count = len(value) if isinstance(value, list) else None
                except ValueError:
                    count = None
            mapped = page_id(page) if side == 'original' else None
            table['ink'].append({'side': side, 'page': page, 'pageId': mapped, 'strokeCount': count})
        for identifier, page, side, kind in db.execute('SELECT id, page, side, kind FROM bookmarks WHERE paper_id = ? ORDER BY id', (notebook_id,)):
            table['bookmarks'].append({'id': str(identifier), 'page': page, 'side': side, 'kind': kind,
                                       'pageId': page_id(page) if side == 'original' else None})
        count_of = lambda sql, *args: db.execute(sql, args).fetchone()[0]   # noqa: E731
        table['relatedRows'] = {
            'messages': count_of('SELECT count(*) FROM messages WHERE paper_id = ?', notebook_id),
            'attachments': count_of('SELECT count(*) FROM attachments WHERE owner_id = ?', notebook_id),
            'noteState': count_of('SELECT count(*) FROM note_state WHERE id = ? OR id IN (SELECT id FROM papers WHERE parent_id = ?)',
                                  notebook_id, notebook_id),
            'itemLinks': count_of('SELECT count(*) FROM item_links WHERE a = ? OR b = ?', notebook_id, notebook_id),
            'children': count_of('SELECT count(*) FROM papers WHERE parent_id = ?', notebook_id),
            'referenceResearch': count_of('SELECT count(*) FROM reference_research WHERE source = ?', notebook_id),
            'paperDiscovery': count_of('SELECT count(*) FROM paper_discovery WHERE source = ?', notebook_id)}
    unmapped = (sum(1 for item in table['pages'] if item['pageId'] is None)
                + sum(1 for item in table['ink'] if item['pageId'] is None or item['strokeCount'] is None)
                + sum(1 for item in table['bookmarks'] if item['pageId'] is None))
    if table['problem'] is not None:
        unmapped = max(1, len(table['pages']) + len(table['ink']) + len(table['bookmarks']))
    table['unmapped'] = unmapped
    return table


# ----- public: pending stores, report, assessment -----------------------------------------------
def _store(location: str, collected: bool, count: int | None, category: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {'location': location, 'collected': collected, 'count': count, **_item(category, reason), **extra}


def _counted(location: str, count: int, reason: str) -> dict[str, Any]:
    return _store(location, True, count, R if count else S, reason if count else 'pending-store-empty')


def _object(source: dict | None, name: str) -> dict | None:
    sqlite_part = (source or {}).get('sqlite')
    return next((item for item in (sqlite_part or {}).get('objects', []) if item['type'] == 'table' and item['name'] == name), None)


def _shaped(item: dict | None) -> bool:
    """The table exists with exactly its expected columns and could be counted (an unknown row group is still counted)."""
    return (item is not None and item['rows'] is not None and item['rows']['total'] is not None
            and all(column['category'] != U for column in item['columns']))


def _total(item: dict | None) -> int:
    return int(((item or {}).get('rows') or {}).get('total') or 0)


def _groups_of(item: dict | None) -> list[dict]:
    return list(((item or {}).get('rows') or {}).get('groups', []))


def pending_stores(sources: list[dict]) -> list[dict]:
    """Every place a pending write could live (3.5), with whether it was collected and how many items it holds."""
    by_kind = {source['kind']: source for source in sources}
    library, canonical, device = by_kind.get('desktop-library'), by_kind.get('canonical'), by_kind.get('device')
    rows: list[dict] = []
    missing = lambda location: _store(location, False, None, U, 'uncollected-source')   # noqa: E731

    def files(source: dict | None, reason: str, name: str | None = None) -> int:
        return sum(1 for item in (source or {}).get('entries', [])
                   if item['reason'] == reason and (name is None or item['key'][-1] == name))

    if library is None:
        rows += [missing('library:.note-imports'), missing('library:papers/*/.notebook-change.json'),
                 missing('library:library.sqlite3-wal'), missing('library:note_operations')]
    else:
        rows.append(_counted('library:.note-imports', files(library, 'note-import-pending'), 'note-import-pending'))
        rows.append(_counted('library:papers/*/.notebook-change.json', files(library, 'notebook-recovery-pending', '.notebook-change.json'),
                             'notebook-recovery-pending'))
        wal = next((item for item in library['entries'] if item['key'] == ['library.sqlite3-wal']), None)
        sqlite_part = library.get('sqlite')
        complete = bool(sqlite_part and sqlite_part['walComplete'])
        if wal is None:
            closed = bool(sqlite_part and sqlite_part['journalMode'] == 'wal' and complete)    # a WAL database that was closed normally
            rows.append(_store('library:library.sqlite3-wal', True, 0, S, 'sqlite-wal-closed' if closed else 'pending-store-empty',
                               walComplete=complete))
        else:
            rows.append(_store('library:library.sqlite3-wal', True, 1, wal['category'], wal['reason'], walComplete=complete))
        table = _object(library, 'note_operations')
        if not _shaped(table):
            rows.append(_store('library:note_operations', True, None, U, 'sqlite-not-inventoried'))
        else:
            rows.append(_counted('library:note_operations', _total(table), 'note-operation-history-not-converted'))
    if canonical is None:
        rows += [missing(location) for location, _table, _group, _reason in CANONICAL_PENDING_STORES]
    elif not canonical['present']:
        rows += [_store(location, True, 0, S, 'pending-store-empty', present=False)
                 for location, _table, _group, _reason in CANONICAL_PENDING_STORES]
    else:
        opened = bool((canonical.get('sqlite') or {}).get('opened'))
        for location, table, group, reason in CANONICAL_PENDING_STORES:
            item = _object(canonical, table)
            if item is None and opened and table in CANONICAL_LAZY_TABLES:
                rows.append(_store(location, True, 0, S, 'pending-store-empty', present=True))     # the table was never created
            elif not _shaped(item):
                rows.append(_store(location, True, None, U, 'sqlite-not-inventoried', present=True))
            else:
                count = _total(item) if group is None else sum(entry['count'] for entry in _groups_of(item) if entry['group'] == group)
                rows.append({**_counted(location, count, reason), 'present': True})
    if device is None:
        rows += [missing('device:<libraryKey>.json'), missing('device:<libraryKey>.cloud-drive.json'),
                 missing('device:storage-location.json#pending')]
    else:
        state_files = sum(1 for item in device['entries'] if len(item['key']) == 1 and item['reason'] == 'folder-sync-state-pending'
                          and not item['key'][0].endswith('.sync-blobs.json'))
        rows.append(_counted('device:<libraryKey>.json', state_files, 'folder-sync-state-pending'))
        rows.append(_counted('device:<libraryKey>.cloud-drive.json', files(device, 'drive-binding-undecided'), 'drive-binding-undecided'))
        location = device.get('storageLocation', {})
        if location.get('present') and not location.get('readable'):
            rows.append(_store('device:storage-location.json#pending', True, None, U, 'storage-location-unreadable'))
        elif location.get('pending'):
            rows.append(_store('device:storage-location.json#pending', True, 1, U, 'storage-location-pending'))
        else:
            rows.append(_store('device:storage-location.json#pending', True, 0, S, 'pending-store-empty'))
    rows += [missing(location) for location in UNCOLLECTED]
    return rows


def _source_reasons(source: dict) -> list[tuple[str, str]]:
    """(category, reason) of everything in a source that blocks a whole-Library conversion."""
    found = [(item['category'], item['reason']) for item in (*source['entries'], *source['containers'], *source['missing'])
             if item['category'] != S]
    sqlite_part = source.get('sqlite')
    if sqlite_part:
        found += [(U, reason) for reason in sqlite_part['reasons']]
        for item in sqlite_part['objects']:
            if item['category'] == U:
                found.append((U, item['reason']))
            found += [(U, column['reason']) for column in item['columns'] if column['category'] == U]
            for group in (item['rows'] or {}).get('groups', []):
                if group['count'] > 0 and group['category'] != S:
                    found.append((group['category'], group['reason']))
    return found


def _units(source: dict) -> list[str]:
    units = [item['category'] for item in (*source['entries'], *source['containers'], *source['missing'])]
    for item in (source.get('sqlite') or {}).get('objects', []):
        units.append(item['category'])
        units += [group['category'] for group in (item['rows'] or {}).get('groups', []) if group['count'] > 0]
    return units


def _notebook_rows(ordered: list[dict]) -> int:
    """papers.kind='notebook' rows of the desktop-library source, read from its own row groups. When the notebook
    tables cannot be read (no library source, database not opened, another schema) no notebook table may exist: 0."""
    library = next((source for source in ordered if source['kind'] == 'desktop-library'), None)
    if library is None or not notebooks_listable(library):
        return 0
    return sum(group['count'] for group in _groups_of(_object(library, 'papers')) if group['group'] == 'notebook')


def build_report(sources: list[dict], notebooks: list[dict], *, budget: InventoryBudget | None = None) -> dict[str, Any]:
    """Assemble the report, then refuse it (inventory-self-check-failed) unless every count agrees (3.7)."""
    budget = budget or InventoryBudget()
    ordered = sorted(sources, key=lambda source: KINDS.index(source['kind']))
    if len({source['kind'] for source in ordered}) != len(ordered):
        raise ValueError('inventory-source-duplicate')
    stores = pending_stores(ordered)
    uncollected = [{'location': store['location'], 'category': U, 'reason': 'uncollected-source'} for store in stores if not store['collected']]
    ordered_notebooks = sorted(notebooks, key=lambda table: table['sourceDocumentId'])
    notebook_ids = [table['sourceDocumentId'] for table in ordered_notebooks]
    if len(set(notebook_ids)) != len(notebook_ids):
        raise ValueError('inventory-self-check-failed')      # one notebook listed twice could stand in for a missing one
    categories = [category for source in ordered for category in _units(source)] + [U] * len(uncollected)
    found = [pair for source in ordered for pair in _source_reasons(source)]
    found += [(store['category'], store['reason']) for store in stores if store['category'] != S and store['count'] != 0]
    if any(table['unmapped'] > 0 for table in ordered_notebooks):
        found.append((U, 'notebook-annotation-unmapped'))
    if any(table.get('problem') for table in ordered_notebooks):
        found.append((U, 'notebook-extraction-blocked'))
    report: dict[str, Any] = {
        'version': VERSION, 'scope': SCOPE, 'sources': ordered, 'pendingStores': stores, 'uncollected': uncollected,
        'notebooks': ordered_notebooks,
        'summary': {'supported': categories.count(S), 'retainedBlocking': categories.count(R), 'unknown': categories.count(U),
                    'blockingReasons': sorted({reason for _category, reason in found})},
        'selfCheck': {
            'entries': [sum(source['entryCount'] for source in ordered), sum(len(source['entries']) for source in ordered)],
            'containers': [sum(source['containerCount'] for source in ordered), sum(len(source['containers']) for source in ordered)],
            'objects': [sum((source['sqlite'] or {}).get('counted', {}).get('objects', 0) for source in ordered),
                        sum(len((source['sqlite'] or {}).get('objects', [])) for source in ordered)],
            'columns': [sum((source['sqlite'] or {}).get('counted', {}).get('columns', 0) for source in ordered),
                        sum(len(item['columns']) for source in ordered for item in (source['sqlite'] or {}).get('objects', [])
                            if item['type'] == 'table')],
            'notebooks': [_notebook_rows(ordered), len(ordered_notebooks)]}}
    if any(left != right for left, right in report['selfCheck'].values()):
        raise ValueError('inventory-self-check-failed')
    report['reportSha256'] = edit_content_hash(report)
    if len(json.dumps(report, ensure_ascii=True, allow_nan=False).encode('utf-8')) > budget.max_report_bytes:
        raise ValueError('inventory-capacity-exceeded')
    return report


def whole_library_assessment(report: dict) -> dict[str, Any]:
    """B6 never accepts a whole-Library conversion: WebView, Drive, other peers and browsers are uncollected."""
    reasons = set(report['summary']['blockingReasons']) | {'uncollected-source'}
    return {'status': 'refused', 'reasons': sorted(reasons)}

