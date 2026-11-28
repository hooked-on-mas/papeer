import type { CanonicalDevicePeer, CanonicalProviderBinding, CanonicalProviderIntent, DatasetPublication, RepositoryCheckpoint } from '../contracts.ts';
import type { EditScope } from '../ports.ts';
import { canonicalJson } from '../editModel.ts';
import { checkpointHash } from '../datasetManifest.ts';
import { resourceHash } from '../contentPublication.ts';
import { scopeKey } from '../repository.ts';
import { pyStrip } from '../../../lib/pyWhitespace.ts';
import { assertProviderOwnerPlan, providerOwnerRequestSha256, type ProviderOwnerPlan } from './providerOwnerPlan.ts';

/** Existing transfer namespace formula, independent of Google principal identity. */
export const providerScopeNamespace = (scope: EditScope) => resourceHash(new TextEncoder().encode(scopeKey(scope)));

type Common = { ownerNamespace: string; principalDigest: string; requestId: string; peer?: CanonicalDevicePeer };
const activationIds = (makeId: () => string) => ({ preparedControlId: makeId(), publishedControlId: makeId(),
  activeControlId: makeId(), profileRevision: makeId() });
function peerId(input: Common, accountId: string, makeId: () => string): string {
  if (input.peer && input.peer.accountId !== accountId) throw new Error('provider-peer-scope');
  return input.peer?.peerId ?? makeId();
}
function intent(input: Common, action: 'create' | 'join', publication: DatasetPublication, descriptorSha256: string,
  makeId: () => string): CanonicalProviderIntent {
  return { version: 1, requestId: input.requestId, bindingId: makeId(), action, scope: { ...publication.manifest.scope },
    requestSha256: '', descriptorObjectId: makeId(), descriptorSha256, manifestId: publication.manifest.id,
    checkpointObjectId: publication.checkpointObjectId, checkpointSha256: publication.manifest.checkpointSha256,
    peerId: peerId(input, publication.manifest.scope.accountId, makeId), phase: 'prepared' };
}
async function finish(plan: ProviderOwnerPlan): Promise<ProviderOwnerPlan> {
  plan.intent.requestSha256 = await providerOwnerRequestSha256(plan);
  await assertProviderOwnerPlan(plan);
  return structuredClone(plan);
}

/** Call only after authenticated query(requestId) returned absent and Google allocated these IDs.
 * This constructs data; the host still has to persist it under its real owner operation BEFORE any POST.
 */
export async function prepareNewProviderLibrary(input: Common & { title: string;
  providerIds: { folderId: string; checkpointFileId: string; manifestFileId: string; descriptorFileId: string } },
  makeId: () => string = () => crypto.randomUUID()): Promise<ProviderOwnerPlan> {
  const scope: EditScope = { accountId: input.ownerNamespace, libraryId: makeId(), epoch: makeId() };
  const checkpoint: RepositoryCheckpoint = { version: 1, libraryId: scope.libraryId,
    roots: [{ kind: 'library', id: scope.libraryId, version: makeId(), items: [], folders: [], links: [], deletions: [] }], edits: [] };
  const manifest = { version: 1 as const, id: makeId(), scope, checkpointSha256: await checkpointHash(checkpoint), resources: [] };
  const publication: DatasetPublication = { manifest, checkpoint, checkpointObjectId: makeId() };
  const descriptorBytes = new TextEncoder().encode(canonicalJson({ version: 1, scope, manifestId: manifest.id, checkpointSha256: manifest.checkpointSha256 }));
  const sha256 = await resourceHash(descriptorBytes), request = intent(input, 'create', publication, sha256, makeId);
  return finish({ ownerNamespace: input.ownerNamespace, requestId: input.requestId, title: pyStrip(input.title),
    folderId: input.providerIds.folderId, principalDigest: input.principalDigest,
    descriptor: { id: input.providerIds.descriptorFileId, version: null, sha256 }, descriptorBytes,
    publication, resources: [], activationIds: activationIds(makeId),
    createObjects: { folderObjectId: makeId(), ...input.providerIds }, binding: null, intent: request });
}

/** Verified descriptor/location and complete dataset are fetched by the host; none come from the view. */
export async function prepareJoinedProviderLibrary(input: Common & { title: string; folderId: string;
  descriptor: { id: string; version: string; sha256: string }; descriptorBytes: Uint8Array;
  publication: DatasetPublication }, makeId: () => string = () => crypto.randomUUID()): Promise<ProviderOwnerPlan> {
  const publication = structuredClone(input.publication), request = intent(input, 'join', publication, input.descriptor.sha256, makeId);
  const binding: CanonicalProviderBinding = { version: 1, id: request.bindingId, provider: 'google-drive', principalDigest: input.principalDigest,
    scope: { ...publication.manifest.scope }, descriptorId: input.descriptor.id, descriptorVersion: input.descriptor.version,
    descriptorSha256: input.descriptor.sha256, state: 'preparing' };
  return finish({ ownerNamespace: input.ownerNamespace, requestId: input.requestId, title: input.title, folderId: input.folderId,
    principalDigest: input.principalDigest, descriptor: { ...input.descriptor }, descriptorBytes: Uint8Array.from(input.descriptorBytes),
    publication, resources: publication.manifest.resources.map(metadata => ({ metadata,
      stagingKey: JSON.stringify([input.ownerNamespace, input.requestId, 'resource', metadata.id]) })),
    activationIds: activationIds(makeId), createObjects: null, binding, intent: request });
}
