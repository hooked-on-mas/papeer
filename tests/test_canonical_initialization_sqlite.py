"""Source-only storage acceptance cases; execute only after integration and generator refresh."""
from contextlib import closing, contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import pytest
from papeer.core.bootstrap.canonical_initialization_sqlite import SqliteCanonicalInitialization, RetrySnapshot
from papeer.core.edit_repository import SqliteEditRepository
from native_core_test_authority import CoreTestAuthority, provision_for_core_test
from papeer.core.edits.datasets import checkpoint_hash

F = json.loads((Path(__file__).parent / 'fixtures/canonical-bootstrap.json').read_text(encoding='utf8'))

def request():
    profile=deepcopy(F['profile']); profile.pop('initialization'); profile.pop('origin'); library=profile['identity']['libraryId']
    checkpoint={'version':1,'libraryId':library,'roots':[{'kind':'library','id':library,'version':F['rootVersion'],'items':[],'folders':[],'links':[],'deletions':[]}],'edits':[]}
    manifest={'version':1,'id':F['manifestId'],'scope':{**profile['identity'],'epoch':F['epoch']},'checkpointSha256':checkpoint_hash(checkpoint),'resources':[]}
    control={'version':1,'id':F['requestId'],'identity':profile['identity'],'epochs':[F['epoch']],'active':manifest,'transition':{'id':F['requestId'],'mode':'initialize','source':None,'phase':'activated','publication':{'manifest':manifest,'checkpoint':checkpoint,'checkpointObjectId':F['checkpointObjectId']}}}
    return {'expectedPeerId':F['peer']['peerId'],'profile':profile,'control':control}

@pytest.fixture
def setup(tmp_path):
    path=tmp_path/'edit.sqlite3'
    @contextmanager
    def write():
        with closing(sqlite3.connect(path)) as db, db: yield db
    req=request()
    # Explicit test-only schema provision; the adapter's lease is the test-only Core harness (not a host lease).
    provision_for_core_test(write)
    lease=CoreTestAuthority(write,req['profile']['identity']['accountId'])
    return SqliteCanonicalInitialization(),lease,req,write

@pytest.fixture
def read_connection(tmp_path):
    @contextmanager
    def read():
        with closing(sqlite3.connect(f'file:{tmp_path/"edit.sqlite3"}?mode=ro',uri=True)) as db: yield db
    return read

def test_peer_prepare_execute_ack_replay_and_account_isolation(setup):
    store,lease,req,write=setup
    assert store.get_or_create_peer(lease,req['expectedPeerId'])['peerId']==req['expectedPeerId']
    assert store.get_or_create_peer(lease,F['manifestId'])['peerId']==req['expectedPeerId']
    assert store.prepare(lease,req)=={'status':'pending'}
    receipt=store.execute(lease,req['control']['id'])
    assert store.query(lease,req['control']['id'])==receipt
    store.acknowledge(lease,req['control']['id'])
    assert store.query(lease,req['control']['id'])==receipt
    assert store.execute(lease,req['control']['id'])==receipt
    assert store.prepare(lease,req)==receipt
    wrong=deepcopy(req); wrong['profile']['title']='different'
    with pytest.raises(ValueError): store.prepare(lease,wrong)
    assert store.query(CoreTestAuthority(write,'other'),req['control']['id'])=={'status':'not-found'}
    lease.current=False
    with pytest.raises(ValueError): store.query(lease,req['control']['id'])

def test_partial_state_never_repaired_and_pending_survives(setup):
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    identity=json.dumps([lease.account_id,req['profile']['identity']['libraryId']],separators=(',',':'))
    with write() as db: db.execute('INSERT INTO edit_dataset_controls VALUES(?,?,?,?,?,?)',(identity,'{}',None,None,0,'[]'))
    with pytest.raises(ValueError): store.execute(lease,req['control']['id'])
    assert store.query(lease,req['control']['id'])=={'status':'pending'}

