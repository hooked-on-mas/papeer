"""Real candidate owner/SQLite and fixed Google host with fake HTTP only."""
from test_provider_data_plane import context  # noqa: F401 - reuse real authority and fake HTTP fixtures
from test_provider_verifier import http as google_http  # noqa: F401 - transitive fixture for context
from sidecar.provider.create_service import ProviderCreateService
from sidecar.provider.join_service import ProviderJoinService
from sidecar.provider.operations import ProviderOperations
from sidecar.provider.replication import ProviderReplicationOwner
from sidecar.canonical_host import NativeAuthority
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edit_model import EditGraph
from papeer.core.edits.provider.activation import upgrade_provider_metadata
from uuid import uuid4
from papeer.core.providers.drive import transport


def test_join_fetches_verified_remote_dataset_and_opens_existing_scope(context):  # noqa: F811 - pytest fixture injection
    host, owner, plan, _admit, put, _http = context
    put('manifest', {'kind': 'dataset-manifest', 'manifest': plan['publication']['manifest']})
    put('checkpoint', {'kind': 'repository-checkpoint', 'checkpoint': plan['publication']['checkpoint']})
    registry, authorization, lease = owner._registry, owner._authorization, owner._lease_id
    operations = ProviderOperations(registry, host)
    token = operations.capture_owner(authorization, lease)
    create = ProviderCreateService(operations, host); join = ProviderJoinService(operations, host, create)
    request = '00000000-0000-0000-0000-000000001124'
    assert join.prepare(token, authorization, lease, plan['descriptor']['id'], request)['status'] == 'pending'
    assert join.execute(token, authorization, lease, request)['status'] == 'accepted'
    opened = create.open_installed(token, authorization, lease, request)
    proof = registry.inspect_handle(authorization, lease, opened['handleId'])
    assert proof['scope'] == plan['intent']['scope']
    create.close()


def test_two_isolated_native_owners_exchange_real_sqlite_edits_through_fake_google(context, tmp_path, monkeypatch):  # noqa: F811 - pytest fixture injection
    import os
    host, first_owner, plan, _admit, put, _http = context
    put('manifest', {'kind': 'dataset-manifest', 'manifest': plan['publication']['manifest']})
    put('checkpoint', {'kind': 'repository-checkpoint', 'checkpoint': plan['publication']['checkpoint']})
    auth, first_lease, first_registry = first_owner._authorization, first_owner._lease_id, first_owner._registry
    first_path = os.environ['PAPEER_DATA_DIR']

    def join(registry, lease, request):
        operations = ProviderOperations(registry, host); token = operations.capture_owner(auth, lease)
        with operations.resolve(token, auth, lease).transaction('provider-upgrade') as db: upgrade_provider_metadata(db)
        create = ProviderCreateService(operations, host); service = ProviderJoinService(operations, host, create)
        assert service.prepare(token, auth, lease, plan['descriptor']['id'], request)['status'] == 'pending'
        assert service.execute(token, auth, lease, request)['status'] == 'accepted'
        handle = create.open_installed(token, auth, lease, request)['handleId']
        proof = registry.inspect_handle(auth, lease, handle)
        repo = SqliteEditRepository(registry.bind_repository(auth, lease, proof['admissionId']), proof['scope'])
        sync = ProviderReplicationOwner(registry, auth, lease, proof['admissionId'], host)
        return create, repo, sync

    def add_folder(repo, name):
        root = repo.read(repo.scope['libraryId']); parent = root['heads'][0]
        batch = {'kind': 'library', 'id': str(uuid4()), 'libraryId': repo.scope['libraryId'], 'targetId': repo.scope['libraryId'],
                 'parents': [parent], 'changes': [{'type': 'put-folder', 'folder': {'id': str(uuid4()), 'title': name, 'parentId': None, 'position': 0}}]}
        assert repo.commit(batch)['status'] == 'durable'; return batch

    def names(repo):
        current = repo.read(repo.scope['libraryId']); state = EditGraph(current['checkpoint']).states[current['heads'][0]]
        return {folder['title'] for folder in state['folders']}

    first_create, first_repo, first_sync = join(first_registry, first_lease, '00000000-0000-0000-0000-000000001125')
    first_batch = add_folder(first_repo, 'first'); first_sync.flush()
    assert first_repo.receipt(first_batch['id'])['upload'] == 'accepted'
    second_path = tmp_path / 'second-owner'; monkeypatch.setenv('PAPEER_DATA_DIR', str(second_path))
    second_registry = NativeAuthority(); second_lease = second_registry.provision(auth)
    second_create, second_repo, second_sync = join(second_registry, second_lease, '00000000-0000-0000-0000-000000001126')
    second_sync.flush(); assert names(second_repo) == {'first'}
    second_batch = add_folder(second_repo, 'second'); second_sync.flush()
    assert second_repo.receipt(second_batch['id'])['upload'] == 'accepted'
    monkeypatch.setenv('PAPEER_DATA_DIR', str(first_path)); first_sync.flush()
    assert names(first_repo) == {'first', 'second'}
    first_create.close()
    restarted = NativeAuthority(); restarted_lease = restarted.issue(auth)
    restarted_operations = ProviderOperations(restarted, host); restarted_token = restarted_operations.capture_owner(auth, restarted_lease)
    restarted_create = ProviderCreateService(restarted_operations, host)
    reopened = restarted_create.open_installed(restarted_token, auth, restarted_lease, '00000000-0000-0000-0000-000000001125')
    reopened_proof = restarted.inspect_handle(auth, restarted_lease, reopened['handleId'])
    reopened_repo = SqliteEditRepository(restarted.bind_repository(auth, restarted_lease, reopened_proof['admissionId']), reopened_proof['scope'])
    assert names(reopened_repo) == {'first', 'second'} and reopened_repo.receipt(first_batch['id'])['upload'] == 'accepted'
    restarted_create.close(); monkeypatch.setenv('PAPEER_DATA_DIR', str(second_path)); second_create.close()


