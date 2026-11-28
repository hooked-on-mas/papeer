"""Read-only Notebook preview on the Native maintenance backup (synthetic, isolated data only).

The extraction -> HTTP wire path runs real SQLite and real files. The TypeScript projection and
rendering of the wire value are covered by the frontend tests, not here.
"""
import asyncio
import base64
from contextlib import closing
import gc
import hashlib
import json
import os
import socket
import sqlite3
import struct
import threading
import time
import urllib.error
import urllib.request
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn

from test_native_maintenance_entry import AUTH, PREFIX, runtime, start  # noqa: F401 - existing controlled-copy fixture
from papeer.core import notebook
from papeer.core.migrations.legacy_backup import BackupReadLimits, NativeLegacyBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from papeer.core.storage import Library
from sidecar import deps
from sidecar.app import app
from sidecar.lifecycle import instance
from sidecar.migrations import notebook_preview, preparation, preview_gate
from sidecar.routes import system

LIST = PREFIX + 'notebooks'
READ = PREFIX + 'notebook-preview'
WIRE_KEYS = {'libraryId', 'sourceDocumentId', 'entry', 'annotations', 'incomplete', 'bytesBase64', 'coverage', 'scope'}


@pytest.fixture(autouse=True)
def fresh_gate(monkeypatch):
    gate = preview_gate.PreviewGate()
    monkeypatch.setattr(preview_gate, 'gate', gate)
    yield gate
    assert gate.wait_idle(10), 'a preview worker thread outlived its test'


def make_notebook(root, title='Synthetic preview', *, ink=True, mark=True):
    library = Library(root)
    note = notebook.create(library, title, {})
    notebook.change(library, note, 1, 'append')
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        if ink:
            db.execute("INSERT INTO pdf_ink VALUES(?, 'original', 2, ?)",
                       (note, json.dumps([{'id': 'stroke', 'color': '#000000', 'width': .01, 'points': [[.1, .2], [.3, .4]]}])))
        if mark:
            db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
                       " VALUES(?,1,'original','synthetic','important','note',.2,.3,'note','','[]')", (note,))
        db.commit()
    return note


def settle(root, mode='DELETE'):
    """Fold the WAL into the main file so that the Library has no -wal/-shm companions."""
    gc.collect()
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        db.execute(f'PRAGMA journal_mode={mode}')
    gc.collect()


def tree_hashes(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob('*')) if path.is_file()}


def backup_root(root):
    return NativeLegacyBackup(root).root


def capture_live(client):
    run_id = start(client)['runId']
    assert preparation._current.wait(60)['state'] == 'captured'
    preparation._current._thread.join(10)
    return run_id


def to_cold(monkeypatch):
    """Finish the live owner as a normal shutdown does, then look at the durable state alone."""
    assert preparation.shutdown_wait(30)
    # A restarted process has neither the finished coordinator nor its reservation; the same
    # process keeps both until it exits, so the restart is simulated by dropping them.
    monkeypatch.setattr(preparation, '_current', None)
    monkeypatch.setattr(deps, '_maintenance_owner', None)
    assert instance.maintenance_owner() is None and not deps.maintenance_running()


def post(client, run_id, selector=None, headers=AUTH):
    if selector is None:
        return client.post(LIST, json={'runId': run_id}, headers=headers)
    return client.post(READ, json={'runId': run_id, 'selector': selector}, headers=headers)


def assert_blocked(response, reason, status=409):
    assert response.status_code == status, response.text
    assert response.json() == {'state': 'blocked', 'reason': reason, 'scope': 'native-notebook-preview-only'}
    assert response.headers['Cache-Control'] == 'no-store'


def untouched(root, original, objects):
    assert tree_hashes(root) == original
    assert tree_hashes(backup_root(root) / 'objects') == objects
    assert not list(backup_root(root).glob('.analysis-*'))


def held_list(monkeypatch, *, honor_cancel):
    """Replace the list reader with one that stays in flight until released."""
    entered, release = threading.Event(), threading.Event()

    def held(token):
        entered.set()
        if honor_cancel:
            token.cancel.wait(10)
        if not release.wait(15):
            raise ValueError('fixture-timeout')
        return {'selectors': [], 'scope': 'native-notebook-preview-only', 'limits': {}}

    monkeypatch.setattr(notebook_preview, 'list_notebooks', held)
    return entered, release


def assert_leases_held(owner):
    assert not owner._closed
    assert owner._device_lease is not None and owner._history_lease is not None
    assert owner._library_lock is not None and owner._library_lock.held


