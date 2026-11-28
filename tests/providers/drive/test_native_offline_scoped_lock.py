"""Lease-scoped cleanup with real NativeAuthority/SQLite and an actual sealed vault.

A/B below are leases across a durable local-grant revision, not different Google
principals. Google authentication/owner fixtures are the existing synthetic HTTP boundary.
"""
from copy import deepcopy
import json
import threading
import uuid

import pytest
from test_provider_verifier import http as google_http  # noqa: F401
from test_provider_data_plane import context as drive_context  # noqa: F401
from test_native_offline import SECRET, enrolled, folder_batch, offline_repository
from sidecar.canonical_host import AuthorityError, _existing
from sidecar.provider.offline import crypto
from sidecar.provider.offline.service import NativeOfflineService
from sidecar.provider.owner import ProviderOperationOwner


@pytest.fixture
def context(request):
    return request.getfixturevalue('drive_context')


def rotate(registry, old_lease):
    with _existing(registry._leases[old_lease]['path'], True) as db:
        grant = json.loads(db.execute('SELECT payload FROM canonical_local_owner_grants').fetchone()[0])
        grant['revision'] = str(uuid.uuid4())
        db.execute('UPDATE canonical_local_owner_grants SET payload=?', (json.dumps(grant),))


def rows(registry, lease):
    with _existing(registry._leases[lease]['path'], False) as db:
        return tuple(db.iterdump())


def renewed_lease(context, registry, service, auth, old):
    # Rotation invalidates the old activation digest. Establish the new lease's
    # permission through real current owner admission and explicit re-enrollment.
    rotate(registry, old)
    fresh = registry.issue(auth)
    host, previous = context[:2]
    owner = ProviderOperationOwner(registry, auth, fresh, host, host.current(), previous._evidence, previous._descriptor)
    admission, _scope = registry.admit_provider(auth, fresh, owner, owner.descriptor()['scope'])
    assert service.revoke_enrollment(auth, fresh, admission, SECRET) == {'status': 'revoked'}
    assert service.enroll(auth, fresh, admission, SECRET, str(uuid.uuid4()))['status'] == 'accepted'
    return fresh


def test_old_lease_cleanup_after_grant_rotation_preserves_fresh_lease_session_and_operation(context):
    registry, first, auth, old, _admission, _scope, _rid, http = enrolled(context)
    other = NativeOfflineService(registry)
    old_a = first.unlock(auth, old, SECRET)
    old_b = other.unlock(auth, old, SECRET)
    flight_a = other._capture(auth, old)
    service = first
    fresh = renewed_lease(context, registry, service, auth, old)
    current = service.unlock(auth, fresh, SECRET)
    repo, proof = offline_repository(registry, service, auth, fresh)
    flight_b = service._capture(auth, fresh)
    before, network = rows(registry, fresh), deepcopy(http['requests'])
    assert first.lock(auth, old) == {'status': 'locked'}
    assert first.lock(auth, old) == {'status': 'locked'}
    assert rows(registry, fresh) == before and http['requests'] == network
    for owner in (first, other):
        assert all(session['lease'] is not registry._leases[old] for session in owner._unlocks.values())
    with pytest.raises(AuthorityError, match='retired'):
        other._check(flight_a)
    with pytest.raises(AuthorityError):
        first.open(auth, old, old_a['unlockSession'], old_a['choices'][0]['handle'])
    with pytest.raises(AuthorityError):
        other.open(auth, old, old_b['unlockSession'], old_b['choices'][0]['handle'])
    service._check(flight_b)
    assert service.open(auth, fresh, current['unlockSession'], current['choices'][0]['handle'])['authorizationMode'] == 'provider-offline'
    registry.revalidate(auth, fresh, proof['admissionId'])
    assert repo.commit(folder_batch(repo, 'Fresh lease survives old cleanup'))['status'] == 'durable'
    registry.revoke_all()
    with pytest.raises(AuthorityError):
        repo.read(repo.scope['libraryId'])


