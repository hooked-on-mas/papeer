"""Work B6-c: the read-only conversion input on the Native preparation run (synthetic, isolated data only).

The sidecar joins the pure inventory (B6-b) to the registered run: it reads the three backups through their
analysis copies, counts each Notebook's rows independently of the extractor, runs the existing extractor and
requires the two to agree. A whole-Library conversion is always refused (the reasons are B7's work list).
Another process holding writer rights is refused with real child processes holding real OS locks. Nothing
here touches a real profile: conftest isolates the folders and every child asserts them first.
"""
from collections import namedtuple
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from unittest.mock import patch
from uuid import uuid4

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
import pytest

from _synthetic_legacy_library import SENTINELS, build_synthetic_library, settle
from test_native_maintenance_entry import AUTH, PREFIX, runtime, start  # noqa: F401 - existing controlled-copy fixture
from test_native_notebook_preview import assert_blocked, assert_leases_held, hold_directly, post, to_cold
from papeer.core import paths
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_storage import edit_storage_root
from papeer.core.instance import instance_key
from papeer.core.migrations import legacy_inventory
from papeer.core.migrations import legacy_backup
from papeer.core.migrations.legacy_backup import BackupReadLimits, NativeLegacyBackup
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_notebook_backup import notebook_projection_input
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from sidecar.app import app
from sidecar.lifecycle import instance
from sidecar.migrations import census, conversion_input, notebook_preview, preparation, preview_gate
from sidecar.routes import system

S, R, U = 'supported', 'retained-blocking', 'unknown'
MAIN_REASONS = sorted([
    'derived-file-retained', 'device-local-undecided', 'folder-not-converted', 'item-link-not-converted',
    'library-metadata-not-converted', 'markdown-not-converted', 'messages-not-converted', 'note-import-pending',
    'page-text-not-converted', 'pdf-annotation-not-converted', 'pdf-document-not-converted', 'summary-not-converted',
    'translation-not-converted', 'uncollected-source'])
WAIT = 600     # a build waits this long in tests: memory-starved runs are slow, never a reason to cancel


@pytest.fixture(autouse=True)
def fresh_gate(monkeypatch):
    gate = preview_gate.PreviewGate()
    monkeypatch.setattr(preview_gate, 'gate', gate)
    yield gate
    assert gate.wait_idle(10), 'a conversion-input worker thread outlived its test'


def capture_live(client):
    """Start the preparation and wait for its capture; a failure shows the recorded reason code.

    The product refuses a source whose stamps moved between its scans (`backup-source-changed`). The recording here
    was added to find out what moves: every stamp the scans take is kept, and a failed capture reports the paths seen
    with more than one stamp (names only, no contents). The cause (REVIEW-r161-b6c.md aspect 6): a folder that NTFS
    has not cached reports st_size 0 from the by-name stat and 4096 once it has been listed, with the same
    mtime/ctime; it happens whenever such a folder is scanned, not only when memory is short. Fixed in B6-f: a
    folder's stamp no longer contains st_size (DESIGN-r161-b6f-stamp.md), so a failure reported here is now a real
    change of the tree; the recording stays only as a diagnostic.
    """
    seen = {}
    real_stat, real_hash = legacy_backup._safe_stat, legacy_backup._hash_file

    def stat_spy(path, directory=False):
        value = real_stat(path, directory=directory)
        seen.setdefault(str(path), set()).add(tuple(legacy_backup._stamp(value)))
        return value

    def hash_spy(path, *args, **kwargs):
        result = real_hash(path, *args, **kwargs)
        seen.setdefault(str(path), set()).add(tuple(result[2]))
        return result

    with patch.object(legacy_backup, '_safe_stat', stat_spy), patch.object(legacy_backup, '_hash_file', hash_spy):
        run_id = start(client)['runId']
        state = preparation._current.wait(WAIT)
    if state['state'] != 'captured':
        unstable = {path: sorted(stamps) for path, stamps in seen.items() if len(stamps) > 1}
        pytest.fail('capture did not complete: ' + json.dumps({'state': state, 'unstable': unstable}, default=str, sort_keys=True))
    preparation._current._thread.join(10)
    return run_id


def build(run_id, **options):
    return conversion_input.build(run_id, timeout=WAIT, **options)


def refused(run_id, reason, **options):
    with pytest.raises(ValueError) as error:
        build(run_id, **options)
    assert error.value.args == (reason,), error.value.args
    assert error.value.__cause__ is None and error.value.__suppress_context__
    return error.value


def backup_base(root):
    return root.with_name('.' + root.name + '-shared-app-backups')


