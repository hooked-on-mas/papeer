"""Actual NativeAuthority/SQLite + real provider owner; fake Google boundary only."""
import json
import uuid
from copy import deepcopy
import pytest
from test_provider_verifier import http as google_http  # noqa: F401
from test_provider_data_plane import context as drive_context  # noqa: F401

@pytest.fixture
def context(request):
    return request.getfixturevalue('drive_context')
from papeer.core.edit_repository import StorageIntegrityError
from sidecar.canonical_host import NativeAuthority, AuthorityError, _existing
from sidecar.provider.offline import crypto, storage
from sidecar.provider.offline.service import NativeOfflineService
from sidecar.provider.replication import ProviderReplicationOwner

SECRET='correct horse battery staple'

def enrolled(context):
    host,owner,plan,activate,put,http=context
    activate(); registry=owner._registry; auth=owner._authorization;lease=owner._lease_id
    admission,scope=registry.admit_provider(auth,lease,owner,owner.descriptor()['scope'])
    service=NativeOfflineService(registry);rid=str(uuid.uuid4())
    assert service.enroll(auth,lease,admission,SECRET,rid)=={'status':'accepted','requestId':rid}
    return registry,service,auth,lease,admission,scope,rid,http

def test_crypto_roundtrip_tamper_and_typed_domains():
    context=str(uuid.uuid4());h,k=crypto.create_header(context,SECRET)
    assert crypto.unlock_header(h,context,SECRET)[1]==k
    with pytest.raises(crypto.VaultInvalid):crypto.unlock_header(h,context,'incorrect horse battery staple')
    counter=crypto.sign_counter(h,k,'2');assert crypto.verify_counter(h,k,counter)==2
    counter['next']='3'
    with pytest.raises(crypto.VaultInvalid):crypto.verify_counter(h,k,counter)
    value={'version':1,'selector':{'bytes':list(range(20))}}
    sealed=crypto.seal(h,k,str(uuid.uuid4()),'1',value);assert crypto.open_grant(h,k,sealed)==value
    sealed['ciphertext'][0]^=1
    with pytest.raises(crypto.VaultInvalid):crypto.open_grant(h,k,sealed)
    assert crypto.digest(b'abc')!=crypto.digest([97,98,99])
    assert crypto.digest({'0':97})!=crypto.digest([97])

@pytest.mark.parametrize('secret',['short','a'*1025,'12345678901\ud800'])
def test_secret_rejected(secret):
    with pytest.raises(crypto.VaultInvalid):crypto.password(secret)

def test_real_enrollment_idempotence_and_duplicate(context):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    assert service.enroll(auth,lease,admission,SECRET,rid)['status']=='accepted'
    assert service.query(auth,lease,admission,SECRET,rid)['status']=='accepted'
    assert service.enroll(auth,lease,admission,SECRET,str(uuid.uuid4()))['reason']=='offline-already-enabled'

def test_cold_unlock_no_google_and_replication_denied(context):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    registry.revoke_all(); cold=NativeAuthority();lease=cold.issue(auth);service=NativeOfflineService(cold)
    before=deepcopy(http['requests'])
    unlocked=service.unlock(auth,lease,SECRET);assert len(unlocked['choices'])==1
    target=service.open(auth,lease,unlocked['unlockSession'],unlocked['choices'][0]['handle'])
    inspected=cold.inspect_handle(auth,lease,target['handleId'])
    assert inspected['scope']==scope and target['authorizationMode']=='provider-offline'
    assert inspected['authorizationMode']=='provider-offline' and target['leaseId']==lease and target['requestId']==context[2]['requestId']
    with cold.transaction(auth,lease,'read',admission_id=inspected['admissionId'],scope=scope) as db:
        assert db.execute('SELECT COUNT(*) FROM canonical_profiles').fetchone()[0]==1
    with pytest.raises(AuthorityError,match='provider-admission-invalid'):
        ProviderReplicationOwner(cold,auth,lease,inspected['admissionId'],context[0])
    with pytest.raises(AuthorityError):cold.admit(auth,lease,scope['libraryId'])
    assert http['requests']==before

def test_bearer_and_fake_admission_do_not_enroll(context):
    host,owner,plan,activate,put,http=context;activate()
    service=NativeOfflineService(owner._registry)
    with pytest.raises(AuthorityError):service.enroll(owner._authorization,owner._lease_id,'fake',SECRET,str(uuid.uuid4()))

