"""Synthetic provider verifier with the real Native authority and isolated SQLite."""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import pytest

from papeer.core.edits.provider.activation import _check_create_prepared, _commitment, _digest, acknowledge, activate_prepared, mark_create_published, mark_join_published, prepare_create, prepare_join, query_prepared, recoveries, upgrade_provider_metadata
from papeer.core.edits.provider.prepare_plan import prepare_new_provider_library
from sidecar import deps
from sidecar.canonical_host import AuthorityError, NativeAuthority
from sidecar.provider.owner import ProviderCommitUnknown, ProviderOperationOwner
from sidecar.provider.operations import ProviderOperations
from sidecar.provider.publication import publish_retained_create
from sidecar.provider.create_service import ProviderCreateService
from sidecar.provider.join_service import ProviderJoinService
from sidecar.provider.sync_authority import SyncAuthority
from sidecar.provider.sync_once import sync_once
from sidecar.provider.replication import ProviderReplicationOwner
from sidecar.provider.transfer_ids import TransferIds
from papeer.core.edit_repository import SqliteEditRepository
from sidecar.provider.hub import NativeProviderHub
from sidecar.routes import provider_owner

FIXTURE = json.loads((Path(__file__).parents[2] / 'fixtures/synthetic-provider-owner-plan.json').read_text(encoding='utf8'))


def stage_join(owner, plan):
    prepared = deepcopy(plan); prepared['intent']['phase'] = 'prepared'
    assert prepare_join(owner, prepared, {})['status'] == 'pending'
    with pytest.raises(ValueError, match='provider-plan-phase'):
        activate_prepared(owner, plan['requestId'])
    return mark_join_published(owner, plan)


class SyntheticVerifier:
    def __init__(self):
        import threading
        self.generation = 1; self.fail_on_exit = False; self.summary = None; self._io = threading.local()
    @contextmanager
    def guard(self, principal):
        self.assert_current(principal); yield
        if self.fail_on_exit:
            self.fail_on_exit = False; self.generation += 1
        self.assert_current(principal)
    def assert_current(self, principal):
        if principal['generation'] != self.generation: raise AuthorityError('provider-stale')
    def descriptor(self, principal, _selection):
        self.assert_current(principal); return deepcopy(self.summary)
    def close(self): pass
    @contextmanager
    def operation_guard(self, principal):
        with self.guard(principal): yield
    def _request_group(self): return getattr(self._io, 'group', None)
    def new_request_group(self):
        from papeer.core.providers.drive.request_group import ProviderRequestCancelled
        class Group:
            cancelled = False
            def cancel(self): self.cancelled = True
            def close(self): self.cancelled = True
            def check(self):
                if self.cancelled: raise ProviderRequestCancelled('provider-io-cancelled')
        return Group()
    @contextmanager
    def io_scope(self, group):
        previous = self._request_group(); self._io.group = group
        try: group.check(); yield; group.check()
        finally: self._io.group = previous


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setenv('PAPEER_DATA_DIR', str(tmp_path / 'isolated'))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy library opened'))
    registry = NativeAuthority(); auth = 'Bearer synthetic-token'; lease = registry.provision(auth)
    plan = deepcopy(FIXTURE['plans']['join']); plan['intent']['phase'] = 'published'
    plan['ownerNamespace'] = registry._lease(auth, lease)['grant']['namespaceId']
    plan['intent']['requestSha256'] = _digest(_commitment(plan))
    principal = {'digest': plan['principalDigest'], 'generation': 1}
    evidence = {'principalDigest': plan['principalDigest'], 'descriptorId': plan['descriptor']['id'],
                'descriptorVersion': plan['descriptor']['version'], 'descriptorSha256': plan['descriptor']['sha256'],
                'owner': True, 'readable': True, 'writable': True, 'folderId': plan['folderId']}
    descriptor = json.loads(bytes.fromhex(plan['descriptorBytesHex']).decode('utf8'))
    verifier = SyntheticVerifier()
    verifier.summary = {'id': evidence['descriptorId'], 'version': evidence['descriptorVersion'], 'sha256': evidence['descriptorSha256'],
                        'folderId': evidence['folderId'], 'scope': plan['intent']['scope'], 'owner': True, 'writable': True, 'title': plan['title']}
    owner = ProviderOperationOwner(registry, auth, lease, verifier, principal, evidence, descriptor)
    with owner.transaction('provider-upgrade') as db: upgrade_provider_metadata(db)
    return registry, auth, lease, owner, verifier, plan


def test_atomic_activation_and_admission_are_bound_to_live_owner(context):
    registry, auth, lease, owner, verifier, plan = context; request = plan['requestId']; scope = plan['binding']['scope']
    assert owner.namespace != scope['accountId']
    assert stage_join(owner, plan)['status'] == 'pending'
    with pytest.raises((AuthorityError, ValueError)): owner.assert_admitted()
    assert mark_join_published(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, request)['status'] == 'accepted'
    assert mark_join_published(owner, plan)['status'] == 'accepted'
    assert query_prepared(owner, request)['status'] == 'accepted'
    assert owner.assert_admitted() == scope
    assert recoveries(owner, lambda _id: owner)[0]['requestId'] == request
    acknowledge(owner, request)
    assert recoveries(owner, lambda _id: owner) == []
    assert query_prepared(owner, request)['status'] == 'accepted'
    admission, admitted = registry.admit_provider(auth, lease, owner, scope); assert admitted == scope
    previous_descriptor = verifier.descriptor; calls = []
    verifier.descriptor = lambda *args: (calls.append(1), previous_descriptor(*args))[1]
    with registry.transaction(auth, lease, 'read', admission_id=admission, scope=scope): pass
    assert calls == []  # Local editor reads/commits fence stored proof and generation without network.
    with pytest.raises(AuthorityError): registry.admit(auth, lease, scope['libraryId'])
    with pytest.raises(AuthorityError):
        with registry.transaction(auth, lease, 'read', admission_id=admission, scope={**scope, 'epoch': 'other'}): pass
    verifier.generation += 1
    with pytest.raises(AuthorityError):
        with registry.transaction(auth, lease, 'read', admission_id=admission, scope=scope): pass


def test_activation_rolls_back_all_rows_when_profile_write_fails(context):
    registry, auth, lease, owner, _verifier, plan = context; request = plan['requestId']
    assert stage_join(owner, plan)['status'] == 'pending'
    with owner.transaction('provider-upgrade') as db:
        db.execute("CREATE TRIGGER fail_provider_profile BEFORE INSERT ON canonical_profiles BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.IntegrityError): activate_prepared(owner, request)
    assert query_prepared(owner, request)['status'] == 'pending'
    namespace = json.dumps([plan['binding']['scope'][key] for key in ('accountId', 'libraryId', 'epoch')], separators=(',', ':'))
    with owner.transaction('provider-upgrade') as db:
        assert db.execute('SELECT count(*) FROM edit_roots WHERE scope=?', (namespace,)).fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM edit_datasets WHERE scope=?', (namespace,)).fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM canonical_profiles').fetchone()[0] == 0
        db.execute('DROP TRIGGER fail_provider_profile')
    assert activate_prepared(owner, request)['status'] == 'accepted'


@pytest.mark.parametrize('table,key', [
    ('edit_projection_pages', 'id'),
    ('edit_publications', 'id'),
])
def test_activation_rejects_existing_orphan_scope_rows(context, table, key):
    _registry, _auth, _lease, owner, _verifier, plan = context
    scope = plan['binding']['scope']
    namespace = json.dumps([scope[k] for k in ('accountId', 'libraryId', 'epoch')], separators=(',', ':'))
    assert stage_join(owner, plan)['status'] == 'pending'
    with owner.transaction('provider-upgrade') as db:
        db.execute(f'INSERT INTO {table} (scope,{key},payload) VALUES (?,?,?)', (namespace, 'orphan', '{}'))
    with pytest.raises(ValueError, match='provider-scope-already-present'):
        activate_prepared(owner, plan['requestId'])
    assert query_prepared(owner, plan['requestId'])['status'] == 'pending'
    with owner.transaction('provider-read') as db:
        assert db.execute('SELECT count(*) FROM canonical_profiles').fetchone()[0] == 0
        assert db.execute(f'SELECT count(*) FROM {table} WHERE scope=?', (namespace,)).fetchone()[0] == 1


