"""Native read-budget preservation with real crypto, owner and SQLite.

Only private storage budgets are reduced, never auth or production assertions.
"""
import json
import uuid

import pytest
from test_provider_verifier import http as google_http  # noqa: F401
from test_provider_data_plane import context as drive_context  # noqa: F401
from test_native_offline import enrolled, offline_repository, folder_batch, SECRET
from test_native_offline_reclaim import second_library, rows, contents
from papeer.core.edit_model import canonical_json
from sidecar.canonical_host import NativeAuthority, _existing
from sidecar.provider.offline import crypto, storage
from sidecar.provider.offline.service import NativeOfflineService


@pytest.fixture
def context(request):
    return request.getfixturevalue('drive_context')


def size(raw):
    return len(raw.encode('utf8'))


def total(saved):
    return sum(size(raw) for raw in [saved['header'], saved['counter'], *saved['grants'].values(), *saved['pending'].values()] if raw is not None)


def pair(context, *, long_epoch=False):
    registry, service, auth, lease, admission_a, scope_a, request_a, http = enrolled(context)
    repository, _proof = offline_repository(registry, service, auth, lease)
    assert repository.commit(folder_batch(repository, 'Existing content and pending outbox'))['status'] == 'durable'
    if long_epoch:
        def change(value):
            if isinstance(value, dict):
                if {'accountId', 'libraryId', 'epoch'} <= value.keys(): value['epoch'] = 'long-' + 'x' * 190
                for child in value.values(): change(child)
            elif isinstance(value, list):
                for child in value: change(child)
        # The first activation is already stored. Only the second test template changes.
        change(context[2])
    owner_b, admission_b, scope_b = second_library(context)
    return registry, service, auth, lease, admission_b, scope_a, scope_b, request_a


def assert_existing_readable(registry, service, auth, lease, scope_a, http):
    requests_before = list(http['requests'])
    registry.revoke_all()
    cold = NativeAuthority(); cold_lease = cold.issue(auth); cold_service = NativeOfflineService(cold)
    repository, proof = offline_repository(cold, cold_service, auth, cold_lease)
    assert proof['scope'] == scope_a
    assert repository.read(scope_a['libraryId'])
    assert repository.pending_records()
    assert http['requests'] == requests_before


def test_row_limit_rejects_new_library_without_poisoning_existing_permission(context, monkeypatch):
    registry, service, auth, lease, admission_b, scope_a, scope_b, request_a = pair(context)
    before, content_before = rows(registry, lease), contents(registry, lease)
    monkeypatch.setattr(storage, 'MAX_ROWS', 3)  # header + counter + the already valid permission
    request_b = str(uuid.uuid4())
    assert service.enroll(auth, lease, admission_b, SECRET, request_b) == {
        'status': 'rejected', 'requestId': request_b, 'reason': 'offline-capacity-exceeded'}
    assert rows(registry, lease) == before and contents(registry, lease) == content_before
    assert_existing_readable(registry, service, auth, lease, scope_a, context[-1])


def test_total_payload_limit_keeps_reserved_nonce_consumed_and_existing_vault_readable(context, monkeypatch):
    registry, service, auth, lease, admission_b, scope_a, scope_b, request_a = pair(context)
    before, content_before = rows(registry, lease), contents(registry, lease)
    context_id = registry._leases[lease]['grant']['contextId']
    header, keys = crypto.unlock_header(json.loads(before['header']), context_id, SECRET)
    next_value = crypto.verify_counter(header, keys, json.loads(before['counter']))
    reserved_raw = canonical_json(crypto.sign_counter(header, keys, str(next_value + 1)))
    budget = max(total(before), total(before) - size(before['counter']) + size(reserved_raw)) + 64
    monkeypatch.setattr(storage, 'MAX_TOTAL_BYTES', budget)
    request_b = str(uuid.uuid4())
    assert service.enroll(auth, lease, admission_b, SECRET, request_b) == {
        'status': 'rejected', 'requestId': request_b, 'reason': 'offline-capacity-exceeded'}
    after = rows(registry, lease)
    assert after['header'] == before['header'] and after['grants'] == before['grants'] and after['pending'] == {}
    assert crypto.verify_counter(header, keys, json.loads(after['counter'])) == next_value + 1
    assert total(after) <= budget and contents(registry, lease) == content_before
    assert service.query(auth, lease, admission_b, SECRET, request_b)['status'] == 'rejected'
    assert_existing_readable(registry, service, auth, lease, scope_a, context[-1])


