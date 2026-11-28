"""Strict local revalidation of the exact provider activation enrolled while live."""
import hashlib
import json
from copy import deepcopy
from papeer.core.edit_model import canonical_json
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edits.provider.activation import assert_provider_schema, _check_plan
from sidecar.canonical_host import _proof, _current_grant
from .crypto import identifier, digest, fail
from papeer.core.edit_contracts import validate_canonicalproviderbinding
import re


def selector_from_proof(grant, proof):
    return {'ownerNamespace': grant['namespaceId'], 'requestId': proof['control']['transition']['id'],
            'scope': deepcopy(proof['scope']), 'binding': deepcopy(proof['providerBinding']),
            'manifestId': proof['manifest']['id'], 'checkpointSha256': proof['manifest']['checkpointSha256']}


def identity(context, value):
    return canonical_json([context, value['scope']['accountId'], value['scope']['libraryId'], value['scope']['epoch'], value['binding']['id']])


def current_proof(db, context, value):
    """Small current authorization footprint, with no historical resource I/O.

    A host-held session compares this exact proof before/after each transaction.
    Historical activation artifacts are verified at unlock, not every edit.
    """
    if (type(value) is not dict or set(value) != {'ownerNamespace', 'requestId', 'scope', 'binding', 'manifestId', 'checkpointSha256'}): fail()
    identifier(context); identifier(value['requestId']); identifier(value['ownerNamespace'])
    grant = _current_grant(db)
    if context != grant['contextId'] or value['ownerNamespace'] != grant['namespaceId']: fail()
    scope = value['scope']
    assert_provider_schema(db)
    actual = _proof(db, scope['accountId'], scope['libraryId'], allow_provider=True)
    binding_row = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?',
                             (grant['namespaceId'], canonical_json([scope['accountId'], scope['libraryId']]))).fetchone()
    if not binding_row: fail()
    binding = json.loads(binding_row[0])
    if (binding != value['binding'] or binding['state'] != 'active' or binding['scope'] != scope
            or actual['scope'] != scope or actual['manifest']['id'] != value['manifestId']
            or actual['manifest']['checkpointSha256'] != value['checkpointSha256']
            or actual['control']['transition']['id'] != value['requestId']): fail()
    return actual | {'providerBinding': binding}


def read(db, context, value):
    """Full strict cold validation, including both staged and used resource bytes."""
    proof = current_proof(db, context, value)
    grant = _current_grant(db)
    scope = value['scope']; owner = grant['namespaceId']; request = value['requestId']
    actual = {key: item for key, item in proof.items() if key != 'providerBinding'}
    binding = proof['providerBinding']
    artifact = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner, request)).fetchone()
    intent = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner, request)).fetchone()
    if not artifact or not intent: fail()
    plan, saved_intent = json.loads(artifact[0]), json.loads(intent[0])
    evidence = {'principalDigest': binding['principalDigest'], 'descriptorId': binding['descriptorId'],
                'descriptorVersion': binding['descriptorVersion'], 'descriptorSha256': binding['descriptorSha256'],
                'owner': True, 'readable': True, 'writable': True, 'folderId': actual['profile']['remote']['folderId']}
    checked, descriptor, profile, control, peer = _check_plan(plan, evidence, allow_prepared=True)
    if (checked['ownerNamespace'] != owner or checked['requestId'] != request or checked['binding'] | {'state': 'active'} != binding
            or saved_intent != checked['intent'] | {'phase': 'activated'} or actual['profile'] != profile
            or actual['control'] != control or actual['peer'] != peer or actual['manifest'] != checked['publication']['manifest']): fail()
    namespace = canonical_json([scope['accountId'], scope['libraryId'], scope['epoch']])
    checkpoint = checked['publication']['manifest']['checkpointSha256']
    if not db.execute('SELECT 1 FROM edit_checkpoints WHERE scope=? AND sha256=?', (namespace, checkpoint)).fetchone(): fail()
    resources = []
    for resource in checked['resources']:
        metadata = resource['metadata']
        row = db.execute('SELECT payload FROM canonical_provider_resource_bytes WHERE owner=? AND request_id=? AND resource_id=?', (owner, request, metadata['id'])).fetchone()
        if not row or type(row[0]) is not bytes or len(row[0]) != metadata['byteLength'] or hashlib.sha256(row[0]).hexdigest() != metadata['sha256']: fail()
        resources.append({'id': metadata['id'], 'bytes': row[0]})
    repository = SqliteEditRepository.__new__(SqliteEditRepository)
    repository.scope, repository.namespace, repository.identity = scope, namespace, canonical_json([scope['accountId'], scope['libraryId']])
    repository._verify_dataset_resources(db, checked['publication']['manifest'])
    proof = actual | {'providerBinding': binding}
    material = {'localGrant': grant, 'selector': value, 'proof': proof, 'plan': checked, 'intent': saved_intent,
                'descriptorBytes': bytes.fromhex(checked['descriptorBytesHex']), 'resources': resources,
                'initialCheckpointMarker': [namespace, checkpoint]}
    return proof, digest(material)


def reclaim_identity(context, selector):
    """Validate a decrypted old selector without authorizing its historical scope."""
    if type(selector) is not dict or set(selector) != {'ownerNamespace', 'requestId', 'scope', 'binding', 'manifestId', 'checkpointSha256'}: fail()
    identifier(context); identifier(selector['ownerNamespace']); identifier(selector['requestId']); identifier(selector['manifestId'])
    validate_canonicalproviderbinding(selector['binding'])
    binding = selector['binding']
    if (binding['scope'] != selector['scope'] or binding['state'] != 'active'
            or type(selector['checkpointSha256']) is not str or not re.fullmatch('[0-9a-f]{64}', selector['checkpointSha256'])): fail()
    return canonical_json([context, selector['ownerNamespace'], selector['scope']['accountId'],
                           selector['scope']['libraryId'], binding['principalDigest']])