def test_lock_revokes_existing_offline_capability(context):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    unlocked=service.unlock(auth,lease,SECRET)
    target=service.open(auth,lease,unlocked['unlockSession'],unlocked['choices'][0]['handle'])
    admitted=registry.inspect_handle(auth,lease,target['handleId'])
    service.lock(auth,lease)
    with pytest.raises(AuthorityError):registry.revalidate(auth,lease,admitted['admissionId'])

def test_revoke_preserves_header_counter_and_is_idempotent(context):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    unlocked=service.unlock(auth,lease,SECRET);choice=unlocked['choices'][0]['handle']
    with _existing(registry._leases[lease]['path'],False) as db:before=storage.read(db,registry._leases[lease]['grant']['contextId'])
    assert service.revoke(auth,lease,unlocked['unlockSession'],choice)['status']=='revoked'
    assert service.revoke(auth,lease,unlocked['unlockSession'],choice)['status']=='revoked'
    with _existing(registry._leases[lease]['path'],False) as db:after=storage.read(db,registry._leases[lease]['grant']['contextId'])
    assert before['header']==after['header'] and before['counter']==after['counter'] and after['grants']=={}
    with pytest.raises(crypto.VaultInvalid):service.unlock(auth,lease,SECRET)


def offline_repository(registry,service,auth,lease):
    from papeer.core.edit_repository import SqliteEditRepository
    unlocked=service.unlock(auth,lease,SECRET)
    target=service.open(auth,lease,unlocked['unlockSession'],unlocked['choices'][0]['handle'])
    proof=registry.inspect_handle(auth,lease,target['handleId'])
    return SqliteEditRepository(registry.bind_repository(auth,lease,proof['admissionId']),proof['scope']),proof

def folder_batch(repo,title):
    root=repo.read(repo.scope['libraryId'])
    return {'kind':'library','id':str(uuid.uuid4()),'libraryId':repo.scope['libraryId'],'targetId':repo.scope['libraryId'],
            'parents':[root['heads'][0]],'changes':[{'type':'put-folder','folder':{'id':str(uuid.uuid4()),'title':title,'parentId':None,'position':0}}]}

def test_real_offline_commit_survives_cold_reopen_and_stays_pending(context):
    from papeer.core.edit_model import EditGraph
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    before=deepcopy(http['requests']);repo,proof=offline_repository(registry,service,auth,lease)
    batch=folder_batch(repo,'Offline durable folder')
    assert repo.commit(batch)['status']=='durable'
    assert any(record['batch']['id']==batch['id'] for record in repo.pending_records())
    registry.revoke_all();cold=NativeAuthority();lease=cold.issue(auth);service=NativeOfflineService(cold)
    repo,proof=offline_repository(cold,service,auth,lease)
    root=repo.read(scope['libraryId']);state=EditGraph(root['checkpoint']).states[root['heads'][0]]
    assert {folder['title'] for folder in state['folders']}=={'Offline durable folder'}
    assert any(record['batch']['id']==batch['id'] for record in repo.pending_records())
    assert http['requests']==before

def test_same_transaction_tamper_rolls_back_and_scope_transfer_denied(context):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    repo,proof=offline_repository(registry,service,auth,lease)
    path=registry._leases[lease]['path'];ctx=registry._leases[lease]['grant']['contextId']
    with _existing(path,False) as db:before=storage.read(db,ctx)
    with pytest.raises((AuthorityError,crypto.VaultInvalid,ValueError)):
        with registry.transaction(auth,lease,'commit',admission_id=proof['admissionId'],scope=scope) as db:
            db.execute('DELETE FROM canonical_provider_artifacts WHERE owner=?',(storage.owner_key(ctx),))
    with _existing(path,False) as db:assert storage.read(db,ctx)==before
    other=scope|{'libraryId':str(uuid.uuid4())}
    for operation,requested in [('read',other),('receive-records',scope),('provider-write',scope)]:
        with pytest.raises(AuthorityError):
            with registry.transaction(auth,lease,operation,admission_id=proof['admissionId'],scope=requested):pass

