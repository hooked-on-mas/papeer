"""Explicit permission removal: real SQLite/live owner, synthetic old sealed metadata.

Old selectors intentionally need no surviving historical rows. These fixtures do
not claim a real epoch migration, OAuth, Google, GUI or profile-rollback defense.
"""
from copy import deepcopy
from contextlib import contextmanager
import hashlib
import json
import re
import threading
import uuid

import pytest
from test_provider_verifier import http as google_http, connected  # noqa: F401
from test_provider_data_plane import context as drive_context  # noqa: F401
from test_native_offline import enrolled, offline_repository, folder_batch, SECRET
from papeer.core.edit_model import canonical_json
from sidecar.canonical_host import AuthorityError, _existing
from sidecar.provider.offline import crypto, snapshot, storage
from sidecar.provider.offline.service import NativeOfflineService
from sidecar.provider.owner import ProviderCommitUnknown


@pytest.fixture
def context(request):
    return request.getfixturevalue('drive_context')


def rows(registry, lease):
    with _existing(registry._leases[lease]['path'], False) as db:
        return storage.read(db, registry._leases[lease]['grant']['contextId'])


def store_sealed(registry, lease, payload, record_id, *, kind='grant', replace=False):
    """Trusted test data: use an actual unused nonce/MAC and real encrypted row."""
    context_id = registry._leases[lease]['grant']['contextId']
    saved = rows(registry, lease)
    header, keys = crypto.unlock_header(json.loads(saved['header']), context_id, SECRET)
    counter = crypto.verify_counter(header, keys, json.loads(saved['counter']))
    cipher = crypto.seal(header, keys, record_id, str(counter), payload)
    with _existing(registry._leases[lease]['path'], True) as db:
        storage.reserve(db, context_id, saved['counter'], crypto.sign_counter(header, keys, str(counter + 1)))
        if replace:
            db.execute('DELETE FROM canonical_provider_artifacts WHERE owner=? AND request_id=?',
                       (storage.owner_key(context_id), storage.key(context_id, kind, record_id)))
        storage.insert(db, context_id, kind, record_id, cipher)
    return cipher


def stale_payload(registry, lease, record_id):
    saved = rows(registry, lease)
    header, keys = crypto.unlock_header(json.loads(saved['header']), registry._leases[lease]['grant']['contextId'], SECRET)
    payload = crypto.open_grant(header, keys, json.loads(saved['grants'][record_id]))
    old = deepcopy(payload)
    old['selector']['scope']['epoch'] = 'retired-test-epoch'
    old['selector']['binding']['scope'] = deepcopy(old['selector']['scope'])
    old['selector']['binding']['id'] = str(uuid.uuid4())
    old['selector']['requestId'] = str(uuid.uuid4())
    old['selector']['manifestId'] = str(uuid.uuid4())
    old['activationDigest'] = 'e' * 64
    return old


def contents(registry, lease):
    """Compare content, outbox, control and ordinary provider rows exactly."""
    with _existing(registry._leases[lease]['path'], False) as db:
        result = {}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            if name == 'canonical_provider_artifacts': continue
            quoted = name.replace('"', '""')
            result[name] = db.execute('SELECT * FROM "' + quoted + '" ORDER BY rowid').fetchall()
        result['ordinary-provider-artifacts'] = db.execute('SELECT * FROM canonical_provider_artifacts WHERE owner=? ORDER BY request_id',
                                                         (registry._leases[lease]['grant']['namespaceId'],)).fetchall()
        return result


def test_explicit_reclaim_removes_stale_grant_and_pending_without_historical_admission(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    repository, _proof = offline_repository(registry, service, auth, lease)
    batch = folder_batch(repository, 'Durable content and outbox must remain')
    assert repository.commit(batch)['status'] == 'durable'
    old = stale_payload(registry, lease, record_id)
    store_sealed(registry, lease, old, record_id, replace=True)
    pending_id = str(uuid.uuid4()); store_sealed(registry, lease, old, pending_id, kind='pending')
    before, content_before = rows(registry, lease), contents(registry, lease)
    with _existing(registry._leases[lease]['path'], False) as db:
        assert not db.execute('SELECT 1 FROM canonical_provider_artifacts WHERE owner=? AND request_id=?',
                              (context[1].namespace, old['selector']['requestId'])).fetchone()
    monkeypatch.setattr(snapshot, 'read', lambda *args: pytest.fail('Revocation consulted historical activation'))
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}
    after = rows(registry, lease)
    assert after['header'] == before['header'] and after['counter'] == before['counter']
    assert after['grants'] == {} and after['pending'] == {}
    assert contents(registry, lease) == content_before
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}
    assert contents(registry, lease) == content_before