def hold_directly(gate, token):
    """Run a worker on the real gate thread that ignores cancellation until released."""
    entered, release = threading.Event(), threading.Event()

    def target(current):
        try:
            entered.set()
            release.wait(15)
        finally:
            preview_gate.gate.finish(current)

    return entered, release, gate.start(token, target)


# 1 ---------------------------------------------------------------------------------------
def test_live_nonempty_notebook_extract_to_http_wire(runtime):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root)
    settle(root)
    assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        assert post(client, run_id, headers={}).status_code == 401
        assert post(client, run_id, note, headers={}).status_code == 401
        listed = post(client, run_id)
        assert listed.status_code == 200 and listed.headers['Cache-Control'] == 'no-store'
        assert listed.json()['selectors'] == [note] and listed.json()['scope'] == 'native-notebook-preview-only'
        assert listed.json()['limits']['backupTotalBytes'] == 256 * 1024 * 1024
        response = post(client, run_id, note)
        assert response.status_code == 200 and response.headers['Cache-Control'] == 'no-store'
        value = response.json()
        assert set(value) == WIRE_KEYS and value['scope'] == 'native-notebook-preview-only'
        raw = base64.b64decode(value['bytesBase64'], validate=True)
        assert hashlib.sha256(raw).hexdigest() == value['entry']['sha256'] and len(raw) == value['entry']['byteLength']
        assert raw == (root / 'papers' / note / 'notebook.json').read_bytes()
        document = json.loads(raw)
        assert len(document['pages']) == 2
        assert value['sourceDocumentId'] == note and value['libraryId'] == preparation._current._library
        annotations = value['annotations']
        assert [item['pageId'] for item in annotations] == [page['id'] for page in document['pages']]
        assert annotations[0]['ink'] == [] and len(annotations[0]['bookmarks']) == 1
        assert len(annotations[1]['ink']) == 1 and annotations[1]['bookmarks'] == []
        assert annotations[0]['bookmarks'][0]['kind'] == 'note' and annotations[0]['bookmarks'][0]['label'] == 'important'
        assert value['coverage'] == {'pageRows': 2, 'inkRows': 1, 'bookmarkRows': 1}
        assert 'page-text-not-converted' in value['incomplete'] and 'original-pdf-fidelity-unverified' in value['incomplete']
        # Nothing about the backup or the filesystem is disclosed.
        assert 'pageText' not in response.text and 'backupId' not in response.text and str(root) not in response.text
        untouched(root, original, objects)


# 2 ---------------------------------------------------------------------------------------
def test_cold_artifacts_verified_preview(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root)
    settle(root)
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        to_cold(monkeypatch)
        state = client.post(PREFIX + 'status', json={}, headers=AUTH).json()
        assert (state['state'], state['phase'], state['runId']) == ('recovery-required', 'artifacts-verified', run_id)
        listed = post(client, run_id)
        assert listed.status_code == 200 and listed.json()['selectors'] == [note]
        response = post(client, run_id, note)
        assert response.status_code == 200 and set(response.json()) == WIRE_KEYS
        assert response.json()['coverage'] == {'pageRows': 2, 'inkRows': 1, 'bookmarkRows': 1}
        untouched(root, original, objects)


# 3 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize('tamper', ['storage-location', 'hold-removed', 'input-set-rewritten', 'cancel-intent', 'peer-input-missing'])
def test_cold_classifier_mismatch_refuses(runtime, monkeypatch, tamper):  # noqa: F811
    root, device, _lock = runtime
    note = make_notebook(root)
    settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        record = NativePreparationJournal(root).read()
        to_cold(monkeypatch)
        if tamper == 'storage-location':
            (device / 'storage-location.json').write_text(json.dumps({'path': str(root)}), encoding='utf8')
        elif tamper == 'hold-removed':
            NativeLegacyStartup(root).path.unlink()
        elif tamper == 'input-set-rewritten':
            path = NativeLegacyInputs(root).root / (run_id + '.json')
            value = json.loads(path.read_text('utf8')); value['catalog']['identity']['libraryId'] = str(uuid4())
            path.write_text(json.dumps(value), encoding='utf8')
        elif tamper == 'cancel-intent':
            NativePreparationJournal(root).mark(record, 'cancel-intent')
        elif tamper == 'peer-input-missing':
            (NativeLegacyInputs(root).root / (run_id + '.json')).unlink()
        assert_blocked(post(client, run_id), 'preview-unavailable')
        assert_blocked(post(client, run_id, note), 'preview-unavailable')
        assert not list(backup_root(root).glob('.analysis-*'))


