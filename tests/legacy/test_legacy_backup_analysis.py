from collections import namedtuple
from copy import deepcopy
import json
import hashlib
from pathlib import Path
import shutil
import sqlite3
import threading
import uuid

import pytest

from _synthetic_legacy_library import OPTIONAL_TABLE_SQL
from papeer.core import notebook
from papeer.core.migrations import legacy_backup
from papeer.core.migrations.legacy_backup import BackupReadLimits, NativeLegacyBackup, assert_free_space, sqlite_family
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_notebook_backup import (assert_notebook_settled, notebook_entries, notebook_projection_from_copy,
                                                          notebook_projection_input)
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from papeer.core.storage import Library


def identity(): return str(uuid.uuid4())


def source_bytes(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if path.is_file()}


def prepared(tmp_path: Path, mutation=None, *, wal=False, wal_closed=False, alter_plan=False, omit_shm=False, omit_wal=False):
    tmp_path.mkdir(parents=True, exist_ok=True)
    root = tmp_path / 'library'; lib = Library(root)
    note_id = notebook.create(lib, 'Synthetic notebook', {})
    notebook.change(lib, note_id, 1, 'append')
    doc = notebook.read(lib, note_id)
    db = sqlite3.connect(root / 'library.sqlite3')
    try:
        db.execute("INSERT INTO pdf_ink VALUES(?, 'original', 2, ?)", (note_id, json.dumps([{'id': 'stroke', 'color': '#000000', 'width': .01, 'points': [[.1, .2]]}])))
        db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects) VALUES(?,1,'original','synthetic','important','note',.2,.3,'note','','[]')", (note_id,))
        db.commit()
        if mutation: mutation(root, db, note_id)
        db.commit()
        if wal:
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.execute('PRAGMA wal_autocheckpoint=0')
            db.execute("UPDATE pages SET text='uncheckpointed synthetic WAL row' WHERE paper_id=? AND number=2", (note_id,))
            db.commit()
            assert (root / 'library.sqlite3-wal').stat().st_size > 0
            assert (root / 'library.sqlite3-shm').is_file()
        elif wal_closed:
            # What the product leaves after the app exits: journal mode WAL (Library sets it), the last connection closed, so
            # neither -wal nor -shm remains (the rows are already in the main file).
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.close()
            assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
            assert (root / 'library.sqlite3').read_bytes()[18:20] == b'\x02\x02'
        else:
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.execute('PRAGMA journal_mode=DELETE')
        backup = NativeLegacyBackup(root)
        backup_id, run_id, peer_id = identity(), identity(), identity()
        plan = backup.inventory(backup_id); manifest = backup.capture(plan)
    finally:
        db.close()
    if omit_shm or omit_wal:
        from copy import deepcopy
        from papeer.core.migrations.legacy_backup import inventory_hash
        reduced = deepcopy(plan); reduced['manifest']['id'] = identity()
        omitted = [['library.sqlite3-shm']] * omit_shm + [['library.sqlite3-wal']] * omit_wal
        reduced['manifest']['entries'] = [entry for entry in reduced['manifest']['entries'] if entry['key'] not in omitted]
        reduced['manifest']['inventorySha256'] = inventory_hash(reduced['manifest'])
        reduced['observationSha256'] = 'f' * 64
        backup.store.prepare(reduced); backup.store.publish(reduced['manifest'])
        plan, manifest, backup_id = reduced, reduced['manifest'], reduced['manifest']['id']
    registered_plan = json.loads(json.dumps(plan))
    if alter_plan: registered_plan['observationSha256'] = '0' * 64
    NativeLegacyStartup(root).hold({'version': 1, 'runId': run_id})
    value = {'catalog': {'version': 1, 'runId': run_id, 'identity': {'accountId': 'synthetic-account', 'libraryId': identity()},
                         'peers': [{'id': peer_id, 'sources': [manifest['source']]}]},
             'inputs': [{'peerId': peer_id, 'plan': registered_plan}]}
    NativeLegacyInputs(root).prepare(value)
    return root, backup, backup_id, run_id, peer_id, note_id, doc, plan


