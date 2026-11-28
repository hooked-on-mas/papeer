"""Actual isolated Native owner and SQLite paths; no real profile is touched."""
from copy import deepcopy
import threading
import json
import os
import subprocess
import sys
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from fastapi.routing import APIRoute

from test_native_maintenance_entry import runtime  # noqa: F401 - existing controlled-copy fixture
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import NativeLegacyStartup, legacy_startup_allowed
from sidecar.app import app
from sidecar.migrations import census, preparation
from papeer.core.migrations.legacy_backup import NativeLegacyBackup


def seeded(root, phase):
    owner = preparation.NativePreparation(census.select_current())
    sources = owner._sources()
    record = {'version': 1, 'runId': owner._run, 'peerId': owner._peer, 'libraryId': owner._library,
              'sources': [deepcopy(source.store.source) for source in sources], 'backupIds': list(owner._backup_ids),
              'selectionSha256': preparation._selection_digest(owner._selection),
              'policy': 'native-local-capture-only-v1'}
    NativePreparationJournal(root).begin(record)
    if phase != 'not-collected': NativeLegacyStartup(root).hold({'version': 1, 'runId': owner._run})
    if phase in ('partial', 'artifacts-verified'):
        plans = [source.inventory(identity) for source, identity in zip(sources, owner._backup_ids, strict=True)]
        ordered = sorted(zip(sources, plans, strict=True), key=lambda pair: (pair[1]['manifest']['source']['kind'], pair[1]['manifest']['source']['id']))
        value = {'catalog': {'version': 1, 'runId': owner._run,
                             'identity': {'accountId': 'controlled-copy-local', 'libraryId': owner._library},
                             'peers': [{'id': owner._peer, 'sources': [deepcopy(plan['manifest']['source']) for _, plan in ordered]}]},
                 'inputs': [{'peerId': owner._peer, 'plan': deepcopy(plan)} for _, plan in ordered]}
        NativeLegacyInputs(root).prepare(value)
        for source, plan in ordered[:1 if phase == 'partial' else 3]: source.capture(plan)
    return record


def test_actual_asgi_shutdown_retains_held_worker_until_drained(runtime, monkeypatch):  # noqa: F811
    from sidecar.routes import system
    root, _device, _lock = runtime
    record = seeded(root, 'hold-only')
    entered, release = threading.Event(), threading.Event()
    original = NativeLegacyBackup.capture
    def held(self, plan):
        entered.set()
        if not release.wait(15): raise ValueError('fixture-timeout')
        return original(self, plan)
    monkeypatch.setattr(NativeLegacyBackup, 'capture', held)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', 0.01)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', 0.01)
    exits = threading.Event()
    monkeypatch.setattr(system, 'exit_process', exits.set)
    preparation.recover(record['runId'], 'capture')
    try:
        assert entered.wait(10)
        with TestClient(app) as client:
            headers = {'Authorization': 'Bearer native-maintenance-fixture'}
            response = client.post('/shutdown', headers=headers)
            assert response.status_code == 200 and response.json()['status'] == 'pending' and response.json()['stopped'] is False
            assert not exits.is_set()
            release.set()
            assert preparation._current.wait(10)['state'] == 'captured'
            preparation._current._thread.join(10)
            response = client.post('/shutdown', headers=headers)
            assert response.status_code == 200 and response.json()['stopped'] is True
            assert exits.wait(3)
    finally:
        release.set()


def test_stdin_close_waits_for_real_preparation_worker_before_exit(runtime, monkeypatch):  # noqa: F811
    from sidecar.routes import system
    root, _device, _lock = runtime
    record = seeded(root, 'hold-only')
    entered, release, exit_called = threading.Event(), threading.Event(), threading.Event()
    original = NativeLegacyBackup.capture

    def held(self, plan):
        entered.set()
        if not release.wait(15): raise ValueError('fixture-timeout')
        return original(self, plan)

    monkeypatch.setattr(NativeLegacyBackup, 'capture', held)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', 0.01)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', 0.01)
    monkeypatch.setattr(system, 'exit_process', exit_called.set)
    preparation.recover(record['runId'], 'capture')
    read_end, write_end = os.pipe()
    watcher = threading.Thread(target=system.watch_stdin, args=(read_end,))
    try:
        assert entered.wait(10)
        watcher.start(); os.close(write_end); write_end = None
        assert not exit_called.wait(.5)
        assert preparation._current._thread.is_alive()
        release.set()
        assert exit_called.wait(15)
        watcher.join(10)
        assert not watcher.is_alive()
    finally:
        release.set()
        if write_end is not None: os.close(write_end)
        if watcher.ident is not None: watcher.join(15)
        os.close(read_end)


