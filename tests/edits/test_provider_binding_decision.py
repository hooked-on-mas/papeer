import uuid
import pytest

from papeer.core.edits.provider_binding_decision import (assert_live_provider_binding, assert_provider_intent_retry,
                                                   assert_provider_plan)


def new_id():
    return str(uuid.uuid4())


def fixture():
    scope = {'accountId': new_id(), 'libraryId': new_id(), 'epoch': new_id()}
    digest, principal = 'a' * 64, 'b' * 64
    descriptor = {'version': 1, 'scope': scope, 'manifestId': new_id(), 'checkpointSha256': digest}
    binding = {'version': 1, 'id': new_id(), 'provider': 'google-drive', 'principalDigest': principal,
               'scope': scope, 'descriptorId': 'opaque-provider-object', 'descriptorVersion': 'version-1',
               'descriptorSha256': digest, 'state': 'active'}
    intent = {'version': 1, 'requestId': new_id(), 'bindingId': binding['id'], 'action': 'join', 'scope': scope,
              'requestSha256': digest, 'descriptorObjectId': new_id(), 'descriptorSha256': digest,
              'manifestId': descriptor['manifestId'], 'checkpointObjectId': new_id(), 'checkpointSha256': digest,
              'peerId': new_id(), 'phase': 'prepared'}
    evidence = {'principalDigest': principal, 'descriptorId': binding['descriptorId'],
                'descriptorVersion': binding['descriptorVersion'], 'descriptorSha256': digest,
                'owner': True, 'readable': True, 'writable': True}
    return binding, descriptor, intent, evidence


def test_owner_write_and_live_principal_are_required():
    binding, descriptor, intent, evidence = fixture()
    assert binding['scope']['accountId'] != evidence['principalDigest']
    assert_live_provider_binding(binding, descriptor, evidence); assert_provider_plan(binding, descriptor, intent)
    for key in ('owner', 'readable', 'writable'):
        with pytest.raises(ValueError, match='provider-owner-write-required'):
            assert_live_provider_binding(binding, descriptor, {**evidence, key: False})
    with pytest.raises(ValueError, match='provider-principal-changed'):
        assert_live_provider_binding(binding, descriptor, {**evidence, 'principalDigest': 'c' * 64})
    with pytest.raises(ValueError, match='provider-descriptor-changed'):
        assert_live_provider_binding(binding, descriptor, {**evidence, 'descriptorVersion': 'changed'})
    with pytest.raises(ValueError, match='provider-binding-inactive'):
        assert_live_provider_binding({**binding, 'state': 'revoked'}, descriptor, evidence)
    with pytest.raises(ValueError, match='provider-binding-inactive'):
        assert_provider_plan({**binding, 'state': 'revoked'}, descriptor, intent)
    with pytest.raises(ValueError, match='provider-plan-mismatch'):
        assert_provider_plan(binding, {**descriptor, 'scope': {**descriptor['scope'], 'epoch': new_id()}}, intent)


def test_retry_is_immutable_and_rejection_needs_proof():
    _, _, intent, _ = fixture()
    assert_provider_intent_retry(intent, {**intent, 'phase': 'published'})
    with pytest.raises(ValueError, match='provider-request-reused'):
        assert_provider_intent_retry(intent, {**intent, 'manifestId': new_id()})
    with pytest.raises(ValueError, match='provider-intent-phase'):
        assert_provider_intent_retry(intent, {**intent, 'phase': 'activated'})
    with pytest.raises(ValueError, match='provider-rejection-unproven'):
        assert_provider_intent_retry(intent, {**intent, 'phase': 'rejected'})
    assert_provider_intent_retry(intent, {**intent, 'phase': 'rejected'}, 'proven-rejected')