def test_local_sqlite_commit_does_not_wait_for_held_provider_http(context, monkeypatch):  # noqa: F811 - pytest fixture injection
    import threading
    host, owner, plan, admit, _put, _http = context; admit()
    registry, auth, lease = owner._registry, owner._authorization, owner._lease_id
    scope = plan['binding']['scope']; admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(registry.bind_repository(auth, lease, admission), scope)
    replication = ProviderReplicationOwner(registry, auth, lease, admission, host)
    root = repository.read(scope['libraryId']); parent = root['heads'][0]
    batch = {'kind': 'library', 'id': str(uuid4()), 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'], 'parents': [parent],
             'changes': [{'type': 'put-folder', 'folder': {'id': str(uuid4()), 'title': 'during pull', 'parentId': None, 'position': 0}}]}
    entered, release = threading.Event(), threading.Event(); original = transport._open; hold_once = [True]
    def held(request, timeout):
        if hold_once[0]:
            hold_once[0] = False; entered.set(); assert release.wait(5)
        return original(request, timeout)
    monkeypatch.setattr(transport, '_open', held)
    errors, committed = [], threading.Event()
    def flush():
        try: replication.flush()
        except Exception as error: errors.append(error)  # noqa: BLE001 - capture worker failure for assertion
    def commit():
        try:
            assert repository.commit(batch)['status'] == 'durable'; committed.set()
        except Exception as error: errors.append(error)  # noqa: BLE001 - capture worker failure for assertion
    pull_thread = threading.Thread(target=flush); pull_thread.start(); assert entered.wait(5)
    writer_thread = threading.Thread(target=commit); writer_thread.start()
    try: assert committed.wait(2), 'local SQLite commit waited for held provider HTTP'
    finally:
        release.set(); pull_thread.join(10); writer_thread.join(10)
    assert not pull_thread.is_alive() and not writer_thread.is_alive() and not errors
