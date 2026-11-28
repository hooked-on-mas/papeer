"""Every canonical /api/edits route rejects missing, forged, foreign, released and revoked capabilities.

The route set is enumerated from the running app so a newly added canonical route cannot escape this matrix
without being classified here. Rejections must leave every table of the canonical database unchanged.
"""
import hashlib
import json
import sqlite3
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from sidecar import deps
from sidecar.app import app
from papeer.core.edit_model import canonical_json
from sidecar.canonical_host import authority
from test_native_bootstrap_routes import AUTH, ROOT, F, established

TOKEN = AUTH['Authorization'].removeprefix('Bearer ')
OTHER = 'native-foreign-token'
ID = '00000000-0000-0000-0000-000000000077'

# Legacy management (backup, legacy drive/startup/inputs) is a separate authenticated management path.
MANAGEMENT = ('/api/edits/legacy-backup/', '/api/edits/backup-artifacts/', '/api/edits/legacy-drive/',
              '/api/edits/legacy-startup/', '/api/edits/legacy-inputs/', '/api/edits/legacy-maintenance/')
READS = {'read', 'receipt', 'pending', 'pending-records', 'pending-publications', 'checkpoint', 'datasets',
         'dataset-control', 'intent', 'pending-intents', 'read-resource', 'resource-metadata'}
WRITES = {'commit', 'publish', 'store-resource', 'replace-intent'}
PRIVILEGED = {'initialize', 'receive', 'receive-publications', 'receive-records', 'acknowledge-upload',
              'acknowledge-import', 'replace-dataset-control', 'install-dataset', 'install-checkpoint'}
DRIVE = {'drive/lease', 'drive/files', 'drive/check-lease', 'drive/read-json', 'drive/save-json',
         'drive/read-resource', 'drive/save-resource'}
BOOTSTRAP_LEASED = {'bootstrap/discover', 'bootstrap/peer', 'bootstrap/initialization/prepare',
                    'bootstrap/initialization/query', 'bootstrap/initialization/execute',
                    'bootstrap/initialization/acknowledge', 'bootstrap/inspect', 'bootstrap/revalidate',
                    'bootstrap/release'}
BOOTSTRAP_BEARER = {'bootstrap/local-context/read', 'bootstrap/local-context/provision'}
OFFLINE_LEASED = {'provider-owner/offline/unlock', 'provider-owner/offline/open',
                  'provider-owner/offline/revoke', 'provider-owner/offline/lock'}
OFFLINE_PROVIDER = {'provider-owner/offline/enroll', 'provider-owner/offline/query',
                    'provider-owner/offline/recover-enrollment', 'provider-owner/offline/revoke-enrollment'}
OFFLINE = OFFLINE_LEASED | OFFLINE_PROVIDER
OFFLINE_CLEANUP = {'provider-owner/offline/lock'}


PROVIDER_ATTEMPT = {'provider-owner/preload', 'provider-owner/connect', 'provider-owner/finish-connect',
                    'provider-owner/status', 'provider-owner/reconnect-saved', 'provider-owner/cancel-connect'}
PROVIDER_OWNER = {'provider-owner/resume-retained', 'provider-owner/cancel-resume',
                  'provider-owner/acknowledge-resume', 'provider-owner/discard-resumed',
                  'provider-owner/disconnect', 'provider-owner/release', 'provider-owner/list',
                  'provider-owner/health', 'provider-owner/create/prepare', 'provider-owner/query',
                  'provider-owner/join/prepare', 'provider-owner/execute', 'provider-owner/recoveries',
                  'provider-owner/acknowledge', 'provider-owner/open-installed', 'provider-owner/open-selected',
                  'provider-owner/replication/open', 'provider-owner/replication/status',
                  'provider-owner/replication/flush', 'provider-owner/replication/suspend',
                  'provider-owner/replication/resume'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    token = {'value': TOKEN}
    root = {'value': tmp_path / 'fixed-legacy'}
    monkeypatch.setenv('PAPEER_DATA_DIR', str(root['value']))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: token['value'])
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy library opened'))
    authority.revoke_all()
    with TestClient(app) as value:
        value.token, value.root = token, root
        yield value
    authority.revoke_all()


def _api_routes(routes, prefix=''):
    # FastAPI wraps included routers; walk them (and any nested include) down to the path operations.
    for route in routes:
        router = getattr(route, 'original_router', None)
        if router is not None:
            yield from _api_routes(router.routes, prefix + route.include_context.prefix)
        elif isinstance(route, APIRoute):
            yield prefix + route.path, route


