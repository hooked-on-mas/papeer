"""D1a authority primitives only; not an endpoint or production integration test."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import pytest

from papeer.core.bootstrap.canonical_local_grant_sqlite import provision_local_grant
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.edit_model import canonical_json
from papeer.core.edit_repository import initialize_edit_schema
from papeer.core.bootstrap.canonical_initialization_sqlite import initialize_canonical_metadata
from sidecar import deps
from sidecar.canonical_host import AuthorityError, NativeAuthority, canonical_storage_path

F = json.loads((Path(__file__).parent / 'fixtures/canonical-bootstrap.json').read_text(encoding='utf8'))

@pytest.fixture
def seeded(tmp_path, monkeypatch):
    monkeypatch.setenv('PAPEER_DATA_DIR',str(tmp_path / 'legacy'))
    monkeypatch.setattr(deps,'get_auth_token',lambda: 'test-real-token')
    # Prove the authority derives its path without opening a legacy library.
    monkeypatch.setattr(deps,'get_library',lambda: pytest.fail('legacy opened'))
    path = canonical_storage_path(); path.parent.mkdir()
    grant = provision_local_grant(path); account = grant['namespaceId']; profile = deepcopy(F['profile'])
    profile['identity']['accountId'] = account; profile['origin']['installedScope']['accountId'] = account
    library = profile['identity']['libraryId']; epoch = F['epoch']
    scope = {'accountId':account,'libraryId':library,'epoch':epoch}; identity = canonical_json([account,library])
    checkpoint = {'version':1,'libraryId':library,'roots':[{'kind':'library','id':library,'version':F['rootVersion'],'items':[],'folders':[],'links':[],'deletions':[]}],'edits':[]}
    manifest = {'version':1,'id':F['manifestId'],'scope':scope,'checkpointSha256':checkpoint_hash(checkpoint),'resources':[]}
    control = {'version':1,'id':F['requestId'],'identity':profile['identity'],'epochs':[epoch],'active':manifest,'transition':{'id':F['requestId'],'mode':'initialize','source':None,'phase':'activated','publication':{'manifest':manifest,'checkpoint':checkpoint,'checkpointObjectId':F['checkpointObjectId']}}}
    peer = {**F['peer'],'accountId':account}
    with sqlite3.connect(path) as db:
        initialize_edit_schema(db); initialize_canonical_metadata(db)
        db.execute('INSERT INTO canonical_profiles VALUES (?,?,?,?,?)',(identity,account,library,None,canonical_json(profile)))
        db.execute('INSERT INTO canonical_peers VALUES (?,?)',(account,canonical_json(peer)))
        db.execute('INSERT INTO edit_dataset_controls VALUES (?,?,?,?,?,?)',(identity,canonical_json(control),epoch,None,0,canonical_json([epoch])))
        db.execute('INSERT INTO edit_datasets VALUES (?,?,?)',(canonical_json([account,library,epoch]),manifest['id'],canonical_json(manifest)))
    return path, grant, scope

def test_real_bearer_fixed_path_and_generation(seeded, monkeypatch, tmp_path):
    path, grant, scope = seeded; authority = NativeAuthority()
    for header in (None,'Bearer wrong','test-real-token'):
        with pytest.raises(AuthorityError): authority.issue(header)
    monkeypatch.setattr(deps,'get_auth_token',lambda: None)
    monkeypatch.setattr(deps,'auth_disabled',lambda: True)
    with pytest.raises(AuthorityError): authority.issue('Bearer test-real-token')
    monkeypatch.setattr(deps,'get_auth_token',lambda: 'test-real-token')
    lease = authority.issue('Bearer test-real-token')
    with pytest.raises(AuthorityError):
        with authority.transaction('Bearer test-real-token','forged','bootstrap-query'): pass
    authority.revoke_all()
    with pytest.raises(AuthorityError):
        with authority.transaction('Bearer test-real-token',lease,'bootstrap-query'): pass
    lease = authority.issue('Bearer test-real-token')
    monkeypatch.setenv('PAPEER_DATA_DIR',str(tmp_path / 'different'))
    with pytest.raises(AuthorityError):
        with authority.transaction('Bearer test-real-token',lease,'bootstrap-query'): pass
    assert path.exists() and grant['namespaceId'] == scope['accountId']

def test_admission_allowlist_readonly_and_scope(seeded):
    path, _, scope = seeded; authority = NativeAuthority(); auth = 'Bearer test-real-token'; lease = authority.issue(auth)
    admission, admitted_scope = authority.admit(auth,lease,scope['libraryId']); assert admitted_scope == scope
    with sqlite3.connect(path) as db: before = db.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall()
    with authority.transaction(auth,lease,'read',admission_id=admission,scope=scope) as db:
        assert db.execute('SELECT count(*) FROM edit_roots').fetchone()[0] == 0
        with pytest.raises(sqlite3.OperationalError): db.execute('CREATE TABLE forbidden (v TEXT)')
    with sqlite3.connect(path) as db: assert db.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall() == before
    for operation in ('install-dataset','replace-dataset-control','receive','acknowledge-upload','unknown'):
        with pytest.raises(AuthorityError):
            with authority.transaction(auth,lease,operation,admission_id=admission,scope=scope): pass
    for bad_admission,bad_scope in (('forged',scope),(admission,{**scope,'epoch':'other'})):
        with pytest.raises(AuthorityError):
            with authority.transaction(auth,lease,'read',admission_id=bad_admission,scope=bad_scope): pass

def test_grant_and_control_mutation_rollback_before_commit(seeded):
    path, grant, scope = seeded; authority = NativeAuthority(); auth = 'Bearer test-real-token'; lease = authority.issue(auth)
    admission, _ = authority.admit(auth,lease,scope['libraryId'])
    with pytest.raises(AuthorityError):
        with authority.transaction(auth,lease,'commit',admission_id=admission,scope=scope) as db:
            changed = {**grant,'revision':'00000000-0000-0000-0000-000000000099'}
            db.execute('UPDATE canonical_local_owner_grants SET payload=?',(canonical_json(changed),))
            db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('scope','pending','payload'))
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT count(*) FROM edit_roots').fetchone()[0] == 0
        assert json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0]) == grant
    with pytest.raises(AuthorityError):
        with authority.transaction(auth,lease,'commit',admission_id=admission,scope=scope) as db:
            db.execute('UPDATE edit_dataset_controls SET active_epoch=?',('other',))
    with sqlite3.connect(path) as db: assert db.execute('SELECT active_epoch FROM edit_dataset_controls').fetchone()[0] == scope['epoch']
    with authority.transaction(auth,lease,'commit',admission_id=admission,scope=scope) as db:
        db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('scope','pending','payload'))
    with sqlite3.connect(path) as db: assert db.execute('SELECT count(*) FROM edit_roots').fetchone()[0] == 1

def test_changed_durable_grant_refuses_old_lease_without_repair(seeded):
    path, grant, scope = seeded; authority = NativeAuthority(); auth = 'Bearer test-real-token'; lease = authority.issue(auth)
    with sqlite3.connect(path) as db:
        db.execute('UPDATE canonical_local_owner_grants SET payload=?',(canonical_json({**grant,'revision':'00000000-0000-0000-0000-000000000099'}),))
    with pytest.raises(AuthorityError):
        with authority.transaction(auth,lease,'bootstrap-query'): pass
    with sqlite3.connect(path) as db: assert json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0])['revision'].endswith('99')

def test_collision_and_lost_generation_preserve_prior_state(seeded):
    path, _, scope = seeded; authority = NativeAuthority(); auth = 'Bearer test-real-token'; lease = authority.issue(auth)
    admission, _ = authority.admit(auth,lease,scope['libraryId'])
    with sqlite3.connect(path) as db: db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('s','existing','original'))
    with pytest.raises(sqlite3.IntegrityError):
        with authority.transaction(auth,lease,'commit',admission_id=admission,scope=scope) as db:
            db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('s','another','uncommitted'))
            db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('s','existing','collision'))
    with sqlite3.connect(path) as db: assert db.execute('SELECT target,payload FROM edit_roots').fetchall() == [('existing','original')]
    with pytest.raises(AuthorityError):
        with authority.transaction(auth,lease,'commit',admission_id=admission,scope=scope) as db:
            db.execute('INSERT INTO edit_roots VALUES (?,?,?)',('s','unknown','uncommitted'))
            authority.revoke_all()
    with sqlite3.connect(path) as db: assert db.execute('SELECT target,payload FROM edit_roots').fetchall() == [('existing','original')]