def test_activation_row_tamper_refuses_unlock_without_http(context):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    before=deepcopy(http['requests'])
    with _existing(registry._leases[lease]['path'],True) as db:
        db.execute('DELETE FROM edit_checkpoints')
    with pytest.raises((AuthorityError,crypto.VaultInvalid,ValueError)):service.unlock(auth,lease,SECRET)
    assert http['requests']==before

def test_lock_during_kdf_cannot_publish_late_unlock(context,monkeypatch):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    original=crypto.unlock_header
    def lock_after(*args):
        result=original(*args);service.lock(auth,lease);return result
    monkeypatch.setattr(crypto,'unlock_header',lock_after)
    with pytest.raises(AuthorityError,match='retired'):service.unlock(auth,lease,SECRET)
    assert not service._unlocks

def test_fixed_request_reconciles_committed_response_loss(context,monkeypatch):
    from sidecar.provider.owner import ProviderCommitUnknown
    import contextlib
    host,owner,plan,activate,put,http=context;activate();registry=owner._registry;auth=owner._authorization;lease=owner._lease_id
    admission,_=registry.admit_provider(auth,lease,owner,owner.descriptor()['scope']);service=NativeOfflineService(registry);rid=str(uuid.uuid4())
    original=owner.transaction
    @contextlib.contextmanager
    def lose_response(operation):
        with original(operation) as db:yield db
        if operation=='provider-write':raise ProviderCommitUnknown('synthetic committed response lost')
    monkeypatch.setattr(owner,'transaction',lose_response)
    assert service.enroll(auth,lease,admission,SECRET,rid)=={'requestId':rid,'status':'unknown'}
    monkeypatch.setattr(owner,'transaction',original)
    assert service.query(auth,lease,admission,SECRET,rid)=={'requestId':rid,'status':'unknown'}
    assert service.recover_enrollment(auth,lease,admission,SECRET)=={'requestId':rid,'status':'pending'}
    with pytest.raises(crypto.VaultInvalid):service.recover_enrollment(auth,lease,admission,'incorrect long passphrase')
    with _existing(registry._leases[lease]['path'],False) as db:
        pending=storage.read(db,registry._leases[lease]['grant']['contextId'])
    from sidecar.provider.owner import ProviderOperationOwner
    registry.revoke_all();cold=NativeAuthority();lease=cold.issue(auth)
    fresh_owner=ProviderOperationOwner(cold,auth,lease,host,host.current(),owner._evidence,owner._descriptor)
    admission,_=cold.admit_provider(auth,lease,fresh_owner,fresh_owner.descriptor()['scope'])
    registry=cold;service=NativeOfflineService(cold)
    assert service.recover_enrollment(auth,lease,admission,SECRET)=={'requestId':rid,'status':'pending'}
    monkeypatch.setattr(crypto,'seal',lambda *args:pytest.fail('fixed pending request encrypted twice'))
    assert service.enroll(auth,lease,admission,SECRET,rid)=={'requestId':rid,'status':'accepted'}
    with _existing(registry._leases[lease]['path'],False) as db:
        final=storage.read(db,registry._leases[lease]['grant']['contextId'])
    assert final['counter']==pending['counter'] and final['grants'][rid]==pending['pending'][rid] and final['pending']=={}
    assert service.recover_enrollment(auth,lease,admission,SECRET)=={'requestId':rid,'status':'accepted'}