def test_verified_backup_notebook_maps_every_page_and_real_rows_without_source_mutation(tmp_path):
    root, backup, backup_id, run_id, peer_id, note_id, doc, plan = prepared(tmp_path)
    before = {tuple(e['key']): backup.object(backup_id, e) for e in plan['manifest']['entries']}
    source_before = source_bytes(root)
    result = notebook_projection_input(backup, run_id, peer_id, note_id)
    assert result['sourceDocumentId'] == note_id
    assert result['bytes'] == (root / 'papers' / note_id / 'notebook.json').read_bytes()
    assert [value['pageId'] for value in result['annotations']] == [page['id'] for page in doc['pages']]
    assert result['annotations'][0]['ink'] == [] and len(result['annotations'][0]['bookmarks']) == 1
    assert result['annotations'][1]['bookmarks'] == [] and result['annotations'][1]['ink'][0]['id'] == 'stroke'
    assert result['coverage']['pageRows'] == 2 and result['coverage']['inkRows'] == 1 and result['coverage']['bookmarkRows'] == 1
    assert len(result['coverage']['bookmarkIds']) == 1 and result['coverage']['inkPages'] == [2]
    assert 'external-writer-quiescence' in result['incomplete']
    assert before == {tuple(e['key']): backup.object(backup_id, e) for e in plan['manifest']['entries']}
    assert source_before == source_bytes(root)
    assert backup.load(backup_id) == plan['manifest']


def test_notebook_analysis_can_bound_backup_and_notebook_bytes(tmp_path, monkeypatch):
    from papeer.core.migrations.legacy_backup import BackupReadLimits, FileLegacyBackupStore
    root, backup, _backup_id, run_id, peer_id, note_id, doc, _plan = prepared(tmp_path)
    original = source_bytes(root)
    limits = BackupReadLimits(metadata_bytes=1024 * 1024, entries=1000, total_bytes=64 * 1024 * 1024)
    def refuse_object(*_args):
        raise AssertionError('the notebook limit must be checked before reading backup bodies')
    with monkeypatch.context() as patches:
        patches.setattr(FileLegacyBackupStore, 'object_path', refuse_object)
        with pytest.raises(ValueError, match='legacy-notebook-read-limit'):
            notebook_projection_input(backup, run_id, peer_id, note_id, limits=limits, max_notebook_bytes=1)
    assert not list(backup.root.glob('.analysis-*'))
    result = notebook_projection_input(backup, run_id, peer_id, note_id, limits=limits, max_notebook_bytes=1024 * 1024,
                                       max_pages=2, max_annotation_rows=2, max_projection_bytes=1024 * 1024)
    assert [row['pageId'] for row in result['annotations']] == [page['id'] for page in doc['pages']]
    assert original == source_bytes(root) and not list(backup.root.glob('.analysis-*'))


@pytest.mark.parametrize('limit', [
    {'max_pages': 1}, {'max_annotation_rows': 1}, {'max_projection_bytes': 1},
])
def test_notebook_analysis_refuses_page_annotation_and_result_limits(tmp_path, limit):
    from papeer.core.migrations.legacy_backup import BackupReadLimits
    root, backup, _backup_id, run_id, peer_id, note_id, _doc, _plan = prepared(tmp_path)
    before = source_bytes(root)
    limits = BackupReadLimits(metadata_bytes=1024 * 1024, entries=1000, total_bytes=64 * 1024 * 1024)
    with pytest.raises(ValueError, match='legacy-notebook-read-limit'):
        notebook_projection_input(backup, run_id, peer_id, note_id, limits=limits,
                                  max_notebook_bytes=1024 * 1024, **limit)
    assert before == source_bytes(root) and not list(backup.root.glob('.analysis-*'))


def test_notebook_analysis_refuses_one_oversized_annotation_row(tmp_path):
    from papeer.core.migrations.legacy_backup import BackupReadLimits
    def enlarge(_root, db, note):
        db.execute("UPDATE pdf_ink SET strokes=? WHERE paper_id=?", (json.dumps(['x' * 100_000]), note))
    root, backup, _backup_id, run_id, peer_id, note_id, _doc, _plan = prepared(tmp_path, enlarge)
    before = source_bytes(root)
    limits = BackupReadLimits(metadata_bytes=1024 * 1024, entries=1000, total_bytes=64 * 1024 * 1024)
    with pytest.raises(ValueError, match='legacy-notebook-read-limit'):
        notebook_projection_input(backup, run_id, peer_id, note_id, limits=limits,
                                  max_notebook_bytes=8192, max_pages=10, max_annotation_rows=10,
                                  max_projection_bytes=8192)
    assert before == source_bytes(root) and not list(backup.root.glob('.analysis-*'))