def test_create_retains_ids_before_publication_and_cas(context):
    registry, auth, lease, _owner, verifier, _join = context
    plan = deepcopy(FIXTURE['plans']['create'])
    plan['ownerNamespace'] = registry._lease(auth, lease)['grant']['namespaceId']
    plan['intent']['requestSha256'] = _digest(_commitment(plan))
    principal = {'digest': plan['principalDigest'], 'generation': 1}
    owner = ProviderOperationOwner(registry, auth, lease, verifier, principal, None, None)
    assert prepare_create(owner, plan)['status'] == 'pending'
    assert prepare_create(owner, plan)['status'] == 'pending'
    assert query_prepared(owner, plan['requestId'])['status'] == 'pending'
    changed = deepcopy(plan); changed['createObjects']['manifestFileId'] = 'replacement'
    changed['intent']['requestSha256'] = _digest(_commitment(changed))
    with pytest.raises(ValueError, match='provider-request-reused'):
        prepare_create(owner, changed)
    binding = {'version': 1, 'id': plan['intent']['bindingId'], 'provider': 'google-drive',
               'principalDigest': plan['principalDigest'], 'scope': plan['intent']['scope'],
               'descriptorId': plan['descriptor']['id'], 'descriptorVersion': '7',
               'descriptorSha256': plan['descriptor']['sha256'], 'state': 'preparing'}
    published = deepcopy(plan); published['binding'] = binding; published['intent']['phase'] = 'published'
    evidence = {'principalDigest': plan['principalDigest'], 'descriptorId': binding['descriptorId'],
                'descriptorVersion': '7', 'descriptorSha256': binding['descriptorSha256'], 'owner': True,
                'readable': True, 'writable': True, 'folderId': plan['folderId']}
    descriptor = json.loads(bytes.fromhex(plan['descriptorBytesHex']).decode('utf8'))
    verifier.summary = {'id': binding['descriptorId'], 'version': binding['descriptorVersion'], 'sha256': binding['descriptorSha256'],
                        'folderId': plan['folderId'], 'scope': binding['scope'], 'owner': True, 'writable': True}
    selected = ProviderOperationOwner(registry, auth, lease, verifier, principal, evidence, descriptor)
    assert mark_create_published(selected, published)['status'] == 'pending'
    assert mark_create_published(selected, published)['status'] == 'pending'
    assert activate_prepared(selected, plan['requestId'])['status'] == 'accepted'
    assert mark_create_published(selected, published)['status'] == 'accepted'
    assert prepare_create(owner, plan)['status'] == 'pending'
    assert query_prepared(selected, plan['requestId'])['status'] == 'accepted'


def test_commit_guard_exit_is_unknown_and_reauthenticated_query_recovers(context):
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    with pytest.raises(ProviderCommitUnknown):
        with owner.transaction('provider-prepare') as db:
            db.execute('UPDATE canonical_provider_intents SET payload=payload WHERE owner=? AND request_id=?', (owner.namespace, plan['requestId']))
            verifier.fail_on_exit = True
    principal = {'digest': plan['principalDigest'], 'generation': verifier.generation}
    replacement = ProviderOperationOwner(registry, auth, lease, verifier, principal, owner._evidence, owner._descriptor)
    assert query_prepared(replacement, plan['requestId']) == {'status': 'pending', 'requestId': plan['requestId']}


def test_activation_unknown_after_commit_recovers_same_accepted_request(context):
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    original = owner.transaction
    @contextmanager
    def fail_after_commit(operation):
        with original(operation) as db:
            yield db
            if operation == 'provider-activate': verifier.fail_on_exit = True
    owner.transaction = fail_after_commit
    with pytest.raises(ProviderCommitUnknown): activate_prepared(owner, plan['requestId'])
    principal = {'digest': plan['principalDigest'], 'generation': verifier.generation}
    replacement = ProviderOperationOwner(registry, auth, lease, verifier, principal, owner._evidence, owner._descriptor)
    assert query_prepared(replacement, plan['requestId']) == {'status': 'accepted', 'requestId': plan['requestId']}
    assert activate_prepared(replacement, plan['requestId'])['status'] == 'accepted'


def test_opaque_operations_reject_wrong_lease_and_changed_descriptor(context):
    registry, auth, lease, _owner, verifier, plan = context
    principal = {'digest': plan['principalDigest'], 'generation': verifier.generation}
    summary = {'id': plan['descriptor']['id'], 'version': plan['descriptor']['version'],
               'sha256': plan['descriptor']['sha256'], 'scope': plan['intent']['scope'],
               'owner': True, 'writable': True, 'folderId': plan['folderId'], 'title': plan['title']}
    verifier.current = lambda: principal
    verifier.descriptor = lambda _principal, _selection: deepcopy(summary)
    verifier.descriptor_bytes = lambda _principal, _id: bytes.fromhex(plan['descriptorBytesHex'])
    operations = ProviderOperations(registry, verifier)
    token = operations.capture_descriptor(auth, lease, summary['id'])
    with pytest.raises(AuthorityError, match='provider-operation-invalid'):
        operations.resolve(token, auth, 'different-lease')
    assert operations.resolve(token, auth, lease).namespace == plan['ownerNamespace']
    summary['version'] = '8'
    with pytest.raises(AuthorityError, match='provider-descriptor-changed'):
        operations.resolve(token, auth, lease)
    summary['version'] = '7'
    with pytest.raises(AuthorityError, match='provider-operation-invalid'):
        operations.resolve(token, auth, lease)


@pytest.mark.parametrize('title,valid', [('😀' * 200, True), ('😀' * 201, False), ('\ufeff', True), ('\x85x', False), ('\x1cx', False)])
def test_create_title_uses_codepoints_and_python_strip(context, title, valid):
    registry, auth, lease, owner, _verifier, _join = context
    plan = deepcopy(FIXTURE['plans']['create'])
    plan['ownerNamespace'] = registry._lease(auth, lease)['grant']['namespaceId']
    plan['title'] = title; plan['intent']['requestSha256'] = _digest(_commitment(plan))
    if valid:
        assert _check_create_prepared(plan, owner)['title'] == title
    else:
        with pytest.raises(ValueError, match='provider-prepared-plan-invalid'):
            _check_create_prepared(plan, owner)


def test_native_create_constructor_generates_valid_retained_plan(context):
    _registry, _auth, _lease, owner, _verifier, _join = context
    common = {'ownerNamespace': owner.namespace, 'principalDigest': owner.principal_digest,
              'requestId': '00000000-0000-0000-0000-000000001111'}
    ids = {'folderId': 'drive-folder', 'checkpointFileId': 'drive-checkpoint', 'manifestFileId': 'drive-manifest', 'descriptorFileId': 'drive-descriptor'}
    plan = prepare_new_provider_library(common, '  title  ', ids)
    assert plan['title'] == 'title' and plan['binding'] is None and plan['intent']['phase'] == 'prepared'
    assert _check_create_prepared(plan, owner) == plan
    assert prepare_create(owner, plan)['status'] == 'pending'


def test_create_remote_retry_reuses_all_retained_ids(context):
    registry, auth, lease, _owner, verifier, _join = context
    common = {'ownerNamespace': registry._lease(auth, lease)['grant']['namespaceId'],
              'principalDigest': FIXTURE['plans']['create']['principalDigest'], 'requestId': '00000000-0000-0000-0000-000000001112'}
    ids = {'folderId': 'drive-folder', 'checkpointFileId': 'drive-checkpoint', 'manifestFileId': 'drive-manifest', 'descriptorFileId': 'drive-descriptor'}
    plan = prepare_new_provider_library(common, 'title', ids)
    owner = ProviderOperationOwner(registry, auth, lease, verifier, {'digest': common['principalDigest'], 'generation': 1}, None, None)
    assert prepare_create(owner, plan)['status'] == 'pending'
    seen = []; fail_once = [True]
    verifier.create_folder = lambda file_id, *_args: seen.append(file_id)
    def write(file_id, *_args):
        seen.append(file_id)
        if fail_once[0]: fail_once[0] = False; raise OSError('unknown transport outcome')
    verifier.write_immutable_json = write
    verifier.write_descriptor = lambda file_id, *_args: seen.append(file_id)
    with pytest.raises(OSError): publish_retained_create(owner, verifier, common['requestId'])
    assert query_prepared(owner, common['requestId'])['status'] == 'pending'
    assert publish_retained_create(owner, verifier, common['requestId'])['descriptorId'] == ids['descriptorFileId']
    assert seen == ['drive-folder', 'drive-checkpoint', 'drive-folder', 'drive-checkpoint', 'drive-manifest', 'drive-descriptor']