def test_individual_record_limit_rejects_pending_before_write_but_never_reuses_nonce(context, monkeypatch):
    registry, service, auth, lease, admission_b, scope_a, scope_b, request_a = pair(context, long_epoch=True)
    before = rows(registry, lease); context_id = registry._leases[lease]['grant']['contextId']
    header, keys = crypto.unlock_header(json.loads(before['header']), context_id, SECRET)
    next_value = crypto.verify_counter(header, keys, json.loads(before['counter']))
    budget = max(size(raw) for raw in [before['header'], before['counter'], *before['grants'].values()])
    monkeypatch.setattr(storage, 'MAX_RECORD_BYTES', budget)
    produced = []; original = crypto.seal; request_b = str(uuid.uuid4())
    def capture(*args):
        value = original(*args)
        if args[2] == request_b: produced.append(size(canonical_json(value)))
        return value
    monkeypatch.setattr(crypto, 'seal', capture)
    assert service.enroll(auth, lease, admission_b, SECRET, request_b) == {
        'status': 'rejected', 'requestId': request_b, 'reason': 'offline-capacity-exceeded'}
    assert produced and produced[0] > budget
    after = rows(registry, lease)
    assert after['header'] == before['header'] and after['grants'] == before['grants'] and after['pending'] == {}
    assert crypto.verify_counter(header, keys, json.loads(after['counter'])) == next_value + 1
    assert_existing_readable(registry, service, auth, lease, scope_a, context[-1])


def test_counter_json_growth_is_checked_before_reservation_commits(context, monkeypatch):
    registry, service, auth, lease, admission_b, scope_a, scope_b, request_a = pair(context)
    initial = rows(registry, lease); context_id = registry._leases[lease]['grant']['contextId']
    header, keys = crypto.unlock_header(json.loads(initial['header']), context_id, SECRET)
    candidates = [9, 99, 999, 9999, *range(2, 502)]
    for counter in candidates:
        old_raw = canonical_json(crypto.sign_counter(header, keys, str(counter)))
        new_raw = canonical_json(crypto.sign_counter(header, keys, str(counter + 1)))
        if size(new_raw) > size(old_raw): break
    else: pytest.fail('No valid signed-counter JSON growth fixture found')
    with _existing(registry._leases[lease]['path'], True) as db:
        storage.reserve(db, context_id, initial['counter'], json.loads(old_raw))
    before = rows(registry, lease)
    monkeypatch.setattr(storage, 'MAX_TOTAL_BYTES', total(before))
    request_b = str(uuid.uuid4())
    assert service.enroll(auth, lease, admission_b, SECRET, request_b) == {
        'status': 'rejected', 'requestId': request_b, 'reason': 'offline-capacity-exceeded'}
    assert rows(registry, lease) == before  # The larger counter was never committed.
    assert_existing_readable(registry, service, auth, lease, scope_a, context[-1])


def test_pending_promotion_at_exact_row_limit_is_atomic_without_transient_overshoot(context, monkeypatch):
    registry, service, auth, lease, admission_b, scope_a, scope_b, request_a = pair(context)
    monkeypatch.setattr(storage, 'MAX_ROWS', 4)  # One existing grant plus one pending/new grant.
    request_b = str(uuid.uuid4())
    assert service.enroll(auth, lease, admission_b, SECRET, request_b)['status'] == 'accepted'
    saved = rows(registry, lease)
    assert set(saved['grants']) == {request_a, request_b} and saved['pending'] == {}
    registry.revoke_all(); registry = NativeAuthority(); lease = registry.issue(auth); service = NativeOfflineService(registry)
    unlocked = service.unlock(auth, lease, SECRET)
    assert len(unlocked['choices']) == 2
    actual = set()
    for choice in unlocked['choices']:
        target = service.open(auth, lease, unlocked['unlockSession'], choice['handle'])
        actual.add(registry.inspect_handle(auth, lease, target['handleId'])['scope']['libraryId'])
    assert actual == {scope_a['libraryId'], scope_b['libraryId']}


def test_new_header_counter_batch_rolls_back_if_counter_would_exceed_budget(context, monkeypatch):
    host, owner, plan, activate, put, http = context; activate()
    registry, auth, lease = owner._registry, owner._authorization, owner._lease_id
    admission, scope = registry.admit_provider(auth, lease, owner, owner.descriptor()['scope'])
    service = NativeOfflineService(registry); original = crypto.create_header
    def bounded_header(*args):
        header, keys = original(*args)
        counter_raw = canonical_json(crypto.sign_counter(header, keys, '2'))
        monkeypatch.setattr(storage, 'MAX_TOTAL_BYTES', size(canonical_json(header)) + size(counter_raw) - 1)
        return header, keys
    monkeypatch.setattr(crypto, 'create_header', bounded_header)
    before = rows(registry, lease); request = str(uuid.uuid4())
    assert service.enroll(auth, lease, admission, SECRET, request) == {
        'status': 'rejected', 'requestId': request, 'reason': 'offline-capacity-exceeded'}
    assert rows(registry, lease) == before


def test_first_header_record_is_checked_before_any_vault_row_is_written(context, monkeypatch):
    host, owner, plan, activate, put, http = context; activate()
    registry, auth, lease = owner._registry, owner._authorization, owner._lease_id
    admission, scope = registry.admit_provider(auth, lease, owner, owner.descriptor()['scope'])
    service = NativeOfflineService(registry); before = rows(registry, lease)
    monkeypatch.setattr(storage, 'MAX_RECORD_BYTES', 1)
    request = str(uuid.uuid4())
    assert service.enroll(auth, lease, admission, SECRET, request) == {
        'status': 'rejected', 'requestId': request, 'reason': 'offline-capacity-exceeded'}
    assert rows(registry, lease) == before
