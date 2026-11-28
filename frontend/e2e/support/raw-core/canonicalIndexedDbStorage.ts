// Test-only raw Core/migration fixture; never a production authorization port.
import type { CanonicalInitializationStorage, CanonicalPrincipalLease, InitializationOutcome } from '../../../src/runtime/edits/canonicalInitializationStorage.ts';
import type { CanonicalDevicePeer, CanonicalInitializeRequest, CanonicalLibraryProfile, CanonicalLibraryInitializationIntent } from '../../../src/runtime/edits/contracts.ts';
import { validateInitializationRead } from '../../../src/runtime/edits/canonicalInitializationReadProof.ts';
import { canonicalJson } from '../../../src/runtime/edits/editModel.ts';
import { CanonicalIndexedDbFoundation } from './canonicalIndexedDbFoundation.ts';
import { CanonicalIndexedDbRead } from './canonicalIndexedDbRead.ts';
import { CanonicalIndexedDbPrepare, current, loadIntent, readProofRows, relevant, transaction } from './canonicalIndexedDbPrepare.ts';
import { CanonicalIndexedDbExecute } from './canonicalIndexedDbExecute.ts';
import { CANONICAL_DATABASE_NAME, openCanonicalReadonly } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';
const key = (...parts: string[]) => JSON.stringify(parts);
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
/** Namespace-owner host lease only. Library-bounded provider capabilities are not implemented. */
export class CanonicalIndexedDbStorage implements CanonicalInitializationStorage {
 private readonly factory: IDBFactory; private readonly name: string;
 private readonly foundation: CanonicalIndexedDbFoundation; private readonly reader: CanonicalIndexedDbRead;
 private readonly preparer: CanonicalIndexedDbPrepare; private readonly executor: CanonicalIndexedDbExecute;
 constructor(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME) {
  this.factory = factory; this.name = name; this.foundation = new CanonicalIndexedDbFoundation(factory, name);
  this.reader = new CanonicalIndexedDbRead(factory, name); this.preparer = new CanonicalIndexedDbPrepare(factory, name); this.executor = new CanonicalIndexedDbExecute(factory, name);
 }
 list(lease: CanonicalPrincipalLease, signal: AbortSignal): Promise<{ profiles: CanonicalLibraryProfile[]; intents: CanonicalLibraryInitializationIntent[] }> { return this.reader.list(lease, signal); }
 getOrCreatePeer(lease: CanonicalPrincipalLease, candidatePeerId: string, signal: AbortSignal): Promise<CanonicalDevicePeer> { return this.foundation.getOrCreatePeer(lease, candidatePeerId, signal); }
 prepare(lease: CanonicalPrincipalLease, request: CanonicalInitializeRequest, signal: AbortSignal): Promise<InitializationOutcome> { return this.preparer.prepare(lease, request, signal); }
 query(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<InitializationOutcome> { return this.reader.query(lease, requestId, signal); }
 execute(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<InitializationOutcome> { return this.executor.execute(lease, requestId, signal); }
 async acknowledge(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<void> {
  if (!validId(requestId)) throw new Error('invalid-id'); current(lease, signal);
  const opened = await openCanonicalReadonly(this.factory, this.name);
  try {
   current(lease, signal); if (opened.status === 'uninitialized') return;
   const db = opened.database;
   const first = await loadIntent(db, lease, signal, requestId); current(lease, signal);
   if (!first || 'retired' in first) { await this.reader.query(lease, requestId, signal); return; }
   const libraryId = first.request.profile.identity.libraryId;
   const captured = await transaction(db, 'readonly', lease, signal, libraryId, requestId, rows => structuredClone(rows));
   const valid = await validateInitializationRead(readProofRows(captured, lease.accountId), lease.accountId); current(lease, signal);
   const intent = valid.intents.find(value => value.requestId === requestId);
   if (!intent || 'retired' in intent) return;
   if (!intent.result) throw new Error('initialization-pending');
   const finalResult = intent.result;
   const library = intent.request.profile.identity.libraryId, expected = canonicalJson(relevant(captured, lease.accountId, library, requestId));
   await lease.withCommitGuard(() => transaction(db, 'readwrite', lease, signal, library, requestId, (rows, tx) => {
    if (canonicalJson(relevant(rows, lease.accountId, library, requestId)) !== expected) throw new Error('retry-snapshot');
    if (finalResult.status === 'accepted') {
     // validateInitializationRead already verified the exact profile, immutable rows and current control.
     tx.objectStore('canonicalInitialIntents').delete(key(lease.accountId, requestId));
    } else {
     const retired: CanonicalLibraryInitializationIntent = { version: 1, accountId: intent.accountId, requestId: intent.requestId,
       requestSha256: intent.requestSha256, identity: intent.request.profile.identity, result: finalResult, retired: true };
     tx.objectStore('canonicalInitialIntents').put({ key: key(lease.accountId, requestId), scope: lease.accountId, value: retired });
    }
   }));
   current(lease, signal);
  } finally { if (opened.status === 'ready') opened.database.close(); }
 }
}