def test_same_revision_cleanup_filters_old_lease_across_services_and_fences_only_its_jobs(context):
    registry, first, auth, old, _admission, _scope, _rid, _http = enrolled(context)
    other = NativeOfflineService(registry)
    old_unlocked = other.unlock(auth, old, SECRET)
    job_a = other._capture(auth, old)
    fresh = registry.issue(auth)
    current = first.unlock(auth, fresh, SECRET)
    job_b = first._capture(auth, fresh)
    before = rows(registry, fresh)
    first.lock(auth, old)
    assert rows(registry, fresh) == before
    with pytest.raises(AuthorityError, match='retired'):
        other._check(job_a)
    with pytest.raises(AuthorityError):
        other.open(auth, old, old_unlocked['unlockSession'], old_unlocked['choices'][0]['handle'])
    first._check(job_b)
    assert first.open(auth, fresh, current['unlockSession'], current['choices'][0]['handle'])['authorizationMode'] == 'provider-offline'


def test_lock_fences_an_actual_old_unlock_paused_in_kdf_without_retiring_fresh_lease(context, monkeypatch):
    registry, service, auth, old, _admission, _scope, _rid, _http = enrolled(context)
    entered, release = threading.Event(), threading.Event()
    original = crypto.unlock_header
    outcomes = []

    def paused(*args):
        if threading.current_thread().name == 'old-lease-kdf':
            entered.set()
            if not release.wait(5):
                raise TimeoutError('test-kdf-not-released')
        return original(*args)

    monkeypatch.setattr(crypto, 'unlock_header', paused)

    def old_unlock():
        try:
            outcomes.append(service.unlock(auth, old, SECRET))
        except Exception as error:  # noqa: BLE001 - test retains the actual thread outcome
            outcomes.append(error)

    thread = threading.Thread(target=old_unlock, name='old-lease-kdf')
    thread.start()
    try:
        assert entered.wait(5)
        fresh = registry.issue(auth)
        current = service.unlock(auth, fresh, SECRET)
        before = rows(registry, fresh)
        assert service.lock(auth, old) == {'status': 'locked'}
        release.set()
        thread.join(5)
        assert not thread.is_alive()
        assert len(outcomes) == 1 and isinstance(outcomes[0], AuthorityError)
        assert str(outcomes[0]) == 'offline-operation-retired'
        assert rows(registry, fresh) == before
        assert service.open(auth, fresh, current['unlockSession'], current['choices'][0]['handle'])['authorizationMode'] == 'provider-offline'
    finally:
        release.set()
        thread.join(5)


@pytest.mark.parametrize('invalid', ['forged', 'foreign', 'released'])
def test_unauthenticated_or_retired_cleanup_cannot_affect_another_live_lease(context, invalid):
    registry, service, auth, old, _admission, _scope, _rid, _http = enrolled(context)
    fresh = registry.issue(auth)
    current = service.unlock(auth, fresh, SECRET)
    if invalid == 'released':
        registry.release(auth, old)
    before = rows(registry, fresh)
    with pytest.raises(AuthorityError):
        service.lock('Bearer foreign-cleanup' if invalid == 'foreign' else auth, 'forged-lease' if invalid == 'forged' else old)
    assert rows(registry, fresh) == before
    assert service.open(auth, fresh, current['unlockSession'], current['choices'][0]['handle'])['authorizationMode'] == 'provider-offline'


def test_own_lock_is_idempotent_and_global_provider_revocation_remains_global(context):
    registry, service, auth, lease, _admission, _scope, _rid, _http = enrolled(context)
    first = service.unlock(auth, lease, SECRET)
    fresh = registry.issue(auth)
    second = service.unlock(auth, fresh, SECRET)
    before = rows(registry, fresh)
    assert service.lock(auth, lease) == service.lock(auth, lease) == {'status': 'locked'}
    assert rows(registry, fresh) == before
    with pytest.raises(AuthorityError):
        service.open(auth, lease, first['unlockSession'], first['choices'][0]['handle'])
    assert service.open(auth, fresh, second['unlockSession'], second['choices'][0]['handle'])['authorizationMode'] == 'provider-offline'
    with registry._lock:
        service._provider_admitted_locked('different-live-principal')
    with pytest.raises(AuthorityError):
        service.open(auth, fresh, second['unlockSession'], second['choices'][0]['handle'])