# 4 ---------------------------------------------------------------------------------------
def test_selector_and_body_shape(runtime):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root)
    settle(root)
    json_header = {**AUTH, 'Content-Type': 'application/json'}
    with TestClient(app) as client:
        run_id = capture_live(client)
        assert_blocked(post(client, run_id, '0' * 32), 'preview-unavailable')
        assert_blocked(post(client, str(uuid4())), 'preview-unavailable')
        assert_blocked(post(client, str(uuid4()), note), 'preview-unavailable')
        bad = [
            (LIST, {'runId': run_id, 'extra': 1}),
            (LIST, {'runId': run_id, 'selector': note}),
            (LIST, {'runId': 'not-a-secret-run'}),
            (LIST, {'runId': 5}),
            (LIST, []),
            (READ, {'runId': run_id}),
            (READ, {'runId': run_id, 'selector': note[:31]}),
            (READ, {'runId': run_id, 'selector': note.upper()}),
            (READ, {'runId': run_id, 'selector': 'g' * 32}),
            (READ, {'runId': run_id, 'selector': note, 'extra': 1}),
            (READ, {'runId': run_id, 'selector': 7}),
        ]
        for url, body in bad:
            response = client.post(url, content=json.dumps(body), headers=json_header)
            assert response.status_code == 422, (url, body, response.text)
            assert 'not-a-secret-run' not in response.text
        oversized = json.dumps({'runId': run_id, 'pad': 'x' * 2000})
        assert client.post(LIST, content=oversized, headers=json_header).status_code == 422
        assert client.post(LIST, content=b'{not json', headers=json_header).status_code == 422
        # The well-formed request still works afterwards and the gate was never left busy.
        assert post(client, run_id).status_code == 200 and not preview_gate.gate.inflight()


# 5 ---------------------------------------------------------------------------------------
@pytest.mark.parametrize('name,value,call', [
    ('LIMITS', BackupReadLimits(metadata_bytes=8 * 1024 * 1024, entries=10_000, total_bytes=0), 'list'),
    ('LIMITS', BackupReadLimits(metadata_bytes=8 * 1024 * 1024, entries=1, total_bytes=256 * 1024 * 1024), 'list'),
    ('LIMITS', BackupReadLimits(metadata_bytes=8 * 1024 * 1024, entries=10_000, total_bytes=0), 'read'),
    ('MAX_NOTEBOOKS', 0, 'list'),
    ('MAX_PAGES', 1, 'read'),
    ('MAX_ANNOTATION_ROWS', 1, 'read'),
    ('MAX_NOTEBOOK_BYTES', 10, 'read'),
    ('MAX_PROJECTION_BYTES', 10, 'read'),
    ('MAX_RESPONSE', 100, 'read'),
])
def test_capacity_limits(runtime, monkeypatch, name, value, call):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root)
    settle(root)
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        if name == 'LIMITS' and value.total_bytes == 0 and call == 'read':
            # List first under the real limits, then lower them for the read only.
            assert post(client, run_id).status_code == 200
        monkeypatch.setattr(notebook_preview, name, value)
        response = post(client, run_id) if call == 'list' else post(client, run_id, note)
        assert_blocked(response, 'preview-capacity-exceeded')
        untouched(root, original, objects)
        assert not preview_gate.gate.inflight()


@pytest.mark.parametrize('name,value', [
    ('LIMITS', BackupReadLimits(metadata_bytes=8 * 1024 * 1024, entries=10_000, total_bytes=0)),
    ('LIMITS', BackupReadLimits(metadata_bytes=8 * 1024 * 1024, entries=1, total_bytes=256 * 1024 * 1024)),
    ('LIMITS', BackupReadLimits(metadata_bytes=16, entries=10_000, total_bytes=256 * 1024 * 1024)),
    ('MAX_NOTEBOOKS', 0),
])
def test_cold_capacity_limits(runtime, monkeypatch, name, value):  # noqa: F811
    """r153 review: a cold backup over the limit is reported as capacity, not as 'unavailable'."""
    root, _device, _lock = runtime
    note = make_notebook(root)
    settle(root)
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        to_cold(monkeypatch)
        assert post(client, run_id).status_code == 200, 'under the real limits the cold list works'
        monkeypatch.setattr(notebook_preview, name, value)
        assert_blocked(post(client, run_id), 'preview-capacity-exceeded')
        assert_blocked(post(client, run_id, note), 'preview-capacity-exceeded')
        untouched(root, original, objects)
        assert not preview_gate.gate.inflight()


