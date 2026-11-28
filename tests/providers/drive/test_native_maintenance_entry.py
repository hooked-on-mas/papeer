"""Actual app/management/lifetime on private copies; original profiles still refuse."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading

from fastapi import Depends
from fastapi.testclient import TestClient
import pytest
import papeer
import httpx2 as httpx
from starlette.websockets import WebSocketDisconnect

from test_provider_verifier import http as google_http  # noqa: F401 - existing synthetic HTTP fixture
import test_provider_data_plane as plane
from papeer.core import paths
from papeer.core.config import Settings
from papeer.core.device_authority import DeviceWriterBusy, writer
from papeer.core.instance import LibraryLock
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from sidecar import deps
from sidecar.lifecycle import instance
from sidecar.app import app
from sidecar.canonical_host import authority, AuthorityError, _existing
from sidecar.lifecycle.jobs import JobManager
from sidecar.lifecycle.job_types import JobKind
from sidecar.migrations import census, preparation
from sidecar.provider.offline import crypto, routes as offline_routes, storage
from sidecar.provider.offline.jobs import PermissionJobs
from sidecar.provider.hub import NativeProviderHub
from sidecar.routes import provider_owner, system

PREFIX = '/api/edits/legacy-maintenance/'
AUTH = {'Authorization': 'Bearer native-maintenance-fixture'}


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    root = tmp_path / 'selected-copy'; root.mkdir()
    monkeypatch.setenv('PAPEER_DATA_DIR', str(root))
    monkeypatch.setenv('PAPEER_TOKEN', 'native-maintenance-fixture')
    device = paths.device_directory(); device.mkdir(parents=True, exist_ok=True)
    for key in ('_lock', '_owned_root', '_maintenance', '_root', '_info', '_idle_grace'):
        monkeypatch.setattr(instance, key, None)
    monkeypatch.setattr(instance, '_release_requested', False)
    monkeypatch.setattr(instance, 'activity', instance.Activity())
    monkeypatch.setattr(deps, 'job_manager', JobManager())
    monkeypatch.setattr(deps, '_maintenance_owner', None)
    monkeypatch.setattr(deps, '_library_requests', 0)
    monkeypatch.setattr(deps, '_side_reads', 0)
    monkeypatch.setattr(preparation, '_current', None)
    monkeypatch.setattr(census, '_controlled_roots', {})
    monkeypatch.setattr(provider_owner, '_hub', None)
    monkeypatch.setattr(provider_owner, '_closing', None)
    monkeypatch.setattr(provider_owner, '_shutdown', False)
    monkeypatch.setattr(offline_routes, '_service', None)
    authority.revoke_all()
    monkeypatch.setattr(authority, '_offline_jobs', PermissionJobs())
    lock = instance.claim_library(root, 'dev', wait=0)
    assert lock.held and instance.current_library_lock(root) is lock
    # Test-only closed-world origin: the fixture created this copy and serves it
    # with the actual instance lock. Production does not populate this registry.
    census._controlled_roots[(root, device)] = (lock, census._identity(root), census._identity(device))
    original_routes, schema = list(app.router.routes), app.openapi_schema
    yield root, device, lock
    assert preparation.shutdown_wait(10), 'retain any incomplete owner rather than conceal teardown failure'
    instance.release(); authority.revoke_all()
    app.router.routes[:] = original_routes; app.openapi_schema = schema


def seed(root):
    with sqlite3.connect(root / 'library.sqlite3') as db:
        db.execute('CREATE TABLE legacy(value TEXT)'); db.execute("INSERT INTO legacy VALUES ('untouched')")
    (root / 'library.sqlite3-wal').write_bytes(b'raw WAL fixture')
    (root / 'library.sqlite3-shm').write_bytes(b'raw SHM fixture')


def start(client, auth=AUTH):
    reply = client.post(PREFIX + 'start', json={}, headers=auth)
    assert reply.status_code == 202, reply.text
    assert reply.headers['Cache-Control'] == 'no-store'
    return reply.json()


def completed(client, root, auth=AUTH):
    owner = preparation._current
    value = owner.wait(10)
    assert value['state'] == 'captured', value
    result = client.post(PREFIX + 'status', json={}, headers=auth)
    assert result.status_code == 200 and result.json()['runId'] == value['runId']
    record = NativeLegacyInputs(root).read(value['runId'])
    assert record == owner._input_set and len(record['inputs']) == 3
    return record


@pytest.mark.parametrize('endpoint', ['start', 'status'])
def test_actual_management_routes_authenticate_and_sanitize_empty_contract(runtime, endpoint):
    root, _device, lock = runtime
    with TestClient(app) as client:
        for bad in ({}, {'Authorization': 'Bearer forged'}):
            response = client.post(PREFIX + endpoint, json={'secret': 'distinctive-never-echo-secret'}, headers=bad)
            assert response.status_code == 401 and 'distinctive-never-echo-secret' not in response.text
        response = client.post(PREFIX + endpoint, json={'path': str(root), 'quiescent': True, 'secret': 'distinctive-never-echo-secret'}, headers=AUTH)
        assert response.status_code == 422
        assert all(value not in response.text for value in (str(root), 'distinctive-never-echo-secret'))
        assert preparation._current is None and lock.held and not deps.job_manager._closed


@pytest.mark.parametrize('reason', ['original-profile', 'other-library', 'other-library-lock', 'folder-sync', 'pending'])
def test_real_unknown_or_pending_writer_coverage_refuses_before_admission(runtime, reason):
    root, device, lock = runtime
    census._controlled_roots.clear()
    if reason == 'other-library':
        (device / 'instances' / ('a' * 64 + '.json')).write_text(json.dumps({'data_dir': str(root.parent / 'another-library'), 'token': 'private-other-token'}), encoding='utf8')
    elif reason == 'other-library-lock':
        (device / 'instances' / ('b' * 64 + '.lock')).write_bytes(b'other held or stale lock cannot prove absence')
    elif reason == 'folder-sync':
        (device / (paths.library_key(root) + '.json')).write_text('{}', encoding='utf8')
    elif reason == 'pending':
        (device / 'storage-location.json').write_text(json.dumps({'path': str(root), 'pending': {'source': str(root), 'destination': str(root.parent / 'unmapped')}}), encoding='utf8')
    before = {file: file.read_bytes() for file in device.rglob('*.json')}
    with TestClient(app) as client:
        response = client.post(PREFIX + 'start', json={}, headers=AUTH)
        assert response.status_code == 409, response.text
        assert response.json()['state'] == 'blocked' and 'private-other-token' not in response.text
        assert preparation._current is None and deps._maintenance_owner is None
        assert lock.held and not deps.job_manager._closed
    assert all(file.read_bytes() == body for file, body in before.items())


def test_real_app_start_is_counted_returns202_and_fixed_run_cold_readback(runtime, monkeypatch):
    root, _device, lock = runtime
    seed(root)
    observed = []
    original = preparation.NativePreparation.start

    def counted(owner):
        observed.append(deps._library_requests)
        return original(owner)

    monkeypatch.setattr(preparation.NativePreparation, 'start', counted)
    with TestClient(app) as client:
        issued = start(client)
        record = completed(client, root)
        assert observed == [1] and record['catalog']['runId'] == issued['runId']
        again = start(client)
        assert again['runId'] == issued['runId'] and again['state'] == 'captured'
        assert lock.held
        preparation._current._device_lease.assert_current()
        with pytest.raises(DeviceWriterBusy): Settings().save(root)
        for source in preparation._current._sources():
            plan = next(row['plan'] for row in record['inputs'] if row['plan']['manifest']['source'] == source.store.source)
            assert source.load(plan['manifest']['id']) == plan['manifest']
            for entry in plan['manifest']['entries']: source.object(plan['manifest']['id'], entry)
        assert (root / 'library.sqlite3-wal').read_bytes() == b'raw WAL fixture'
        # A new interpreter cold-loads the same immutable run and verifies every
        # body; no candidate coordinator import or in-memory state is available.
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
root=Path(sys.argv[1]); run=sys.argv[2]; record=NativeLegacyInputs(root).read(run)
sources=[NativeLegacyBackup(root), NativeLegacyBackup(edit_storage_root(root),allow_missing=True),
         NativeLegacyHeldDeviceBackup(root,device_root=Path(sys.argv[3]))]
checked=0
for item in record['inputs']:
 plan=item['plan']; source=next(source for source in sources if source.store.source==plan['manifest']['source'])
 assert source.load(plan['manifest']['id'])==plan['manifest']
 for entry in plan['manifest']['entries']:
  body=source.object(plan['manifest']['id'],entry)
  assert hashlib.sha256(body).hexdigest()==entry['sha256'] and len(body)==entry['byteLength']; checked+=1
print(json.dumps({'runId':run,'sources':len(record['inputs']),'objects':checked}))
"""
        origin = Path(sys.modules[NativeLegacyHeldDeviceBackup.__module__].__file__)
        import hashlib
        child = subprocess.run([sys.executable, '-B', '-c', script, str(root), issued['runId'], str(_device),
                                str(origin), hashlib.sha256(origin.read_bytes()).hexdigest()],
                               cwd=Path(papeer.__file__).resolve().parents[1], capture_output=True, text=True, check=True, timeout=20)
        cold = json.loads(child.stdout)
        assert cold['runId'] == issued['runId'] and cold['sources'] == 3 and cold['objects'] >= 3
    assert instance.maintenance_owner() is None and lock.held
    with writer(timeout=0): pass