def test_snapshot_reads_only_target_library_resource_bytes_across_epochs(setup, read_connection):
    store,lease,req,write=setup
    library=req['profile']['identity']['libraryId']
    target_scope=json.dumps([lease.account_id,library,'another-epoch'])
    other_library=json.dumps([lease.account_id,library+'-other','epoch'])
    other_account=json.dumps(['another-account',library,'epoch'])
    private=b'unrelated resource bytes must not be fetched'
    with write() as db:
        db.executemany('INSERT INTO edit_resource_bytes VALUES(?,?,?)',[
            (target_scope,'target',b'target partial state'),
            (other_library,'other-library',private),
            (other_account,'other-account',private),
        ])

    # A row factory observes values crossing SQLite's query boundary, before
    # application filtering can hide a fetched unrelated resource.
    def checked_row(cursor,row):
        assert private not in row
        return row
    @contextmanager
    def checked(connection):
        with connection() as db:
            db.row_factory=checked_row
            yield db
    checked_lease=CoreTestAuthority(lambda:checked(write),lease.account_id)
    store.get_or_create_peer(checked_lease,req['expectedPeerId'])
    store.prepare(checked_lease,req)
    with checked(read_connection) as db:
        snapshot=store._snapshot(db,lease.account_id,req['control']['id'],req)
    assert len(snapshot['footprint']) == 1
    assert snapshot['footprint'][0][0] == 'edit_resource_bytes'
    with pytest.raises(ValueError): store.execute(checked_lease,req['control']['id'])
    assert store.query(checked_lease,req['control']['id'])=={'status':'pending'}
    with write() as db: db.execute('DELETE FROM edit_resource_bytes WHERE scope=?',(target_scope,))
    assert store.execute(checked_lease,req['control']['id'])['status']=='accepted'

def test_lost_prepare_and_commit_reply_are_recoverable(setup):
    store,lease,req,_=setup; store.get_or_create_peer(lease,req['expectedPeerId'])
    store.prepare(lease,req) # discard reply
    assert store.prepare(lease,req)=={'status':'pending'}
    store.execute(lease,req['control']['id']) # discard reply
    assert store.execute(lease,req['control']['id'])['status']=='accepted'

def test_rejected_reservation_never_reexecutes(setup):
    store,lease,req,_=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    store.execute(lease,req['control']['id']); store.acknowledge(lease,req['control']['id'])
    second=deepcopy(req); second['control']['id']=F['manifestId']; second['control']['transition']['id']=F['manifestId']
    store.prepare(lease,second); result=store.execute(lease,second['control']['id'])
    assert result['status']=='rejected'; store.acknowledge(lease,second['control']['id'])
    assert store.prepare(lease,second)==result
    different=deepcopy(second); different['profile']['title']='changed'
    with pytest.raises(ValueError): store.prepare(lease,different)

def test_snapshot_change_requires_retry_without_partial_write(setup, monkeypatch):
    import papeer.core.bootstrap.canonical_initialization_sqlite as module
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    original=module.admit_initial_library
    def changed(*args):
        result=original(*args)
        with write() as db: db.execute('UPDATE canonical_peers SET payload=? WHERE account=?',(json.dumps({**F['peer'],'peerId':F['manifestId']}),lease.account_id))
        return result
    monkeypatch.setattr(module,'admit_initial_library',changed)
    with pytest.raises(RetrySnapshot): store.execute(lease,req['control']['id'])
    assert store.query(lease,req['control']['id'])=={'status':'pending'}

def test_ack_receipt_survives_rename_link_and_active_change(setup):
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    accepted=store.execute(lease,req['control']['id']); store.acknowledge(lease,req['control']['id'])
    with write() as db:
        row=db.execute('SELECT identity,payload FROM canonical_profiles').fetchone(); profile=json.loads(row[1])
        profile['title']='renamed'; profile['remote']={'kind':'drive','folderId':'folder'}
        db.execute('UPDATE canonical_profiles SET payload=? WHERE identity=?',(json.dumps(profile),row[0]))
        row=db.execute('SELECT identity,payload FROM edit_dataset_controls').fetchone(); control=json.loads(row[1])
        source=deepcopy(control['active']); target=deepcopy(source); target['id']=F['rootVersion']; target['scope']['epoch']='later-epoch'
        control['id']=F['manifestId']; control['epochs'].append('later-epoch'); control['active']=target
        control['transition']={'id':F['manifestId'],'mode':'publish','source':source,'phase':'activated','publication':{**deepcopy(req['control']['transition']['publication']),'manifest':target}}
        db.execute('UPDATE edit_dataset_controls SET payload=?,active_epoch=?,epochs=? WHERE identity=?',(json.dumps(control),'later-epoch',json.dumps(control['epochs']),row[0]))
    assert store.query(lease,req['control']['id'])==accepted
    assert store.prepare(lease,req)==accepted


def test_shared_intent_validation():
    from papeer.core.bootstrap.canonical_initialization_intent import make_initialization_intent, assert_initialization_intent
    req=request(); intent=make_initialization_intent(req,F['peer']['accountId']); assert_initialization_intent(intent)
    retired={'version':1,'accountId':intent['accountId'],'requestId':intent['requestId'],'requestSha256':intent['requestSha256'],'identity':req['profile']['identity'],'result':{'status':'rejected','reason':'collision'},'retired':True}
    assert_initialization_intent(retired)
    altered=deepcopy(intent); altered['requestSha256']='a'*64
    with pytest.raises(ValueError): assert_initialization_intent(altered)