def test_limit_overrun_is_raised_only_when_limits_are_given(runtime):  # noqa: F811
    """The default classification (status/start/recover) is unchanged; only a caller passing limits sees the overrun."""
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        default = preparation._durable_recovery_status()
        assert default['runId'] == run_id and default['state'] in ('recovery-required', 'captured', 'cancelled')
        zero = BackupReadLimits(metadata_bytes=8 * 1024 * 1024, entries=10_000, total_bytes=0)
        with pytest.raises(ValueError, match='^backup-read-limit$'):
            preparation._durable_recovery_status(limits=zero)


# 6 ---------------------------------------------------------------------------------------
def test_unsupported_notebook_entries_block_only_that_notebook(runtime):  # noqa: F811
    root, _device, _lock = runtime
    good = make_notebook(root, 'Good')
    bad_json = make_notebook(root, 'Malformed json', ink=False, mark=False)
    missing_rows = make_notebook(root, 'Missing rows', ink=False, mark=False)
    (root / 'papers' / bad_json / 'notebook.json').write_text('{"version": 1}', encoding='utf8')
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
        db.execute('DELETE FROM pages WHERE paper_id=? AND number=2', (missing_rows,)); db.commit()
    settle(root)
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        listed = post(client, run_id)
        assert listed.status_code == 200 and listed.json()['selectors'] == sorted([good, bad_json, missing_rows])
        assert post(client, run_id, good).status_code == 200
        assert_blocked(post(client, run_id, bad_json), 'preview-unavailable')
        assert_blocked(post(client, run_id, missing_rows), 'preview-unavailable')
        assert post(client, run_id, good).status_code == 200, 'a refused notebook leaves the others readable'
        untouched(root, original, objects)


@pytest.mark.parametrize('damage', ['schema-version', 'wal-incomplete'])
def test_unsupported_library_blocks_the_read_not_the_list(runtime, damage):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root)
    if damage == 'schema-version':
        settle(root)
        with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
            db.execute('PRAGMA user_version=8')
    else:
        # B7-a (decision J5): neither companion is a database closed normally and is read (the test below). A WAL database with
        # exactly one companion has lost part of its state: header 2 and a -wal without a -shm.
        settle(root, 'WAL')
        assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
        (root / 'library.sqlite3-wal').write_bytes(b'synthetic stray wal')
    gc.collect()
    with TestClient(app) as client:
        run_id = capture_live(client)
        assert post(client, run_id).json()['selectors'] == [note]
        assert_blocked(post(client, run_id, note), 'preview-unavailable')
        assert not list(backup_root(root).glob('.analysis-*'))