def test_lost_start_response_recovers_same_server_owned_operation_without_new_run(runtime, monkeypatch):
    root, _device, _lock = runtime
    seed(root)
    with TestClient(app) as client:
        original = client._transport.handle_request
        lost = False

        def receive(request):
            nonlocal lost
            response = original(request)
            if request.url.path == PREFIX + 'start' and not lost:
                lost = True; response.close()
                raise httpx.ReadError('synthetic response lost after actual handler')
            return response

        monkeypatch.setattr(client._transport, 'handle_request', receive)
        with pytest.raises(httpx.ReadError): client.post(PREFIX + 'start', json={}, headers=AUTH)
        fixed = preparation._current.status()['runId']
        status = client.post(PREFIX + 'status', json={}, headers=AUTH)
        assert status.status_code == 200 and status.json()['runId'] == fixed
        assert start(client)['runId'] == fixed
        assert completed(client, root)['catalog']['runId'] == fixed


def held_request(monkeypatch, on_release=None):
    entered, release = threading.Event(), threading.Event()

    def held():
        entered.set(); assert release.wait(15)
        if on_release is not None: on_release()
        return {'status': 'ended'}

    app.add_api_route('/test-maintenance-held', held, methods=['POST'], dependencies=[Depends(deps.verify_token)])
    return entered, release