def hashed(base, *, skip_locks=False):
    result = {}
    if not base.exists():
        return result
    for path in sorted(base.rglob('*')):
        key = path.relative_to(base).as_posix()
        if path.is_dir():
            result[key] = None
        elif skip_locks and path.name.endswith('.lock'):
            result[key] = path.stat().st_size          # an OS-locked file is not read
        else:
            result[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def snapshot(root, device):
    """Every byte of the Library, canonical store, device footprint, backups and bootstrap, to compare after a read."""
    return {'library': hashed(root), 'canonical': hashed(edit_storage_root(root)), 'device': hashed(device, skip_locks=True),
            'backups': hashed(backup_base(root)), 'bootstrap': hashed(NativeLegacyStartup(root).root)}


def assert_no_working_copy(root):
    base = backup_base(root)
    if base.exists():
        assert not list(base.rglob('.analysis-*'))


def prepared(values, **options):
    root, device, _lock = values
    return build_synthetic_library(root, device=device, **options)


def notebook(manifest, identifier):
    return next(item for item in manifest['notebooks'] if item['sourceDocumentId'] == identifier)


def assert_matches_independent_counts(manifest, synthetic):
    """Both notebooks extracted; pages, ink rows, strokes and marks equal the direct SQLite/notebook.json count."""
    expected = synthetic.expected['notebooks']
    assert [item['sourceDocumentId'] for item in manifest['notebooks']] == sorted(expected)
    for identifier, counts in expected.items():
        item = notebook(manifest, identifier)
        assert item['status'] == 'extracted' and item['reason'] is None
        assert item['pageIds'] == counts['pageIds']
        assert item['coverage'] == {'pageRows': counts['pages'], 'inkRows': counts['inkRows'], 'bookmarkRows': len(counts['marks'])}
        assert [(row['side'], row['page'], row['strokeCount']) for row in item['rows']['ink']] == counts['ink']
        assert [(row['page'], row['kind']) for row in item['rows']['bookmarks']] == counts['marks'] or \
            sorted((row['page'], row['kind']) for row in item['rows']['bookmarks']) == sorted(counts['marks'])
        assert [row['number'] for row in item['rows']['pages']] == list(range(1, counts['pages'] + 1))
        assert [row['pageId'] for row in item['rows']['pages']] == counts['pageIds']
        assert all(row['pageId'] in counts['pageIds'] for row in (*item['rows']['ink'], *item['rows']['bookmarks']))
        assert 'page-text-not-converted' in item['incomplete'] and item['notebookEntry']['sha256']


def held_build(monkeypatch, *, honor_cancel):
    """Replace the worker body with one that stays in flight until released."""
    entered, release = threading.Event(), threading.Event()

    def held(token, include_extractions):
        entered.set()
        if honor_cancel:
            token.cancel.wait(10)
        if not release.wait(15):
            raise ValueError('fixture-timeout')
        return {'manifest': {}, 'report': {}, 'extractions': None}

    monkeypatch.setattr(conversion_input, '_build', held)
    return entered, release


# 1 ---------------------------------------------------------------------------------------
def test_live_main_fixture_manifest(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    before = snapshot(root, device)
    with TestClient(app) as client:
        run_id = capture_live(client)
        after_capture = snapshot(root, device)
        value = build(run_id)
        manifest, report = value['manifest'], value['report']
        assert value['extractions'] is None and set(value) == {'manifest', 'report', 'extractions'}
        record = NativePreparationJournal(root).read()
        registered = NativeLegacyInputs(root).read(run_id)
        assert manifest['version'] == 1 and manifest['scope'] == 'native-legacy-conversion-input-v1'
        assert (manifest['runId'], manifest['peerId'], manifest['libraryId']) == (run_id, record['peerId'], record['libraryId'])
        assert manifest['journalRecordSha256'] == edit_content_hash(record)
        assert manifest['selectionSha256'] == record['selectionSha256']
        assert manifest['inputSetSha256'] == edit_content_hash(registered)
        assert [item['kind'] for item in manifest['sources']] == ['desktop-library', 'canonical', 'device']
        assert [item['backupId'] for item in manifest['sources']] == record['backupIds']       # library, canonical, device
        for item in manifest['sources']:
            plan = next(entry['plan'] for entry in registered['inputs'] if entry['plan']['manifest']['id'] == item['backupId'])
            assert item['sourceId'] == plan['manifest']['source']['id']
            assert item['planSha256'] == edit_content_hash(plan) and item['observationSha256'] == plan['observationSha256']
            assert item['inventorySha256'] == plan['manifest']['inventorySha256']
            assert item['entryCount'] == len(plan['manifest']['entries'])
            assert item['totalBytes'] == sum(row['byteLength'] for row in plan['manifest']['entries'])
        assert manifest['inventory'] == {'reportSha256': report['reportSha256'], 'summary': report['summary']}
        assert manifest['sqlite'] == {'journalMode': 'rollback', 'walEntries': [], 'walComplete': True, 'userVersion': 9,
                                      'quickCheck': 'ok', 'notebooksListable': True}
        assert_matches_independent_counts(manifest, synthetic)
        assert report['selfCheck']['notebooks'] == [2, 2]
        # The whole Library is refused, with exactly the reasons a human can act on (equal, not a subset).
        assert manifest['wholeLibrary'] == {'status': 'refused', 'reasons': MAIN_REASONS}
        with pytest.raises(ValueError) as error:
            conversion_input.assert_whole_library_convertible(manifest)
        assert error.value.args == ('conversion-input-whole-library-refused', MAIN_REASONS)
        body = {key: item for key, item in manifest.items() if key != 'manifestSha256'}
        assert manifest['manifestSha256'] == edit_content_hash(body)
        # C-3: nothing the run read changed, and no working copy is left.
        assert snapshot(root, device) == after_capture
        assert_no_working_copy(root)
        assert not preview_gate.gate.inflight() and before['library'] == after_capture['library']


# 2 + 4 -----------------------------------------------------------------------------------
def test_cold_equals_live_and_builds_are_deterministic(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        first, second = build(run_id), build(run_id)
        assert first['manifest'] == second['manifest'] and first['report'] == second['report']
        assert first['manifest']['manifestSha256'] == second['manifest']['manifestSha256']
        assert first['report']['reportSha256'] == second['report']['reportSha256']
        to_cold(monkeypatch)
        settled = snapshot(root, device)
        cold = build(run_id)
        assert cold['manifest']['manifestSha256'] == first['manifest']['manifestSha256']
        assert cold['manifest'] == first['manifest'] and cold['report'] == first['report']
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)


# 3 ---------------------------------------------------------------------------------------
def test_extractions_are_returned_only_on_request_and_leave_everything_unchanged(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        value = build(run_id, include_extractions=True)
        assert sorted(value['extractions']) == sorted(synthetic.ids[key] for key in 'AB')
        for identifier, extraction in value['extractions'].items():
            assert extraction['bytes'] == (root / 'papers' / identifier / 'notebook.json').read_bytes()
            document = json.loads(extraction['bytes'])
            assert [item['pageId'] for item in extraction['annotations']] == [page['id'] for page in document['pages']]
            assert extraction['sourceDocumentId'] == identifier and extraction['libraryId'] == value['manifest']['libraryId']
        assert value['extractions'] and build(run_id)['extractions'] is None
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)


# 5 ---------------------------------------------------------------------------------------
def test_pending_notebook_change_blocks_only_that_notebook(runtime):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime, notebook_journal=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        a, b = synthetic.ids['A'], synthetic.ids['B']
        assert notebook(manifest, a)['status'] == 'extracted'
        blocked = notebook(manifest, b)
        assert blocked['status'] == 'blocked' and blocked['reason'] == 'legacy-notebook-recovery-pending'
        assert blocked['coverage'] is None and blocked['incomplete'] == []
        assert {'notebook-recovery-pending', 'notebook-extraction-blocked', 'uncollected-source'} <= set(manifest['wholeLibrary']['reasons'])
        assert manifest['wholeLibrary']['status'] == 'refused'
        assert_no_working_copy(root)


# 6 ---------------------------------------------------------------------------------------
def test_optional_and_glossary_tables_no_longer_block_the_notebooks(runtime):  # noqa: F811
    """B7-a (review r161 B6-b low-6, design risk 2): the extractor tolerates exactly the classified optional tables, so a
    Library that used glossaries (or has the old optional tables) still extracts both notebooks. The tables themselves stay
    retained-blocking (they are not converted), so the whole Library is still refused."""
    root, device, _lock = runtime
    prepared(runtime, optional_tables=('global_glossary', 'collection_undo'), glossary_tables=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id)
        manifest, report = value['manifest'], value['report']
        assert [item['status'] for item in manifest['notebooks']] == ['extracted', 'extracted']
        library = next(item for item in report['sources'] if item['kind'] == 'desktop-library')
        tables = {item['name']: item for item in library['sqlite']['objects']}
        assert all(tables[name]['category'] == R for name in ('global_glossary', 'collection_undo', 'paper_glossary',
                                                              'paper_glossary_domains', 'web_annotation_ops'))
        reasons = set(manifest['wholeLibrary']['reasons'])
        # Only a table holding a row blocks: collection_undo and global_glossary are empty here, paper_glossary(+domains) and
        # web_annotation_ops each hold one row.
        assert {'library-metadata-not-converted', 'web-annotation-ops-not-converted'} <= reasons and 'undo-state-not-converted' not in reasons
        assert 'notebook-extraction-blocked' not in reasons and manifest['wholeLibrary']['status'] == 'refused'
        assert manifest['sqlite']['notebooksListable'] is True
        assert_no_working_copy(root)


def test_an_unclassified_table_still_blocks_every_notebook_in_the_extractor(runtime):  # noqa: F811
    """The same path with a table the classification does not know: the inventory calls it unknown and the extractor refuses."""
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    synthetic.sql('CREATE TABLE surprise_table (id TEXT)')
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id)
        manifest, report = value['manifest'], value['report']
        assert [item['status'] for item in manifest['notebooks']] == ['blocked', 'blocked']
        assert {item['reason'] for item in manifest['notebooks']} == {'legacy-notebook-schema-unsupported'}
        library = next(item for item in report['sources'] if item['kind'] == 'desktop-library')
        assert {item['name']: item['reason'] for item in library['sqlite']['objects']}['surprise_table'] == 'unknown-table'
        assert {'unknown-table', 'notebook-extraction-blocked'} <= set(manifest['wholeLibrary']['reasons'])
        assert_no_working_copy(root)


def test_canonical_and_device_state_is_inventoried_and_blocks(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime, canonical_pending=True, folder_sync_state=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        assert {'canonical-pending-intent', 'folder-sync-state-pending', 'legacy-history-not-converted'} <= set(manifest['wholeLibrary']['reasons'])
        assert next(item for item in manifest['sources'] if item['kind'] == 'canonical')['entryCount'] > 0
        assert [item['status'] for item in manifest['notebooks']] == ['extracted', 'extracted']
        assert_no_working_copy(root)


# the table of notebook tables is read only when the database could really be opened (review low-3) -----------
def spy_on_reading(monkeypatch):
    calls = {'ids': 0, 'rows': 0, 'extract': 0}
    for name, key in (('notebook_ids', 'ids'), ('notebook_row_table', 'rows')):
        real = getattr(legacy_inventory, name)
        monkeypatch.setattr(legacy_inventory, name, lambda *args, _real=real, _key=key, **kwargs: (calls.__setitem__(_key, calls[_key] + 1), _real(*args, **kwargs))[1])
    real_extract = conversion_input.notebook_projection_from_copy
    monkeypatch.setattr(conversion_input, 'notebook_projection_from_copy',
                        lambda *args, **kwargs: (calls.__setitem__('extract', calls['extract'] + 1), real_extract(*args, **kwargs))[1])
    return calls


def test_a_wal_database_with_exactly_one_companion_is_not_listable(runtime, monkeypatch):  # noqa: F811
    """A WAL database with only a -wal (or only a -shm) in the backup is not listable: no notebook table is built and
    nothing is extracted, and the manifest says so. notebook_ids/notebook_row_table do not look at the WAL themselves.
    (Before B7-a this was also the state of a cleanly closed database, with neither file; that one is read now, below.)"""
    root, device, _lock = runtime
    prepared(runtime)
    settle(root / 'library.sqlite3', mode='WAL')          # header says WAL, no -wal/-shm companions exist
    assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
    (root / 'library.sqlite3-wal').write_bytes(b'synthetic stray wal')      # one companion only, after the last connection closed
    calls = spy_on_reading(monkeypatch)
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id)
        manifest = value['manifest']
        assert calls == {'ids': 0, 'rows': 0, 'extract': 0}
        assert manifest['notebooks'] == [] and value['report']['notebooks'] == []
        assert manifest['sqlite']['notebooksListable'] is False and manifest['sqlite']['walComplete'] is False
        assert manifest['sqlite']['journalMode'] == 'wal' and manifest['sqlite']['walEntries'] == ['library.sqlite3-wal']
        assert 'sqlite-wal-incomplete' in manifest['wholeLibrary']['reasons'] and manifest['wholeLibrary']['status'] == 'refused'
        assert_no_working_copy(root)


def test_a_cleanly_closed_wal_database_is_listable_and_extracted(runtime, monkeypatch):  # noqa: F811
    """B7-a, decision J5: header 2 and neither -wal nor -shm (what the app leaves after it exits) is read. Row tables are built
    and both notebooks are extracted; the WAL fields of the manifest say journal mode wal, no companion, complete."""
    root, device, _lock = runtime
    prepared(runtime)
    settle(root / 'library.sqlite3', mode='WAL')
    assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
    assert (root / 'library.sqlite3').read_bytes()[18:20] == b'\x02\x02'
    calls = spy_on_reading(monkeypatch)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        value = build(run_id)
        assert snapshot(root, device) == settled          # reading it changed nothing of the source
        manifest = value['manifest']
        assert calls == {'ids': 1, 'rows': 2, 'extract': 2}
        assert [item['status'] for item in manifest['notebooks']] == ['extracted', 'extracted']
        assert manifest['sqlite']['notebooksListable'] is True and manifest['sqlite']['walComplete'] is True
        assert manifest['sqlite']['journalMode'] == 'wal' and manifest['sqlite']['walEntries'] == []
        assert 'sqlite-wal-incomplete' not in manifest['wholeLibrary']['reasons'] and manifest['wholeLibrary']['status'] == 'refused'
        assert 'notebook-extraction-blocked' not in manifest['wholeLibrary']['reasons']
        assert_no_working_copy(root)


# child processes: real OS locks ----------------------------------------------------------
HOLD = r'''
import sys
from pathlib import Path
from papeer.core.instance import LibraryLock, instance_folder
lock = LibraryLock()
assert lock.try_acquire(Path(sys.argv[1]))
print(instance_folder(), flush=True)
print('ready', flush=True)
sys.stdin.read()
'''
REWRITE = r'''
import json, os, sys
from pathlib import Path
path = Path(sys.argv[1])
value = json.loads(path.read_text('utf8'))
value['pid'] = os.getpid()
value['nonce'] = 'f' * 64
path.write_text(json.dumps(value), 'utf8')
print('rewritten', flush=True)
'''


def read_line(process, seconds=300):
    box = []
    reader = threading.Thread(target=lambda: box.append(process.stdout.readline()), daemon=True)
    reader.start()
    reader.join(seconds)
    if reader.is_alive():
        pytest.fail(f'child pid {process.pid} printed nothing in {seconds}s (left running, never killed)')
    return box[0].strip()


def assert_isolated(tmp_path_factory, *folders):
    base = tmp_path_factory.getbasetemp().resolve()
    for folder in folders:
        assert Path(folder).resolve().is_relative_to(base)
    env = os.environ.copy()
    assert Path(env['LOCALAPPDATA']).resolve().is_relative_to(base)
    return env


@contextmanager
def holder(env, target, device):
    process = subprocess.Popen([sys.executable, '-B', '-c', HOLD, str(target)], env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf8')
    try:
        assert Path(read_line(process)).resolve() == (device / 'instances').resolve(), 'the child must share this device folder'
        assert read_line(process) == 'ready'
        yield process
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            pytest.fail(f'child pid {process.pid} did not exit after stdin closed (left running, never killed)')


def run_child(env, script, *args):
    result = subprocess.run([sys.executable, '-B', '-c', script, *args], env=env, capture_output=True, text=True,
                            encoding='utf8', timeout=300)
    assert result.returncode == 0, result.stderr
    return result.stdout


def spy_on_backup_reads(monkeypatch):
    """Every way a worker reads a backup: the whole-copy and the SQLite working copy, the verification pass, a single object
    (since B7-b the worker uses the last three; analysis_copy stays in the list so that a return to it would show)."""
    reads = []
    for name in ('analysis_copy', 'sqlite_working_copy', 'load', 'read_object'):
        real = getattr(NativeLegacyBackup, name)
        monkeypatch.setattr(NativeLegacyBackup, name, lambda self, *args, _real=real, _name=name, **kwargs: (reads.append(_name), _real(self, *args, **kwargs))[1])
    return reads


# 7 ---------------------------------------------------------------------------------------
def test_another_process_holding_the_library_lock_refuses_before_any_backup_is_read(runtime, monkeypatch, tmp_path_factory):  # noqa: F811
    root, device, lock = runtime
    prepared(runtime)
    env = assert_isolated(tmp_path_factory, device, root, paths.selected_data_directory())
    copies = spy_on_backup_reads(monkeypatch)
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        copies.clear()                           # the capture itself made its own copies
        instance.release()                       # this process lets go of the Library lock ...
        assert instance.current_library_lock(root) is None and not lock.held
        with holder(env, root, device):          # ... and a real other process takes it
            from papeer.core.instance import LibraryLock
            assert LibraryLock().try_acquire(root) is False, 'the OS lock must really be held by the child'
            refused(run_id, 'conversion-input-library-lock-unavailable')
            refused(run_id, 'conversion-input-library-lock-unavailable', include_extractions=True)
            assert copies == [] and not preview_gate.gate.inflight()
        assert_no_working_copy(root)


# 8 ---------------------------------------------------------------------------------------
def test_another_librarys_writer_refuses_live_and_cold_and_a_leftover_lock_file_still_refuses(runtime, monkeypatch, tmp_path, tmp_path_factory):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    env = assert_isolated(tmp_path_factory, device, root)
    other = tmp_path / 'another-library'
    other.mkdir()
    copies = spy_on_backup_reads(monkeypatch)
    with TestClient(app) as client:
        with holder(env, other, device):
            run_id = capture_live(client)                       # a controlled copy is captured; the foreign writer stays
            copies.clear()                                      # the capture itself made its own copies
            assert (device / 'instances' / (instance_key(other) + '.lock')).exists()
            refused(run_id, 'conversion-input-other-writer-present')
            to_cold(monkeypatch)
            refused(run_id, 'conversion-input-other-writer-present')
            assert copies == []
        # The child has exited; its lock file remains and nothing can tell a stale file from a live writer.
        leftovers = [item.name for item in (device / 'instances').iterdir() if item.name.startswith(instance_key(other))]
        assert leftovers
        refused(run_id, 'conversion-input-other-writer-present')
        assert copies == [] and not preview_gate.gate.inflight()
        assert_no_working_copy(root)


# 9 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize('state', ['live', 'cold'])
def test_a_rewritten_writer_record_is_not_this_processs_authority(runtime, monkeypatch, tmp_path_factory, state):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    env = assert_isolated(tmp_path_factory, device, root)
    record = device / 'instances' / (instance_key(root) + '.writer-v1.json')
    with TestClient(app) as client:
        run_id = capture_live(client)
        if state == 'cold':
            to_cold(monkeypatch)
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused'       # the genuine record is accepted
        original = record.read_bytes()
        try:
            assert run_child(env, REWRITE, str(record)).strip() == 'rewritten'
            assert record.read_bytes() != original
            refused(run_id, 'conversion-input-instance-writer-unverified')
        finally:
            record.write_bytes(original)
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused'


def test_writers_are_checked_at_admission_at_the_start_of_the_worker_and_again_at_the_end(runtime, monkeypatch):  # noqa: F811
    prepared(runtime)
    real = conversion_input._assert_external_writers
    state = {'calls': 0, 'fail_at': 0}

    def counting(selection):
        state['calls'] += 1
        if state['calls'] == state['fail_at']:
            raise ValueError('conversion-input-other-writer-present')
        return real(selection)

    with TestClient(app) as client:
        run_id = capture_live(client)
        monkeypatch.setattr(conversion_input, '_assert_external_writers', counting)
        for fail_at in (1, 2, 3):
            state.update(calls=0, fail_at=fail_at)
            refused(run_id, 'conversion-input-other-writer-present')
            assert state['calls'] == fail_at and not preview_gate.gate.inflight()
        state.update(calls=0, fail_at=0)
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused' and state['calls'] == 3
        assert_no_working_copy(root=runtime[0])


# 10 --------------------------------------------------------------------------------------
@pytest.mark.parametrize('claim', [{'quiescent': True}, {'path': 'C:/anything'}, {'writers_stopped': True}, {'digest': 'f' * 64}])
def test_no_caller_claim_authorises_anything_and_no_route_exists(runtime, claim):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with pytest.raises(TypeError):
            conversion_input.build(run_id, **claim)
        with pytest.raises(TypeError):
            conversion_input.start(run_id, **claim)
        with pytest.raises(ValueError) as error:
            conversion_input.start(run_id, include_extractions=1)
        assert error.value.args == ('conversion-input-unavailable',)
        assert not preview_gate.gate.inflight()
        def routes(items, prefix=''):
            for route in items:
                router = getattr(route, 'original_router', None)
                if router is not None:
                    yield from routes(router.routes, prefix + route.include_context.prefix)
                elif isinstance(route, APIRoute):
                    yield prefix + route.path
        found = {path for path in routes(app.routes) if path.startswith('/api/edits/legacy-maintenance/')}
        assert found == {f'/api/edits/legacy-maintenance/{name}' for name in ('start', 'status', 'resume', 'abandon', 'notebooks', 'notebook-preview')}
        assert 'conversion' not in json.dumps(app.openapi())


# 11 --------------------------------------------------------------------------------------
def test_preview_and_conversion_input_are_mutually_busy(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    synthetic = prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        token = preparation.admit_preview(run_id)
        entered, release, _future = hold_directly(preview_gate.gate, token)
        try:
            assert entered.wait(10)
            refused(run_id, 'conversion-input-busy')
        finally:
            release.set()
        assert preview_gate.gate.wait_idle(10)
        entered, release = held_build(monkeypatch, honor_cancel=False)
        token, future = conversion_input.start(run_id)
        try:
            assert entered.wait(10)
            response = post(client, run_id)
            assert response.status_code == 409 and response.json()['reason'] == 'preview-busy'
            response = post(client, run_id, synthetic.ids['A'])
            assert response.status_code == 409 and response.json()['reason'] == 'preview-busy'
            refused(run_id, 'conversion-input-busy')
        finally:
            release.set()
        assert future.result(10) and preview_gate.gate.wait_idle(10)
        assert post(client, run_id).status_code == 200


# 12 --------------------------------------------------------------------------------------
def test_preparation_operations_are_refused_while_a_build_runs(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    entered, release = held_build(monkeypatch, honor_cancel=False)
    with TestClient(app) as client:
        run_id = capture_live(client)
        token, future = conversion_input.start(run_id)
        try:
            assert entered.wait(10)
            for action in ('resume', 'abandon'):
                reply = client.post(PREFIX + action, json={'runId': run_id}, headers=AUTH)
                assert reply.status_code == 409 and reply.json()['reason'] == 'maintenance-recovery-unavailable'
            assert preparation._current.status()['state'] == 'captured'
        finally:
            release.set()
        assert future.result(10) and preview_gate.gate.wait_idle(10)


def test_cold_start_and_recover_are_refused_while_a_build_runs(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    entered, release = held_build(monkeypatch, honor_cancel=False)
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        token, future = conversion_input.start(run_id)
        try:
            assert entered.wait(10)
            with pytest.raises(ValueError, match='^maintenance-preview-pending$'):
                preparation.start()
            with pytest.raises(ValueError, match='^maintenance-preview-pending$'):
                preparation.recover(run_id, 'capture')
            assert client.post(PREFIX + 'start', json={}, headers=AUTH).status_code == 409 and preparation._current is None
        finally:
            release.set()
        assert future.result(10) and preview_gate.gate.wait_idle(10)


# 13 --------------------------------------------------------------------------------------
def test_shutdown_during_a_build_is_sticky_and_keeps_the_leases(runtime, monkeypatch):  # noqa: F811
    root, _device, lock = runtime
    prepared(runtime)
    entered, release = held_build(monkeypatch, honor_cancel=True)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .05)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .05)
    exited = threading.Event()
    monkeypatch.setattr(system, 'exit_process', exited.set)
    with TestClient(app) as client:
        run_id = capture_live(client)
        owner = preparation._current
        token, future = conversion_input.start(run_id)
        try:
            assert entered.wait(10)
            reply = client.post('/shutdown', headers=AUTH)
            assert reply.status_code == 200 and reply.json()['status'] == 'pending' and reply.json()['stopped'] is False
            assert token.cancel.is_set() and preview_gate.gate.closed
            assert not exited.wait(.7), 'the process must stay while the reader thread is alive'
            assert_leases_held(owner)
            assert lock.held and instance.maintenance_owner() is owner
            refused(run_id, 'conversion-input-shutdown-pending')
        finally:
            release.set()
        assert future.result(10) and preview_gate.gate.wait_idle(10)
        reply = client.post('/shutdown', headers=AUTH)
        assert reply.json()['status'] == 'shutting down' and reply.json()['stopped'] is True
        assert exited.wait(5)
        assert owner._closed and owner._device_lease is None and owner._history_lease is None, 'released only afterwards'
        refused(run_id, 'conversion-input-shutdown-pending')       # sticky


# 14 --------------------------------------------------------------------------------------
def test_cancel_inside_the_working_copy(runtime, monkeypatch):  # noqa: F811
    """The worker copies only the Library database (the main fixture has no -wal/-shm), so the first object it copies is
    the cancel point (before B7-b the whole backup was copied and the second object was)."""
    root, device, _lock = runtime
    prepared(runtime)
    calls = []
    real = NativeLegacyBackup._object

    def cancelling(self, entry, **kwargs):
        calls.append(entry['sha256'])
        if len(calls) == 1:
            preview_gate.gate._token.cancel.set()       # the running worker's own token
        return real(self, entry, **kwargs)

    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        monkeypatch.setattr(NativeLegacyBackup, '_object', cancelling)
        refused(run_id, 'conversion-input-cancelled')
        monkeypatch.setattr(NativeLegacyBackup, '_object', real)
        assert len(calls) >= 1, 'the cancel point was never reached inside the working copy'
        assert preview_gate.gate.wait_idle(5) and not preview_gate.gate.inflight()
        assert_no_working_copy(root)
        assert snapshot(root, device) == settled
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused', 'a cancelled build does not poison the next one'


# 15 --------------------------------------------------------------------------------------
def test_timeout_cancels_the_worker_and_the_gate_still_waits_for_its_thread(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    entered, release = held_build(monkeypatch, honor_cancel=False)
    with TestClient(app) as client:
        run_id = capture_live(client)
        started = time.monotonic()
        with pytest.raises(ValueError) as error:
            conversion_input.build(run_id, timeout=.2)
        assert error.value.args == ('conversion-input-cancelled',) and time.monotonic() - started < 5
        token = preview_gate.gate._token
        assert token is not None and token.cancel.is_set() and entered.is_set()
        assert preview_gate.gate.inflight() and not preview_gate.gate.wait_idle(.1), 'the thread is still the gate\'s'
        refused(run_id, 'conversion-input-busy')
        release.set()
        assert preview_gate.gate.wait_idle(10)


# 16 --------------------------------------------------------------------------------------
def test_state_that_is_not_a_captured_run_is_unavailable(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        owner = preparation._current
        refused(str(uuid4()), 'conversion-input-state-unavailable')
        refused('not-a-run-id C:\\private', 'conversion-input-state-unavailable')
        saved = owner._state
        owner._state = 'failed'
        try:
            refused(run_id, 'conversion-input-state-unavailable')
        finally:
            owner._state = saved
        record = NativePreparationJournal(root).read()
        to_cold(monkeypatch)
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused'
        journal = NativePreparationJournal(root)
        journal.mark(record, 'cancel-intent')
        refused(run_id, 'conversion-input-state-unavailable')                 # cancel-interrupted
        journal.mark_cleanup(record, str(uuid4()), 'begin')
        refused(run_id, 'conversion-input-state-unavailable')                 # cleanup-unknown
        assert not preview_gate.gate.inflight()
        assert_no_working_copy(root)


# 17 --------------------------------------------------------------------------------------
def test_a_change_between_the_two_reads_is_refused(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    real = notebook_preview._fingerprint
    seen = []

    def changing(token, *, deep, **options):
        value = real(token, deep=deep, **options)
        seen.append(deep)
        return value if len(seen) != 2 else (*value[:5], (*value[5], 'f' * 32))

    with TestClient(app) as client:
        run_id = capture_live(client)
        monkeypatch.setattr(notebook_preview, '_fingerprint', changing)
        refused(run_id, 'conversion-input-source-changed')
        assert len(seen) == 2 and not preview_gate.gate.inflight()
        monkeypatch.setattr(notebook_preview, '_fingerprint', real)
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused'


def test_an_owner_change_at_the_very_end_discards_the_result(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    real = conversion_input._manifest

    def then_replace(*args, **kwargs):
        value = real(*args, **kwargs)           # a complete manifest ...
        monkeypatch.setattr(preparation, '_current', None)
        return value                            # ... that must still be discarded

    with TestClient(app) as client:
        run_id = capture_live(client)
        monkeypatch.setattr(conversion_input, '_manifest', then_replace)
        refused(run_id, 'conversion-input-state-unavailable')


# 18 --------------------------------------------------------------------------------------
def test_the_row_check_compares_the_extractor_with_the_independent_table(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    real = conversion_input.notebook_projection_from_copy

    def mutate(kind):
        def wrapper(*args, **kwargs):
            value = real(*args, **kwargs)
            coverage, annotations = dict(value['coverage']), [dict(item) for item in value['annotations']]
            if kind == 'ink-rows':
                coverage['inkRows'] -= 1
            elif kind == 'bookmark-rows':
                coverage['bookmarkRows'] += 1
            elif kind == 'ink-pages':
                coverage['inkPages'] = [page + 1 for page in coverage['inkPages']]
            elif kind == 'bookmark-ids':
                coverage['bookmarkIds'] = list(reversed(coverage['bookmarkIds'])) + ['0']
            elif kind == 'page-ids':
                annotations.reverse()
            elif kind == 'stroke-dropped':
                target = next(item for item in annotations if item['ink'])
                target['ink'] = target['ink'][:-1]
            elif kind == 'mark-dropped':
                target = next(item for item in annotations if item['bookmarks'])
                target['bookmarks'] = target['bookmarks'][:-1]
            return {**value, 'coverage': coverage, 'annotations': annotations}
        return wrapper

    with TestClient(app) as client:
        run_id = capture_live(client)
        for kind in ('ink-rows', 'bookmark-rows', 'ink-pages', 'bookmark-ids', 'page-ids', 'stroke-dropped', 'mark-dropped'):
            with monkeypatch.context() as patch:
                patch.setattr(conversion_input, 'notebook_projection_from_copy', mutate(kind))
                error = refused(run_id, 'conversion-input-row-coverage-mismatch')       # no manifest is ever returned
                assert error.args == ('conversion-input-row-coverage-mismatch',), kind
        assert build(run_id)['manifest']['notebooks'][0]['status'] == 'extracted'
        assert_no_working_copy(root)


# 19 --------------------------------------------------------------------------------------
def test_limits_refuse_instead_of_truncating(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    megabyte = 1024 * 1024
    cases = [
        (conversion_input, 'CONVERSION_LIMITS', BackupReadLimits(metadata_bytes=8 * megabyte, entries=100_000, total_bytes=0), {}, 'conversion-input-capacity-exceeded'),
        (conversion_input, 'CONVERSION_LIMITS', BackupReadLimits(metadata_bytes=8 * megabyte, entries=1, total_bytes=4096 * megabyte), {}, 'conversion-input-capacity-exceeded'),
        (conversion_input, 'CONVERSION_LIMITS', BackupReadLimits(metadata_bytes=1, entries=100_000, total_bytes=4096 * megabyte), {}, 'conversion-input-capacity-exceeded'),
        (notebook_preview, 'MAX_NOTEBOOKS', 1, {}, 'conversion-input-capacity-exceeded'),
        (notebook_preview, 'MAX_NOTEBOOK_BYTES', 10, {}, 'conversion-input-capacity-exceeded'),
        (notebook_preview, 'MAX_PAGES', 1, {}, 'conversion-input-capacity-exceeded'),
        (notebook_preview, 'MAX_PROJECTION_BYTES', 10, {}, 'conversion-input-capacity-exceeded'),
        (conversion_input, 'MAX_EXTRACTION_BYTES', 10, {'include_extractions': True}, 'conversion-input-capacity-exceeded'),
        (conversion_input, 'MAX_MANIFEST_BYTES', 100, {}, 'conversion-input-capacity-exceeded'),
        (conversion_input, 'MAX_INSTANCE_FILES', 1, {}, 'conversion-input-instance-census-unbounded'),
    ]
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        for owner, name, value, options, reason in cases:
            with monkeypatch.context() as patch:
                patch.setattr(owner, name, value)
                refused(run_id, reason, **options)
                assert not preview_gate.gate.inflight(), name
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused'
        # B7-b: the preview's 256 MiB bound is the preview's only; a conversion does not read it.
        with monkeypatch.context() as patch:
            patch.setattr(notebook_preview, 'LIMITS', BackupReadLimits(metadata_bytes=8 * megabyte, entries=1, total_bytes=0))
            assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused'


# 20 --------------------------------------------------------------------------------------
def test_nothing_private_is_returned_in_a_manifest_a_report_or_an_error(runtime, monkeypatch, tmp_path_factory):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    base = str(tmp_path_factory.getbasetemp().resolve())
    with TestClient(app) as client:
        run_id = capture_live(client)
        value = build(run_id, include_extractions=False)
        text = json.dumps(value, ensure_ascii=True, sort_keys=True)
        for forbidden in (*SENTINELS, str(root), str(device), base, base.replace('\\', '\\\\'), str(paths.device_directory()),
                          root.name, 'Traceback'):
            assert forbidden not in text, forbidden
        real = conversion_input.notebook_projection_from_copy
        for error in (OSError(2, 'secret-os-text C:\\private\\library.sqlite3'), RecursionError('secret-recursion-text'),
                      ValueError('secret-value-text C:\\private\\path')):
            def failing(*args, _error=error, **kwargs):
                raise _error
            with monkeypatch.context() as patch:
                patch.setattr(conversion_input, 'notebook_projection_from_copy', failing)
                if isinstance(error, ValueError):
                    # one notebook's unreadable message is that notebook's blocked reason, never the text
                    blocked = build(run_id)['manifest']
                    assert [item['reason'] for item in blocked['notebooks']] == ['extraction-unavailable'] * 2
                    assert 'secret' not in json.dumps(blocked) and 'private' not in json.dumps(blocked)
                else:
                    raised = refused(run_id, 'conversion-input-unavailable')
                    assert 'secret' not in repr(raised) and 'private' not in repr(raised)
        for failure in (OSError('secret C:\\private'), RuntimeError('secret thread'), sqlite3.DatabaseError('secret db')):
            with monkeypatch.context() as patch:
                patch.setattr(conversion_input, '_build', lambda *args, _failure=failure, **kwargs: (_ for _ in ()).throw(_failure))
                raised = refused(run_id, 'conversion-input-unavailable')
                assert 'secret' not in repr(raised)
        assert real is conversion_input.notebook_projection_from_copy


# unit ------------------------------------------------------------------------------------
def test_reason_table_is_a_closed_set():
    table = {
        'preview-busy': 'busy', 'preview-shutdown-pending': 'shutdown-pending', 'preview-cancelled': 'cancelled',
        'backup-read-cancelled': 'cancelled', 'inventory-cancelled': 'cancelled', 'backup-read-limit': 'capacity-exceeded',
        'legacy-notebook-read-limit': 'capacity-exceeded', 'inventory-capacity-exceeded': 'capacity-exceeded',
        'preview-notebook-capacity-exceeded': 'capacity-exceeded', 'preview-response-capacity-exceeded': 'capacity-exceeded',
        'preview-state-unavailable': 'state-unavailable', 'preview-source-changed': 'source-changed',
        'backup-source-changed': 'source-changed', 'legacy-notebook-input-changed': 'source-changed',
        'inventory-self-check-failed': 'inventory-self-check-failed', 'inventory-copy-mismatch': 'inventory-copy-mismatch',
        'backup-disk-insufficient': 'disk-insufficient',
        'conversion-input-other-writer-present': 'other-writer-present', 'conversion-input-row-coverage-mismatch': 'row-coverage-mismatch',
        'anything else C:\\secret': 'unavailable', 'inventory-notebook-not-found': 'unavailable'}
    for text, reason in table.items():
        assert conversion_input.reason_of(ValueError(text)) == 'conversion-input-' + reason, text
    assert conversion_input.reason_of(census.CoverageUnresolved('maintenance-lock-unavailable')) == 'conversion-input-library-lock-unavailable'
    assert conversion_input.reason_of(census.CoverageUnresolved('maintenance-other-library-writers-unresolved')) == 'conversion-input-coverage-unresolved'
    for error in (OSError('x'), RecursionError(), sqlite3.Error('x'), ValueError('a', 'b'), ValueError(), KeyError('k')):
        assert conversion_input.reason_of(error) == 'conversion-input-unavailable'
    assert set(table) and all(('conversion-input-' + reason) in conversion_input.REASONS for reason in table.values())


def test_whole_library_assessment_never_accepts():
    for manifest in ({}, {'wholeLibrary': {}}, {'wholeLibrary': {'status': 'accepted', 'reasons': []}},
                     {'wholeLibrary': {'status': 'accepted', 'reasons': ['x']}}, None, [], 'accepted'):
        with pytest.raises(ValueError) as error:
            conversion_input.assert_whole_library_convertible(manifest)
        assert error.value.args[0] == 'conversion-input-whole-library-refused'
    with pytest.raises(ValueError) as error:
        conversion_input.assert_whole_library_convertible({'wholeLibrary': {'status': 'refused', 'reasons': ['a', 'b']}})
    assert error.value.args == ('conversion-input-whole-library-refused', ['a', 'b'])
    assert legacy_inventory.whole_library_assessment({'summary': {'blockingReasons': []}}) == {'status': 'refused', 'reasons': ['uncollected-source']}


# unit: the same checks without a live capture (so that they are exercised even when a capture cannot run) ---------
class FakeLock:
    def __init__(self, current=True):
        self.current = current

    def writer_protocol_current(self, _root):
        return self.current


class FakeSelection:
    def __init__(self, root, device, lock):
        self.root, self.device, self.held_lock = root, device, lock


def fake_writer_world(tmp_path, monkeypatch, *, owns=True, current=True, extra=(), own=('lock', 'json', 'writer-v1.json')):
    root, device = tmp_path / 'library', tmp_path / 'device'
    root.mkdir(parents=True)
    (device / 'instances').mkdir(parents=True)
    for suffix in own:
        (device / 'instances' / (instance_key(root) + '.' + suffix)).write_bytes(b'x')
    for name in extra:
        (device / 'instances' / name).write_bytes(b'x')
    lock = FakeLock(current)
    monkeypatch.setattr(instance, 'owns_library_lock', lambda _root, held: owns and held is lock)
    return FakeSelection(root, device, lock)


def test_external_writer_check_unit(tmp_path, monkeypatch):
    conversion_input._assert_external_writers(fake_writer_world(tmp_path / 'ok', monkeypatch))
    cases = [({'owns': False}, 'library-lock-unavailable'), ({'current': False}, 'instance-writer-unverified'),
             ({'extra': ('f' * 64 + '.lock',)}, 'other-writer-present'), ({'extra': ('f' * 64 + '.json',)}, 'other-writer-present'),
             ({'extra': ('stray.txt',)}, 'other-writer-present')]
    for number, (options, reason) in enumerate(cases):
        (tmp_path / str(number)).mkdir()
        with pytest.raises(ValueError) as error:
            conversion_input._assert_external_writers(fake_writer_world(tmp_path / str(number), monkeypatch, **options))
        assert error.value.args == ('conversion-input-' + reason,), options
    (tmp_path / 'many').mkdir()
    monkeypatch.setattr(conversion_input, 'MAX_INSTANCE_FILES', 3)
    selection = fake_writer_world(tmp_path / 'many', monkeypatch)
    conversion_input._assert_external_writers(selection)                  # three own files are exactly at the limit
    monkeypatch.setattr(conversion_input, 'MAX_INSTANCE_FILES', 2)
    with pytest.raises(ValueError) as error:
        conversion_input._assert_external_writers(selection)
    assert error.value.args == ('conversion-input-instance-census-unbounded',)


def row_table():
    ids = ['a' * 32, 'b' * 32]
    return {'sourceDocumentId': 'n' * 32, 'notebookEntry': {'sha256': 's' * 64, 'byteLength': 9}, 'pageIds': ids,
            'pages': [{'number': 1, 'pageId': ids[0]}, {'number': 2, 'pageId': ids[1]}],
            'ink': [{'side': 'original', 'page': 2, 'pageId': ids[1], 'strokeCount': 2}],
            'bookmarks': [{'id': '7', 'page': 1, 'side': 'original', 'kind': 'note', 'pageId': ids[0]}]}


def extraction_of(table):
    ids = table['pageIds']
    return {'sourceDocumentId': table['sourceDocumentId'], 'entry': dict(table['notebookEntry']),
            'coverage': {'pageRows': 2, 'inkRows': 1, 'bookmarkRows': 1, 'inkPages': [2], 'bookmarkIds': ['7']},
            'annotations': [{'pageId': ids[0], 'ink': [], 'bookmarks': [{'id': '7'}]},
                            {'pageId': ids[1], 'ink': [{}, {}], 'bookmarks': []}]}


def test_row_check_unit():
    table = row_table()
    conversion_input._check_rows(table, extraction_of(table))             # the matching pair is accepted
    mutations = {
        'page-rows': lambda v: v['coverage'].update(pageRows=1), 'ink-rows': lambda v: v['coverage'].update(inkRows=0),
        'bookmark-rows': lambda v: v['coverage'].update(bookmarkRows=2), 'ink-pages': lambda v: v['coverage'].update(inkPages=[1]),
        'bookmark-ids': lambda v: v['coverage'].update(bookmarkIds=['8']), 'page-order': lambda v: v['annotations'].reverse(),
        'stroke-dropped': lambda v: v['annotations'][1].update(ink=[{}]), 'mark-dropped': lambda v: v['annotations'][0].update(bookmarks=[]),
        'document': lambda v: v.update(sourceDocumentId='m' * 32), 'entry': lambda v: v['entry'].update(byteLength=10)}
    for name, change in mutations.items():
        value = extraction_of(table)
        change(value)
        with pytest.raises(ValueError) as error:
            conversion_input._check_rows(table, value)
        assert error.value.args == ('conversion-input-row-coverage-mismatch',), name


def test_row_tables_need_a_listable_database_unit(monkeypatch):
    calls = []
    monkeypatch.setattr(legacy_inventory, 'notebook_ids', lambda *args, **kwargs: calls.append('ids') or ['a' * 32])
    # The row table has the shape of the real one: `_library_tables` normalizes it now (work B7-f), and an empty well-formed table comes back unchanged.
    table = {'sourceDocumentId': 'a' * 32, 'pages': [], 'ink': [], 'bookmarks': [], 'pageIds': [], 'problem': None, 'unmapped': 0}
    monkeypatch.setattr(legacy_inventory, 'notebook_row_table', lambda *args, **kwargs: calls.append('row') or dict(table))
    token = type('Token', (), {'cancel': threading.Event()})()

    def source(*, listable, wal_complete=True, reasons=()):
        monkeypatch.setattr(legacy_inventory, 'notebooks_listable', lambda _source: listable)
        return {'kind': 'desktop-library', 'sqlite': {'walComplete': wal_complete, 'reasons': list(reasons)}}

    for options in ({'listable': False}, {'listable': True, 'wal_complete': False}, {'listable': True, 'reasons': ['sqlite-wal-incomplete']}):
        assert conversion_input._library_tables(token, Path('.'), {}, source(**options), None) == []
        assert calls == [], options
    assert conversion_input._library_tables(token, Path('.'), {}, source(listable=True), None) == [table]
    assert calls == ['ids', 'row']
    monkeypatch.setattr(notebook_preview, 'MAX_NOTEBOOKS', 0)
    with pytest.raises(ValueError, match='^preview-notebook-capacity-exceeded$'):
        conversion_input._library_tables(token, Path('.'), {}, source(listable=True), None)


def test_timeout_cancels_the_token_unit(monkeypatch):
    from concurrent.futures import Future
    token = type('Token', (), {'cancel': threading.Event()})()
    monkeypatch.setattr(conversion_input, 'start', lambda run_id, **_options: (token, Future()))
    with pytest.raises(ValueError) as error:
        conversion_input.build(str(uuid4()), timeout=.05)
    assert error.value.args == ('conversion-input-cancelled',) and token.cancel.is_set()


# ----- work B7-b: one SQLite-only working copy, the conversion's own limits, free space, the per-resource cap -------------
# DESIGN-r161-b7-staging.md 7.2, tests K-1 .. K-6. The B6 tests above (C-1 .. C-20) are unchanged in what they claim.
MIB = 1024 * 1024
FILE_USAGE = namedtuple('usage', 'total used free')


def track_working_copies(monkeypatch):
    """Every working folder the worker makes (how many, how many exist at once, what the inventory finds in each) and every
    byte that is copied into one. The worker makes no analysis_copy any more (a whole copy would show in `whole`)."""
    log = {'made': [], 'alive': 0, 'peak': 0, 'inventory': [], 'copied': [], 'whole': 0}
    real_directory, real_copy, real_whole = NativeLegacyBackup._working_directory, NativeLegacyBackup._copy_into, NativeLegacyBackup.analysis_copy

    @contextmanager
    def tracked(self):
        with real_directory(self) as directory:
            log['made'].append(directory.name)
            log['alive'] += 1
            log['peak'] = max(log['peak'], log['alive'])
            try:
                yield directory
            finally:
                log['alive'] -= 1

    def copying(self, directory, entry, cancel=None):
        log['copied'].append((tuple(entry['key']), entry['byteLength']))
        return real_copy(self, directory, entry, cancel)

    def whole(self, *args, **kwargs):
        log['whole'] += 1
        return real_whole(self, *args, **kwargs)

    real_inventory = legacy_inventory.inventory_source

    def looking(kind, manifest, copy, **options):
        log['inventory'].append((kind, None if copy is None else sorted(path.relative_to(copy).as_posix() for path in copy.rglob('*'))))
        return real_inventory(kind, manifest, copy, **options)

    monkeypatch.setattr(NativeLegacyBackup, '_working_directory', tracked)
    monkeypatch.setattr(NativeLegacyBackup, '_copy_into', copying)
    monkeypatch.setattr(NativeLegacyBackup, 'analysis_copy', whole)
    monkeypatch.setattr(legacy_inventory, 'inventory_source', looking)
    return log


def preview_extraction(root, run_id, table):
    """The projection the Notebook preview would return for this Notebook (its own, whole-copy function)."""
    record = NativePreparationJournal(root).read()
    return notebook_projection_input(
        NativeLegacyBackup(root), run_id, record['peerId'], table['sourceDocumentId'], limits=notebook_preview.LIMITS,
        max_notebook_bytes=notebook_preview.MAX_NOTEBOOK_BYTES, max_pages=notebook_preview.MAX_PAGES,
        max_annotation_rows=notebook_preview.MAX_ANNOTATION_ROWS, max_projection_bytes=notebook_preview.MAX_PROJECTION_BYTES)


# K-1 + K-2 + the extractor is the preview's --------------------------------------------------------------------------
@pytest.mark.parametrize('options,expected', [
    ({}, [('desktop-library', ['library.sqlite3']), ('canonical', None), ('device', None)]),
    ({'wal_closed': True}, [('desktop-library', ['library.sqlite3']), ('canonical', None), ('device', None)]),
    ({'canonical_pending': True, 'folder_sync_state': True},
     [('desktop-library', ['library.sqlite3']), ('canonical', ['content.sqlite3']), ('device', None)])],
    ids=['main', 'wal-closed', 'canonical-store'])
def test_one_working_copy_per_database_serves_the_whole_worker_and_holds_only_the_database(runtime, monkeypatch, options, expected):  # noqa: F811
    """K-1: before B7-b every source was copied whole and every Notebook was copied whole again (here 1 + 1 + 1 + 2 copies of
    everything). Now a source with a database makes ONE working copy and a source without one makes none; the copies are made one
    at a time (peak 1) and the Notebooks (2 here) share the Library's. K-2: the only files that are copied are the database files."""
    root, device, _lock = runtime
    synthetic = prepared(runtime, **options)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        log = track_working_copies(monkeypatch)
        value = build(run_id, include_extractions=True)
        assert [item['status'] for item in value['manifest']['notebooks']] == ['extracted', 'extracted']
        databases = sum(1 for _kind, files in expected if files)
        assert len(log['made']) == databases and log['peak'] == 1 and log['whole'] == 0
        assert log['inventory'] == expected
        assert sorted(key for key, _size in log['copied']) == sorted((name,) for _kind, files in expected for name in (files or []))
        # every Notebook of the shared copy gives exactly what the preview's own whole-copy extraction gives
        assert sorted(value['extractions']) == sorted(synthetic.ids[key] for key in 'AB')
        for table in value['manifest']['notebooks']:
            assert value['extractions'][table['sourceDocumentId']] == preview_extraction(root, run_id, table)
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)
        assert build(run_id)['manifest']['manifestSha256'] == value['manifest']['manifestSha256']


def test_the_worker_without_extractions_makes_the_same_single_copy(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        log = track_working_copies(monkeypatch)
        assert build(run_id)['extractions'] is None
        assert len(log['made']) == 1 and log['peak'] == 1 and log['whole'] == 0
        assert_no_working_copy(root)


# K-5 -----------------------------------------------------------------------------------------------------------------
def test_free_space_is_checked_before_the_copy_and_refused_with_its_own_reason(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        needed = (root / 'library.sqlite3').stat().st_size          # the only file that is copied (the main fixture has no -wal/-shm)
        monkeypatch.setattr(conversion_input, 'DISK_MARGIN_BYTES', 4 * MIB)
        free, library_backup = {'bytes': 0}, NativeLegacyBackup(root).root
        real = shutil.disk_usage
        monkeypatch.setattr(shutil, 'disk_usage', lambda path: FILE_USAGE(10 ** 12, 0, free['bytes']) if Path(path) == library_backup else real(path))
        log = track_working_copies(monkeypatch)
        for starved in (0, needed + 4 * MIB - 1):
            free['bytes'] = starved
            refused(run_id, 'conversion-input-disk-insufficient')
            refused(run_id, 'conversion-input-disk-insufficient', include_extractions=True)
            assert log['made'] == [] and not preview_gate.gate.inflight()
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)
        free['bytes'] = needed + 4 * MIB
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused' and len(log['made']) == 1
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)


# K-6 -----------------------------------------------------------------------------------------------------------------
def test_a_notebook_whose_pdf_is_over_the_resource_cap_is_blocked_alone(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    synthetic = prepared(runtime)
    sizes = {key: (root / 'papers' / synthetic.ids[key] / 'original.pdf').stat().st_size for key in 'AB'}
    assert conversion_input.MAX_RESOURCE_BYTES == 512 * MIB
    assert sizes['A'] != sizes['B'], 'the two notebooks need different PDF sizes for a cap between them'
    small, large = sorted(sizes, key=sizes.get)
    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        monkeypatch.setattr(conversion_input, 'MAX_RESOURCE_BYTES', sizes[small])      # a PDF of exactly the cap is within it
        value = build(run_id, include_extractions=True)
        manifest = value['manifest']
        blocked = notebook(manifest, synthetic.ids[large])
        assert blocked['status'] == 'blocked' and blocked['reason'] == 'resource-too-large' and blocked['coverage'] is None
        assert notebook(manifest, synthetic.ids[small])['status'] == 'extracted'
        assert list(value['extractions']) == [synthetic.ids[small]]
        assert 'notebook-extraction-blocked' in manifest['wholeLibrary']['reasons'] and manifest['wholeLibrary']['status'] == 'refused'
        monkeypatch.setattr(conversion_input, 'MAX_RESOURCE_BYTES', sizes[small] - 1)
        assert [item['reason'] for item in build(run_id)['manifest']['notebooks']] == ['resource-too-large'] * 2
        monkeypatch.setattr(conversion_input, 'MAX_RESOURCE_BYTES', 512 * MIB)
        assert [item['status'] for item in build(run_id)['manifest']['notebooks']] == ['extracted'] * 2
        assert snapshot(root, device) == settled
        assert_no_working_copy(root)


# K-4 -----------------------------------------------------------------------------------------------------------------
def tree_digest(base):
    """Relative path -> sha256, read in 1 MiB blocks (a 300 MiB file is never held in memory)."""
    result = {}
    for path in sorted(base.rglob('*')):
        key = path.relative_to(base).as_posix()
        if path.is_dir():
            result[key] = None
        elif path.name.endswith('.lock'):
            result[key] = path.stat().st_size
        else:
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(MIB), b''):
                    digest.update(block)
            result[key] = digest.hexdigest()
    return result


def test_a_library_of_about_300_mib_is_converted_while_the_preview_refuses_it(runtime, monkeypatch):  # noqa: F811
    """K-4: a Library with a PDF (a PDF row, kind='pdf') padded to 300 MiB. The preview keeps its 256 MiB bound and says
    capacity-exceeded, live and cold; the conversion input succeeds, reads 300 MiB once per verification pass, copies no PDF (only
    the database goes into the single working copy) and leaves the Library, the backups and the device exactly as they were."""
    root, device, _lock = runtime
    synthetic = prepared(runtime, large_pdf=300 * MIB)
    pdf = root / 'papers' / synthetic.ids['P'] / 'original.pdf'
    assert pdf.stat().st_size > 300 * MIB and pdf.stat().st_size > notebook_preview.LIMITS.total_bytes
    with TestClient(app) as client:
        run_id = capture_live(client)
        before = {'library': tree_digest(root), 'backups': tree_digest(backup_base(root)), 'device': tree_digest(device)}
        assert_blocked(post(client, run_id), 'preview-capacity-exceeded')
        assert_blocked(post(client, run_id, synthetic.ids['A']), 'preview-capacity-exceeded')
        log = track_working_copies(monkeypatch)
        value = build(run_id, include_extractions=True)
        manifest = value['manifest']
        assert [item['status'] for item in manifest['notebooks']] == ['extracted', 'extracted']
        assert next(item for item in manifest['sources'] if item['kind'] == 'desktop-library')['totalBytes'] > 300 * MIB
        assert manifest['wholeLibrary'] == {'status': 'refused', 'reasons': MAIN_REASONS}
        assert len(log['made']) == 1 and log['peak'] == 1 and log['whole'] == 0
        assert log['inventory'][0] == ('desktop-library', ['library.sqlite3'])
        assert sum(size for _key, size in log['copied']) < 8 * MIB, 'only the database is copied, never the PDF'
        assert {'library': tree_digest(root), 'backups': tree_digest(backup_base(root)), 'device': tree_digest(device)} == before
        assert_no_working_copy(root)
        # the same from the cold state (the durable classifier verifies every object under the conversion's limits)
        to_cold(monkeypatch)             # a normal shutdown writes its own cleanup events into the bootstrap area: look after it
        settled = {'library': tree_digest(root), 'backups': tree_digest(backup_base(root)), 'device': tree_digest(device)}
        assert settled['library'] == before['library'] and settled['device'] == before['device']
        assert_blocked(post(client, run_id), 'preview-capacity-exceeded')
        cold = build(run_id, include_extractions=True)
        assert cold['manifest'] == manifest and cold['report'] == value['report']
        assert {'library': tree_digest(root), 'backups': tree_digest(backup_base(root)), 'device': tree_digest(device)} == settled
        assert_no_working_copy(root)
        # a lower conversion bound refuses (instead of reading less)
        monkeypatch.setattr(conversion_input, 'CONVERSION_LIMITS', BackupReadLimits(metadata_bytes=8 * MIB, entries=100_000, total_bytes=256 * MIB))
        refused(run_id, 'conversion-input-capacity-exceeded')


# K-3 at the worker level: a file that is not copied is still verified -----------------------------------------------------
def test_every_backup_object_is_verified_even_when_it_is_not_copied(runtime):  # noqa: F811
    """Only the database goes into the working copy, so the verification of every other object (their size and sha256, which the
    whole-copy analysis did by copying them) is the `load` pass of each source. A damaged object of the Library (a file the worker
    never reads) or of the device (a source with no database at all) refuses the build, live, and leaves nothing behind."""
    root, device, _lock = runtime
    synthetic = prepared(runtime, folder_sync_state=True)
    with TestClient(app) as client:
        run_id = capture_live(client)
        record = NativePreparationJournal(root).read()
        targets = [(NativeLegacyBackup(root), record['backupIds'][0], ('papers', synthetic.ids['P'], 'media', 'figure.png')),
                   (NativeLegacyHeldDeviceBackup(root, device_root=device), record['backupIds'][2], ('device-settings.json',))]
        settled = snapshot(root, device)
        for backup, backup_id, key in targets:
            entry = next(item for item in backup.load(backup_id)['entries'] if tuple(item['key']) == key)
            path = backup.root / 'objects' / entry['sha256']
            good = path.read_bytes()
            path.write_bytes(bytes((byte + 1) % 256 for byte in good))                   # same size, other bytes
            try:
                refused(run_id, 'conversion-input-unavailable')
                refused(run_id, 'conversion-input-unavailable', include_extractions=True)
                assert not preview_gate.gate.inflight()
                assert_no_working_copy(root)
            finally:
                path.write_bytes(good)
            assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused', key
        assert snapshot(root, device) == settled


# Work B7-d: REVIEW-r161-b7b low 3 and low 1 at the worker level ---------------------------------------------------------------
@pytest.mark.parametrize('after', ['_library_tables', '_extract_notebooks'])
def test_a_working_copy_that_changed_after_a_use_is_refused_at_its_last_use(runtime, monkeypatch, after):  # noqa: F811
    """The inventory checks the copy's tree before the database is opened; since B7-b nothing looked at the copy again, so the row
    tables and the extraction could agree on a copy that had been changed in between. The worker now compares the database (and
    its -wal) with the manifest once more after its last use of the copy. Appending a byte keeps every page readable, so a change
    is refused by this check and by nothing else."""
    root, device, _lock = runtime
    prepared(runtime)
    real = getattr(conversion_input, after)

    def tampering(*args, **kwargs):
        value = real(*args, **kwargs)
        copy = next(item for item in (*args, *kwargs.values()) if isinstance(item, Path))
        assert copy.joinpath('library.sqlite3').is_file()
        with copy.joinpath('library.sqlite3').open('ab') as stream:
            stream.write(b'0')
        return value

    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        monkeypatch.setattr(conversion_input, after, tampering)
        refused(run_id, 'conversion-input-inventory-copy-mismatch')
        refused(run_id, 'conversion-input-inventory-copy-mismatch', include_extractions=True)
        monkeypatch.setattr(conversion_input, after, real)
        assert preview_gate.gate.wait_idle(5) and not preview_gate.gate.inflight()
        assert_no_working_copy(root)
        assert snapshot(root, device) == settled
        assert build(run_id)['manifest']['wholeLibrary']['status'] == 'refused', 'the next build starts from a fresh copy'


@pytest.mark.parametrize('failure, reason', [('backup-source-changed', 'conversion-input-source-changed'),
                                              ('backup-object-hash', 'conversion-input-unavailable'),
                                              ('backup-entry-missing', 'conversion-input-unavailable')])
def test_a_storage_location_object_that_stops_matching_is_refused_not_called_unreadable(runtime, monkeypatch, failure, reason):  # noqa: F811
    """Before B7-d every failure of the read was a fact about the file ("unreadable"); only the size bound and a JSON error are."""
    root, device, _lock = runtime
    prepared(runtime)
    (device / 'storage-location.json').write_text(json.dumps({'path': str(root)}), 'utf-8')
    real = NativeLegacyBackup.read_object

    def broken(self, identity, entry, **kwargs):
        if entry['key'] == ['storage-location.json']:
            raise ValueError(failure)
        return real(self, identity, entry, **kwargs)

    def too_big(self, identity, entry, **kwargs):
        if entry['key'] == ['storage-location.json']:
            raise ValueError('backup-read-limit')
        return real(self, identity, entry, **kwargs)

    with TestClient(app) as client:
        run_id = capture_live(client)
        settled = snapshot(root, device)
        monkeypatch.setattr(NativeLegacyBackup, 'read_object', broken)
        refused(run_id, reason)
        assert not preview_gate.gate.inflight()
        assert_no_working_copy(root)
        monkeypatch.setattr(NativeLegacyBackup, 'read_object', too_big)        # the size bound is still just a fact about the file
        report = build(run_id)['report']
        device_source = next(item for item in report['sources'] if item['kind'] == 'device')
        assert device_source['storageLocation'] == {'present': True, 'readable': False, 'pending': None}
        monkeypatch.setattr(NativeLegacyBackup, 'read_object', real)
        assert next(item for item in build(run_id)['report']['sources'] if item['kind'] == 'device')['storageLocation']['readable'] is True
        assert snapshot(root, device) == settled
