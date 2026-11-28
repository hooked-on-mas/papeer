"""Actual fixed host + real NativeAuthority/SQLite owner, fake Google HTTP only.

This does not execute real OAuth, Google, public sync routes or Native GUI.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import uuid
import pytest

from test_provider_verifier import http as google_http, connected  # noqa: F401 - pytest fixture
from papeer.core.edit_model import canonical_json
from papeer.core.edit_drive import scope_namespace
from papeer.core.edits.provider.activation import _commitment, _digest, prepare_join, mark_join_published, activate_prepared, upgrade_provider_metadata
from sidecar import deps
from sidecar.canonical_host import NativeAuthority, AuthorityError
from sidecar.provider.owner import ProviderOperationOwner


@pytest.fixture
def context(google_http, monkeypatch, tmp_path):  # noqa: F811 - imported pytest fixture injection
    http = google_http
    monkeypatch.setenv('PAPEER_DATA_DIR', str(tmp_path / 'isolated-library'))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'synthetic-owner-token')
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy library opened'))
    plan = json.loads((Path(__file__).parents[2] / 'fixtures/synthetic-provider-owner-plan.json').read_text('utf8'))['plans']['join']
    host, principal = connected()
    registry = NativeAuthority(); authorization = 'Bearer synthetic-owner-token'; lease = registry.provision(authorization)
    plan['ownerNamespace'] = registry._lease(authorization, lease)['grant']['namespaceId']
    plan['principalDigest'] = principal['digest']; plan['binding']['principalDigest'] = principal['digest']
    raw = bytes.fromhex(plan['descriptorBytesHex']); descriptor = json.loads(raw)
    folder, selected = plan['folderId'], plan['descriptor']['id']
    http['files'][folder] = {'metadata': http['metadata'](folder, mimeType='application/vnd.google-apps.folder', properties={}), 'bytes': b''}
    http['files'][selected] = {'metadata': http['metadata'](selected, name=plan['title'], parents=[folder], version=plan['descriptor']['version'], size=str(len(raw)), sha256Checksum=hashlib.sha256(raw).hexdigest()), 'bytes': raw}
    summary = host.descriptor(principal, selected)
    evidence = {'principalDigest': principal['digest'], 'descriptorId': selected, 'descriptorVersion': summary['version'], 'descriptorSha256': summary['sha256'],
                'owner': True, 'readable': True, 'writable': True, 'folderId': folder}
    owner = ProviderOperationOwner(registry, authorization, lease, host, principal, evidence, descriptor)
    with owner.transaction('provider-upgrade') as db: upgrade_provider_metadata(db)
    plan['intent']['phase'] = 'prepared'; plan['intent']['requestSha256'] = _digest(_commitment(plan))
    def admit():
        assert prepare_join(owner, plan, {})['status'] == 'pending'
        published = deepcopy(plan); published['intent']['phase'] = 'published'
        assert mark_join_published(owner, published)['status'] == 'pending'
        assert activate_prepared(owner, plan['requestId'])['status'] == 'accepted'
    def put(file_id, value):
        raw = canonical_json(value).encode('utf8')
        http['files'][file_id] = {'metadata': http['metadata'](file_id, parents=[folder], size=str(len(raw)), properties={'papeer': 'edits-v1', 'scope': scope_namespace(descriptor['scope']), 'editKind': value['kind']}), 'bytes': raw}
    try: yield host, owner, plan, admit, put, http
    finally: host.close()


def test_join_dataset_reads_actual_scoped_envelopes_before_admission_but_cannot_write(context):
    host, owner, plan, _admit, put, _http = context
    storage = host.dataset_storage(owner)
    with pytest.raises(ValueError, match='provider-read-only'):
        storage.imported(str(uuid.uuid4()), str(uuid.uuid4()))
    with pytest.raises(AuthorityError, match='provider-binding-missing'): host.edit_storage(owner)  # real inactive SQLite binding, not a supplied boolean
    put('manifest', {'kind': 'dataset-manifest', 'manifest': plan['publication']['manifest']})
    put('checkpoint', {'kind': 'repository-checkpoint', 'checkpoint': plan['publication']['checkpoint']})
    actual = storage.read_published_dataset()
    assert actual == {'manifest': plan['publication']['manifest'], 'checkpoint': plan['publication']['checkpoint'], 'resources': []}
    with pytest.raises(ValueError, match='owner-required'): host.dataset_storage({'scope': owner.descriptor()['scope']})


def test_admitted_same_id_accepted_post_lost_then_409_replay_and_immutable_receipt(context):
    host, owner, _plan, admit, _put, http = context; admit()
    storage = host.edit_storage(owner); batch, peer = str(uuid.uuid4()), str(uuid.uuid4())
    value = {'kind': 'import-receipt', 'batchId': batch, 'peerId': peer}; logical = batch + '-' + peer
    http['lose'].add('retained-receipt')
    with pytest.raises(ValueError, match='network'): storage.upload_json(logical, value, 'retained-receipt')
    assert storage.upload_json(logical, value, 'retained-receipt') is None
    assert http['created']['retained-receipt'] == 1
    assert storage.pull()['imports'] == [{'batchId': batch, 'peerId': peer}]
    cold_storage = host.edit_storage(owner)
    assert cold_storage.upload_json(logical, value, 'retained-receipt') is None
    altered = {**value, 'peerId': str(uuid.uuid4())}
    with pytest.raises(ValueError): storage.upload_json(logical, altered, 'retained-receipt')
    http['files']['retained-receipt']['bytes'] = b'{}'
    # Real Drive increments version on every server-side content change.
    http['files']['retained-receipt']['metadata']['version'] = '9007199254740994'
    with pytest.raises(ValueError): storage.pull()


def test_binary_resumable_chunking_hash_and_cold_retained_ids(context):
    host, owner, _plan, admit, _put, http = context; admit(); storage = host.edit_storage(owner)
    data = b'canonical-resource' * 600000  # exceeds 8MiB: real 308 continuation path at fake HTTP boundary
    metadata = {'id': str(uuid.uuid4()), 'mediaType': 'application/octet-stream', 'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    http['lose'].add('retained-blob')
    with pytest.raises(ValueError, match='network'): storage.save_resource(metadata, data, 'retained-blob', 'retained-resource-envelope')
    assert storage.save_resource(metadata, data, 'retained-blob', 'retained-resource-envelope') is None
    assert http['created']['retained-blob'] == 1
    assert len([entry for entry in http['requests'] if entry[0] == 'PUT']) == 2
    cold_storage = host.edit_storage(owner)
    assert cold_storage.save_resource(metadata, data, 'retained-blob', 'retained-resource-envelope') is None
    assert cold_storage.pull()['resources'] == [metadata]
    assert cold_storage.download_resource(metadata) == {'metadata': metadata, 'bytes': data}
    http['files']['retained-blob']['bytes'] = b'x' * len(data)
    with pytest.raises(ValueError, match='hash'): cold_storage.download_resource(metadata)


def test_scope_version_envelope_and_credential_lifetime_rejections(context):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    batch, peer = str(uuid.uuid4()), str(uuid.uuid4()); value = {'kind': 'import-receipt', 'batchId': batch, 'peerId': peer}
    put('receipt', value); assert storage.read_json('receipt') == value
    http['files']['receipt']['metadata']['properties']['scope'] = '0' * 64
    with pytest.raises(ValueError, match='scope'): storage.read_json('receipt')
    put('receipt', {**value, 'extra': True})
    with pytest.raises(ValueError, match='envelope'): storage.read_json('receipt')
    put('receipt', value); http['version_race'] = True
    with pytest.raises(ValueError, match='changed'): storage.read_json('receipt')
    host.disconnect_and_wait(); before = len(http['requests'])
    with pytest.raises((AuthorityError, ValueError), match='auth-changed|not-connected|operation-invalid'): storage.pull()
    assert len(http['requests']) == before


def test_wrong_409_object_cannot_be_overwritten_or_reused(context):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    batch, peer = str(uuid.uuid4()), str(uuid.uuid4())
    value = {'kind': 'import-receipt', 'batchId': batch, 'peerId': peer}
    put('taken-id', {**value, 'peerId': str(uuid.uuid4())})
    before = deepcopy(http['files']['taken-id'])
    with pytest.raises(ValueError, match='immutable'):
        storage.upload_json(batch + '-' + peer, value, 'taken-id')
    assert http['files']['taken-id'] == before
    assert 'taken-id' not in http['created']


def test_active_owner_invalidation_stops_data_plane_without_followup_http(context):
    host, owner, _plan, admit, _put, http = context; admit(); storage = host.edit_storage(owner)
    owner.invalidate(); before = len(http['requests'])
    with pytest.raises(AuthorityError, match='provider-operation-invalid'): storage.pull()
    with pytest.raises(AuthorityError, match='provider-operation-invalid'): storage.imported(str(uuid.uuid4()), str(uuid.uuid4()))
    assert len(http['requests']) == before


def test_join_descriptor_changed_during_read_is_rejected_without_local_stage(context, monkeypatch):
    from urllib.parse import parse_qs, urlparse
    from papeer.core.providers.drive import transport
    host, owner, plan, _admit, put, http = context
    storage = host.dataset_storage(owner)
    put('manifest', {'kind': 'dataset-manifest', 'manifest': plan['publication']['manifest']})
    original = transport._open
    def changing(request, timeout):
        response = original(request, timeout)
        url = urlparse(request.full_url)
        if url.path.endswith('/manifest') and parse_qs(url.query).get('alt') == ['media']:
            http['files'][plan['descriptor']['id']]['metadata']['version'] = '8'
        return response
    monkeypatch.setattr(transport, '_open', changing)
    with pytest.raises(AuthorityError, match='provider-descriptor-changed'): storage.read_json('manifest')
    # Sticky selected-owner failure remains even if the remote metadata changes back.
    http['files'][plan['descriptor']['id']]['metadata']['version'] = '7'
    with pytest.raises(AuthorityError, match='provider-operation-invalid'): storage.files()


@pytest.mark.parametrize('failure', ['foreign-location', 'wrong-range'])
def test_resumable_session_or_range_cannot_publish_resource_descriptor(context, monkeypatch, failure):
    from urllib.error import HTTPError
    from urllib.parse import parse_qs, urlparse
    from papeer.core.providers.drive import transport
    host, owner, _plan, admit, _put, http = context; admit(); storage = host.edit_storage(owner)
    data = b'x' * (9 * 1024 * 1024)
    metadata = {'id': str(uuid.uuid4()), 'mediaType': 'application/octet-stream', 'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    original = transport._open
    def broken(request, timeout):
        try: response = original(request, timeout)
        except HTTPError as error:
            if failure == 'wrong-range' and error.code == 308:
                raise HTTPError(request.full_url, 308, 'synthetic wrong-range', {'Range': 'bytes=0-1'}, None) from None
            raise
        if failure == 'foreign-location' and parse_qs(urlparse(request.full_url).query).get('uploadType') == ['resumable']:
            response.headers = {'Location': 'https://not-google.invalid/upload'}
        return response
    monkeypatch.setattr(transport, '_open', broken)
    with pytest.raises(ValueError, match='origin|range'): storage.save_resource(metadata, data, 'failed-blob', 'failed-descriptor')
    assert 'failed-descriptor' not in http['files'] and 'failed-blob' not in http['files']


# These exercise the real fixed host, real owner/SQLite admission and production
# transport; only the HTTP boundary is synthetic. No Google/OAuth claim.
def _cache_http(monkeypatch):
    from urllib.parse import parse_qs, urlparse
    from papeer.core.providers.drive import transport
    from test_provider_verifier import Response
    original = transport._open
    trace = {'bodies': {}, 'list': None, 'after_body': None, 'after_list': None}
    def observed(request, timeout):
        response = original(request, timeout)
        url = urlparse(request.full_url); query = parse_qs(url.query)
        if request.method == 'GET' and url.path.endswith('/files'):
            if trace['list'] is not None:
                value = json.loads(response.read()); response.close()
                value['files'] = trace['list'](value['files'])
                response = Response(json.dumps(value).encode())
            if trace['after_list'] is not None: trace['after_list']()
        elif query.get('alt') == ['media']:
            file_id = url.path.rsplit('/', 1)[1]
            trace['bodies'][file_id] = trace['bodies'].get(file_id, 0) + 1
            if trace['after_body'] is not None: trace['after_body'](file_id)
        return response
    monkeypatch.setattr(transport, '_open', observed)
    return trace


def _receipt_value():
    return {'kind': 'import-receipt', 'batchId': str(uuid.uuid4()), 'peerId': str(uuid.uuid4())}


def test_pull_cache_reuses_only_body_and_returns_complete_detached_log(context, monkeypatch):
    from papeer.core.providers.drive.verifier import FIELDS
    host, owner, plan, admit, put, _http = context; admit()
    storage = host.edit_storage(owner); trace = _cache_http(monkeypatch)
    first, second = _receipt_value(), _receipt_value(); put('one', first); put('two', second)
    expected = [{'batchId': value['batchId'], 'peerId': value['peerId']} for value in [first, second]]
    assert storage.pull()['imports'] == expected
    descriptor_id = plan['descriptor']['id']
    first_freshness = trace['bodies'][descriptor_id]
    assert first_freshness > 0
    assert storage.pull()['imports'] == expected
    assert trace['bodies'][descriptor_id] > first_freshness, 'warm hits still perform real descriptor media freshness reads'
    assert trace['bodies']['one'] == trace['bodies']['two'] == 1
    assert len(storage._envelope_cache) == 2
    returned = storage.pull(); returned['imports'][0]['peerId'] = 'altered-return-only'
    assert storage.pull()['imports'] == expected
    # Direct reads never use the pull cache, including their admission fences.
    assert storage.read_json('one') == first and trace['bodies']['one'] == 2
    assert 'ownedByMe' in FIELDS and 'capabilities' in FIELDS and 'parents' in FIELDS


@pytest.mark.parametrize('field', ['version', 'name'])
def test_pull_cache_changed_complete_header_requires_validated_body(context, monkeypatch, field):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); value = _receipt_value(); put('one', value); storage.pull()
    http['files']['one']['metadata'][field] = '9007199254740994' if field == 'version' else 'renamed immutable envelope'
    assert storage.pull()['imports'][0]['batchId'] == value['batchId']
    assert trace['bodies']['one'] == 2
    storage.pull(); assert trace['bodies']['one'] == 2


def test_pull_cache_changed_content_preserves_immutable_seen_anchor(context, monkeypatch):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); value = _receipt_value(); put('one', value); storage.pull()
    seen = deepcopy(storage._seen)
    put('one', {**value, 'peerId': str(uuid.uuid4())}); http['files']['one']['metadata']['version'] = '9007199254740994'
    with pytest.raises(ValueError, match='immutable-drive-file-changed'): storage.pull()
    assert storage._envelope_cache == {} and storage._seen == seen and trace['bodies']['one'] == 2


@pytest.mark.parametrize('damage', ['missing-version', 'invalid-version', 'missing-capabilities', 'denied', 'scope', 'parent', 'duplicate'])
def test_pull_cache_incomplete_or_denied_list_row_falls_back_without_dropping(context, monkeypatch, damage):
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); value = _receipt_value(); put('one', value); storage.pull()
    def change(rows):
        rows = deepcopy(rows); row = next(item for item in rows if item['id'] == 'one')
        if damage == 'missing-version': row.pop('version')
        elif damage == 'invalid-version': row['version'] = 'unknown'
        elif damage == 'missing-capabilities': row.pop('capabilities')
        elif damage == 'denied': row['capabilities']['canDownload'] = False
        elif damage == 'scope': row['properties']['scope'] = '0' * 64
        elif damage == 'parent': row['parents'] = ['other-folder']
        else: rows.append(deepcopy(row))
        return rows
    trace['list'] = change
    actual = storage.pull()['imports']
    assert actual and all(item == {'batchId': value['batchId'], 'peerId': value['peerId']} for item in actual)
    assert len(actual) == (2 if damage == 'duplicate' else 1)
    assert trace['bodies']['one'] == (3 if damage == 'duplicate' else 2)
    assert 'one' not in storage._envelope_cache


def test_pull_cache_actual_owner_denial_does_not_return_cached_body(context, monkeypatch):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); put('one', _receipt_value()); storage.pull()
    http['files']['one']['metadata']['ownedByMe'] = False
    with pytest.raises(ValueError, match='owner-write-required'): storage.pull()
    assert storage._envelope_cache == {} and trace['bodies']['one'] == 1


def test_pull_cache_failed_pull_clears_only_cache_then_retry_reads_all(context, monkeypatch):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); first, second = _receipt_value(), _receipt_value()
    put('one', first); storage.pull(); seen = deepcopy(storage._seen); references = deepcopy(storage._references)
    put('two', {**second, 'unexpected': True})
    with pytest.raises(ValueError, match='invalid-edit-envelope'): storage.pull()
    assert storage._envelope_cache == {} and storage._seen == seen and storage._references == references
    put('two', second); http['files']['two']['metadata']['version'] = '9007199254740994'
    assert len(storage.pull()['imports']) == 2
    assert trace['bodies']['one'] == 2 and trace['bodies']['two'] == 2


def test_pull_cache_cancel_clears_and_renew_retries_without_new_credentials(context, monkeypatch):
    from papeer.core.providers.drive.request_group import ProviderRequestCancelled
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); put('one', _receipt_value()); storage.pull(); seen = deepcopy(storage._seen)
    trace['after_list'] = storage.cancel
    with pytest.raises(ProviderRequestCancelled): storage.pull()
    assert storage._envelope_cache == {} and storage._seen == seen
    trace['after_list'] = None; storage.renew()
    assert len(storage.pull()['imports']) == 1 and trace['bodies']['one'] == 2
    storage.finish()


def test_pull_cache_cold_and_disappeared_entries_require_body_again(context, monkeypatch):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); value = _receipt_value(); put('one', value); storage.pull()
    assert len(host.edit_storage(owner).pull()['imports']) == 1 and trace['bodies']['one'] == 2
    saved = http['files'].pop('one'); assert storage.pull()['imports'] == [] and storage._envelope_cache == {}
    http['files']['one'] = saved; storage.pull(); assert trace['bodies']['one'] == 3


@pytest.mark.parametrize('budget', ['bytes', 'entries'])
def test_pull_cache_memory_budget_falls_back_without_truncating_log(context, monkeypatch, budget):
    from papeer.core.providers.drive import data_plane
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); put('one', _receipt_value()); put('two', _receipt_value())
    monkeypatch.setattr(data_plane, 'MAX_ENVELOPE_CACHE_BYTES' if budget == 'bytes' else 'MAX_ENVELOPE_CACHE_ENTRIES', 1)
    assert len(storage.pull()['imports']) == len(storage.pull()['imports']) == 2
    assert len(storage._envelope_cache) == (0 if budget == 'bytes' else 1)
    assert trace['bodies']['two'] == 2
    assert sum(len(header) + len(raw) for header, raw in storage._envelope_cache.values()) <= data_plane.MAX_ENVELOPE_CACHE_BYTES


@pytest.mark.parametrize('revocation', ['descriptor-version', 'folder-permission'])
def test_pull_cache_all_hits_still_fail_outer_post_freshness(context, monkeypatch, revocation):
    host, owner, plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); put('one', _receipt_value()); storage.pull()
    descriptor_id = plan['descriptor']['id']
    descriptor_reads = trace['bodies'][descriptor_id]
    cache_before = deepcopy(storage._envelope_cache); seen_before = deepcopy(storage._seen)
    at_list = {}
    def revoke_after_fresh_list():
        at_list['descriptorReads'] = trace['bodies'][descriptor_id]
        at_list['folderRequests'] = http['requests'].count(('GET', '/drive/v3/files/' + plan['folderId']))
        # The completed list snapshot still contains the same full envelope header.
        # No per-item GET is needed for this hit, so only the outer post-check can
        # observe this actual selected descriptor/folder revocation.
        if revocation == 'descriptor-version':
            http['files'][descriptor_id]['metadata']['version'] = '8'
        else:
            http['files'][plan['folderId']]['metadata']['capabilities']['canEdit'] = False
    trace['after_list'] = revoke_after_fresh_list
    with pytest.raises((AuthorityError, ValueError), match='descriptor-changed|owner-write-required'):
        storage.pull()
    assert cache_before and storage._envelope_cache == {}
    assert storage._seen == seen_before
    assert trace['bodies']['one'] == 1, 'the failed second pull used an envelope cache hit'
    assert trace['bodies'][descriptor_id] > descriptor_reads, 'fresh pre-check still fetched actual descriptor bytes'
    if revocation == 'descriptor-version':
        assert trace['bodies'][descriptor_id] > at_list['descriptorReads'], 'post-check fetched changed descriptor bytes'
    assert http['requests'].count(('GET', '/drive/v3/files/' + plan['folderId'])) > at_list['folderRequests'], 'post-check revalidated folder metadata'


@pytest.mark.parametrize('revocation', ['descriptor-version', 'folder-permission'])
def test_cold_pull_misses_reject_remote_revocation_before_return(context, monkeypatch, revocation):
    import sqlite3
    host, owner, plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); put('one', _receipt_value()); put('two', _receipt_value())
    with sqlite3.connect(owner._path) as db: before = list(db.iterdump())
    def revoke(file_id):
        if file_id != 'one': return
        if revocation == 'descriptor-version': http['files'][plan['descriptor']['id']]['metadata']['version'] = '8'
        else: http['files'][plan['folderId']]['metadata']['capabilities']['canEdit'] = False
    trace['after_body'] = revoke
    with pytest.raises((AuthorityError, ValueError), match='descriptor-changed|owner-write-required'):
        storage.pull()
    # Batch freshness detects remote revocation at the outer post-check: individually
    # authorized later GETs may finish, but no result/cache or Core write escapes.
    assert trace['bodies']['one'] == trace['bodies']['two'] == 1
    assert storage._envelope_cache == {}
    with sqlite3.connect(owner._path) as db: assert list(db.iterdump()) == before
    with pytest.raises((AuthorityError, ValueError)): storage.pull()


@pytest.mark.parametrize('loss', ['lease', 'group'])
def test_cold_pull_misses_reject_local_lease_loss_or_group_cancel(context, monkeypatch, loss):
    import sqlite3
    from papeer.core.providers.drive.request_group import ProviderRequestCancelled
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); put('one', _receipt_value()); put('two', _receipt_value())
    with sqlite3.connect(owner._path) as db: before = list(db.iterdump())
    def cancel(file_id):
        if file_id != 'one': return
        if loss == 'group': storage.cancel()
        else: owner._registry.release(owner._authorization, owner._lease_id)
    trace['after_body'] = cancel
    with pytest.raises((AuthorityError, ValueError, ProviderRequestCancelled)): storage.pull()
    assert storage._envelope_cache == {}
    if loss == 'group': assert 'two' not in trace['bodies']
    with sqlite3.connect(owner._path) as db: assert list(db.iterdump()) == before


def test_direct_json_read_keeps_fresh_guard_before_body(context, monkeypatch):
    host, owner, plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    trace = _cache_http(monkeypatch); value = _receipt_value(); put('one', value)
    assert storage.read_json('one') == value
    assert trace['bodies'][plan['descriptor']['id']] >= 2
    http['files'][plan['descriptor']['id']]['metadata']['version'] = '8'
    with pytest.raises(AuthorityError, match='descriptor-changed'): storage.read_json('one')
    assert trace['bodies']['one'] == 1


def test_incremental_pull_only_after_identity_bound_ack_and_dataset_remains_full(context):
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    value = _receipt_value(); put('incremental-one', value)
    pair = (value['batchId'], value['peerId'])
    first = storage.pull(); assert first['imports'] == [{'batchId': pair[0], 'peerId': pair[1]}]
    second = storage.pull(); assert second['imports'] == first['imports']
    with pytest.raises(ValueError, match='provider-delivery-stale'):
        storage.acknowledge_pull(first, [], [pair], [])
    storage.acknowledge_pull(second, [], [pair], [])
    assert storage.pull()['imports'] == []
    assert storage.pull(True)['imports'] == first['imports']
    assert host.edit_storage(owner).pull()['imports'] == first['imports']


def test_incremental_pull_cancel_renew_and_unknown_header_replay(context, monkeypatch):
    host, owner, _plan, admit, put, http = context; admit(); storage = host.edit_storage(owner)
    try:
        value = _receipt_value(); put('incremental-two', value); pair = (value['batchId'], value['peerId'])
        first = storage.pull(); storage.acknowledge_pull(first, [], [pair], [])
        assert storage.pull()['imports'] == []
        storage.cancel()
        from papeer.core.providers.drive.request_group import ProviderRequestCancelled
        with pytest.raises(ProviderRequestCancelled): storage.acknowledge_pull(first, [], [pair], [])
        storage.renew(); assert storage.pull()['imports'] == [{'batchId': pair[0], 'peerId': pair[1]}]
        # Damage LIST only: GET continues to validate actual full metadata.
        trace = _cache_http(monkeypatch)
        def missing_version(rows):
            rows = deepcopy(rows); next(row for row in rows if row['id'] == 'incremental-two').pop('version', None); return rows
        trace['list'] = missing_version
        returned = storage.pull(); storage.acknowledge_pull(returned, [], [pair], [])
        assert storage.pull()['imports'] == [{'batchId': pair[0], 'peerId': pair[1]}]
        assert trace['bodies']['incremental-two'] >= 2
    finally:
        storage.finish()


def test_incremental_pull_unhandled_import_and_ack_failure_replay(context):
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    known, missing = _receipt_value(), _receipt_value(); put('incremental-known', known); put('incremental-missing', missing)
    incoming = storage.pull(); known_pair = (known['batchId'], known['peerId'])
    # Only the actually handled receipt can be acknowledged.
    storage.acknowledge_pull(incoming, [], [known_pair], [])
    assert storage.pull()['imports'] == [{'batchId': missing['batchId'], 'peerId': missing['peerId']}]
    owner.invalidate()
    with pytest.raises(AuthorityError): storage.pull()


def test_incremental_pull_eviction_replays_and_revocation_still_denies(context, monkeypatch):
    import papeer.core.providers.drive.data_plane as plane
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    one, two = _receipt_value(), _receipt_value(); put('incremental-cap-one', one)
    first = storage.pull(); pair = (one['batchId'], one['peerId']); storage.acknowledge_pull(first, [], [pair], [])
    assert storage.pull()['imports'] == []
    monkeypatch.setattr(plane, 'MAX_ENVELOPE_CACHE_ENTRIES', 0)
    assert storage.pull()['imports'] == [{'batchId': pair[0], 'peerId': pair[1]}]
    put('incremental-cap-two', two)
    assert len(storage.pull()['imports']) == 2
    owner.invalidate()
    with pytest.raises(AuthorityError): storage.pull()


def test_incremental_pull_ack_failure_does_not_consume_delivery(context, monkeypatch):
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    value = _receipt_value(); put('incremental-failed-ack', value); pair = (value['batchId'], value['peerId'])
    incoming = storage.pull()
    original = owner.assert_admitted
    def fail(): raise ValueError('injected-admission-failure')
    monkeypatch.setattr(owner, 'assert_admitted', fail)
    with pytest.raises(ValueError, match='injected-admission-failure'):
        storage.acknowledge_pull(incoming, [], [pair], [])
    monkeypatch.setattr(owner, 'assert_admitted', original)
    assert storage.pull()['imports'] == [{'batchId': pair[0], 'peerId': pair[1]}]


def test_incremental_direct_renew_rejects_old_delivery_and_replays(context):
    host, owner, _plan, admit, put, _http = context; admit(); storage = host.edit_storage(owner)
    try:
        value = _receipt_value(); put('renew-late', value); pair = (value['batchId'], value['peerId'])
        old = storage.pull(); storage.renew()
        with pytest.raises(ValueError, match='provider-delivery-stale'): storage.acknowledge_pull(old, [], [pair], [])
        fresh = storage.pull(); assert fresh['imports'] == [{'batchId': pair[0], 'peerId': pair[1]}]
        storage.acknowledge_pull(fresh, [], [pair], []); assert storage.pull()['imports'] == []
    finally:
        storage.finish()


def test_actual_sync_replays_old_edit_until_durable_then_omits_it(context, monkeypatch):
    from sidecar.provider.sync_once import sync_once
    from sidecar.provider.sync_authority import SyncAuthority
    from sidecar.provider.transfer_ids import TransferIds
    from papeer.core.edit_repository import SqliteEditRepository
    host, owner, plan, admit, put, http = context; admit()
    scope = plan['binding']['scope']; registry = owner._registry; auth = owner._authorization; lease = owner._lease_id
    admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    # The actual repository read supplies a valid current graph head.
    public = SqliteEditRepository(registry.bind_repository(auth, lease, admission), scope)
    parent = public.read(scope['libraryId'])['heads'][0]
    batch_id = str(uuid.uuid4())
    batch = {'kind': 'library', 'id': batch_id, 'libraryId': scope['libraryId'], 'targetId': scope['libraryId'],
             'parents': [parent], 'changes': [{'type': 'put-folder', 'folder': {'id': str(uuid.uuid4()), 'title': 'incremental', 'parentId': None, 'position': 0}}]}
    put('incremental-old-edit', {'kind': 'edit-record', 'record': {'batch': batch}})
    before = deepcopy(http['files']['incremental-old-edit']['metadata'])
    missing = _receipt_value(); put('incremental-missing-import', missing)
    missing_value = {'batchId': missing['batchId'], 'peerId': missing['peerId']}
    storage = host.edit_storage(owner); recorded = []; original = repository.receive_records; lose = True
    def receive(records):
        nonlocal lose
        recorded.append([value['batch']['id'] for value in records]); result = original(records)
        if lose:
            lose = False
            raise OSError('reply lost after durable receive')
        return result
    monkeypatch.setattr(repository, 'receive_records', receive)
    ids = TransferIds(owner, host); peer = registry._admissions[admission]['proof']['peer']['peerId']
    with pytest.raises(OSError, match='reply lost after durable receive'):
        sync_once(owner, repository, storage, peer, lambda: False, ids)
    assert public.receipt(batch_id)['durable'] is True
    replay = storage.pull()
    assert batch_id in [record['batch']['id'] for record in replay['edits']]
    assert missing_value in replay['imports']
    sync_once(owner, repository, storage, peer, lambda: False, ids)
    sync_once(owner, repository, storage, peer, lambda: False, ids)
    assert http['files']['incremental-old-edit']['metadata'] == before
    assert batch_id in recorded[0] and batch_id in recorded[1] and batch_id not in recorded[2]
    assert missing_value in storage.pull()['imports']


def test_actual_sync_resource_ack_preserves_bytes_and_validates_duplicate_metadata(context):
    from sidecar.provider.sync_once import sync_once
    from sidecar.provider.sync_authority import SyncAuthority
    from sidecar.provider.transfer_ids import TransferIds
    from papeer.core.edit_repository import SqliteEditRepository
    host, owner, plan, admit, put, http = context; admit()
    scope = plan['binding']['scope']; registry = owner._registry; auth = owner._authorization; lease = owner._lease_id
    admission, _ = registry.admit_provider(auth, lease, owner, scope)
    repository = SqliteEditRepository(SyncAuthority(registry, auth, lease, admission, owner, scope), scope)
    storage = host.edit_storage(owner); body = b'incremental resource bytes'; resource_id = str(uuid.uuid4())
    metadata = {'id': resource_id, 'mediaType': 'application/octet-stream', 'byteLength': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
    storage.save_resource(metadata, body, 'incremental-resource-blob', 'incremental-resource-descriptor')
    sync_once(owner, repository, storage, registry._admissions[admission]['proof']['peer']['peerId'], lambda: False, TransferIds(owner, host))
    assert repository.read_resource(resource_id) == {'metadata': metadata, 'bytes': body}
    assert storage.pull()['resources'] == []
    assert storage.download_resource(metadata) == {'metadata': metadata, 'bytes': body}
    altered = {**metadata, 'mediaType': 'image/png'}
    put('incremental-resource-conflict', {'kind': 'resource', 'metadata': altered, 'blobId': 'incremental-resource-blob'})
    try:
        with pytest.raises(ValueError, match='resource-id-reused'): storage.pull()
    finally:
        del http['files']['incremental-resource-conflict']
    assert repository.read_resource(resource_id) == {'metadata': metadata, 'bytes': body}
    # Failed pull clears the cache: the original must be replayed, not lost.
    assert storage.pull()['resources'] == [metadata]
    assert storage.download_resource(metadata) == {'metadata': metadata, 'bytes': body}
