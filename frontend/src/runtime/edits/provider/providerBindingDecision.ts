import { validateCanonicalProviderBinding, validateCanonicalProviderDescriptor, validateCanonicalProviderIntent,
  type CanonicalProviderBinding, type CanonicalProviderDescriptor, type CanonicalProviderIntent } from '../contracts.ts';
import { canonicalJson, EditRejected } from '../editModel.ts';

/** Supplied exclusively by the host after live provider identity, ownership and write-access inspection.
 * This plain data is an input to a pure decision, not an admission capability. */
export type LiveProviderEvidence = Readonly<{ principalDigest: string; descriptorId: string; descriptorVersion: string;
  descriptorSha256: string; owner: boolean; readable: boolean; writable: boolean }>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const reject = (reason: string): never => { throw new EditRejected(reason); };

/** The host must re-read provider and local authority evidence around the transaction. */
export function assertLiveProviderBinding(binding: CanonicalProviderBinding, descriptor: CanonicalProviderDescriptor,
  evidence: LiveProviderEvidence): void {
  validateCanonicalProviderBinding(binding); validateCanonicalProviderDescriptor(descriptor);
  if (binding.state !== 'active') reject('provider-binding-inactive');
  if (evidence.owner !== true || evidence.readable !== true || evidence.writable !== true) reject('provider-owner-write-required');
  if (binding.principalDigest !== evidence.principalDigest) reject('provider-principal-changed');
  if (binding.descriptorId !== evidence.descriptorId || binding.descriptorVersion !== evidence.descriptorVersion
    || binding.descriptorSha256 !== evidence.descriptorSha256) reject('provider-descriptor-changed');
  if (!same(binding.scope, descriptor.scope)) reject('provider-scope-mismatch');
}

export function assertProviderPlan(binding: CanonicalProviderBinding, descriptor: CanonicalProviderDescriptor,
  intent: CanonicalProviderIntent): void {
  validateCanonicalProviderBinding(binding); validateCanonicalProviderDescriptor(descriptor); validateCanonicalProviderIntent(intent);
  if (binding.state === 'revoked') reject('provider-binding-inactive');
  if (binding.id !== intent.bindingId || !same(binding.scope, intent.scope) || !same(descriptor.scope, intent.scope)
    || binding.descriptorSha256 !== intent.descriptorSha256 || descriptor.manifestId !== intent.manifestId
    || descriptor.checkpointSha256 !== intent.checkpointSha256) reject('provider-plan-mismatch');
  if (new Set([intent.requestId, intent.bindingId, intent.manifestId, intent.checkpointObjectId, intent.descriptorObjectId, intent.peerId]).size !== 6)
    reject('provider-id-reused');
}

/** Retry may advance a phase but cannot alter any identity or immutable request digest. */
export function assertProviderIntentRetry(before: CanonicalProviderIntent, after: CanonicalProviderIntent,
  evidence: 'none' | 'proven-rejected' = 'none'): void {
  validateCanonicalProviderIntent(before); validateCanonicalProviderIntent(after);
  const { phase: previousPhase, ...previous } = before, { phase: nextPhase, ...next } = after;
  if (!same(previous, next)) reject('provider-request-reused');
  const allowed: Record<CanonicalProviderIntent['phase'], readonly CanonicalProviderIntent['phase'][]> = {
    prepared: ['prepared', 'published', 'rejected'], published: ['published', 'activated', 'rejected'],
    activated: ['activated'], rejected: ['rejected'],
  };
  if (!allowed[previousPhase].includes(nextPhase)) reject('provider-intent-phase');
  if (nextPhase === 'rejected' && previousPhase !== 'rejected' && evidence !== 'proven-rejected') reject('provider-rejection-unproven');
}