def request_thread(client, path, body=None, headers=AUTH):
    results, errors = [], []

    def run():
        try: results.append(client.post(path, json={} if body is None else body, headers=headers))
        except Exception as error: errors.append(type(error).__name__)  # noqa: BLE001 - retain actual ASGI request outcome

    thread = threading.Thread(target=run); thread.start()
    return thread, results, errors


def test_real_release_and_shutdown_cannot_abandon_live_copy_and_controls_are_narrow(runtime, monkeypatch):
    root, _device, lock = runtime
    entered, release = held_request(monkeypatch)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .01)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .01)
    exits = []; monkeypatch.setattr(system.os, '_exit', lambda code: exits.append(code))
    with TestClient(app) as client:
        worker, replies, errors = request_thread(client, '/test-maintenance-held')
        try:
            assert entered.wait(5)
            start(client)
            assert client.post(PREFIX + 'status', json={}, headers=AUTH).status_code == 200
            instance.release()
            assert instance.current_library_lock(root) is lock and lock.held
            with pytest.raises(ValueError, match='maintenance-lifetime-active'):
                instance.claim_library(root.parent / 'must-not-claim', 'dev', wait=0)
            assert not instance.activity.close_if_idle(0, lambda: False)
            competitor = LibraryLock(); assert not competitor.try_acquire(root)
            for path in ('/api/storage', '/api/cloud-drive'):
                assert client.get(path, headers=AUTH).status_code == 409
            assert client.put('/api/storage', json={'path': str(root.parent / 'elsewhere')}, headers=AUTH).status_code == 409
            assert client.post('/shutdown', json={}, headers=AUTH).json()['status'] == 'pending'
            system.exit_process()
            assert exits == [] and lock.held
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect('/ws/events?token=native-maintenance-fixture'):
                    pytest.fail('new event socket admitted during maintenance')
        finally:
            release.set(); worker.join(10)
        assert errors == [] and [reply.status_code for reply in replies] == [200]
        completed(client, root)
    assert not lock.held and exits == [], 'deferred release occurs only after the actual lifespan drains'