@pytest.mark.parametrize('phase', ['not-collected', 'hold-only', 'partial', 'artifacts-verified'])
def test_cold_evidence_is_classified_without_claiming_live_fences(runtime, phase):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, phase)
    observed = preparation.status()
    assert observed['state'] == 'recovery-required' and observed['phase'] == phase
    assert observed['runId'] == value['runId'] and not legacy_startup_allowed(root)
    assert preparation._current is None


def test_unknown_hold_and_corrupt_record_are_readonly_and_fail_closed(runtime):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'hold-only')
    NativePreparationJournal(root).active.write_text('{', 'utf8')
    result = preparation.status()
    assert result['state'] == 'recovery-required' and result['failure'] == 'maintenance-durable-state-unreadable'
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}
    assert not legacy_startup_allowed(root)
    with pytest.raises(ValueError): preparation.recover(value['runId'], 'cancel')


def test_stale_run_and_live_worker_refuse_abandon(runtime):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'hold-only')
    with pytest.raises(ValueError): preparation.recover(str(uuid4()), 'cancel')
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}


def test_interrupted_cancel_reacquires_owner_and_keeps_artifacts(runtime):  # noqa: F811
    root, _device, _lock = runtime; original = root / 'legacy-data'; original.write_bytes(b'preserve')
    value = seeded(root, 'hold-only'); journal = NativePreparationJournal(root)
    journal.mark(value, 'cancel-intent')
    assert preparation.status()['phase'] == 'cancel-interrupted'
    result = preparation.recover(value['runId'], 'cancel'); assert result['state'] == 'running'
    assert preparation._current.wait(20)['state'] == 'cancelled'
    assert NativeLegacyStartup(root).read() is None and journal.event(value['runId'], 'cancel-complete')
    assert original.read_bytes() == b'preserve'
    assert preparation.status()['phase'] == 'restart-required'
    assert preparation.recover(value['runId'], 'cancel')['state'] == 'cancelled'


def test_foreign_hold_never_clears_or_reuses_another_run(runtime):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'not-collected')
    other = str(uuid4()); NativeLegacyStartup(root).hold({'version': 1, 'runId': other})
    assert preparation.status()['failure'] == 'maintenance-durable-state-unreadable'
    with pytest.raises(ValueError): preparation.recover(value['runId'], 'cancel')
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': other}


def test_recovery_requires_a_fresh_actual_library_lock(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'hold-only')
    monkeypatch.setattr('sidecar.lifecycle.instance.owns_library_lock', lambda *_: False)
    with pytest.raises(ValueError): preparation.recover(value['runId'], 'cancel')
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}


def test_stale_selection_digest_cannot_resume_or_clear_hold(runtime):  # noqa: F811
    root, _device, _lock = runtime; owner = preparation.NativePreparation(census.select_current()); sources = owner._sources()
    value = {'version': 1, 'runId': owner._run, 'peerId': owner._peer, 'libraryId': owner._library,
             'sources': [deepcopy(source.store.source) for source in sources], 'backupIds': list(owner._backup_ids),
             'selectionSha256': '0' * 64, 'policy': 'native-local-capture-only-v1'}
    NativePreparationJournal(root).begin(value); NativeLegacyStartup(root).hold({'version': 1, 'runId': value['runId']})
    assert preparation.status()['failure'] == 'maintenance-durable-state-unreadable'
    with pytest.raises(ValueError): preparation.recover(value['runId'], 'cancel')
    assert preparation._current is None
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}


