"""Row extraction of a Native legacy Library for the staging conversion (work B7-d, DESIGN-r161-b7-staging.md 7.1).

Pure and read only: it reads the verified working copy's `library.sqlite3` (the shared copy of NativeLegacyBackup.sqlite_working_copy,
after the inventory has checked its tree) and, for a Markdown note's `note.md` mirror, the verified bytes of a backup object that the
caller hands over as `read_entry(entry, max_bytes)` (NativeLegacyBackup.read_object). It writes nothing, stores nothing and is called
from no route, CLI or startup path (callers are tests only, until the staging writer of work B7-f).

What it returns (all in memory):
  rows    the rows the converters need: every `papers` row (all columns, raw), the folders (normalized paths with their ancestors),
          the links resolved to {pdfId, noteId}, the Markdown notes (content, revision, the `note.md` mirror check, media entries)
          and the PDFs (page rows, original-side ink and bookmark rows, the original.pdf entry). THESE CONTAIN TITLES AND BODIES.
  report  only keys, counts, reason codes and hashes: no title, no body, no quote, no path, no exception text.
          Its `counts` are made by separate aggregate queries, independent of the way `rows` are collected, and the two are compared
          before anything is returned (`staging-rows-count-mismatch`): the same rule as legacy_inventory.notebook_row_table.
Every row that is returned carries `sourceSha256` (DESIGN 3.5): edit_content_hash([table, columns, values]) of the raw values read from
the copy (a BLOB value is replaced by its sha256 and length), so that the writer can recompute it from a fresh copy and compare.

`normalize_notebook_table` makes a B6 notebook row table safe for the TypeScript manifest check (REVIEW-r161-b6d low 2): a row the
manifest cannot hold (negative or non-integer page, an empty or over-long side/kind) gets a placeholder label and no page ID, and the
Notebook is blocked instead of the whole manifest being refused. `row_reasons` adds `notebook-rows-not-listable` when the rows cannot
be read for a reason that is not the WAL rule (REVIEW-r161-b6c low 4).

Closed exception codes (ValueError, never an exception text, a value or a path): staging-rows-cancelled, -capacity-exceeded,
-copy-changed, -count-mismatch, -schema-unsupported, -unreadable, -value-unhashable, -invalid-argument.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from dataclasses import dataclass
import copy as _copy
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any

from papeer.core.collection_paths import collection_ancestors, normalize_collection_name
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.migrations import legacy_inventory
from papeer.core.migrations.legacy_backup import assert_backup_manifest
from papeer.core.migrations.legacy_notebook_backup import _COLUMNS, _OPTIONAL_COLUMNS

SCOPE = 'native-legacy-staging-rows-v1'
VERSION = 1
MIB = 1024 * 1024
# Interval (SQLite virtual-machine steps) of the progress handler that checks `cancel`. Tests lower it.
PROGRESS_INTERVAL = 1000
ROW_BATCH = 256                    # rows between two explicit cancel checks
KINDS = ('pdf', 'markdown', 'notebook')
DATABASE = 'library.sqlite3'
UNREADABLE = 'unreadable'          # the label a row the manifest cannot hold gets (the Notebook is blocked, the row only counted)
MAX_COUNT = 2 ** 53 - 1            # the largest integer the TypeScript manifest check (Number.isSafeInteger) accepts
REASONS = tuple('staging-rows-' + name for name in (
    'cancelled', 'capacity-exceeded', 'copy-changed', 'count-mismatch', 'schema-unsupported', 'unreadable', 'value-unhashable',
    'invalid-argument'))
PAPER_COLUMNS = tuple(_COLUMNS['papers'].split())
_BOOKMARK_COLUMNS = tuple(_COLUMNS['bookmarks'].split())
_ID = re.compile(r'^[0-9a-f]{32}$')
_BOOKMARK_ID = re.compile(r'^[1-9][0-9]{0,18}$')    # frontend/src/migrations/legacyConversionInput.ts
_NOTE_KINDS = ('note', 'highlight')
# The tables this module reads, each exactly as storage.MIGRATIONS 1-9 leave it (legacy_notebook_backup._COLUMNS).
_TABLES = ('papers', 'pages', 'pdf_ink', 'bookmarks', 'collections', 'item_links', 'note_state', 'note_legacy')


@dataclass(frozen=True)
class RowBudget:
    """Bounds of one extraction. Overrunning one is a refusal (`staging-rows-capacity-exceeded`), never a truncation."""
    max_items: int = 100_000           # papers rows
    max_rows: int = 2_000_000          # rows of every table read, together
    max_value_bytes: int = 6 * MIB     # one stored value (also the largest note.md that is compared)
    max_total_bytes: int = 128 * MIB   # every text value held in `rows`, together

    def __post_init__(self):
        for value in (self.max_items, self.max_rows, self.max_value_bytes, self.max_total_bytes):
            if type(value) is not int or value < 0:
                raise ValueError('staging-rows-invalid-argument')


def _cancelled(cancel) -> bool:
    return cancel is not None and cancel.is_set()


def _check(cancel) -> None:
    if _cancelled(cancel):
        raise ValueError('staging-rows-cancelled')


# ----- hashing ------------------------------------------------------------------------------------
def _plain(value: Any) -> Any:
    """A raw SQLite value as JSON content (edit_content_hash takes no bytes)."""
    if isinstance(value, bytes):
        return {'blob': hashlib.sha256(value).hexdigest(), 'bytes': len(value)}
    return value


def source_hash(table: str, columns, values) -> str:
    """The `source_sha256` of one row (DESIGN 3.5 source_kind 'row'): edit_content_hash([table, columns, values])."""
    try:
        return edit_content_hash([table, list(columns), [_plain(value) for value in values]])
    except ValueError:
        raise ValueError('staging-rows-value-unhashable') from None


def rows_hash(hashes) -> str:
    """The `source_sha256` of a set of rows (source_kind 'rows'): the hash of the ascending list of the row hashes."""
    return edit_content_hash(sorted(hashes))


# ----- the database ---------------------------------------------------------------------------------
@contextmanager
def _database(path: Path, cancel, budget: RowBudget):
    """The working copy's database, read only; cancel is polled by SQLite itself and values are length-bounded."""
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, max(4096, budget.max_value_bytes))
            db.set_progress_handler(lambda: 1 if _cancelled(cancel) else 0, max(1, PROGRESS_INTERVAL))
            db.execute('PRAGMA query_only=ON')
            yield db
    except sqlite3.DataError:
        raise ValueError('staging-rows-capacity-exceeded') from None
    except sqlite3.OperationalError as error:
        if 'interrupt' in str(error).lower():
            raise ValueError('staging-rows-cancelled') from None
        raise ValueError('staging-rows-unreadable') from None
    except sqlite3.Error:
        raise ValueError('staging-rows-unreadable') from None


