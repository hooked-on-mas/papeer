"""Real bearer, grant and SQLite transaction tests for the candidate hooks."""
from copy import deepcopy
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import pytest

from papeer.core.bootstrap.canonical_initialization_sqlite import SqliteCanonicalInitialization
from papeer.core.bootstrap.canonical_local_grant_sqlite import provision_local_grant
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.edit_repository import SqliteEditRepository
from sidecar import deps
from sidecar.canonical_host import AuthorityError, NativeAuthority, canonical_storage_path

F = json.loads((Path(__file__).parent / 'fixtures/canonical-bootstrap.json').read_text(encoding='utf8'))

@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setenv('PAPEER_DATA_DIR',str(tmp_path / 'legacy'))
    monkeypatch.setattr(deps,'get_auth_token',lambda: 'test-real-token')
    monkeypatch.setattr(deps,'get_library',lambda: pytest.fail('legacy opened'))
    authority = NativeAuthority(); auth = 'Bearer test-real-token'; lease_id = authority.provision(auth)
    return authority, auth, lease_id, canonical_storage_path()

def initial_request(account):
    profile = deepcopy(F['profile']); profile.pop('origin'); profile.pop('initialization'); profile['identity']['accountId'] = account
    library = profile['identity']['libraryId']; scope = {**profile['identity'],'epoch':F['epoch']}
    checkpoint = {'version':1,'libraryId':library,'roots':[{'kind':'library','id':library,'version':F['rootVersion'],'items':[],'folders':[],'links':[],'deletions':[]}],'edits':[]}
    manifest = {'version':1,'id':F['manifestId'],'scope':scope,'checkpointSha256':checkpoint_hash(checkpoint),'resources':[]}
    control = {'version':1,'id':F['requestId'],'identity':profile['identity'],'epochs':[F['epoch']],'active':manifest,'transition':{'id':F['requestId'],'mode':'initialize','source':None,'phase':'activated','publication':{'manifest':manifest,'checkpoint':checkpoint,'checkpointObjectId':F['checkpointObjectId']}}}
    return {'expectedPeerId':F['peer']['peerId'],'profile':profile,'control':control}

def test_explicit_schema_provision_readonly_open_and_scope(owner):
    authority, auth, lease_id, path = owner; bootstrap = authority.bind_initialization(auth,lease_id)
    store = SqliteCanonicalInitialization(); request = initial_request(bootstrap.account_id)
    assert store.get_or_create_peer(bootstrap,request['expectedPeerId'])['peerId'] == request['expectedPeerId']
    assert store.prepare(bootstrap,request)['status'] == 'pending'
    accepted = store.execute(bootstrap,request['control']['id']); assert accepted['status'] == 'accepted'
    store.acknowledge(bootstrap,request['control']['id']); assert store.query(bootstrap,request['control']['id']) == accepted
    admission, scope = authority.admit(auth,lease_id,request['profile']['identity']['libraryId'])
    bound = authority.bind_repository(auth,lease_id,admission)
    with sqlite3.connect(path) as db: before = db.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall()
    repo = SqliteEditRepository(bound,scope)
    assert repo.read(scope['libraryId'])['checkpoint']['root']['id'] == scope['libraryId']
    assert repo.pending() == [] and repo.pending_intents() == []
    assert repo.dataset_control()['active']['scope'] == scope
    with sqlite3.connect(path) as db: assert db.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall() == before
    with pytest.raises(ValueError,match='authority-required'): SqliteEditRepository(lambda: None,scope)
    with pytest.raises(AuthorityError): repo.acknowledge(F['rootVersion'])
    with pytest.raises(AuthorityError): repo.initialize(request['control']['transition']['publication']['checkpoint']['roots'][0])
    wrong = SqliteEditRepository(bound,{**scope,'epoch':'other'})
    with pytest.raises(AuthorityError): wrong.pending()
    authority.revoke_all()
    with pytest.raises(AuthorityError): repo.pending()
    with pytest.raises(AuthorityError): store.query(bootstrap,request['control']['id'])
    edits = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))
    batch = deepcopy(edits['batches'][0]); batch['libraryId'] = scope['libraryId']
    # A revoked lease is an unknown authority failure, not a definitive aborted receipt.
    with pytest.raises(AuthorityError): repo.commit(batch)

