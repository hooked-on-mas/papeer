import type { CanonicalDevicePeer, CanonicalLibraryProfile, CanonicalProviderBinding, CanonicalProviderIntent,
  DatasetControlRecord, DatasetPublication, ResourceMetadata } from '../contracts.ts';
import { validateCanonicalDevicePeer, validateCanonicalProviderBinding, validateCanonicalProviderIntent } from '../contracts.ts';
import { assertCanonicalProfile } from '../canonicalBootstrap.ts';
import { assertDatasetControlPlan, assertEmptyInitialPublication } from '../datasetControl.ts';
import { assertDatasetCheckpoint } from '../datasetManifest.ts';
import { canonicalJson } from '../editModel.ts';
import { resourceHash } from '../contentPublication.ts';
import { readProviderDescriptorBytes } from './providerDescriptorBytes.ts';
import { EDIT_LIMITS } from '../contracts.ts';
import { pyStrip } from '../../../lib/pyWhitespace.ts';

export type ProviderResourceReference = { metadata: ResourceMetadata; stagingKey: string };
export type ProviderActivationIds = {
  preparedControlId: string; publishedControlId: string; activeControlId: string; profileRevision: string;
};
/** Opaque Google IDs allocated before the first create POST, not canonical/logical UUIDs. */
export type ProviderCreateObjects = {
  folderObjectId: string; folderId: string; checkpointFileId: string; manifestFileId: string; descriptorFileId: string;
};
/** Host-local retained artifact. Binding is observed output, not part of the immutable request.
 * CREATE has no real remote descriptor version before publication, so it stores null, never a fake version.
 */
export type ProviderOwnerPlan = {
  ownerNamespace: string;
  requestId: string;
  title: string;
  folderId: string;
  principalDigest: string;
  descriptor: { id: string; version: string | null; sha256: string };
  descriptorBytes: Uint8Array;
  publication: DatasetPublication;
  resources: ProviderResourceReference[];
  activationIds: ProviderActivationIds;
  createObjects: ProviderCreateObjects | null;
  binding: CanonicalProviderBinding | null;
  intent: CanonicalProviderIntent;
  /** UI acknowledgement only; excluded from the immutable request and all authority decisions. */
  acknowledged?: boolean;
};

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const driveId = /^[A-Za-z0-9_-]+$/;

/** Exact JSON commitment shared with Native. Excludes phase, observed binding/version and raw staged bytes.
 * descriptor.version is a fixed expected version for JOIN, null for CREATE. A later observed CREATE
 * version belongs in binding and must be reverified against Google before activation/admission.
 */
export function providerOwnerCommitment(plan: ProviderOwnerPlan) {
  const { phase: _phase, requestSha256: _digest, ...intentIdentity } = plan.intent;
  return {
    ownerNamespace: plan.ownerNamespace, requestId: plan.requestId, title: plan.title, folderId: plan.folderId,
    principalDigest: plan.principalDigest, descriptor: plan.descriptor, publication: plan.publication,
    resources: plan.resources, activationIds: plan.activationIds, createObjects: plan.createObjects,
    intent: intentIdentity,
  };
}

export async function providerOwnerRequestSha256(plan: ProviderOwnerPlan): Promise<string> {
  return resourceHash(new TextEncoder().encode(canonicalJson(providerOwnerCommitment(plan))));
}