def test_actual_drain_timeout_is_not_retried_or_released_by_shutdown(runtime, monkeypatch):
    root, _device, lock = runtime
    entered, release = held_request(monkeypatch)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .01)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .01)
    with TestClient(app) as client:
        worker, replies, errors = request_thread(client, '/test-maintenance-held')
        try:
            assert entered.wait(5); start(client)
            result = preparation._current.wait(7)
            assert result['state'] == 'failed' and result['failure'] == 'controlled-copy-requests-incomplete'
            instance.release()
            assert client.post('/shutdown', json={}, headers=AUTH).json()['status'] == 'pending'
            assert lock.held and NativeLegacyInputs(root).read(result['runId']) is None
        finally:
            release.set(); worker.join(10)
        assert errors == [] and [reply.status_code for reply in replies] == [200]
        assert preparation.shutdown_wait(5) and not lock.held
        assert preparation._current.status()['state'] == 'failed'
        assert client.post(PREFIX + 'status', json={}, headers=AUTH).json()['state'] == 'failed'


def test_actual_lifespan_close_waits_for_live_owner_and_deferred_instance_release(runtime, monkeypatch):
    root, _device, lock = runtime
    entered, release = held_request(monkeypatch)
    lifespan_entered = threading.Event()
    original = preparation.wait_for_shutdown

    def wait():
        lifespan_entered.set(); return original()

    monkeypatch.setattr(preparation, 'wait_for_shutdown', wait)
    client = TestClient(app); client.__enter__()
    worker, replies, errors = request_thread(client, '/test-maintenance-held')
    closes = []

    def close():
        try: client.__exit__(None, None, None)
        except Exception as error: closes.append(type(error).__name__)  # noqa: BLE001 - retain actual lifespan outcome

    closer = threading.Thread(target=close)
    try:
        assert entered.wait(5); issued = start(client)
        instance.release(); closer.start()
        assert lifespan_entered.wait(5) and closer.is_alive() and lock.held
        assert NativeLegacyInputs(root).read(issued['runId']) is None
    finally:
        release.set(); worker.join(10)
        if closer.ident is not None: closer.join(10)
        else: client.__exit__(None, None, None)
    assert errors == closes == [] and [reply.status_code for reply in replies] == [200]
    assert not closer.is_alive() and not lock.held
    assert NativeLegacyInputs(root).read(issued['runId']) is not None


def test_actual_app_waits_finishing_job_thread_before_inventory(runtime, monkeypatch):
    root, _device, _lock = runtime
    entered, finishing, release = threading.Event(), threading.Event(), threading.Event()
    original = deps.job_manager.broadcast

    def broadcast(event):
        if getattr(event, 'status', None) == 'succeeded': finishing.set(); assert release.wait(10)
        original(event)

    monkeypatch.setattr(deps.job_manager, 'broadcast', broadcast)

    def action(cancel, _progress, _page):
        entered.set(); assert cancel.wait(5)
        return {'paper_ids': [], 'added': 0}

    deps.job_manager.submit_job(JobKind.IMPORT, action)
    with TestClient(app) as client:
        try:
            assert entered.wait(5); start(client)
            assert finishing.wait(5)
            assert NativeLegacyInputs(root).read(preparation._current.status()['runId']) is None
            assert preparation._current.wait(0)['state'] == 'running'
        finally: release.set()
        completed(client, root)