def test_host_create_service_retains_then_publishes_then_activates(context, monkeypatch):
    registry, auth, lease, _owner, verifier, join = context
    principal = {'digest': join['principalDigest'], 'generation': 1}
    verifier.current = lambda: principal
    verifier.allocate_file_ids = lambda _count: ['drive-folder', 'drive-checkpoint', 'drive-manifest', 'drive-descriptor']
    verifier.create_folder = lambda *_args: None
    uploaded = []; interrupted = [True]
    def upload(*args):
        uploaded.append(args[-1])
        if interrupted[0]: interrupted[0] = False; raise OSError('lost reply')
    verifier.write_immutable_json = upload
    body = {}
    def write_descriptor(file_id, _logical, folder, title, raw, _namespace):
        import hashlib
        body['raw'] = raw
        verifier.summary = {'id': file_id, 'version': '7', 'sha256': hashlib.sha256(raw).hexdigest(),
                            'scope': json.loads(raw)['scope'], 'owner': True, 'writable': True, 'folderId': folder, 'title': title}
    verifier.write_descriptor = write_descriptor
    verifier.descriptor_bytes = lambda _principal, _id: body['raw']
    operations = ProviderOperations(registry, verifier)
    token = operations.capture_owner(auth, lease)
    service = ProviderCreateService(operations, verifier)
    request = '00000000-0000-0000-0000-000000001113'
    assert service.prepare(token, auth, lease, 'title', request)['status'] == 'pending'
    assert 'raw' not in body
    assert service.execute(token, auth, lease, request)['status'] == 'unknown'
    assert service.query(token, auth, lease, request)['status'] == 'pending'
    assert service.execute(token, auth, lease, request)['status'] == 'accepted'
    assert service.prepare(token, auth, lease, 'title', request)['status'] == 'accepted'
    assert [value['kind'] for value in uploaded] == ['repository-checkpoint', 'repository-checkpoint', 'dataset-manifest']
    assert 'checkpoint' in uploaded[0] and 'manifest' in uploaded[2]
    assert service.execute(token, auth, lease, request)['status'] == 'accepted'
    assert registry.discover(auth, lease)['libraries'] == []
    assert service.query(token, auth, lease, request)['status'] == 'accepted'
    opened = service.open_installed(token, auth, lease, request)
    inspected = registry.inspect_handle(auth, lease, opened['handleId'])
    assert inspected['scope']['libraryId'] != '' and inspected['admissionId']
    selected_open = service.open_selected(token, auth, lease, 'drive-descriptor')
    assert selected_open['requestId'] == request
    from types import SimpleNamespace
    verifier.edit_storage = lambda _owner: SimpleNamespace(pull=lambda: {'edits': [], 'imports': [], 'resources': []},
        acknowledge_pull=lambda *_args: None, cancel=lambda: None, renew=lambda: None, finish=lambda: None, pass_scope=lambda: _null_scope())
    hub = NativeProviderHub(registry, verifier); hub_token = hub._operations.capture_owner(auth, lease)
    sync_id = hub.open_replication(auth, lease, hub_token, inspected['admissionId'])['replicationId']
    hub.replication(auth, lease, hub_token, sync_id).flush()
    with pytest.raises(AuthorityError): hub.replication(auth, lease, hub_token, 'forged')
    hub.close()
    service.close()
    with pytest.raises(AuthorityError): registry.revalidate(auth, lease, inspected['admissionId'])
    assert service.recoveries(token, auth, lease)[0]['requestId'] == request
    service.acknowledge(token, auth, lease, request)
    assert service.recoveries(token, auth, lease) == []
    assert service.query(token, auth, lease, request)['status'] == 'accepted'

    # Resume uses the existing accepted plan and a fresh lease/operation, never OAuth.
    resume_lease = registry.issue(auth)
    resume_hub = NativeProviderHub(registry, verifier)
    original_token = resume_hub._operations.capture_owner(auth, resume_lease)
    verifier.connect = lambda: pytest.fail('resume must not start OAuth')
    initial = resume_hub._create.open_installed(original_token, auth, resume_lease, request)
    original_scope = registry.inspect_handle(auth, resume_lease, initial['handleId'])['scope']
    attempt = '00000000-0000-4000-8000-000000001500'
    resumed = resume_hub.resume_retained(auth, resume_lease, original_token, request, attempt)
    assert resumed['leaseId'] != resume_lease and resumed['operationId'] != original_token
    assert resumed['installed']['requestId'] == request
    assert registry.inspect_handle(auth, resumed['leaseId'], resumed['installed']['handleId'])['scope'] == original_scope
    with pytest.raises(AuthorityError): resume_hub.resume_retained(auth, resume_lease, original_token, request, attempt)
    with pytest.raises(AuthorityError): registry.inspect_handle(auth, resume_lease, initial['handleId'])
    timer = resume_hub._resume_attempts[(auth, resume_lease, original_token, attempt)]['timer']
    assert timer is not None and timer.is_alive()
    assert resume_hub.acknowledge_resume(auth, resume_lease, original_token, attempt)['acknowledged']
    timer.join(2); assert not timer.is_alive()
    # Repeated successful adoptions reclaim only the prior consumed lease.
    last = resumed
    for index in range(65):
        old_lease, old_token = last['leaseId'], last['operationId']
        next_attempt = f'00000000-0000-4000-8000-{2000 + index:012d}'
        last = resume_hub.resume_retained(auth, old_lease, old_token, request, next_attempt)
        resume_hub.acknowledge_resume(auth, old_lease, old_token, next_attempt)
        assert old_lease not in registry._leases
        assert len(resume_hub._resume_attempts) == 1
    resume_hub.close()
    assert last['leaseId'] not in registry._leases

    # Cancel before the request arrives terminally consumes the old capability.
    pre_lease = registry.issue(auth); pre_hub = NativeProviderHub(registry, verifier)
    pre_token = pre_hub._operations.capture_owner(auth, pre_lease)
    pre_attempt = '00000000-0000-4000-8000-000000001502'
    assert pre_hub.cancel_resume(auth, pre_lease, pre_token, pre_attempt)['cancelled']
    with pytest.raises(AuthorityError): pre_hub.resume_retained(auth, pre_lease, pre_token, request, pre_attempt)
    with pytest.raises(AuthorityError): pre_hub._operations.resolve(pre_token, auth, pre_lease)
    pre_hub.close()

    # A server-completed response lost to the caller is cancelled by that exact attempt.
    lost_lease = registry.issue(auth); lost_hub = NativeProviderHub(registry, verifier)
    lost_token = lost_hub._operations.capture_owner(auth, lost_lease)
    lost_attempt = '00000000-0000-4000-8000-000000001503'
    lost = lost_hub.resume_retained(auth, lost_lease, lost_token, request, lost_attempt)
    assert lost_hub.cancel_resume(auth, lost_lease, lost_token, lost_attempt)['cancelled']
    with pytest.raises(AuthorityError): registry.inspect_handle(auth, lost['leaseId'], lost['installed']['handleId'])
    with pytest.raises(AuthorityError): lost_hub._operations.resolve(lost['operationId'], auth, lost['leaseId'])
    lost_hub.close()

    # Server-owned retirement survives bearer rotation; failed cleanup must
    # retain its bounded row for a later retry rather than forgetting a lease.
    rotated_lease = registry.issue(auth); rotated_hub = NativeProviderHub(registry, verifier)
    rotated_token = rotated_hub._operations.capture_owner(auth, rotated_lease)
    rotated_attempt = '00000000-0000-4000-8000-000000001506'
    rotated = rotated_hub.resume_retained(auth, rotated_lease, rotated_token, request, rotated_attempt)
    key = (auth, rotated_lease, rotated_token, rotated_attempt)
    row = rotated_hub._resume_attempts[key]
    retire = row['new_retire']
    def fail_retirement(): raise RuntimeError('temporary cleanup failure')
    row['new_retire'] = fail_retirement
    rotated_hub._expire_resume(key, row)
    assert key in rotated_hub._resume_attempts and not row['cleaned']
    row['deadline'] = 0
    rotated_hub._purge_resume()
    assert key in rotated_hub._resume_attempts and rotated['leaseId'] in registry._leases
    with pytest.raises(AuthorityError, match='provider-resume-cleanup-incomplete'):
        rotated_hub.connect(auth, '00000000-0000-4000-8000-000000001507')
    assert rotated_hub._auth_attempt is None
    rotated_hub.begin_shutdown()
    assert not rotated_hub.finish_shutdown(0, close_host=False)
    assert key in rotated_hub._resume_attempts and not row['cleaned']
    row['new_retire'] = retire
    from sidecar import deps
    with monkeypatch.context() as changed:
        changed.setattr(deps, 'get_auth_token', lambda: 'rotated-app-bearer')
        rotated_hub._expire_resume(key, row)
    assert row['cleaned'] and rotated['leaseId'] not in registry._leases
    # Shutdown remains honestly failed even after a later cleanup retry.
    assert not rotated_hub.finish_shutdown(0, close_host=False)

    # Cancel while the real authority is waiting on a descriptor read.  The
    # losing resume may neither publish a fresh handle nor retain a new lease.
    import threading
    entered, release = threading.Event(), threading.Event()
    concurrent_lease = registry.issue(auth); concurrent_hub = NativeProviderHub(registry, verifier)
    concurrent_token = concurrent_hub._operations.capture_owner(auth, concurrent_lease)
    attempt = '00000000-0000-4000-8000-000000001504'
    with registry._lock: expected_leases = set(registry._leases) - {concurrent_lease}
    original_descriptor = verifier.descriptor
    def held_descriptor(*args):
        entered.set()
        if not release.wait(5): raise RuntimeError('descriptor fixture timeout')
        return original_descriptor(*args)
    verifier.descriptor = held_descriptor
    failures, results = [], []
    def run_resume():
        try: results.append(concurrent_hub.resume_retained(auth, concurrent_lease, concurrent_token, request, attempt))
        except Exception as error: failures.append(error)  # noqa: BLE001 - preserve worker exception for the parent assertion
    worker = threading.Thread(target=run_resume); worker.start()
    try:
        assert entered.wait(5)
        with pytest.raises(AuthorityError): concurrent_hub.resume_retained(auth, concurrent_lease, concurrent_token, request, '00000000-0000-4000-8000-000000001505')
        assert concurrent_hub.cancel_resume(auth, concurrent_lease, concurrent_token, attempt)['cancelled']
    finally:
        release.set(); worker.join(5); verifier.descriptor = original_descriptor
    assert not worker.is_alive() and not results and failures
    with registry._lock: assert set(registry._leases) == expected_leases
    concurrent_hub.close()

    # Credential generation and lease revocation never silently reacquire OAuth.
    for revoke in ('generation', 'lease'):
        current_lease = registry.issue(auth)
        stale_hub = NativeProviderHub(registry, verifier)
        stale_token = stale_hub._operations.capture_owner(auth, current_lease)
        if revoke == 'generation': verifier.generation += 1
        else: registry.release(auth, current_lease)
        with pytest.raises(AuthorityError): stale_hub.resume_retained(auth, current_lease, stale_token, request, '00000000-0000-4000-8000-000000001501')
        if revoke == 'generation': verifier.generation -= 1
        stale_hub.close()


