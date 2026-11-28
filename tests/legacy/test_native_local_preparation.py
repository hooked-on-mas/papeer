"""Actual supported Windows local start/status on the project's isolated folders.

These tests never register a controlled-root bypass, open a user's profile or
claim one global snapshot. The actual same-Library/history OS locks are retained.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import threading

from fastapi.testclient import TestClient
import pytest

from papeer.core import cloud_drive_auth, local_history, paths, storage_location
from papeer.core.device_authority import reserve_maintenance
from papeer.core.edit_storage import edit_storage_root
from papeer.core.migrations.legacy_device import NativeLegacyDeviceBackup, NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from sidecar import deps
from sidecar.lifecycle import instance
from sidecar.app import app
from sidecar.canonical_host import authority
from sidecar.lifecycle.jobs import JobManager
from sidecar.migrations import census, preparation
from sidecar.migrations.history import retain_selected_histories
from sidecar.provider.offline import routes as offline_routes
from sidecar.provider.offline.jobs import PermissionJobs
from sidecar.routes import provider_owner

pytestmark = pytest.mark.skipif(sys.platform != 'win32', reason='supported local preparation currently Windows only')
BASE = '/api/edits/legacy-maintenance/'
AUTH = {'Authorization': 'Bearer isolated-local-preparation'}


@pytest.fixture
def local_runtime(monkeypatch):
    # Actual repository autouse isolation sets LOCALAPPDATA before imports. The
    # real platform selector/native fixed-drive query are used, not patched true.
    monkeypatch.delenv('PAPEER_DATA_DIR', raising=False)
    monkeypatch.delenv('PAPERDESK_DATA_DIR', raising=False)
    monkeypatch.setenv('PAPEER_TOKEN', 'isolated-local-preparation')
    root = paths.default_data_directory(); root.mkdir(parents=True, exist_ok=True)
    device = paths.device_directory(); device.mkdir(parents=True, exist_ok=True)
    for name in ('_lock', '_owned_root', '_maintenance', '_root', '_info', '_idle_grace'):
        monkeypatch.setattr(instance, name, None)
    monkeypatch.setattr(instance, '_release_requested', False)
    monkeypatch.setattr(instance, 'activity', instance.Activity())
    monkeypatch.setattr(deps, 'job_manager', JobManager())
    for name in ('_maintenance_owner',): monkeypatch.setattr(deps, name, None)
    for name in ('_library_requests', '_side_reads'): monkeypatch.setattr(deps, name, 0)
    monkeypatch.setattr(preparation, '_current', None)
    monkeypatch.setattr(census, '_controlled_roots', {})
    for name in ('_hub', '_closing'): monkeypatch.setattr(provider_owner, name, None)
    monkeypatch.setattr(provider_owner, '_shutdown', False)
    monkeypatch.setattr(offline_routes, '_service', None)
    authority.revoke_all()
    monkeypatch.setattr(authority, '_offline_jobs', PermissionJobs())
    held = instance.claim_library(root, 'dev', wait=0)
    assert held.held and held.writer_protocol_current(root)
    with closing(sqlite3.connect(root / 'library.sqlite3')) as db, db:
        db.execute('CREATE TABLE old_notes(body TEXT)')
        db.execute("INSERT INTO old_notes VALUES ('owned legacy body')")
    files = {root / 'notes' / 'original.md': b'old-library-body',
             device / 'device-settings.json': b'{"version":1,"migrated":false,"provider_options":{"codex":{"cli_path":"synthetic-not-executed"}}}',
             device / 'history-settings.json': b'{"version":1,"recent":3,"days":4}',
             device / 'ocr-settings.json': b'{"version":1,"mode":"ask","engine":"auto","lang":"jpn"}',
             device / 'storage-location.json': json.dumps({'path': str(root), 'history_key': 'c' * 64}).encode()}
    for key in (paths.library_key(root), 'c' * 64):
        folder = device / 'history' / key
        folder.mkdir(parents=True, exist_ok=True)
        (folder / '.lock').write_bytes(b'')
        files[folder / 'library.json'] = json.dumps({'library': str(root)}).encode()
        files[folder / 'raw-unknown-history.bin'] = b'preserve-opaque-history'
    for path, body in files.items():
        path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(body)
    files[root / 'library.sqlite3'] = (root / 'library.sqlite3').read_bytes()
    routes, schema = list(app.router.routes), app.openapi_schema
    yield root, device, held, files
    assert preparation.shutdown_wait(10)
    instance.release(); authority.revoke_all()
    app.router.routes[:] = routes; app.openapi_schema = schema


def begin(client):
    response = client.post(BASE + 'start', json={}, headers=AUTH)
    assert response.status_code == 202, response.text
    assert response.headers['Cache-Control'] == 'no-store'
    return response.json()


def test_actual_local_entry_holds_two_existing_history_locks_and_cold_reads_same_input_set(local_runtime, monkeypatch):
    root, device, held, originals = local_runtime
    selected = census.select_current()
    assert selected.managed and not census._controlled_roots and len(selected.history_refs) == 2
    with TestClient(app) as client:
        schema = app.openapi()['paths']
        assert '202' in schema[BASE + 'start']['post']['responses']
        assert '200' not in schema[BASE + 'start']['post']['responses']
        assert '200' in schema[BASE + 'status']['post']['responses']
        issued = begin(client)
        result = preparation._current.wait(10)
        assert result['state'] == 'captured', result
        assert result['runId'] == issued['runId'] and held.held
        assert client.post(BASE + 'status', json={}, headers=AUTH).json() == result
        assert begin(client)['runId'] == issued['runId']
        owner = preparation._current
        owner._history_lease.assert_current(); owner._device_lease.assert_current()
        record = NativeLegacyInputs(root).read(result['runId'])
        assert record == owner._input_set and record['catalog']['identity']['accountId'] == 'native-local'
        assert len(record['inputs']) == 3
        device_plan = next(item['plan'] for item in record['inputs'] if item['plan']['manifest']['source']['kind'] == 'desktop-device')
        assert all(entry['key'][-1] != '.lock' for entry in device_plan['manifest']['entries'])
        assert {entry['key'][0] for entry in device_plan['manifest']['entries']} >= {
            'device-settings.json', 'storage-location.json', 'history-settings.json', 'ocr-settings.json', 'history'}
        # The unchanged actual old-history acquisition primitive does not use
        # the new device gate. It must contend on the same real byte lock.
        monkeypatch.setattr(local_history, 'LOCK_WAIT', .1)
        for key, _identity in selected.history_refs:
            with pytest.raises(local_history.HistoryBusy):
                local_history._acquire_file_lock(device / 'history' / key / '.lock')
        for source in owner._sources():
            plan = next(item['plan'] for item in record['inputs'] if item['plan']['manifest']['source'] == source.store.source)
            assert source.load(plan['manifest']['id']) == plan['manifest']
            for entry in plan['manifest']['entries']: source.object(plan['manifest']['id'], entry)
        fresh = NativeLegacyHeldDeviceBackup(root, device_root=device)
        assert fresh.plan(device_plan['manifest']['id']) == device_plan
        # Existing v1 identity/reader is intentionally distinct, not silently
        # reinterpreted after excluding the held operational lock files.
        assert NativeLegacyDeviceBackup(root, device_root=device).store.source != fresh.store.source
        assert not edit_storage_root(root).exists()
        # Fresh interpreter, exact actual loaded reader bytes; no coordinator
        # memory and no CP path hard-coded into the eventual public test.
        script = """