/** Data validation only. Calling this cannot create a provider grant or local admission. */
export async function assertProviderOwnerPlan(plan: ProviderOwnerPlan): Promise<void> {
  validateCanonicalProviderIntent(plan.intent);
  const { manifest, checkpoint, checkpointObjectId } = plan.publication, scope = manifest.scope;
  const intent = plan.intent;
  if (!uuid.test(plan.ownerNamespace) || plan.requestId !== intent.requestId || !pyStrip(plan.title)
    || plan.title !== pyStrip(plan.title) || Array.from(plan.title).length > EDIT_LIMITS.title || !driveId.test(plan.folderId)
    || !/^[0-9a-f]{64}$/.test(plan.principalDigest) || !driveId.test(plan.descriptor.id)
    || plan.descriptor.sha256 !== intent.descriptorSha256 || !same(scope, intent.scope)
    || manifest.id !== intent.manifestId || manifest.checkpointSha256 !== intent.checkpointSha256
    || checkpointObjectId !== intent.checkpointObjectId) throw new Error('provider-owner-plan-invalid');
  const ids = [...Object.values(plan.activationIds), intent.requestId, intent.bindingId, intent.manifestId,
    intent.checkpointObjectId, intent.descriptorObjectId, intent.peerId];
  if (ids.some(id => !uuid.test(id)) || new Set(ids).size !== ids.length) throw new Error('provider-owner-id-reused');
  if (intent.action === 'create') {
    const objects = plan.createObjects;
    if (!objects || !uuid.test(objects.folderObjectId) || ids.includes(objects.folderObjectId)
      || [objects.folderId, objects.checkpointFileId, objects.manifestFileId, objects.descriptorFileId].some(id => !driveId.test(id))
      || new Set([objects.folderId, objects.checkpointFileId, objects.manifestFileId, objects.descriptorFileId]).size !== 4
      || objects.folderId !== plan.folderId || objects.descriptorFileId !== plan.descriptor.id
      || plan.descriptor.version !== null) throw new Error('provider-create-objects-invalid');
    assertEmptyInitialPublication(plan.publication);
  } else if (plan.createObjects !== null || !plan.descriptor.version) throw new Error('provider-join-descriptor-invalid');
  const checked = await readProviderDescriptorBytes(plan.descriptorBytes, plan.descriptor.sha256, scope);
  if (checked.descriptor.manifestId !== manifest.id || checked.descriptor.checkpointSha256 !== manifest.checkpointSha256)
    throw new Error('provider-publication-descriptor-mismatch');
  await assertDatasetCheckpoint(manifest, checkpoint, scope);
  if (!same(plan.resources.map(row => row.metadata), manifest.resources)
    || plan.resources.some(row => row.stagingKey !== JSON.stringify([plan.ownerNamespace, plan.requestId, 'resource', row.metadata.id])))
    throw new Error('provider-staging-invalid');
  if (await providerOwnerRequestSha256(plan) !== intent.requestSha256) throw new Error('provider-request-digest-invalid');
  if (plan.binding) {
    validateCanonicalProviderBinding(plan.binding);
    if (plan.binding.id !== intent.bindingId || plan.binding.principalDigest !== plan.principalDigest
      || !same(plan.binding.scope, scope) || plan.binding.descriptorId !== plan.descriptor.id
      || plan.binding.descriptorSha256 !== plan.descriptor.sha256 || !plan.binding.descriptorVersion
      || (plan.descriptor.version !== null && plan.binding.descriptorVersion !== plan.descriptor.version))
      throw new Error('provider-binding-plan-mismatch');
  } else if (intent.action !== 'create' || intent.phase !== 'prepared') throw new Error('provider-binding-missing');
}

/** Same existing dataset transition metadata used by both hosts; all IDs were fixed in the retained request. */
export async function providerActivationMetadata(plan: ProviderOwnerPlan): Promise<{
  peer: CanonicalDevicePeer; profile: CanonicalLibraryProfile;
  controls: readonly [DatasetControlRecord, DatasetControlRecord, DatasetControlRecord];
}> {
  await assertProviderOwnerPlan(plan);
  if (!plan.binding || plan.binding.state === 'revoked' || !['prepared', 'published', 'activated'].includes(plan.intent.phase))
    throw new Error('provider-not-published');
  const scope = plan.publication.manifest.scope, identity = { accountId: scope.accountId, libraryId: scope.libraryId };
  const control = (phase: 'prepared' | 'published' | 'activated', id: string): DatasetControlRecord => ({
    version: 1, id, identity, epochs: [scope.epoch], active: phase === 'activated' ? plan.publication.manifest : null,
    transition: { id: plan.requestId, mode: 'import', source: null, phase, publication: plan.publication },
  });
  const controls = [control('prepared', plan.activationIds.preparedControlId),
    control('published', plan.activationIds.publishedControlId), control('activated', plan.activationIds.activeControlId)] as const;
  for (const value of controls) await assertDatasetControlPlan(value, identity);
  const peer: CanonicalDevicePeer = { version: 1, accountId: scope.accountId, peerId: plan.intent.peerId };
  validateCanonicalDevicePeer(peer);
  const profile: CanonicalLibraryProfile = {
    version: 1, revision: plan.activationIds.profileRevision, identity, title: plan.title,
    remote: { kind: 'drive', folderId: plan.folderId }, initialization: null,
    origin: { kind: 'activated-installation', source: 'import', controlId: plan.activationIds.activeControlId,
      manifestId: plan.publication.manifest.id, installedScope: scope },
  };
  assertCanonicalProfile(profile);
  return { peer, profile, controls };
}
