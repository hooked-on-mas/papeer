"""Work B6-b: the pure inventory of a verified analysis copy (synthetic Library, temporary folders only).

No sidecar, route or live process is involved: a synthetic schema-9 Library is captured with
NativeLegacyBackup (as the existing analysis tests do) and papeer.core.migrations.legacy_inventory
classifies the disposable analysis copy. Counts are compared with `Synthetic.expected`, which is read
straight from SQLite and notebook.json. Several tests pin the constraints a mutation would remove:
unknown is never empty, an unlisted name is unknown, the self check catches a dropped classification.
"""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import uuid

import pytest

from _synthetic_legacy_library import (HIGHLIGHT_RECTS, OPTIONAL_TABLE_SQL, SENTINELS, Capture, analysis, build_synthetic_library, run_inventory,
                                       run_inventory_shared, settle, sqlite_names, tree_hashes)
from papeer.core.bootstrap.canonical_initialization_sqlite import initialize_canonical_metadata
from papeer.core.bootstrap.canonical_local_grant_sqlite import provision_local_grant
from papeer.core.edit_repository import initialize_edit_schema
from papeer.core.edits.provider.activation import upgrade_provider_metadata
from papeer.core.migrations import legacy_inventory
from papeer.core.migrations.legacy_backup import inventory_hash
from papeer.core.migrations.legacy_inventory import InventoryBudget, build_report, inventory_source, notebook_row_table

S, R, U = 'supported', 'retained-blocking', 'unknown'
MAIN_REASONS = sorted([
    'derived-file-retained', 'device-local-undecided', 'folder-not-converted', 'item-link-not-converted',
    'library-metadata-not-converted', 'markdown-not-converted', 'messages-not-converted', 'note-import-pending',
    'page-text-not-converted', 'pdf-annotation-not-converted', 'pdf-document-not-converted', 'summary-not-converted',
    'translation-not-converted', 'uncollected-source'])


def run(tmp_path, **options):
    synthetic = build_synthetic_library(tmp_path / 'library', **options)
    captured = synthetic.capture()
    report, sources, notebooks = run_inventory(synthetic, captured)
    return synthetic, captured, report, sources, notebooks


def source(report, kind):
    return next(item for item in report['sources'] if item['kind'] == kind)


def entries(src):
    return {tuple(item['key']): (item['category'], item['reason']) for item in src['entries']}


def containers(src):
    return {tuple(item['key']): (item['category'], item['reason']) for item in src['containers']}


def objects(src):
    return {item['name']: item for item in src['sqlite']['objects']}


def groups(src, table):
    return [(item['group'], item['count'], item['category'], item['reason']) for item in objects(src)[table]['rows']['groups']]


def without_entry(capture, key):
    """A published manifest of the same backup minus one entry (the existing `omit_shm` method)."""
    plan = deepcopy(capture.plan)
    plan['manifest']['id'] = str(uuid.uuid4())
    plan['manifest']['entries'] = [entry for entry in plan['manifest']['entries'] if entry['key'] != key]
    plan['manifest']['inventorySha256'] = inventory_hash(plan['manifest'])
    plan['observationSha256'] = 'f' * 64
    capture.backup.store.prepare(plan)
    capture.backup.store.publish(plan['manifest'])
    return Capture(capture.backup, plan, plan['manifest'])


# I-1 --------------------------------------------------------------------------------------------
def test_main_fixture_is_classified_exactly(tmp_path):
    synthetic, _captured, report, _sources, _notebooks = run(tmp_path)
    ids = synthetic.ids
    library = source(report, 'desktop-library')
    note_import = next(key for key in entries(library) if key[0] == '.note-imports')
    assert entries(library) == {
        note_import: (R, 'note-import-pending'), ('library.sqlite3',): (S, 'sqlite-database-inventoried'),
        ('papers', ids['A'], 'notebook.json'): (S, 'notebook-entry'), ('papers', ids['A'], 'original.pdf'): (R, 'derived-file-retained'),
        ('papers', ids['B'], 'notebook.json'): (S, 'notebook-entry'), ('papers', ids['B'], 'original.pdf'): (R, 'derived-file-retained'),
        ('papers', ids['M'], 'note.md'): (R, 'markdown-not-converted'),
        ('papers', ids['P'], 'original.pdf'): (R, 'pdf-document-not-converted'),
        ('papers', ids['P'], 'document.json'): (R, 'derived-file-retained'),
        ('papers', ids['P'], 'translation.md'): (R, 'translation-not-converted'),
        ('papers', ids['P'], 'translation-pages', '1.json'): (R, 'translation-not-converted'),
        ('papers', ids['P'], 'article.md'): (R, 'summary-not-converted'),
        ('papers', ids['P'], 'media', 'figure.png'): (R, 'summary-not-converted')}
    assert set(containers(library).values()) == {(S, 'directory-no-content')} and len(containers(library)) == 8
    assert library['missing'] == []
    tables = objects(library)
    assert {name: (item['category'], item['reason']) for name, item in tables.items() if item['type'] == 'table'} == {
        'attachments': (R, 'attachment-not-converted'), 'bookmarks': (R, 'pdf-annotation-not-converted'),
        'collection_glossaries': (R, 'library-metadata-not-converted'), 'collections': (R, 'folder-not-converted'),
        'item_links': (R, 'item-link-not-converted'), 'messages': (R, 'messages-not-converted'),
        'note_legacy': (R, 'markdown-not-converted'), 'note_operations': (R, 'note-operation-history-not-converted'),
        'note_state': (R, 'markdown-not-converted'), 'note_templates': (R, 'library-metadata-not-converted'),
        'pages': (R, 'page-text-not-converted'), 'paper_discovery': (R, 'reference-data-not-converted'),
        'papers': (R, 'library-metadata-not-converted'), 'pdf_ink': (R, 'pdf-annotation-not-converted'),
        'reading_status_choices': (R, 'library-metadata-not-converted'), 'reference_research': (R, 'reference-data-not-converted'),
        'sqlite_sequence': (S, 'sqlite-internal-no-content'), 'tag_choices': (R, 'library-metadata-not-converted')}
    assert all(item['category'] == S and item['reason'] == 'index-no-content' for item in tables.values() if item['type'] == 'index')
    assert library['sqlite']['userVersion'] == 9 and library['sqlite']['quickCheck'] == 'ok'
    assert library['sqlite']['foreignKeyCheck'] == 'ok' and library['sqlite']['journalMode'] == 'rollback'
    assert library['sqlite']['walComplete'] is True
    # Every actual row count equals the independent count.
    assert {name: item['rows']['total'] for name, item in tables.items() if item['type'] == 'table' and name != 'sqlite_sequence'} \
        == synthetic.expected['tables']
    canonical, device = source(report, 'canonical'), source(report, 'device')
    assert canonical['present'] is False and canonical['entries'] == [] and canonical['sqlite'] is None
    assert entries(device) == {(synthetic.library_key + '.opened.json',): (R, 'device-local-undecided'),
                               ('device-settings.json',): (R, 'device-local-undecided')}
    assert report['selfCheck'] == {'entries': [15, 15], 'containers': [8, 8], 'objects': [37, 37], 'columns': [84, 84],
                                   'notebooks': [2, 2]}
    assert report['summary']['blockingReasons'] == MAIN_REASONS      # equal, not a subset
    assert report['summary']['unknown'] == 4                           # the four uncollected locations only
    assert [item['location'] for item in report['uncollected']] == list(legacy_inventory.UNCOLLECTED)
    assert all(item == {'location': item['location'], 'category': U, 'reason': 'uncollected-source'} for item in report['uncollected'])
    assessment = legacy_inventory.whole_library_assessment(report)
    assert assessment == {'status': 'refused', 'reasons': MAIN_REASONS}
    columns = {item['name']: item['category'] for item in tables['papers']['columns']}
    assert sorted(name for name, category in columns.items() if category == S) == ['id', 'kind', 'pages', 'sha256']
    assert sum(1 for category in columns.values() if category == R) == 16
    assert report['version'] == 1 and report['scope'] == 'native-legacy-inventory-v1'


# I-2 --------------------------------------------------------------------------------------------
def test_notebook_table_matches_the_independent_count(tmp_path):
    synthetic, _captured, report, _sources, notebooks = run(tmp_path)
    assert [table['sourceDocumentId'] for table in notebooks] == sorted(synthetic.expected['notebooks'])
    assert report['notebooks'] == notebooks
    live = synthetic.root / 'papers'
    for table in notebooks:
        expected = synthetic.expected['notebooks'][table['sourceDocumentId']]
        raw = (live / table['sourceDocumentId'] / 'notebook.json').read_bytes()
        assert table['notebookEntry'] == {'sha256': hashlib.sha256(raw).hexdigest(), 'byteLength': len(raw)}
        assert table['revision'] == expected['revision'] and table['pageIds'] == expected['pageIds']
        assert table['pages'] == [{'number': number, 'pageId': page} for number, page in enumerate(expected['pageIds'], 1)]
        assert [(item['side'], item['page'], item['strokeCount']) for item in table['ink']] == expected['ink']
        assert all(item['pageId'] == expected['pageIds'][item['page'] - 1] for item in table['ink'] + table['bookmarks'])
        assert [(item['page'], item['kind']) for item in table['bookmarks']] == expected['marks']
        assert sum(item['strokeCount'] for item in table['ink']) == expected['strokes']
        assert sum(1 for item in table['bookmarks'] if item['kind'] == 'note') == expected['notes']
        assert sum(1 for item in table['bookmarks'] if item['kind'] == 'highlight') == expected['highlights']
        assert table['unmapped'] == 0 and table['problem'] is None
    a, b = (next(table for table in notebooks if table['sourceDocumentId'] == synthetic.ids[key]) for key in 'AB')
    assert (len(a['pageIds']), len(a['ink']), len(a['bookmarks'])) == (2, 1, 2)
    assert (len(b['pageIds']), len(b['ink']), len(b['bookmarks'])) == (3, 2, 2)
    assert a['relatedRows']['itemLinks'] == 1 and b['relatedRows']['itemLinks'] == 0
    assert set(a['relatedRows']) == {'messages', 'attachments', 'noteState', 'itemLinks', 'children', 'referenceResearch', 'paperDiscovery'}


