import { validateCanonicalLibraryProfile, validateCanonicalDevicePeer, validateCanonicalInitializeRequest, type CanonicalLibraryProfile, type CanonicalDevicePeer, type CanonicalInitializeRequest, type DatasetControlRecord, type DatasetManifest, type RepositoryCheckpoint, type Snapshot } from './contracts.ts';
import { assertDatasetControl, assertDatasetControlPlan } from './datasetControl.ts';
import { editContentHash } from './editContentHash.ts';
import { canonicalJson, EditRejected } from './editModel.ts';

// Supplied from a single host transaction. otherLibraryState covers every other row/object
// in the identity's canonical footprint; requestIdUsedByOtherIdentity is account-wide.
export type InitialLibraryState = { peer: CanonicalDevicePeer | null; profile: CanonicalLibraryProfile | null; control: DatasetControlRecord | null; root: Snapshot | null; checkpoint: RepositoryCheckpoint | null; manifest: DatasetManifest | null; otherLibraryState: boolean; requestIdUsedByOtherIdentity: boolean };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function assertCanonicalProfile(profile: CanonicalLibraryProfile): void {
  validateCanonicalLibraryProfile(profile);
  if (profile.origin.kind === 'local-initialize' && profile.initialization === null) throw new EditRejected('dataset-scope');
  const scope = profile.initialization !== null ? profile.initialization.initialScope : profile.origin.kind === 'activated-installation' ? profile.origin.installedScope : (() => { throw new EditRejected('dataset-scope'); })();
  if (!same({accountId:scope.accountId, libraryId:scope.libraryId}, profile.identity)) throw new EditRejected('dataset-scope');
}
export function assertInitializationUnchanged(before: CanonicalLibraryProfile, after: CanonicalLibraryProfile): void {
  assertCanonicalProfile(before); assertCanonicalProfile(after);
  if (!same(before.identity, after.identity) || !same(before.initialization, after.initialization) || !same(before.origin, after.origin)) throw new EditRejected('dataset-initialization-changed');
}
/** Pure decision only. The host must hold its principal guard and transaction across read, decision and commit. */
export async function admitInitialLibrary(inputRequest: CanonicalInitializeRequest, accountId: string, inputState: InitialLibraryState) {
  // Capture both inputs synchronously before checkpoint hashing yields.
  const request = structuredClone(inputRequest), state = structuredClone(inputState);
  validateCanonicalInitializeRequest(request);
  const { profile, control, expectedPeerId } = request;
  if (profile.identity.accountId !== accountId || profile.remote !== null || !same(profile.identity, control.identity)) throw new EditRejected('dataset-scope');
  if (!state.peer) throw new EditRejected('dataset-peer');
  validateCanonicalDevicePeer(state.peer);
  if (state.peer.accountId !== accountId || state.peer.peerId !== expectedPeerId) throw new EditRejected('dataset-peer');
  if (state.requestIdUsedByOtherIdentity) throw new EditRejected('dataset-request-reused');
  await assertDatasetControlPlan(control, profile.identity);
  if (control.transition.mode !== 'initialize') throw new EditRejected('dataset-initialize');
  if (control.transition.source !== null || control.transition.phase !== 'activated' || control.id !== control.transition.id || control.epochs.length !== 1 || control.epochs[0] !== control.transition.publication.manifest.scope.epoch) throw new EditRejected('dataset-initialize');
  const publication = control.transition.publication;
  const evidence = { requestId: control.id, requestSha256: await editContentHash(request), initialScope: publication.manifest.scope, manifestId: publication.manifest.id, peerId: expectedPeerId };
  const receipt = { requestId: evidence.requestId, identity: profile.identity, initialScope: evidence.initialScope, manifestId: evidence.manifestId, peerId: evidence.peerId };
  const present = [state.profile, state.control, state.root, state.checkpoint, state.manifest].filter(value => value !== null).length;
  if (present === 0 && !state.otherLibraryState) return { kind: 'create' as const, profile: { ...profile, origin: { kind: 'local-initialize' as const }, initialization: evidence }, receipt };
  if (present !== 5) throw new EditRejected('recovery-required');
  const currentProfile = state.profile!, currentControl = state.control!;
  try { assertCanonicalProfile(currentProfile); assertDatasetControl(currentControl, profile.identity); }
  catch { throw new EditRejected('recovery-required'); }
  if (!same(currentProfile.identity, profile.identity)) throw new EditRejected('recovery-required');
  if (currentProfile.origin.kind !== 'local-initialize' || currentProfile.initialization === null) throw new EditRejected('recovery-required');
  if (currentProfile.initialization.requestId !== evidence.requestId) throw new EditRejected('dataset-request-reused');
  if (!same(currentProfile.initialization, evidence)) throw new EditRejected('dataset-initialize-retry-mismatch');
  if (!same(state.root, publication.checkpoint.roots[0]) || !same(state.checkpoint, publication.checkpoint) || !same(state.manifest, publication.manifest)) throw new EditRejected('recovery-required');
  return { kind: 'retry' as const, receipt };
}