def test_two_peer_candidates_converge(setup):
    from concurrent.futures import ThreadPoolExecutor
    store,lease,req,_=setup
    with ThreadPoolExecutor(max_workers=2) as pool:
        peers=list(pool.map(lambda candidate: store.get_or_create_peer(lease,candidate),[req['expectedPeerId'],F['manifestId']]))
    assert peers[0] == peers[1]

def test_accepted_delivery_without_profile_or_artifacts_is_recovery(setup):
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    store.execute(lease,req['control']['id'])
    with write() as db:
        profile=db.execute('SELECT * FROM canonical_profiles').fetchone(); db.execute('DELETE FROM canonical_profiles')
    for call in (lambda:store.query(lease,req['control']['id']),lambda:store.execute(lease,req['control']['id']),lambda:store.prepare(lease,req)):
        with pytest.raises(ValueError, match='recovery-required'): call()
    with write() as db:
        assert db.execute('SELECT count(*) FROM canonical_initial_intents').fetchone()[0]==1
        db.execute('INSERT INTO canonical_profiles VALUES(?,?,?,?,?)',profile)
        db.execute('DELETE FROM canonical_initial_artifacts')
    for call in (lambda:store.query(lease,req['control']['id']),lambda:store.execute(lease,req['control']['id']),lambda:store.prepare(lease,req)):
        with pytest.raises(ValueError, match='recovery-required'): call()
    with write() as db: assert db.execute('SELECT count(*) FROM canonical_initial_intents').fetchone()[0]==1


def test_list_rejects_cross_account_payload_without_disclosure(setup):
    from papeer.core.bootstrap.canonical_initialization_intent import make_initialization_intent
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    other=deepcopy(req); other['profile']['identity']['accountId']='other'; other['control']['identity']['accountId']='other'
    other['control']['active']['scope']['accountId']='other'; other['control']['transition']['publication']['manifest']['scope']['accountId']='other'
    other['profile']['title']='private-other-title'
    payload=make_initialization_intent(other,'other')
    with write() as db: db.execute('UPDATE canonical_initial_intents SET payload=? WHERE account=?',(json.dumps(payload),lease.account_id))
    with pytest.raises(ValueError, match='recovery-required'): store.list(lease)


def test_installed_profile_is_listed_but_cannot_prove_local_acceptance(setup):
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req)
    store.execute(lease,req['control']['id'])
    installed=deepcopy(F['profile']); identity=json.dumps([lease.account_id,installed['identity']['libraryId']],separators=(',',':'))
    with write() as db:
        db.execute('UPDATE canonical_profiles SET payload=? WHERE identity=?',(json.dumps(installed),identity))
    with pytest.raises(ValueError,match='recovery-required'): store.query(lease,req['control']['id'])
    # Legitimate installed profiles have no initialization request index.
    with write() as db:
        db.execute('DELETE FROM canonical_initial_intents')
        db.execute('UPDATE canonical_profiles SET request_id=NULL WHERE identity=?',(identity,))
    assert store.list(lease)['profiles']==[installed]
    assert store.query(lease,req['control']['id'])=={'status':'not-found'}
    # The occupied identity cannot be initialized over an installation.
    store.prepare(lease,req)
    with pytest.raises(ValueError): store.execute(lease,req['control']['id'])
    assert store.query(lease,req['control']['id'])=={'status':'pending'}

def test_list_requires_accepted_profile_proof(setup):
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req); store.execute(lease,req['control']['id'])
    with write() as db:
        profile=db.execute('SELECT * FROM canonical_profiles').fetchone(); db.execute('DELETE FROM canonical_profiles')
    with pytest.raises(ValueError,match='recovery-required'): store.list(lease)
    with write() as db:
        assert db.execute('SELECT count(*) FROM canonical_initial_intents').fetchone()[0]==1
        installed=deepcopy(F['profile']); db.execute('INSERT INTO canonical_profiles VALUES(?,?,?,?,?)',(*profile[:4],json.dumps(installed)))
    with pytest.raises(ValueError,match='recovery-required'): store.list(lease)
    with write() as db: assert db.execute('SELECT count(*) FROM canonical_initial_intents').fetchone()[0]==1

