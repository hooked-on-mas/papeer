"""Physical-key corruption cases; overlay requires D1b/D2 test sources."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import pytest
from papeer.core.bootstrap.canonical_initialization_sqlite import SqliteCanonicalInitialization
from papeer.core.edit_model import canonical_json
from papeer.core.edit_repository import SqliteEditRepository, StorageIntegrityError
from test_native_authority_hooks import owner, initial_request  # noqa: F401  (owner is a pytest fixture)

ID_A = '00000000-0000-0000-0000-000000000081'
ID_B = '00000000-0000-0000-0000-000000000082'

@pytest.fixture
def initialized(owner):  # noqa: F811  (the imported fixture, requested by name)
    authority,auth,lease,path = owner
    bootstrap = authority.bind_initialization(auth,lease); store = SqliteCanonicalInitialization()
    request = initial_request(bootstrap.account_id); store.get_or_create_peer(bootstrap,request['expectedPeerId']); store.prepare(bootstrap,request); store.execute(bootstrap,request['control']['id'])
    admission,scope = authority.admit(auth,lease,request['profile']['identity']['libraryId'])
    repo = SqliteEditRepository(authority.bind_repository(auth,lease,admission),scope)
    return repo,path,scope,request

def rows(path):
    with sqlite3.connect(path) as db:
        names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'edit_%' OR name LIKE 'canonical_%') ORDER BY name")]
        return {name:db.execute('SELECT * FROM "' + name.replace('"','""') + '" ORDER BY rowid').fetchall() for name in names}

def batch(scope,version,edit_id=ID_A):
    return {'kind':'library','id':edit_id,'libraryId':scope['libraryId'],'targetId':scope['libraryId'],'parents':[version],
            'changes':[{'type':'put-folder','folder':{'id':'00000000-0000-0000-0000-000000000083','title':'Folder','parentId':None,'position':0}}]}

def receipt(edit_id,target):
    return {'id':edit_id,'targetId':target,'durable':True,'upload':'pending','importedBy':[]}

def test_resource_payload_id_and_bytes_cannot_be_read_under_another_key(initialized):
    repo,path,scope,_ = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']]); body = b'private-other-resource'
    digest = hashlib.sha256(body).hexdigest(); metadata = {'id':ID_B,'sha256':digest,'mediaType':'application/octet-stream','byteLength':len(body)}
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO edit_resources VALUES (?,?,?)',(namespace,ID_A,canonical_json(metadata)))
        db.execute('INSERT INTO edit_resource_bytes VALUES (?,?,?)',(namespace,digest,body))
    before = rows(path)
    for read in (lambda:repo.read_resource(ID_A),lambda:repo.resource_metadata(ID_A)):
        with pytest.raises(StorageIntegrityError): read()
        assert rows(path) == before

def test_root_key_mismatch_cannot_disclose_other_valid_root(initialized):
    repo,path,scope,request = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    other = deepcopy(request['control']['transition']['publication']['checkpoint']['roots'][0]); other['id'] = ID_B
    with sqlite3.connect(path) as db: db.execute('UPDATE edit_roots SET payload=? WHERE scope=? AND target=?',(canonical_json(other),namespace,scope['libraryId']))
    before = rows(path)
    with pytest.raises(StorageIntegrityError): repo.read(scope['libraryId'])
    with pytest.raises(StorageIntegrityError): repo.checkpoint()
    with pytest.raises(StorageIntegrityError): repo.commit(batch(scope,other['version']))
    assert rows(path) == before

@pytest.mark.parametrize('damage',['batch-id','batch-target','receipt-id','receipt-target','invalid-json'])
def test_batch_and_receipt_physical_keys_do_not_return_aborted_receipt(initialized,damage):
    repo,path,scope,request = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    version = request['control']['transition']['publication']['checkpoint']['roots'][0]['version']; requested = batch(scope,version); saved = deepcopy(requested)
    if damage == 'batch-id': saved['id'] = ID_B
    if damage == 'batch-target': saved['targetId'] = ID_B
    delivered = receipt(ID_B if damage == 'receipt-id' else ID_A,ID_B if damage == 'receipt-target' else scope['libraryId'])
    payload = '{' if damage == 'invalid-json' else canonical_json(saved)
    with sqlite3.connect(path) as db: db.execute('INSERT INTO edit_batches VALUES (?,?,?,?,?,?)',(namespace,ID_A,scope['libraryId'],payload,canonical_json(delivered),None))
    before = rows(path)
    for operation in (lambda:repo.receipt(ID_A),lambda:repo.pending(),lambda:repo.read(scope['libraryId']),lambda:repo.commit(requested)):
        with pytest.raises(StorageIntegrityError): operation()
        assert rows(path) == before

def test_manifest_physical_id_is_checked_before_disclosure(initialized):
    repo,path,scope,request = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    other = deepcopy(request['control']['active']); other['id'] = ID_B
    with sqlite3.connect(path) as db: db.execute('INSERT INTO edit_datasets VALUES (?,?,?)',(namespace,ID_A,canonical_json(other)))
    before = rows(path)
    with pytest.raises(StorageIntegrityError): repo.installed_datasets()
    assert rows(path) == before

def test_publish_and_graph_write_reject_corrupt_stored_rows_atomically(initialized):
    repo,path,scope,request = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    version = request['control']['transition']['publication']['checkpoint']['roots'][0]['version']; incoming = batch(scope,version,ID_B)
    saved = batch(scope,version,ID_B); wrong_receipt = receipt(ID_B,scope['libraryId'])
    with sqlite3.connect(path) as db: db.execute('INSERT INTO edit_batches VALUES (?,?,?,?,?,?)',(namespace,ID_A,scope['libraryId'],canonical_json(saved),canonical_json(wrong_receipt),None))
    before = rows(path)
    # A valid publication can use an item ID distinct from its batch ID.
    fixture = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))
    publication = deepcopy(fixture['publications'][0]['value']); publication['libraryBatch']['libraryId'] = scope['libraryId']; publication['libraryBatch']['targetId'] = scope['libraryId']
    with pytest.raises(StorageIntegrityError): repo.publish(publication)
    with pytest.raises(StorageIntegrityError): repo.commit(incoming)
    assert rows(path) == before

def test_publication_item_id_is_not_required_to_equal_batch_id(initialized):
    repo,path,scope,_ = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    fixture = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))
    publication = deepcopy(fixture['publications'][0]['value']); edit = publication['libraryBatch']
    edit['id'] = ID_A; edit['libraryId'] = scope['libraryId']; edit['targetId'] = scope['libraryId']
    assert edit['changes'][0]['item']['id'] != edit['id']
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO edit_batches VALUES (?,?,?,?,?,?)',(namespace,ID_A,scope['libraryId'],canonical_json(edit),canonical_json(receipt(ID_A,scope['libraryId'])),None))
        db.execute('INSERT INTO edit_publications VALUES (?,?,?)',(namespace,ID_A,canonical_json(publication)))
    assert repo.pending_publications() == [publication]

def test_projection_key_mismatch_fails_before_graph_write(initialized):
    repo,path,scope,request = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    root = deepcopy(request['control']['transition']['publication']['checkpoint']['roots'][0]); version = root['version']; root['id'] = ID_B
    with sqlite3.connect(path) as db: db.execute('UPDATE edit_projections SET payload=? WHERE scope=? AND target=? AND version=?',(canonical_json(root),namespace,scope['libraryId'],version))
    before = rows(path)
    with pytest.raises(StorageIntegrityError): repo.commit(batch(scope,version))
    assert rows(path) == before

def test_metadata_only_resource_is_not_automatically_repaired(initialized):
    repo,path,scope,_ = initialized; body = b'resource-body'; digest = hashlib.sha256(body).hexdigest()
    repo.store_resource(ID_A,digest,'application/octet-stream',body)
    namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    with sqlite3.connect(path) as db: db.execute('DELETE FROM edit_resource_bytes WHERE scope=? AND sha256=?',(namespace,digest))
    before = rows(path)
    for action in (lambda:repo.store_resource(ID_A,digest,'application/octet-stream',body),lambda:repo.read_resource(ID_A)):
        with pytest.raises(StorageIntegrityError): action()
        assert rows(path) == before

@pytest.mark.parametrize('operation',['commit','publish'])
@pytest.mark.parametrize('damage',['wrong-id','invalid-schema'])
def test_same_incoming_version_projection_is_checked_before_overwrite(initialized,operation,damage):
    repo,path,scope,request = initialized; namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    root = deepcopy(request['control']['transition']['publication']['checkpoint']['roots'][0]); version = root['version']
    corrupt = deepcopy(root); corrupt['version'] = ID_A
    if damage == 'wrong-id': corrupt['id'] = ID_B
    else: del corrupt['folders']
    with sqlite3.connect(path) as db:
        db.execute('INSERT INTO edit_projections VALUES (?,?,?,?)',(namespace,scope['libraryId'],ID_A,canonical_json(corrupt)))
    before = rows(path)
    if operation == 'commit':
        action = lambda:repo.commit(batch(scope,version,ID_A))
    else:
        fixture = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))
        publication = deepcopy(fixture['publications'][2]['value']); edit = publication['libraryBatch']
        edit['id'] = ID_A; edit['libraryId'] = scope['libraryId']; edit['targetId'] = scope['libraryId']; edit['parents'] = [version]
        action = lambda:repo.publish(publication)
    with pytest.raises(StorageIntegrityError): action()
    assert rows(path) == before

def test_valid_same_version_projection_can_be_rebuilt(initialized):
    repo,path,scope,request = initialized
    snapshot = deepcopy(request['control']['transition']['publication']['checkpoint']['roots'][0])
    snapshot['folders'].append({'id':ID_A,'title':'Rebuilt','parentId':None,'position':0})
    with repo.authority.transaction('commit',scope) as db: repo._project(db,snapshot)
    namespace = canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']])
    with sqlite3.connect(path) as db:
        payload = db.execute('SELECT payload FROM edit_projections WHERE scope=? AND target=? AND version=?',(namespace,scope['libraryId'],snapshot['version'])).fetchone()[0]
    assert json.loads(payload) == snapshot