def test_a_cleanly_closed_wal_library_is_read_by_the_preview(runtime):  # noqa: F811
    """B7-a, decision J5 (a behavior change of this route, on purpose): header 2 and neither -wal nor -shm is what the app leaves
    after it exits, and the same read that used to be refused as `preview-unavailable` now succeeds, with the source and the
    backup objects byte for byte unchanged."""
    root, _device, _lock = runtime
    note = make_notebook(root)
    settle(root, 'WAL')
    assert not (root / 'library.sqlite3-wal').exists() and not (root / 'library.sqlite3-shm').exists()
    assert (root / 'library.sqlite3').read_bytes()[18:20] == b''
    original = tree_hashes(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        assert post(client, run_id).json()['selectors'] == [note]
        response = post(client, run_id, note)
        assert response.status_code == 200 and response.headers['Cache-Control'] == 'no-store'
        assert response.json()['scope'] == 'native-notebook-preview-only'
        untouched(root, original, objects)


# 7 ---------------------------------------------------------------------------------------
def test_busy_single_flight(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    entered, release = held_list(monkeypatch, honor_cancel=False)
    results = []
    with TestClient(app) as client:
        run_id = capture_live(client)
        worker = threading.Thread(target=lambda: results.append(post(client, run_id)))
        worker.start()
        try:
            assert entered.wait(10)
            assert_blocked(post(client, run_id), 'preview-busy')
            assert_blocked(post(client, run_id, '1' * 32), 'preview-busy')
            assert preview_gate.gate.inflight()
        finally:
            release.set(); worker.join(10)
        assert not worker.is_alive() and results[0].status_code == 200
        assert preview_gate.gate.wait_idle(5)
        assert post(client, run_id).status_code == 200


# 8 ---------------------------------------------------------------------------------------
def test_cancel_inside_analysis_copy(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root); settle(root)
    original = tree_hashes(root)
    calls = []
    real = NativeLegacyBackup._object

    def cancelling(self, entry, **kwargs):
        calls.append(entry['sha256'])
        if len(calls) == 2:
            preview_gate.gate._token.cancel.set()  # the running preview's own token
        return real(self, entry, **kwargs)

    with TestClient(app) as client:
        run_id = capture_live(client)
        objects = tree_hashes(backup_root(root) / 'objects')
        monkeypatch.setattr(NativeLegacyBackup, '_object', cancelling)
        response = post(client, run_id, note)
        monkeypatch.setattr(NativeLegacyBackup, '_object', real)
        assert len(calls) >= 2, 'the cancel point was never reached inside analysis_copy'
        assert_blocked(response, 'preview-cancelled')
        assert preview_gate.gate.wait_idle(5) and not preview_gate.gate.inflight()
        untouched(root, original, objects)
        assert post(client, run_id, note).status_code == 200, 'a cancelled preview does not poison the next one'


# 9 ---------------------------------------------------------------------------------------
def test_shutdown_during_preview_sticky(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    entered, release = held_list(monkeypatch, honor_cancel=True)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .05)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .05)
    exited = threading.Event(); monkeypatch.setattr(system, 'exit_process', exited.set)
    results = []
    with TestClient(app) as client:
        run_id = capture_live(client)
        worker = threading.Thread(target=lambda: results.append(post(client, run_id)))
        worker.start()
        try:
            assert entered.wait(10)
            token = preview_gate.gate._token
            reply = client.post('/shutdown', headers=AUTH)
            assert reply.status_code == 200 and reply.json()['status'] == 'pending' and reply.json()['stopped'] is False
            assert token.cancel.is_set() and preview_gate.gate.closed
            assert not exited.wait(.7), 'the process must stay while the reader thread is alive'
            assert_blocked(post(client, run_id), 'preview-shutdown-pending')
            assert client.post('/shutdown', headers=AUTH).json()['status'] == 'pending'
            release.set(); worker.join(10)
            assert not worker.is_alive() and preview_gate.gate.wait_idle(5)
            reply = client.post('/shutdown', headers=AUTH)
            assert reply.json()['status'] == 'shutting down' and reply.json()['stopped'] is True
            assert exited.wait(5)
            # Sticky: even with the previous preview gone, no new one is ever admitted.
            assert_blocked(post(client, run_id), 'preview-shutdown-pending')
            assert_blocked(post(client, run_id, '2' * 32), 'preview-shutdown-pending')
        finally:
            release.set(); worker.join(10)


# 10 --------------------------------------------------------------------------------------
def test_shutdown_preview_stuck_keeps_owner(runtime, monkeypatch):  # noqa: F811
    root, _device, lock = runtime
    make_notebook(root); settle(root)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .05)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .05)
    with TestClient(app) as client:
        run_id = capture_live(client)
        owner = preparation._current
        released = []
        real_wait = owner.shutdown_wait
        monkeypatch.setattr(owner, 'shutdown_wait', lambda timeout: released.append(timeout) or real_wait(timeout))
        token = preparation.admit_preview(run_id)
        entered, release, _future = hold_directly(preview_gate.gate, token)
        try:
            assert entered.wait(10)
            _cancelled, stopped = system.stop_work()
            assert stopped is False and released == [], 'maintenance.shutdown_wait must not run with a live reader'
            assert instance.maintenance_owner() is owner and lock.held and not owner._closed
            assert owner._device_lease is not None and owner._history_lease is not None
            assert token.cancel.is_set() and preview_gate.gate.closed and preview_gate.gate.inflight()
        finally:
            release.set()
        assert preview_gate.gate.wait_idle(10)
        _cancelled, stopped = system.stop_work()
        assert stopped is True and len(released) == 1