# I-3 --------------------------------------------------------------------------------------------
def test_row_groups_split_notebook_pdf_and_markdown_rows(tmp_path):
    synthetic, _captured, report, _sources, _notebooks = run(tmp_path)
    library = source(report, 'desktop-library')
    assert groups(library, 'pdf_ink') == [('notebook', 3, S, 'notebook-annotation'), ('pdf', 1, R, 'pdf-annotation-not-converted')]
    assert groups(library, 'bookmarks') == [('notebook', 4, S, 'notebook-annotation'), ('pdf', 1, R, 'pdf-annotation-not-converted')]
    assert groups(library, 'pages') == [('notebook', 5, R, 'page-text-not-converted'), ('pdf', 1, R, 'pdf-document-not-converted')]
    assert groups(library, 'papers') == [('notebook', 2, R, 'library-metadata-not-converted'), ('pdf', 1, R, 'pdf-document-not-converted'),
                                         ('markdown', 1, R, 'markdown-not-converted')]
    assert groups(library, 'messages') == [('pdf', 2, R, 'messages-not-converted')]
    assert groups(library, 'note_state') == [('markdown', 1, R, 'markdown-not-converted')]
    assert groups(library, 'collections') == [('all', 2, R, 'folder-not-converted')]
    assert groups(library, 'attachments') == []
    totals = synthetic.expected['tables']
    assert totals['pdf_ink'] == 4 and totals['bookmarks'] == 5 and totals['pages'] == 6 and totals['messages'] == 2


# I-4 --------------------------------------------------------------------------------------------
def test_an_unlisted_table_is_unknown_even_when_empty(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    synthetic.sql('CREATE TABLE extra(x)')
    captured = synthetic.capture()
    report, _sources, _notebooks = run_inventory(synthetic, captured)
    item = objects(source(report, 'desktop-library'))['extra']
    assert (item['category'], item['reason'], item['rows']['total']) == (U, 'unknown-table', 0)
    assert 'unknown-table' in report['summary']['blockingReasons'] and report['summary']['unknown'] == 5


# I-5 --------------------------------------------------------------------------------------------
def test_unknown_and_generated_columns_make_the_table_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'one')
    synthetic.sql('ALTER TABLE messages ADD COLUMN extra TEXT')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    item = objects(source(report, 'desktop-library'))['messages']
    assert (item['category'], item['reason']) == (U, 'unknown-column')
    assert {column['reason'] for column in item['columns']} == {'unknown-column'} and item['rows']['groups'] == []
    assert 'unknown-column' in report['summary']['blockingReasons']
    second = build_synthetic_library(tmp_path / 'two' / 'library')
    second.sql('ALTER TABLE pages ADD COLUMN derived TEXT GENERATED ALWAYS AS (text) VIRTUAL')
    report, _sources, _notebooks = run_inventory(second, second.capture())
    item = objects(source(report, 'desktop-library'))['pages']
    assert (item['category'], item['reason']) == (U, 'generated-or-hidden-column')
    assert [column['reason'] for column in item['columns'] if column['name'] == 'derived'] == ['generated-or-hidden-column']
    assert 'generated-or-hidden-column' in report['summary']['blockingReasons']


# I-6 --------------------------------------------------------------------------------------------
def test_views_triggers_and_unlisted_indexes_are_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    synthetic.sql('CREATE VIEW extra_view AS SELECT 1', 'CREATE TRIGGER extra_trigger AFTER INSERT ON collections BEGIN SELECT 1; END',
                  'CREATE INDEX extra_index ON messages(role)')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    found = objects(source(report, 'desktop-library'))
    assert {name: found[name]['reason'] for name in ('extra_view', 'extra_trigger', 'extra_index')} == {
        'extra_view': 'unknown-view', 'extra_trigger': 'unknown-trigger', 'extra_index': 'unknown-index'}
    assert all(found[name]['category'] == U for name in ('extra_view', 'extra_trigger', 'extra_index'))
    assert {'unknown-view', 'unknown-trigger', 'unknown-index'} <= set(report['summary']['blockingReasons'])


# I-7 --------------------------------------------------------------------------------------------
def test_unlisted_files_and_orphan_folders_are_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    orphan = uuid.uuid4().hex
    (synthetic.root / 'papers' / orphan).mkdir()
    (synthetic.root / 'papers' / orphan / 'x.bin').write_bytes(b'x')
    (synthetic.root / 'foo.txt').write_text('x', 'utf-8')
    (synthetic.root / 'strange').mkdir()
    (synthetic.root / 'strange' / 'inner.txt').write_text('x', 'utf-8')
    (synthetic.root / 'papers' / synthetic.ids['A'] / 'extra.dat').write_bytes(b'x')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    library = source(report, 'desktop-library')
    assert entries(library)[('papers', orphan, 'x.bin')] == (U, 'orphan-item-folder')
    assert containers(library)[('papers', orphan)] == (U, 'orphan-item-folder')
    assert entries(library)[('foo.txt',)] == (U, 'unknown-file')
    assert entries(library)[('strange', 'inner.txt')] == (U, 'unknown-file')
    assert containers(library)[('strange',)] == (U, 'unknown-directory')
    assert entries(library)[('papers', synthetic.ids['A'], 'extra.dat')] == (U, 'unknown-file')
    assert {'orphan-item-folder', 'unknown-file', 'unknown-directory'} <= set(report['summary']['blockingReasons'])