def _assert_schema(db) -> None:
    """The Library is schema 9 and the tables read here have exactly the known columns (any other table is the inventory's business)."""
    if db.execute('PRAGMA user_version').fetchone()[0] != legacy_inventory.SCHEMA_VERSION:
        raise ValueError('staging-rows-schema-unsupported')
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_'")}
    if not set(_COLUMNS) <= tables or not tables - set(_COLUMNS) <= set(_OPTIONAL_COLUMNS):
        raise ValueError('staging-rows-schema-unsupported')
    for name in _TABLES:
        actual = db.execute('PRAGMA table_xinfo("' + name + '")').fetchall()
        if [row[1] for row in actual] != _COLUMNS[name].split() or any(row[6] != 0 for row in actual):
            raise ValueError('staging-rows-schema-unsupported')


class _Meter:
    """Row and byte budgets, and the cancel check every few rows."""

    def __init__(self, budget: RowBudget, cancel):
        self.budget, self.cancel, self.rows, self.bytes = budget, cancel, 0, 0

    def take(self, row=()) -> None:
        self.rows += 1
        if self.rows > self.budget.max_rows:
            raise ValueError('staging-rows-capacity-exceeded')
        if self.rows % ROW_BATCH == 0:
            _check(self.cancel)
        for value in row:
            if isinstance(value, str):
                self.bytes += len(value.encode('utf-8', 'surrogatepass'))
            elif isinstance(value, bytes):
                self.bytes += len(value)
        if self.bytes > self.budget.max_total_bytes:
            raise ValueError('staging-rows-capacity-exceeded')


def _is_count(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_COUNT


def _js_length(value: str) -> int:
    return len(value.encode('utf-16-le', 'surrogatepass')) // 2     # the length JavaScript's String.length reports


def _bucket_side(side: Any) -> str:
    return 'original' if side == 'original' else 'other'


def _bucket_kind(kind: Any) -> str:
    return kind if kind in _NOTE_KINDS else 'other'


_STROKE_COUNT = ("CASE WHEN typeof(strokes) = 'text' AND json_valid(strokes) AND json_type(strokes) = 'array' "
                 "THEN json_array_length(strokes) END")


def _strokes(text: Any) -> list | None:
    """The stroke list of an ink row, or None when the value is not a JSON array (the row is then unmapped)."""
    if not isinstance(text, str):
        return None

    def reject(_value: str) -> None:
        raise ValueError('nonfinite')
    try:
        value = json.loads(text, parse_constant=reject)
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, list) else None


