// Test-only raw Core/migration fixture; never a production authorization port.
import type { CanonicalPrincipalLease, InitializationOutcome } from '../../../src/runtime/edits/canonicalInitializationStorage.ts';
import type { CanonicalDevicePeer, CanonicalLibraryProfile, DatasetControlRecord, DatasetManifest, RepositoryCheckpoint, Snapshot } from '../../../src/runtime/edits/contracts.ts';
import { assertInitializationIntent } from '../../../src/runtime/edits/canonicalInitializationIntent.ts';
import { admitInitialLibrary } from '../../../src/runtime/edits/canonicalBootstrap.ts';
import { initializationReceipt, validateInitializationRead } from '../../../src/runtime/edits/canonicalInitializationReadProof.ts';
import { canonicalJson, EditRejected } from '../../../src/runtime/edits/editModel.ts';
import { CANONICAL_DATABASE_NAME, CANONICAL_STORES, openCanonicalReadonly } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';
import { current, loadIntent, readProofRows, relevant, scopeParts, transaction, type Rows } from './canonicalIndexedDbPrepare.ts';
import { CanonicalIndexedDbRead } from './canonicalIndexedDbRead.ts';
import { enqueueInitialCanonicalRows } from '../../../src/adapters/browser/canonicalIndexedDbEnqueue.ts';
const key = (...parts: string[]) => JSON.stringify(parts);
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
/** OWNER namespace only. Authenticated library-bounded provider access is not supported. */
export class CanonicalIndexedDbExecute {
 private readonly factory: IDBFactory; private readonly name: string;
 constructor(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME) { this.factory = factory; this.name = name; }
 async execute(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<InitializationOutcome> {
  if (!validId(requestId)) throw new Error('invalid-id'); current(lease, signal);
  const opened = await openCanonicalReadonly(this.factory, this.name);
  try {
   current(lease, signal); if (opened.status === 'uninitialized') return { status: 'not-found' };
   const db = opened.database;
   current(lease, signal);
   const outcome = await new CanonicalIndexedDbRead(this.factory, this.name).query(lease, requestId, signal); current(lease, signal);
   if (outcome.status !== 'pending') return outcome;
   const first = await loadIntent(db, lease, signal, requestId); if (!first || 'retired' in first) throw new Error('retry-snapshot');
   const checked = await assertInitializationIntent(first); current(lease, signal); if ('retired' in checked) throw new Error('retry-snapshot');
   const libraryId = checked.request.profile.identity.libraryId;
   const captured = await transaction(db, 'readonly', lease, signal, libraryId, requestId, rows => structuredClone(rows));
   const valid = await validateInitializationRead(readProofRows(captured, lease.accountId), lease.accountId); current(lease, signal);
   const profileByRequest = valid.profiles.find(profile => profile.initialization?.requestId === requestId);
   const saved = valid.intents.find(intent => intent.requestId === requestId);
   if (profileByRequest) { const result: InitializationOutcome = { status: 'accepted', receipt: initializationReceipt(profileByRequest) }; current(lease, signal); return result; }
   if (!saved) return { status: 'not-found' };
   if ('retired' in saved || saved.result) { current(lease, signal); return saved.result!; }
   const intent = await assertInitializationIntent(saved); current(lease, signal);
   if ('retired' in intent || intent.result) throw new Error('retry-snapshot');
   const request = intent.request, account = lease.accountId, library = request.profile.identity.libraryId, identityKey = key(account, library);
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
    current(lease, signal);
    const rejected = { status: 'rejected' as const, reason: 'dataset-request-reused' };
    const committed = await lease.withCommitGuard(() => transaction(db, 'readwrite', lease, signal, library, requestId, (rows, tx) => {
      if (canonicalJson(relevant(rows, account, library, requestId)) !== expected) throw new Error('retry-snapshot');
      tx.objectStore('canonicalInitialIntents').put({ key: key(account, requestId), scope: account, value: { ...intent, result: rejected } }); return rejected;
    }));
    current(lease, signal); return committed;
   }
   current(lease, signal);
   const accepted = { status: 'accepted' as const, receipt: decision.receipt };
   const committed = await lease.withCommitGuard(() => transaction(db, 'readwrite', lease, signal, library, requestId, (rows, tx) => {
    if (canonicalJson(relevant(rows, account, library, requestId)) !== expected) throw new Error('retry-snapshot');
    if (decision.kind === 'create') enqueueInitialCanonicalRows(tx, request, decision.profile, { ...intent, result: accepted });
    else tx.objectStore('canonicalInitialIntents').put({ key: key(account, requestId), scope: account, value: { ...intent, result: accepted } });
    return accepted;
   }));
   current(lease, signal); return committed;
  } finally { if (opened.status === 'ready') opened.database.close(); }
 }
}