class OwnedRoot:
    def __init__(self, root): self.root = root
    def __truediv__(self, name): assert name == 'isolated-library'; return self.root


@pytest.fixture
def real_provider(runtime, request, monkeypatch):
    root, _device, _lock = runtime
    # The existing provider fixture uses the very same authority as actual routes.
    monkeypatch.setattr(plane, 'NativeAuthority', lambda: authority)
    context = plane.context.__wrapped__(request.getfixturevalue('google_http'), monkeypatch, OwnedRoot(root))
    value = next(context); value[3]()
    try: yield value
    finally:
        try: next(context)
        except StopIteration: pass


def test_real_offline_http_enrollment_is_registered_kdf_fenced_and_drained(runtime, real_provider, monkeypatch):
    root, _device, _lock = runtime
    _host, owner, _plan, _activate, _put, _http = real_provider
    auth, lease = owner._authorization, owner._lease_id
    admission, _scope = authority.admit_provider(auth, lease, owner, owner.descriptor()['scope'])
    selected = authority._leases[lease]
    headers = {'Authorization': auth, 'X-Papeer-Host-Lease': lease, 'X-Papeer-Admission': admission}
    entered, release = threading.Event(), threading.Event()
    original = crypto.create_header

    def kdf(*args):
        value = original(*args); entered.set(); assert release.wait(10); return value

    monkeypatch.setattr(crypto, 'create_header', kdf)
    request = '00000000-0000-0000-0000-000000000077'
    with TestClient(app) as client:
        worker, replies, errors = request_thread(client, '/api/edits/provider-owner/offline/enroll', {'requestId': request, 'secret': 'real native maintenance passphrase'}, headers)
        try:
            assert entered.wait(5)
            token = authority._offline_jobs.enrollments[request]['jobToken']
            start(client, {'Authorization': auth})
            assert token.cancelled.wait(5) and not token.done.is_set()
            assert NativeLegacyInputs(root).read(preparation._current.status()['runId']) is None
        finally:
            release.set(); worker.join(10)
        assert errors == [] and [reply.status_code for reply in replies] == [403] and token.done.is_set()
        completed(client, root, {'Authorization': auth})
        with _existing(selected['path'], False) as db: rows = storage.read(db, selected['grant']['contextId'])
        assert rows['header'] is None and rows['grants'] == {} and rows['pending'] == {}


def test_real_provider_http_replication_group_cancels_before_actual_app_capture(runtime, real_provider, monkeypatch):
    from urllib.parse import urlparse
    from papeer.core.providers.drive import transport
    root, _device, _lock = runtime
    host, owner, plan, _activate, _put, _http = real_provider
    auth, lease = owner._authorization, owner._lease_id
    hub = NativeProviderHub(authority, host)
    token = hub._operations.capture_descriptor(auth, lease, plan['descriptor']['id'])
    selected = hub._operations.resolve(token, auth, lease)
    admission, _scope = authority.admit_provider(auth, lease, selected, selected.descriptor()['scope'])
    headers = {'Authorization': auth, 'X-Papeer-Host-Lease': lease, 'X-Papeer-Admission': admission, 'X-Papeer-Provider-Operation': token}
    monkeypatch.setattr(provider_owner, '_hub', hub)
    entered, cancelled, release, suspended = [threading.Event() for _ in range(4)]
    original = transport._open
    with TestClient(app) as client:
        reply = client.post('/api/edits/provider-owner/replication/open', json={}, headers=headers)
        assert reply.status_code == 200
        identity = reply.json()['replicationId']; replication = hub._replications[identity][2]
        old_suspend = replication.suspend

        def suspend(): old_suspend(); suspended.set()
        monkeypatch.setattr(replication, 'suspend', suspend)

        def held(request, timeout):
            if request.method == 'GET' and urlparse(request.full_url).path.endswith('/files'):
                group = host._request_group(); assert group is not None
                entered.set(); assert group._cancelled.wait(10); cancelled.set()
                assert release.wait(10); group.check()
                pytest.fail('cancelled group resumed transport')
            return original(request, timeout)

        monkeypatch.setattr(transport, '_open', held)
        worker, replies, errors = request_thread(client, '/api/edits/provider-owner/replication/flush', {'replicationId': identity}, headers)
        try:
            assert entered.wait(5)
            start(client, {'Authorization': auth})
            assert cancelled.wait(5) and suspended.wait(5)
            assert replication.snapshot()['running'] and not provider_owner._closing.host_closed
            assert preparation._current.wait(0)['state'] == 'running'
        finally:
            release.set(); worker.join(10)
        assert errors == [] and [reply.status_code for reply in replies] == [200]
        completed(client, root, {'Authorization': auth})
        assert replication.wait_drained(0) and provider_owner._closing.host_closed
        with pytest.raises((AuthorityError, ValueError), match='auth-changed|unauthorized|operation-invalid'):
            owner.assert_current()


