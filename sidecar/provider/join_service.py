"""Host-only JOIN: fetch the verified published dataset before staging."""
import json
import threading
from uuid import uuid4

from papeer.core.edits.provider.activation import mark_join_published, prepare_join, activate_prepared
from papeer.core.edits.provider.prepare_plan import prepare_joined_provider_library
from sidecar.provider.owner import ProviderCommitUnknown


class ProviderJoinService:
    def __init__(self, operations, host, create_service):
        self._operations, self._host, self._create = operations, host, create_service
        self._lock = threading.RLock()

    def prepare(self, owner_token, authorization, lease, descriptor_id, request_id):
        with self._lock:
            owner = self._operations.resolve(owner_token, authorization, lease)
            prior = self._create._plan(owner, request_id)
            if prior:
                if (prior['intent']['action'] != 'join' or prior['principalDigest'] != owner.principal_digest
                        or prior['descriptor']['id'] != descriptor_id): raise ValueError('provider-request-reused')
                return self._create.query(owner_token, authorization, lease, request_id)
            token = self._operations.capture_descriptor(authorization, lease, descriptor_id)
            try:
                selected = self._operations.resolve(token, authorization, lease)
                if selected.principal_digest != owner.principal_digest: raise ValueError('provider-principal-changed')
                evidence, descriptor = selected.live_evidence(), selected.descriptor()
                dataset = self._host.dataset_storage(selected).read_published_dataset()
                selected.assert_current()
                with owner.transaction('provider-read') as db:
                    row = db.execute('SELECT payload FROM canonical_peers WHERE account=?', (descriptor['scope']['accountId'],)).fetchone()
                    peer = json.loads(row[0]) if row else None
                common = {'ownerNamespace': owner.namespace, 'principalDigest': owner.principal_digest, 'requestId': request_id, 'peer': peer}
                summary = {'id': evidence['descriptorId'], 'version': evidence['descriptorVersion'], 'sha256': evidence['descriptorSha256']}
                raw = self._host.descriptor_bytes(selected._principal, descriptor_id)
                publication = {'manifest': dataset['manifest'], 'checkpoint': dataset['checkpoint'], 'checkpointObjectId': str(uuid4())}
                plan = prepare_joined_provider_library(common, selected.display_title(), evidence['folderId'], summary, raw, publication)
                resources = {resource['metadata']['id']: resource['bytes'] for resource in dataset['resources']}
                return prepare_join(selected, plan, resources)
            finally:
                self._operations.revoke(token)

    def execute(self, owner_token, authorization, lease, request_id):
        with self._lock:
            owner = self._operations.resolve(owner_token, authorization, lease)
            plan = self._create._plan(owner, request_id)
            if not plan or plan['intent']['action'] != 'join' or plan['principalDigest'] != owner.principal_digest: raise ValueError('provider-plan-missing')
            token = self._operations.capture_descriptor(authorization, lease, plan['descriptor']['id'])
            try:
                selected = self._operations.resolve(token, authorization, lease)
                if selected.principal_digest != owner.principal_digest: raise ValueError('provider-principal-changed')
                plan['intent']['phase'] = 'published'
                try:
                    mark_join_published(selected, plan)
                    return activate_prepared(selected, request_id)
                except ProviderCommitUnknown:
                    return {'requestId': request_id, 'status': 'unknown'}
            finally:
                self._operations.revoke(token)