@pytest.mark.parametrize('different', ['account', 'library', 'principal', 'owner'])
def test_other_identity_rows_are_preserved(different, context):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    old = stale_payload(registry, lease, record_id)
    if different in ('account', 'library'):
        old['selector']['scope']['accountId' if different == 'account' else 'libraryId'] = str(uuid.uuid4())
        old['selector']['binding']['scope'] = deepcopy(old['selector']['scope'])
    elif different == 'principal': old['selector']['binding']['principalDigest'] = 'b' * 64
    else: old['selector']['ownerNamespace'] = str(uuid.uuid4())
    store_sealed(registry, lease, old, record_id, replace=True)
    before = rows(registry, lease)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}
    assert rows(registry, lease) == before


def test_wrong_secret_and_fake_admission_never_mutate_or_reserve_barrier(context):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    before = rows(registry, lease)
    with pytest.raises(crypto.VaultInvalid): service.revoke_enrollment(auth, lease, admission, 'incorrect long secret')
    with pytest.raises(AuthorityError): service.revoke_enrollment(auth, lease, 'unissued', SECRET)
    assert rows(registry, lease) == before and not registry._offline_jobs.barriers


def test_active_B_cannot_revoke_A(context):
    from sidecar.provider.operations import ProviderOperations
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    before = rows(registry, lease)
    http['principal'] = 'fixture-permission-B'; host_b, principal_b = connected()
    try:
        operations = ProviderOperations(registry, host_b); operation = operations.capture_owner(auth, lease)
        assert operations.resolve(operation, auth, lease).principal_digest == principal_b['digest']
        with pytest.raises((AuthorityError, ValueError)): service.revoke_enrollment(auth, lease, admission, SECRET)
        assert rows(registry, lease) == before
        operations.close()
    finally: host_b.close()


def test_after_commit_response_loss_is_unknown_and_retry_is_idempotent(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    before = rows(registry, lease); original = context[1].transaction
    @contextmanager
    def lose_response(operation):
        with original(operation) as db: yield db
        if operation == 'provider-write': raise ProviderCommitUnknown('synthetic committed response loss')
    monkeypatch.setattr(context[1], 'transaction', lose_response)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'unknown'}
    after = rows(registry, lease)
    assert after['grants'] == {} and after['counter'] == before['counter'] and after['header'] == before['header']
    assert not registry._offline_jobs.barriers
    monkeypatch.setattr(context[1], 'transaction', original)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}


def test_target_payload_CAS_failure_rolls_back_all_deletes(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    before = rows(registry, lease); original = storage.remove_permission
    def changed_before_delete(db, context_id, kind, request_id, raw):
        db.execute("UPDATE canonical_provider_artifacts SET payload='{}' WHERE owner=? AND request_id=?",
                   (storage.owner_key(context_id), storage.key(context_id, kind, request_id)))
        original(db, context_id, kind, request_id, raw)
    monkeypatch.setattr(storage, 'remove_permission', changed_before_delete)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'unknown'}
    assert rows(registry, lease) == before
    assert registry._offline_jobs.barriers  # unknown/unsettled retirement is not silently released
    monkeypatch.setattr(storage, 'remove_permission', original)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}


