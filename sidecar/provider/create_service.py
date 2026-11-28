"""Host-private CREATE orchestration. No plan or credential crosses the UI boundary."""
import json
import threading
import time

from papeer.core.edits.provider.activation import (acknowledge, activate_prepared, assert_provider_schema, mark_create_published,
                                                   prepare_create, query_prepared, recoveries)
from papeer.core.edits.provider.prepare_plan import prepare_new_provider_library
from sidecar.canonical_host import AuthorityError
from sidecar.errors import log
from sidecar.provider.publication import publish_retained_create
from sidecar.provider.owner import ProviderCommitUnknown


def _safe_error(exc: Exception) -> str:
    status = getattr(exc, 'status', None)
    if isinstance(status, int):
        return f'{type(exc).__name__}(status={status})'
    if isinstance(exc, (ValueError, AuthorityError)):
        return f'{type(exc).__name__}({str(exc)[:120]})'
    return type(exc).__name__


class ProviderCreateService:
    def __init__(self, operations, host):
        # The production composition owns both instances; no public route accepts
        # a verifier or callbacks from the renderer.
        self._operations, self._host = operations, host
        self._lock = threading.RLock()
        self._open_tokens = set()

    def _plan(self, owner, request_id):
        with owner.transaction('provider-read') as db:
            assert_provider_schema(db)
            row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
            return json.loads(row[0]) if row else None

    def prepare(self, owner_token, authorization, lease, title, request_id):
        with self._lock:
            owner = self._operations.resolve(owner_token, authorization, lease)
            prior = self._plan(owner, request_id)
            if prior:
                if prior['intent']['action'] != 'create' or prior['title'] != title.strip() or prior['principalDigest'] != owner.principal_digest:
                    raise ValueError('provider-request-reused')
                return self.query(owner_token, authorization, lease, request_id)
            with owner.provider_guard(self._host):
                allocated = self._host.allocate_file_ids(4)
            if len(allocated) != 4 or len(set(allocated)) != 4: raise ValueError('provider-allocation-invalid')
            ids = dict(zip(('folderId', 'checkpointFileId', 'manifestFileId', 'descriptorFileId'), allocated, strict=True))
            with owner.transaction('provider-read') as db:
                row = db.execute('SELECT payload FROM canonical_peers WHERE account=?', (owner.namespace,)).fetchone()
                peer = json.loads(row[0]) if row else None
            common = {'ownerNamespace': owner.namespace, 'principalDigest': owner.principal_digest, 'requestId': request_id, 'peer': peer}
            plan = prepare_new_provider_library(common, title, ids)
            return prepare_create(owner, plan)

    def execute(self, owner_token, authorization, lease, request_id):
        with self._lock:
            owner = self._operations.resolve(owner_token, authorization, lease)
            plan = self._plan(owner, request_id)
            if not plan or plan['intent']['action'] != 'create': raise ValueError('provider-plan-missing')
            freshly_published = plan['binding'] is None
            if freshly_published:
                try:
                    publish_retained_create(owner, self._host, request_id)
                except Exception as exc:  # noqa: BLE001 - preserve unknown outcome or complete cleanup
                    # Any remote attempt may have completed despite a lost reply.
                    log.warning('provider create publish failed: %s', _safe_error(exc))
                    return {'requestId': request_id, 'status': 'unknown'}
            selected_token = None
            for attempt in range(3):
                try:
                    selected_token = self._operations.capture_descriptor(authorization, lease, plan['descriptor']['id'])
                    break
                except Exception as exc:  # noqa: BLE001 - preserve unknown outcome or complete cleanup
                    if freshly_published and attempt < 2 and isinstance(exc, ValueError) and str(exc) == 'drive-descriptor-version-changed':
                        time.sleep(0.35)
                        continue
                    log.warning('provider create capture_descriptor failed: %s', _safe_error(exc))
                    return {'requestId': request_id, 'status': 'unknown'}
            assert selected_token is not None
            try:
                selected = self._operations.resolve(selected_token, authorization, lease)
                if selected.principal_digest != owner.principal_digest: raise ValueError('provider-principal-changed')
                evidence = selected.live_evidence()
                if plan['binding'] is None:
                    plan['binding'] = {'version': 1, 'id': plan['intent']['bindingId'], 'provider': 'google-drive',
                        'principalDigest': owner.principal_digest, 'scope': plan['intent']['scope'], 'descriptorId': plan['descriptor']['id'],
                        'descriptorVersion': evidence['descriptorVersion'], 'descriptorSha256': plan['descriptor']['sha256'], 'state': 'preparing'}
                    plan['intent']['phase'] = 'published'
                    try:
                        mark_create_published(selected, plan)
                    except ProviderCommitUnknown:
                        return {'requestId': request_id, 'status': 'unknown'}
                try:
                    return activate_prepared(selected, request_id)
                except ProviderCommitUnknown:
                    return {'requestId': request_id, 'status': 'unknown'}
            finally:
                self._operations.revoke(selected_token)

    def query(self, owner_token, authorization, lease, request_id):
        owner = self._operations.resolve(owner_token, authorization, lease)
        plan = self._plan(owner, request_id)
        if not plan: return {'status': 'not-found', 'requestId': request_id}
        if plan['principalDigest'] != owner.principal_digest: raise ValueError('provider-principal-changed')
        if plan['binding'] is None: return query_prepared(owner, request_id)
        token = self._operations.capture_descriptor(authorization, lease, plan['descriptor']['id'])
        try:
            selected = self._operations.resolve(token, authorization, lease)
            if selected.principal_digest != owner.principal_digest: raise ValueError('provider-principal-changed')
            return query_prepared(selected, request_id)
        finally:
            self._operations.revoke(token)

    def recoveries(self, owner_token, authorization, lease):
        owner = self._operations.resolve(owner_token, authorization, lease)
        tokens = []
        def select(descriptor_id):
            token = self._operations.capture_descriptor(authorization, lease, descriptor_id)
            tokens.append(token)
            return self._operations.resolve(token, authorization, lease)
        try:
            return recoveries(owner, select)
        finally:
            for token in tokens: self._operations.revoke(token)

    def acknowledge(self, owner_token, authorization, lease, request_id):
        owner = self._operations.resolve(owner_token, authorization, lease)
        plan = self._plan(owner, request_id)
        if not plan or plan['binding'] is None or plan['principalDigest'] != owner.principal_digest: raise ValueError('provider-plan-missing')
        token = self._operations.capture_descriptor(authorization, lease, plan['descriptor']['id'])
        try:
            selected = self._operations.resolve(token, authorization, lease)
            if selected.principal_digest != owner.principal_digest: raise ValueError('provider-principal-changed')
            acknowledge(selected, request_id)
        finally:
            self._operations.revoke(token)

    def open_installed(self, owner_token, authorization, lease, request_id):
        owner = self._operations.resolve(owner_token, authorization, lease)
        plan = self._plan(owner, request_id)
        if not plan or plan['binding'] is None or plan['principalDigest'] != owner.principal_digest: raise ValueError('provider-plan-missing')
        token = self._operations.capture_descriptor(authorization, lease, plan['descriptor']['id'])
        try:
            selected = self._operations.resolve(token, authorization, lease)
            if selected.principal_digest != owner.principal_digest or query_prepared(selected, request_id)['status'] != 'accepted':
                raise ValueError('provider-plan-not-accepted')
            handle = selected._registry.provider_handle(authorization, lease, selected, plan['intent']['scope'])
            with self._lock: self._open_tokens.add(token)
            return {'leaseId': lease, 'handleId': handle, 'requestId': request_id}
        except Exception:
            self._operations.revoke(token)
            raise

    def open_selected(self, owner_token, authorization, lease, descriptor_id):
        owner = self._operations.resolve(owner_token, authorization, lease)
        token = self._operations.capture_descriptor(authorization, lease, descriptor_id)
        try:
            selected = self._operations.resolve(token, authorization, lease)
            if selected.principal_digest != owner.principal_digest: raise ValueError('provider-principal-changed')
            evidence = selected.live_evidence()
            with owner.transaction('provider-read') as db:
                assert_provider_schema(db)
                rows = db.execute("SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id NOT LIKE 'transfer:%'", (owner.namespace,)).fetchall()
            matching = []
            for (raw,) in rows:
                plan = json.loads(raw); binding = plan.get('binding')
                if (plan['principalDigest'] == owner.principal_digest and binding is not None
                        and binding['descriptorId'] == evidence['descriptorId'] and binding['descriptorVersion'] == evidence['descriptorVersion']
                        and binding['descriptorSha256'] == evidence['descriptorSha256']):
                    matching.append(plan)
            if len(matching) > 1: raise ValueError('provider-selection-ambiguous')
            if not matching: return None
            if query_prepared(selected, matching[0]['requestId'])['status'] != 'accepted': return None
            return self.open_installed(owner_token, authorization, lease, matching[0]['requestId'])
        finally:
            self._operations.revoke(token)

    def close(self):
        with self._lock:
            tokens, self._open_tokens = self._open_tokens, set()
        for token in tokens: self._operations.revoke(token)