def canonical_routes():
    found = set()
    for path, route in _api_routes(app.routes):
        if path.startswith('/api/edits/') and not path.startswith(MANAGEMENT):
            assert route.methods == {'POST'}, path
            found.add(path.removeprefix('/api/edits/'))
    assert found, 'no canonical route found; the route walker no longer matches FastAPI'
    return found


def database_rows():
    with sqlite3.connect(deps.get_canonical_storage_path()) as db:
        names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        return {name: db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall() for name in names}


def payloads(scope, request, handle):
    body = {'scope': scope}
    read = {**body, 'targetId': scope['libraryId']}
    resource = {**body, 'resourceId': ID}
    drive = {**body, 'folderId': 'folder', 'leaseId': 'unused'}
    return {
        'read': read, 'intent': read, 'receipt': {**body, 'batchId': F['rootVersion']},
        'pending': scope, 'pending-records': scope, 'pending-publications': scope, 'checkpoint': scope,
        'datasets': scope, 'dataset-control': scope, 'pending-intents': scope,
        'read-resource': resource, 'resource-metadata': resource,
        'commit': {**body, 'batch': {'kind': 'library', 'id': ID, 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'],
                                     'parents': [F['rootVersion']], 'changes': [{'type': 'put-folder', 'folder': {
                                         'id': '00000000-0000-0000-0000-000000000078', 'title': 'Denied', 'parentId': None, 'position': 0}}]}},
        'publish': {**body, 'publication': {}},
        'store-resource': {**resource, 'sha256': '0' * 64, 'mediaType': 'application/octet-stream', 'dataBase64': 'AA=='},
        'replace-intent': {**read, 'record': None, 'expectedId': None},
        'initialize': {**body, 'root': {}}, 'receive': {**body, 'batches': []},
        'receive-publications': {**body, 'batches': [], 'publications': []}, 'receive-records': {**body, 'records': []},
        'acknowledge-upload': {**body, 'batchId': F['rootVersion']},
        'acknowledge-import': {**body, 'batchId': F['rootVersion'], 'peerId': F['peer']['peerId']},
        'replace-dataset-control': {**body, 'record': {}, 'expectedId': None},
        'install-dataset': {**body, 'manifest': {}, 'checkpoint': {}}, 'install-checkpoint': {**body, 'checkpoint': {}},
        'drive/lease': {**body, 'folderId': 'folder'}, 'drive/files': drive, 'drive/check-lease': drive,
        'drive/read-json': {**drive, 'fileId': 'id'}, 'drive/save-json': {**drive, 'editId': F['requestId'], 'value': {}},
        'drive/read-resource': {**drive, 'metadata': {}, 'blobId': 'id'},
        'drive/save-resource': {**drive, 'metadata': {}, 'dataBase64': ''},
        'bootstrap/discover': {}, 'bootstrap/peer': {}, 'bootstrap/initialization/prepare': {'request': request},
        'bootstrap/initialization/query': {'requestId': request['control']['id']},
        'bootstrap/initialization/execute': {'requestId': request['control']['id']},
        'bootstrap/initialization/acknowledge': {'requestId': request['control']['id']},
        'bootstrap/inspect': {'handleId': handle}, 'bootstrap/revalidate': {}, 'bootstrap/release': {},
        **{path: {'secret': 'matrix-passphrase-42', 'requestId': ID}
           for path in ('provider-owner/offline/enroll', 'provider-owner/offline/query')},
        **{path: {'secret': 'matrix-passphrase-42'}
           for path in ('provider-owner/offline/unlock', 'provider-owner/offline/recover-enrollment',
                        'provider-owner/offline/revoke-enrollment')},
        **{path: {'unlockSession': 'matrix-unlock-session-canary', 'handle': 'matrix-handle-canary'}
           for path in ('provider-owner/offline/open', 'provider-owner/offline/revoke')},
        'provider-owner/offline/lock': {},
    }


def second_capability(client, authorization):
    lease = client.post(ROOT + '/local-context/read', json={}, headers={'Authorization': authorization}).json()['leaseId']
    headers = {'Authorization': authorization, 'X-Papeer-Host-Lease': lease}
    handle = client.post(ROOT + '/discover', json={}, headers=headers).json()['libraries'][0]['handleId']
    admission = client.post(ROOT + '/inspect', json={'handleId': handle}, headers=headers).json()['admissionId']
    return lease, admission