# ----- reasons ---------------------------------------------------------------------------------------
def _wal_rule_failed(source: dict) -> bool:
    """conversion_input._library_tables' condition: the database is not WAL-complete, or the inventory says its WAL is incomplete.
    `walComplete` is false by default (header unreadable, a -journal beside it, a companion beside a rollback database all leave it
    false), so this is NOT the same as "the WAL is the cause"."""
    database = source.get('sqlite')
    return database is not None and (database['walComplete'] is not True or 'sqlite-wal-incomplete' in database['reasons'])


def _wal_incomplete(source: dict) -> bool:
    """The WAL rule's own verdict (a WAL database with exactly one companion): the inventory already reports it as `sqlite-wal-incomplete`."""
    database = source.get('sqlite')
    return database is not None and 'sqlite-wal-incomplete' in database['reasons']


def rows_listable(source: dict) -> bool:
    """True when this desktop-library source's rows can be read: the notebook tables are readable (legacy_inventory.notebooks_listable),
    so are the two tables only this module reads, and the WAL rule holds (the same condition as conversion_input._library_tables)."""
    return (legacy_inventory.notebooks_listable(source) and not _wal_rule_failed(source)
            and legacy_inventory._tables_readable(source['sqlite'], ('collections', 'note_legacy')))


def row_reasons(source: dict) -> list[str]:
    """Reasons to add to the staging report when the rows cannot be listed: `notebook-rows-not-listable` for every cause but the WAL
    rule (a WAL database with exactly one companion, which already has its own reason, `sqlite-wal-incomplete`, in the inventory).
    A header that is not SQLite's, a -journal beside the database, a companion beside a rollback database, an unknown column, a
    database that could not be opened: none of these is the WAL rule, so each gets `notebook-rows-not-listable`."""
    if source.get('kind') != 'desktop-library':
        raise ValueError('staging-rows-invalid-argument')
    return [] if rows_listable(source) or _wal_incomplete(source) else ['notebook-rows-not-listable']


# ----- normalization of B6 notebook row tables -----------------------------------------------------------
def normalize_notebook_table(table: dict) -> dict:
    """A copy of a legacy_inventory.notebook_row_table result that the TypeScript manifest check can always read.

    A row it cannot hold is replaced, not dropped, so that the counts stay: a page or bookmark `page` that is not an integer in
    0..2^53-1 becomes null, a `side` or `kind` that is not 1..64 characters long (JavaScript length) and a page `number` or a
    bookmark `id` outside the manifest's forms become a placeholder (`unreadable`, 0, '1'), and the row's pageId is null (unmapped).
    The notebook then gets `problem` `notebook-rows-unreadable`; pages rows that are not exactly 1..n get
    `notebook-page-rows-not-contiguous` (the extractor would refuse them too). `unmapped` is recomputed the way notebook_row_table
    does it, so a notebook with any of this is blocked (conversion_input) and never extracted. The input is not changed.
    """
    result = _copy.deepcopy(table)
    unreadable = False

    def label(value: Any) -> str:
        nonlocal unreadable
        if isinstance(value, str) and 1 <= _js_length(value) <= 64:
            return value
        unreadable = True
        return UNREADABLE

    def page(value: Any) -> int | None:
        nonlocal unreadable
        if value is None or _is_count(value):
            return value
        unreadable = True
        return None

    for row in result['pages']:
        if not _is_count(row['number']):
            row['number'], row['pageId'], unreadable = 0, None, True
    for row in result['ink']:
        row['side'], row['page'] = label(row['side']), page(row['page'])
        if row['page'] is None or row['side'] == UNREADABLE:
            row['pageId'] = None
        if row['strokeCount'] is not None and not _is_count(row['strokeCount']):
            row['strokeCount'], unreadable = None, True
    for row in result['bookmarks']:
        row['side'], row['kind'], row['page'] = label(row['side']), label(row['kind']), page(row['page'])
        if not (isinstance(row['id'], str) and _BOOKMARK_ID.fullmatch(row['id'])):
            row['id'], unreadable = '1', True
        if row['page'] is None or UNREADABLE in (row['side'], row['kind']):
            row['pageId'] = None
    if result['problem'] is None:
        numbers = [row['number'] for row in result['pages']]
        if unreadable:
            result['problem'] = 'notebook-rows-unreadable'
        elif result['pageIds'] and numbers != list(range(1, len(result['pageIds']) + 1)):
            result['problem'] = 'notebook-page-rows-not-contiguous'
    total = len(result['pages']) + len(result['ink']) + len(result['bookmarks'])
    unmapped = (sum(1 for row in result['pages'] if row['pageId'] is None)
                + sum(1 for row in result['ink'] if row['pageId'] is None or row['strokeCount'] is None)
                + sum(1 for row in result['bookmarks'] if row['pageId'] is None))
    result['unmapped'] = max(1, total) if result['problem'] is not None else unmapped
    return result


