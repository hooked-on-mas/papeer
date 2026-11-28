import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLiveProviderBinding, assertProviderIntentRetry, assertProviderPlan } from '../../../src/runtime/edits/provider/providerBindingDecision.ts';
import type { CanonicalProviderBinding, CanonicalProviderDescriptor, CanonicalProviderIntent } from '../../../src/runtime/edits/contracts.ts';

const id = () => crypto.randomUUID();
function fixture() {
  const scope = { accountId: id(), libraryId: id(), epoch: id() }, hash = 'a'.repeat(64), principal = 'b'.repeat(64);
  const descriptor: CanonicalProviderDescriptor = { version: 1, scope, manifestId: id(), checkpointSha256: hash };
  const binding: CanonicalProviderBinding = { version: 1, id: id(), provider: 'google-drive', principalDigest: principal,
    scope, descriptorId: 'opaque-provider-object', descriptorVersion: 'version-1', descriptorSha256: hash, state: 'active' };
  const intent: CanonicalProviderIntent = { version: 1, requestId: id(), bindingId: binding.id, action: 'join', scope,
    requestSha256: hash, descriptorObjectId: id(), descriptorSha256: hash, manifestId: descriptor.manifestId,
    checkpointObjectId: id(), checkpointSha256: hash, peerId: id(), phase: 'prepared' };
  const evidence = { principalDigest: principal, descriptorId: binding.descriptorId, descriptorVersion: binding.descriptorVersion,
    descriptorSha256: hash, owner: true, readable: true, writable: true };
  return { binding, descriptor, intent, evidence };
}

test('live owner/write evidence and separate logical scope are required', () => {
  const { binding, descriptor, intent, evidence } = fixture();
  assert.notEqual(binding.scope.accountId, evidence.principalDigest);
  assert.doesNotThrow(() => assertLiveProviderBinding(binding, descriptor, evidence));
  assert.doesNotThrow(() => assertProviderPlan(binding, descriptor, intent));
  for (const change of [{ owner: false }, { readable: false }, { writable: false }])
    assert.throws(() => assertLiveProviderBinding(binding, descriptor, { ...evidence, ...change }), /provider-owner-write-required/);
  assert.throws(() => assertLiveProviderBinding(binding, descriptor, { ...evidence, principalDigest: 'c'.repeat(64) }), /provider-principal-changed/);
  assert.throws(() => assertLiveProviderBinding(binding, descriptor, { ...evidence, descriptorVersion: 'changed' }), /provider-descriptor-changed/);
  assert.throws(() => assertLiveProviderBinding({ ...binding, state: 'revoked' }, descriptor, evidence), /provider-binding-inactive/);
  assert.throws(() => assertProviderPlan({ ...binding, state: 'revoked' }, descriptor, intent), /provider-binding-inactive/);
  assert.throws(() => assertProviderPlan(binding, { ...descriptor, scope: { ...descriptor.scope, epoch: id() } }, intent), /provider-plan-mismatch/);
});

test('lost-response retry preserves immutable IDs and can only advance allowed phases', () => {
  const { intent } = fixture();
  assert.doesNotThrow(() => assertProviderIntentRetry(intent, { ...intent, phase: 'published' }));
  assert.throws(() => assertProviderIntentRetry(intent, { ...intent, manifestId: id() }), /provider-request-reused/);
  assert.throws(() => assertProviderIntentRetry(intent, { ...intent, phase: 'activated' }), /provider-intent-phase/);
  assert.throws(() => assertProviderIntentRetry({ ...intent, phase: 'activated' }, { ...intent, phase: 'published' }), /provider-intent-phase/);
  assert.throws(() => assertProviderIntentRetry(intent, { ...intent, phase: 'rejected' }), /provider-rejection-unproven/);
  assert.doesNotThrow(() => assertProviderIntentRetry(intent, { ...intent, phase: 'rejected' }, 'proven-rejected'));
});