def assert_denied(client, path, body, headers, expected=403, params=None):
    response = client.post('/api/edits/' + path, json=body, headers=headers, params=params)
    assert response.status_code == expected, (path, headers.keys(), response.status_code, response.text)
    assert response.headers['cache-control'] == 'no-store', path
    text = response.text
    for secret in (TOKEN, OTHER, headers.get('X-Papeer-Host-Lease') or TOKEN, headers.get('X-Papeer-Admission') or TOKEN):
        assert secret not in text, path
    if path in OFFLINE:
        for key in ('secret', 'unlockSession', 'handle'):
            if key in body:
                assert body[key] not in text, path


def test_every_canonical_route_is_classified():
    assert canonical_routes() == READS | WRITES | PRIVILEGED | DRIVE | BOOTSTRAP_LEASED | BOOTSTRAP_BEARER | PROVIDER_ATTEMPT | PROVIDER_OWNER | OFFLINE


def test_every_canonical_route_rejects_missing_forged_foreign_released_and_revoked_capabilities(client, monkeypatch):
    lease, headers, scope, request = established(client)
    admission = headers['X-Papeer-Admission']
    handle = client.post(ROOT + '/discover', json={}, headers=headers).json()['libraries'][0]['handleId']
    body = payloads(scope, request, handle)
    assert set(body) == canonical_routes() - BOOTSTRAP_BEARER - PROVIDER_ATTEMPT - PROVIDER_OWNER
    # A second capability for the same owner: its admission must not be usable with the first lease.
    other_lease, other_admission = second_capability(client, AUTH['Authorization'])
    # A capability issued to another bearer (rotated token) is foreign to the configured bearer.
    client.token['value'] = OTHER
    foreign_lease, foreign_admission = second_capability(client, 'Bearer ' + OTHER)
    client.token['value'] = TOKEN
    before = database_rows()

    edits = READS | WRITES | PRIVILEGED
    variants = {
        'missing-lease-and-admission': AUTH,
        'missing-admission': {**AUTH, 'X-Papeer-Host-Lease': lease},
        'missing-lease': {**AUTH, 'X-Papeer-Admission': admission},
        'forged-lease': {**AUTH, 'X-Papeer-Host-Lease': 'forged', 'X-Papeer-Admission': admission},
        'forged-admission': {**headers, 'X-Papeer-Admission': 'forged'},
        'admission-of-other-lease': {**headers, 'X-Papeer-Admission': other_admission},
        'lease-of-other-admission': {**AUTH, 'X-Papeer-Host-Lease': other_lease, 'X-Papeer-Admission': admission},
        'foreign-bearer-capability': {**AUTH, 'X-Papeer-Host-Lease': foreign_lease, 'X-Papeer-Admission': foreign_admission},
    }
    for name, bad in variants.items():
        for path in sorted(edits | DRIVE | OFFLINE_PROVIDER):
            assert_denied(client, path, body[path], bad)
        # With a current lease, only the admission-bearing bootstrap route is affected by a bad admission.
        current_lease = bad.get('X-Papeer-Host-Lease') in (lease, other_lease)
        if not current_lease:
            for path in sorted(OFFLINE_LEASED):
                assert_denied(client, path, body[path], bad)
        for path in (['bootstrap/revalidate'] if current_lease else sorted(BOOTSTRAP_LEASED)):
            assert_denied(client, path, body[path], bad)
    # The configured bearer must arrive as a header; a query credential passes verify_token but grants no owner authority.
    for path in sorted(edits | BOOTSTRAP_LEASED | OFFLINE):
        assert_denied(client, path, body[path], {'X-Papeer-Host-Lease': lease, 'X-Papeer-Admission': admission}, params={'token': TOKEN})
    for path in sorted(edits | DRIVE | BOOTSTRAP_LEASED | BOOTSTRAP_BEARER | OFFLINE):
        assert_denied(client, path, body.get(path, {}), {**headers, 'Authorization': 'Bearer wrong'}, expected=401)
        assert_denied(client, path, body.get(path, {}), {k: v for k, v in headers.items() if k != 'Authorization'}, expected=401)
    assert database_rows() == before

    # Positive control: the valid capability still reads every read route and never mutates on these bodies.
    for path in sorted(READS):
        response = client.post('/api/edits/' + path, json=body[path], headers=headers)
        assert response.status_code == 200, (path, response.text)
    assert client.post('/api/edits/replace-intent', json=body['replace-intent'], headers=headers).json() == {'status': 'cleared'}
    for path in sorted(PRIVILEGED | DRIVE):
        assert_denied(client, path, body[path], headers)
    # A valid local lease/admission does not authorize provider enrollment.
    # Nor do fabricated unlock handles grant access. Lock is deliberately
    # lease-only and idempotent, so a missing admission must not reject it.
    for path in sorted(OFFLINE - {'provider-owner/offline/lock'}):
        assert_denied(client, path, body[path], headers)
    locked = client.post('/api/edits/provider-owner/offline/lock', json={}, headers={'Authorization': AUTH['Authorization'], 'X-Papeer-Host-Lease': lease})
    assert locked.status_code == 200 and locked.json() == {'status': 'locked'}
    assert database_rows() == before

    # Released lease: every route rejects it afterwards.
    assert client.post(ROOT + '/release', json={}, headers=headers).json() == {'status': 'released'}
    for path in sorted(edits | DRIVE | BOOTSTRAP_LEASED | OFFLINE):
        assert_denied(client, path, body[path], headers)
    # Released admission only (lease still current) denies normal routes.
    other = {**AUTH, 'X-Papeer-Host-Lease': other_lease, 'X-Papeer-Admission': other_admission}
    assert client.post('/api/edits/pending', json=scope, headers=other).status_code == 200
    assert client.post(ROOT + '/release', json={'admissionId': other_admission}, headers=other).json() == {'status': 'released'}
    for path in sorted(edits | DRIVE | OFFLINE_PROVIDER | {'bootstrap/revalidate'}):
        assert_denied(client, path, body[path], other)
    # A lease bound to another server-selected data root is foreign there, and current again at its own root.
    other = {**AUTH, 'X-Papeer-Host-Lease': other_lease}
    assert client.post(ROOT + '/discover', json={}, headers=other).status_code == 200
    own_root = client.root['value']
    client.root['value'] = own_root.parent / 'other-root'
    monkeypatch.setenv('PAPEER_DATA_DIR', str(client.root['value']))
    for path in sorted(BOOTSTRAP_LEASED | OFFLINE):
        assert_denied(client, path, body[path], other)
    assert not deps.get_canonical_storage_path().exists()
    client.root['value'] = own_root
    monkeypatch.setenv('PAPEER_DATA_DIR', str(own_root))
    # Revoked generation: the remaining live lease, a fresh admission and a fresh handle are rejected everywhere.
    fresh = client.post(ROOT + '/discover', json={}, headers=other).json()['libraries'][0]['handleId']
    other['X-Papeer-Admission'] = client.post(ROOT + '/inspect', json={'handleId': fresh}, headers=other).json()['admissionId']
    assert client.post('/api/edits/pending', json=scope, headers=other).status_code == 200
    body['bootstrap/inspect'] = {'handleId': fresh}
    authority.revoke_all()
    for path in sorted(edits | DRIVE | BOOTSTRAP_LEASED | OFFLINE):
        assert_denied(client, path, body[path], other)
    assert database_rows() == before