# ----- extraction ------------------------------------------------------------------------------------
def _paper_rows(db, meter: _Meter) -> list[dict]:
    items = []
    columns = ', '.join(PAPER_COLUMNS)
    for values in db.execute(f'SELECT {columns} FROM papers ORDER BY id'):
        if len(items) >= meter.budget.max_items:
            raise ValueError('staging-rows-capacity-exceeded')
        meter.take(values)
        raw = dict(zip(PAPER_COLUMNS, values, strict=True))
        path = normalize_collection_name(raw['collection_name']) if isinstance(raw['collection_name'], str) else None
        items.append({'id': raw['id'], 'kind': raw['kind'], 'columns': raw, 'collectionPath': path,
                      'collectionParts': path.split(' / ') if path else [],
                      'sourceSha256': source_hash('papers', PAPER_COLUMNS, values)})
    return items


def _folders(db, items: list[dict], meter: _Meter) -> list[dict]:
    """Every folder (a normalized path) that a `collections` row or a paper's collection_name names, with all its ancestors.

    A folder's source rows are every row that makes it exist: the rows that name it and the rows that name a folder below it."""
    direct: dict[str, list[str]] = {}
    empty = 0
    for (name,) in db.execute('SELECT name FROM collections ORDER BY name'):
        meter.take((name,))
        path = normalize_collection_name(name) if isinstance(name, str) else ''
        if not path:
            empty += 1
            continue
        direct.setdefault(path, []).append(source_hash('collections', ('name',), (name,)))
    for item in items:
        if item['collectionPath']:
            direct.setdefault(item['collectionPath'], []).append(item['sourceSha256'])
    sources: dict[str, list[str]] = {}
    for path, hashes in direct.items():
        for ancestor in collection_ancestors(path):
            sources.setdefault(ancestor, []).extend(hashes)
    folders = []
    for path in sorted(sources, key=lambda value: value.split(' / ')):
        parts = path.split(' / ')
        folders.append({'path': path, 'parts': parts, 'parent': ' / '.join(parts[:-1]) or None,
                        'rowCount': len(sources[path]), 'sourceSha256': rows_hash(sources[path])})
    return folders


def _links(db, items: list[dict], meter: _Meter) -> list[dict]:
    """item_links (a < b) resolved to {pdfId, noteId}: one end a stand-alone PDF, the other a stand-alone Notebook or Markdown note
    (the pairs item_relations.link_items and notebook.link allow). Anything else is kept, unresolved, with its reason."""
    by_id = {item['id']: item for item in items}
    links = []
    for a, b in db.execute('SELECT a, b FROM item_links ORDER BY a, b'):
        meter.take((a, b))
        first, second = by_id.get(a), by_id.get(b)
        link = {'a': a, 'b': b, 'status': 'unresolved', 'reason': None, 'pdfId': None, 'noteId': None, 'noteKind': None,
                'sourceSha256': source_hash('item_links', ('a', 'b'), (a, b))}
        if first is None or second is None:
            link['reason'] = 'link-endpoint-missing'
        elif any(end['columns']['parent_id'] is not None for end in (first, second)):
            link['reason'] = 'link-endpoint-owned'
        elif sorted(end['kind'] for end in (first, second)) not in (['notebook', 'pdf'], ['markdown', 'pdf']):
            link['reason'] = 'link-kinds-unsupported'
        else:
            pdf, note = sorted((first, second), key=lambda end: end['kind'] != 'pdf')
            link.update(status='resolved', pdfId=pdf['id'], noteId=note['id'], noteKind=note['kind'])
        links.append(link)
    return links