@pytest.mark.parametrize('phase', ['not-collected', 'hold-only', 'partial', 'artifacts-verified'])
def test_cold_status_refuses_changed_location_binding_without_releasing_hold(runtime, phase):  # noqa: F811
    root, device, _lock = runtime
    value = seeded(root, phase)
    # The selected folder remains the same, but the device selection evidence changed.
    (device / 'storage-location.json').write_text(json.dumps({'path': str(root)}), encoding='utf8')
    result = preparation.status()
    assert result['state'] == 'recovery-required'
    assert result['failure'] == 'maintenance-durable-state-unreadable'
    assert result['runId'] == value['runId']
    with pytest.raises(ValueError): preparation.recover(value['runId'], 'capture')
    with pytest.raises(ValueError): preparation.recover(value['runId'], 'cancel')
    expected_hold = None if phase == 'not-collected' else {'version': 1, 'runId': value['runId']}
    assert NativeLegacyStartup(root).read() == expected_hold
    assert preparation._current is None


def test_cold_status_verifies_backup_without_loading_bodies_into_memory(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    (root / 'legacy-content').write_bytes(b'original backup content')
    value = seeded(root, 'artifacts-verified')
    def reject_full_body(*_args, **_kwargs):
        raise AssertionError('recovery status must not materialize complete backup bodies')
    monkeypatch.setattr(NativeLegacyBackup, 'object', reject_full_body)
    assert preparation.status()['phase'] == 'artifacts-verified'
    backup = NativeLegacyBackup(root)
    manifest = backup.store.reference(value['backupIds'][0])
    entry = next(item for item in manifest['entries'] if item['key'] == ['legacy-content'])
    (backup.root / 'objects' / entry['sha256']).write_bytes(b'tampered backup content')
    result = preparation.status()
    assert result['state'] == 'recovery-required'
    assert result['failure'] == 'maintenance-durable-state-unreadable'
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}


def test_partial_capture_resumes_exact_registered_input_set(runtime):  # noqa: F811
    root, _device, _lock = runtime; original = root / 'legacy-data'; original.write_bytes(b'original')
    value = seeded(root, 'partial'); before = NativeLegacyInputs(root).read(value['runId'])
    assert preparation.recover(value['runId'], 'capture')['state'] == 'running'
    assert preparation._current.wait(20)['state'] == 'captured'
    assert NativeLegacyInputs(root).read(value['runId']) == before
    assert original.read_bytes() == b'original'
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}


def test_active_capture_refuses_abandon_without_releasing_writer_fence(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'hold-only')
    entered, release = threading.Event(), threading.Event(); original = NativeLegacyBackup.capture
    def held(self, plan):
        entered.set()
        if not release.wait(10): raise ValueError('fixture-release-timeout')
        return original(self, plan)
    monkeypatch.setattr(NativeLegacyBackup, 'capture', held)
    assert preparation.recover(value['runId'], 'capture')['state'] == 'running'
    try:
        assert entered.wait(10)
        with pytest.raises(ValueError, match='maintenance-cancel-unavailable'):
            preparation.recover(value['runId'], 'cancel')
        assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}
        assert not legacy_startup_allowed(root)
    finally:
        release.set()
    assert preparation._current.wait(20)['state'] == 'captured'


def test_abandon_waits_for_actual_worker_exit_after_done_event(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'hold-only')
    entered, release = threading.Event(), threading.Event(); original = preparation.NativePreparation._work
    def finishing(owner):
        original(owner); entered.set(); release.wait(10)
    monkeypatch.setattr(preparation.NativePreparation, '_work', finishing)
    preparation.recover(value['runId'], 'capture')
    try:
        assert entered.wait(20) and preparation._current._done.is_set()
        with pytest.raises(ValueError, match='maintenance-cancel-unavailable'):
            preparation.recover(value['runId'], 'cancel')
        assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}
    finally:
        release.set()
    preparation._current._thread.join(10)
    assert preparation.recover(value['runId'], 'cancel')['state'] == 'cancelled'


def test_management_routes_require_bearer_and_sanitize_invalid_body(runtime):  # noqa: F811
    with TestClient(app) as client:
        for action in ('resume', 'abandon'):
            assert client.post('/api/edits/legacy-maintenance/' + action, json={'runId': 'not-a-secret'}).status_code == 401
            assert client.post('/api/edits/legacy-maintenance/' + action, json={'runId': str(uuid4())}, headers={'Authorization': 'Bearer forged-token'}).status_code == 401
            response = client.post('/api/edits/legacy-maintenance/' + action, json={'runId': 'not-a-secret'}, headers={'Authorization': 'Bearer native-maintenance-fixture'})
            assert response.status_code == 422 and 'not-a-secret' not in response.text
            response = client.post('/api/edits/legacy-maintenance/' + action, json={'runId': str(uuid4())}, headers={'Authorization': 'Bearer native-maintenance-fixture'})
            assert response.status_code == 409 and preparation._current is None