def test_every_canonical_route_rejects_a_lease_expired_by_grant_rotation(client):
    lease, headers, scope, request = established(client)
    handle = client.post(ROOT + '/discover', json={}, headers=headers).json()['libraries'][0]['handleId']
    body = payloads(scope, request, handle)
    assert client.post('/api/edits/pending', json=scope, headers=headers).status_code == 200
    # Durable grant rotation (a new owner revision): the in-memory lease, admission and handle are now expired.
    with sqlite3.connect(deps.get_canonical_storage_path()) as db:
        grant = json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0])
        grant['revision'] = '00000000-0000-0000-0000-000000000099'
        db.execute('UPDATE canonical_local_owner_grants SET payload=?', (json.dumps(grant),))
    # store-resource with self-consistent bytes, so its stateless hash check cannot answer before the authority.
    body['store-resource'] = {**body['store-resource'], 'sha256': hashlib.sha256(b'\x00').hexdigest(), 'dataBase64': 'AA=='}
    before = database_rows()
    for path in sorted((READS | WRITES | PRIVILEGED | DRIVE | BOOTSTRAP_LEASED | OFFLINE) - {'bootstrap/release', 'publish'} - OFFLINE_CLEANUP):
        assert_denied(client, path, body[path], headers)
    assert database_rows() == before
    # Offline lock, like release, may retire its own authority after durable
    # grant rotation. It authorizes no read/write/admission and changes no rows.
    # Cross-lease cleanup isolation is also exercised with real unlocked owners
    # in tests/providers/drive/test_native_offline_scoped_lock.py.
    cleanup = client.post('/api/edits/provider-owner/offline/lock', json={}, headers=headers)
    assert cleanup.status_code == 200 and cleanup.json() == {'status': 'locked'}
    assert database_rows() == before
    # publish validates the payload statelessly before its transaction: an invalid body gets the same 'aborted'
    # answer it would get under any capability (no stored state involved); a valid body reaches the grant check.
    stateless = client.post('/api/edits/publish', json=body['publish'], headers=headers)
    assert stateless.status_code == 200 and stateless.json()['status'] == 'aborted'
    assert stateless.json()['reason'].startswith('Invalid edit data')
    assert database_rows() == before
    # Release is not an authorizing route: dropping the expired in-memory capability grants nothing, writes nothing,
    # and leaves that lease unusable everywhere afterwards.
    assert client.post(ROOT + '/release', json={}, headers=headers).json() == {'status': 'released'}
    for path in sorted(READS | BOOTSTRAP_LEASED | OFFLINE):
        assert_denied(client, path, body[path], headers)
    assert database_rows() == before
    # Positive control: only a newly issued lease for the rotated grant is current again.
    fresh = {**AUTH, 'X-Papeer-Host-Lease': client.post(ROOT + '/local-context/read', json={}, headers=AUTH).json()['leaseId']}
    fresh_handle = client.post(ROOT + '/discover', json={}, headers=fresh).json()['libraries'][0]['handleId']
    fresh['X-Papeer-Admission'] = client.post(ROOT + '/inspect', json={'handleId': fresh_handle}, headers=fresh).json()['admissionId']
    assert client.post('/api/edits/pending', json=scope, headers=fresh).status_code == 200
    assert_denied(client, 'pending', scope, {**fresh, 'X-Papeer-Host-Lease': lease})
    assert database_rows() == before