def _markdown(db, items: list[dict], manifest: dict, read_entry, meter: _Meter) -> tuple[list[dict], dict]:
    entries = {tuple(entry['key']): entry for entry in manifest['entries']}
    ids = [item['id'] for item in items if item['kind'] == 'markdown']
    states, legacy = {}, {}
    for values in db.execute('SELECT id, revision, content, source, updated_at FROM note_state ORDER BY id'):
        meter.take(values)
        states[values[0]] = values
    for values in db.execute('SELECT id, note_id FROM note_legacy ORDER BY id'):
        meter.take(values)
        legacy[values[0]] = values
    lengths = {row[0]: row[1] for row in db.execute(
        "SELECT id, CASE WHEN typeof(content) = 'text' THEN length(CAST(content AS BLOB)) END FROM note_state")}
    notes, independent = [], {}
    for identifier in ids:
        _check(meter.cancel)
        state = states.get(identifier)
        note: dict[str, Any] = {'id': identifier, 'state': 'present' if state else 'missing', 'revision': None, 'source': None,
                                'updatedAt': None, 'legacyNoteId': legacy[identifier][1] if identifier in legacy else None,
                                'content': None, 'contentBytes': None, 'contentSha256': None, 'mirror': 'unchecked',
                                'media': [], 'sourceSha256': None, 'legacySourceSha256': (
                                    source_hash('note_legacy', ('id', 'note_id'), legacy[identifier]) if identifier in legacy else None)}
        encoded = None
        if state:
            note.update(revision=state[1], source=state[3], updatedAt=state[4], content=state[2] if isinstance(state[2], str) else None,
                        sourceSha256=source_hash('note_state', ('id', 'revision', 'content', 'source', 'updated_at'), state))
            if isinstance(state[2], str):
                try:
                    encoded = state[2].encode('utf-8')
                except UnicodeEncodeError:
                    encoded = None
            if encoded is not None:
                note.update(contentBytes=len(encoded), contentSha256=hashlib.sha256(encoded).hexdigest())
                if lengths.get(identifier) != len(encoded):
                    raise ValueError('staging-rows-count-mismatch')
        entry = entries.get(('papers', identifier, 'note.md'))
        if read_entry is not None:
            if entry is None:
                note['mirror'] = 'missing'
            else:
                try:
                    mirror = read_entry(entry, meter.budget.max_value_bytes)
                except ValueError as error:
                    if error.args == ('backup-read-limit',):
                        raise ValueError('staging-rows-capacity-exceeded') from None
                    raise
                note['mirror'] = 'match' if encoded is not None and mirror == encoded else 'mismatch'
        note['media'] = [{'name': '/'.join(key[3:]), 'sha256': entries[key]['sha256'], 'byteLength': entries[key]['byteLength']}
                         for key in sorted(entries) if key[:3] == ('papers', identifier, 'media') and len(key) >= 4]
        independent[identifier] = {'contentBytes': note['contentBytes'], 'contentSha256': note['contentSha256']}
        notes.append(note)
    id_set = set(ids)
    other = sum(1 for identifier in states if identifier not in id_set)
    return notes, {'notes': independent, 'noteStateOtherRows': other, 'noteLegacyRows': len(legacy)}


def _pdfs(items: list[dict], manifest: dict) -> list[dict]:
    entries = {tuple(entry['key']): entry for entry in manifest['entries']}
    pdfs: dict[str, dict] = {}
    for item in items:
        if item['kind'] != 'pdf':
            continue
        pages = item['columns']['pages']
        entry = entries.get(('papers', item['id'], 'original.pdf'))
        pdfs[item['id']] = {
            'id': item['id'], 'pagesColumn': pages if type(pages) is int else None,
            'file': None if entry is None else {'sha256': entry['sha256'], 'byteLength': entry['byteLength']},
            'fileMatchesRow': None if entry is None else entry['sha256'] == item['columns']['sha256'],
            'counts': {}, 'pageNumbers': [], 'inkRows': [], 'bookmarkRows': [], 'annotationPages': {}, 'problems': []}
    return list(pdfs.values())


def _page_facts(db, kinds: dict[str, str], meter: _Meter) -> tuple[dict[str, dict], dict[str, tuple]]:
    """Page rows per PDF and Notebook (one pass) and, from an aggregate query, what each paper's page rows should be:
    (rows, rows with text, numbers are exactly 1..n). The caller compares the two for every PDF and Notebook."""
    facts: dict[str, dict] = {}
    for paper_id, number, text in db.execute(
            "SELECT paper_id, number, typeof(text) = 'text' AND length(text) > 0 FROM pages ORDER BY paper_id, number"):
        meter.take()
        if kinds.get(paper_id) in ('pdf', 'notebook'):
            fact = facts.setdefault(paper_id, {'numbers': [], 'text': 0})
            fact['numbers'].append(number)
            fact['text'] += 1 if text else 0
    independent = {}
    for paper_id, rows, text, low, high, distinct, integers in db.execute(
            "SELECT paper_id, count(*), sum(typeof(text) = 'text' AND length(text) > 0), min(number), max(number), "
            "count(DISTINCT number), sum(typeof(number) = 'integer') FROM pages GROUP BY paper_id"):
        independent[paper_id] = (rows, text, rows > 0 and integers == rows and low == 1 and high == rows and distinct == rows)
    for fact in facts.values():
        fact['contiguous'] = fact['numbers'] == list(range(1, len(fact['numbers']) + 1))
    return facts, independent