def test_named_leftovers_attachments_and_settings_have_their_own_reasons(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    a, p = synthetic.ids['A'], synthetic.ids['P']
    attachment = uuid.uuid4().hex
    synthetic.sql(('INSERT INTO attachments(id,owner_id,format,title) VALUES(?,?,?,?)', (attachment, p, 'html', 'doc')))
    (synthetic.root / 'papers' / p / 'attachments').mkdir()
    (synthetic.root / 'papers' / p / 'attachments' / (attachment + '.html')).write_text('<p>x</p>', 'utf-8')
    (synthetic.root / 'papers' / p / 'attachments' / (uuid.uuid4().hex + '.md')).write_text('no row', 'utf-8')
    (synthetic.root / 'papers' / a / '.original.pdf.abc123.tmp').write_bytes(b'x')
    (synthetic.root / 'papers' / a / '.notebook-before.pdf').write_bytes(b'x')
    (synthetic.root / 'settings.json').write_text('{}', 'utf-8')
    (synthetic.root / 'prompts').mkdir()
    (synthetic.root / 'prompts' / 'translate.txt').write_text('x', 'utf-8')
    (synthetic.root / 'before-unified-notes.sqlite3').write_bytes(b'x')
    (synthetic.root / 'before-unified-notes-files' / 'papers' / a).mkdir(parents=True)
    (synthetic.root / 'before-unified-notes-files' / 'papers' / a / 'note.md').write_text('old', 'utf-8')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    found = entries(source(report, 'desktop-library'))
    assert found[('papers', p, 'attachments', attachment + '.html')] == (R, 'attachment-not-converted')
    unlisted = next(key for key in found if key[:3] == ('papers', p, 'attachments') and key[3].endswith('.md'))
    assert found[unlisted] == (U, 'unknown-file')
    assert found[('papers', a, '.original.pdf.abc123.tmp')] == (R, 'interrupted-atomic-output')
    assert found[('papers', a, '.notebook-before.pdf')] == (R, 'notebook-recovery-pending')
    assert found[('settings.json',)] == (R, 'library-settings-not-converted')
    assert found[('prompts', 'translate.txt')] == (R, 'library-settings-not-converted')
    assert found[('before-unified-notes.sqlite3',)] == (R, 'pre-migration-backup-retained')
    assert found[('before-unified-notes-files', 'papers', a, 'note.md')] == (R, 'pre-migration-backup-retained')
    assert 'attachment-not-converted' in report['summary']['blockingReasons']


# I-8 --------------------------------------------------------------------------------------------
def test_a_row_without_its_file_is_reported_missing(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    (synthetic.root / 'papers' / synthetic.ids['P'] / 'original.pdf').unlink()
    (synthetic.root / 'papers' / synthetic.ids['A'] / 'notebook.json').unlink()
    synthetic_captured = synthetic.capture()
    report, _sources, notebooks = run_inventory(synthetic, synthetic_captured)
    library = source(report, 'desktop-library')
    assert library['missing'] == sorted(library['missing'], key=lambda item: item['key']) and {
        (tuple(item['key']), item['category'], item['reason']) for item in library['missing']} == {
        (('papers', synthetic.ids['P'], 'original.pdf'), U, 'item-file-missing'),
        (('papers', synthetic.ids['A'], 'notebook.json'), U, 'item-file-missing')}
    assert 'item-file-missing' in report['summary']['blockingReasons']
    broken = next(table for table in notebooks if table['sourceDocumentId'] == synthetic.ids['A'])
    assert broken['problem'] == 'notebook-entry-missing' and broken['unmapped'] >= 1
    assert 'notebook-extraction-blocked' in report['summary']['blockingReasons']


@pytest.mark.parametrize('damage,problem', [
    ('invalid-json', 'notebook-json-invalid'), ('wrong-shape', 'notebook-shape-unsupported'),
    ('marker', 'notebook-marker-or-count-mismatch')])
def test_a_damaged_notebook_is_never_mapped(tmp_path, damage, problem):
    synthetic = build_synthetic_library(tmp_path / 'library')
    path = synthetic.root / 'papers' / synthetic.ids['A'] / 'notebook.json'
    if damage == 'invalid-json':
        path.write_text('{not json', 'utf-8')
    elif damage == 'wrong-shape':
        path.write_text('{"version": 1, "revision": 2, "pages": [], "extra": 1}', 'utf-8')
    else:
        synthetic.sql(('UPDATE papers SET pages = 9 WHERE id = ?', (synthetic.ids['A'],)))
    report, _sources, notebooks = run_inventory(synthetic, synthetic.capture())
    broken = next(table for table in notebooks if table['sourceDocumentId'] == synthetic.ids['A'])
    other = next(table for table in notebooks if table['sourceDocumentId'] == synthetic.ids['B'])
    assert broken['problem'] == problem and broken['unmapped'] >= 1 and other['problem'] is None and other['unmapped'] == 0
    assert 'notebook-extraction-blocked' in report['summary']['blockingReasons']


def test_unmappable_annotation_rows_are_counted_unmapped(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    a = synthetic.ids['A']
    synthetic.sql(("INSERT INTO pdf_ink VALUES(?, 'original', 9, '[]')", (a,)),
                  ("INSERT INTO pdf_ink VALUES(?, 'translated', 1, '[]')", (a,)),
                  ("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
                   " VALUES(?,1,'translated','q','l','n',0,0,'note','','[]')", (a,)),
                  ("UPDATE pdf_ink SET strokes = '{}' WHERE paper_id = ? AND page = 2", (a,)))
    report, _sources, notebooks = run_inventory(synthetic, synthetic.capture())
    table = next(item for item in notebooks if item['sourceDocumentId'] == a)
    # page 9 (out of range), side translated (ink and bookmark), and a strokes value that is not an array.
    assert table['unmapped'] == 4 and table['problem'] is None
    assert [item['pageId'] for item in table['ink'] if item['page'] == 9 or item['side'] == 'translated'] == [None, None]
    assert [item['strokeCount'] for item in table['ink'] if item['page'] == 2 and item['side'] == 'original'] == [None]
    library = source(report, 'desktop-library')
    assert ('notebook-unmapped', 2, R, 'notebook-annotation-unmapped') in groups(library, 'pdf_ink')
    assert ('notebook-unmapped', 1, R, 'notebook-annotation-unmapped') in groups(library, 'bookmarks')
    assert 'notebook-annotation-unmapped' in report['summary']['blockingReasons']


def test_rows_of_an_unlisted_kind_or_without_an_owner_are_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    synthetic.sql(("UPDATE papers SET kind = 'weird' WHERE id = ?", (synthetic.ids['M'],)),
                  ("INSERT INTO messages(paper_id,role,content,scope) VALUES('no-such-owner','user','SENTINEL-MESSAGE-CONTENT','paper')",))
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    library = source(report, 'desktop-library')
    assert ('other-kind', 1, U, 'item-kind-unknown') in groups(library, 'papers')
    assert ('orphan', 1, U, 'row-owner-missing') in groups(library, 'messages')
    assert library['sqlite']['foreignKeyCheck'] == 'violations'
    assert {'item-kind-unknown', 'row-owner-missing', 'sqlite-foreign-key-invalid'} <= set(report['summary']['blockingReasons'])
    assert entries(library)[('papers', synthetic.ids['M'], 'note.md')] == (R, 'legacy-memo-not-converted')


# I-9 / I-10 / I-11 ------------------------------------------------------------------------------
def test_a_complete_wal_is_counted_with_its_rows(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', wal=True)
    assert synthetic.expected['tables']['collections'] == 3
    # The main file alone does not contain the WAL-only row (the live connection still holds it).
    plain = tmp_path / 'main-only.sqlite3'
    plain.write_bytes((synthetic.root / 'library.sqlite3').read_bytes())
    with sqlite3.connect(plain) as db:
        assert db.execute('SELECT count(*) FROM collections').fetchone()[0] == 2
    captured = synthetic.capture()
    report, _sources, _notebooks = run_inventory(synthetic, captured)
    library = source(report, 'desktop-library')
    assert library['sqlite']['journalMode'] == 'wal' and library['sqlite']['walComplete'] is True and library['sqlite']['opened']
    assert entries(library)[('library.sqlite3-wal',)] == (S, 'sqlite-wal-complete')
    assert entries(library)[('library.sqlite3-shm',)] == (S, 'sqlite-wal-complete')
    assert objects(library)['collections']['rows']['total'] == 3
    store = next(item for item in report['pendingStores'] if item['location'] == 'library:library.sqlite3-wal')
    assert (store['count'], store['walComplete'], store['category'], store['reason']) == (1, True, S, 'sqlite-wal-complete')


@pytest.mark.parametrize('omit', [['library.sqlite3-shm'], ['library.sqlite3-wal']])
def test_an_incomplete_wal_is_unknown_and_the_database_is_not_opened(tmp_path, omit):
    synthetic = build_synthetic_library(tmp_path / 'library', wal=True)
    captured = synthetic.capture()
    captured['desktop-library'] = without_entry(captured['desktop-library'], omit)
    report, _sources, notebooks = run_inventory(synthetic, captured)
    library = source(report, 'desktop-library')
    present = ({'library.sqlite3-wal', 'library.sqlite3-shm'} - set(omit)).pop()
    assert entries(library)[(present,)] == (U, 'sqlite-wal-incomplete')
    assert entries(library)[('library.sqlite3',)] == (U, 'sqlite-wal-incomplete')
    assert library['sqlite']['walComplete'] is False and library['sqlite']['opened'] is False and library['sqlite']['objects'] == []
    assert notebooks == []
    # Files under papers/ cannot be tied to rows without the database: unknown, never "supported".
    assert all(category == U for key, (category, _reason) in entries(library).items() if key[0] == 'papers')
    assert {'sqlite-wal-incomplete', 'item-index-unavailable'} <= set(report['summary']['blockingReasons'])


def _table_view(src):
    """(category, reason, row total) of every table, to compare two sources whose only difference is the journal state."""
    return {name: (item['category'], item['reason'], item['rows']['total']) for name, item in objects(src).items() if item['type'] == 'table'}


# W-1 (B7-a, decision J5): header 2 and neither -wal nor -shm in the manifest = a database closed normally. It is read like any other.
def test_a_cleanly_closed_wal_database_is_inventoried_like_any_other(tmp_path):
    reference = run(tmp_path / 'delete-mode')[2]
    synthetic = build_synthetic_library(tmp_path / 'closed' / 'library', wal_closed=True)    # asserts: header 2, no -wal, no -shm
    captured = synthetic.capture()
    report, _sources, notebooks = run_inventory(synthetic, captured)
    library = source(report, 'desktop-library')
    assert library['sqlite']['journalMode'] == 'wal' and library['sqlite']['walComplete'] is True and library['sqlite']['opened'] is True
    assert library['sqlite']['reasons'] == [] and library['sqlite']['userVersion'] == 9 and library['sqlite']['quickCheck'] == 'ok'
    assert entries(library)[('library.sqlite3',)] == (S, 'sqlite-wal-closed')
    assert ('library.sqlite3-wal',) not in entries(library) and ('library.sqlite3-shm',) not in entries(library)
    store = next(item for item in report['pendingStores'] if item['location'] == 'library:library.sqlite3-wal')
    assert (store['count'], store['walComplete'], store['category'], store['reason']) == (0, True, S, 'sqlite-wal-closed')
    # Everything else is what the DELETE-mode main fixture reports: same tables, same row groups, same reasons, same notebooks.
    assert _table_view(library) == _table_view(source(reference, 'desktop-library'))
    assert report['summary']['blockingReasons'] == reference['summary']['blockingReasons'] == MAIN_REASONS
    assert report['summary']['unknown'] == 4 and 'sqlite-wal-incomplete' not in report['summary']['blockingReasons']
    assert [table['sourceDocumentId'] for table in notebooks] == sorted([synthetic.ids['A'], synthetic.ids['B']])
    assert legacy_inventory.notebooks_listable(library) is True
    assert {name: item['rows']['total'] for name, item in objects(library).items() if item['type'] == 'table' and name != 'sqlite_sequence'} \
        == synthetic.expected['tables']
    assert report['selfCheck']['notebooks'] == [2, 2]


@pytest.mark.parametrize('omit', [['library.sqlite3-shm'], ['library.sqlite3-wal']])
def test_a_wal_database_with_one_companion_stays_unknown_beside_the_closed_rule(tmp_path, omit):
    """W-2: dropping one companion from a complete WAL capture is `incomplete`; only dropping both is `closed` (the rule is
    not "either may be missing"). The closed variant's own test is above."""
    synthetic = build_synthetic_library(tmp_path / 'library', wal=True)
    captured = synthetic.capture()
    captured['desktop-library'] = without_entry(captured['desktop-library'], omit)
    library = source(run_inventory(synthetic, captured)[0], 'desktop-library')
    assert entries(library)[('library.sqlite3',)] == (U, 'sqlite-wal-incomplete')
    assert library['sqlite']['walComplete'] is False and library['sqlite']['opened'] is False


def test_a_wal_database_with_both_companions_dropped_from_the_manifest_is_the_closed_rule(tmp_path):
    """The same complete WAL capture with both companions removed from the manifest is, by the manifest alone, `closed`: the
    rule reads the manifest, so a capture that lost both is treated as one that never had them (and the copy is then the main
    file alone, which this test shows no longer holds the WAL-only row). That is the premise of J5: a source that was open
    would have had both files, and capture records what the tree holds."""
    synthetic = build_synthetic_library(tmp_path / 'library', wal=True)
    captured = synthetic.capture()
    captured['desktop-library'] = without_entry(without_entry(captured['desktop-library'], ['library.sqlite3-shm']), ['library.sqlite3-wal'])
    library = source(run_inventory(synthetic, captured)[0], 'desktop-library')
    assert entries(library)[('library.sqlite3',)] == (S, 'sqlite-wal-closed') and library['sqlite']['walComplete'] is True
    assert objects(library)['collections']['rows']['total'] == 2        # the WAL-only third folder is not in the main file


def test_a_closed_wal_canonical_store_is_inventoried_with_the_same_rule(tmp_path):
    """The canonical store (edit_storage.py also runs WAL) shares _database_state, so it gets the same rule."""
    synthetic = build_synthetic_library(tmp_path / 'library')
    _product_canonical_store(synthetic, rows=False)
    settle(synthetic.canonical_root / 'content.sqlite3', mode='WAL')
    assert (synthetic.canonical_root / 'content.sqlite3').read_bytes()[18:20] == b'\x02\x02'
    assert not (synthetic.canonical_root / 'content.sqlite3-wal').exists() and not (synthetic.canonical_root / 'content.sqlite3-shm').exists()
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    canonical = source(report, 'canonical')
    assert canonical['sqlite']['journalMode'] == 'wal' and canonical['sqlite']['walComplete'] is True and canonical['sqlite']['opened'] is True
    assert entries(canonical)[('content.sqlite3',)] == (S, 'sqlite-wal-closed')
    assert canonical['sqlite']['reasons'] == [] and all(item['category'] != U for item in canonical['sqlite']['objects'])


def test_the_wal_state_rule_is_one_function_for_the_inventory_and_the_extractor():
    from papeer.core.migrations.legacy_notebook_backup import sqlite_companion_state as state
    assert [state('wal', wal, shm) for wal, shm in ((True, True), (False, False), (True, False), (False, True))] \
        == ['complete', 'closed', 'incomplete', 'incomplete']
    assert [state('rollback', wal, shm) for wal, shm in ((False, False), (True, False), (False, True), (True, True))] \
        == ['plain', 'unexpected', 'unexpected', 'unexpected']


# B6-b low-2 (review r161): a WAL database in the analysis copy is not read without writing, and the module said it never writes.
def test_opening_a_wal_copy_writes_only_inside_the_copy(tmp_path):
    """The facts, pinned: the source Library, the canonical store, the device folder and the backup objects are byte for byte
    unchanged and no `.analysis-*` is left; inside the copy, SQLite creates the `-wal` and `-shm` of a closed WAL database
    (and rewrites the `-shm` of a complete one) and nothing else changes."""
    for options in ({'wal_closed': True}, {'wal': True}):
        folder = tmp_path / ('closed' if options.get('wal_closed') else 'complete')
        synthetic = build_synthetic_library(folder / 'library', **options)
        captured = synthetic.capture()
        before, backup_before = synthetic.tree_hashes(), tree_hashes(captured['desktop-library'].backup.root)
        with analysis(captured, 'desktop-library') as copy:
            files = tree_hashes(copy)
            inventory_source('desktop-library', captured['desktop-library'].manifest, copy)
            changed = {name for name, digest in tree_hashes(copy).items() if files.get(name) != digest}
        # -shm is rewritten (complete) or created (closed); -wal is created only when the manifest had none.
        assert changed == ({'library.sqlite3-shm', 'library.sqlite3-wal'} if options.get('wal_closed') else {'library.sqlite3-shm'}), changed
        assert synthetic.tree_hashes() == before and tree_hashes(captured['desktop-library'].backup.root) == backup_before
        assert not [name for name in tree_hashes(captured['desktop-library'].backup.root) if '.analysis-' in name]


def test_a_stray_wal_beside_a_rollback_database_is_unexpected(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    (synthetic.root / 'library.sqlite3-wal').write_bytes(b'stray')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture(refresh_expected=False))
    library = source(report, 'desktop-library')
    assert entries(library)[('library.sqlite3-wal',)] == (U, 'sqlite-wal-unexpected')
    assert entries(library)[('library.sqlite3',)] == (U, 'sqlite-wal-unexpected') and library['sqlite']['opened'] is False
    assert 'sqlite-wal-unexpected' in report['summary']['blockingReasons']


def test_a_rollback_journal_blocks_and_the_database_is_not_opened(tmp_path, monkeypatch):
    synthetic = build_synthetic_library(tmp_path / 'library')
    (synthetic.root / 'library.sqlite3-journal').write_bytes(b'hot journal')
    captured = synthetic.capture(refresh_expected=False)

    def refuse(*_args, **_kwargs):
        raise AssertionError('the database must not be opened while a rollback journal is pending')

    monkeypatch.setattr(legacy_inventory, '_database', refuse)
    report, _sources, notebooks = run_inventory(synthetic, captured)
    library = source(report, 'desktop-library')
    assert entries(library)[('library.sqlite3-journal',)] == (R, 'sqlite-rollback-journal-pending')
    assert entries(library)[('library.sqlite3',)] == (R, 'sqlite-rollback-journal-pending')
    assert library['sqlite']['opened'] is False and library['sqlite']['objects'] == [] and notebooks == []
    assert 'sqlite-rollback-journal-pending' in report['summary']['blockingReasons']
    store = next(item for item in report['pendingStores'] if item['location'] == 'library:note_operations')
    assert (store['category'], store['reason']) == (U, 'sqlite-not-inventoried')


# I-12 -------------------------------------------------------------------------------------------
def test_optional_tables_are_retained_blocking_not_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', optional_tables=('global_glossary', 'collection_undo'))
    synthetic.sql("INSERT INTO global_glossary VALUES(1, '[]')", "INSERT INTO collection_undo VALUES('t', '{}')")
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    found = objects(source(report, 'desktop-library'))
    assert (found['global_glossary']['category'], found['global_glossary']['reason']) == (R, 'library-metadata-not-converted')
    assert (found['collection_undo']['category'], found['collection_undo']['reason']) == (R, 'undo-state-not-converted')
    assert 'undo-state-not-converted' in report['summary']['blockingReasons']
    assert report['summary']['unknown'] == 4


# W-7 (B7-a): the fixture writes a highlight's `rects` the way the product does (it used to store `[[.2,...]]`, which is not JSON) ----
def test_the_rects_text_the_fixture_uses_is_what_the_product_writes():
    # No fixture needed: the constant the fixture inserts. library_annotations.py writes floats through json.dumps with compact
    # separators (leading zeros, no spaces); `[[.2,.3,...]]` is not JSON.
    assert json.loads(HIGHLIGHT_RECTS) == [[.2, .3, .25, .025], [.1, .35, .4, .03]]
    assert HIGHLIGHT_RECTS == '[[0.2,0.3,0.25,0.025],[0.1,0.35,0.4,0.03]]'


def test_the_fixture_stores_highlight_rects_as_the_product_writes_them(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    with closing(sqlite3.connect(synthetic.root / 'library.sqlite3')) as db:
        stored = [row[0] for row in db.execute("SELECT rects FROM bookmarks WHERE kind = 'highlight' ORDER BY id")]
    assert len(stored) == 1
    # library_annotations.py normalizes to floats and writes json.dumps(..., separators=(',', ':')): leading zeros, no spaces.
    assert json.loads(stored[0]) == [[.2, .3, .25, .025], [.1, .35, .4, .03]]
    assert stored[0] == json.dumps(json.loads(stored[0]), separators=(',', ':')) == '[[0.2,0.3,0.25,0.025],[0.1,0.35,0.4,0.03]]'


# W-4 / W-5 (B7-a): the tables and the file a Library that used glossaries has (review r161 B6-b low-6) ---------------------------
GLOSSARY_RESULTS = {'paper_glossary': (R, 'library-metadata-not-converted'), 'paper_glossary_domains': (R, 'library-metadata-not-converted'),
                    'web_annotation_ops': (R, 'web-annotation-ops-not-converted')}


def test_glossary_tables_and_the_legacy_glossary_file_are_classified(tmp_path):
    synthetic, _captured, report, _sources, _notebooks = run(tmp_path, glossary_tables=True)
    library = source(report, 'desktop-library')
    found = objects(library)
    for name, result in GLOSSARY_RESULTS.items():
        assert (found[name]['category'], found[name]['reason']) == result, name
        assert found[name]['rows']['total'] == 1 and all(column['category'] == R for column in found[name]['columns'])
    assert groups(library, 'paper_glossary') == [('notebook', 1, R, 'library-metadata-not-converted')]       # the row belongs to notebook A
    assert groups(library, 'paper_glossary_domains') == [('notebook', 1, R, 'library-metadata-not-converted')]
    assert groups(library, 'web_annotation_ops') == [('all', 1, R, 'web-annotation-ops-not-converted')]
    assert entries(library)[('papers', synthetic.ids['A'], 'glossary.json')] == (R, 'library-metadata-not-converted')
    assert report['summary']['blockingReasons'] == sorted({*MAIN_REASONS, 'web-annotation-ops-not-converted'})
    assert report['summary']['unknown'] == 4          # still only the uncollected locations: nothing here is unknown
    assert not [item for item in found.values() if item['category'] == U]
    assert {name: found[name]['rows']['total'] for name in GLOSSARY_RESULTS} == {name: synthetic.expected['tables'][name] for name in GLOSSARY_RESULTS}
    assert report['selfCheck']['objects'][0] == report['selfCheck']['objects'][1]
    assert synthetic.expected['tables']['paper_glossary'] == 1       # the product function's default row is there


def test_the_fixture_creates_the_glossary_tables_as_the_product_does(tmp_path):
    """W-4: the tables the `glossary_tables` variant gets from terminology.py's own functions have the columns the classification
    expects and the statements the fixture keeps; the third statement equals the one in cloud_annotations.py."""
    root = Path(__file__).resolve().parents[2]
    synthetic = build_synthetic_library(tmp_path / 'library', glossary_tables=True)
    with closing(sqlite3.connect(synthetic.root / 'library.sqlite3')) as db:
        made = {name: [tuple(row[1:3]) + tuple(row[3:6]) for row in db.execute(f'PRAGMA table_info("{name}")')]
                for name in legacy_inventory._OPTIONAL_COLUMNS if db.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (name,)).fetchone()}
    assert {'paper_glossary', 'paper_glossary_domains', 'web_annotation_ops'} <= set(made)
    with closing(sqlite3.connect(':memory:')) as db:
        for name in ('paper_glossary', 'paper_glossary_domains', 'web_annotation_ops'):
            db.execute(OPTIONAL_TABLE_SQL[name])
            assert [tuple(row[1:3]) + tuple(row[3:6]) for row in db.execute(f'PRAGMA table_info("{name}")')] == made[name], name
    for name in ('paper_glossary', 'paper_glossary_domains', 'web_annotation_ops'):
        assert [column[0] for column in made[name]] == legacy_inventory._OPTIONAL_COLUMNS[name].split(), name
    source_text = (root / 'papeer' / 'core' / 'cloud_annotations.py').read_text('utf-8')
    assert 'db.execute("' + OPTIONAL_TABLE_SQL['web_annotation_ops'] + '")' in source_text


@pytest.mark.parametrize('kind', ['notebook', 'pdf', 'markdown'])
def test_a_legacy_glossary_file_is_retained_in_the_folder_of_any_known_item(tmp_path, kind):
    synthetic = build_synthetic_library(tmp_path / 'library')
    owner = synthetic.ids[{'notebook': 'A', 'pdf': 'P', 'markdown': 'M'}[kind]]
    (synthetic.root / 'papers' / owner / 'glossary.json').write_text('[{"source": "synthetic", "target": "x"}]', 'utf-8')
    library = source(run_inventory(synthetic, synthetic.capture())[0], 'desktop-library')
    assert entries(library)[('papers', owner, 'glossary.json')] == (R, 'library-metadata-not-converted')


def test_a_glossary_file_in_a_folder_without_an_item_is_still_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    orphan = synthetic.root / 'papers' / uuid.uuid4().hex
    orphan.mkdir()
    (orphan / 'glossary.json').write_text('[]', 'utf-8')
    library = source(run_inventory(synthetic, synthetic.capture())[0], 'desktop-library')
    assert entries(library)[('papers', orphan.name, 'glossary.json')] == (U, 'orphan-item-folder')


def test_a_glossary_row_without_a_paper_is_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', glossary_tables=True)
    synthetic.sql("INSERT INTO paper_glossary VALUES('no-such-paper', '[]', '[]', NULL)")
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    library = source(report, 'desktop-library')
    assert ('orphan', 1, U, 'row-owner-missing') in groups(library, 'paper_glossary')
    assert 'row-owner-missing' in report['summary']['blockingReasons']


# W-8 (mutation target): a table taken out of the classification is unknown, with its own reason -------------------------------
@pytest.mark.parametrize('name', ['paper_glossary', 'paper_glossary_domains', 'web_annotation_ops'])
def test_removing_a_glossary_table_from_the_classification_makes_it_unknown(tmp_path, monkeypatch, name):
    synthetic = build_synthetic_library(tmp_path / 'library', glossary_tables=True)
    captured = synthetic.capture()
    monkeypatch.delitem(legacy_inventory.LIBRARY_TABLES, name)
    report, _sources, _notebooks = run_inventory(synthetic, captured)
    item = objects(source(report, 'desktop-library'))[name]
    assert (item['category'], item['reason']) == (U, 'unknown-table')
    # The table and the automatic index of its TEXT primary key (an index of an unknown table is unknown), besides the four uncollected locations.
    assert objects(source(report, 'desktop-library'))[f'sqlite_autoindex_{name}_1']['reason'] == 'unknown-index'
    assert report['summary']['unknown'] == 6 and {'unknown-table', 'unknown-index'} <= set(report['summary']['blockingReasons'])


# I-13 -------------------------------------------------------------------------------------------
def test_another_schema_version_makes_every_object_unknown(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    synthetic.sql('PRAGMA user_version=8')
    report, _sources, notebooks = run_inventory(synthetic, synthetic.capture())
    library = source(report, 'desktop-library')
    assert library['sqlite']['userVersion'] == 8
    assert library['sqlite']['objects'] and all(
        (item['category'], item['reason']) == (U, 'schema-version-unsupported') for item in library['sqlite']['objects'])
    assert all(column['reason'] == 'schema-version-unsupported' for item in library['sqlite']['objects'] for column in item['columns'])
    assert entries(library)[('library.sqlite3',)] == (U, 'schema-version-unsupported') and notebooks == []
    assert 'schema-version-unsupported' in report['summary']['blockingReasons']


# I-14 -------------------------------------------------------------------------------------------
def test_canonical_absent_and_pending(tmp_path):
    absent_synthetic, _c, absent, _s, _n = run(tmp_path / 'absent')
    del absent_synthetic
    assert source(absent, 'canonical')['present'] is False
    stores = {item['location']: item for item in absent['pendingStores']}
    assert stores['canonical:edit_intents']['present'] is False and stores['canonical:edit_intents']['count'] == 0
    assert 'canonical-pending-intent' not in absent['summary']['blockingReasons']
    synthetic = build_synthetic_library(tmp_path / 'pending' / 'library', canonical_pending=True)
    synthetic.canonical_sql(
        ("INSERT INTO edit_batches VALUES('s','b1','t','{}','{\"upload\":\"pending\"}',NULL)",),
        ("INSERT INTO edit_batches VALUES('s','b2','t','{}','{\"upload\":\"done\"}',NULL)",),
        ("INSERT INTO edit_batches VALUES('s','b3','t','{}','not json',NULL)",),
        'CREATE TABLE canonical_unlisted_future (account TEXT PRIMARY KEY, payload TEXT NOT NULL)')
    (synthetic.canonical_root / 'unlisted.bin').write_bytes(b'x')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    canonical = source(report, 'canonical')
    found = objects(canonical)
    assert canonical['present'] is True and canonical['sqlite']['opened'] is True
    assert (found['edit_intents']['category'], found['edit_intents']['reason']) == (R, 'canonical-pending-intent')
    assert groups(canonical, 'edit_batches') == [('pending-upload', 1, R, 'canonical-pending-upload'),
                                                 ('other', 1, R, 'canonical-store-present'),
                                                 ('receipt-unreadable', 1, U, 'canonical-receipt-unreadable')]
    assert (found['edit_roots']['category'], found['edit_roots']['rows']['total']) == (R, 0)
    assert found['canonical_unlisted_future']['reason'] == 'unknown-table'
    assert 'canonical_unlisted_future' not in legacy_inventory.CANONICAL_COLUMNS      # not a table the product creates
    assert found['edit_batch_target']['reason'] == 'index-no-content'
    assert entries(canonical)[('unlisted.bin',)] == (U, 'unknown-file')
    stores = {item['location']: item for item in report['pendingStores']}
    assert (stores['canonical:edit_intents']['count'], stores['canonical:edit_batches(pending upload)']['count']) == (1, 1)
    # This store never created the later tables: no such table means no row, not an unknown.
    for location in ('canonical:canonical_initial_intents', 'canonical:canonical_provider_intents'):
        assert (stores[location]['count'], stores[location]['category'], stores[location]['present']) == (0, S, True)
    assert {'canonical-pending-intent', 'canonical-pending-upload', 'canonical-store-present', 'canonical-receipt-unreadable',
            'unknown-table', 'unknown-file'} <= set(report['summary']['blockingReasons'])


def _product_canonical_store(synthetic, *, rows: bool):
    """content.sqlite3 made only by the product's own functions, in the order the host runs them
    (canonical_host.py provision, then initialize_edit_schema + initialize_canonical_metadata, then the provider hub)."""
    synthetic.canonical_root.mkdir(mode=0o700, exist_ok=True)
    path = synthetic.canonical_root / 'content.sqlite3'
    provision_local_grant(path)
    with closing(sqlite3.connect(path)) as db:
        initialize_edit_schema(db)
        initialize_canonical_metadata(db)
        upgrade_provider_metadata(db)
        if rows:
            db.execute("INSERT INTO canonical_peers VALUES('acct','{}')")
            db.execute("INSERT INTO canonical_profiles VALUES('id1','acct','lib','r1','{}')")
            db.execute("INSERT INTO canonical_initial_intents VALUES('acct','r1','lib',0,'{}')")
            db.execute("INSERT INTO canonical_initial_intents VALUES('acct','r2','lib2',1,'{}')")
            db.execute("INSERT INTO canonical_initial_intents VALUES('acct','r3','lib3',1,'{}')")
            db.execute("INSERT INTO canonical_initial_artifacts VALUES('id1','{}')")
            db.execute("INSERT INTO canonical_provider_bindings VALUES('o','id1','{}')")
            db.execute("INSERT INTO canonical_provider_intents VALUES('o','r1','{}')")
            db.execute("INSERT INTO canonical_provider_intents VALUES('o','r2','{}')")
            db.execute("INSERT INTO canonical_provider_artifacts VALUES('o','r1','{}')")
            db.execute("INSERT INTO canonical_provider_resource_bytes VALUES('o','r1','res',x'00')")
            db.execute("INSERT INTO canonical_provider_acknowledgements VALUES('o','r1')")
        db.commit()
    settle(path)


def test_the_canonical_classification_is_exactly_what_the_product_creates(tmp_path):
    """The classification is compared with the real creating functions, not with a list copied from them."""
    path = tmp_path / 'content.sqlite3'
    provision_local_grant(path)
    with closing(sqlite3.connect(path)) as db:
        initialize_edit_schema(db)
        initialize_canonical_metadata(db)
        upgrade_provider_metadata(db)
        tables = {name: [row[1] for row in db.execute(f'PRAGMA table_info("{name}")')] for (name,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()}
        indexes = {name: table for name, table in db.execute(
            "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%'").fetchall()}
    assert tables == {name: columns.split() for name, columns in legacy_inventory.CANONICAL_COLUMNS.items()}
    assert len(tables) == 21
    assert indexes == legacy_inventory.CANONICAL_INDEXES


# Library-side tables product code creates on use that the classification does not list yet (review r161 low-6). They would be
# unknown on purpose; this set may only shrink, and it has been empty since B7-a classified paper_glossary, paper_glossary_domains
# and web_annotation_ops. The search index is a separate file (<key>.search.sqlite3) classified as a file.
KNOWN_UNCLASSIFIED_LIBRARY_TABLES: set[str] = set()
SEARCH_INDEX_OBJECTS = {'info', 'sources', 'entries', 'texts', 'entries_source'}
_CREATE = re.compile(r'CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)',
                     re.IGNORECASE)


def test_every_table_the_product_code_creates_is_classified_or_a_named_gap():
    """A CREATE TABLE/INDEX added anywhere in papeer/ or sidecar/ fails here until the classification (or the named gap) is updated."""
    root = Path(__file__).resolve().parents[2]
    created: dict[str, set[str]] = {}
    staging: set[str] = set()
    for folder in ('papeer', 'sidecar'):
        for file in (root / folder).rglob('*.py'):
            if file.name == 'legacy_inventory.py':
                continue
            if file.name == 'legacy_staging_store.py':
                # B7-c: the staging database is a file of its own (beside the Library, never captured as a source), so its tables
                # are not Library or canonical tables; they are compared with the staging module's own list below.
                staging.update(_CREATE.findall(file.read_text('utf-8')))
                continue
            for name in _CREATE.findall(file.read_text('utf-8')):
                created.setdefault(name, set()).add(file.relative_to(root).as_posix())
    from papeer.core.migrations import legacy_staging_store
    assert staging == set(legacy_staging_store.STAGING_TABLES), 'the staging module creates exactly its own tables (the edit tables come from edit_repository.py)'
    assert not staging & (set(legacy_inventory.LIBRARY_TABLES) | set(legacy_inventory.CANONICAL_COLUMNS))
    assert len(created) >= 40                               # the scan found the statements at all
    classified = (set(legacy_inventory.LIBRARY_TABLES) | set(legacy_inventory.CANONICAL_COLUMNS) | set(legacy_inventory.LIBRARY_INDEXES)
                  | set(legacy_inventory.CANONICAL_INDEXES) | KNOWN_UNCLASSIFIED_LIBRARY_TABLES | SEARCH_INDEX_OBJECTS)
    assert sorted(set(created) - classified) == []
    # The named gaps really are unclassified (so the set shrinks when the classification grows), and nothing listed is stale.
    assert not KNOWN_UNCLASSIFIED_LIBRARY_TABLES & (set(legacy_inventory.LIBRARY_TABLES) | set(legacy_inventory.CANONICAL_COLUMNS))
    assert (KNOWN_UNCLASSIFIED_LIBRARY_TABLES | SEARCH_INDEX_OBJECTS) <= set(created)
    # Every canonical table is created by one of the four modules named in the classification's comment.
    canonical_files = {'papeer/core/edit_repository.py', 'papeer/core/bootstrap/canonical_local_grant_sqlite.py',
                       'papeer/core/bootstrap/canonical_initialization_sqlite.py', 'papeer/core/edits/provider/activation.py'}
    assert {file for name in legacy_inventory.CANONICAL_COLUMNS for file in created[name]} == canonical_files


def test_a_store_made_by_the_product_is_raw_preserved_with_intents_as_pending_stores(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    _product_canonical_store(synthetic, rows=True)
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    canonical = source(report, 'canonical')
    found = objects(canonical)
    assert canonical['present'] is True and canonical['sqlite']['opened'] is True
    # Nothing the product creates is unknown, and nothing is mapped (supported): there is no converter for any of them.
    tables = {name: item for name, item in found.items() if item['type'] == 'table'}
    assert set(tables) == set(legacy_inventory.CANONICAL_COLUMNS)
    assert all(item['category'] == R for item in tables.values())
    assert [name for name, item in found.items() if item['category'] == U] == []
    assert all(item['category'] == S and item['reason'] == 'index-no-content' for item in found.values() if item['type'] == 'index')
    assert {'canonical_intent_library', 'edit_batch_target'} <= set(found)
    assert {name: item['rows']['total'] for name, item in tables.items() if item['rows']['total']} == {
        'canonical_peers': 1, 'canonical_profiles': 1, 'canonical_initial_intents': 3, 'canonical_initial_artifacts': 1,
        'canonical_provider_bindings': 1, 'canonical_provider_intents': 2, 'canonical_provider_artifacts': 1,
        'canonical_provider_resource_bytes': 1, 'canonical_provider_acknowledgements': 1, 'canonical_local_owner_grants': 1}
    assert groups(canonical, 'canonical_initial_intents') == [('pending', 1, R, 'canonical-pending-intent'),
                                                              ('retired', 2, R, 'canonical-store-present')]
    assert groups(canonical, 'canonical_provider_intents') == [('all', 2, R, 'canonical-pending-intent')]
    for name in ('canonical_local_owner_grants', 'canonical_peers', 'canonical_profiles', 'canonical_initial_artifacts',
                 'canonical_provider_bindings', 'canonical_provider_artifacts', 'canonical_provider_resource_bytes',
                 'canonical_provider_acknowledgements'):
        assert groups(canonical, name) == [('all', 1, R, 'canonical-store-present')], name
    stores = {item['location']: item for item in report['pendingStores']}
    assert {location: (item['count'], item['category'], item['reason']) for location, item in stores.items()
            if location.startswith('canonical:')} == {
        'canonical:edit_intents': (0, S, 'pending-store-empty'),
        'canonical:edit_batches(pending upload)': (0, S, 'pending-store-empty'),
        'canonical:canonical_initial_intents': (1, R, 'canonical-pending-intent'),
        'canonical:canonical_provider_intents': (2, R, 'canonical-pending-intent')}
    assert 'unknown-table' not in report['summary']['blockingReasons']
    assert 'canonical-pending-intent' in report['summary']['blockingReasons']
    # A store whose intent tables are empty reports them as empty (they exist, they hold nothing).
    empty = build_synthetic_library(tmp_path / 'empty' / 'library')
    _product_canonical_store(empty, rows=False)
    empty_report, _sources, _notebooks = run_inventory(empty, empty.capture())
    empty_stores = {item['location']: item for item in empty_report['pendingStores'] if item['location'].startswith('canonical:')}
    assert len(empty_stores) == 4 and {item['count'] for item in empty_stores.values()} == {0}
    assert 'canonical-pending-intent' not in empty_report['summary']['blockingReasons']
    assert 'unknown-table' not in empty_report['summary']['blockingReasons']


# I-15 -------------------------------------------------------------------------------------------
def test_device_files_are_classified(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', folder_sync_state=True)
    key = synthetic.library_key
    for name in ('.sync-blobs.json', '.fingerprint.json', '.review-pages.json', '.search.sqlite3', '.search.sqlite3-wal', '.weird.bin'):
        (synthetic.device / (key + name)).write_bytes(b'x')
    for name in ('history-settings.json', 'ocr-settings.json'):
        (synthetic.device / name).write_text('{}', 'utf-8')
    (synthetic.device / ('.' + key + '.x.abc.tmp')).write_bytes(b'x')
    (synthetic.device / 'storage-location.json').write_text(
        json.dumps({'path': str(synthetic.root), 'pending': {'source': str(synthetic.root), 'destination': str(tmp_path / 'elsewhere')}}), 'utf-8')
    report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    device = source(report, 'device')
    found = entries(device)
    assert found[(key + '.json',)] == (R, 'folder-sync-state-pending')
    assert found[(key + '.sync-blobs.json',)] == (R, 'folder-sync-state-pending')
    assert found[(key + '.cloud-drive.json',)] == (R, 'drive-binding-undecided')
    assert found[(key + '.fingerprint.json',)] == (R, 'device-local-undecided')
    assert found[(key + '.review-pages.json',)] == (R, 'device-local-undecided')
    assert found[(key + '.search.sqlite3',)] == (R, 'derived-file-retained')
    assert found[(key + '.search.sqlite3-wal',)] == (R, 'derived-file-retained')
    assert found[(key + '.weird.bin',)] == (U, 'unknown-file')
    assert found[('.' + key + '.x.abc.tmp',)] == (R, 'interrupted-atomic-output')
    assert found[('history', key, 'state.json')] == (R, 'legacy-history-not-converted')
    assert all(found[(name,)] == (R, 'device-local-undecided') for name in
               ('device-settings.json', 'history-settings.json', 'ocr-settings.json', 'storage-location.json'))
    assert containers(device) == {('history',): (S, 'directory-no-content'), ('history', key): (S, 'directory-no-content')}
    stores = {item['location']: item for item in report['pendingStores']}
    assert stores['device:<libraryKey>.json']['count'] == 1 and stores['device:<libraryKey>.cloud-drive.json']['count'] == 1
    pending = stores['device:storage-location.json#pending']
    assert (pending['count'], pending['category'], pending['reason']) == (1, U, 'storage-location-pending')
    assert {'folder-sync-state-pending', 'drive-binding-undecided', 'legacy-history-not-converted', 'storage-location-pending',
            'unknown-file'} <= set(report['summary']['blockingReasons'])


def test_a_pending_notebook_change_is_a_pending_store(tmp_path):
    synthetic, _captured, report, _sources, _notebooks = run(tmp_path, notebook_journal=True)
    library = source(report, 'desktop-library')
    assert entries(library)[('papers', synthetic.ids['B'], '.notebook-change.json')] == (R, 'notebook-recovery-pending')
    stores = {item['location']: item for item in report['pendingStores']}
    assert stores['library:papers/*/.notebook-change.json']['count'] == 1 and stores['library:.note-imports']['count'] == 1
    assert 'notebook-recovery-pending' in report['summary']['blockingReasons']
    clean = run(tmp_path / 'clean', note_import=False)[2]
    clean_stores = {item['location']: item for item in clean['pendingStores']}
    assert clean_stores['library:.note-imports']['count'] == 0 and clean_stores['library:.note-imports']['category'] == S
    assert 'note-import-pending' not in clean['summary']['blockingReasons']


# I-16 -------------------------------------------------------------------------------------------
def test_cancel_is_honoured_inside_sqlite(tmp_path, monkeypatch):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(ValueError, match='^inventory-cancelled$'):
        run_inventory(synthetic, captured, cancel=cancel)
    # With every explicit check disabled only the progress handler can stop it.
    monkeypatch.setattr(legacy_inventory, '_check', lambda _cancel: None)
    monkeypatch.setattr(legacy_inventory, 'PROGRESS_INTERVAL', 1)
    with pytest.raises(ValueError, match='^inventory-cancelled$'):
        run_inventory(synthetic, captured, cancel=cancel)
    # The caller's copy removes itself: nothing remains in the backup folders.
    assert not list(captured['desktop-library'].backup.root.glob('.analysis-*'))


# I-17 -------------------------------------------------------------------------------------------
def test_removing_a_table_from_the_classification_makes_it_unknown(tmp_path, monkeypatch):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    monkeypatch.delitem(legacy_inventory.LIBRARY_TABLES, 'messages')
    report, _sources, _notebooks = run_inventory(synthetic, captured)
    item = objects(source(report, 'desktop-library'))['messages']
    assert (item['category'], item['reason']) == (U, 'unknown-table')
    assert 'unknown-table' in report['summary']['blockingReasons'] and 'messages-not-converted' not in report['summary']['blockingReasons']
    assert report['summary']['unknown'] == 5


def test_the_classification_covers_exactly_the_schema_nine_tables():
    from papeer.core.migrations.legacy_notebook_backup import _COLUMNS
    assert set(legacy_inventory.LIBRARY_TABLES) == set(_COLUMNS) | set(legacy_inventory._OPTIONAL_COLUMNS)
    assert set(legacy_inventory._OPTIONAL_COLUMNS) == {'global_glossary', 'collection_undo', 'paper_glossary', 'paper_glossary_domains',
                                                       'web_annotation_ops'}
    assert len(_COLUMNS) == 17
    for name, columns in {**_COLUMNS, **legacy_inventory._OPTIONAL_COLUMNS}.items():
        rules = legacy_inventory.LIBRARY_TABLES[name]['groups']
        assert rules and all(category in (S, R, U) for items in rules.values() for _c, category, _r in items)
        covered = {column for items in rules.values() for cols, _category, _reason in items for column in (cols or columns.split())}
        assert covered == set(columns.split())


def test_a_fresh_library_has_no_table_outside_the_classification(tmp_path):
    from papeer.core.storage import Library
    root = tmp_path / 'fresh'
    Library(root)
    with sqlite3.connect(root / 'library.sqlite3') as db:
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    from papeer.core.migrations.legacy_notebook_backup import _COLUMNS
    assert names <= set(legacy_inventory.LIBRARY_TABLES) and names == set(_COLUMNS)


# I-18 -------------------------------------------------------------------------------------------
def test_budgets_refuse_instead_of_truncating(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    for budget in (InventoryBudget(max_objects=3), InventoryBudget(max_columns_per_table=2)):
        with pytest.raises(ValueError, match='^inventory-capacity-exceeded$'):
            run_inventory(synthetic, captured, budget=budget)
    manifest = captured['desktop-library'].manifest
    with analysis(captured, 'desktop-library') as copy:
        with pytest.raises(ValueError, match='^inventory-capacity-exceeded$'):
            notebook_row_table(copy, manifest, synthetic.ids['A'], budget=InventoryBudget(max_value_bytes=8))
    report, sources, notebooks = run_inventory(synthetic, captured)
    with pytest.raises(ValueError, match='^inventory-capacity-exceeded$'):
        build_report(sources, notebooks, budget=InventoryBudget(max_report_bytes=100))
    assert report['reportSha256']
    with pytest.raises(ValueError, match='^inventory-budget-invalid$'):
        InventoryBudget(max_objects=-1)


def test_stroke_json_is_read_under_a_cumulative_budget(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    big = json.dumps(['x' * 2490])
    synthetic.sql(('UPDATE pdf_ink SET strokes = ? WHERE paper_id = ?', (big, synthetic.ids['B'])))
    captured = synthetic.capture()
    manifest = captured['desktop-library'].manifest
    with analysis(captured, 'desktop-library') as copy:
        # Two values of about 2.5 KB each pass the per-value limit (4096) but not the 4096-byte total.
        with pytest.raises(ValueError, match='^inventory-capacity-exceeded$'):
            notebook_row_table(copy, manifest, synthetic.ids['B'], budget=InventoryBudget(max_value_bytes=4096))
        table = notebook_row_table(copy, manifest, synthetic.ids['B'], budget=InventoryBudget(max_value_bytes=64 * 1024))
        assert [item['strokeCount'] for item in table['ink']] == [1, 1]
        # One value above the per-value limit is refused as well.
        with pytest.raises(ValueError, match='^inventory-capacity-exceeded$'):
            notebook_row_table(copy, manifest, synthetic.ids['B'], budget=InventoryBudget(max_value_bytes=1024))


def test_report_has_no_content_or_paths_and_is_deterministic(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', optional_tables=('collection_undo',), folder_sync_state=True)
    captured = synthetic.capture()
    first, _sources, _notebooks = run_inventory(synthetic, captured)
    second, _sources, _notebooks = run_inventory(synthetic, captured)
    assert first == second and first['reportSha256'] == second['reportSha256']
    text = json.dumps(first, ensure_ascii=False)
    for marker in SENTINELS:
        assert marker not in text
    for forbidden in (str(tmp_path), str(synthetic.root), str(synthetic.device), '\\\\', 'Traceback', 'sqlite3.'):
        assert forbidden not in text
    assert len(text.encode('utf-8')) < 8 * 1024 * 1024


# self check and constraints ---------------------------------------------------------------------
def test_the_self_check_catches_a_dropped_classification(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    _report, sources, notebooks = run_inventory(synthetic, captured)
    build_report(sources, notebooks)           # sanity: the intact sources pass

    def broken(mutate):
        copy = deepcopy(sources)
        mutate(next(item for item in copy if item['kind'] == 'desktop-library'))
        with pytest.raises(ValueError, match='^inventory-self-check-failed$'):
            build_report(copy, notebooks)

    broken(lambda src: src['entries'].pop())
    broken(lambda src: src['containers'].pop())
    broken(lambda src: src['sqlite']['objects'].pop())
    broken(lambda src: next(item for item in src['sqlite']['objects'] if item['type'] == 'table' and item['columns'])['columns'].pop())


def test_the_self_check_catches_a_missing_or_surplus_notebook(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    report, sources, notebooks = run_inventory(synthetic, captured)
    assert len(notebooks) == 2 and report['selfCheck']['notebooks'] == [2, 2]
    for dropped in (notebooks[:1], notebooks[1:], []):
        with pytest.raises(ValueError, match='^inventory-self-check-failed$'):
            build_report(sources, dropped)
    # The same notebook twice does not stand in for the missing one, and a table of a notebook the Library does not hold is surplus.
    with pytest.raises(ValueError, match='^inventory-self-check-failed$'):
        build_report(sources, [notebooks[0], deepcopy(notebooks[0])])
    stranger = deepcopy(notebooks[0])
    stranger['sourceDocumentId'] = uuid.uuid4().hex
    with pytest.raises(ValueError, match='^inventory-self-check-failed$'):
        build_report(sources, [*notebooks, stranger])
    # Without a readable notebook table of the Library no notebook may be offered either.
    only_others = [source for source in sources if source['kind'] != 'desktop-library']
    with pytest.raises(ValueError, match='^inventory-self-check-failed$'):
        build_report(only_others, notebooks)
    assert build_report(only_others, [])['selfCheck']['notebooks'] == [0, 0]


def test_the_notebook_check_follows_the_library_not_the_caller(tmp_path):
    """A notebook row the caller did not build a table for is a missing table, not a silent skip."""
    synthetic = build_synthetic_library(tmp_path / 'library')
    synthetic.sql(("INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,kind)"
                   " VALUES(?,?,?,?,1,'not_translated','','notebook')", (uuid.uuid4().hex, 'x', 'late notebook', 'n.pdf')))
    captured = synthetic.capture()
    manifest = captured['desktop-library'].manifest
    sources = []
    with analysis(captured, 'desktop-library') as copy:
        sources.append(inventory_source('desktop-library', manifest, copy))
        listed = legacy_inventory.notebook_ids(copy)
        assert len(listed) == 3
        tables = [notebook_row_table(copy, manifest, identifier) for identifier in synthetic.ids.values() if identifier in listed]
    assert len(tables) == 2
    with pytest.raises(ValueError, match='^inventory-self-check-failed$'):
        build_report(sources, tables)


def test_inventory_never_writes_and_leaves_no_working_copy(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', canonical_pending=True, folder_sync_state=True)
    captured = synthetic.capture()
    before = tree_hashes(tmp_path)
    originals = synthetic.tree_hashes()
    run_inventory(synthetic, captured)
    run_inventory(synthetic, captured)
    assert tree_hashes(tmp_path) == before and synthetic.tree_hashes() == originals
    assert not [name for name in before if '.analysis-' in name]


def test_the_copy_must_equal_the_manifest(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    manifest = captured['desktop-library'].manifest
    with analysis(captured, 'desktop-library') as copy:
        (copy / 'extra.txt').write_text('x', 'utf-8')
        with pytest.raises(ValueError, match='^inventory-copy-mismatch$'):
            inventory_source('desktop-library', manifest, copy)
    with analysis(captured, 'desktop-library') as copy:
        (copy / 'library.sqlite3').write_bytes(b'')
        with pytest.raises(ValueError, match='^inventory-copy-mismatch$'):
            inventory_source('desktop-library', manifest, copy)
    with analysis(captured, 'desktop-library') as copy:
        (copy / 'papers' / synthetic.ids['A'] / 'original.pdf').unlink()
        with pytest.raises(ValueError, match='^inventory-copy-mismatch$'):
            inventory_source('desktop-library', manifest, copy)
    assert not list(captured['desktop-library'].backup.root.glob('.analysis-*'))


def test_arguments_are_validated(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    manifest = captured['device'].manifest
    with analysis(captured, 'device') as copy:
        with pytest.raises(ValueError, match='^inventory-kind-invalid$'):
            inventory_source('library', manifest, copy)
        with pytest.raises(ValueError, match='^inventory-library-key-required$'):
            inventory_source('device', manifest, copy)
        with pytest.raises(ValueError, match='^inventory-library-key-required$'):
            inventory_source('device', manifest, copy, library_key='not-a-key')
    with analysis(captured, 'desktop-library') as copy:
        with pytest.raises(ValueError, match='^inventory-notebook-id-invalid$'):
            notebook_row_table(copy, captured['desktop-library'].manifest, '../x')
        with pytest.raises(ValueError, match='^inventory-notebook-not-found$'):
            notebook_row_table(copy, captured['desktop-library'].manifest, synthetic.ids['P'])
    with pytest.raises(ValueError, match='^inventory-source-duplicate$'):
        _report, sources, notebooks = run_inventory(synthetic, captured)
        build_report([*sources, sources[0]], notebooks)


def test_a_whole_library_conversion_is_never_accepted(tmp_path):
    report = build_report([], [])
    assert legacy_inventory.whole_library_assessment(report) == {'status': 'refused', 'reasons': ['uncollected-source']}
    synthetic = build_synthetic_library(tmp_path / 'library')
    clean_report, _sources, _notebooks = run_inventory(synthetic, synthetic.capture())
    assert legacy_inventory.whole_library_assessment(clean_report)['status'] == 'refused'
    assert 'uncollected-source' in legacy_inventory.whole_library_assessment(clean_report)['reasons']


# ----- work B7-b: one SQLite-only working copy shared by the inventory, the row tables and the extractor ----------------
# The inventory of a source through its SQLite working copy (and verified object reads for the one other file it reads) must
# be exactly the inventory through the whole analysis copy; the tree check is the first use of the copy.
SHARED_VARIANTS = [
    {}, {'wal': True}, {'wal_closed': True}, {'canonical_pending': True, 'folder_sync_state': True},
    {'glossary_tables': True, 'optional_tables': ('global_glossary', 'collection_undo')}, {'notebook_journal': True},
    {'note_import': False}]


@pytest.mark.parametrize('options', SHARED_VARIANTS, ids=lambda options: '+'.join(sorted(options)) or 'main')
def test_the_shared_sqlite_copy_gives_the_inventory_of_the_whole_copy(tmp_path, options):
    synthetic = build_synthetic_library(tmp_path / 'library', **options)
    captured = synthetic.capture()
    whole = run_inventory(synthetic, captured)
    shared = run_inventory_shared(synthetic, captured)
    assert shared[0] == whole[0] and shared[1] == whole[1] and shared[2] == whole[2]
    assert not [path for path in tmp_path.rglob('.analysis-*')]


@pytest.mark.parametrize('content', [
    json.dumps({'path': 'x', 'pending': None}), json.dumps({'path': 'x', 'pending': {'source': 'a', 'destination': 'b'}}),
    'not json', '[1, 2]', ' ' * 70_000], ids=['plain', 'pending', 'garbage', 'not-an-object', 'oversize'])
def test_the_shared_copy_reads_the_storage_location_from_its_verified_object(tmp_path, content):
    synthetic = build_synthetic_library(tmp_path / 'library', folder_sync_state=True)
    (synthetic.device / 'storage-location.json').write_text(content, 'utf-8')
    captured = synthetic.capture()
    whole = run_inventory(synthetic, captured)[1][2]
    shared = run_inventory_shared(synthetic, captured)[1][2]
    assert shared['storageLocation'] == whole['storageLocation'] and shared == whole
    assert shared['storageLocation']['present'] is True


def test_the_shared_copy_needs_no_copy_for_a_source_without_a_database(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library')
    captured = synthetic.capture()
    for kind in ('canonical', 'device'):
        capture = captured[kind]
        assert not sqlite_names(kind, capture.manifest)
        shared = inventory_source(kind, capture.manifest, None, library_key=synthetic.library_key, copied=frozenset(),
                                  read_entry=lambda entry, max_bytes, _capture=capture: _capture.backup.read_object(_capture.manifest['id'], entry, max_bytes=max_bytes))
        with analysis(captured, kind) as copy:
            assert shared == inventory_source(kind, capture.manifest, copy, library_key=synthetic.library_key)


def test_the_partial_copy_must_equal_exactly_the_files_it_claims(tmp_path):
    synthetic = build_synthetic_library(tmp_path / 'library', wal=True)
    captured = synthetic.capture()
    capture = captured['desktop-library']
    manifest, backup = capture.manifest, capture.backup
    names = sqlite_names('desktop-library', manifest)
    assert names == ('library.sqlite3', 'library.sqlite3-wal', 'library.sqlite3-shm')
    copied = frozenset((name,) for name in names)

    def mismatch(copy, claimed=copied, **options):
        with pytest.raises(ValueError, match='^inventory-copy-mismatch$'):
            inventory_source('desktop-library', manifest, copy, copied=claimed, **options)

    with backup.sqlite_working_copy(manifest['id'], names) as copy:
        (copy / 'extra.txt').write_text('x', 'utf-8')                        # a file the claim does not name
        mismatch(copy)
    with backup.sqlite_working_copy(manifest['id'], names) as copy:
        (copy / 'papers').mkdir()                                            # a folder: a partial copy has none
        mismatch(copy)
    with backup.sqlite_working_copy(manifest['id'], names) as copy:
        (copy / 'library.sqlite3-wal').write_bytes(b'')                      # another size
        mismatch(copy)
    with backup.sqlite_working_copy(manifest['id'], names) as copy:
        (copy / 'library.sqlite3-shm').unlink()                              # a claimed file is missing
        mismatch(copy)
    with backup.sqlite_working_copy(manifest['id'], names) as copy:
        mismatch(copy, copied | {('not-in-the-manifest.sqlite3',)})          # a claim the manifest does not back
        mismatch(copy, frozenset({('papers',)}))                             # a name that is a folder of the manifest
        mismatch(copy, set(copied))                                          # a claim must be a frozenset
        mismatch(None)                                                       # claimed files but no copy
    with backup.sqlite_working_copy(manifest['id'], ('library.sqlite3-wal', 'library.sqlite3-shm')) as copy:
        mismatch(copy, frozenset({('library.sqlite3-wal',), ('library.sqlite3-shm',)}))     # the database is in the manifest but not in the copy
    with backup.sqlite_working_copy(manifest['id'], ()) as copy:
        mismatch(copy, frozenset())                                          # nothing claimed: there is no copy to hand over
    assert not list(backup.root.glob('.analysis-*'))


def test_an_opened_copy_no_longer_equals_the_manifest_so_the_tree_is_checked_first(tmp_path):
    """B7-a hand-off 1: opening a cleanly closed WAL database makes SQLite create -wal and -shm inside the copy, so the tree check
    runs (and passes) only on a fresh copy; the second look at the same copy would refuse. The shared flow therefore checks first."""
    synthetic = build_synthetic_library(tmp_path / 'library', wal_closed=True)
    captured = synthetic.capture()
    capture = captured['desktop-library']
    names = sqlite_names('desktop-library', capture.manifest)
    assert names == ('library.sqlite3',)
    copied = frozenset((name,) for name in names)
    with capture.backup.sqlite_working_copy(capture.manifest['id'], names) as copy:
        first = inventory_source('desktop-library', capture.manifest, copy, copied=copied)
        assert first['sqlite']['opened'] is True
        assert sorted(path.name for path in copy.iterdir()) != ['library.sqlite3'], 'SQLite wrote its companions into the copy'
        with pytest.raises(ValueError, match='^inventory-copy-mismatch$'):
            inventory_source('desktop-library', capture.manifest, copy, copied=copied)
        assert legacy_inventory.notebook_ids(copy)           # the row tables still read the opened copy (no tree check there)
    assert not list(capture.backup.root.glob('.analysis-*'))