# 11 --------------------------------------------------------------------------------------
def test_stdin_exit_waits_for_preview(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .05)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .05)
    exit_called, observed = threading.Event(), []
    monkeypatch.setattr(system, 'exit_process', lambda: observed.append(preview_gate.gate.inflight()) or exit_called.set())
    with TestClient(app) as client:
        run_id = capture_live(client)
        owner = preparation._current
        token = preparation.admit_preview(run_id)
        entered, release, _future = hold_directly(preview_gate.gate, token)
        read_end, write_end = os.pipe()
        watcher = threading.Thread(target=system.watch_stdin, args=(read_end,))
        try:
            assert entered.wait(10)
            watcher.start(); os.close(write_end); write_end = None
            assert not exit_called.wait(1.0), 'exit was attempted while the preview thread still ran'
            assert preview_gate.gate.inflight() and token.cancel.is_set()
            assert_leases_held(owner)  # r153 review: the reader's backup must not lose its leases
            release.set()
            assert exit_called.wait(20)
            watcher.join(10)
            assert not watcher.is_alive() and observed == [False]
            assert owner._closed and owner._device_lease is None and owner._history_lease is None, 'released only afterwards'
        finally:
            release.set()
            if write_end is not None: os.close(write_end)
            if watcher.ident is not None: watcher.join(15)
            os.close(read_end)


def test_lifespan_wait_waits_for_preview_before_releasing_leases(runtime):  # noqa: F811
    """The ASGI lifespan path (preparation.wait_for_shutdown) closes the gate and waits for the reader first."""
    root, _device, lock = runtime
    make_notebook(root); settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        owner = preparation._current
        token = preparation.admit_preview(run_id)
        entered, release, _future = hold_directly(preview_gate.gate, token)
        waiter = threading.Thread(target=preparation.wait_for_shutdown)
        try:
            assert entered.wait(10)
            waiter.start()
            waiter.join(1.0)
            assert waiter.is_alive(), 'the lifespan wait ended while the preview thread still ran'
            assert preview_gate.gate.closed and token.cancel.is_set() and preview_gate.gate.inflight()
            assert_leases_held(owner)
            assert lock.held and instance.maintenance_owner() is owner
        finally:
            release.set()
            waiter.join(20)
        assert not waiter.is_alive() and not preview_gate.gate.inflight()
        assert owner._closed and owner._device_lease is None and owner._history_lease is None
        assert_blocked(post(client, owner._run), 'preview-shutdown-pending')


# 12 --------------------------------------------------------------------------------------
def test_recover_and_abandon_refused_while_preview(runtime):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        token = preparation.admit_preview(run_id)
        entered, release, _future = hold_directly(preview_gate.gate, token)
        try:
            assert entered.wait(10)
            for action in ('resume', 'abandon'):
                reply = client.post(PREFIX + action, json={'runId': run_id}, headers=AUTH)
                assert reply.status_code == 409 and reply.json()['reason'] == 'maintenance-recovery-unavailable'
            assert preparation._current.status()['state'] == 'captured'
        finally:
            release.set()
        assert preview_gate.gate.wait_idle(10)
        reply = client.post(PREFIX + 'abandon', json={'runId': run_id}, headers=AUTH)
        assert reply.status_code == 202 and reply.json()['state'] == 'cancelled'


def test_start_refused_while_cold_preview(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        token = preparation.admit_preview(run_id)
        entered, release, _future = hold_directly(preview_gate.gate, token)
        try:
            assert entered.wait(10)
            reply = client.post(PREFIX + 'start', json={}, headers=AUTH)
            assert reply.status_code == 409 and preparation._current is None
            reply = client.post(PREFIX + 'resume', json={'runId': run_id}, headers=AUTH)
            assert reply.status_code == 409 and preparation._current is None
        finally:
            release.set()
        assert preview_gate.gate.wait_idle(10)


# 13 --------------------------------------------------------------------------------------
@pytest.mark.parametrize('change,reason', [('owner-replaced', 'preview-unavailable'), ('state-changed', 'preview-unavailable'),
                                           ('cancelled', 'preview-cancelled'), ('gate-closed', 'preview-cancelled'),
                                           ('owner-closed', 'preview-unavailable'), ('lease-released', 'preview-unavailable')])
def test_abandon_after_admission_discards_result(runtime, monkeypatch, change, reason):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root); settle(root)
    real = notebook_preview.notebook_projection_input
    owner_state = {}

    def then_change(*args, **kwargs):
        value = real(*args, **kwargs)  # a complete, valid extraction ...
        token = preview_gate.gate._token
        if change == 'owner-replaced':
            monkeypatch.setattr(preparation, '_current', None)
        elif change == 'state-changed':
            owner_state['owner'] = token.owner; owner_state['state'] = token.owner._state
            token.owner._state = 'failed'
        elif change == 'cancelled':
            token.cancel.set()
        elif change == 'owner-closed':
            owner_state['owner'] = token.owner; owner_state['state'] = token.owner._state
            owner_state['restore'] = lambda owner=token.owner: setattr(owner, '_closed', False)
            token.owner._closed = True
        elif change == 'lease-released':
            lease = token.owner._device_lease
            owner_state['owner'] = token.owner; owner_state['state'] = token.owner._state
            owner_state['restore'] = lambda owner=token.owner: setattr(owner, '_device_lease', lease)
            token.owner._device_lease = None
        else:
            preview_gate.gate.close()
        return value  # ... whose result must still be discarded

    with TestClient(app) as client:
        run_id = capture_live(client)
        monkeypatch.setattr(notebook_preview, 'notebook_projection_input', then_change)
        try:
            response = post(client, run_id, note)
        finally:
            if owner_state:
                owner_state['owner']._state = owner_state['state']
                if 'restore' in owner_state: owner_state['restore']()
        assert_blocked(response, reason)
        assert 'bytesBase64' not in response.text