def test_hub_construction_and_connect_do_not_provision_before_auth(tmp_path, monkeypatch):
    data = tmp_path / 'hub-isolated'
    monkeypatch.setenv('PAPEER_DATA_DIR', str(data))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    registry = NativeAuthority(); verifier = SyntheticVerifier()
    verifier.connect = lambda: {'connecting': True}
    principal = {'digest': 'a' * 64, 'generation': 1}
    verifier.finish_connect = lambda: principal
    verifier.current = lambda: principal
    hub = NativeProviderHub(registry, verifier)
    assert not data.exists()
    attempt = '00000000-0000-0000-0000-000000001116'
    assert hub.connect('Bearer synthetic-token', attempt) == {'connecting': True}
    assert not data.exists()
    issued = hub.finish_connect('Bearer synthetic-token', attempt)
    assert issued['leaseId'] and issued['operationId']
    assert registry.discover('Bearer synthetic-token', issued['leaseId'])['libraries'] == []
    hub.close()
    with pytest.raises(AuthorityError, match='provider-unavailable'): hub.connect('Bearer synthetic-token', attempt)


def test_hub_does_not_bypass_legacy_hold_on_connect(tmp_path, monkeypatch):
    data = tmp_path / 'held-isolated'; monkeypatch.setenv('PAPEER_DATA_DIR', str(data))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    def held(): raise AuthorityError('legacy-held')
    monkeypatch.setattr('sidecar.provider.hub._require_clear', held)
    verifier = SyntheticVerifier(); verifier.connect = lambda: pytest.fail('connect bypassed legacy hold')
    with pytest.raises(AuthorityError, match='legacy-held'):
        NativeProviderHub(NativeAuthority(), verifier).connect('Bearer synthetic-token', '00000000-0000-0000-0000-000000001117')
    assert not data.exists()


def test_cancel_is_bound_to_exact_attempt_and_cannot_cancel_new_login(tmp_path, monkeypatch):
    monkeypatch.setenv('PAPEER_DATA_DIR', str(tmp_path / 'attempts'))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    cancelled = []
    verifier = SyntheticVerifier(); verifier.connect = lambda: {'connecting': True}
    verifier.cancel_connect = lambda: (cancelled.append(True) or True)
    hub = NativeProviderHub(NativeAuthority(), verifier); auth = 'Bearer synthetic-token'
    first = '00000000-0000-0000-0000-000000001118'; second = '00000000-0000-0000-0000-000000001119'
    hub.connect(auth, first); hub.cancel_connect(auth, first); hub.connect(auth, second)
    with pytest.raises(AuthorityError, match='provider-attempt-invalid'): hub.cancel_connect(auth, first)
    assert cancelled == [True]
    hub.cancel_connect(auth, second); assert cancelled == [True, True]


def test_hub_cancel_does_not_wait_for_browser_launch_or_clear_new_attempt(tmp_path, monkeypatch):
    import threading
    monkeypatch.setenv('PAPEER_DATA_DIR', str(tmp_path / 'launch-race'))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    started, release = threading.Event(), threading.Event(); calls = []
    verifier = SyntheticVerifier()
    def connect():
        calls.append('connect')
        if len(calls) == 1:
            started.set(); assert release.wait(5)
        return {'connecting': True}
    verifier.connect = connect; verifier.cancel_connect = lambda: True
    hub = NativeProviderHub(NativeAuthority(), verifier); auth = 'Bearer synthetic-token'
    first = '00000000-0000-0000-0000-000000001122'; second = '00000000-0000-0000-0000-000000001123'
    errors = []
    def launch():
        try: hub.connect(auth, first)
        except Exception as error: errors.append(str(error))  # noqa: BLE001 - capture worker failure for assertion
    thread = threading.Thread(target=launch); thread.start(); assert started.wait(5)
    assert hub.cancel_connect(auth, first) == {'cancelled': True}
    assert hub.connect(auth, second) == {'connecting': True}
    release.set(); thread.join(5); assert not thread.is_alive()
    assert errors == ['provider-attempt-invalid']
    assert hub.cancel_connect(auth, second) == {'cancelled': True}


def test_hub_close_retires_operations_and_attempt_before_drain(context):
    import threading
    from types import SimpleNamespace
    registry, auth, lease, _owner, verifier, _plan = context
    verifier.current = lambda: {'digest': 'a' * 64, 'generation': 1}
    verifier.connect = lambda: {'connecting': True}; cancelled = []
    verifier.cancel_connect = lambda: (cancelled.append(True) or True)
    hub = NativeProviderHub(registry, verifier); operation = hub._operations.capture_owner(auth, lease)
    attempt = '00000000-0000-0000-0000-000000001128'; hub.connect(auth, attempt)
    entered, release = threading.Event(), threading.Event()
    def drain(timeout): entered.set(); return release.wait(timeout)
    hub._replications['test'] = (lease, operation, SimpleNamespace(suspend=lambda: None, wait_drained=drain))
    thread = threading.Thread(target=hub.close); thread.start(); assert entered.wait(5)
    assert cancelled == [True]
    with pytest.raises(AuthorityError, match='provider-unavailable'): hub._operations.resolve(operation, auth, lease)
    with pytest.raises(AuthorityError, match='provider-unavailable'): hub.connect(auth, attempt)
    release.set(); thread.join(5); assert not thread.is_alive()