def test_reclaim_cancels_drains_old_job_and_rejects_new_target_enrollment(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    store_sealed(registry, lease, stale_payload(registry, lease, record_id), record_id, replace=True)
    second = NativeOfflineService(registry)
    entered, release, barrier_reserved = threading.Event(), threading.Event(), threading.Event()
    original_seal, original_reserve = crypto.seal, registry._offline_jobs.reserve
    outcomes = {}
    def delayed_seal(*args):
        value = original_seal(*args); entered.set(); assert release.wait(10); return value
    def reserve(key):
        value = original_reserve(key); barrier_reserved.set(); return value
    monkeypatch.setattr(crypto, 'seal', delayed_seal); monkeypatch.setattr(registry._offline_jobs, 'reserve', reserve)
    def enroll():
        try: outcomes['enroll'] = second.enroll(auth, lease, admission, SECRET, str(uuid.uuid4()))
        except AuthorityError: outcomes['enroll'] = 'retired'
    def revoke(): outcomes['revoke'] = service.revoke_enrollment(auth, lease, admission, SECRET)
    producer, revoker = threading.Thread(target=enroll), threading.Thread(target=revoke)
    try:
        producer.start(); assert entered.wait(5); revoker.start(); assert barrier_reserved.wait(5)
        assert revoker.is_alive()  # Not reported revoked before the old producer drains.
        with pytest.raises(AuthorityError): second.enroll(auth, lease, admission, SECRET, str(uuid.uuid4()))
        release.set(); producer.join(6); revoker.join(6)
        assert not producer.is_alive() and not revoker.is_alive()
        assert outcomes == {'enroll': 'retired', 'revoke': {'status': 'revoked'}}
        assert rows(registry, lease)['grants'] == {} and rows(registry, lease)['pending'] == {}
        assert not registry._offline_jobs.barriers
    finally:
        release.set()
        if producer.ident is not None: producer.join(6)
        if revoker.ident is not None: revoker.join(6)


def test_timeout_keeps_barrier_until_authorized_retry_after_drain(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    store_sealed(registry, lease, stale_payload(registry, lease, record_id), record_id, replace=True)
    entered, release = threading.Event(), threading.Event(); original = crypto.seal; outcomes = []
    def delayed(*args):
        value = original(*args); entered.set(); assert release.wait(15); return value
    monkeypatch.setattr(crypto, 'seal', delayed)
    def enroll():
        try: service.enroll(auth, lease, admission, SECRET, str(uuid.uuid4()))
        except AuthorityError: outcomes.append('retired')
    producer = threading.Thread(target=enroll)
    try:
        producer.start(); assert entered.wait(5)
        assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'unknown'}
        assert registry._offline_jobs.barriers
        with pytest.raises(AuthorityError): service.enroll(auth, lease, admission, SECRET, str(uuid.uuid4()))
        release.set(); producer.join(6); assert outcomes == ['retired']
        assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}
        assert not registry._offline_jobs.barriers
    finally:
        release.set(); producer.join(6)


def second_library(context):
    """A second actual activated dataset through production prepare/activate APIs."""
    from papeer.core.edits.datasets import checkpoint_hash
    from papeer.core.edits.provider.activation import _commitment, _digest, prepare_join, mark_join_published, activate_prepared
    from sidecar.provider.owner import ProviderOperationOwner
    host, first, original, activate, put, http = context
    replacements = {}
    def remap(value):
        if isinstance(value, dict): return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list): return [remap(item) for item in value]
        if isinstance(value, str) and value != first.namespace and re.fullmatch('[0-9a-f-]{36}', value):
            return replacements.setdefault(value, str(uuid.uuid4()))
        return value
    plan = remap(deepcopy(original)); plan['ownerNamespace'] = first.namespace
    scope = plan['binding']['scope']; manifest = plan['publication']['manifest']
    manifest['checkpointSha256'] = checkpoint_hash(plan['publication']['checkpoint'])
    descriptor = {'version': 1, 'scope': scope, 'manifestId': manifest['id'], 'checkpointSha256': manifest['checkpointSha256']}
    raw = canonical_json(descriptor).encode(); sha = hashlib.sha256(raw).hexdigest()
    folder, selected = 'fixture-second-folder', 'fixture-second-descriptor'
    plan['folderId'] = folder; plan['descriptorBytesHex'] = raw.hex()
    plan['descriptor'].update(id=selected, sha256=sha)
    plan['binding'].update(descriptorId=selected, descriptorSha256=sha)
    plan['intent'].update(descriptorSha256=sha, checkpointSha256=manifest['checkpointSha256'])
    plan['intent']['requestSha256'] = _digest(_commitment(plan))
    http['files'][folder] = {'metadata': http['metadata'](folder, mimeType='application/vnd.google-apps.folder', properties={}), 'bytes': b''}
    http['files'][selected] = {'metadata': http['metadata'](selected, parents=[folder], size=str(len(raw)), sha256Checksum=sha, version=plan['descriptor']['version']), 'bytes': raw}
    evidence = first._evidence | {'descriptorId': selected, 'descriptorSha256': sha, 'folderId': folder}
    owner = ProviderOperationOwner(first._registry, first._authorization, first._lease_id, host, host.current(), evidence, descriptor)
    assert prepare_join(owner, plan, {})['status'] == 'pending'
    published = deepcopy(plan); published['intent']['phase'] = 'published'
    assert mark_join_published(owner, published)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    admission, _scope = first._registry.admit_provider(first._authorization, first._lease_id, owner, scope)
    return owner, admission, scope