def test_maintenance_route_inventory_is_exact():
    def routes(items, prefix=''):
        for route in items:
            router = getattr(route, 'original_router', None)
            if router is not None: yield from routes(router.routes, prefix + route.include_context.prefix)
            elif isinstance(route, APIRoute): yield prefix + route.path, route
    found = {path: route.methods for path, route in routes(app.routes) if path.startswith('/api/edits/legacy-maintenance/')}
    assert found == {f'/api/edits/legacy-maintenance/{name}': {'POST'} for name in ('start', 'status', 'resume', 'abandon', 'notebooks', 'notebook-preview')}


def test_resume_and_abandon_management_retries_keep_the_same_run(runtime):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'hold-only')
    headers = {'Authorization': 'Bearer native-maintenance-fixture'}; body = {'runId': value['runId']}
    with TestClient(app) as client:
        first = client.post('/api/edits/legacy-maintenance/resume', json=body, headers=headers)
        second = client.post('/api/edits/legacy-maintenance/resume', json=body, headers=headers)
        assert first.status_code == second.status_code == 202
        assert first.json()['runId'] == second.json()['runId'] == value['runId']
        assert preparation._current.wait(20)['state'] == 'captured'
        preparation._current._thread.join(10)
        first = client.post('/api/edits/legacy-maintenance/abandon', json=body, headers=headers)
        second = client.post('/api/edits/legacy-maintenance/abandon', json=body, headers=headers)
        assert first.status_code == second.status_code == 202
        assert first.json()['runId'] == second.json()['runId'] == value['runId']
        assert first.json()['state'] == second.json()['state'] == 'cancelled'


def test_completed_cancel_does_not_authorize_a_changed_selected_root(runtime, monkeypatch, tmp_path):  # noqa: F811
    root, _device, _lock = runtime; value = seeded(root, 'not-collected'); journal = NativePreparationJournal(root)
    attempt = str(uuid4()); journal.mark(value, 'cancel-intent'); journal.mark_cleanup(value, attempt, 'begin')
    journal.mark(value, 'cancel-complete'); journal.mark_cleanup(value, attempt, 'complete')
    assert preparation.status()['state'] == 'cancelled' and legacy_startup_allowed(root)
    other = tmp_path / 'other-root'; other.mkdir()
    monkeypatch.setattr('papeer.core.paths.selected_data_directory', lambda: other)
    assert not legacy_startup_allowed(root)
    assert preparation.status()['state'] == 'recovery-required'


@pytest.mark.parametrize('phase', ['not-collected', 'hold-only', 'partial', 'artifacts-verified'])
def test_cold_interpreter_reads_existing_artifacts_without_retained_owner(runtime, phase):  # noqa: F811
    root, device, _lock = runtime; value = seeded(root, phase)
    code = r'''
import importlib.abc, importlib.util, json, os, sys
from pathlib import Path
overlay = os.environ.get('PAPEER_REC_TEST_OVERLAY')
if overlay:
    class Overlay(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            file = Path(overlay) / (fullname.replace('.', '/') + '.py')
            if file.is_file(): return importlib.util.spec_from_file_location(fullname, file)
            return None
    sys.meta_path.insert(0, Overlay())
from papeer.core import paths
paths.selected_data_directory = lambda: Path(sys.argv[1])
paths.device_directory = lambda: Path(sys.argv[2])
from sidecar.migrations import preparation
value = preparation.status()
print(json.dumps({'status': value, 'module': preparation.__file__}, sort_keys=True))
'''
    result = subprocess.run([sys.executable, '-B', '-c', code, str(root), str(device)],
                            check=True, capture_output=True, text=True, encoding='utf8', timeout=20)
    actual = json.loads(result.stdout)
    assert actual['status']['state'] == 'recovery-required'
    assert actual['status']['phase'] == phase and actual['status']['runId'] == value['runId']
    if os.environ.get('PAPEER_REC_TEST_OVERLAY'):
        assert actual['module'].startswith(os.environ['PAPEER_REC_TEST_OVERLAY'])