def test_hub_disconnect_retires_old_operations_before_drain(context):
    import threading
    from types import SimpleNamespace
    registry, auth, lease, _owner, verifier, _plan = context
    verifier.current = lambda: {'digest': 'a' * 64, 'generation': 1}
    verifier.disconnect_and_wait = lambda: None
    hub = NativeProviderHub(registry, verifier); operation = hub._operations.capture_owner(auth, lease)
    entered, release = threading.Event(), threading.Event()
    def drain(): entered.set(); assert release.wait(5)
    hub._replications['test'] = (lease, operation, SimpleNamespace(suspend=lambda: None, suspend_and_wait=drain))
    errors = []
    def disconnect():
        try: hub.disconnect(auth, lease, operation)
        except Exception as error: errors.append(error)  # noqa: BLE001 - capture worker failure for assertion
    thread = threading.Thread(target=disconnect); thread.start(); assert entered.wait(5)
    with pytest.raises(AuthorityError, match='provider-unavailable'): hub._operations.resolve(operation, auth, lease)
    with pytest.raises(AuthorityError, match='provider-unavailable'): hub.connect(auth, '00000000-0000-0000-0000-000000001129')
    release.set(); thread.join(5); assert not thread.is_alive() and not errors
    with pytest.raises(AuthorityError): hub._operations.resolve(operation, auth, lease)


def test_cancel_lookup_does_not_wait_for_held_provider_lock(context):
    import threading
    from types import SimpleNamespace
    registry, auth, lease, _owner, verifier, _plan = context
    verifier.current = lambda: {'digest': 'a' * 64, 'generation': 1}
    lock = threading.RLock(); entered, release = threading.Event(), threading.Event()
    @contextmanager
    def guard(principal):
        with lock:
            verifier.assert_current(principal); yield; verifier.assert_current(principal)
    verifier.guard = guard
    verifier.health_current = lambda _principal: True
    hub = NativeProviderHub(registry, verifier); operation = hub._operations.capture_owner(auth, lease)
    replication = SimpleNamespace(); hub._replications['test'] = (lease, operation, replication)
    def held():
        with lock: entered.set(); assert release.wait(5)
    thread = threading.Thread(target=held); thread.start(); assert entered.wait(5)
    lookup_done = threading.Event(); found = []
    def lookup():
        found.append(hub.replication_for_cancel(auth, lease, operation, 'test'))
        found.append(hub.health(auth, lease, operation)); lookup_done.set()
    lookup_thread = threading.Thread(target=lookup); lookup_thread.start()
    try:
        assert lookup_done.wait(1) and found == [replication, {'active': True}]
        with pytest.raises(AuthorityError): hub.replication_for_cancel(auth, 'forged-lease', operation, 'test')
    finally:
        release.set(); thread.join(5); lookup_thread.join(5)
        assert not thread.is_alive() and not lookup_thread.is_alive()


def test_hub_lists_valid_selection_without_leaking_denied_id(context):
    registry, auth, lease, _owner, verifier, plan = context
    verifier.current = lambda: {'digest': plan['principalDigest'], 'generation': verifier.generation}
    verifier.list = lambda: [{'id': 'denied', 'title': 'Denied'}, {'id': plan['descriptor']['id'], 'title': plan['title']}]
    def descriptor(principal, selection):
        verifier.assert_current(principal)
        if selection == 'denied': raise ValueError('drive-owner-write-required')
        return deepcopy(verifier.summary)
    verifier.descriptor = descriptor
    verifier.descriptor_bytes = lambda _principal, _id: bytes.fromhex(plan['descriptorBytesHex'])
    hub = NativeProviderHub(registry, verifier)
    operation = hub._operations.capture_owner(auth, lease)
    rows = hub.list(auth, lease, operation)
    assert [row['status'] for row in rows] == ['unavailable', 'available']
    assert all(row['handleId'] not in {'denied', plan['descriptor']['id']} for row in rows)
    assert hub.resolve_selection(auth, lease, operation, rows[1]['handleId']) == plan['descriptor']['id']
    with pytest.raises(AuthorityError): hub.resolve_selection(auth, lease, operation, rows[0]['handleId'])
    renewed_lease = registry.issue(auth); renewed = hub._operations.capture_owner(auth, renewed_lease)
    assert hub.resolve_selection(auth, renewed_lease, renewed, rows[1]['handleId']) == plan['descriptor']['id']
    verifier.summary['version'] = '8'; newer_lease = registry.issue(auth); newer = hub._operations.capture_owner(auth, newer_lease)
    with pytest.raises(AuthorityError, match='provider-selection-changed'):
        hub.resolve_selection(auth, newer_lease, newer, rows[1]['handleId'])
    verifier.current = lambda: {'digest': 'b' * 64, 'generation': verifier.generation}
    other_lease = registry.issue(auth); other = hub._operations.capture_owner(auth, other_lease)
    with pytest.raises(AuthorityError, match='provider-selection-invalid'):
        hub.resolve_selection(auth, other_lease, other, rows[1]['handleId'])