@pytest.mark.parametrize('mutation,expected', [
    (lambda root, db, note: db.execute('CREATE TABLE future_unclassified(value TEXT)'), 'schema-unsupported'),
    (lambda root, db, note: db.execute('CREATE TABLE sqliteXfuture(value TEXT)'), 'schema-unsupported'),
    (lambda root, db, note: db.execute('ALTER TABLE bookmarks ADD COLUMN future_field TEXT'), 'schema-unsupported'),
    (lambda root, db, note: db.execute('ALTER TABLE pages ADD COLUMN future_generated TEXT GENERATED ALWAYS AS (text) VIRTUAL'), 'schema-unsupported'),
    (lambda root, db, note: db.execute('DELETE FROM pages WHERE paper_id=? AND number=2', (note,)), 'page-row-coverage'),
    (lambda root, db, note: db.execute("INSERT INTO pdf_ink VALUES(?,'translated',1,'[]')", (note,)), 'annotation-row-unmapped'),
    (lambda root, db, note: db.execute("INSERT INTO pdf_ink VALUES(?,'original',99,'[]')", (note,)), 'annotation-row-unmapped'),
    (lambda root, db, note: (root/'papers'/note/'.notebook-change.json').write_text('{}', encoding='utf8'), 'recovery-pending'),
    (lambda root, db, note: (root/'papers'/note/'original.pdf').unlink(), 'required-entry-missing'),
])
def test_unsupported_or_incomplete_source_fails_closed(tmp_path, mutation, expected):
    _, backup, _, run_id, peer_id, note_id, _, _ = prepared(tmp_path, mutation)
    with pytest.raises(ValueError, match=expected): notebook_projection_input(backup, run_id, peer_id, note_id)


def test_registered_plan_mismatch_and_selected_backup_are_refused(tmp_path):
    root, backup, _, run_id, peer_id, note_id, _, _ = prepared(tmp_path, alter_plan=True)
    with pytest.raises(ValueError, match='plan-or-manifest-mismatch'): notebook_projection_input(backup, run_id, peer_id, note_id)
    selected = NativeLegacyBackup(root, select=lambda _: True, selection_id='synthetic-selection')
    with pytest.raises(ValueError, match='full-native-backup-required'): notebook_projection_input(selected, run_id, peer_id, note_id)


def test_corrupted_object_fails_before_returning_a_projection(tmp_path):
    _, backup, _, run_id, peer_id, note_id, _, plan = prepared(tmp_path)
    entry = next(item for item in plan['manifest']['entries'] if item['key'][-1] == 'notebook.json')
    (backup.root / 'objects' / entry['sha256']).write_bytes(b'corrupt synthetic object')
    with pytest.raises(ValueError, match='backup-object-hash'): notebook_projection_input(backup, run_id, peer_id, note_id)


def test_wal_only_row_is_read_from_verified_disposable_copy(tmp_path):
    root, backup, _, run_id, peer_id, note_id, _, _ = prepared(tmp_path, wal=True)
    before = source_bytes(root)
    result = notebook_projection_input(backup, run_id, peer_id, note_id)
    assert before == source_bytes(root)
    assert result['coverage']['sqliteWalEntries'] == ['library.sqlite3-shm', 'library.sqlite3-wal']
    assert result['coverage']['pageText'][1] == 'uncheckpointed synthetic WAL row'


# W-1 (B7-a, decision J5): the extractor reads a WAL database that was closed normally (header 2, no -wal, no -shm).
def test_a_cleanly_closed_wal_database_is_read_like_a_rollback_one(tmp_path):
    reference = notebook_projection_input(*_arguments(prepared(tmp_path / 'delete-mode')))
    root, backup, _backup_id, run_id, peer_id, note_id, doc, _plan = prepared(tmp_path / 'closed', wal_closed=True)
    before = source_bytes(root)
    result = notebook_projection_input(backup, run_id, peer_id, note_id)
    assert before == source_bytes(root) and not list(backup.root.glob('.analysis-*'))
    assert result['coverage']['sqliteWalEntries'] == []
    assert [value['pageId'] for value in result['annotations']] == [page['id'] for page in doc['pages']]
    assert result['annotations'][1]['ink'][0]['id'] == 'stroke' and len(result['annotations'][0]['bookmarks']) == 1
    for key in ('pageRows', 'inkRows', 'bookmarkRows', 'inkPages'):
        assert result['coverage'][key] == reference['coverage'][key], key


def _arguments(prepared_value):
    _root, backup, _backup_id, run_id, peer_id, note_id, _doc, _plan = prepared_value
    return backup, run_id, peer_id, note_id