def test_repository_resource_checks_grant_in_same_write_transaction(owner):
    authority, auth, lease_id, path = owner; bootstrap = authority.bind_initialization(auth,lease_id); store = SqliteCanonicalInitialization()
    request = initial_request(bootstrap.account_id); store.get_or_create_peer(bootstrap,request['expectedPeerId']); store.prepare(bootstrap,request); store.execute(bootstrap,request['control']['id'])
    admission, scope = authority.admit(auth,lease_id,request['profile']['identity']['libraryId'])
    bound = authority.bind_repository(auth,lease_id,admission); repo = SqliteEditRepository(bound,scope)
    body = b'opaque-resource'; digest = hashlib.sha256(body).hexdigest(); resource_id = '00000000-0000-0000-0000-000000000098'
    metadata = repo.store_resource(resource_id,digest,'application/octet-stream',body)
    assert metadata['sha256'] == digest and repo.read_resource(resource_id)['bytes'] == body
    with sqlite3.connect(path) as db:
        grant = json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0]); grant['revision'] = '00000000-0000-0000-0000-000000000099'
        db.execute('UPDATE canonical_local_owner_grants SET payload=?',(json.dumps(grant),))
    with pytest.raises(AuthorityError): repo.store_resource('00000000-0000-0000-0000-000000000097',digest,'application/octet-stream',body)
    with sqlite3.connect(path) as db: assert db.execute('SELECT count(*) FROM edit_resources').fetchone()[0] == 1

def test_incomplete_schema_is_only_resumed_when_empty(tmp_path,monkeypatch):
    monkeypatch.setenv('PAPEER_DATA_DIR',str(tmp_path / 'legacy')); monkeypatch.setattr(deps,'get_auth_token',lambda: 'test-real-token')
    path = canonical_storage_path(); path.parent.mkdir(); provision_local_grant(path); authority = NativeAuthority(); auth = 'Bearer test-real-token'
    with pytest.raises(AuthorityError,match='setup-required'): authority.issue(auth)
    lease = authority.provision(auth); assert lease
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('occupied','target','value')); db.execute('DROP TABLE edit_batches')
    with pytest.raises(AuthorityError,match='recovery-required'): authority.provision(auth)
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT payload FROM edit_roots').fetchone()[0] == 'value'
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_batches'").fetchone()

def test_repository_write_rolls_back_when_grant_changes_before_commit(owner,monkeypatch):
    authority, auth, lease_id, path = owner; bootstrap = authority.bind_initialization(auth,lease_id); store = SqliteCanonicalInitialization()
    request = initial_request(bootstrap.account_id); store.get_or_create_peer(bootstrap,request['expectedPeerId']); store.prepare(bootstrap,request); store.execute(bootstrap,request['control']['id'])
    admission, scope = authority.admit(auth,lease_id,request['profile']['identity']['libraryId'])
    bound = authority.bind_repository(auth,lease_id,admission); repo = SqliteEditRepository(bound,scope); original = bound.transaction
    @contextmanager
    def mutate_at_end(operation,requested_scope):
        with original(operation,requested_scope) as db:
            yield db
            if operation == 'store-resource':
                grant = json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0])
                grant['revision'] = '00000000-0000-0000-0000-000000000099'
                db.execute('UPDATE canonical_local_owner_grants SET payload=?',(json.dumps(grant),))
    monkeypatch.setattr(bound,'transaction',mutate_at_end)
    body = b'new-data'; digest = hashlib.sha256(body).hexdigest()
    with pytest.raises(AuthorityError): repo.store_resource('00000000-0000-0000-0000-000000000097',digest,'application/octet-stream',body)
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT count(*) FROM edit_resources').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM edit_resource_bytes').fetchone()[0] == 0

@pytest.mark.parametrize('damage', ['invalid-json','invalid-shape','wrong-key'])
def test_malformed_grant_is_authority_failure_not_aborted_receipt(owner,damage):
    authority, auth, lease_id, path = owner; bootstrap = authority.bind_initialization(auth,lease_id); store = SqliteCanonicalInitialization()
    request = initial_request(bootstrap.account_id); store.get_or_create_peer(bootstrap,request['expectedPeerId']); store.prepare(bootstrap,request); store.execute(bootstrap,request['control']['id'])
    admission, scope = authority.admit(auth,lease_id,request['profile']['identity']['libraryId'])
    repo = SqliteEditRepository(authority.bind_repository(auth,lease_id,admission),scope)
    fixture = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))
    batch = deepcopy(fixture['batches'][0]); batch['libraryId'] = scope['libraryId']
    publication = deepcopy(fixture['publications'][0]['value'])
    publication['libraryBatch']['libraryId'] = scope['libraryId']; publication['libraryBatch']['targetId'] = scope['libraryId']
    with sqlite3.connect(path) as db:
        if damage == 'wrong-key': db.execute("UPDATE canonical_local_owner_grants SET key='wrong'")
        else: db.execute('UPDATE canonical_local_owner_grants SET payload=?', ('{' if damage == 'invalid-json' else '{}',))
    tables = ('canonical_local_owner_grants','canonical_initial_intents','canonical_profiles','edit_roots','edit_batches','edit_projections','edit_publications','edit_dataset_controls')
    def raw():
        with sqlite3.connect(path) as db:
            return {name: db.execute('SELECT * FROM "' + name + '" ORDER BY rowid').fetchall() for name in tables}
    before = raw()
    for attempt in (lambda: repo.commit(batch), lambda: repo.publish(publication)):
        with pytest.raises(AuthorityError,match='recovery-required'): attempt()
        assert raw() == before