def test_route_facade_real_bearer_secret_and_extra_fields(context,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from fastapi.responses import JSONResponse
    from sidecar import canonical_host
    from sidecar.routes.provider_owner import router
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    monkeypatch.setattr(canonical_host,'authority',registry)
    app=FastAPI();app.include_router(router)
    @app.exception_handler(AuthorityError)
    async def denied(request,error):return JSONResponse(status_code=403,content={'detail':'canonical-authority-denied'})
    headers={'Authorization':auth,'X-Papeer-Host-Lease':lease,'X-Papeer-Admission':admission}
    with TestClient(app) as client:
        base='/api/edits/provider-owner/offline/'
        assert client.post(base+'unlock',json={'secret':SECRET}).status_code in (401,403)
        assert client.post(base+'unlock',headers=headers,json={'secret':SECRET,'scope':scope}).status_code==422
        failed=client.post(base+'unlock',headers=headers,json={'secret':'incorrect long passphrase'})
        assert failed.status_code==403 and 'title' not in failed.text and 'scope' not in failed.text
        result=client.post(base+'unlock',headers=headers,json={'secret':SECRET})
        assert result.status_code==200 and len(result.json()['choices'])==1
        opened=client.post(base+'open',headers=headers,json={'unlockSession':result.json()['unlockSession'],'handle':result.json()['choices'][0]['handle']})
        assert opened.status_code==200 and opened.json()['authorizationMode']=='provider-offline'


def test_fresh_real_B_provider_owner_refuses_A_unlock_before_library_admission(context):
    from test_provider_verifier import connected
    from sidecar.provider.operations import ProviderOperations
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    http['principal']='fixture-permission-B';host_b,principal_b=connected()
    try:
        operations=ProviderOperations(registry,host_b);operation=operations.capture_owner(auth,lease)
        assert operations.resolve(operation,auth,lease).principal_digest==principal_b['digest']
        assert registry._provider_principal==principal_b['digest']
        before=deepcopy(http['requests'])
        with pytest.raises(AuthorityError,match='account-mismatch'):service.unlock(auth,lease,SECRET)
        assert not service._unlocks and http['requests']==before
        operations.close()
    finally:host_b.close()

def test_reserved_counter_burned_on_late_cancel_before_grant_write(context,monkeypatch):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    unlocked=service.unlock(auth,lease,SECRET);service.revoke(auth,lease,unlocked['unlockSession'],unlocked['choices'][0]['handle'])
    ctx=registry._leases[lease]['grant']['contextId'];path=registry._leases[lease]['path'];original=crypto.seal
    with _existing(path,False) as db:before=storage.read(db,ctx)
    def cancel_after_reservation(*args):
        with _existing(path,False) as db:
            reserved=storage.read(db,ctx)
            assert json.loads(reserved['counter'])['next']=='3' and reserved['grants']=={}
        service.lock(auth,lease)
        return original(*args)
    monkeypatch.setattr(crypto,'seal',cancel_after_reservation)
    next_id=str(uuid.uuid4())
    with pytest.raises(AuthorityError,match='retired'):service.enroll(auth,lease,admission,SECRET,next_id)
    with _existing(path,False) as db:after=storage.read(db,ctx)
    assert after['header']==before['header'] and after['grants']=={} and json.loads(after['counter'])['next']=='3'
    monkeypatch.setattr(crypto,'seal',original)
    assert service.enroll(auth,lease,admission,SECRET,next_id)['status']=='accepted'
    with _existing(path,False) as db:final=storage.read(db,ctx)
    assert json.loads(final['counter'])['next']=='4' and json.loads(final['grants'][next_id])['counter']=='3'

def test_bad_header_rejected_before_kdf(monkeypatch):
    h,k=crypto.create_header(str(uuid.uuid4()),SECRET);h['iterations']=1
    monkeypatch.setattr(crypto,'_wrapping',lambda *args:pytest.fail('KDF ran before header validation'))
    with pytest.raises(crypto.VaultInvalid):crypto.unlock_header(h,h['context'],SECRET)

def test_tagged_vault_rows_cannot_be_returned_as_ordinary_activation(context):
    from papeer.core.edits.provider.activation import query_prepared,recoveries
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    owner=context[1]
    assert query_prepared(owner,rid)['status']=='not-found'
    assert all(row.get('requestId')!=rid for row in recoveries(owner,lambda _:owner))


@pytest.mark.parametrize('kind',['header','counter','grant'])
def test_corrupt_vault_rows_failclosed_without_google(context,kind):
    from papeer.core.edit_model import canonical_json
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    ctx=registry._leases[lease]['grant']['contextId'];path=registry._leases[lease]['path']
    with _existing(path,True) as db:
        rows=storage.read(db,ctx);raw=rows['grants'][rid] if kind=='grant' else rows[kind]
        value=json.loads(raw)
        if kind=='header':value['wrapped'][0]^=1
        elif kind=='counter':value['next']='99'
        else:value['ciphertext'][0]^=1
        db.execute('UPDATE canonical_provider_artifacts SET payload=? WHERE owner=? AND request_id=?',
                   (canonical_json(value),storage.owner_key(ctx),storage.key(ctx,kind,rid if kind=='grant' else ctx)))
    before=deepcopy(http['requests'])
    with pytest.raises((AuthorityError,crypto.VaultInvalid,ValueError)):service.unlock(auth,lease,SECRET)
    assert http['requests']==before and not service._unlocks

def test_concurrent_new_vault_enroll_cannot_duplicate_same_active_tuple(context,monkeypatch):
    import threading
    host,owner,plan,activate,put,http=context;activate();registry=owner._registry;auth=owner._authorization;lease=owner._lease_id
    admission,_=registry.admit_provider(auth,lease,owner,owner.descriptor()['scope']);service=NativeOfflineService(registry)
    barrier=threading.Barrier(2);original=crypto.seal;outcomes=[]
    def both_encrypt(*args):
        result=original(*args);barrier.wait(timeout=5);return result
    monkeypatch.setattr(crypto,'seal',both_encrypt)
    def enroll():
        try:outcomes.append(service.enroll(auth,lease,admission,SECRET,str(uuid.uuid4()))['status'])
        except (AuthorityError,crypto.VaultInvalid):outcomes.append('refused')
    threads=[threading.Thread(target=enroll) for _ in range(2)]
    for thread in threads:thread.start()
    for thread in threads:thread.join(timeout=10);assert not thread.is_alive()
    assert sorted(outcomes)==['accepted','refused']
    with _existing(registry._leases[lease]['path'],False) as db:
        rows=storage.read(db,registry._leases[lease]['grant']['contextId']);assert len(rows['grants'])==1


def test_generation_loss_after_actual_grant_commit_is_unknown_then_reconciles(context,monkeypatch):
    host,owner,plan,activate,put,http=context;activate();registry=owner._registry;auth=owner._authorization;lease=owner._lease_id
    admission,_=registry.admit_provider(auth,lease,owner,owner.descriptor()['scope']);service=NativeOfflineService(registry)
    rid=str(uuid.uuid4());original=service._check;once=[True];path=registry._leases[lease]['path'];ctx=registry._leases[lease]['grant']['contextId']
    def retire_after_durable(job):
        original(job)
        with _existing(path,False) as db:committed=rid in storage.read(db,ctx)['grants']
        if once[0] and committed:
            once[0]=False;service.lock(auth,lease);original(job)
    monkeypatch.setattr(service,'_check',retire_after_durable)
    assert service.enroll(auth,lease,admission,SECRET,rid)=={'status':'unknown','requestId':rid}
    monkeypatch.setattr(service,'_check',original)
    assert service.query(auth,lease,admission,SECRET,rid)=={'status':'accepted','requestId':rid}


def test_route_validation_does_not_echo_submitted_secret(context,monkeypatch,caplog):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sidecar.routes.provider_owner import router
    from sidecar import canonical_host
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    monkeypatch.setattr(canonical_host,'authority',registry);app=FastAPI();app.include_router(router)
    headers={'Authorization':auth,'X-Papeer-Host-Lease':lease}
    marker='DO-NOT-ECHO-SECRET-unique-092734'
    bodies=[{'secret':marker*60},{'secret':[marker]},{'secret':marker,'unexpected':marker}, {'secret':marker,'requestId':{'leak':marker}}]
    with TestClient(app) as client:
        for body in bodies:
            response=client.post('/api/edits/provider-owner/offline/unlock',headers=headers,json=body)
            assert response.status_code==422 and marker not in response.text
            assert response.json()=={'detail':'offline-request-invalid'}
            assert response.headers['Cache-Control']=='no-store'
    assert marker not in caplog.text


def test_recover_enrollment_without_vault_does_not_create_consent(context):
    host,owner,plan,activate,put,http=context;activate();registry=owner._registry;auth=owner._authorization;lease=owner._lease_id
    admission,_=registry.admit_provider(auth,lease,owner,owner.descriptor()['scope']);service=NativeOfflineService(registry)
    assert service.recover_enrollment(auth,lease,admission,SECRET) is None
    with _existing(registry._leases[lease]['path'],False) as db:
        rows=storage.read(db,registry._leases[lease]['grant']['contextId'])
    assert rows=={'header':None,'counter':None,'grants':{},'pending':{}}


@pytest.mark.parametrize('row',['profile','peer','control','manifest','binding','header','grant','local-grant'])
def test_current_authority_rows_revoke_existing_offline_admission(context,row):
    from papeer.core.edit_model import canonical_json
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    repo,proof=offline_repository(registry,service,auth,lease)
    path=registry._leases[lease]['path'];ctx=registry._leases[lease]['grant']['contextId']
    with _existing(path,True) as db:
        if row=='profile':
            value=json.loads(db.execute('SELECT payload FROM canonical_profiles').fetchone()[0]);value['title']='Changed profile'
            db.execute('UPDATE canonical_profiles SET payload=?',(canonical_json(value),))
        elif row=='peer':
            value=json.loads(db.execute('SELECT payload FROM canonical_peers').fetchone()[0]);value['peerId']=str(uuid.uuid4())
            db.execute('UPDATE canonical_peers SET payload=?',(canonical_json(value),))
        elif row=='local-grant':
            value=json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0]);value['revision']=str(uuid.uuid4())
            db.execute('UPDATE canonical_local_owner_grants SET payload=?',(canonical_json(value),))
        elif row=='control':db.execute('UPDATE edit_dataset_controls SET frozen=1')
        elif row=='manifest':db.execute("UPDATE edit_datasets SET payload='{}'")
        elif row=='binding':
            value=json.loads(db.execute('SELECT payload FROM canonical_provider_bindings').fetchone()[0]);value['state']='revoked'
            db.execute('UPDATE canonical_provider_bindings SET payload=?',(canonical_json(value),))
        else:db.execute('DELETE FROM canonical_provider_artifacts WHERE owner=? AND request_id=?',(storage.owner_key(ctx),storage.key(ctx,row,rid if row=='grant' else ctx)))
    with pytest.raises((AuthorityError,crypto.VaultInvalid,StorageIntegrityError,ValueError,KeyError,TypeError)):repo.read(scope['libraryId'])