def test_valid_publication_rejects_cross_scope_and_rotated_grant_then_succeeds(client):
    lease, headers, scope, _ = established(client)
    fixture = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))
    publication = deepcopy(next(entry['value'] for entry in fixture['publications'] if entry['name'] == 'markdown'))
    batch = publication['libraryBatch']
    batch.update(libraryId=scope['libraryId'], targetId=scope['libraryId'], parents=[F['rootVersion']])
    before = database_rows()
    for key, value in (('accountId', 'foreign-account'), ('libraryId', ID), ('epoch', 'foreign-epoch')):
        other_scope = {**scope, key: value}
        other_publication = deepcopy(publication)
        other_publication['libraryBatch'].update(libraryId=other_scope['libraryId'], targetId=other_scope['libraryId'])
        assert_denied(client, 'publish', {'scope': other_scope, 'publication': other_publication}, headers)
        assert database_rows() == before

    with sqlite3.connect(deps.get_canonical_storage_path()) as db:
        grant = json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0])
        grant['revision'] = '00000000-0000-0000-0000-000000000099'
        db.execute('UPDATE canonical_local_owner_grants SET payload=?', (json.dumps(grant),))
    rotated = database_rows()
    body = {'scope': scope, 'publication': publication}
    assert_denied(client, 'publish', body, headers)
    assert database_rows() == rotated

    fresh = {**AUTH, 'X-Papeer-Host-Lease': client.post(ROOT + '/local-context/read', json={}, headers=AUTH).json()['leaseId']}
    handle = client.post(ROOT + '/discover', json={}, headers=fresh).json()['libraries'][0]['handleId']
    fresh['X-Papeer-Admission'] = client.post(ROOT + '/inspect', json={'handleId': handle}, headers=fresh).json()['admissionId']
    assert fresh['X-Papeer-Host-Lease'] != lease
    result = client.post('/api/edits/publish', json=body, headers=fresh)
    assert result.status_code == 200 and result.json()['status'] == 'durable', result.text
    assert client.post('/api/edits/pending-publications', json=scope, headers=fresh).json() == [publication]