@pytest.mark.parametrize('flag', ['omit_shm', 'omit_wal'])
def test_a_wal_database_with_exactly_one_registered_companion_is_refused(tmp_path, flag):
    """W-2: `closed` is both companions absent. One of them alone, beside a header 2 database, is still incomplete."""
    _, backup, _, run_id, peer_id, note_id, _, _ = prepared(tmp_path, wal=True, **{flag: True})
    with pytest.raises(ValueError, match='sqlite-wal-incomplete'): notebook_projection_input(backup, run_id, peer_id, note_id)
    assert not list(backup.root.glob('.analysis-*'))


# W-6 (B7-a): classified optional tables are tolerated, with exactly their columns; any other table is still refused -----
OPTIONAL = ('global_glossary', 'collection_undo', 'paper_glossary', 'paper_glossary_domains', 'web_annotation_ops')


def with_tables(*statements):
    def mutation(_root, db, _note_id):
        for statement in statements:
            db.execute(statement)
    return mutation


def test_every_classified_optional_table_may_exist_beside_the_notebook_tables(tmp_path):
    root, backup, _, run_id, peer_id, note_id, doc, _ = prepared(tmp_path, with_tables(*(OPTIONAL_TABLE_SQL[name] for name in OPTIONAL)))
    result = notebook_projection_input(backup, run_id, peer_id, note_id)
    assert [value['pageId'] for value in result['annotations']] == [page['id'] for page in doc['pages']]
    assert result['coverage']['pageRows'] == 2 and result['coverage']['inkRows'] == 1


@pytest.mark.parametrize('statement', [
    'CREATE TABLE surprise_table (id TEXT)',                                       # an unclassified table
    'CREATE TABLE paper_glossary_extra (paper_id TEXT)',                           # a look-alike name
    'CREATE TABLE web_annotation_ops (id TEXT, operation TEXT, extra TEXT)',       # a classified name with another column set
    'CREATE TABLE paper_glossary (paper_id TEXT, terms TEXT)',                     # a classified name with fewer columns
    'CREATE TABLE global_glossary (terms TEXT, id INTEGER)',                       # a classified name with the columns reordered
])
def test_an_unclassified_table_or_an_optional_table_with_other_columns_is_still_refused(tmp_path, statement):
    _, backup, _, run_id, peer_id, note_id, _, _ = prepared(tmp_path, with_tables(statement))
    with pytest.raises(ValueError, match='legacy-notebook-schema-unsupported'): notebook_projection_input(backup, run_id, peer_id, note_id)
    assert not list(backup.root.glob('.analysis-*'))


def test_a_missing_required_table_is_still_refused_even_with_optional_tables_present(tmp_path):
    _, backup, _, run_id, peer_id, note_id, _, _ = prepared(
        tmp_path, with_tables('DROP TABLE tag_choices', *(OPTIONAL_TABLE_SQL[name] for name in OPTIONAL)))
    with pytest.raises(ValueError, match='legacy-notebook-schema-unsupported'): notebook_projection_input(backup, run_id, peer_id, note_id)


def test_wal_without_registered_shm_is_refused(tmp_path):
    # A genuinely selective backup would have a different source identity and
    # is rejected even earlier; this creates a valid synthetic stored manifest
    # whose registered input omits SHM to test the archive-coverage boundary.
    _, backup, _, run_id, peer_id, note_id, _, _ = prepared(tmp_path, wal=True, omit_shm=True)
    with pytest.raises(ValueError, match='sqlite-wal-incomplete'): notebook_projection_input(backup, run_id, peer_id, note_id)


# ----- work B7-b: the SQLite working copy, read_object, free space, the extraction body on a shared copy -----------------
# DESIGN-r161-b7-staging.md 7.2 and tests K-2 (only SQLite files are copied), K-3 (read_object), K-5 (free space), and the
# extractor split of decision J4 (the preview's whole-copy function and the shared-copy function give the same result).
MIB = 1024 * 1024
LIBRARY_FILES = ['library.sqlite3', 'library.sqlite3-shm', 'library.sqlite3-wal']


class CancelAfter:
    """An Event-like cancel token that reports set from its n-th poll on."""
    def __init__(self, polls): self.polls, self.count = polls, 0

    def is_set(self):
        self.count += 1
        return self.count >= self.polls


def leftovers(backup):
    return sorted(path.name for path in backup.root.glob('.analysis-*'))