def test_route_contract_rejects_extra_scope_and_unauthenticated_calls(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    app = FastAPI(); app.include_router(provider_owner.router)
    with TestClient(app) as client:
        missing = client.post('/api/edits/provider-owner/create/prepare', json={'title': 'x', 'requestId': 'id'})
        assert missing.status_code == 401
        forged = client.post('/api/edits/provider-owner/create/prepare', headers={'Authorization': 'Bearer synthetic-token'},
                             json={'title': 'x', 'requestId': 'id', 'scope': {'accountId': 'forged'}})
        assert forged.status_code == 422


def test_provider_router_is_registered_in_candidate_app(monkeypatch):
    from fastapi.testclient import TestClient
    from sidecar.app import app
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    with TestClient(app) as client:
        for path in ('connect', 'join/prepare', 'replication/flush'):
            assert client.post('/api/edits/provider-owner/' + path, json={}).status_code == 401


def test_actual_shutdown_route_signals_provider_before_bounded_request_drain(monkeypatch):
    from fastapi.testclient import TestClient
    from types import SimpleNamespace
    from sidecar.app import app
    from sidecar.routes import system
    events = []
    provider_drained = False
    def finish_provider_shutdown(timeout, close_host=True):
        events.append(('provider-drain', timeout, close_host))
        return provider_drained
    fake_hub = SimpleNamespace(begin_shutdown=lambda: events.append('provider-signal'),
                               finish_shutdown=finish_provider_shutdown)
    fake_manager = SimpleNamespace(close=lambda: 0, wait_idle=lambda _timeout: True, set_loop=lambda _loop: None, get_jobs=lambda: [])
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    monkeypatch.setattr(deps, 'job_manager', fake_manager)
    monkeypatch.setattr(deps, 'wait_for_library_requests', lambda timeout: (events.append(('request-drain', timeout)) or True))
    monkeypatch.setattr(system, 'exit_process', lambda: None)
    with TestClient(app) as client:
        monkeypatch.setattr(provider_owner, '_hub', fake_hub)
        try:
            result = client.post('/shutdown', headers={'Authorization': 'Bearer synthetic-token'})
            assert result.status_code == 200 and result.json()['stopped'] is False
            assert events[0] == 'provider-signal' and events[1][0] == 'request-drain' and events[2] == ('provider-drain', 0, False)
        finally:
            # Complete the synthetic work before leaving its app lifetime, even
            # when an assertion fails. The real failed-shutdown guard stays on.
            provider_drained = True
    closes = [event for event in events if isinstance(event, tuple) and event[0] == 'provider-drain' and event[2] is True]
    assert len(closes) == 1 and 0 <= closes[0][1] <= 5


def test_native_owner_routes_create_and_open_with_opaque_handles(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import hashlib
    monkeypatch.setenv('PAPEER_DATA_DIR', str(tmp_path / 'route-isolated'))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    registry = NativeAuthority(); verifier = SyntheticVerifier(); principal = {'digest': 'a' * 64, 'generation': 1}
    verifier.connect = lambda: {'connecting': True}; verifier.finish_connect = lambda: principal; verifier.current = lambda: principal
    verifier.allocate_file_ids = lambda _count: ['route-folder', 'route-checkpoint', 'route-manifest', 'route-descriptor']
    verifier.create_folder = lambda *_args: None; verifier.write_immutable_json = lambda *_args: None
    body = {}
    def write_descriptor(file_id, _logical, folder, title, raw, _namespace):
        body['raw'] = raw
        verifier.summary = {'id': file_id, 'version': '7', 'sha256': hashlib.sha256(raw).hexdigest(),
                            'scope': json.loads(raw)['scope'], 'owner': True, 'writable': True, 'folderId': folder, 'title': title}
    verifier.write_descriptor = write_descriptor; verifier.descriptor_bytes = lambda _principal, _id: body['raw']
    monkeypatch.setattr(provider_owner, '_hub', NativeProviderHub(registry, verifier))
    monkeypatch.setattr(provider_owner, '_shutdown', False)
    app = FastAPI(); app.include_router(provider_owner.router)
    headers = {'Authorization': 'Bearer synthetic-token'}
    attempt = '00000000-0000-0000-0000-000000001120'; request = '00000000-0000-0000-0000-000000001121'
    with TestClient(app) as client:
        assert client.post('/api/edits/provider-owner/connect', headers=headers, json={'attemptId': attempt}).status_code == 200
        issued = client.post('/api/edits/provider-owner/finish-connect', headers=headers, json={'attemptId': attempt}).json()
        headers |= {'X-Papeer-Host-Lease': issued['leaseId'], 'X-Papeer-Provider-Operation': issued['operationId']}
        assert client.post('/api/edits/provider-owner/create/prepare', headers=headers, json={'requestId': request, 'title': 'Private'}).json()['status'] == 'pending'
        assert client.post('/api/edits/provider-owner/execute', headers=headers, json={'requestId': request}).json()['status'] == 'accepted'
        opened = client.post('/api/edits/provider-owner/open-installed', headers=headers, json={'requestId': request}).json()
        assert set(opened) == {'leaseId', 'handleId', 'requestId'} and opened['handleId'] != 'route-descriptor'
        assert registry.inspect_handle(headers['Authorization'], issued['leaseId'], opened['handleId'])['scope']['libraryId']


def test_host_join_reads_selected_dataset_then_activates_same_request(context):
    from types import SimpleNamespace
    registry, auth, lease, _owner, verifier, plan = context
    principal = {'digest': plan['principalDigest'], 'generation': 1}
    verifier.current = lambda: principal
    verifier.descriptor_bytes = lambda _principal, _id: bytes.fromhex(plan['descriptorBytesHex'])
    verifier.dataset_storage = lambda _owner: SimpleNamespace(read_published_dataset=lambda: {
        'manifest': deepcopy(plan['publication']['manifest']), 'checkpoint': deepcopy(plan['publication']['checkpoint']), 'resources': []})
    operations = ProviderOperations(registry, verifier)
    token = operations.capture_owner(auth, lease)
    create = ProviderCreateService(operations, verifier)
    join = ProviderJoinService(operations, verifier, create)
    request = '00000000-0000-0000-0000-000000001114'
    assert join.prepare(token, auth, lease, plan['descriptor']['id'], request)['status'] == 'pending'
    assert join.prepare(token, auth, lease, plan['descriptor']['id'], request)['status'] == 'pending'
    assert join.execute(token, auth, lease, request)['status'] == 'accepted'
    assert create.query(token, auth, lease, request)['status'] == 'accepted'
    assert join.execute(token, auth, lease, request)['status'] == 'accepted'


def test_private_sync_rejects_cross_library_records_without_acknowledgement(context):
    from types import SimpleNamespace
    registry, auth, lease, owner, _verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    fixture = json.loads((Path.cwd() / 'tests/fixtures/shared-edits.json').read_text(encoding='utf8'))
    record = {'batch': fixture['batches'][0]}
    assert record['batch']['libraryId'] != scope['libraryId']
    storage = SimpleNamespace(pull=lambda: {'edits': [record], 'imports': [], 'resources': []},
                              imported=lambda *_args: pytest.fail('unexpected acknowledgement'))
    before = repository.pending_records()
    with pytest.raises(ValueError, match='batch-scope'):
        sync_once(owner, repository, storage, plan['intent']['peerId'], lambda: False, None)
    assert repository.pending_records() == before


def test_sync_descriptor_change_during_pull_prevents_import_and_stays_revoked(context):
    from types import SimpleNamespace
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    with sqlite3.connect(owner._path) as db: before = db.execute('SELECT count(*) FROM edit_batches').fetchone()[0]
    def pull():
        verifier.summary['version'] = '8'
        return {'edits': [], 'imports': [], 'resources': []}
    with pytest.raises(AuthorityError, match='provider-descriptor-changed'):
        sync_once(owner, repository, SimpleNamespace(pull=pull), plan['intent']['peerId'], lambda: False, None)
    verifier.summary['version'] = '7'
    with pytest.raises(AuthorityError, match='provider-operation-invalid'): owner.assert_current()
    with sqlite3.connect(owner._path) as db: assert db.execute('SELECT count(*) FROM edit_batches').fetchone()[0] == before


def test_private_sync_retries_unknown_upload_before_acknowledgement(context):
    from types import SimpleNamespace
    from uuid import uuid4
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(registry.bind_repository(auth, lease, admission), scope)
    before = repository.read(scope['libraryId']); parent = before['heads'][0]
    batch = {'kind': 'library', 'id': str(uuid4()), 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'], 'parents': [parent],
             'changes': [{'type': 'put-folder', 'folder': {'id': str(uuid4()), 'title': 'Folder', 'parentId': None, 'position': 0}}]}
    assert repository.commit(batch)['status'] == 'durable'
    sync_repository = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    calls = []; fail = [True]
    allocations = []
    verifier.allocate_file_ids = lambda count: (allocations.append(count) or ['retained-drive-id'])
    def upload(key, envelope, provider_file_id=None):
        calls.append((key, envelope, provider_file_id))
        if fail[0]: fail[0] = False; raise OSError('lost reply')
    storage = SimpleNamespace(pull=lambda: {'edits': [], 'imports': [], 'resources': []}, upload_json=upload, acknowledge_pull=lambda *_args: None)
    with pytest.raises(OSError): sync_once(owner, sync_repository, storage, plan['intent']['peerId'], lambda: False, TransferIds(owner, verifier))
    assert repository.receipt(batch['id'])['upload'] == 'pending'
    restarted = NativeAuthority(); fresh_lease = restarted.issue(auth)
    fresh_owner = ProviderOperationOwner(restarted, auth, fresh_lease, verifier, {'digest': plan['principalDigest'], 'generation': 1}, owner._evidence, owner._descriptor)
    fresh_admission, _ = restarted.admit_provider(auth, fresh_lease, fresh_owner, scope)
    restarted_repository = SqliteEditRepository(SyncAuthority(restarted, auth, fresh_lease, fresh_admission, fresh_owner, scope), scope)
    sync_once(fresh_owner, restarted_repository, storage, plan['intent']['peerId'], lambda: False, TransferIds(fresh_owner, verifier))
    assert calls[0] == calls[1] and calls[0][0] == batch['id'] and calls[0][2] == 'retained-drive-id'
    assert allocations == [1]
    assert repository.receipt(batch['id'])['upload'] == 'accepted'


def test_private_replication_suspends_and_rechecks_admission(context):
    from types import SimpleNamespace
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    calls = []
    storage = SimpleNamespace(pull=lambda: (calls.append('pull') or {'edits': [], 'imports': [], 'resources': []}),
                              acknowledge_pull=lambda *_args: None, cancel=lambda: None, renew=lambda: None, finish=lambda: None, pass_scope=lambda: _null_scope())
    verifier.edit_storage = lambda selected: storage if selected is owner else pytest.fail('wrong owner')
    replication = ProviderReplicationOwner(registry, auth, lease, admission, verifier)
    replication.suspend_and_wait(); replication.flush(); assert calls == []
    replication.resume(); assert calls == ['pull'] and replication.scope == scope
    registry.release(auth, lease, admission)
    with pytest.raises(AuthorityError): replication.flush()
    assert replication.snapshot()['error'] == 'provider-sync-failed'


@contextmanager
def _null_scope():
    yield


def test_replication_suspend_cancels_held_pass_without_sticky_revocation(context):
    import threading
    from types import SimpleNamespace
    from papeer.core.providers.drive.request_group import ProviderRequestCancelled
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'; assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    entered, release = threading.Event(), threading.Event()
    def pull():
        entered.set(); assert release.wait(5); raise ProviderRequestCancelled('cancelled')
    storage = SimpleNamespace(pull=pull, cancel=release.set, renew=lambda: None, finish=lambda: None, pass_scope=lambda: _null_scope())
    verifier.edit_storage = lambda _selected: storage
    replication = ProviderReplicationOwner(registry, auth, lease, admission, verifier)
    errors = []
    def flush():
        try: replication.flush()
        except Exception as error: errors.append(error)  # noqa: BLE001 - capture worker failure for assertion
    thread = threading.Thread(target=flush); thread.start(); assert entered.wait(5)
    replication.suspend_and_wait(); thread.join(5)
    assert not thread.is_alive() and not errors and replication.snapshot()['suspended']
    owner.assert_current()


def test_queued_old_flush_cannot_restart_after_suspend_and_resume(context):
    import threading
    from types import SimpleNamespace
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'; assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    calls = []; storage = SimpleNamespace(pull=lambda: (calls.append('pull') or {'edits': [], 'imports': [], 'resources': []}),
        acknowledge_pull=lambda *_args: None, cancel=lambda: None, renew=lambda: None, finish=lambda: None, pass_scope=lambda: _null_scope())
    verifier.edit_storage = lambda _selected: storage
    replication = ProviderReplicationOwner(registry, auth, lease, admission, verifier)
    lock, queued = threading.Lock(), threading.Event(); lock.acquire()
    class ObservedLock:
        def __enter__(self):
            if threading.current_thread().name == 'old-flush': queued.set()
            lock.acquire(); return self
        def __exit__(self, *_args): lock.release()
    replication._flight = ObservedLock(); errors = []
    def invoke(action):
        try: action()
        except Exception as error: errors.append(error)  # noqa: BLE001 - capture worker failure for assertion
    old = threading.Thread(target=lambda: invoke(replication.flush), name='old-flush'); old.start(); assert queued.wait(5)
    replication.suspend()
    resumed = threading.Thread(target=lambda: invoke(replication.resume)); resumed.start()
    lock.release(); old.join(5); resumed.join(5)
    assert not old.is_alive() and not resumed.is_alive() and not errors
    assert calls == ['pull']


def test_resource_transfer_ids_survive_new_authority_and_reject_hash_change(context):
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; registry.admit_provider(auth, lease, owner, scope)
    allocations = []; verifier.allocate_file_ids = lambda count: (allocations.append(count) or ['retained-blob', 'retained-descriptor'])
    resource = '00000000-0000-0000-0000-000000001115'
    assert TransferIds(owner, verifier).ensure('resource', resource, 'a' * 64, 2) == ['retained-blob', 'retained-descriptor']
    restarted = NativeAuthority(); fresh_lease = restarted.issue(auth)
    fresh = ProviderOperationOwner(restarted, auth, fresh_lease, verifier, {'digest': plan['principalDigest'], 'generation': 1}, owner._evidence, owner._descriptor)
    assert TransferIds(fresh, verifier).ensure('resource', resource, 'a' * 64, 2) == ['retained-blob', 'retained-descriptor']
    with pytest.raises(ValueError, match='provider-transfer-id-conflict'):
        TransferIds(fresh, verifier).ensure('resource', resource, 'b' * 64, 2)
    assert allocations == [2]


def test_cancel_held_finish_does_not_provision_or_retire_new_attempt(tmp_path, monkeypatch):
    import threading
    from sidecar import deps
    from sidecar.canonical_host import NativeAuthority, AuthorityError, _bearer
    from sidecar.provider.hub import NativeProviderHub
    monkeypatch.setenv('PAPEER_DATA_DIR', str(tmp_path / 'held-finish'))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-token')
    verifier = SyntheticVerifier(); verifier.connect = lambda: {'connecting': True}
    entered = threading.Event(); release = threading.Event(); errors = []
    def held():
        entered.set(); assert release.wait(5)
    verifier.finish_connect = held; verifier.cancel_connect = lambda: True
    hub = NativeProviderHub(NativeAuthority(), verifier); auth = 'Bearer synthetic-token'
    first = '00000000-0000-0000-0000-000000001118'; second = '00000000-0000-0000-0000-000000001119'
    hub.connect(auth, first)
    def finish():
        try: hub.finish_connect(auth, first)
        except Exception as error: errors.append(error)  # noqa: BLE001 - capture worker failure for assertion
    worker = threading.Thread(target=finish); worker.start()
    assert entered.wait(2)
    assert hub.cancel_connect(auth, first)['cancelled']
    hub.connect(auth, second)
    release.set(); worker.join(3)
    assert not worker.is_alive() and len(errors) == 1 and isinstance(errors[0], AuthorityError)
    assert hub._auth_attempt == (second, _bearer(auth))
    assert not (tmp_path / 'held-finish').exists()
    hub.cancel_connect(auth, second)


def test_private_sync_skips_durable_duplicate_peer_receipts_after_lost_reply(context, monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    public = SqliteEditRepository(registry.bind_repository(auth, lease, admission), scope)
    parent = public.read(scope['libraryId'])['heads'][0]
    batch_id = str(uuid4())
    batch = {'kind': 'library', 'id': batch_id, 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'], 'parents': [parent],
             'changes': [{'type': 'put-folder', 'folder': {'id': str(uuid4()), 'title': 'ACK regression', 'parentId': None, 'position': 0}}]}
    assert public.commit(batch)['status'] == 'durable'
    repository.acknowledge(batch_id)
    assert repository.pending_records() == []
    assert repository.receipt(batch_id) is not None
    peer = str(uuid4()); missing = str(uuid4())
    incoming = {'edits': [], 'resources': [], 'imports': [{'batchId': batch_id, 'peerId': peer}, {'batchId': missing, 'peerId': peer}]}
    storage = SimpleNamespace(pull=lambda: deepcopy(incoming), acknowledge_pull=lambda *_args: None)
    actual_ack = repository.acknowledge; calls = []
    def lost_reply(key, peer_id=None):
        calls.append((key, peer_id)); actual_ack(key, peer_id)
        raise OSError('ack reply lost after durable commit')
    monkeypatch.setattr(repository, 'acknowledge', lost_reply)
    with pytest.raises(OSError, match='ack reply lost'):
        sync_once(owner, repository, storage, plan['intent']['peerId'], lambda: False, None)
    assert calls == [(batch_id, peer)]
    assert peer in repository.receipt(batch_id)['importedBy']
    with sqlite3.connect(owner._path) as db: durable = list(db.iterdump())
    # A fresh repository reads the committed receipt; it must not repeat the write.
    restarted = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    monkeypatch.setattr(restarted, 'acknowledge', lambda *_args: pytest.fail('duplicate or unknown ACK written'))
    sync_once(owner, restarted, storage, plan['intent']['peerId'], lambda: False, None)
    with sqlite3.connect(owner._path) as db: assert list(db.iterdump()) == durable
    assert restarted.receipt(missing) is None
    owner.invalidate()
    with pytest.raises(AuthorityError):
        sync_once(owner, restarted, storage, plan['intent']['peerId'], lambda: False, None)
    with sqlite3.connect(owner._path) as db: assert list(db.iterdump()) == durable


# The real context fixture issues the lease/admission and activates actual SQLite
# rows. These tests never supply a successful fake authority or forged proof.
def _sync_snapshot_fixture(context):
    import hashlib
    from uuid import uuid4
    registry, auth, lease, owner, verifier, plan = context
    assert stage_join(owner, plan)['status'] == 'pending'
    assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    scope = plan['binding']['scope']
    admission, admitted = registry.admit_provider(auth, lease, owner, scope)
    assert admitted == scope
    public = SqliteEditRepository(registry.bind_repository(auth, lease, admission), scope)
    parent = public.read(scope['libraryId'])['heads'][0]
    batch = {'kind': 'library', 'id': str(uuid4()), 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'],
             'parents': [parent], 'changes': [{'type': 'put-folder', 'folder': {
                 'id': str(uuid4()), 'title': 'Readonly snapshot proof', 'parentId': None, 'position': 0}}]}
    assert public.commit(batch)['status'] == 'durable'
    resource_id, body = str(uuid4()), b'isolated sync resource'
    metadata = public.store_resource(resource_id, hashlib.sha256(body).hexdigest(), 'application/octet-stream', body)
    authority = SyncAuthority(registry, auth, lease, admission, owner, scope)
    return registry, auth, lease, owner, verifier, scope, admission, authority, batch, metadata, body


@pytest.mark.parametrize('operation', ['receipt', 'pending-records', 'dataset-control', 'read-resource', 'resource-metadata'])
def test_sync_readonly_validates_persisted_provider_proof_once_per_snapshot(context, monkeypatch, operation):
    import sidecar.provider.sync_authority as sync_module
    *_, scope, _admission, authority, batch, metadata, body = _sync_snapshot_fixture(context)
    repository = SqliteEditRepository(authority, scope)
    actual = sync_module._provider_proof
    calls = {}
    def checked(db, owner, selected):
        calls[db] = calls.get(db, 0) + 1
        return actual(db, owner, selected)
    monkeypatch.setattr(sync_module, '_provider_proof', checked)
    if operation == 'receipt':
        value = repository.receipt(batch['id']); assert value['id'] == batch['id'] and value['durable'] is True
    elif operation == 'pending-records':
        assert batch in [record['batch'] for record in repository.pending_records()]
    elif operation == 'dataset-control':
        assert repository.dataset_control()['active']['scope'] == scope
    elif operation == 'read-resource':
        assert repository.read_resource(metadata['id']) == {'metadata': metadata, 'bytes': body}
    else:
        assert repository.resource_metadata(metadata['id']) == metadata
    # Some public reads separately assert_current after their transaction. That
    # is a new snapshot and must retain a complete check, never a cached proof.
    assert calls and set(calls.values()) == {1}


@pytest.mark.parametrize('fault', ['lease', 'admission', 'owner', 'principal', 'descriptor', 'evidence', 'folder', 'admission-proof'])
def test_sync_readonly_rechecks_all_live_authority_after_yield(context, fault):
    registry, auth, lease, owner, verifier, scope, admission, authority, *_ = _sync_snapshot_fixture(context)
    with pytest.raises((AuthorityError, ValueError)):
        with authority.transaction('receipt', scope) as db:
            assert db.execute('SELECT 1').fetchone() == (1,)
            if fault == 'lease': registry.release(auth, lease)
            elif fault == 'admission': registry.release(auth, lease, admission)
            elif fault == 'owner': owner.invalidate()
            elif fault == 'principal': verifier.generation += 1
            elif fault == 'descriptor': owner._descriptor['scope']['epoch'] = 'changed-epoch'
            elif fault == 'evidence': owner._evidence['writable'] = False
            elif fault == 'folder': owner._evidence['folderId'] = 'changed-folder'
            else: registry._admissions[admission]['proof']['peer']['peerId'] = 'changed-peer'


_SYNC_PROTECTED_ROWS = (
    ('canonical_provider_bindings', 'owner=? AND identity=?'),
    ('canonical_profiles', 'identity=?'), ('canonical_peers', 'account=?'),
    ('edit_dataset_controls', 'identity=?'), ('edit_datasets', 'scope=? AND id=?'),
)


def _sync_snapshot_row_args(owner, scope, proof):
    from papeer.core.edit_model import canonical_json
    identity = canonical_json([scope['accountId'], scope['libraryId']])
    return ((owner.namespace, identity), (identity,), (scope['accountId'],), (identity,),
            (canonical_json([scope['accountId'], scope['libraryId'], scope['epoch']]), proof['manifest']['id']))


def test_sync_readonly_rejects_selected_malformed_persisted_rows_before_body(context):
    registry, _auth, _lease, owner, _verifier, scope, admission, authority, batch, *_ = _sync_snapshot_fixture(context)
    repository = SqliteEditRepository(authority, scope)
    args = _sync_snapshot_row_args(owner, scope, registry._admissions[admission]['proof'])
    for (table, where), keys in zip(_SYNC_PROTECTED_ROWS, args):
        with sqlite3.connect(owner._path) as db:
            original = db.execute('SELECT payload FROM ' + table + ' WHERE ' + where, keys).fetchone()[0]
            db.execute('UPDATE ' + table + ' SET payload=? WHERE ' + where, ('{}', *keys))
        entered = False
        try:
            with pytest.raises((AuthorityError, ValueError)):
                with authority.transaction('receipt', scope): entered = True
            assert not entered, table
        finally:
            with sqlite3.connect(owner._path) as db:
                db.execute('UPDATE ' + table + ' SET payload=? WHERE ' + where, (original, *keys))
        assert repository.receipt(batch['id'])['id'] == batch['id'], table


@pytest.mark.parametrize('operation', ['receive-records', 'acknowledge-upload', 'store-resource'])
def test_sync_write_keeps_full_postproof_and_rolls_back_every_protected_row(context, monkeypatch, operation):
    import sidecar.provider.sync_authority as sync_module
    registry, _auth, _lease, owner, _verifier, scope, admission, authority, batch, *_ = _sync_snapshot_fixture(context)
    args = _sync_snapshot_row_args(owner, scope, registry._admissions[admission]['proof'])
    with sqlite3.connect(owner._path) as db:
        db.execute('CREATE TABLE sync_write_rollback_marker (value TEXT)')
        before = list(db.iterdump())
    actual = sync_module._provider_proof; calls = []
    def checked(*args):
        calls.append(1); return actual(*args)
    monkeypatch.setattr(sync_module, '_provider_proof', checked)
    for (table, where), keys in zip(_SYNC_PROTECTED_ROWS, args):
        calls.clear()
        with pytest.raises((AuthorityError, ValueError)):
            with authority.transaction(operation, scope) as db:
                db.execute('INSERT INTO sync_write_rollback_marker VALUES(?)', (operation,))
                db.execute('UPDATE ' + table + ' SET payload=? WHERE ' + where, ('{}', *keys))
        assert calls == [1, 1], (operation, table)
        with sqlite3.connect(owner._path) as db:
            assert list(db.iterdump()) == before, (operation, table)
            assert db.execute('SELECT count(*) FROM sync_write_rollback_marker').fetchone() == (0,)
        assert SqliteEditRepository(authority, scope).receipt(batch['id'])['id'] == batch['id']


@pytest.mark.parametrize('journal', ['DELETE', 'WAL'])
def test_sync_readonly_snapshot_excludes_concurrent_write_and_next_transaction_rejects(context, journal):
    from threading import Event, Thread
    registry, _auth, _lease, owner, _verifier, scope, admission, authority, batch, *_ = _sync_snapshot_fixture(context)
    from papeer.core.edit_model import canonical_json
    identity = canonical_json([scope['accountId'], scope['libraryId']])
    with sqlite3.connect(owner._path) as db:
        assert db.execute('PRAGMA journal_mode=' + journal).fetchone()[0].upper() == journal
        original = db.execute('SELECT payload FROM canonical_profiles WHERE identity=?', (identity,)).fetchone()[0]
    attempted, committed = Event(), Event(); errors = []
    def writer():
        try:
            with sqlite3.connect(owner._path, timeout=5) as other:
                other.execute('UPDATE canonical_profiles SET payload=? WHERE identity=?', ('{}', identity))
                attempted.set(); other.commit(); committed.set()
        except sqlite3.Error as error:
            errors.append(error); attempted.set()
    worker = Thread(target=writer, daemon=True)
    try:
        with authority.transaction('receipt', scope) as db:
            assert db.in_transaction and db.execute('PRAGMA read_uncommitted').fetchone() == (0,)
            worker.start(); assert attempted.wait(2), 'writer did not reach its commit'
            if journal == 'WAL': assert committed.wait(2), 'WAL writer should commit while reader retains snapshot'
            else: assert not committed.is_set(), 'rollback-journal reader must still exclude writer commit'
            assert db.execute('SELECT payload FROM canonical_profiles WHERE identity=?', (identity,)).fetchone() == (original,)
        worker.join(6); assert not worker.is_alive() and not errors and committed.is_set()
        with pytest.raises((AuthorityError, ValueError)):
            SqliteEditRepository(authority, scope).receipt(batch['id'])
    finally:
        if worker.ident is not None: worker.join(6)
        assert not worker.is_alive()
        with sqlite3.connect(owner._path) as db:
            db.execute('UPDATE canonical_profiles SET payload=? WHERE identity=?', (original, identity))
    assert SqliteEditRepository(authority, scope).receipt(batch['id'])['id'] == batch['id']