@pytest.mark.parametrize('damage',['checkpoint-version','checkpoint-edits','missing-control'])
def test_accepted_proof_checks_checkpoint_and_current_control_across_all_reads(setup,damage):
    store,lease,req,write=setup; store.get_or_create_peer(lease,req['expectedPeerId']); store.prepare(lease,req); store.execute(lease,req['control']['id'])
    with write() as db:
        if damage == 'missing-control': db.execute('DELETE FROM edit_dataset_controls')
        else:
            identity,payload=db.execute('SELECT identity,payload FROM canonical_initial_artifacts').fetchone(); artifact=json.loads(payload)
            if damage == 'checkpoint-version': artifact['checkpoint']['version']=2
            else: artifact['checkpoint']['edits']=[{}]
            db.execute('UPDATE canonical_initial_artifacts SET payload=? WHERE identity=?',(json.dumps(artifact),identity))
        before=(db.execute('SELECT payload FROM canonical_initial_intents').fetchone()[0],db.execute('SELECT payload FROM canonical_initial_artifacts').fetchone()[0])
    calls=(lambda:store.list(lease),lambda:store.query(lease,req['control']['id']),lambda:store.execute(lease,req['control']['id']),lambda:store.prepare(lease,req),lambda:store.acknowledge(lease,req['control']['id']))
    for call in calls:
        with pytest.raises(ValueError,match='recovery-required'): call()
    with write() as db:
        after=(db.execute('SELECT payload FROM canonical_initial_intents').fetchone()[0],db.execute('SELECT payload FROM canonical_initial_artifacts').fetchone()[0])
    assert before == after


def test_initialized_catalog_readback_is_readonly_and_isolated(setup, tmp_path, read_connection):
    import hashlib

    store, lease, first, write = setup
    peer = store.get_or_create_peer(lease, first['expectedPeerId'])
    assert store.prepare(lease, first) == {'status':'pending'}
    accepted = store.execute(lease, first['control']['id'])
    assert accepted['status'] == 'accepted'
    database = tmp_path / 'edit.sqlite3'

    def readonly_catalog(request):
        publication = request['control']['transition']['publication']
        scope = publication['manifest']['scope']
        before = hashlib.sha256(database.read_bytes()).hexdigest()
        repository = SqliteEditRepository(CoreTestAuthority(read_connection, scope['accountId']), scope)
        result = repository.read(scope['libraryId'])
        assert result['checkpoint']['root'] == publication['checkpoint']['roots'][0]
        assert result['checkpoint']['batches'] == []
        assert result['receipts'] == [] and result['history'] == []
        assert result['heads'] == [publication['checkpoint']['roots'][0]['version']]
        assert repository.checkpoint() == publication['checkpoint']
        assert hashlib.sha256(database.read_bytes()).hexdigest() == before
        return repository, result

    first_repository, first_read = readonly_catalog(first)
    store.acknowledge(lease, first['control']['id'])
    restarted = SqliteCanonicalInitialization()
    assert restarted.query(lease, first['control']['id']) == accepted
    assert first_repository.read(first['profile']['identity']['libraryId']) == first_read

    # This is sequential creation, not a concurrent peer-creation claim.
    second = deepcopy(first)
    library = '00000000-0000-0000-0000-000000000008'
    request_id = '00000000-0000-0000-0000-000000000009'
    second['profile']['identity']['libraryId'] = library
    second['profile']['title'] = 'Second isolated library'
    control = second['control']
    control['identity']['libraryId'] = library
    control['id'] = request_id
    control['transition']['id'] = request_id
    publication = control['transition']['publication']
    manifest, checkpoint = publication['manifest'], publication['checkpoint']
    manifest['id'] = '00000000-0000-0000-0000-000000000010'
    manifest['scope']['libraryId'] = library
    manifest['scope']['epoch'] = 'probe-second-epoch'
    checkpoint['libraryId'] = library
    checkpoint['roots'][0]['id'] = library
    checkpoint['roots'][0]['version'] = '00000000-0000-0000-0000-000000000011'
    manifest['checkpointSha256'] = checkpoint_hash(checkpoint)
    publication['checkpointObjectId'] = '00000000-0000-0000-0000-000000000012'
    control['active'] = deepcopy(manifest)
    control['epochs'] = [manifest['scope']['epoch']]
    assert restarted.get_or_create_peer(lease, '00000000-0000-0000-0000-000000000013') == peer
    assert restarted.prepare(lease, second) == {'status':'pending'}
    assert restarted.execute(lease, request_id)['status'] == 'accepted'
    second_repository, _ = readonly_catalog(second)
    assert first_repository.read(first['profile']['identity']['libraryId']) == first_read
    for repository, target in ((first_repository, library), (second_repository, first['profile']['identity']['libraryId'])):
        with pytest.raises(ValueError, match='^missing-target$'):
            repository.read(target)
    listed = restarted.list(lease)
    assert len(listed['profiles']) == 2
    assert {profile['identity']['libraryId'] for profile in listed['profiles']} == {first['profile']['identity']['libraryId'], library}