def entry_of(manifest, *key):
    return next(item for item in manifest['entries'] if item['key'] == list(key))


def test_a_sqlite_working_copy_holds_only_the_named_database_files(tmp_path):
    """K-2: the database and its companions are copied (verified), nothing else, in one `.analysis-*` folder that goes away."""
    root, backup, backup_id, _run, _peer, note_id, _doc, plan = prepared(tmp_path, wal=True)
    manifest = backup.load(backup_id)
    assert len(manifest['entries']) > 3 and any(len(item['key']) == 3 for item in manifest['entries'])      # more than the SQLite family exists
    before = source_bytes(root)
    with backup.sqlite_working_copy(backup_id, sqlite_family('library.sqlite3')) as copy:
        assert copy.parent == backup.root and copy.name.startswith('.analysis-') and leftovers(backup) == [copy.name]
        assert sorted(path.relative_to(copy).as_posix() for path in copy.rglob('*')) == LIBRARY_FILES
        for name in LIBRARY_FILES:
            entry = entry_of(manifest, name)
            assert hashlib.sha256((copy / name).read_bytes()).hexdigest() == entry['sha256']
    assert leftovers(backup) == [] and source_bytes(root) == before and backup.load(backup_id) == manifest


def test_names_the_manifest_does_not_hold_are_skipped_and_a_plain_database_has_no_companions(tmp_path):
    _root, backup, backup_id, *_ = prepared(tmp_path)           # DELETE-mode database: no -wal, no -shm
    with backup.sqlite_working_copy(backup_id, sqlite_family('library.sqlite3') + ('content.sqlite3',)) as copy:
        assert sorted(path.name for path in copy.iterdir()) == ['library.sqlite3']
    with backup.sqlite_working_copy(backup_id, ()) as copy:
        assert list(copy.iterdir()) == []
    assert leftovers(backup) == []


@pytest.mark.parametrize('name', ['notebook.json', 'original.pdf', 'papers', 'library.sqlite3-journal', '../library.sqlite3',
                                  'a/b.sqlite3', 'a\\b.sqlite3', 'C:library.sqlite3', '', 'library.sqlite3\0', 'x.sqlite3-wal-shm'])
def test_only_database_file_names_can_be_named(tmp_path, name):
    _root, backup, backup_id, *_ = prepared(tmp_path)
    with pytest.raises(ValueError, match='^backup-working-copy-name$'):
        with backup.sqlite_working_copy(backup_id, ('library.sqlite3', name)):
            raise AssertionError('no copy may be made for a bad name')
    with pytest.raises(ValueError, match='^backup-working-copy-name$'):
        with backup.sqlite_working_copy(backup_id, (None,)):
            raise AssertionError('no copy may be made for a bad name')
    assert leftovers(backup) == []


def test_the_working_copy_is_removed_when_the_block_fails_and_when_it_is_cancelled(tmp_path, monkeypatch):
    _root, backup, backup_id, *_ = prepared(tmp_path)
    with pytest.raises(RuntimeError, match='^analysis failed$'):
        with backup.sqlite_working_copy(backup_id, ('library.sqlite3',)):
            raise RuntimeError('analysis failed')
    assert leftovers(backup) == []
    with pytest.raises(ValueError, match='^backup-read-cancelled$'):
        with backup.sqlite_working_copy(backup_id, ('library.sqlite3',), cancel=CancelAfter(1)):
            raise AssertionError('a cancelled copy must not be handed out')
    assert leftovers(backup) == []
    token, real = threading.Event(), NativeLegacyBackup._object

    def cancelling(self, entry, **kwargs):
        token.set()                                   # the first object of the copy: the verification pass (`load`) is over
        return real(self, entry, **kwargs)

    monkeypatch.setattr(NativeLegacyBackup, '_object', cancelling)
    with pytest.raises(ValueError, match='^backup-read-cancelled$'):
        with backup.sqlite_working_copy(backup_id, ('library.sqlite3',), cancel=token):
            raise AssertionError('a cancelled copy must not be handed out')
    assert leftovers(backup) == []