@pytest.mark.parametrize('artifact',['plan','initial-marker'])
def test_historical_corruption_after_admission_keeps_fixed_current_proof_but_blocks_cold_unlock(context,artifact):
    registry,service,auth,lease,admission,scope,rid,http=enrolled(context)
    repo,proof=offline_repository(registry,service,auth,lease)
    with _existing(registry._leases[lease]['path'],True) as db:
        if artifact=='plan':db.execute("UPDATE canonical_provider_artifacts SET payload='{}' WHERE owner=?",(context[1].namespace,))
        else:db.execute('DELETE FROM edit_checkpoints')
    assert repo.commit(folder_batch(repo,'Still exact current scope'))['status']=='durable'
    with pytest.raises((AuthorityError,crypto.VaultInvalid,StorageIntegrityError,ValueError,KeyError,TypeError)):service.unlock(auth,lease,SECRET)


def large_resource_enrolled(context):
    import hashlib
    from sidecar.provider.owner import ProviderOperationOwner
    from papeer.core.edits.datasets import checkpoint_hash
    from papeer.core.edits.provider.activation import _commitment,_digest,prepare_join,mark_join_published,activate_prepared
    from papeer.core.edit_model import canonical_json
    host,old_owner,original,activate,put,http=context;plan=deepcopy(original)
    body=b'bounded-native-offline-resource-'*70000  # 2.17MB, actual SQLite BLOBs in both storage locations.
    resource_id=str(uuid.uuid4());metadata={'id':resource_id,'mediaType':'application/octet-stream','byteLength':len(body),'sha256':hashlib.sha256(body).hexdigest()}
    root=plan['publication']['checkpoint']['roots'][0]
    markdown_id=str(uuid.uuid4())
    root['items'].append({'id':markdown_id,'kind':'markdown','title':'Resource owner','ownerId':None,'folderId':None,'position':0,'tags':[],'read':False,'metadata':{}})
    plan['publication']['checkpoint']['roots'].append({'kind':'markdown','id':markdown_id,'version':str(uuid.uuid4()),'content':'','appendIds':[],'imageResources':[]})
    root['items'].append({'id':str(uuid.uuid4()),'kind':'attachment','title':'Bounded resource','ownerId':markdown_id,'folderId':None,'position':0,'tags':[],'read':False,'resourceId':resource_id,'metadata':{}})
    manifest=plan['publication']['manifest'];manifest['resources']=[metadata];manifest['checkpointSha256']=checkpoint_hash(plan['publication']['checkpoint'])
    descriptor=json.loads(bytes.fromhex(plan['descriptorBytesHex']));descriptor['checkpointSha256']=manifest['checkpointSha256']
    raw=canonical_json(descriptor).encode();sha=hashlib.sha256(raw).hexdigest();version='9007199254740994'
    plan['descriptorBytesHex']=raw.hex();plan['descriptor'].update(sha256=sha,version=version)
    plan['binding'].update(descriptorSha256=sha,descriptorVersion=version)
    plan['intent'].update(descriptorSha256=sha,checkpointSha256=manifest['checkpointSha256'])
    plan['resources']=[{'metadata':metadata,'stagingKey':canonical_json([plan['ownerNamespace'],plan['requestId'],'resource',resource_id])}]
    plan['intent']['requestSha256']=_digest(_commitment(plan))
    http['files'][plan['descriptor']['id']]['bytes']=raw
    http['files'][plan['descriptor']['id']]['metadata'].update(size=str(len(raw)),sha256Checksum=sha,version=version)
    evidence=old_owner._evidence|{'descriptorSha256':sha,'descriptorVersion':version}
    registry=old_owner._registry;auth=old_owner._authorization;lease=old_owner._lease_id
    owner=ProviderOperationOwner(registry,auth,lease,host,host.current(),evidence,descriptor)
    assert prepare_join(owner,plan,{resource_id:body})['status']=='pending'
    published=deepcopy(plan);published['intent']['phase']='published'
    assert mark_join_published(owner,published)['status']=='pending'
    assert activate_prepared(owner,plan['requestId'])['status']=='accepted'
    admission,scope=registry.admit_provider(auth,lease,owner,descriptor['scope']);service=NativeOfflineService(registry);rid=str(uuid.uuid4())
    assert service.enroll(auth,lease,admission,SECRET,rid)['status']=='accepted'
    return registry,service,auth,lease,scope,rid,resource_id,body