# 14 --------------------------------------------------------------------------------------
@pytest.mark.parametrize('error', [OSError(2, 'secret-os-text C:\\private\\library.sqlite3'),
                                   ValueError('secret-value-text C:\\private\\path'),
                                   sqlite3.DatabaseError('secret-sqlite-text C:\\private\\db'),
                                   RecursionError('secret-recursion-text')])
def test_error_sanitized(runtime, monkeypatch, error):  # noqa: F811
    root, _device, _lock = runtime
    note = make_notebook(root); settle(root)

    def failing(*args, **kwargs):
        raise error

    with TestClient(app) as client:
        run_id = capture_live(client)
        monkeypatch.setattr(notebook_preview, 'notebook_projection_input', failing)
        response = post(client, run_id, note)
        assert_blocked(response, 'preview-unavailable')
        assert 'secret' not in response.text and 'private' not in response.text and str(root) not in response.text
        monkeypatch.setattr(notebook_preview, 'list_notebooks', failing)
        response = post(client, run_id)
        assert_blocked(response, 'preview-unavailable')
        assert 'secret' not in response.text and not preview_gate.gate.inflight()


def test_blocked_reason_table():
    mapping = {'preview-busy': 'preview-busy', 'preview-shutdown-pending': 'preview-shutdown-pending',
               'backup-read-cancelled': 'preview-cancelled', 'preview-cancelled': 'preview-cancelled',
               'backup-read-limit': 'preview-capacity-exceeded', 'legacy-notebook-read-limit': 'preview-capacity-exceeded',
               'preview-capacity-exceeded': 'preview-capacity-exceeded', 'preview-response-capacity-exceeded': 'preview-capacity-exceeded',
               'preview-notebook-capacity-exceeded': 'preview-capacity-exceeded', 'anything else': 'preview-unavailable'}
    for text, reason in mapping.items():
        assert notebook_preview.blocked_reason(ValueError(text)) == reason
    for error in (OSError('x'), RecursionError(), sqlite3.Error('x')):
        assert notebook_preview.blocked_reason(error) == 'preview-unavailable'
    assert set(mapping.values()) <= set(notebook_preview.BLOCKED_REASONS)


def test_gate_contract():
    gate = preview_gate.PreviewGate()
    token = gate.admit('run', 'cold', None)
    with pytest.raises(ValueError, match='^preview-busy$'):
        gate.admit('run', 'cold', None)
    assert gate.inflight() and not gate.wait_idle(.05)
    gate.close()
    assert token.cancel.is_set()
    with pytest.raises(ValueError, match='^preview-shutdown-pending$'):
        gate.admit('run', 'cold', None)
    gate.finish(token); gate.finish(token)
    assert not gate.inflight() and gate.wait_idle(.05) and gate.closed
    with pytest.raises(ValueError, match='^preview-shutdown-pending$'):
        gate.admit('run', 'live', None)


# Client disconnect reaches the worker (r153 B3a) ---------------------------------------------
def cancellable_list(monkeypatch):
    """A list reader that stays in flight until cancelled; afterwards it answers at once (mode['quick'])."""
    entered, cancelled, mode = threading.Event(), threading.Event(), {'quick': False}

    def reader(token):
        if mode['quick']:
            return {'selectors': [], 'scope': 'native-notebook-preview-only', 'limits': {}}
        entered.set()
        if token.cancel.wait(10):
            mode['cancelled_at'] = time.monotonic()
            cancelled.set()
            raise ValueError('preview-cancelled')
        raise ValueError('fixture-timeout')

    monkeypatch.setattr(notebook_preview, 'list_notebooks', reader)
    return entered, cancelled, mode


