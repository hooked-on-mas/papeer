import type { InitializationOutcome } from '../../../runtime/edits/canonicalInitializationStorage.ts';
import type { CanonicalDevicePeer, CanonicalLibraryProfile, DatasetControlRecord, DatasetManifest, RepositoryCheckpoint, Snapshot } from '../../../runtime/edits/contracts.ts';
import { assertInitializationIntent } from '../../../runtime/edits/canonicalInitializationIntent.ts';
import { admitInitialLibrary } from '../../../runtime/edits/canonicalBootstrap.ts';
import { initializationReceipt, validateInitializationRead } from '../../../runtime/edits/canonicalInitializationReadProof.ts';
import { canonicalJson, EditRejected } from '../../../runtime/edits/editModel.ts';
import { CANONICAL_STORES } from '.././canonicalIndexedDbSchema.ts';
import { loadOwnerIntent, readProofRows, relevant, scopeParts, ownerRows, type Rows } from './namespaceOwnerPrepare.ts';
import { queryOwner } from './namespaceOwnerRead.ts';
import { enqueueInitialCanonicalRows } from '.././canonicalIndexedDbEnqueue.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';
import { namespaceOwnerAccount } from './namespaceOwnerTransaction.ts';
const key=(...parts:string[])=>JSON.stringify(parts);
export async function executeOwner(authority:LocalHostAuthority,operation:HostOperation,requestId:string):Promise<InitializationOutcome>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))throw new Error('invalid-id');
 const accountId=namespaceOwnerAccount(authority,operation);
   const outcome = await queryOwner(authority, operation, requestId); namespaceOwnerAccount(authority, operation);
   if (outcome.status !== 'pending') return outcome;
   const first = await loadOwnerIntent(authority, operation, requestId); if (!first || 'retired' in first) throw new Error('retry-snapshot');
   const checked = await assertInitializationIntent(first); namespaceOwnerAccount(authority, operation); if ('retired' in checked) throw new Error('retry-snapshot');
   const libraryId = checked.request.profile.identity.libraryId;
   const captured = await ownerRows(authority, operation, 'readonly', libraryId, requestId, rows => structuredClone(rows));
   const valid = await validateInitializationRead(readProofRows(captured, accountId), accountId); namespaceOwnerAccount(authority, operation);
   const profileByRequest = valid.profiles.find(profile => profile.initialization?.requestId === requestId);
   const saved = valid.intents.find(intent => intent.requestId === requestId);
   if (profileByRequest) { const result: InitializationOutcome = { status: 'accepted', receipt: initializationReceipt(profileByRequest) }; namespaceOwnerAccount(authority, operation); return result; }
   if (!saved) return { status: 'not-found' };
   if ('retired' in saved || saved.result) { namespaceOwnerAccount(authority, operation); return saved.result!; }
   const intent = await assertInitializationIntent(saved); namespaceOwnerAccount(authority, operation);
   if ('retired' in intent || intent.result) throw new Error('retry-snapshot');
   const request = intent.request, account = accountId, library = request.profile.identity.libraryId, identityKey = key(account, library);
   const find = (rows: Rows, store: keyof Rows, rowKey: string) => rows[store].find(row => row.key === rowKey)?.value ?? null;
   const peerRow = captured.canonicalPeers.find(row => row.key === account);
   if (peerRow && (peerRow.scope !== account || (peerRow.value as CanonicalDevicePeer).accountId !== account)) throw new Error('recovery-required');
   const peer = (peerRow?.value ?? null) as CanonicalDevicePeer | null;
   const profile = find(captured, 'canonicalProfiles', identityKey) as CanonicalLibraryProfile | null;
   const control = find(captured, 'datasetControls', identityKey) as DatasetControlRecord | null;
   const artifacts = find(captured, 'canonicalInitialArtifacts', identityKey) as { root: Snapshot; checkpoint: RepositoryCheckpoint; manifest: DatasetManifest } | null;
   const otherLibraryState = CANONICAL_STORES.some(store => captured[store].some(row => { const scope = scopeParts(row.scope); return scope[0] === account && scope[1] === library; }));
   const state = { peer, profile, control, root: artifacts?.root ?? null, checkpoint: artifacts?.checkpoint ?? null, manifest: artifacts?.manifest ?? null,
     otherLibraryState, requestIdUsedByOtherIdentity: false };
   const expected = canonicalJson(relevant(captured, account, library, requestId));
   let decision: Awaited<ReturnType<typeof admitInitialLibrary>>;
   try { decision = await admitInitialLibrary(request, account, state); }
   catch (error) {
    if (!(error instanceof EditRejected) || error.message !== 'dataset-request-reused') throw error;
    namespaceOwnerAccount(authority, operation);
    const rejected = { status: 'rejected' as const, reason: 'dataset-request-reused' };
    const committed = await ownerRows(authority, operation, 'readwrite', library, requestId, (rows, tx) => {
      if (canonicalJson(relevant(rows, account, library, requestId)) !== expected) throw new Error('retry-snapshot');
      tx.objectStore('canonicalInitialIntents').put({ key: key(account, requestId), scope: account, value: { ...intent, result: rejected } }); return rejected;
    });
    namespaceOwnerAccount(authority, operation); return committed;
   }
   namespaceOwnerAccount(authority, operation);
   const accepted = { status: 'accepted' as const, receipt: decision.receipt };
   const committed = await ownerRows(authority, operation, 'readwrite', library, requestId, (rows, tx) => {
    if (canonicalJson(relevant(rows, account, library, requestId)) !== expected) throw new Error('retry-snapshot');
    if (decision.kind === 'create') enqueueInitialCanonicalRows(tx, request, decision.profile, { ...intent, result: accepted });
    else tx.objectStore('canonicalInitialIntents').put({ key: key(account, requestId), scope: account, value: { ...intent, result: accepted } });
    return accepted;
   });
   namespaceOwnerAccount(authority, operation); return committed;
}
