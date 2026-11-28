"""Work B7-d: the row extraction of the staging conversion and two small fixes of work B7-b (synthetic, isolated data only).

DESIGN-r161-b7-staging.md 7.1 and 12.2 RX-1..RX-10, plus REVIEW-r161-b7b low 1 (a storage-location read that fails for any reason
but the size bound or a JSON error is refused) and low 3 (a shared working copy is checked against the manifest again after its last
use). A synthetic schema-9 Library is captured with NativeLegacyBackup, the inventory opens the shared SQLite-only working copy
first (as conversion_input does), and papeer.core.migrations.legacy_staging_rows reads it. Expected figures are written by hand from
the fixture, read straight from SQLite by this test, or taken from `Synthetic.expected`; never from the module under test.
The TypeScript half (RX-3) runs the existing bridge under plain node with a manifest this test seals itself.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import threading
import uuid

import pytest

from _synthetic_legacy_library import SENTINELS, build_synthetic_library, sqlite_names
from papeer.core import collection_paths
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.migrations import legacy_inventory, legacy_staging_rows as rows_module
from papeer.core.migrations.legacy_inventory import inventory_source, notebook_row_table
from papeer.core.migrations.legacy_staging_rows import RowBudget, extract_staging_rows, normalize_notebook_table, row_reasons

FRONTEND = Path(__file__).resolve().parents[2] / 'frontend'
BRIDGE = FRONTEND / 'tests' / 'migrations' / 'conversionInputBridge.ts'
COLLECTION_CASES = json.loads((Path(__file__).resolve().parents[1] / 'fixtures' / 'collection_paths.json').read_text('utf-8'))['normalize']
MARK = ("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
        " VALUES(?,?,?,?,?,?,.2,.3,?,?,?)")
STROKES = json.dumps([{'id': 's0', 'color': '#000000', 'width': .01, 'points': [[.1, .2], [.3, .4]]}])
TITLES = ('Synthetic PDF', 'Synthetic memo', 'Synthetic notebook A', 'Synthetic notebook B')


def library_of(synthetic, captured):
    capture = captured['desktop-library']
    manifest = capture.manifest
    return capture, manifest, sqlite_names('desktop-library', manifest)


def extract(synthetic, captured, *, before=None, with_mirror=True, **options):
    """What conversion_input does with the Library copy: the inventory first (it checks the tree and opens the database), then the rows."""
    capture, manifest, names = library_of(synthetic, captured)

    def read_entry(entry, max_bytes):
        return capture.backup.read_object(manifest['id'], entry, max_bytes=max_bytes)

    with capture.backup.sqlite_working_copy(manifest['id'], names) as copy:
        source = inventory_source('desktop-library', manifest, copy, copied=frozenset((name,) for name in names), read_entry=read_entry)
        if before is not None:
            before(copy, source)
        return extract_staging_rows(copy / 'library.sqlite3', manifest, source, read_entry=read_entry if with_mirror else None, **options)


def fresh(tmp_path, *, sql=(), **options):
    synthetic = build_synthetic_library(tmp_path / 'library', **options)
    if sql:
        synthetic.sql(*sql)
    return synthetic, synthetic.capture()


def by_id(rows, key):
    return {item['id']: item for item in rows[key]}


def refused(code, call, *args, **kwargs):
    with pytest.raises(ValueError) as error:
        call(*args, **kwargs)
    assert error.value.args == (code,), error.value.args
    assert error.value.__cause__ is None and (error.value.__context__ is None or error.value.__suppress_context__)
    return error.value


def direct(synthetic, sql, *args):
    with closing(sqlite3.connect(synthetic.root / 'library.sqlite3')) as db:
        return db.execute(sql, args).fetchall()


def plain(value):
    return {'blob': hashlib.sha256(value).hexdigest(), 'bytes': len(value)} if isinstance(value, bytes) else value


def hash_of(table, columns, values):
    """The row hash, written out here from the DESIGN (3.5), not taken from the module."""
    return edit_content_hash([table, list(columns), [plain(value) for value in values]])


# RX-1 ------------------------------------------------------------------------------------------------------------------
def test_the_main_fixture_rows_and_independent_counts_equal_the_source(tmp_path):
    synthetic, captured = fresh(tmp_path)
    result = extract(synthetic, captured)
    a, b, m, p = (synthetic.ids[key] for key in 'ABMP')
    assert result['listable'] is True and result['reasons'] == [] and result['report']['listable'] is True
    counts, rows = result['report']['counts'], result['rows']
    # Hand-written from the fixture (tests/_synthetic_legacy_library.py).
    assert counts['items'] == {'pdf': 1, 'markdown': 1, 'notebook': 2, 'other': 0, 'held': 0}
    assert counts['folders'] == 2 and [folder['path'] for folder in rows['folders']] == ['Folder', 'Folder / Sub']
    assert [(folder['parts'], folder['parent']) for folder in rows['folders']] == [(['Folder'], None), (['Folder', 'Sub'], 'Folder')]
    assert counts['links'] == {'total': 1, 'resolved': 1, 'unresolved': 0}
    link = rows['links'][0]
    assert (link['status'], link['pdfId'], link['noteId'], link['noteKind'], link['reason']) == ('resolved', p, a, 'notebook', None)
    assert counts['pdfs'] == {p: {'pagesColumn': 1, 'pageRows': 1, 'pageTextRows': 1, 'pageNumbersContiguous': True,
                                  'ink': {'original': 1, 'other': 0}, 'strokes': {'original': 1, 'other': 0},
                                  'bookmarks': {'note': {'original': 1, 'other': 0}, 'highlight': {'original': 0, 'other': 0},
                                                'other': {'original': 0, 'other': 0}}}}
    pdf = rows['pdfs'][0]
    assert pdf['problems'] == [] and pdf['fileMatchesRow'] is True and pdf['file']['sha256'] == by_id(rows, 'items')[p]['columns']['sha256']
    assert [(row['page'], row['strokeCount']) for row in pdf['inkRows']] == [(1, 1)] and len(pdf['inkRows'][0]['strokes']) == 1
    assert [(row['page'], row['kind'], row['side']) for row in pdf['bookmarkRows']] == [(1, 'note', 'original')]
    assert pdf['bookmarkRows'][0]['record']['quote'] == 'SENTINEL-QUOTE' and isinstance(pdf['bookmarkRows'][0]['id'], str)
    assert pdf['annotationPages'] == {1: {'rowCount': 2, 'sourceSha256': pdf['annotationPages'][1]['sourceSha256']}}
    # The Notebooks: the numbers Synthetic.expected counted from SQLite and notebook.json.
    assert sorted(counts['notebooks']) == sorted([a, b])
    for identifier in (a, b):
        expected, found = synthetic.expected['notebooks'][identifier], counts['notebooks'][identifier]
        assert found['pageRows'] == expected['pages'] and found['pageNumbersContiguous'] is True
        assert found['ink'] == {'original': expected['inkRows'], 'other': 0} and found['strokes'] == {'original': expected['strokes'], 'other': 0}
        assert found['bookmarks']['note']['original'] == expected['notes'] and found['bookmarks']['highlight']['original'] == expected['highlights']
    assert [item['id'] for item in rows['notebooks']] == sorted([a, b])
    # The Markdown note: bytes and hash counted from the stored text.
    text = direct(synthetic, 'SELECT content FROM note_state WHERE id = ?', m)[0][0]
    note = rows['markdown'][0]
    assert (note['id'], note['state'], note['content'], note['mirror']) == (m, 'present', '# memo\nSENTINEL-MEMO-BODY', 'match')
    assert note['contentBytes'] == len(text.encode('utf-8')) and note['contentSha256'] == hashlib.sha256(text.encode('utf-8')).hexdigest()
    assert counts['markdown']['notes'] == {m: {'contentBytes': note['contentBytes'], 'contentSha256': note['contentSha256']}}
    assert note['media'] == [] and note['legacyNoteId'] is None
    # Every papers row, raw, with its kind and folder.
    items = by_id(rows, 'items')
    assert sorted(items) == sorted(synthetic.ids.values()) and {i: items[i]['kind'] for i in items} == {a: 'notebook', b: 'notebook', m: 'markdown', p: 'pdf'}
    assert items[b]['collectionPath'] == 'Folder / Sub' and items[b]['collectionParts'] == ['Folder', 'Sub'] and items[m]['collectionParts'] == []
    assert list(items[p]['columns']) == list(rows_module.PAPER_COLUMNS) and items[p]['columns']['title'] == 'Synthetic PDF'
    assert not [path for path in tmp_path.rglob('.analysis-*')]


@pytest.mark.parametrize('options', [{'wal': True}, {'wal_closed': True}], ids=['wal-open', 'wal-closed'])
def test_a_wal_library_is_read_and_its_copy_is_still_the_manifest_afterwards(tmp_path, options):
    synthetic, captured = fresh(tmp_path, **options)
    result = extract(synthetic, captured)            # verify_copy is on: the database (and the -wal) must still equal the manifest
    assert result['listable'] is True
    if 'wal' in options:
        # A row that exists only in the WAL is read, so the WAL really is part of what was read.
        assert 'WAL only folder' in [folder['path'] for folder in result['rows']['folders']]
        assert result['report']['counts']['folders'] == 3
        assert {('library.sqlite3-wal',), ('library.sqlite3-shm',)} <= {tuple(entry['key']) for entry in captured['desktop-library'].manifest['entries']}
    else:
        assert result['report']['counts']['folders'] == 2


# RX-2 ------------------------------------------------------------------------------------------------------------------
def test_source_hashes_are_the_designed_formula_and_deterministic(tmp_path):
    synthetic, captured = fresh(tmp_path)
    first, second = extract(synthetic, captured), extract(synthetic, captured)
    assert first['report'] == second['report'] and first['rows'] == second['rows']
    assert first['report']['sourceSha256']['rowSet'] == edit_content_hash({key: value for key, value in first['report']['sourceSha256'].items() if key != 'rowSet'})
    # A new capture of the same Library (new backup, new run) gives the same hashes: nothing time or random enters them.
    again = extract(synthetic, synthetic.capture())
    assert again['report']['sourceSha256'] == first['report']['sourceSha256'] and again['rows']['items'] == first['rows']['items']
    p, m = synthetic.ids['P'], synthetic.ids['M']
    items, columns = by_id(first['rows'], 'items'), tuple(rows_module.PAPER_COLUMNS)
    with closing(sqlite3.connect(synthetic.root / 'library.sqlite3')) as db:
        for identifier in synthetic.ids.values():
            values = db.execute(f'SELECT {", ".join(columns)} FROM papers WHERE id = ?', (identifier,)).fetchone()
            assert items[identifier]['sourceSha256'] == hash_of('papers', columns, values)
        ink = db.execute('SELECT paper_id, side, page, strokes FROM pdf_ink WHERE paper_id = ?', (p,)).fetchone()
        assert first['rows']['pdfs'][0]['inkRows'][0]['sourceSha256'] == hash_of('pdf_ink', ('paper_id', 'side', 'page', 'strokes'), ink)
        bookmark_columns = tuple(rows_module._BOOKMARK_COLUMNS)
        mark = db.execute(f'SELECT {", ".join(bookmark_columns)} FROM bookmarks WHERE paper_id = ?', (p,)).fetchone()
        assert first['rows']['pdfs'][0]['bookmarkRows'][0]['sourceSha256'] == hash_of('bookmarks', bookmark_columns, mark)
        state = db.execute('SELECT id, revision, content, source, updated_at FROM note_state WHERE id = ?', (m,)).fetchone()
        assert first['rows']['markdown'][0]['sourceSha256'] == hash_of('note_state', ('id', 'revision', 'content', 'source', 'updated_at'), state)
        pair = db.execute('SELECT a, b FROM item_links').fetchone()
    assert first['rows']['links'][0]['sourceSha256'] == hash_of('item_links', ('a', 'b'), pair)
    folder = {item['path']: item for item in first['rows']['folders']}
    # 'Folder' exists because of its own collections row, the paper P in it, and the folder below it (rows that name it or lie below).
    assert folder['Folder']['rowCount'] == 1 + 1 + 1 + 1       # collections 'Folder' and 'Folder / Sub', papers P and B
    assert folder['Folder']['sourceSha256'] == edit_content_hash(sorted([
        hash_of('collections', ('name',), ('Folder',)), hash_of('collections', ('name',), ('Folder / Sub',)),
        items[p]['sourceSha256'], items[synthetic.ids['B']]['sourceSha256']]))
    assert folder['Folder / Sub']['rowCount'] == 2


def test_a_changed_row_changes_exactly_its_own_hashes(tmp_path):
    synthetic, captured = fresh(tmp_path)
    before = extract(synthetic, captured)
    m, p = synthetic.ids['M'], synthetic.ids['P']
    synthetic.sql(("UPDATE papers SET title = 'renamed' WHERE id = ?", (m,)))
    after = extract(synthetic, synthetic.capture())
    old, new = by_id(before['rows'], 'items'), by_id(after['rows'], 'items')
    assert [i for i in old if old[i]['sourceSha256'] != new[i]['sourceSha256']] == [m]
    digests = {key: before['report']['sourceSha256'][key] != after['report']['sourceSha256'][key] for key in before['report']['sourceSha256']}
    assert digests == {'items': True, 'folders': False, 'links': False, 'markdown': False, 'pdfAnnotations': False, 'rowSet': True}
    synthetic.sql(("UPDATE note_state SET content = 'changed' WHERE id = ?", (m,)))
    changed = extract(synthetic, synthetic.capture(), with_mirror=False)
    assert changed['report']['sourceSha256']['markdown'] != after['report']['sourceSha256']['markdown']
    assert changed['rows']['markdown'][0]['contentSha256'] == hashlib.sha256(b'changed').hexdigest() and p in {i['id'] for i in changed['rows']['items']}


@pytest.mark.parametrize('update, field', [
    ("UPDATE papers SET collection_name = 'Moved' WHERE kind = 'pdf'", 'items'),
    ("INSERT INTO collections(name) VALUES('Another')", 'folders')])
def test_a_folder_row_changes_the_folder_digest_only_where_it_belongs(tmp_path, update, field):
    synthetic, captured = fresh(tmp_path)
    before = extract(synthetic, captured)
    synthetic.sql(update)
    after = extract(synthetic, synthetic.capture())
    assert after['report']['sourceSha256']['folders'] != before['report']['sourceSha256']['folders']
    assert (after['report']['sourceSha256']['items'] != before['report']['sourceSha256']['items']) == (field == 'items')


# RX-3 ------------------------------------------------------------------------------------------------------------------
BAD_ROWS = (
    ("INSERT INTO pages VALUES(?, -3, '')", lambda a: (a,)),
    ("INSERT INTO pdf_ink VALUES(?, '', -1, ?)", lambda a: (a, STROKES)),
    ("INSERT INTO pdf_ink VALUES(?, ?, 1, ?)", lambda a: (a, 'x' * 65, STROKES)),
    (MARK, lambda a: (a, 1.5, 'original', 'q', 'l', 'n', '', '', '[]')),
    (MARK, lambda a: (a, 1, 'original', 'q', 'l', 'n', 'k' * 65, 'yellow', '[]')),
    (MARK, lambda a: (a, 2, 'o' * 65, 'q', 'l', 'n', 'k' * 65, '', '[]')))


def poisoned(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    a = synthetic.ids['A']
    synthetic.sql(*((sql, make(a)) for sql, make in BAD_ROWS))
    captured = synthetic.capture()
    capture, manifest, names = library_of(synthetic, captured)
    with capture.backup.sqlite_working_copy(manifest['id'], names) as copy:
        source = inventory_source('desktop-library', manifest, copy, copied=frozenset((name,) for name in names),
                                  read_entry=lambda entry, limit: capture.backup.read_object(manifest['id'], entry, max_bytes=limit))
        tables = [notebook_row_table(copy, manifest, identifier, read_entry=lambda entry, limit: capture.backup.read_object(
            manifest['id'], entry, max_bytes=limit)) for identifier in legacy_inventory.notebook_ids(copy)]
    return synthetic, source, tables


def sealed_manifest(tables):
    """A manifest in the form conversion_input builds, with every Notebook blocked (nothing is extracted), sealed like the product."""
    def blocked(table):
        return {'sourceDocumentId': table['sourceDocumentId'], 'notebookEntry': table['notebookEntry'], 'pageIds': table['pageIds'],
                'rows': {key: table[key] for key in ('pages', 'ink', 'bookmarks')}, 'status': 'blocked',
                'reason': table['problem'] or 'notebook-annotation-unmapped', 'coverage': None, 'incomplete': []}
    body = {'version': 1, 'scope': 'native-legacy-conversion-input-v1', 'runId': str(uuid.uuid4()), 'peerId': str(uuid.uuid4()),
            'libraryId': str(uuid.uuid4()), 'journalRecordSha256': '1' * 64, 'selectionSha256': '2' * 64, 'inputSetSha256': '3' * 64,
            'sources': [{'kind': kind, 'sourceId': '4' * 64, 'backupId': str(uuid.uuid4()), 'planSha256': '5' * 64, 'observationSha256': '6' * 64,
                         'inventorySha256': '7' * 64, 'entryCount': 1, 'totalBytes': 1} for kind in ('desktop-library', 'canonical', 'device')],
            'inventory': {'reportSha256': '8' * 64, 'summary': {'supported': 0, 'retainedBlocking': 0, 'unknown': 0, 'blockingReasons': []}},
            'sqlite': {'journalMode': 'rollback', 'walEntries': [], 'walComplete': True, 'userVersion': 9, 'quickCheck': 'ok', 'notebooksListable': True},
            'notebooks': [blocked(table) for table in tables],
            'wholeLibrary': {'status': 'refused', 'reasons': ['notebook-extraction-blocked', 'uncollected-source']}}
    return {**body, 'manifestSha256': edit_content_hash(body)}


def run_bridge(manifest):
    node = shutil.which('node')
    assert node, 'node is required for the TypeScript half of this test'
    process = subprocess.Popen([node, '--experimental-transform-types', '--disable-warning=ExperimentalWarning', str(BRIDGE)], cwd=FRONTEND,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        stdout, stderr = process.communicate(json.dumps({'manifest': manifest, 'extractions': []}), timeout=60)
    except subprocess.TimeoutExpired:
        pytest.fail(f'node bridge did not finish within 60s; left running as PID {process.pid}')     # never killed (the established policy)
    return process.returncode, stdout, stderr


def test_a_notebook_row_table_with_rows_the_manifest_cannot_hold_is_normalized_and_blocked(tmp_path):
    synthetic, _source, tables = poisoned(tmp_path)
    a, b = synthetic.ids['A'], synthetic.ids['B']
    raw = {table['sourceDocumentId']: table for table in tables}
    copy_of_raw = json.loads(json.dumps(raw[a]))
    cleaned = normalize_notebook_table(raw[a])
    assert raw[a] == copy_of_raw, 'the input is not changed'
    assert normalize_notebook_table(cleaned) == cleaned, 'idempotent'
    assert cleaned['problem'] == 'notebook-rows-unreadable' and cleaned['unmapped'] == len(cleaned['pages']) + len(cleaned['ink']) + len(cleaned['bookmarks'])
    # Every value is now one the TypeScript manifest check reads, and nothing was dropped (the counts stay).
    assert len(cleaned['pages']) == len(raw[a]['pages']) and len(cleaned['ink']) == len(raw[a]['ink']) and len(cleaned['bookmarks']) == len(raw[a]['bookmarks'])
    assert [row['number'] for row in cleaned['pages']] == [0, 1, 2] and cleaned['pages'][0]['pageId'] is None and [row['number'] for row in raw[a]['pages']] == [-3, 1, 2]
    assert all(1 <= len(row['side']) <= 64 and (row['page'] is None or (type(row['page']) is int and row['page'] >= 0)) for row in cleaned['ink'])
    assert all(1 <= len(row['side']) <= 64 and 1 <= len(row['kind']) <= 64 and row['id'].isdigit() for row in cleaned['bookmarks'])
    assert {row['side'] for row in cleaned['ink']} >= {'unreadable', 'original'} and any(row['page'] is None for row in cleaned['ink'] + cleaned['bookmarks'])
    assert any(row['kind'] == 'unreadable' for row in cleaned['bookmarks'])
    # Pages rows that are not exactly 1..n get their own reason when nothing else is wrong; a Notebook that was fine is unchanged.
    gap = json.loads(json.dumps(raw[b]))
    gap['pages'], gap['ink'], gap['bookmarks'], gap['problem'], gap['unmapped'] = [{'number': 1, 'pageId': gap['pageIds'][0]}, {'number': 3, 'pageId': gap['pageIds'][2]}], [], [], None, 0
    assert normalize_notebook_table(gap)['problem'] == 'notebook-page-rows-not-contiguous' and normalize_notebook_table(gap)['unmapped'] == 2
    clean = json.loads(json.dumps(raw[b]))
    clean.update(pages=[{'number': n, 'pageId': i} for n, i in enumerate(clean['pageIds'], 1)], ink=[], bookmarks=[], problem=None, unmapped=0)
    assert normalize_notebook_table(clean) == clean
    assert normalize_notebook_table({**clean, 'problem': 'notebook-json-invalid', 'unmapped': 1})['problem'] == 'notebook-json-invalid'


def test_typescript_refuses_the_raw_manifest_and_reads_the_normalized_one(tmp_path):
    synthetic, _source, tables = poisoned(tmp_path)
    a, b = synthetic.ids['A'], synthetic.ids['B']
    code, stdout, stderr = run_bridge(sealed_manifest(tables))
    assert code == 1 and stdout == '' and stderr == '{"error":"conversion-input-manifest-invalid"}', (stdout, stderr)       # the problem is real
    cleaned = [normalize_notebook_table(table) for table in tables]
    code, stdout, stderr = run_bridge(sealed_manifest(cleaned))
    assert code == 0, stderr[-2000:]
    result = {item['sourceDocumentId']: item for item in json.loads(stdout)['notebooks']}
    assert result[a] == {'sourceDocumentId': a, 'status': 'blocked', 'reason': 'notebook-rows-unreadable'}
    assert result[b] == {'sourceDocumentId': b, 'status': 'blocked', 'reason': 'notebook-annotation-unmapped'}      # the untouched Notebook is read as it was


# RX-4 ------------------------------------------------------------------------------------------------------------------
def spy_on_connect(monkeypatch):
    opened = []
    real = sqlite3.connect

    def connect(*args, **kwargs):
        opened.append(args[0] if args else kwargs.get('database'))
        return real(*args, **kwargs)
    monkeypatch.setattr(rows_module.sqlite3, 'connect', connect)
    return opened


@pytest.mark.parametrize('statement', [
    'ALTER TABLE pdf_ink ADD COLUMN extra TEXT', 'ALTER TABLE collections ADD COLUMN extra TEXT', 'ALTER TABLE note_legacy ADD COLUMN extra TEXT',
    'ALTER TABLE papers ADD COLUMN extra TEXT'])
def test_rows_that_cannot_be_listed_for_a_reason_other_than_the_wal_say_so_and_read_nothing(tmp_path, monkeypatch, statement):
    synthetic, captured = fresh(tmp_path, sql=(statement,))
    opened = spy_on_connect(monkeypatch)
    result = extract(synthetic, captured, before=lambda copy, source: opened.clear())
    assert result['listable'] is False and result['rows'] is None
    assert result['reasons'] == ['notebook-rows-not-listable'] and result['report']['reasons'] == ['notebook-rows-not-listable']
    assert result['report']['counts'] is None and result['report']['sourceSha256'] is None
    assert opened == [], 'a library that cannot be listed is never opened by the row extraction'
    capture, manifest, names = library_of(synthetic, captured)
    with capture.backup.sqlite_working_copy(manifest['id'], names) as copy:
        source = inventory_source('desktop-library', manifest, copy, copied=frozenset((name,) for name in names))
    assert row_reasons(source) == ['notebook-rows-not-listable'] and not rows_module.rows_listable(source)


def test_a_single_wal_companion_is_the_wal_rule_not_a_second_reason(tmp_path, monkeypatch):
    # The inventory's own verdict for a Library with exactly one companion is `walComplete` false with `sqlite-wal-incomplete`; that
    # has its own reason in the inventory, so the row extraction adds nothing and still reads nothing. A source with no database at
    # all is not the WAL rule: it gets the new reason.
    wal_source = {'kind': 'desktop-library', 'sqlite': {'walComplete': False, 'reasons': ['sqlite-wal-incomplete'], 'opened': False, 'objects': []}}
    assert row_reasons(wal_source) == [] and not rows_module.rows_listable(wal_source)
    assert row_reasons({'kind': 'desktop-library', 'sqlite': None}) == ['notebook-rows-not-listable']
    assert row_reasons({'kind': 'desktop-library', 'sqlite': {'walComplete': True, 'reasons': [], 'opened': False, 'objects': []}}) == ['notebook-rows-not-listable']
    refused('staging-rows-invalid-argument', row_reasons, {'kind': 'device', 'sqlite': None})
    synthetic, captured = fresh(tmp_path)
    manifest = captured['desktop-library'].manifest
    opened = spy_on_connect(monkeypatch)
    result = extract_staging_rows(Path('x') / 'library.sqlite3', manifest, wal_source)
    assert result['listable'] is False and result['reasons'] == [] and result['rows'] is None and opened == []
    refused('staging-rows-invalid-argument', extract_staging_rows, Path('x') / 'library.sqlite3', manifest, {'kind': 'device'})
    refused('staging-rows-invalid-argument', extract_staging_rows, Path('x') / 'other.sqlite3', manifest, wal_source)
    assert opened == []


# RX-5 ------------------------------------------------------------------------------------------------------------------
def test_nothing_private_is_in_the_report_or_in_any_error(tmp_path):
    synthetic, captured = fresh(tmp_path)
    result = extract(synthetic, captured)
    text = json.dumps(result['report'], sort_keys=True)
    assert result['report']['counts'] and not [sentinel for sentinel in (*SENTINELS, *TITLES) if sentinel in text]
    assert str(tmp_path) not in text and 'library.sqlite3' not in text and str(synthetic.root) not in text
    # ... while the rows really carry the bodies (so the absence above is a statement about the report, not about an empty extraction).
    assert 'SENTINEL-MEMO-BODY' in json.dumps(result['rows']) and 'Synthetic PDF' in json.dumps(result['rows'])
    # Every refusal is one closed code with no cause, no text and no path.
    failures = []
    for options in ({'budget': RowBudget(max_items=1)}, {'budget': RowBudget(max_rows=3)}, {'budget': RowBudget(max_total_bytes=10)},
                    {'budget': RowBudget(max_value_bytes=0)}):
        with pytest.raises(ValueError) as error:
            extract(synthetic, captured, **options)
        failures.append(error.value)
    for error in failures:
        assert error.args == ('staging-rows-capacity-exceeded',) and error.__cause__ is None and (error.__context__ is None or error.__suppress_context__)
        assert not [sentinel for sentinel in (*SENTINELS, *TITLES, str(tmp_path)) if sentinel in repr(error)]


def listable_source():
    """What the inventory says of a Library whose notebook tables it could read (the row extraction is handed this, and still checks itself)."""
    names = ('papers', 'pages', 'pdf_ink', 'bookmarks', 'messages', 'attachments', 'note_state', 'item_links', 'reference_research',
             'paper_discovery', 'collections', 'note_legacy')
    return {'kind': 'desktop-library', 'sqlite': {'walComplete': True, 'reasons': [], 'opened': True, 'objects': [
        {'type': 'table', 'name': name, 'rows': {'total': 1}, 'columns': [{'category': 'supported'}]} for name in names]}}


@pytest.mark.parametrize('sql, code', [
    ('PRAGMA user_version = 8', 'staging-rows-schema-unsupported'),
    ("UPDATE papers SET pages = 1e999 WHERE kind = 'pdf'", 'staging-rows-value-unhashable')])
def test_unreadable_databases_and_values_are_closed_codes(tmp_path, sql, code):
    synthetic, captured = fresh(tmp_path, sql=(sql,))
    capture, manifest, names = library_of(synthetic, captured)
    with capture.backup.sqlite_working_copy(manifest['id'], names) as copy:
        # The inventory would call the database unsupported (version) or not; the row extraction must refuse on its own as well,
        # so it is handed a source the inventory called listable.
        assert rows_module.rows_listable(listable_source())
        error = refused(code, extract_staging_rows, copy / 'library.sqlite3', manifest, listable_source())
    assert not [sentinel for sentinel in (*SENTINELS, *TITLES, str(tmp_path)) if sentinel in repr(error)]


def test_a_file_that_is_not_a_database_is_unreadable_and_says_nothing_else(tmp_path):
    synthetic, captured = fresh(tmp_path)
    manifest = captured['desktop-library'].manifest
    folder = tmp_path / 'not-a-database'
    folder.mkdir()
    (folder / 'library.sqlite3').write_bytes(b'SENTINEL-NOTE this is not a database ' * 20)
    error = refused('staging-rows-unreadable', extract_staging_rows, folder / 'library.sqlite3', manifest, listable_source())
    assert not [sentinel for sentinel in (*SENTINELS, str(tmp_path)) if sentinel in repr(error)]
    refused('staging-rows-unreadable', extract_staging_rows, folder / 'missing' / 'library.sqlite3', manifest, listable_source())


@pytest.mark.parametrize('name', ['_paper_rows', '_folders', '_links', '_annotation_facts', '_page_facts'])
def test_a_pass_that_disagrees_with_its_independent_count_is_refused(tmp_path, monkeypatch, name):
    """The rows and the counts come from different queries; one that has lost a row is a mismatch, never a quietly smaller result."""
    synthetic, captured = fresh(tmp_path)
    p = synthetic.ids['P']
    real = getattr(rows_module, name)

    def lossy(*args, **kwargs):
        value = real(*args, **kwargs)
        if name == '_annotation_facts':
            return {key: rows for key, rows in value[0].items() if key != p}, value[1]
        if name == '_page_facts':
            return {key: fact for key, fact in value[0].items() if key != p}, value[1]
        return value[1:]
    assert extract(synthetic, captured)['listable'] is True
    monkeypatch.setattr(rows_module, name, lossy)
    refused('staging-rows-count-mismatch', extract, synthetic, captured)


def test_sqlite_itself_polls_the_cancel_token(tmp_path, monkeypatch):
    """With every explicit check disabled, only the progress handler can stop a running query."""
    synthetic, captured = fresh(tmp_path)
    event = threading.Event()
    event.set()
    monkeypatch.setattr(rows_module, '_check', lambda cancel: None)
    monkeypatch.setattr(rows_module, 'PROGRESS_INTERVAL', 1)
    refused('staging-rows-cancelled', extract, synthetic, captured, cancel=event)


# RX-6 ------------------------------------------------------------------------------------------------------------------
def test_a_budget_is_a_refusal_not_a_truncation(tmp_path):
    synthetic, captured = fresh(tmp_path)
    whole = extract(synthetic, captured)
    items, rows = 4, whole['rows']
    # Exactly at the bound passes and gives everything; one below refuses.
    assert extract(synthetic, captured, budget=RowBudget(max_items=items))['rows'] == rows
    refused('staging-rows-capacity-exceeded', extract, synthetic, captured, budget=RowBudget(max_items=items - 1))
    taken = []
    real_take = rows_module._Meter.take

    def counting(self, row=()):
        taken.append(1)
        return real_take(self, row)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(rows_module._Meter, 'take', counting)
        extract(synthetic, captured)
    total = len(taken)
    assert total > 10
    refused('staging-rows-capacity-exceeded', extract, synthetic, captured, budget=RowBudget(max_rows=total - 1))
    assert extract(synthetic, captured, budget=RowBudget(max_rows=total))['rows'] == rows
    refused('staging-rows-capacity-exceeded', extract, synthetic, captured, budget=RowBudget(max_total_bytes=60))
    # A stored value over max_value_bytes is refused by SQLite's own length limit before it becomes a Python object.
    synthetic2, captured2 = fresh(tmp_path / 'big', sql=(("UPDATE note_state SET content = ?", ('x' * 10_000,)),))
    refused('staging-rows-capacity-exceeded', extract, synthetic2, captured2, budget=RowBudget(max_value_bytes=4096))
    assert extract(synthetic2, captured2, budget=RowBudget(max_value_bytes=20_000), with_mirror=False)['rows']['markdown'][0]['contentBytes'] == 10_000
    for bad in (-1, 1.5, None):
        refused('staging-rows-invalid-argument', RowBudget, max_rows=bad)


# RX-7 ------------------------------------------------------------------------------------------------------------------
class CancelAfter:
    """An Event-like that says 'not set' for its first `calls` questions and 'set' from then on (cancel at every possible point)."""

    def __init__(self, calls):
        self.calls, self.asked = calls, 0

    def is_set(self):
        self.asked += 1
        return self.asked > self.calls


def test_cancel_stops_the_extraction_at_every_point_and_never_returns_a_partial_result(tmp_path, monkeypatch):
    synthetic, captured = fresh(tmp_path)
    refused('staging-rows-cancelled', extract, synthetic, captured, cancel=CancelAfter(0))
    event = threading.Event()
    event.set()
    refused('staging-rows-cancelled', extract, synthetic, captured, cancel=event)
    monkeypatch.setattr(rows_module, 'PROGRESS_INTERVAL', 50)        # SQLite itself polls the token (the progress handler)
    probe = CancelAfter(10 ** 9)
    whole = extract(synthetic, captured, cancel=probe)
    assert probe.asked > 20
    outcomes = set()
    for calls in range(0, probe.asked + 1, max(1, probe.asked // 12)):
        try:
            result = extract(synthetic, captured, cancel=CancelAfter(calls))
        except ValueError as error:
            assert error.args == ('staging-rows-cancelled',) and error.__cause__ is None
            outcomes.add('cancelled')
        else:
            assert result['rows'] == whole['rows']
            outcomes.add('complete')
    assert outcomes == {'cancelled', 'complete'}
    assert not [path for path in tmp_path.rglob('.analysis-*')]


# RX-8 ------------------------------------------------------------------------------------------------------------------
def test_the_note_md_mirror_is_compared_with_note_state(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    m = synthetic.ids['M']
    (synthetic.root / 'papers' / m / 'note.md').write_bytes(b'# memo\nsomething else')
    result = extract(synthetic, synthetic.capture())
    note = result['rows']['markdown'][0]
    assert note['mirror'] == 'mismatch' and note['content'] == '# memo\nSENTINEL-MEMO-BODY' and note['contentSha256'] == hashlib.sha256(note['content'].encode()).hexdigest()
    # The byte-exact comparison: a file that differs only by line ending is a mismatch too (the Library writes bytes).
    (synthetic.root / 'papers' / m / 'note.md').write_bytes(b'# memo\r\nSENTINEL-MEMO-BODY')
    assert extract(synthetic, synthetic.capture())['rows']['markdown'][0]['mirror'] == 'mismatch'
    (synthetic.root / 'papers' / m / 'note.md').unlink()
    missing = extract(synthetic, synthetic.capture())
    assert missing['rows']['markdown'][0]['mirror'] == 'missing' and missing['rows']['markdown'][0]['state'] == 'present'
    (synthetic.root / 'papers' / m / 'note.md').write_bytes('# memo\nSENTINEL-MEMO-BODY'.encode())
    synthetic.sql(('DELETE FROM note_state WHERE id = ?', (m,)))
    nobody = extract(synthetic, synthetic.capture())
    note = nobody['rows']['markdown'][0]
    assert (note['state'], note['content'], note['contentBytes'], note['contentSha256'], note['sourceSha256']) == ('missing', None, None, None, None)
    assert note['mirror'] == 'mismatch'              # a mirror without a stored note is not "the same"
    assert extract(synthetic, synthetic.capture(), with_mirror=False)['rows']['markdown'][0]['mirror'] == 'unchecked'


def test_markdown_media_and_note_legacy_are_listed_from_the_manifest(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    m = synthetic.ids['M']
    media = synthetic.root / 'papers' / m / 'media'
    (media / 'sub').mkdir(parents=True)
    (media / 'a.png').write_bytes(b'\x89PNG a')
    (media / 'sub' / 'b.png').write_bytes(b'\x89PNG b')
    synthetic.sql(('INSERT INTO note_legacy VALUES(?, ?)', (m, m)), ('INSERT INTO note_state(id, revision, content) VALUES(?, ?, ?)', ('f' * 32, 'r', 'orphan note')))
    result = extract(synthetic, synthetic.capture())
    note = result['rows']['markdown'][0]
    assert note['media'] == [{'name': 'a.png', 'sha256': hashlib.sha256(b'\x89PNG a').hexdigest(), 'byteLength': 6},
                             {'name': 'sub/b.png', 'sha256': hashlib.sha256(b'\x89PNG b').hexdigest(), 'byteLength': 6}]
    assert note['legacyNoteId'] == m and note['legacySourceSha256'] == hash_of('note_legacy', ('id', 'note_id'), (m, m))
    assert result['report']['counts']['markdown']['noteStateOtherRows'] == 1 and result['report']['counts']['markdown']['noteLegacyRows'] == 1


# RX-9 ------------------------------------------------------------------------------------------------------------------
def test_collection_paths_are_normalized_the_way_the_product_and_the_shared_cases_say(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    inserts = []
    for number, case in enumerate(COLLECTION_CASES):
        identifier = f'{number + 1:032x}'
        inserts.append(("INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,kind) VALUES(?,?,?,?,0,'not_translated',?,'markdown')",
                        (identifier, 'markdown:' + identifier, 'case', 'case', case['value'])))
        inserts.append(('INSERT OR IGNORE INTO collections(name) VALUES(?)', (case['value'],)))
    synthetic.sql(*inserts)
    result = extract(synthetic, synthetic.capture(), with_mirror=False)
    items = by_id(result['rows'], 'items')
    wanted = set()
    for number, case in enumerate(COLLECTION_CASES):
        item = items[f'{number + 1:032x}']
        assert item['collectionPath'] == case['path'] == collection_paths.normalize_collection_name(case['value'])
        assert item['collectionParts'] == (case['path'].split(' / ') if case['path'] else [])
        if case['path']:
            parts = case['path'].split(' / ')
            wanted.update(' / '.join(parts[:depth]) for depth in range(1, len(parts) + 1))
    wanted.update({'Folder', 'Folder / Sub'})
    folders = result['rows']['folders']
    assert {folder['path'] for folder in folders} == wanted and result['report']['counts']['folders'] == len(wanted)
    assert all(folder['parent'] == (' / '.join(folder['parts'][:-1]) or None) for folder in folders)
    assert [folder['parts'] for folder in folders] == sorted(folder['parts'] for folder in folders)
    # Folders that normalize to nothing ("", " / / ") are not folders, whatever the raw collections row says.
    assert '' not in wanted and all(folder['path'] for folder in folders)


# RX-10 -----------------------------------------------------------------------------------------------------------------
def test_a_link_resolves_only_between_a_stand_alone_pdf_and_a_stand_alone_note(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    a, b, m, p = (synthetic.ids[key] for key in 'ABMP')
    held, ghost = 'e' * 32, 'f' * 32
    pairs = {'pdf-markdown': tuple(sorted((p, m))), 'notebook-notebook': tuple(sorted((a, b))), 'markdown-notebook': tuple(sorted((m, a))),
             'missing': tuple(sorted((p, ghost))), 'owned': tuple(sorted((held, p)))}
    synthetic.sql(("INSERT INTO papers(id,sha256,title,original_name,pages,status,kind,parent_id) VALUES(?,?,?,?,0,'not_translated','markdown',?)",
                   (held, 'markdown:' + held, 'held', 'held', p)),
                  *(('INSERT INTO item_links VALUES(?, ?)', pair) for pair in pairs.values()))
    result = extract(synthetic, synthetic.capture(), with_mirror=False)
    links = {(link['a'], link['b']): link for link in result['rows']['links']}
    outcome = {name: (links[pair]['status'], links[pair]['reason'], links[pair]['pdfId'], links[pair]['noteId']) for name, pair in pairs.items()}
    assert outcome == {'pdf-markdown': ('resolved', None, p, m), 'notebook-notebook': ('unresolved', 'link-kinds-unsupported', None, None),
                       'markdown-notebook': ('unresolved', 'link-kinds-unsupported', None, None), 'missing': ('unresolved', 'link-endpoint-missing', None, None),
                       'owned': ('unresolved', 'link-endpoint-owned', None, None)}
    assert links[tuple(sorted((p, a)))]['status'] == 'resolved' and links[tuple(sorted((p, a)))]['noteKind'] == 'notebook'
    assert result['report']['counts']['links'] == {'total': 6, 'resolved': 2, 'unresolved': 4}
    assert [(link['a'], link['b']) for link in result['rows']['links']] == sorted(links)
    assert result['report']['counts']['items']['held'] == 1
    held_item = by_id(result['rows'], 'items')[held]
    assert held_item['columns']['parent_id'] == p and held_item['kind'] == 'markdown'


# PDFs and the facts that block them ---------------------------------------------------------------------------------------
def test_pdf_rows_keep_only_what_a_conversion_may_use_and_report_the_blocking_facts(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    p = synthetic.ids['P']
    synthetic.sql(("INSERT INTO pdf_ink VALUES(?, 'translated', 1, ?)", (p, STROKES)), ("INSERT INTO pdf_ink VALUES(?, 'original', 5, ?)", (p, STROKES)),
                  ("INSERT INTO pdf_ink VALUES(?, 'original', 2, 'not json')", (p,)),
                  (MARK, (p, 1, 'translated', 'q', 'l', 'n', 'highlight', 'yellow', '[]')), (MARK, (p, 9, 'original', 'q', 'l', 'n', 'highlight', 'yellow', '[]')),
                  (MARK, (p, 1, 'original', 'q', 'l', 'n', 'underline', '', '[]')))
    result = extract(synthetic, synthetic.capture(), with_mirror=False)
    pdf = result['rows']['pdfs'][0]
    assert pdf['problems'] == ['pdf-annotation-unmapped', 'pdf-annotation-unreadable']
    counts = result['report']['counts']['pdfs'][p]
    assert counts['ink'] == {'original': 3, 'other': 1} and counts['strokes'] == {'original': 2, 'other': 1}
    assert counts['bookmarks'] == {'note': {'original': 1, 'other': 0}, 'highlight': {'original': 1, 'other': 1}, 'other': {'original': 1, 'other': 0}}
    translated = [row for row in pdf['inkRows'] if row['side'] == 'translated']
    assert translated == [{'side': 'translated', 'page': 1, 'strokeCount': 1}], 'a translated row is counted, not kept'
    unreadable = next(row for row in pdf['inkRows'] if row['page'] == 2)
    assert unreadable['strokes'] is None and unreadable['strokeCount'] is None
    assert sorted(pdf['annotationPages']) == [1] and all('record' not in row for row in pdf['bookmarkRows'] if row['side'] != 'original')
    # Rows that are only counted carry no content and no hash.
    assert all(set(row) == {'id', 'side', 'page', 'kind'} for row in pdf['bookmarkRows'] if row['side'] != 'original')


@pytest.mark.parametrize('sql, files, problems', [
    (("UPDATE papers SET pages = 2 WHERE kind = 'pdf'",), None, ['pdf-page-count-mismatch']),
    (("DELETE FROM pages WHERE paper_id IN (SELECT id FROM papers WHERE kind = 'pdf')",), None, ['pdf-page-count-mismatch', 'pdf-page-rows-not-contiguous']),
    (("INSERT INTO pages SELECT id, 3, '' FROM papers WHERE kind = 'pdf'",), None, ['pdf-page-count-mismatch', 'pdf-page-rows-not-contiguous']),
    (("UPDATE papers SET sha256 = CASE WHEN substr(sha256, 1, 1) = 'f' THEN 'e' ELSE 'f' END || substr(sha256, 2) WHERE kind = 'pdf'",), None,
     ['pdf-file-hash-mismatch']),         # a different first character whatever the generated PDF's own hash starts with (B7-d flaky, found in B7-e)
    ((), 'delete-pdf', ['pdf-file-missing'])], ids=['pages-column', 'no-page-rows', 'gap', 'sha', 'file'])
def test_pdf_facts(tmp_path, sql, files, problems):
    synthetic = build_synthetic_library(tmp_path / 'library')
    if sql:
        synthetic.sql(*sql)
    if files:
        (synthetic.root / 'papers' / synthetic.ids['P'] / 'original.pdf').unlink()
    result = extract(synthetic, synthetic.capture(), with_mirror=False)
    assert result['rows']['pdfs'][0]['problems'] == problems


# Low 3 of REVIEW-r161-b7b: a shared copy is checked again after its last use ----------------------------------------------
def flip_last_byte(path):
    with path.open('r+b') as stream:
        stream.seek(-1, 2)
        last = stream.read(1)
        stream.seek(-1, 2)
        stream.write(bytes([last[0] ^ 1]))


def append_byte(path):
    with path.open('ab') as stream:
        stream.write(b'0')


@pytest.mark.parametrize('target', ['library.sqlite3', 'library.sqlite3-wal'])
def test_a_copy_changed_while_the_rows_were_read_is_refused(tmp_path, monkeypatch, target):
    synthetic, captured = fresh(tmp_path, wal=True)
    capture, manifest, names = library_of(synthetic, captured)
    assert target in names

    def tamper(copy, _source):
        real = rows_module._markdown

        def changed(db, items, manifest, read_entry, meter):
            value = real(db, items, manifest, read_entry, meter)
            append_byte(copy / target)           # after the database has been opened, before the extraction ends (appending keeps every page readable)
            return value
        monkeypatch.setattr(rows_module, '_markdown', changed)
    refused('staging-rows-copy-changed', extract, synthetic, captured, before=tamper)
    monkeypatch.undo()
    assert extract(synthetic, captured)['listable'] is True, 'the same capture reads fine when nothing is changed'


def test_the_copy_check_can_be_left_to_the_owner_of_the_copy(tmp_path, monkeypatch):
    synthetic, captured = fresh(tmp_path)
    capture, manifest, names = library_of(synthetic, captured)
    calls = []
    real = legacy_inventory.assert_copy_unchanged
    monkeypatch.setattr(legacy_inventory, 'assert_copy_unchanged', lambda *args, **kwargs: calls.append(args[2]) or real(*args, **kwargs))
    extract(synthetic, captured)
    extract(synthetic, captured, verify_copy=False)
    assert calls == [('library.sqlite3',)]


def test_assert_copy_unchanged_compares_the_database_and_the_wal_but_not_the_shm(tmp_path):
    synthetic, captured = fresh(tmp_path, wal=True)
    capture, manifest, names = library_of(synthetic, captured)
    assert names == ('library.sqlite3', 'library.sqlite3-wal', 'library.sqlite3-shm')
    with capture.backup.sqlite_working_copy(manifest['id'], names) as copy:
        legacy_inventory.assert_copy_unchanged(copy, manifest, names)                    # straight after the copy
        inventory_source('desktop-library', manifest, copy, copied=frozenset((name,) for name in names))    # the database is opened
        legacy_inventory.assert_copy_unchanged(copy, manifest, names)                    # opening it read only changed neither file
        (copy / 'library.sqlite3-shm').write_bytes(b'rewritten by SQLite')
        legacy_inventory.assert_copy_unchanged(copy, manifest, names)                    # the -shm is SQLite's own to rewrite
        flip_last_byte(copy / 'library.sqlite3-wal')
        refused('inventory-copy-mismatch', legacy_inventory.assert_copy_unchanged, copy, manifest, names)
        flip_last_byte(copy / 'library.sqlite3-wal')
        legacy_inventory.assert_copy_unchanged(copy, manifest, names)
        flip_last_byte(copy / 'library.sqlite3')
        refused('inventory-copy-mismatch', legacy_inventory.assert_copy_unchanged, copy, manifest, names)
        flip_last_byte(copy / 'library.sqlite3')
        with (copy / 'library.sqlite3').open('ab') as stream:
            stream.write(b'0')
        refused('inventory-copy-mismatch', legacy_inventory.assert_copy_unchanged, copy, manifest, names)      # a size change is caught too
        refused('inventory-copy-mismatch', legacy_inventory.assert_copy_unchanged, None, manifest, names)
        refused('inventory-copy-mismatch', legacy_inventory.assert_copy_unchanged, copy, manifest, ('library.sqlite3-journal',))
        legacy_inventory.assert_copy_unchanged(None, manifest, ())                       # a source without a database has nothing to check
        event = threading.Event()
        event.set()
        refused('inventory-cancelled', legacy_inventory.assert_copy_unchanged, copy, manifest, ('library.sqlite3-wal',), cancel=event)


# Low 1 of REVIEW-r161-b7b: a storage-location that cannot be read from its backup object is refused ---------------------------
def device_source(synthetic, captured, read):
    capture = captured['device']
    manifest = capture.manifest
    return inventory_source('device', manifest, None, library_key=synthetic.library_key, copied=frozenset(), read_entry=read)


GOOD = json.dumps({'path': 'x', 'pending': None}).encode()


@pytest.mark.parametrize('failure', [ValueError('backup-object-hash'), ValueError('backup-source-changed'), ValueError('backup-entry-missing'),
                                     ValueError('backup-read-cancelled'), ValueError('backup-read-limit-invalid'), ValueError('inventory-copy-mismatch'),
                                     OSError('device read failed')], ids=lambda value: str(value))
def test_a_storage_location_read_that_fails_for_any_other_reason_is_refused(tmp_path, failure):
    synthetic = build_synthetic_library(tmp_path / 'library', folder_sync_state=True)
    (synthetic.device / 'storage-location.json').write_bytes(GOOD)
    captured = synthetic.capture()

    def broken(entry, max_bytes):
        raise failure
    with pytest.raises(type(failure)) as error:
        device_source(synthetic, captured, broken)
    assert error.value.args == failure.args


@pytest.mark.parametrize('content, readable', [
    (GOOD, True), (b'not json', False), (b'[1, 2]', False), (b'\xff\xfe\x00', False), (b'{"pending": NaN}', False), (b' ' * 70_000, False)],
    ids=['plain', 'garbage', 'not-an-object', 'not-utf8', 'non-finite', 'oversize'])
def test_only_the_size_bound_and_a_json_error_make_a_storage_location_unreadable(tmp_path, content, readable):
    synthetic = build_synthetic_library(tmp_path / 'library', folder_sync_state=True)
    (synthetic.device / 'storage-location.json').write_bytes(content)
    captured = synthetic.capture()
    capture = captured['device']
    source = device_source(synthetic, captured, lambda entry, max_bytes: capture.backup.read_object(capture.manifest['id'], entry, max_bytes=max_bytes))
    assert source['storageLocation']['present'] is True and source['storageLocation']['readable'] is readable
    classification = {tuple(item['key']): item['reason'] for item in source['entries']}[('storage-location.json',)]
    assert (classification == 'storage-location-unreadable') is (not readable)


def test_the_whole_copy_path_refuses_a_changed_file_too(tmp_path, monkeypatch):
    synthetic = build_synthetic_library(tmp_path / 'library', folder_sync_state=True)
    (synthetic.device / 'storage-location.json').write_bytes(GOOD)
    captured = synthetic.capture()
    capture = captured['device']
    with capture.backup.analysis_copy(capture.manifest['id']) as copy:
        def changed(path, limit):
            raise ValueError('backup-source-changed')
        monkeypatch.setattr(legacy_inventory, '_read_bounded_bytes', changed)
        with pytest.raises(ValueError) as error:
            inventory_source('device', capture.manifest, copy, library_key=synthetic.library_key)
        assert error.value.args == ('backup-source-changed',)


def test_the_wal_rule_holds_even_for_a_source_that_claims_to_be_opened():
    """The inventory never calls a database with an incomplete WAL opened, but the row extraction does not rely on that: a source that
    says `opened` and also says the WAL is incomplete (or its `walComplete` is not true) is not listable (conversion_input's own condition)."""
    for database, reasons in (({'walComplete': False, 'reasons': []}, ['notebook-rows-not-listable']),      # not WAL-complete, but not the WAL rule either
                              ({'walComplete': True, 'reasons': ['sqlite-wal-incomplete']}, [])):
        source = listable_source()
        source['sqlite'].update(database)
        assert not rows_module.rows_listable(source) and row_reasons(source) == reasons
    assert rows_module.rows_listable(listable_source())


def test_only_the_progress_handler_can_stop_a_running_query(tmp_path, monkeypatch):
    """Every explicit check is disabled here, and so is the final copy check (it asks the token too): a token that is already set
    can only be seen by SQLite's own progress handler."""
    synthetic, captured = fresh(tmp_path)
    event = threading.Event()
    event.set()
    monkeypatch.setattr(rows_module, '_check', lambda cancel: None)
    monkeypatch.setattr(rows_module, 'PROGRESS_INTERVAL', 1)
    refused('staging-rows-cancelled', extract, synthetic, captured, cancel=event, verify_copy=False)
    monkeypatch.setattr(rows_module, 'PROGRESS_INTERVAL', 10 ** 9)           # without the handler firing the same token goes unseen
    assert extract(synthetic, captured, cancel=event, verify_copy=False)['listable'] is True


def corrupt_header(synthetic):
    path = synthetic.root / 'library.sqlite3'
    data = path.read_bytes()
    assert data[:16] == b'SQLite format 3\x00'
    path.write_bytes(b'SQLite format X\x00' + data[16:])


@pytest.mark.parametrize('name, options, plant, inventory_reason, reasons', [
    ('header', {}, corrupt_header, 'sqlite-invalid', ['notebook-rows-not-listable']),
    ('wal-with-a-journal', {'wal_closed': True}, lambda s: (s.root / 'library.sqlite3-journal').write_bytes(b'journal'),
     'sqlite-rollback-journal-pending', ['notebook-rows-not-listable']),
    ('rollback-with-a-companion', {}, lambda s: (s.root / 'library.sqlite3-wal').write_bytes(b'wal'),
     'sqlite-wal-unexpected', ['notebook-rows-not-listable']),
    ('wal-with-one-companion', {'wal_closed': True}, lambda s: (s.root / 'library.sqlite3-wal').write_bytes(b'wal'),
     'sqlite-wal-incomplete', [])], ids=['header', 'wal-with-a-journal', 'rollback-with-a-companion', 'wal-with-one-companion'])
def test_not_the_wal_rule_the_reason_comes_from_the_real_inventory(tmp_path, monkeypatch, name, options, plant, inventory_reason, reasons):
    """The inventory's `walComplete` is false by default, so it cannot tell the WAL rule from the other causes; these are real
    inventories of Libraries that cannot be read, and only a WAL database with exactly one companion is the WAL rule's own case."""
    synthetic = build_synthetic_library(tmp_path / 'library', **options)
    plant(synthetic)
    captured = synthetic.capture(refresh_expected=False)
    opened = spy_on_connect(monkeypatch)
    seen = {}
    result = extract(synthetic, captured, before=lambda copy, source: (seen.update(source=source), opened.clear()))
    assert inventory_reason in seen['source']['sqlite']['reasons'], seen['source']['sqlite']['reasons']
    assert result['listable'] is False and result['rows'] is None and opened == []
    assert result['reasons'] == reasons == result['report']['reasons'] == row_reasons(seen['source']), (name, result['reasons'])