def test_the_whole_backup_is_verified_once_before_the_working_copy_is_made(tmp_path):
    """The files that are not copied stay in the backup, so the copy call itself must verify every object (design 7.2)."""
    _root, backup, backup_id, _run, _peer, _note, _doc, plan = prepared(tmp_path)
    other = next(item for item in plan['manifest']['entries'] if item['key'][-1] == 'original.pdf')
    (backup.root / 'objects' / other['sha256']).write_bytes(b'x' * other['byteLength'])      # same size, other bytes
    with pytest.raises(ValueError, match='^backup-object-hash$'):
        with backup.sqlite_working_copy(backup_id, ('library.sqlite3',)):
            raise AssertionError('a damaged backup must not be copied')
    assert leftovers(backup) == []


def test_the_working_copy_honours_the_read_limits(tmp_path):
    _root, backup, backup_id, *_ = prepared(tmp_path)
    for limits in (BackupReadLimits(8 * MIB, 1, 4096 * MIB), BackupReadLimits(8 * MIB, 100_000, 1), BackupReadLimits(1, 100_000, 4096 * MIB)):
        with pytest.raises(ValueError, match='^backup-read-limit$'):
            with backup.sqlite_working_copy(backup_id, ('library.sqlite3',), limits=limits):
                raise AssertionError('over the limits')
    assert leftovers(backup) == []


def test_free_space_is_checked_before_anything_is_created(tmp_path, monkeypatch):
    """K-5 (the backup level): free < the files to copy + the margin refuses with no `.analysis-*`; exactly enough passes.

    Only the database files count (the PDF and the other objects are not copied)."""
    _root, backup, backup_id, _run, _peer, _note, _doc, plan = prepared(tmp_path, wal=True)
    needed = sum(entry_of(plan['manifest'], name)['byteLength'] for name in LIBRARY_FILES)
    assert needed < sum(item['byteLength'] for item in plan['manifest']['entries'])
    usage = namedtuple('usage', 'total used free')
    free = {'bytes': 0}
    real = shutil.disk_usage
    monkeypatch.setattr(shutil, 'disk_usage', lambda path: usage(10 ** 12, 0, free['bytes']) if Path(path) == backup.root else real(path))
    margin = 5 * MIB
    free['bytes'] = needed + margin - 1
    with pytest.raises(ValueError, match='^backup-disk-insufficient$'):
        with backup.sqlite_working_copy(backup_id, sqlite_family('library.sqlite3'), free_margin=margin):
            raise AssertionError('refused before anything is copied')
    assert leftovers(backup) == []
    free['bytes'] = needed + margin
    with backup.sqlite_working_copy(backup_id, sqlite_family('library.sqlite3'), free_margin=margin) as copy:
        assert sorted(path.name for path in copy.iterdir()) == LIBRARY_FILES
    free['bytes'] = 0
    with backup.sqlite_working_copy(backup_id, sqlite_family('library.sqlite3')) as copy:       # no margin given: no check
        assert (copy / 'library.sqlite3').is_file()
    assert leftovers(backup) == []


def test_assert_free_space_unit(tmp_path):
    assert_free_space(tmp_path, 0, 0)
    for bad in ((-1, 0), (0, -1), (1.5, 0), ('1', 0), (None, 0), (True, 0), (0, False)):
        with pytest.raises(ValueError, match='^backup-disk-limit-invalid$'):
            assert_free_space(tmp_path, *bad)
    with pytest.raises(ValueError, match='^backup-disk-insufficient$'):
        assert_free_space(tmp_path, shutil.disk_usage(tmp_path).free + 1, 0)


# K-3: read_object -----------------------------------------------------------------------------------------------------
def big_file(root, note_id):
    (root / 'papers' / note_id / 'media').mkdir()
    (root / 'papers' / note_id / 'media' / 'big.bin').write_bytes(bytes(range(256)) * (10 * 1024))          # 2.5 MiB


def with_big_file(root, _db, note_id):
    big_file(root, note_id)


def test_read_object_returns_the_verified_bytes_of_a_manifest_entry(tmp_path):
    root, backup, backup_id, _run, _peer, note_id, _doc, plan = prepared(tmp_path, with_big_file)
    before = tree_of(backup.root)
    manifest = backup.load(backup_id)
    for key in (('papers', note_id, 'notebook.json'), ('papers', note_id, 'original.pdf'), ('papers', note_id, 'media', 'big.bin'), ('library.sqlite3',)):
        entry = entry_of(manifest, *key)
        assert backup.read_object(backup_id, entry) == (root.joinpath(*key)).read_bytes() and isinstance(backup.read_object(backup_id, entry), bytes)
    assert len(entry_of(manifest, 'papers', note_id, 'media', 'big.bin')['sha256']) == 64
    assert tree_of(backup.root) == before and leftovers(backup) == []           # nothing is written


