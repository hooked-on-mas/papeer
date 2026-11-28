import { validateCanonicalInitializeRequest, validateCanonicalDevicePeer, type CanonicalDevicePeer, type CanonicalInitializeRequest, type RepositoryCheckpoint } from '../../runtime/edits/contracts.ts';
import { checkpointHash } from '../../runtime/edits/datasetManifest.ts';
import { assertDatasetControlPlan } from '../../runtime/edits/datasetControl.ts';
/** IDs are generated once after a durable peer result; retries retain the entire returned request. */
export async function initialRequest(title: string, peer: CanonicalDevicePeer, makeId: () => string = () => crypto.randomUUID()): Promise<CanonicalInitializeRequest> {
 const capturedPeer = structuredClone(peer); validateCanonicalDevicePeer(capturedPeer);
 const name = title.trim(); if (!name) throw new Error('library-title-required');
 const libraryId = makeId(), requestId = makeId(), epoch = makeId(), rootVersion = makeId(), manifestId = makeId(), checkpointObjectId = makeId(), revision = makeId();
 const identity = { accountId: capturedPeer.accountId, libraryId }, scope = { ...identity, epoch };
 const checkpoint: RepositoryCheckpoint = { version: 1, libraryId, roots: [{ kind: 'library', id: libraryId, version: rootVersion, items: [], folders: [], links: [], deletions: [] }], edits: [] };
 const manifest = { version: 1 as const, id: manifestId, scope, checkpointSha256: await checkpointHash(checkpoint), resources: [] };
 const request: CanonicalInitializeRequest = { expectedPeerId: capturedPeer.peerId, profile: { version: 1, revision, identity, title: name, remote: null },
  control: { version: 1, id: requestId, identity, epochs: [epoch], active: manifest, transition: { id: requestId, mode: 'initialize', phase: 'activated', source: null, publication: { manifest, checkpoint, checkpointObjectId } } } };
 validateCanonicalInitializeRequest(request); await assertDatasetControlPlan(request.control, identity); return structuredClone(request);
}