import hashlib,importlib.util,json,sys
from pathlib import Path
source=Path(sys.argv[4]); assert hashlib.sha256(source.read_bytes()).hexdigest()==sys.argv[5]
spec=importlib.util.spec_from_file_location('papeer.core.migrations.legacy_device',source)
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
from papeer.core.edit_storage import edit_storage_root
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
root=Path(sys.argv[1]);record=NativeLegacyInputs(root).read(sys.argv[2])
sources=[NativeLegacyBackup(root),NativeLegacyBackup(edit_storage_root(root),allow_missing=True),
 NativeLegacyHeldDeviceBackup(root,device_root=Path(sys.argv[3]))]
checked=0
for item in record['inputs']:
 plan=item['plan']; source=next(s for s in sources if s.store.source==plan['manifest']['source'])
 assert source.load(plan['manifest']['id'])==plan['manifest'] and source.plan(plan['manifest']['id'])==plan
 for entry in plan['manifest']['entries']:
  body=source.object(plan['manifest']['id'],entry)
  assert len(body)==entry['byteLength'] and hashlib.sha256(body).hexdigest()==entry['sha256'];checked+=1
print(json.dumps({'sources':len(record['inputs']),'objects':checked,'account':record['catalog']['identity']['accountId']}))
"""
        origin = Path(sys.modules[NativeLegacyHeldDeviceBackup.__module__].__file__)
        child = subprocess.run([sys.executable, '-B', '-c', script, str(root), issued['runId'], str(device),
                                str(origin), hashlib.sha256(origin.read_bytes()).hexdigest()],
                               capture_output=True, text=True, timeout=20, check=True)
        cold = json.loads(child.stdout)
        assert cold['sources'] == 3 and cold['objects'] >= 10 and cold['account'] == 'native-local'
    assert all(path.read_bytes() == body for path, body in originals.items())


def test_contended_actual_history_refuses_capture_and_retains_own_lifetime(local_runtime):
    root, device, held, originals = local_runtime
    from papeer.core import file_lock

    folder = device / 'history' / ('c' * 64)
    handle = file_lock.open_lock_file(folder / '.lock')
    assert file_lock.try_lock(handle)
    try:
        with TestClient(app) as client:
            begin(client)
            value = preparation._current.wait(10)
            assert value['state'] == 'failed' and value['failure'] == 'maintenance-history-busy', value
            assert held.held and instance.maintenance_owner() is preparation._current
            assert NativeLegacyStartup(root).read() is None
            assert all(path.read_bytes() == body for path, body in originals.items())
    finally:
        file_lock.unlock(handle)


def test_real_windows_lock_prevents_old_trailing_directory_removal_and_releases_cross_thread(local_runtime):
    root, device, _held, originals = local_runtime
    for key in (paths.library_key(root), 'c' * 64):
        folder = device / 'history' / key
        for path in list(folder.iterdir()):
            if path.name != '.lock': path.unlink()
    selection = census.select_current()
    lease = reserve_maintenance()
    histories = retain_selected_histories(selection)
    try:
        for key, _identity in selection.history_refs:
            folder = device / 'history' / key
            # Exact old remove_other_histories trailing shutil.rmtree operation
            # after its critical section: only .lock remains, no data is deleted.
            with pytest.raises(PermissionError): shutil.rmtree(folder)
            assert folder.is_dir() and (folder / '.lock').exists()
        worker = threading.Thread(target=histories.release)
        worker.start(); worker.join(2)
        assert not worker.is_alive()
        for key, _identity in selection.history_refs:
            shutil.rmtree(device / 'history' / key)
    finally:
        histories.release(); lease.release()
    assert (root / 'library.sqlite3').read_bytes() == originals[root / 'library.sqlite3']


def test_unlock_error_closes_descriptor_and_records_cleanup_unknown_instead_of_claiming_held(local_runtime, monkeypatch):
    root, device, _held, _originals = local_runtime
    from papeer.core import file_lock

    (device / 'storage-location.json').write_text(json.dumps({'path': str(root)}), 'utf8')
    selection = census.select_current()
    lease = reserve_maintenance()
    histories = retain_selected_histories(selection)
    assert len(histories._handles) == 1
    handle = histories._handles[0][-1]
    original = file_lock.unlock

    def closed_then_error(current):
        original(current)
        raise OSError('synthetic-unlock-error-after-real-close')

    try:
        with monkeypatch.context() as patch:
            patch.setattr(file_lock, 'unlock', closed_then_error)
            with pytest.raises(OSError, match='synthetic-unlock-error-after-real-close'):
                histories.release()
        assert handle.closed and histories._cleanup_unknown and not histories._closed
        assert not histories._handles and histories._uncertain_count == 1
        for action in (histories.release, histories.assert_current):
            with pytest.raises(ValueError, match='maintenance-history-cleanup-unknown'):
                action()
        # A fresh exact OS handle can acquire it: the old descriptor is NOT
        # falsely reported retained just because the Python outcome is unknown.
        probe = file_lock.open_lock_file(device / 'history' / paths.library_key(root) / '.lock')
        try: assert file_lock.try_lock(probe)
        finally: file_lock.unlock(probe)
    finally:
        lease.release()


def test_admitted_location_writer_changes_history_mapping_after_start_and_is_rejected(local_runtime):
    root, device, held, originals = local_runtime
    entered, release = threading.Event(), threading.Event()
    replies = []

    @app.post('/test-local-location-writer')
    def delayed():
        entered.set(); assert release.wait(10)
        storage_location._save({'path': str(root), 'history_key': 'd' * 64})
        return {'saved': True}

    with TestClient(app) as client:
        thread = threading.Thread(target=lambda: replies.append(client.post('/test-local-location-writer', headers=AUTH)))
        thread.start()
        try:
            assert entered.wait(5)
            begin(client)
            release.set(); thread.join(5)
            assert not thread.is_alive() and len(replies) == 1 and replies[0].status_code == 200
            value = preparation._current.wait(10)
            assert value['state'] == 'failed' and value['failure'] == 'maintenance-history-selection-changed', value
            assert held.held and NativeLegacyStartup(root).read() is None
            assert json.loads((device / 'storage-location.json').read_text('utf8'))['history_key'] == 'd' * 64
            assert all(path.read_bytes() == body for path, body in originals.items() if path.name != 'storage-location.json')
        finally:
            release.set(); thread.join(5)


@pytest.mark.parametrize('mode', ['pending', 'custom', 'folder-sync', 'remote', 'canonical', 'unknown-instance', 'connecting', 'changing'])
def test_unsupported_modes_refuse_before_reservation_without_touching_inputs(local_runtime, monkeypatch, mode):
    root, device, held, originals = local_runtime
    if mode == 'pending':
        (device / 'storage-location.json').write_text(json.dumps({'path': str(root), 'pending': {
            'source': str(root), 'destination': str(root.parent / 'not-selected')}}), 'utf8')
    elif mode == 'custom': monkeypatch.setenv('PAPEER_DATA_DIR', str(root))
    elif mode == 'folder-sync': (device / (paths.library_key(root) + '.json')).write_text('{}', 'utf8')
    elif mode == 'remote': (device / (paths.library_key(root) + '.cloud-drive.json')).write_text('{}', 'utf8')
    elif mode == 'canonical': edit_storage_root(root).mkdir()
    elif mode == 'connecting': monkeypatch.setattr(cloud_drive_auth, '_attempt', cloud_drive_auth._Attempt())
    elif mode == 'changing':
        changing = threading.Event(); changing.set()
        monkeypatch.setattr(cloud_drive_auth, '_changing', changing)
    else: (device / 'instances' / ('f' * 64 + '.json')).write_text('{"format":1}', 'utf8')
    before = {path: path.read_bytes() for path in originals if path.exists()}
    with TestClient(app) as client:
        reply = client.post(BASE + 'start', json={}, headers=AUTH)
        assert reply.status_code == 409 and reply.json()['state'] == 'blocked'
        assert preparation._current is None and instance.maintenance_owner() is None
        assert held.held and not deps.job_manager._closed
    assert all(path.read_bytes() == body for path, body in before.items())


def test_network_selection_is_refused_before_any_native_drive_query():
    with pytest.raises(census.CoverageUnresolved, match='maintenance-local-volume-unverified'):
        census._fixed_windows_drive(Path(r'\\untrusted-host\share\Papeer'))

def test_fresh_python_status_reports_interrupted_and_refuses_replacement_without_claiming_old_locks(local_runtime):
    root, _device, _held, originals = local_runtime
    with TestClient(app) as client:
        issued = begin(client)
        assert preparation._current.wait(10)['state'] == 'captured'
    # Fresh interpreter + actual ASGI routes, exact loaded production origins.
    # No helper path is hard-coded into the eventual public test.
    names = ('papeer.core.cloud_drive', 'papeer.core.cloud_drive_auth', 'papeer.core.config',
             'papeer.core.device_authority', 'papeer.core.drive_sync', 'papeer.core.instance',
             'papeer.core.local_history', 'papeer.core.migrations.legacy_device', 'papeer.core.migrations.legacy_startup',
             'papeer.core.migrations.legacy_preparation_journal', 'papeer.core.ocr',
             'papeer.core.storage_location', 'sidecar.app', 'sidecar.deps', 'sidecar.lifecycle', 'sidecar.lifecycle.instance',
             'sidecar.migrations', 'sidecar.migrations.census', 'sidecar.migrations.history',
             'sidecar.migrations.preparation', 'sidecar.migrations.routes', 'sidecar.canonical_host',
             'sidecar.provider.offline.jobs', 'sidecar.routes.system')
    origins = {name: {'path': str(Path(sys.modules[name].__file__)),
                      'sha256': hashlib.sha256(Path(sys.modules[name].__file__).read_bytes()).hexdigest(),
                      'package': hasattr(sys.modules[name], '__path__')} for name in names}
    script = r'''
import hashlib,importlib.abc,importlib.util,json,os,sys
from pathlib import Path
origins=json.loads(sys.argv[1])
for row in origins.values(): assert hashlib.sha256(Path(row['path']).read_bytes()).hexdigest()==row['sha256']
class Overlay(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname not in origins:return None
  row=origins[fullname];source=Path(row['path'])
  return importlib.util.spec_from_file_location(fullname,source,submodule_search_locations=[str(source.parent)] if row['package'] else None)
sys.meta_path.insert(0,Overlay())
from fastapi.testclient import TestClient
from sidecar.app import app
from sidecar import deps
from sidecar.lifecycle import instance
from sidecar.migrations import preparation
assert preparation._current is None and instance.current_library_root() is None
auth={'Authorization':'Bearer '+os.environ['PAPEER_TOKEN']}
with TestClient(app) as client:
 status=client.post('/api/edits/legacy-maintenance/status',json={},headers=auth)
 assert status.status_code==200
 value=status.json();assert value['state']=='recovery-required' and value['phase']=='artifacts-verified'
 refused=client.post('/api/edits/legacy-maintenance/start',json={},headers=auth)
 assert refused.status_code==409 and refused.json()['reason']=='maintenance-recovery-required'
 assert preparation._current is None and instance.maintenance_owner() is None
 assert instance.current_library_root() is None and not deps.job_manager._closed
 print(json.dumps({'status':value,'startStatus':refused.status_code,'noOwnerClaimed':True}))
'''
    child = subprocess.run([sys.executable, '-B', '-c', script, json.dumps(origins)],
                           capture_output=True, text=True, timeout=30, check=True)
    result = json.loads(child.stdout)
    assert result['status']['runId'] == issued['runId'] and result['noOwnerClaimed']
    assert NativeLegacyInputs(root).read(issued['runId']) is not None
    assert all(path.read_bytes() == body for path, body in originals.items())


def test_valid_old_hold_without_inputset_is_recovery_required_and_never_replaced(local_runtime):
    from uuid import uuid4

    root, _device, _held, originals = local_runtime
    identity = str(uuid4()); startup = NativeLegacyStartup(root)
    startup.hold({'version': 1, 'runId': identity})
    before = startup.path.read_bytes()
    with TestClient(app) as client:
        value = client.post(BASE + 'status', json={}, headers=AUTH).json()
        assert value['state'] == 'recovery-required' and value['runId'] == identity
        assert value['phase'] == 'interrupted'
        reply = client.post(BASE + 'start', json={}, headers=AUTH)
        assert reply.status_code == 409 and reply.json()['reason'] == 'maintenance-recovery-required'
        assert preparation._current is None and instance.maintenance_owner() is None
        assert not deps.job_manager._closed and not NativeLegacyInputs(root).root.exists()
    assert startup.path.read_bytes() == before
    assert all(path.read_bytes() == body for path, body in originals.items())


def test_orphan_inputset_cannot_manufacture_runid_or_idle_and_start_does_not_drain(local_runtime):
    root, _device, _held, _originals = local_runtime
    folder = NativeLegacyInputs(root).root; folder.mkdir(parents=True)
    file = folder / 'untrusted-run.json'
    raw = b'{"catalog":{"runId":"untrusted-private-identifier","title":"do-not-echo"}}'
    file.write_bytes(raw)
    with TestClient(app) as client:
        reply = client.post(BASE + 'status', json={}, headers=AUTH)
        value = reply.json()
        assert value['state'] == 'recovery-required' and 'runId' not in value
        assert 'untrusted-private-identifier' not in reply.text and 'do-not-echo' not in reply.text
        blocked = client.post(BASE + 'start', json={}, headers=AUTH)
        assert blocked.status_code == 409
        assert preparation._current is None and instance.maintenance_owner() is None and not deps.job_manager._closed
    assert file.read_bytes() == raw and NativeLegacyStartup(root).read() is None


@pytest.mark.parametrize('body', [b'{malformed', b'{"version":1,"runId":"not-an-id","capturedId":"private"}', b'x' * 65_537],
                         ids=['malformed', 'invalid-schema', 'oversized'])
def test_corrupt_durable_hold_stays_unreadable_not_idle_and_no_state_is_cleared(local_runtime, body):
    root, _device, _held, _originals = local_runtime
    path = NativeLegacyStartup(root).path
    path.parent.mkdir(parents=True); path.write_bytes(body)
    with TestClient(app) as client:
        for _ in range(2):
            response = client.post(BASE + 'status', json={}, headers=AUTH)
            value = response.json()
            assert value['state'] == 'recovery-required' and value['failure'] == 'maintenance-durable-state-unreadable'
            assert 'runId' not in value and 'private' not in response.text
        refused = client.post(BASE + 'start', json={}, headers=AUTH)
        assert refused.status_code == 409
        assert preparation._current is None and instance.maintenance_owner() is None and not deps.job_manager._closed
    assert path.read_bytes() == body