def tree_of(base):
    return {path.relative_to(base).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(base.rglob('*')) if path.is_file()}


def test_read_object_refuses_changed_bytes_a_wrong_size_and_an_entry_the_manifest_lacks(tmp_path):
    _root, backup, backup_id, _run, _peer, note_id, _doc, plan = prepared(tmp_path)
    manifest = backup.load(backup_id)
    entry = entry_of(manifest, 'papers', note_id, 'notebook.json')
    path = backup.root / 'objects' / entry['sha256']
    good = path.read_bytes()
    path.write_bytes(bytes(reversed(good)))                                                  # same size, other bytes
    with pytest.raises(ValueError, match='^backup-object-hash$'): backup.read_object(backup_id, entry)
    path.write_bytes(good + b'x')                                                            # longer
    with pytest.raises(ValueError, match='^backup-object-hash$'): backup.read_object(backup_id, entry)
    path.write_bytes(good[:-1])                                                              # shorter
    with pytest.raises(ValueError, match='^backup-object-hash$'): backup.read_object(backup_id, entry)
    path.write_bytes(good)
    assert backup.read_object(backup_id, entry) == good
    for forged in ({**entry, 'sha256': '0' * 64}, {**entry, 'byteLength': entry['byteLength'] + 1}, {**entry, 'key': ['papers', note_id, 'other.json']}):
        with pytest.raises(ValueError, match='^backup-entry-missing$'): backup.read_object(backup_id, forged)
    with pytest.raises(ValueError, match='^backup-entry-missing$'): backup.read_object(identity(), entry)


def test_read_object_enforces_its_size_limits_before_reading(tmp_path, monkeypatch):
    _root, backup, backup_id, _run, _peer, note_id, _doc, _plan = prepared(tmp_path, with_big_file)
    entry = entry_of(backup.load(backup_id), 'papers', note_id, 'media', 'big.bin')
    opened = []
    real = Path.open
    monkeypatch.setattr(Path, 'open', lambda self, *args, **kwargs: (opened.append(self), real(self, *args, **kwargs))[1])
    with pytest.raises(ValueError, match='^backup-read-limit$'): backup.read_object(backup_id, entry, max_bytes=entry['byteLength'] - 1)
    with pytest.raises(ValueError, match='^backup-read-limit$'): backup.read_object(backup_id, entry, limits=BackupReadLimits(8 * MIB, 100_000, 1 * MIB))   # (the manifest itself is over it)
    assert not [path for path in opened if path.parent == backup.root / 'objects'], 'an over-limit object must not be opened'
    assert len(backup.read_object(backup_id, entry, max_bytes=entry['byteLength'])) == entry['byteLength']
    assert len(backup.read_object(backup_id, entry, limits=BackupReadLimits(8 * MIB, 100_000, 4096 * MIB))) == entry['byteLength']
    for bad in (-1, 1.5, '1'):
        with pytest.raises(ValueError, match='^backup-read-limit-invalid$'): backup.read_object(backup_id, entry, max_bytes=bad)


def test_read_object_is_cancellable_every_mebibyte(tmp_path):
    _root, backup, backup_id, _run, _peer, note_id, _doc, _plan = prepared(tmp_path, with_big_file)
    entry = entry_of(backup.load(backup_id), 'papers', note_id, 'media', 'big.bin')           # 2.5 MiB: three blocks
    polls = CancelAfter(10 ** 9)
    assert backup.read_object(backup_id, entry, cancel=polls)
    assert polls.count >= 4, 'one poll before the read and one per mebibyte block'
    for stop in (1, 2, 3):
        with pytest.raises(ValueError, match='^backup-read-cancelled$'): backup.read_object(backup_id, entry, cancel=CancelAfter(stop))


# the extraction body: the preview's whole-copy function and the shared-copy function give the same projection ---------------
def shared_projection(prepared_value, **options):
    root, backup, backup_id, run_id, peer_id, note_id, _doc, _plan = prepared_value
    manifest = backup.load(backup_id)
    registered = NativeLegacyInputs(root).read(run_id)
    names = [name for name in sqlite_family('library.sqlite3') if [name] in [item['key'] for item in manifest['entries']]]
    note = entry_of(manifest, 'papers', note_id, 'notebook.json')
    entries = notebook_entries(manifest, note_id)
    assert_notebook_settled(entries, note_id)
    with backup.sqlite_working_copy(backup_id, names) as copy:
        results = [notebook_projection_from_copy(
            copy / 'library.sqlite3', manifest, note_id, lambda max_bytes: backup.read_object(backup_id, note, max_bytes=max_bytes),
            library_id=registered['catalog']['identity']['libraryId'], run_id=run_id, peer_id=peer_id, **options) for _ in range(2)]
    assert results[0] == results[1], 'one verified copy can be used again (it is opened read only)'
    assert leftovers(backup) == []
    return results[0]