def test_pending_destination_added_by_preadmitted_writer_is_rechecked_after_drain(runtime, monkeypatch):
    from papeer.core.fileio import atomic_write_json
    root, device, lock = runtime
    destination = root.parent / 'pending-destination'; destination.mkdir()
    (destination / 'old-body').write_bytes(b'destination must not be omitted or moved')
    value = {'path': str(root), 'pending': {'source': str(root), 'destination': str(destination)}}
    entered, release = held_request(monkeypatch, lambda: atomic_write_json(device / 'storage-location.json', value))
    with TestClient(app) as client:
        worker, replies, errors = request_thread(client, '/test-maintenance-held')
        try:
            assert entered.wait(5); start(client)
        finally:
            release.set(); worker.join(10)
        assert errors == [] and [reply.status_code for reply in replies] == [200]
        result = preparation._current.wait(10)
        assert result['state'] == 'failed' and result['failure'] == 'maintenance-pending-location-unresolved'
        assert lock.held and NativeLegacyInputs(root).read(result['runId']) is None
        assert json.loads((device / 'storage-location.json').read_text('utf8')) == value
        assert (destination / 'old-body').read_bytes() == b'destination must not be omitted or moved'


def test_concurrent_different_root_claim_releases_new_lock_if_maintenance_wins_install(runtime, monkeypatch):
    root, _device, retained = runtime
    other = root.parent / 'concurrent-library'; other.mkdir()
    acquired, resume = threading.Event(), threading.Event()
    captured, failures = [], []
    original = LibraryLock.try_acquire

    def paused(lock, selected):
        result = original(lock, selected)
        if selected == other and threading.current_thread().name == 'racing-library-claim':
            assert result and lock.held
            captured.append(lock); acquired.set(); assert resume.wait(10)
        return result

    monkeypatch.setattr(LibraryLock, 'try_acquire', paused)

    def claim():
        try: instance.claim_library(other, 'dev', wait=0)
        except ValueError as error: failures.append(str(error))

    thread = threading.Thread(target=claim, name='racing-library-claim'); thread.start()
    with TestClient(app) as client:
        try:
            assert acquired.wait(5)
            start(client)
            resume.set(); thread.join(5)
            assert not thread.is_alive() and failures == ['maintenance-lifetime-active']
            assert not captured[0].held, 'failed late installation must explicitly unlock the fresh handle'
            # A new claim is now deliberately fenced by device maintenance.
            # Probe the underlying OS Library lock directly to prove the failed
            # late install released it, without admitting any new writer.
            from papeer.core import file_lock, instance as discovery
            handle = file_lock.open_lock_file(discovery.lock_path(other))
            try: assert file_lock.try_lock(handle)
            finally: file_lock.unlock(handle)
            assert instance.current_library_lock(root) is retained and retained.held
            completed(client, root)
        finally:
            resume.set(); thread.join(10)
            # The expected-red old candidate must not leak its known fresh test
            # handle into teardown. This is only the exact captured other-root lock.
            for lock in captured: lock.release()