@pytest.mark.parametrize('boundary,expected', [('journal', 'not-collected'), ('hold', 'hold-only'), ('input', 'partial'),
                                               ('capture-1', 'partial'), ('capture-2', 'partial'), ('capture-3', 'artifacts-verified')])
def test_owned_worker_process_interruption_leaves_recoverable_evidence(tmp_path, boundary, expected):
    root, device = tmp_path / 'isolated-library', tmp_path / 'isolated-device'
    root.mkdir(); device.mkdir(); original = root / 'original'; original.write_bytes(b'untouched')
    code = r'''
import importlib.abc, importlib.util, os, sys, threading
from pathlib import Path
overlay = os.environ.get('PAPEER_REC_TEST_OVERLAY')
if overlay:
    class Overlay(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            file = Path(overlay) / (fullname.replace('.', '/') + '.py')
            if file.is_file(): return importlib.util.spec_from_file_location(fullname, file)
            return None
    sys.meta_path.insert(0, Overlay())
from papeer.core import paths
root, device, boundary = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
paths.device_directory = lambda: device
from sidecar import deps
from sidecar.lifecycle import instance
from sidecar.migrations import census, preparation
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
lock = instance.claim_library(root, 'dev', wait=0)
census._controlled_roots[(root, device)] = (lock, census._identity(root), census._identity(device))
cls, method = (NativeLegacyBackup, 'capture') if boundary.startswith('capture-') else {'journal': (NativePreparationJournal, 'begin'), 'hold': (NativeLegacyStartup, 'hold'), 'input': (NativeLegacyInputs, 'prepare')}[boundary]
original = getattr(cls, method)
count = 0
def stop_after(self, *args, **kwargs):
    global count
    result = original(self, *args, **kwargs)
    count += 1
    if not boundary.startswith('capture-') or count == int(boundary[-1]): os._exit(37)
    return result
setattr(cls, method, stop_after)
preparation.start()
threading.Event().wait(20)
os._exit(3)
'''
    env = os.environ.copy(); env['PAPEER_DATA_DIR'] = str(root)
    result = subprocess.run([sys.executable, '-B', '-c', code, str(root), str(device), boundary],
                            env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 37, result.stderr
    value = NativePreparationJournal(root).read(); assert value is not None
    assert original.read_bytes() == b'untouched'
    if boundary == 'journal':
        assert NativeLegacyStartup(root).read() is None and NativeLegacyInputs(root).read(value['runId']) is None
    else:
        assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': value['runId']}
        assert (NativeLegacyInputs(root).read(value['runId']) is not None) == (boundary == 'input' or boundary.startswith('capture-'))
    assert not legacy_startup_allowed(root)
    cold = r'''
import importlib.abc, importlib.util, json, os, sys
from pathlib import Path
overlay = os.environ.get('PAPEER_REC_TEST_OVERLAY')
if overlay:
    class Overlay(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            file = Path(overlay) / (fullname.replace('.', '/') + '.py')
            if file.is_file(): return importlib.util.spec_from_file_location(fullname, file)
            return None
    sys.meta_path.insert(0, Overlay())
from papeer.core import paths
paths.selected_data_directory = lambda: Path(sys.argv[1])
paths.device_directory = lambda: Path(sys.argv[2])
from sidecar.migrations import preparation
print(json.dumps({'status': preparation.status(), 'module': preparation.__file__}, sort_keys=True))
'''
    inspected = subprocess.run([sys.executable, '-B', '-c', cold, str(root), str(device)], env=env,
                               check=True, capture_output=True, text=True, encoding='utf8', timeout=20)
    state = json.loads(inspected.stdout)
    assert state['status']['state'] == 'recovery-required' and state['status']['phase'] == expected
    assert state['status']['runId'] == value['runId']
    if env.get('PAPEER_REC_TEST_OVERLAY'): assert state['module'].startswith(env['PAPEER_REC_TEST_OVERLAY'])


@pytest.mark.parametrize('boundary,expected', [
    ('intent', 'cancel-interrupted'), ('cleanup-begin', 'cleanup-unknown'),
    ('hold-unlink', 'cleanup-unknown'), ('cancel-complete', 'cleanup-unknown'),
    ('cleanup-complete', 'restart-complete'),
])
def test_owned_cancel_process_crash_keeps_admission_fenced_until_known_cleanup(tmp_path, boundary, expected):
    root, device = tmp_path / 'isolated-library', tmp_path / 'isolated-device'
    root.mkdir(); device.mkdir(); original = root / 'original'; original.write_bytes(b'untouched')
    code = r'''
import importlib.abc, importlib.util, os, sys
from pathlib import Path
from copy import deepcopy
overlay = os.environ.get('PAPEER_REC_TEST_OVERLAY')
if overlay:
    class Overlay(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            file = Path(overlay) / (fullname.replace('.', '/') + '.py')
            if file.is_file(): return importlib.util.spec_from_file_location(fullname, file)
            return None
    sys.meta_path.insert(0, Overlay())
from papeer.core import paths
root, device, boundary = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
paths.device_directory = lambda: device
from sidecar.lifecycle import instance
from sidecar.migrations import census, preparation
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
lock = instance.claim_library(root, 'dev', wait=0)
census._controlled_roots[(root, device)] = (lock, census._identity(root), census._identity(device))
owner = preparation.NativePreparation(census.select_current()); sources = owner._sources()
record = {'version':1, 'runId':owner._run, 'peerId':owner._peer, 'libraryId':owner._library,
          'sources':[deepcopy(source.store.source) for source in sources], 'backupIds':list(owner._backup_ids),
          'selectionSha256':preparation._selection_digest(owner._selection), 'policy':'native-local-capture-only-v1'}
NativePreparationJournal(root).begin(record); NativeLegacyStartup(root).hold({'version':1, 'runId':owner._run})
mark, cleanup, unlink = NativePreparationJournal.mark, NativePreparationJournal.mark_cleanup, Path.unlink
def stop_mark(self, value, kind):
    result = mark(self, value, kind)
    if (boundary == 'intent' and kind == 'cancel-intent') or (boundary == 'cancel-complete' and kind == 'cancel-complete'): os._exit(37)
    return result
def stop_cleanup(self, value, attempt, phase):
    result = cleanup(self, value, attempt, phase)
    if boundary == 'cleanup-' + phase: os._exit(37)
    return result
hold_path = NativeLegacyStartup(root).path
def stop_unlink(self, *args, **kwargs):
    result = unlink(self, *args, **kwargs)
    if boundary == 'hold-unlink' and self == hold_path: os._exit(37)
    return result
NativePreparationJournal.mark, NativePreparationJournal.mark_cleanup, Path.unlink = stop_mark, stop_cleanup, stop_unlink
preparation.recover(owner._run, 'cancel')
preparation._current.wait(20)
preparation.shutdown_wait(20)
os._exit(3)
'''
    env = os.environ.copy(); env['PAPEER_DATA_DIR'] = str(root)
    result = subprocess.run([sys.executable, '-B', '-c', code, str(root), str(device), boundary],
                            env=env, capture_output=True, text=True, timeout=40)
    assert result.returncode == 37, result.stderr
    assert original.read_bytes() == b'untouched'
    journal = NativePreparationJournal(root); value = journal.read(); assert value is not None
    if expected != 'restart-complete': assert not legacy_startup_allowed(root)
    cold = r'''
import importlib.abc, importlib.util, json, os, sys
from pathlib import Path
overlay = os.environ.get('PAPEER_REC_TEST_OVERLAY')
if overlay:
    class Overlay(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            file = Path(overlay) / (fullname.replace('.', '/') + '.py')
            if file.is_file(): return importlib.util.spec_from_file_location(fullname, file)
            return None
    sys.meta_path.insert(0, Overlay())
from papeer.core import paths
paths.selected_data_directory = lambda: Path(sys.argv[1])
paths.device_directory = lambda: Path(sys.argv[2])
from sidecar.migrations import preparation
print(json.dumps(preparation.status(), sort_keys=True))
'''
    inspected = subprocess.run([sys.executable, '-B', '-c', cold, str(root), str(device)], env=env,
                               check=True, capture_output=True, text=True, encoding='utf8', timeout=20)
    state = json.loads(inspected.stdout); assert state['phase'] == expected and state['runId'] == value['runId']
    assert state['state'] == ('cancelled' if expected == 'restart-complete' else 'recovery-required')