@pytest.mark.parametrize('variant', [{}, {'wal': True}, {'wal_closed': True}], ids=['rollback', 'wal-open', 'wal-closed'])
def test_the_shared_copy_extraction_equals_the_preview_extraction(tmp_path, variant):
    value = prepared(tmp_path, **variant)
    options = dict(max_notebook_bytes=2 * MIB, max_pages=256, max_annotation_rows=20_000, max_projection_bytes=6 * MIB)
    _root, backup, _backup_id, run_id, peer_id, note_id, _doc, _plan = value
    reference = notebook_projection_input(backup, run_id, peer_id, note_id, **options)
    assert shared_projection(value, **options) == reference
    assert shared_projection(value) == notebook_projection_input(backup, run_id, peer_id, note_id)


@pytest.mark.parametrize('flag', ['omit_shm', 'omit_wal'])
def test_the_shared_copy_extraction_refuses_one_companion_like_the_preview(tmp_path, flag):
    value = prepared(tmp_path, wal=True, **{flag: True})
    with pytest.raises(ValueError, match='^legacy-notebook-sqlite-wal-incomplete$'): shared_projection(value)


def test_the_extraction_body_refuses_a_companion_beside_a_rollback_database(tmp_path):
    """B7-a review low 1: the `unexpected` branch (a rollback-journal database with a -wal in the manifest) had no direct test."""
    root, backup, backup_id, run_id, peer_id, note_id, _doc, _plan = prepared(tmp_path)
    manifest = deepcopy(backup.load(backup_id))
    manifest['entries'].append({'key': ['library.sqlite3-wal'], 'sha256': '0' * 64, 'byteLength': 1})
    note = entry_of(manifest, 'papers', note_id, 'notebook.json')
    with backup.sqlite_working_copy(backup_id, ('library.sqlite3',)) as copy:
        with pytest.raises(ValueError, match='^legacy-notebook-sqlite-wal-incomplete$'):
            notebook_projection_from_copy(copy / 'library.sqlite3', manifest, note_id, lambda _max: backup.read_object(backup_id, note),
                                          library_id=identity(), run_id=run_id, peer_id=peer_id)


def test_the_entry_checks_of_the_extraction_need_only_the_manifest(tmp_path):
    root, backup, backup_id, _run, _peer, note_id, _doc, _plan = prepared(tmp_path)
    manifest = deepcopy(backup.load(backup_id))
    entries = notebook_entries(manifest, note_id)
    assert set(entries) == {tuple(item['key']) for item in manifest['entries']}
    with pytest.raises(ValueError, match='^legacy-notebook-required-entry-missing$'): notebook_entries(manifest, 'f' * 32)
    note = entry_of(manifest, 'papers', note_id, 'notebook.json')
    with pytest.raises(ValueError, match='^legacy-notebook-read-limit$'): notebook_entries(manifest, note_id, max_notebook_bytes=note['byteLength'] - 1)
    with pytest.raises(ValueError, match='^legacy-notebook-read-limit$'): notebook_entries(manifest, note_id, max_projection_bytes=note['byteLength'] - 1)
    assert notebook_entries(manifest, note_id, max_notebook_bytes=note['byteLength'], max_projection_bytes=note['byteLength'])
    assert_notebook_settled(entries, note_id)
    for name in ('.notebook-change.json', '.notebook-before.pdf', '.notebook-after.pdf'):
        pending = {**entries, ('papers', note_id, name): {'key': ['papers', note_id, name]}}
        with pytest.raises(ValueError, match='^legacy-notebook-recovery-pending$'): assert_notebook_settled(pending, note_id)
    with pytest.raises(ValueError, match='^legacy-notebook-sqlite-journal-unsupported$'):
        assert_notebook_settled({**entries, ('library.sqlite3-journal',): {'key': ['library.sqlite3-journal']}}, note_id)
    assert legacy_backup.sqlite_family('a.sqlite3') == ('a.sqlite3', 'a.sqlite3-wal', 'a.sqlite3-shm')
