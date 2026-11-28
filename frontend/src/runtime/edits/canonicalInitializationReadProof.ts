import type { CanonicalLibraryProfile, CanonicalLibraryInitializationIntent, CanonicalInitializationReceipt, DatasetControlRecord, DatasetManifest, RepositoryCheckpoint, Snapshot } from './contracts.ts';
import { assertCanonicalProfile } from './canonicalBootstrap.ts';
import { assertInitializationIntent } from './canonicalInitializationIntent.ts';
import { assertDatasetControl, assertEmptyInitialPublication } from './datasetControl.ts';
import { assertDatasetCheckpoint } from './datasetManifest.ts';
import { canonicalJson } from './editModel.ts';

export type CanonicalStoredRow = { key: string; scope: string; value: unknown };
export type InitializationReadSnapshot = { profiles: CanonicalStoredRow[]; intents: CanonicalStoredRow[]; artifacts: CanonicalStoredRow[]; controls: CanonicalStoredRow[]; roots: CanonicalStoredRow[]; datasets: CanonicalStoredRow[]; checkpoints: CanonicalStoredRow[] };
const key = (...parts: string[]) => JSON.stringify(parts);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const requireRow = (rows: CanonicalStoredRow[], rowKey: string, scope: string): CanonicalStoredRow => {
  const rowsAtKey = rows.filter(row => row.key === rowKey); if (rowsAtKey.length !== 1 || rowsAtKey[0].scope !== scope) throw new Error('recovery-required'); return rowsAtKey[0];
};
export function initializationReceipt(profile: CanonicalLibraryProfile): CanonicalInitializationReceipt {
  if (profile.origin.kind !== 'local-initialize' || !profile.initialization) throw new Error('recovery-required');
  const e = profile.initialization; return { requestId: e.requestId, identity: profile.identity, initialScope: e.initialScope, manifestId: e.manifestId, peerId: e.peerId };
}
/** Deep capture before any cryptographic await. Current control is structural identity only. */
export async function validateInitializationRead(input: InitializationReadSnapshot, account: string): Promise<{ profiles: CanonicalLibraryProfile[]; intents: CanonicalLibraryInitializationIntent[] }> {
  const snap = structuredClone(input), profiles: CanonicalLibraryProfile[] = [], intents: CanonicalLibraryInitializationIntent[] = [];
  for (const row of snap.profiles) {
    const profile = row.value as CanonicalLibraryProfile; assertCanonicalProfile(profile);
    if (row.scope !== account || profile.identity.accountId !== account || row.key !== key(account, profile.identity.libraryId)) throw new Error('recovery-required');
    profiles.push(profile);
  }
  for (const row of snap.intents) {
    const intent = await assertInitializationIntent(row.value);
    if (row.scope !== account || intent.accountId !== account || row.key !== key(account, intent.requestId)) throw new Error('recovery-required');
    intents.push(intent);
  }
  const requestIds = new Set<string>();
  for (const profile of profiles) {
    if (!profile.initialization) {
      const identityKey = key(account, profile.identity.libraryId);
      assertDatasetControl(requireRow(snap.controls, identityKey, identityKey).value, profile.identity);
      continue;
    }
    if (profile.origin.kind !== 'local-initialize' || requestIds.has(profile.initialization.requestId)) throw new Error('recovery-required');
    requestIds.add(profile.initialization.requestId);
    const identityKey = key(account, profile.identity.libraryId), proof = profile.initialization;
    const artifacts = requireRow(snap.artifacts, identityKey, account).value as { root: Snapshot; checkpoint: RepositoryCheckpoint; manifest: DatasetManifest };
    if (!artifacts || !artifacts.root || !artifacts.checkpoint || !artifacts.manifest) throw new Error('recovery-required');
    const { root, checkpoint, manifest } = artifacts;
    if (manifest.id !== proof.manifestId || !same(manifest.scope, proof.initialScope) || !same({ accountId: manifest.scope.accountId, libraryId: manifest.scope.libraryId }, profile.identity)
      || checkpoint.libraryId !== profile.identity.libraryId || !same(checkpoint.roots, [root])) throw new Error('recovery-required');
    await assertDatasetCheckpoint(manifest, checkpoint, proof.initialScope);
    assertEmptyInitialPublication({ manifest, checkpoint, checkpointObjectId: profile.initialization.requestId });
    const namespace = key(account, profile.identity.libraryId, proof.initialScope.epoch);
    if (!same(requireRow(snap.roots, key(namespace, profile.identity.libraryId), namespace).value, root)
      || !same(requireRow(snap.datasets, key(namespace, manifest.id), namespace).value, manifest)
      || requireRow(snap.checkpoints, key(namespace, manifest.checkpointSha256), namespace).value !== true) throw new Error('recovery-required');
    const control = requireRow(snap.controls, identityKey, identityKey).value as DatasetControlRecord;
    assertDatasetControl(control, profile.identity);
    const intent = intents.find(value => value.requestId === proof.requestId);
    if (intent && ('retired' in intent || !intent.result || intent.result.status !== 'accepted' || intent.requestSha256 !== proof.requestSha256
      || !same(intent.request.profile.identity, profile.identity) || !same(intent.result.receipt, initializationReceipt(profile)))) throw new Error('recovery-required');
  }
  for (const intent of intents) {
    if (!('retired' in intent) && intent.result?.status === 'accepted') {
      const profile = profiles.find(value => value.initialization?.requestId === intent.requestId);
      if (!profile || profile.origin.kind !== 'local-initialize' || !profile.initialization) throw new Error('recovery-required');
    }
  }
  return { profiles, intents };
}
