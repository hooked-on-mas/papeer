"""Test harness for API fixtures that formerly patched ``deps.get_edit_connection``.

Real configured bearer, fixed temporary data root and durable local grant. The library profile, peer,
active dataset control and manifest are seeded at the grant namespace; library content is seeded through
the test-only Core harness (tests/native_core_test_authority.py). API calls then use a lease from
``/local-context/read`` and an admission from the real ``/discover`` + ``/inspect`` routes, so every
``/api/edits`` request goes through the server-selected authority. Owner-closed routes stay closed.
"""
from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient

from native_core_test_authority import core_repository, provision_for_core_test
from papeer.core.bootstrap.canonical_local_grant_sqlite import provision_local_grant
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.edit_model import canonical_json
from papeer.core import paths
from sidecar import deps
from sidecar.app import app
from sidecar.canonical_host import authority

F = json.loads((Path(__file__).parent / 'fixtures/canonical-bootstrap.json').read_text(encoding='utf8'))
TOKEN = 'native-owner-api-token'
AUTH = {'Authorization': 'Bearer ' + TOKEN}
BOOTSTRAP = '/api/edits/bootstrap'


class OwnerApi:
    def __init__(self, client, headers, scope, connection, path):
        self.client, self.headers, self.scope, self.connection, self.path = client, headers, scope, connection, path

    def post(self, route, body):
        return self.client.post('/api/edits/' + route, json=body, headers=self.headers)

    def core(self, scope=None):
        """Test-only Core repository on the same canonical database (seeding/inspection only)."""
        return core_repository(self.connection, scope or self.scope)

    def rows(self):
        with closing(sqlite3.connect(self.path)) as db:
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            return {name: db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall() for name in names}


def owner_scope(scope, account):
    return {**scope, 'accountId': account}


@contextmanager
def owner_api(tmp_path, monkeypatch, library_id, epoch, seed=None, data_dir=None):
    """Yield an OwnerApi whose admitted scope is {grant namespace, library_id, epoch}."""
    data_dir = data_dir or tmp_path / 'owner-data'
    monkeypatch.setenv('PAPEER_DATA_DIR', str(data_dir))
    monkeypatch.setattr(paths, 'device_directory', lambda: tmp_path / 'owner-device')
    monkeypatch.setattr(deps, 'get_auth_token', lambda: TOKEN)
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy library opened'))
    authority.revoke_all()
    path = deps.get_canonical_storage_path(); path.parent.mkdir(parents=True, exist_ok=True)
    account = provision_local_grant(path)['namespaceId']

    @contextmanager
    def connection():
        with closing(sqlite3.connect(path)) as db, db:
            yield db

    provision_for_core_test(connection)
    scope = {'accountId': account, 'libraryId': library_id, 'epoch': epoch}
    identity = {'accountId': account, 'libraryId': library_id}
    profile = deepcopy(F['profile']); profile['identity'] = identity; profile['origin']['installedScope'] = scope
    checkpoint = {'version': 1, 'libraryId': library_id, 'roots': [{'kind': 'library', 'id': library_id, 'version': F['rootVersion'],
                  'items': [], 'folders': [], 'links': [], 'deletions': []}], 'edits': []}
    manifest = {'version': 1, 'id': F['manifestId'], 'scope': scope, 'checkpointSha256': checkpoint_hash(checkpoint), 'resources': []}
    control = {'version': 1, 'id': F['requestId'], 'identity': identity, 'epochs': [epoch], 'active': manifest,
               'transition': {'id': F['requestId'], 'mode': 'initialize', 'source': None, 'phase': 'activated',
                              'publication': {'manifest': manifest, 'checkpoint': checkpoint, 'checkpointObjectId': F['checkpointObjectId']}}}
    key = canonical_json([account, library_id])
    with connection() as db:
        db.execute('INSERT INTO canonical_profiles VALUES (?,?,?,?,?)', (key, account, library_id, None, canonical_json(profile)))
        db.execute('INSERT INTO canonical_peers VALUES (?,?)', (account, canonical_json({**F['peer'], 'accountId': account})))
        db.execute('INSERT INTO edit_dataset_controls VALUES (?,?,?,?,?,?)', (key, canonical_json(control), epoch, None, 0, canonical_json([epoch])))
        db.execute('INSERT INTO edit_datasets VALUES (?,?,?)', (canonical_json([account, library_id, epoch]), manifest['id'], canonical_json(manifest)))
    if seed:
        seed(core_repository(connection, scope))
    try:
        with TestClient(app) as client:
            lease = client.post(BOOTSTRAP + '/local-context/read', json={}, headers=AUTH).json()['leaseId']
            headers = {**AUTH, 'X-Papeer-Host-Lease': lease}
            listing = client.post(BOOTSTRAP + '/discover', json={}, headers=headers).json()['libraries']
            assert [entry['status'] for entry in listing] == ['available'], listing
            proof = client.post(BOOTSTRAP + '/inspect', json={'handleId': listing[0]['handleId']}, headers=headers).json()
            assert proof['scope'] == scope
            yield OwnerApi(client, {**headers, 'X-Papeer-Admission': proof['admissionId']}, scope, connection, path)
    finally:
        authority.revoke_all()