def test_large_resource_full_validation_once_then_no_historical_hashing_per_edit(context,monkeypatch):
    from sidecar.provider.offline import snapshot
    registry,service,auth,lease,scope,rid,resource_id,body=large_resource_enrolled(context)
    calls=[0];original=snapshot.read
    def full_snapshot(*args):calls[0]+=1;return original(*args)
    monkeypatch.setattr(snapshot,'read',full_snapshot)
    repo,proof=offline_repository(registry,service,auth,lease)
    assert calls[0]==1
    assert repo.commit(folder_batch(repo,'Small edit with large initial resource'))['status']=='durable'
    assert repo.read_resource(resource_id)['bytes']==body
    assert calls[0]==1  # Every transaction still checks current proof before and after.
    ctx=registry._leases[lease]['grant']['contextId']
    with _existing(registry._leases[lease]['path'],False) as db:rows=storage.read(db,ctx)
    assert len(rows['grants'][rid])<20000  # Grant is selector+digest, not the multi-MB snapshot/body.
    with _existing(registry._leases[lease]['path'],True) as db:
        db.execute("UPDATE edit_resource_bytes SET payload=X'00'")
    with pytest.raises(StorageIntegrityError,match='stored-data-invalid'):repo.read_resource(resource_id)
    assert repo.commit(folder_batch(repo,'Current authority remains exact'))['status']=='durable'
    with pytest.raises((AuthorityError,crypto.VaultInvalid,StorageIntegrityError,ValueError,KeyError,TypeError)):service.unlock(auth,lease,SECRET)
    assert calls[0]==2


def test_staged_historical_resource_corrupt_after_unlock_only_blocks_next_cold_unlock(context):
    registry,service,auth,lease,scope,rid,resource_id,body=large_resource_enrolled(context)
    repo,proof=offline_repository(registry,service,auth,lease)
    with _existing(registry._leases[lease]['path'],True) as db:
        db.execute("UPDATE canonical_provider_resource_bytes SET payload=X'00'")
    assert repo.read_resource(resource_id)['bytes']==body
    assert repo.commit(folder_batch(repo,'Unchanged current proof'))['status']=='durable'
    with pytest.raises((AuthorityError,crypto.VaultInvalid,StorageIntegrityError,ValueError,KeyError,TypeError)):service.unlock(auth,lease,SECRET)
