import type { InitializationOutcome } from '../../../runtime/edits/canonicalInitializationStorage.ts';
import { initializationReceipt, validateInitializationRead } from '../../../runtime/edits/canonicalInitializationReadProof.ts';
import { datasetAccess } from '../../../runtime/edits/datasetControl.ts';
import type { DatasetControlRecord } from '../../../runtime/edits/contracts.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';
import { namespaceOwnerAccount } from './namespaceOwnerTransaction.ts';
import { ownerSnapshot } from './namespaceOwnerRead.ts';

export type OwnerLibraryListing = {
  libraries: { libraryId: string; title: string; status: 'available' | 'recovery-required' | 'frozen'; reason?: string }[];
  creations: { requestId: string; title: string; outcome: InitializationOutcome }[];
};

/** One validated readonly snapshot of the leased namespace; no peer is created and nothing is executed. */
export async function listOwnerLibraries(authority: LocalHostAuthority, operation: HostOperation): Promise<OwnerLibraryListing> {
  const account = namespaceOwnerAccount(authority, operation), snapshot = await ownerSnapshot(authority, operation);
  const result = await validateInitializationRead(snapshot, account); namespaceOwnerAccount(authority, operation);
  const controls = new Map(snapshot.controls.map(row => [row.key, row.value as DatasetControlRecord]));
  const libraries: OwnerLibraryListing['libraries'] = result.profiles.map(profile => {
    const control = controls.get(JSON.stringify([account, profile.identity.libraryId]));
    if (!control || !control.active) return { libraryId: profile.identity.libraryId, title: profile.title, status: 'recovery-required' as const, reason: 'no-active-dataset' };
    if (datasetAccess(control).frozen) return { libraryId: profile.identity.libraryId, title: profile.title, status: 'frozen' as const, reason: 'dataset-frozen' };
    return { libraryId: profile.identity.libraryId, title: profile.title, status: 'available' as const };
  });
  const creations: OwnerLibraryListing['creations'] = [];
  for (const intent of result.intents) {
    if ('retired' in intent) continue;
    const profile = result.profiles.find(value => value.initialization?.requestId === intent.requestId);
    const outcome: InitializationOutcome = profile ? { status: 'accepted', receipt: initializationReceipt(profile) } : intent.result ?? { status: 'pending' };
    creations.push({ requestId: intent.requestId, title: intent.request.profile.title, outcome });
  }
  return { libraries, creations };
}