def test_real_other_library_enrollment_and_online_editor_survive_target_retirement(context, monkeypatch):
    from papeer.core.edit_repository import SqliteEditRepository
    registry, service, auth, lease, admission_a, scope_a, record_id, http = enrolled(context)
    store_sealed(registry, lease, stale_payload(registry, lease, record_id), record_id, replace=True)
    owner_b, admission_b, scope_b = second_library(context)
    second = NativeOfflineService(registry)
    online_a = SqliteEditRepository(registry.bind_repository(auth, lease, admission_a), scope_a)
    entered, release, reserved = threading.Event(), threading.Event(), threading.Event()
    original_seal, original_reserve = crypto.seal, registry._offline_jobs.reserve
    outcomes = {}
    def delay_only_a(*args):
        value = original_seal(*args)
        if args[-1]['selector']['scope']['libraryId'] == scope_a['libraryId']:
            entered.set(); assert release.wait(10)
        return value
    def reserve(key):
        value = original_reserve(key); reserved.set(); return value
    monkeypatch.setattr(crypto, 'seal', delay_only_a); monkeypatch.setattr(registry._offline_jobs, 'reserve', reserve)
    def enroll_a():
        try: outcomes['a'] = second.enroll(auth, lease, admission_a, SECRET, str(uuid.uuid4()))
        except AuthorityError: outcomes['a'] = 'retired'
    def revoke_a(): outcomes['revoke'] = service.revoke_enrollment(auth, lease, admission_a, SECRET)
    producer, revoker = threading.Thread(target=enroll_a), threading.Thread(target=revoke_a)
    try:
        producer.start(); assert entered.wait(5); revoker.start(); assert reserved.wait(5)
        request_b = str(uuid.uuid4())
        assert second.enroll(auth, lease, admission_b, SECRET, request_b)['status'] == 'accepted'
        foreign_before = rows(registry, lease)['grants'][request_b]
        assert online_a.commit(folder_batch(online_a, 'Online editor remains live'))['status'] == 'durable'
        release.set(); producer.join(6); revoker.join(6)
        assert outcomes == {'a': 'retired', 'revoke': {'status': 'revoked'}}
        saved = rows(registry, lease)
        assert saved['grants'] == {request_b: foreign_before} and saved['pending'] == {}
        repository_b, proof_b = offline_repository(registry, second, auth, lease)
        assert proof_b['scope'] == scope_b
        assert repository_b.commit(folder_batch(repository_b, 'Other Library still usable'))['status'] == 'durable'
        assert online_a.read(scope_a['libraryId'])
    finally:
        release.set()
        if producer.ident is not None: producer.join(6)
        if revoker.ident is not None: revoker.join(6)