def test_stored_corruption_through_the_api_is_not_an_aborted_receipt(client):
    """StorageIntegrityError stays outside ValueError/sqlite3.Error: the authorized API must not answer 'aborted'."""
    _, headers, scope, _ = established(client)
    batch = {'kind': 'library', 'id': ID, 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'], 'parents': [F['rootVersion']],
             'changes': [{'type': 'put-folder', 'folder': {'id': '00000000-0000-0000-0000-000000000078', 'title': 'Denied', 'parentId': None, 'position': 0}}]}
    saved = {**batch, 'id': '00000000-0000-0000-0000-000000000079'}  # physical key ID, payload of another id
    receipt = {'id': ID, 'targetId': scope['libraryId'], 'durable': True, 'upload': 'pending', 'importedBy': []}
    with sqlite3.connect(deps.get_canonical_storage_path()) as db:
        db.execute('INSERT INTO edit_batches VALUES (?,?,?,?,?,?)', (canonical_json([scope['accountId'], scope['libraryId'], scope['epoch']]),
                   ID, scope['libraryId'], canonical_json(saved), canonical_json(receipt), None))
    before = database_rows()
    # The Core raises StorageIntegrityError (not ValueError/sqlite3.Error), so the app answers it as an unexpected
    # error (500) instead of a 200 'aborted' receipt or a 400 refusal that would let the client discard the intent.
    for path, value in (('commit', {'scope': scope, 'batch': batch}), ('receipt', {'scope': scope, 'batchId': ID}), ('pending', scope)):
        response = client.post('/api/edits/' + path, json=value, headers=headers)
        assert response.status_code == 500, (path, response.status_code, response.text)
        assert 'aborted' not in response.text and 'durable' not in response.text and 'Denied' not in response.text, path
        assert database_rows() == before


