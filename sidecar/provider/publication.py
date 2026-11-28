"""Resume the fixed host's retained CREATE; no renderer-supplied plan or bytes."""
import json

from papeer.core.edits.provider.activation import _check_create_prepared, assert_provider_schema
from papeer.core.edits.provider.prepare_plan import scope_namespace


def publish_retained_create(owner, host, request_id):
    with owner.transaction('provider-read') as db:
        assert_provider_schema(db)
        row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        if not row: raise ValueError('provider-plan-missing')
        plan = _check_create_prepared(json.loads(row[0]), owner)
    if plan['requestId'] != request_id: raise ValueError('provider-request-mismatch')
    objects, publication, intent = plan['createObjects'], plan['publication'], plan['intent']
    namespace = scope_namespace(intent['scope'])
    # Retained Drive IDs are reused on every attempt. The host methods verify an
    # existing 409 object byte-for-byte and reject any conflicting object.
    with owner.provider_guard(host):
        host.create_folder(objects['folderId'], objects['folderObjectId'], plan['title'])
        host.write_immutable_json(objects['checkpointFileId'], namespace, objects['folderId'], intent['checkpointObjectId'],
                                  'repository-checkpoint', {'kind': 'repository-checkpoint', 'checkpoint': publication['checkpoint']})
        host.write_immutable_json(objects['manifestFileId'], namespace, objects['folderId'], intent['manifestId'],
                                  'dataset-manifest', {'kind': 'dataset-manifest', 'manifest': publication['manifest']})
        host.write_descriptor(objects['descriptorFileId'], intent['descriptorObjectId'], objects['folderId'],
                              plan['title'], bytes.fromhex(plan['descriptorBytesHex']), namespace)
    return {'requestId': request_id, 'descriptorId': objects['descriptorFileId']}