def _annotation_facts(db, items_by_id: dict[str, dict], meter: _Meter) -> tuple[dict, dict]:
    """Ink and bookmark rows of every PDF and Notebook.

    Notebook rows are only counted (the Notebook's rows come from legacy_inventory.notebook_row_table and the existing extractor).
    A PDF's original-side rows are kept with their content and source hash; its other-side rows are kept as counts only."""
    ink: dict[str, list[dict]] = {}
    marks: dict[str, list[dict]] = {}
    query = ("SELECT t.paper_id, t.side, t.page, " + _STROKE_COUNT.replace('strokes', 't.strokes') + ", "
             "CASE WHEN p.kind = 'pdf' AND t.side = 'original' THEN t.strokes END FROM pdf_ink t "
             "LEFT JOIN papers p ON p.id = t.paper_id ORDER BY t.paper_id, t.side, t.page")
    for paper_id, side, page, count, strokes in db.execute(query):
        meter.take((strokes,))
        item = items_by_id.get(paper_id)
        if item is None or item['kind'] not in ('pdf', 'notebook'):
            continue
        row = {'side': side, 'page': page, 'strokeCount': count}
        if item['kind'] == 'pdf' and side == 'original':
            parsed = _strokes(strokes) if count is not None else None     # SQLite does not call it a JSON array: unreadable
            if parsed is not None and len(parsed) != count:
                raise ValueError('staging-rows-count-mismatch')
            row.update(strokes=parsed, strokeCount=None if parsed is None else len(parsed),
                       sourceSha256=source_hash('pdf_ink', ('paper_id', 'side', 'page', 'strokes'), (paper_id, side, page, strokes)))
        ink.setdefault(paper_id, []).append(row)
    columns = ', '.join(_BOOKMARK_COLUMNS)
    for values in db.execute(f"SELECT {columns} FROM bookmarks ORDER BY id"):
        raw = dict(zip(_BOOKMARK_COLUMNS, values, strict=True))
        item = items_by_id.get(raw['paper_id'])
        if item is None or item['kind'] not in ('pdf', 'notebook'):
            meter.take()
            continue
        if item['kind'] == 'pdf' and raw['side'] == 'original':
            meter.take(values)
            marks.setdefault(raw['paper_id'], []).append({
                'id': str(raw['id']), 'side': raw['side'], 'page': raw['page'], 'kind': raw['kind'],
                'record': {**raw, 'id': str(raw['id'])}, 'sourceSha256': source_hash('bookmarks', _BOOKMARK_COLUMNS, values)})
        else:
            meter.take((raw['side'], raw['kind']))
            marks.setdefault(raw['paper_id'], []).append({'id': str(raw['id']), 'side': raw['side'], 'page': raw['page'], 'kind': raw['kind']})
    return ink, marks


def _tally(ink: list[dict], marks: list[dict]) -> dict[str, Any]:
    result = {'ink': {'original': 0, 'other': 0}, 'strokes': {'original': 0, 'other': 0},
              'bookmarks': {kind: {'original': 0, 'other': 0} for kind in (*_NOTE_KINDS, 'other')}}
    for row in ink:
        bucket = _bucket_side(row['side'])
        result['ink'][bucket] += 1
        result['strokes'][bucket] += row['strokeCount'] or 0
    for row in marks:
        result['bookmarks'][_bucket_kind(row['kind'])][_bucket_side(row['side'])] += 1
    return result


def _independent_tally(db, kinds: dict[str, str]) -> dict[str, dict]:
    """The same tally from aggregate queries (not from the rows above)."""
    result: dict[str, dict] = {}
    for paper_id, side, rows, strokes in db.execute(
            "SELECT paper_id, CASE WHEN side = 'original' THEN 'original' ELSE 'other' END, count(*), "
            f"sum(coalesce({_STROKE_COUNT}, 0)) FROM pdf_ink GROUP BY 1, 2"):
        if kinds.get(paper_id) in ('pdf', 'notebook'):
            entry = result.setdefault(paper_id, _tally([], []))
            entry['ink'][side], entry['strokes'][side] = rows, strokes
    for paper_id, kind, side, rows in db.execute(
            "SELECT paper_id, CASE WHEN kind IN ('note', 'highlight') THEN kind ELSE 'other' END, "
            "CASE WHEN side = 'original' THEN 'original' ELSE 'other' END, count(*) FROM bookmarks GROUP BY 1, 2, 3"):
        if kinds.get(paper_id) in ('pdf', 'notebook'):
            result.setdefault(paper_id, _tally([], []))['bookmarks'][kind][side] = rows
    return result