def test_provider_owner_routes_reject_bad_capabilities_before_network_or_storage(client, monkeypatch):
    # Synthetic verifier supplies identity only for constructing a genuine owner operation.
    # Any verifier network method reached by a denial fails the test.
    from contextlib import contextmanager
    from sidecar.provider.hub import NativeProviderHub
    from sidecar.routes import provider_owner
    class Verifier:
        def __init__(self): self.generation = 1
        def current(self): return {'digest': 'a' * 64, 'generation': self.generation}
        def assert_current(self, principal):
            if principal['generation'] != self.generation: raise ValueError('provider-stale')
        @contextmanager
        def guard(self, principal): self.assert_current(principal); yield; self.assert_current(principal)
        @contextmanager
        def operation_guard(self, principal): self.assert_current(principal); yield; self.assert_current(principal)
        def new_request_group(self):
            class Group:
                def check(self): pass
                def cancel(self): pass
                def close(self): pass
            return Group()
        @contextmanager
        def io_scope(self, group): yield
        def _request_group(self): return None
        def close(self): pass
        def __getattr__(self, name): pytest.fail('unexpected provider network or host access: ' + name)
    lease, headers, scope, request = established(client)
    other_lease, _ = second_capability(client, AUTH['Authorization'])
    client.token['value'] = OTHER
    foreign_lease, _ = second_capability(client, 'Bearer ' + OTHER)
    client.token['value'] = TOKEN
    verifier = Verifier(); hub = NativeProviderHub(authority, verifier)
    monkeypatch.setattr(provider_owner, 'hub', lambda: hub)
    operation = hub._operations.capture_owner(AUTH['Authorization'], lease)
    revoked = hub._operations.capture_owner(AUTH['Authorization'], lease)
    hub._operations.revoke(revoked)
    bodies = {path: {} for path in PROVIDER_OWNER}
    for path in ('query', 'execute', 'acknowledge', 'open-installed'):
        bodies['provider-owner/' + path] = {'requestId': ID}
    bodies['provider-owner/resume-retained'] = {'requestId': ID, 'attemptId': ID}
    for path in ('cancel-resume', 'acknowledge-resume'):
        bodies['provider-owner/' + path] = {'attemptId': ID}
    bodies['provider-owner/create/prepare'] = {'requestId': ID, 'title': 'test'}
    bodies['provider-owner/join/prepare'] = {'requestId': ID, 'handleId': 'forged'}
    bodies['provider-owner/open-selected'] = {'handleId': 'forged'}
    for path in ('status', 'flush', 'suspend', 'resume'):
        bodies['provider-owner/replication/' + path] = {'replicationId': 'forged'}
    variants = [AUTH, {**AUTH, 'X-Papeer-Host-Lease': lease},
                {**AUTH, 'X-Papeer-Provider-Operation': operation},
                {**AUTH, 'X-Papeer-Host-Lease': 'forged', 'X-Papeer-Provider-Operation': operation},
                {**AUTH, 'X-Papeer-Host-Lease': lease, 'X-Papeer-Provider-Operation': 'forged'},
                {**AUTH, 'X-Papeer-Host-Lease': other_lease, 'X-Papeer-Provider-Operation': operation},
                {**AUTH, 'X-Papeer-Host-Lease': foreign_lease, 'X-Papeer-Provider-Operation': operation},
                {**AUTH, 'X-Papeer-Host-Lease': lease, 'X-Papeer-Provider-Operation': revoked}]
    before = database_rows()
    for bad in variants:
        for path in sorted(PROVIDER_OWNER): assert_denied(client, path, bodies[path], bad)
    no_attempt_id = {'provider-owner/preload', 'provider-owner/reconnect-saved'}
    for path in sorted(PROVIDER_ATTEMPT | PROVIDER_OWNER):
        body = {'attemptId': ID} if path in PROVIDER_ATTEMPT - no_attempt_id else bodies.get(path, {})
        assert_denied(client, path, body, {'Authorization': 'Bearer wrong'}, expected=401)
        assert_denied(client, path, body, {}, expected=401)
        if path != 'provider-owner/preload':
            assert_denied(
                client,
                path,
                body,
                {'X-Papeer-Host-Lease': lease, 'X-Papeer-Provider-Operation': operation},
                params={'token': TOKEN},
            )
    # Cleanup-only exception: an exact registered attempt may cancel again even
    # though its original operation/lease was consumed. It cannot mint/read/write.
    cleanup_lease, _ = second_capability(client, AUTH['Authorization'])
    cleanup_op = hub._operations.capture_owner(AUTH['Authorization'], cleanup_lease)
    cleanup_headers = {**AUTH, 'X-Papeer-Host-Lease': cleanup_lease, 'X-Papeer-Provider-Operation': cleanup_op}
    next_op = hub._operations.capture_owner(AUTH['Authorization'], other_lease)
    attempt = '00000000-0000-4000-8000-000000000088'
    wrong_attempt = '00000000-0000-4000-8000-000000000089'
    response = client.post('/api/edits/provider-owner/cancel-resume', json={'attemptId':attempt}, headers=cleanup_headers)
    assert response.status_code == 200 and response.json() == {'cancelled':True, 'settled':True}
    response = client.post('/api/edits/provider-owner/cancel-resume', json={'attemptId':attempt}, headers=cleanup_headers)
    assert response.status_code == 200 and response.json()['settled'] is True
    for path, body in (
        ('cancel-resume', {'attemptId':wrong_attempt}),
        ('acknowledge-resume', {'attemptId':attempt}),
        ('resume-retained', {'attemptId':attempt, 'requestId':ID}),
        ('discard-resumed', {}),
    ):
        assert_denied(client, 'provider-owner/' + path, body, cleanup_headers)
    # Old cleanup cannot touch the newer independent operation or its lease.
    assert hub._operations.resolve_cancel(next_op, AUTH['Authorization'], other_lease)
    for bad in ({**cleanup_headers, 'Authorization':'Bearer ' + OTHER},
                {**cleanup_headers, 'X-Papeer-Host-Lease':other_lease},
                {**cleanup_headers, 'X-Papeer-Provider-Operation':next_op}):
        assert_denied(client, 'provider-owner/cancel-resume', {'attemptId':attempt}, bad,
                      expected=401 if bad['Authorization'] != AUTH['Authorization'] else 403)
    client.token['value'] = OTHER
    try:
        assert_denied(client, 'provider-owner/cancel-resume', {'attemptId':attempt}, cleanup_headers, expected=401)
    finally:
        client.token['value'] = TOKEN
    assert hub._operations.resolve_cancel(next_op, AUTH['Authorization'], other_lease)
    assert database_rows() == before
    # A valid operation tied to the released lease must be denied too.
    assert client.post(ROOT + '/release', json={}, headers=headers).json()['status'] == 'released'
    released = {**AUTH, 'X-Papeer-Host-Lease': lease, 'X-Papeer-Provider-Operation': operation}
    for path in sorted(PROVIDER_OWNER): assert_denied(client, path, bodies[path], released)
    assert database_rows() == before
    hub.close()
