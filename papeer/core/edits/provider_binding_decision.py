"""Pure provider binding decisions. A verified host issuer supplies live evidence."""
from papeer.core.edit_contracts import (validate_canonicalproviderbinding, validate_canonicalproviderdescriptor,
                                        validate_canonicalproviderintent)
from papeer.core.edit_model import canonical_json, reject


def assert_live_provider_binding(binding, descriptor, evidence):
    validate_canonicalproviderbinding(binding); validate_canonicalproviderdescriptor(descriptor)
    if binding['state'] != 'active': reject('provider-binding-inactive')
    if not all(evidence.get(key) is True for key in ('owner', 'readable', 'writable')): reject('provider-owner-write-required')
    if binding['principalDigest'] != evidence.get('principalDigest'): reject('provider-principal-changed')
    if any(binding[key] != evidence.get(key) for key in ('descriptorId', 'descriptorVersion', 'descriptorSha256')):
        reject('provider-descriptor-changed')
    if canonical_json(binding['scope']) != canonical_json(descriptor['scope']): reject('provider-scope-mismatch')


def assert_provider_plan(binding, descriptor, intent):
    validate_canonicalproviderbinding(binding); validate_canonicalproviderdescriptor(descriptor); validate_canonicalproviderintent(intent)
    if binding['state'] == 'revoked': reject('provider-binding-inactive')
    if (binding['id'] != intent['bindingId'] or canonical_json(binding['scope']) != canonical_json(intent['scope'])
            or canonical_json(descriptor['scope']) != canonical_json(intent['scope'])
            or binding['descriptorSha256'] != intent['descriptorSha256'] or descriptor['manifestId'] != intent['manifestId']
            or descriptor['checkpointSha256'] != intent['checkpointSha256']): reject('provider-plan-mismatch')
    if len({intent[key] for key in ('requestId', 'bindingId', 'manifestId', 'checkpointObjectId', 'descriptorObjectId', 'peerId')}) != 6:
        reject('provider-id-reused')


def assert_provider_intent_retry(before, after, evidence='none'):
    validate_canonicalproviderintent(before); validate_canonicalproviderintent(after)
    previous = {key: value for key, value in before.items() if key != 'phase'}
    following = {key: value for key, value in after.items() if key != 'phase'}
    if canonical_json(previous) != canonical_json(following): reject('provider-request-reused')
    allowed = {'prepared': ('prepared', 'published', 'rejected'), 'published': ('published', 'activated', 'rejected'),
               'activated': ('activated',), 'rejected': ('rejected',)}
    if after['phase'] not in allowed[before['phase']]: reject('provider-intent-phase')
    if after['phase'] == 'rejected' and before['phase'] != 'rejected' and evidence != 'proven-rejected': reject('provider-rejection-unproven')