def _aggregate_counts(db, items: list[dict], folders: list[dict], links: list[dict]) -> dict[str, Any]:
    """Item, folder and link counts from queries of their own, compared with what the passes above collected."""
    by_kind = {kind: count for kind, count in db.execute('SELECT kind, count(*) FROM papers GROUP BY kind')}
    counts = {'pdf': 0, 'markdown': 0, 'notebook': 0, 'other': 0}
    for kind, count in by_kind.items():
        counts[kind if kind in KINDS else 'other'] += count
    held = db.execute('SELECT count(*) FROM papers WHERE parent_id IS NOT NULL').fetchone()[0]
    names = [row[0] for row in db.execute('SELECT name FROM collections UNION SELECT collection_name FROM papers')]
    paths = {ancestor for name in names if isinstance(name, str) for ancestor in collection_ancestors(name)}
    link_total = db.execute('SELECT count(*) FROM item_links').fetchone()[0]
    collected = {'pdf': 0, 'markdown': 0, 'notebook': 0, 'other': 0}
    for item in items:
        collected[item['kind'] if item['kind'] in KINDS else 'other'] += 1
    if (counts != collected or len(paths) != len(folders) or {folder['path'] for folder in folders} != paths
            or link_total != len(links) or held != sum(1 for item in items if item['columns']['parent_id'] is not None)):
        raise ValueError('staging-rows-count-mismatch')
    resolved = sum(1 for link in links if link['status'] == 'resolved')
    return {'items': {**counts, 'held': held}, 'folders': len(paths),
            'links': {'total': link_total, 'resolved': resolved, 'unresolved': link_total - resolved}}


def extract_staging_rows(db_path: Path, manifest: dict, source: dict, *, read_entry=None, cancel=None, budget: RowBudget | None = None,
                         verify_copy: bool = True) -> dict[str, Any]:
    """The rows and the independent counts of the Library database of a verified working copy.

    `db_path` is `library.sqlite3` inside the shared copy of NativeLegacyBackup.sqlite_working_copy (the inventory has already
    checked the copy's tree and opened it), `manifest` is the Library backup's manifest, `source` the inventory's result for it
    (legacy_inventory.inventory_source). `read_entry(entry, max_bytes)` returns the verified bytes of a manifest entry
    (NativeLegacyBackup.read_object); without it the `note.md` mirror is `unchecked`.

    When the rows cannot be listed (`rows_listable` is false) nothing is read: `rows` is None and `reasons` says why
    (`notebook-rows-not-listable` unless the WAL rule is the cause). Otherwise the database is read once, every count is checked
    against an independent query (`staging-rows-count-mismatch`) and, when `verify_copy`, the database file (and its -wal) is
    checked against the manifest again before anything is returned: this is a last use of the copy, so a change made inside the
    copy while it was read is refused (`staging-rows-copy-changed`, REVIEW-r161-b7b low 3).
    """
    budget = budget or RowBudget()
    if not isinstance(db_path, Path) or db_path.name != DATABASE or not isinstance(manifest, dict) or not isinstance(source, dict):
        raise ValueError('staging-rows-invalid-argument')
    assert_backup_manifest(manifest)
    _check(cancel)
    head = {'version': VERSION, 'scope': SCOPE, 'manifest': {'id': manifest['id'], 'inventorySha256': manifest['inventorySha256']}}
    if source.get('kind') != 'desktop-library':
        raise ValueError('staging-rows-invalid-argument')
    if not rows_listable(source):
        return {**head, 'listable': False, 'reasons': row_reasons(source), 'rows': None,
                'report': {**head, 'listable': False, 'reasons': row_reasons(source), 'counts': None, 'sourceSha256': None}}
    meter = _Meter(budget, cancel)
    with _database(db_path, cancel, budget) as db:
        _assert_schema(db)
        db.execute('BEGIN')
        items = _paper_rows(db, meter)
        kinds = {item['id']: item['kind'] for item in items}
        items_by_id = {item['id']: item for item in items}
        folders = _folders(db, items, meter)
        links = _links(db, items, meter)
        counts = _aggregate_counts(db, items, folders, links)
        markdown, markdown_counts = _markdown(db, items, manifest, read_entry, meter)
        pages, page_counts = _page_facts(db, kinds, meter)
        ink, marks = _annotation_facts(db, items_by_id, meter)
        independent = _independent_tally(db, kinds)
        pdfs = _pdfs(items, manifest)
        pdf_by_id = {pdf['id']: pdf for pdf in pdfs}
        notebooks = []
        for item in items:
            if item['kind'] not in ('pdf', 'notebook'):
                continue
            _check(cancel)
            identifier = item['id']
            fact = pages.get(identifier, {'numbers': [], 'text': 0, 'contiguous': False})
            if page_counts.get(identifier, (0, 0, False)) != (len(fact['numbers']), fact['text'], fact['contiguous']):
                raise ValueError('staging-rows-count-mismatch')
            tally = _tally(ink.get(identifier, []), marks.get(identifier, []))
            if independent.get(identifier, _tally([], [])) != tally:
                raise ValueError('staging-rows-count-mismatch')
            common = {'pageRows': len(fact['numbers']), 'pageTextRows': fact['text'], 'pageNumbersContiguous': fact['contiguous'], **tally}
            if item['kind'] == 'notebook':
                notebooks.append({'id': identifier, **common})
                continue
            pdf = pdf_by_id[identifier]
            pdf.update(counts=common, pageNumbers=fact['numbers'], inkRows=ink.get(identifier, []), bookmarkRows=marks.get(identifier, []))
            pdf['annotationPages'] = _annotation_pages(pdf)
            pdf['problems'] = _problems(pdf)
        db.execute('ROLLBACK')
    if verify_copy:
        _assert_unchanged(db_path, manifest, cancel)
    counts.update(
        markdown={'notes': markdown_counts['notes'], 'noteStateOtherRows': markdown_counts['noteStateOtherRows'],
                  'noteLegacyRows': markdown_counts['noteLegacyRows']},
        pdfs={pdf['id']: {'pagesColumn': pdf['pagesColumn'], **pdf['counts']} for pdf in pdfs},
        notebooks={item['id']: {key: item[key] for key in ('pageRows', 'pageTextRows', 'pageNumbersContiguous', 'ink', 'strokes', 'bookmarks')}
                   for item in notebooks})
    digests = {'items': rows_hash(item['sourceSha256'] for item in items), 'folders': rows_hash(folder['sourceSha256'] for folder in folders),
               'links': rows_hash(link['sourceSha256'] for link in links),
               'markdown': rows_hash(filter(None, (note['sourceSha256'] for note in markdown))),
               'pdfAnnotations': rows_hash(row['sourceSha256'] for pdf in pdfs for row in (*pdf['inkRows'], *pdf['bookmarkRows'])
                                           if 'sourceSha256' in row)}
    digests['rowSet'] = edit_content_hash(digests)
    reasons: list[str] = []
    report = {**head, 'listable': True, 'reasons': reasons, 'counts': counts, 'sourceSha256': digests}
    rows = {'items': items, 'folders': folders, 'links': links, 'markdown': markdown, 'pdfs': pdfs, 'notebooks': notebooks}
    return {**head, 'listable': True, 'reasons': reasons, 'rows': rows, 'report': report}