def release_worker(mode):
    """Whatever the test found, let a still-running fixture worker end at once (and answer quickly afterwards)."""
    mode['quick'] = True
    token = preview_gate.gate._token
    if token is not None:
        token.cancel.set()


def test_no_base_http_middleware():
    """BaseHTTPMiddleware wraps receive so request.is_disconnected() never sees the client leave (r153 B3)."""
    found = [m for m in app.user_middleware if m.cls is BaseHTTPMiddleware]
    assert not found, ('a BaseHTTPMiddleware (@app.middleware("http")) makes request.is_disconnected() always False, '
                       'so a cancelled Notebook preview would keep reading (r153 B3): ' + repr(found))


def test_client_disconnect_cancels_preview_in_process(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        entered, cancelled, mode = cancellable_list(monkeypatch)
        body = json.dumps({'runId': run_id}).encode()
        sent, calls = [], []

        async def receive():
            calls.append(1)
            if len(calls) == 1:
                return {'type': 'http.request', 'body': body, 'more_body': False}
            if entered.is_set():
                return {'type': 'http.disconnect'}  # not awaited: is_disconnected() reads it inside a cancelled scope
            await asyncio.Event().wait()

        async def send(message):
            sent.append(message)

        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST', 'scheme': 'http',
                 'path': LIST, 'raw_path': LIST.encode(), 'query_string': b'', 'root_path': '',
                 'headers': [(b'host', b'127.0.0.1'), (b'authorization', b'Bearer native-maintenance-fixture'),
                             (b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())],
                 'client': ('127.0.0.1', 50000), 'server': ('127.0.0.1', 8000)}
        started = time.monotonic()
        try:
            asyncio.run(asyncio.wait_for(app(scope, receive, send), 3))
        finally:
            release_worker(mode)
        assert time.monotonic() - started < 3
        assert cancelled.wait(2), 'the client left but the preview worker was never cancelled'
        start = next(m for m in sent if m['type'] == 'http.response.start')
        headers = {key.decode().lower(): value.decode() for key, value in start['headers']}
        assert start['status'] == 409 and headers['cache-control'] == 'no-store'
        assert json.loads(b''.join(m.get('body', b'') for m in sent if m['type'] == 'http.response.body'))['reason'] == 'preview-cancelled'
        assert preview_gate.gate.wait_idle(5)
        assert post(client, run_id).status_code == 200, 'a new preview must be possible right after the cancel'


@pytest.mark.parametrize('http_impl,close', [('httptools', 'fin'), ('h11', 'rst')])
def test_client_disconnect_cancels_preview_over_uvicorn(runtime, monkeypatch, record_property, http_impl, close):  # noqa: F811
    root, _device, _lock = runtime
    make_notebook(root); settle(root)
    with TestClient(app) as client:
        run_id = capture_live(client)
        entered, cancelled, mode = cancellable_list(monkeypatch)
        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(16)
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off', http=http_impl))
        worker = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True); worker.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and worker.is_alive() and time.monotonic() < deadline: time.sleep(.02)
            assert server.started
            body = json.dumps({'runId': run_id}).encode()
            request = (f'POST {LIST} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {AUTH["Authorization"]}\r\n'
                       f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n').encode() + body
            raw = socket.create_connection(('127.0.0.1', port), timeout=10)
            raw.sendall(request)
            assert entered.wait(10), 'the request never reached the preview worker'
            if close == 'rst':
                raw.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            closed_at = time.monotonic()
            raw.close()
            try:
                assert cancelled.wait(2), f'the client left ({http_impl}, {close}) but the preview worker was never cancelled'
            finally:
                release_worker(mode)
            record_property('cancel_delay_seconds', round(mode['cancelled_at'] - closed_at, 3))
            busy, status = 0, None
            retry_until = time.monotonic() + 3
            while time.monotonic() < retry_until:
                call = urllib.request.Request(f'http://127.0.0.1:{port}{LIST}', data=json.dumps({'runId': run_id}).encode(), method='POST',
                                              headers={**AUTH, 'Content-Type': 'application/json'})
                try:
                    with urllib.request.urlopen(call, timeout=5) as reply:
                        status = reply.status
                        break
                except urllib.error.HTTPError as error:
                    assert error.code == 409 and json.loads(error.read())['reason'] == 'preview-busy'
                    busy += 1
                    time.sleep(.1)
            record_property('busy_before_new_preview', busy)
            assert status == 200, 'a new preview must be possible within 3 seconds of the cancel'
        finally:
            server.should_exit = True; worker.join(10); listener.close()
            assert not worker.is_alive()