def test_real_route_pre_effect_secret_failure_vs_unknown_retirement(context, monkeypatch):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient
    from sidecar import canonical_host
    from sidecar.provider.offline import routes
    from sidecar.routes.provider_owner import router
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    monkeypatch.setattr(canonical_host, 'authority', registry); monkeypatch.setattr(routes, '_service', service)
    app = FastAPI(); app.include_router(router)
    @app.exception_handler(AuthorityError)
    async def denied(request, error): return JSONResponse(status_code=403, content={'detail': 'canonical-authority-denied'})
    headers = {'Authorization': auth, 'X-Papeer-Host-Lease': lease, 'X-Papeer-Admission': admission}
    url = '/api/edits/provider-owner/offline/revoke-enrollment'
    before = rows(registry, lease)
    with TestClient(app) as client:
        marker = 'WRONG-secret-should-not-echo'
        response = client.post(url, headers=headers, json={'secret': marker})
        assert response.status_code == 403 and marker not in response.text
        assert rows(registry, lease) == before and not registry._offline_jobs.barriers
        rejected = client.post(url, headers=headers, json={'secret': SECRET, 'scope': scope})
        assert rejected.status_code == 422 and SECRET not in rejected.text
        original = storage.remove_permission
        monkeypatch.setattr(storage, 'remove_permission', lambda *args: (_ for _ in ()).throw(ValueError('synthetic reserved failure')))
        unknown = client.post(url, headers=headers, json={'secret': SECRET})
        assert unknown.status_code == 200 and unknown.json() == {'status': 'unknown'}
        assert rows(registry, lease) == before and registry._offline_jobs.barriers
        monkeypatch.setattr(storage, 'remove_permission', original)
        finished = client.post(url, headers=headers, json={'secret': SECRET})
        assert finished.status_code == 200 and finished.json() == {'status': 'revoked'}


def test_retirement_drains_enrollment_before_network_verification_finishes(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    entered, release, reserved = threading.Event(), threading.Event(), threading.Event(); outcomes = {}
    original_verify, original_reserve = context[1].verify_fresh, registry._offline_jobs.reserve
    def delayed_verify():
        if threading.current_thread().name == 'pre-verification-enrollment':
            entered.set(); assert release.wait(10)
        return original_verify()
    def reserve(key):
        value = original_reserve(key); reserved.set(); return value
    monkeypatch.setattr(context[1], 'verify_fresh', delayed_verify); monkeypatch.setattr(registry._offline_jobs, 'reserve', reserve)
    def enroll():
        try: outcomes['enroll'] = service.enroll(auth, lease, admission, SECRET, str(uuid.uuid4()))
        except AuthorityError: outcomes['enroll'] = 'retired'
    def revoke(): outcomes['revoke'] = service.revoke_enrollment(auth, lease, admission, SECRET)
    producer = threading.Thread(target=enroll, name='pre-verification-enrollment'); revoker = threading.Thread(target=revoke)
    try:
        producer.start(); assert entered.wait(5); revoker.start(); assert reserved.wait(5)
        assert revoker.is_alive()
        release.set(); producer.join(6); revoker.join(6)
        assert outcomes == {'enroll': 'retired', 'revoke': {'status': 'revoked'}}
        assert rows(registry, lease)['grants'] == {} and not registry._offline_jobs.barriers
    finally:
        release.set()
        if producer.ident is not None: producer.join(6)
        if revoker.ident is not None: revoker.join(6)


def test_current_live_proof_change_inside_delete_transaction_rolls_back(context, monkeypatch):
    registry, service, auth, lease, admission, scope, record_id, http = enrolled(context)
    before, content_before = rows(registry, lease), contents(registry, lease)
    original = storage.remove_permission
    def changed_live_proof(db, context_id, kind, request_id, raw):
        value = json.loads(db.execute('SELECT payload FROM canonical_profiles').fetchone()[0])
        value['title'] = 'Concurrent profile mutation'
        db.execute('UPDATE canonical_profiles SET payload=?', (canonical_json(value),))
        original(db, context_id, kind, request_id, raw)
    monkeypatch.setattr(storage, 'remove_permission', changed_live_proof)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'unknown'}
    assert rows(registry, lease) == before and contents(registry, lease) == content_before
    monkeypatch.setattr(storage, 'remove_permission', original)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}


def test_absent_vault_revoke_is_idempotent_and_creates_no_permission(context, monkeypatch):
    host, owner, plan, activate, put, http = context; activate()
    registry, auth, lease = owner._registry, owner._authorization, owner._lease_id
    admission, scope = registry.admit_provider(auth, lease, owner, owner.descriptor()['scope'])
    service = NativeOfflineService(registry)
    monkeypatch.setattr(crypto, 'unlock_header', lambda *args: pytest.fail('No stored secret exists to unwrap'))
    before, content_before = rows(registry, lease), contents(registry, lease)
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}
    assert service.revoke_enrollment(auth, lease, admission, SECRET) == {'status': 'revoked'}
    assert rows(registry, lease) == before and contents(registry, lease) == content_before
    assert not registry._offline_jobs.barriers
