"""Source-only integration cases: real token, fixed temp path, durable grant."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import pytest
from fastapi.testclient import TestClient
from papeer.core.edits.datasets import checkpoint_hash
from sidecar import deps
from sidecar.app import app
from sidecar.canonical_host import authority
from sidecar.canonical_host import AuthorityError
from papeer.core.migrations.legacy_startup import NativeLegacyStartup

F = json.loads((Path(__file__).parent / 'fixtures/canonical-bootstrap.json').read_text(encoding='utf8'))
ROOT = '/api/edits/bootstrap'
AUTH = {'Authorization':'Bearer native-test-token'}

@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setenv('PAPEER_DATA_DIR',str(tmp_path / 'fixed-legacy'))
    monkeypatch.setattr(deps,'get_auth_token',lambda: 'native-test-token')
    monkeypatch.setattr(deps,'get_library',lambda: pytest.fail('legacy library opened'))
    authority.revoke_all()
    with TestClient(app) as value: yield value
    authority.revoke_all()

def request_for(peer):
    profile = deepcopy(F['profile']); profile.pop('origin'); profile.pop('initialization'); profile['identity']['accountId'] = peer['accountId']
    library = profile['identity']['libraryId']; scope = {**profile['identity'],'epoch':F['epoch']}
    checkpoint = {'version':1,'libraryId':library,'roots':[{'kind':'library','id':library,'version':F['rootVersion'],'items':[],'folders':[],'links':[],'deletions':[]}],'edits':[]}
    manifest = {'version':1,'id':F['manifestId'],'scope':scope,'checkpointSha256':checkpoint_hash(checkpoint),'resources':[]}
    control = {'version':1,'id':F['requestId'],'identity':profile['identity'],'epochs':[F['epoch']],'active':manifest,'transition':{'id':F['requestId'],'mode':'initialize','source':None,'phase':'activated','publication':{'manifest':manifest,'checkpoint':checkpoint,'checkpointObjectId':F['checkpointObjectId']}}}
    return {'expectedPeerId':peer['peerId'],'profile':profile,'control':control}

def established(client):
    response = client.post(ROOT+'/local-context/provision',json={},headers=AUTH); assert response.status_code == 200
    lease = response.json()['leaseId']; headers = {**AUTH,'X-Papeer-Host-Lease':lease}
    peer = client.post(ROOT+'/peer',json={},headers=headers).json(); request = request_for(peer)
    assert client.post(ROOT+'/initialization/prepare',json={'request':request},headers=headers).json()['status'] == 'pending'
    accepted = client.post(ROOT+'/initialization/execute',json={'requestId':request['control']['id']},headers=headers).json(); assert accepted['status'] == 'accepted'
    listing = client.post(ROOT+'/discover',json={},headers=headers).json(); assert listing['libraries'][0]['status'] == 'available'
    result = client.post(ROOT+'/inspect',json={'handleId':listing['libraries'][0]['handleId']},headers=headers).json()
    return lease,{**headers,'X-Papeer-Admission':result['admissionId']},result['scope'],request

def test_real_bearer_readonly_absence_create_inspect_commit_reload(client):
    path = deps.get_canonical_storage_path()
    assert client.post(ROOT+'/local-context/read',json={},headers={'Authorization':'Bearer wrong'}).status_code == 401
    assert client.post(ROOT+'/local-context/read',json={}).status_code == 401
    absent = client.post(ROOT+'/local-context/read',json={},headers=AUTH)
    assert absent.json() == {'status':'setup-required','reason':'absent'} and not path.exists()
    lease,headers,scope,request = established(client)
    assert client.post('/api/edits/read',json={'scope':scope,'targetId':scope['libraryId']},headers=headers).json()['checkpoint']['root']['id'] == scope['libraryId']
    batch = {'kind':'library','id':'00000000-0000-0000-0000-000000000091','libraryId':scope['libraryId'],'targetId':scope['libraryId'],'parents':[F['rootVersion']],'changes':[{'type':'put-folder','folder':{'id':'00000000-0000-0000-0000-000000000092','title':'Created','parentId':None,'position':0}}]}
    saved = client.post('/api/edits/commit',json={'scope':scope,'batch':batch},headers=headers)
    assert saved.json()['status'] == 'durable' and saved.headers['cache-control'] == 'no-store'
    assert len(client.post('/api/edits/pending',json=scope,headers=headers).json()) == 1
    # A newly issued lease and newly discovered handle still read the durable outbox.
    new_lease = client.post(ROOT+'/local-context/read',json={},headers=AUTH).json()['leaseId']
    new_headers = {**AUTH,'X-Papeer-Host-Lease':new_lease}
    handles = client.post(ROOT+'/discover',json={},headers=new_headers).json()['libraries']
    proof = client.post(ROOT+'/inspect',json={'handleId':handles[0]['handleId']},headers=new_headers).json()
    new_headers['X-Papeer-Admission'] = proof['admissionId']
    assert len(client.post('/api/edits/pending',json=scope,headers=new_headers).json()) == 1
    assert client.post(ROOT+'/initialization/query',json={'requestId':request['control']['id']},headers=new_headers).json()['status'] == 'accepted'
    assert lease != new_lease

def test_missing_forged_stale_cross_scope_and_privileged_routes(client):
    lease,headers,scope,request = established(client)
    body = {'scope':scope,'targetId':scope['libraryId']}
    for bad in (AUTH,{**AUTH,'X-Papeer-Host-Lease':'forged','X-Papeer-Admission':headers['X-Papeer-Admission']},
                {**headers,'X-Papeer-Admission':'forged'}):
        assert client.post('/api/edits/read',json=body,headers=bad).status_code == 403
    assert client.post('/api/edits/read',json={'scope':{**scope,'epoch':'other'},'targetId':scope['libraryId']},headers=headers).status_code == 403
    assert client.post('/api/edits/read',json={'scope':{**scope,'libraryId':'00000000-0000-0000-0000-000000000099'},'targetId':scope['libraryId']},headers=headers).status_code == 403
    privileged = {
        'initialize':{'scope':scope,'root':{}}, 'receive':{'scope':scope,'batches':[]},
        'receive-publications':{'scope':scope,'batches':[],'publications':[]}, 'receive-records':{'scope':scope,'records':[]},
        'acknowledge-upload':{'scope':scope,'batchId':F['rootVersion']}, 'acknowledge-import':{'scope':scope,'batchId':F['rootVersion'],'peerId':F['peer']['peerId']},
        'replace-dataset-control':{'scope':scope,'record':{},'expectedId':None}, 'install-dataset':{'scope':scope,'manifest':{},'checkpoint':{}},
        'install-checkpoint':{'scope':scope,'checkpoint':{}},
    }
    with sqlite3.connect(deps.get_canonical_storage_path()) as db: before = db.execute('SELECT * FROM edit_batches').fetchall()
    for route,payload in privileged.items(): assert client.post('/api/edits/'+route,json=payload,headers=headers).status_code == 403
    drive = {'scope':scope,'folderId':'folder','leaseId':'unused'}
    drive_payloads = {'lease':{'scope':scope,'folderId':'folder'}, 'files':drive, 'check-lease':drive,
        'read-json':{**drive,'fileId':'id'}, 'save-json':{**drive,'editId':F['requestId'],'value':{}},
        'read-resource':{**drive,'metadata':{},'blobId':'id'}, 'save-resource':{**drive,'metadata':{},'dataBase64':''}}
    for route,payload in drive_payloads.items(): assert client.post('/api/edits/drive/'+route,json=payload,headers=headers).status_code == 403
    with sqlite3.connect(deps.get_canonical_storage_path()) as db: assert db.execute('SELECT * FROM edit_batches').fetchall() == before
    authority.revoke_all()
    assert client.post('/api/edits/read',json=body,headers=headers).status_code == 403
    assert client.post(ROOT+'/initialization/query',json={'requestId':request['control']['id']},headers={**AUTH,'X-Papeer-Host-Lease':lease}).status_code == 403

@pytest.mark.parametrize('route,payload',[
 ('read',{'targetId':'00000000-0000-0000-0000-000000000002'}), ('commit',{'batch':{}}), ('publish',{'publication':{}}),
 ('store-resource',{'resourceId':'r','sha256':'s','mediaType':'m','dataBase64':''}), ('read-resource',{'resourceId':'r'}),
 ('resource-metadata',{'resourceId':'r'}), ('receipt',{'batchId':'r'}), ('pending',None), ('pending-records',None),
 ('pending-publications',None), ('checkpoint',None), ('datasets',None), ('dataset-control',None),
 ('intent',{'targetId':'r'}), ('replace-intent',{'targetId':'r','record':None,'expectedId':None}), ('pending-intents',None),
])
def test_every_normal_route_requires_lease_and_admission(client,route,payload):
    _,_,scope,_ = established(client)
    body = scope if payload is None else {'scope':scope,**payload}
    assert client.post('/api/edits/'+route,json=body,headers=AUTH).status_code == 403

def test_development_no_auth_does_not_issue_owner(client,monkeypatch):
    monkeypatch.setattr(deps,'get_auth_token',lambda: None)
    monkeypatch.setattr(deps,'auth_disabled',lambda: True)
    response = client.post(ROOT+'/local-context/provision',json={})
    assert response.status_code == 403
    assert not deps.get_canonical_storage_path().exists()

def canonical_rows():
    with sqlite3.connect(deps.get_canonical_storage_path()) as db:
        names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'edit_%' OR name LIKE 'canonical_%') ORDER BY name")]
        return {name: db.execute('SELECT * FROM "' + name.replace('"','""') + '" ORDER BY rowid').fetchall() for name in names}

def test_hold_revokes_all_existing_capabilities_even_after_clear(client):
    lease,headers,scope,_ = established(client)
    bootstrap = authority.bind_initialization(AUTH['Authorization'],lease)
    listing = client.post(ROOT+'/discover',json={},headers=headers).json()
    old_handle = listing['libraries'][0]['handleId']; before = canonical_rows()
    hold = {'version':1,'runId':F['requestId']}
    response = client.post('/api/edits/legacy-startup/hold',json={'hold':hold},headers=AUTH)
    assert response.status_code == 200 and response.json() == hold
    with pytest.raises(AuthorityError): bootstrap.assert_current()
    assert client.post(ROOT+'/revalidate',json={},headers=headers).status_code == 403
    assert client.post(ROOT+'/inspect',json={'handleId':old_handle},headers=headers).status_code == 403
    assert client.post(ROOT+'/local-context/read',json={},headers=AUTH).status_code == 403
    assert canonical_rows() == before
    # Test-only hold removal simulates a separately authorized management clear.
    startup = NativeLegacyStartup(deps.get_data_dir())
    startup.path.unlink()
    assert client.post(ROOT+'/local-context/read',json={},headers=AUTH).status_code == 403
    # Isolated test-only removal of the now-empty orphan footprint, not a production cancel.
    startup.path.parent.rmdir()
    new_lease = client.post(ROOT+'/local-context/read',json={},headers=AUTH).json()['leaseId']
    assert new_lease != lease
    assert client.post(ROOT+'/inspect',json={'handleId':old_handle},headers={**AUTH,'X-Papeer-Host-Lease':new_lease}).status_code == 403
    assert client.post('/api/edits/read',json={'scope':scope,'targetId':scope['libraryId']},headers=headers).status_code == 403
    assert canonical_rows() == before

def test_uncertain_hold_write_still_revokes_old_capabilities(client,monkeypatch):
    lease,headers,_,_ = established(client); bound = authority.bind_initialization(AUTH['Authorization'],lease); before = canonical_rows()
    original = NativeLegacyStartup.hold
    def committed_then_error(self,value):
        original(self,value)
        raise OSError('injected lost hold response')
    monkeypatch.setattr(NativeLegacyStartup,'hold',committed_then_error)
    response = client.post('/api/edits/legacy-startup/hold',json={'hold':{'version':1,'runId':F['requestId']}},headers=AUTH)
    assert response.status_code == 503
    with pytest.raises(AuthorityError): bound.assert_current()
    assert NativeLegacyStartup(deps.get_data_dir()).read() is not None
    assert client.post(ROOT+'/revalidate',json={},headers=headers).status_code == 403
    assert client.post(ROOT+'/local-context/read',json={},headers=AUTH).status_code == 403
    assert canonical_rows() == before