def _annotation_pages(pdf: dict) -> dict[int, dict]:
    """Per page of a PDF, the original-side annotation rows on it: their count and the hash of their row hashes (source_kind 'rows')."""
    pages: dict[int, list[str]] = {}
    for row in (*pdf['inkRows'], *pdf['bookmarkRows']):
        if row['side'] == 'original' and 'sourceSha256' in row and type(row['page']) is int and pdf['pagesColumn'] is not None \
                and 1 <= row['page'] <= pdf['pagesColumn']:
            pages.setdefault(row['page'], []).append(row['sourceSha256'])
    return {page: {'rowCount': len(hashes), 'sourceSha256': rows_hash(hashes)} for page, hashes in sorted(pages.items())}


def _problems(pdf: dict) -> list[str]:
    """Facts about a PDF that stop it from being converted, as closed codes (the writer decides what to do with them)."""
    found = []
    if pdf['file'] is None:
        found.append('pdf-file-missing')
    elif pdf['fileMatchesRow'] is False:
        found.append('pdf-file-hash-mismatch')
    if pdf['pagesColumn'] is None or pdf['pagesColumn'] != pdf['counts']['pageRows']:
        found.append('pdf-page-count-mismatch')
    if not pdf['counts']['pageNumbersContiguous']:
        found.append('pdf-page-rows-not-contiguous')
    rows = (*pdf['inkRows'], *pdf['bookmarkRows'])
    in_range = sum(1 for row in rows if row['side'] == 'original' and type(row['page']) is int
                   and pdf['pagesColumn'] is not None and 1 <= row['page'] <= pdf['pagesColumn'])
    original = sum(1 for row in rows if row['side'] == 'original')
    if in_range != original:
        found.append('pdf-annotation-unmapped')
    if any(row.get('strokes', []) is None for row in pdf['inkRows']):
        found.append('pdf-annotation-unreadable')
    return sorted(found)


def _assert_unchanged(db_path: Path, manifest: dict, cancel) -> None:
    """The database (and its -wal when the manifest holds one) is still byte-identical to the manifest: opening it read only
    changed neither, and nothing else wrote to the copy while it was read."""
    keys = {tuple(entry['key']) for entry in manifest['entries']}
    names = tuple(name for name in (DATABASE, DATABASE + '-wal') if (name,) in keys)
    try:
        legacy_inventory.assert_copy_unchanged(db_path.parent, manifest, names, cancel=cancel)
    except ValueError as error:
        if error.args == ('inventory-cancelled',):
            raise ValueError('staging-rows-cancelled') from None
        raise ValueError('staging-rows-copy-changed') from None
    except OSError:
        raise ValueError('staging-rows-copy-changed') from None
