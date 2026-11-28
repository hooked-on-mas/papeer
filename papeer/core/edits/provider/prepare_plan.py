"""Native host construction of the shared immutable provider owner plan."""
from copy import deepcopy
import hashlib
from uuid import uuid4

from papeer.core.edit_model import canonical_json
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.edits.provider.activation import _commitment, _digest


def _id():
    return str(uuid4())


def scope_namespace(scope):
    value = canonical_json([scope['accountId'], scope['libraryId'], scope['epoch']])
    return hashlib.sha256(value.encode('utf8')).hexdigest()


def _intent(common, action, publication, descriptor_sha, make_id):
    scope = publication['manifest']['scope']
    peer = common.get('peer')
    if peer and peer['accountId'] != scope['accountId']: raise ValueError('provider-peer-scope')
    return {'version': 1, 'requestId': common['requestId'], 'bindingId': make_id(), 'action': action,
            'scope': deepcopy(scope), 'requestSha256': '', 'descriptorObjectId': make_id(),
            'descriptorSha256': descriptor_sha, 'manifestId': publication['manifest']['id'],
            'checkpointObjectId': publication['checkpointObjectId'], 'checkpointSha256': publication['manifest']['checkpointSha256'],
            'peerId': peer['peerId'] if peer else make_id(), 'phase': 'prepared'}


def _activation_ids(make_id):
    return {'preparedControlId': make_id(), 'publishedControlId': make_id(), 'activeControlId': make_id(), 'profileRevision': make_id()}


def _finish(plan):
    plan['intent']['requestSha256'] = _digest(_commitment(plan))
    return deepcopy(plan)


def prepare_new_provider_library(common, title, provider_ids, make_id=_id):
    scope = {'accountId': common['ownerNamespace'], 'libraryId': make_id(), 'epoch': make_id()}
    checkpoint = {'version': 1, 'libraryId': scope['libraryId'], 'roots': [{'kind': 'library', 'id': scope['libraryId'],
                  'version': make_id(), 'items': [], 'folders': [], 'links': [], 'deletions': []}], 'edits': []}
    manifest = {'version': 1, 'id': make_id(), 'scope': scope, 'checkpointSha256': checkpoint_hash(checkpoint), 'resources': []}
    publication = {'manifest': manifest, 'checkpoint': checkpoint, 'checkpointObjectId': make_id()}
    descriptor = {'version': 1, 'scope': scope, 'manifestId': manifest['id'], 'checkpointSha256': manifest['checkpointSha256']}
    raw = canonical_json(descriptor).encode('utf8'); sha = hashlib.sha256(raw).hexdigest()
    intent = _intent(common, 'create', publication, sha, make_id)
    return _finish({'ownerNamespace': common['ownerNamespace'], 'requestId': common['requestId'], 'title': title.strip(),
                    'folderId': provider_ids['folderId'], 'principalDigest': common['principalDigest'],
                    'descriptor': {'id': provider_ids['descriptorFileId'], 'version': None, 'sha256': sha},
                    'descriptorBytesHex': raw.hex(), 'publication': publication, 'resources': [],
                    'activationIds': _activation_ids(make_id), 'createObjects': {'folderObjectId': make_id(), **provider_ids},
                    'binding': None, 'intent': intent})


def prepare_joined_provider_library(common, title, folder_id, descriptor, descriptor_bytes, publication, make_id=_id):
    publication = deepcopy(publication); descriptor = deepcopy(descriptor)
    intent = _intent(common, 'join', publication, descriptor['sha256'], make_id)
    binding = {'version': 1, 'id': intent['bindingId'], 'provider': 'google-drive', 'principalDigest': common['principalDigest'],
               'scope': deepcopy(intent['scope']), 'descriptorId': descriptor['id'], 'descriptorVersion': descriptor['version'],
               'descriptorSha256': descriptor['sha256'], 'state': 'preparing'}
    resources = [{'metadata': deepcopy(metadata), 'stagingKey': canonical_json([common['ownerNamespace'], common['requestId'], 'resource', metadata['id']])}
                 for metadata in publication['manifest']['resources']]
    return _finish({'ownerNamespace': common['ownerNamespace'], 'requestId': common['requestId'], 'title': title,
                    'folderId': folder_id, 'principalDigest': common['principalDigest'], 'descriptor': descriptor,
                    'descriptorBytesHex': bytes(descriptor_bytes).hex(), 'publication': publication, 'resources': resources,
                    'activationIds': _activation_ids(make_id), 'createObjects': None, 'binding': binding, 'intent': intent})
