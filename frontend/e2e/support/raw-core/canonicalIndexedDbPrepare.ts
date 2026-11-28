// Test-only raw Core/migration fixture; never a production authorization port.
import type { CanonicalPrincipalLease, InitializationOutcome } from '../../../src/runtime/edits/canonicalInitializationStorage.ts';
import type { CanonicalInitializeRequest, CanonicalLibraryInitializationIntent, CanonicalLibraryProfile } from '../../../src/runtime/edits/contracts.ts';
import { makeInitializationIntent } from '../../../src/runtime/edits/canonicalInitializationIntent.ts';
import { initializationReceipt, validateInitializationRead, type CanonicalStoredRow, type InitializationReadSnapshot } from '../../../src/runtime/edits/canonicalInitializationReadProof.ts';
import { canonicalJson, EditRejected } from '../../../src/runtime/edits/editModel.ts';
import { CANONICAL_DATABASE_NAME, CANONICAL_STORES, openCanonicalDatabase } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';

const stores = ['canonicalPeers', 'canonicalProfiles', 'canonicalInitialIntents', 'canonicalInitialArtifacts', ...CANONICAL_STORES] as const;
type StoreName = typeof stores[number];
export type Rows = Record<StoreName, CanonicalStoredRow[]>;
const key = (...parts: string[]) => JSON.stringify(parts);
export function current(lease: CanonicalPrincipalLease, signal: AbortSignal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); lease.assertCurrent(); }
export function scopeParts(scope: string): unknown[] { try { const value: unknown = JSON.parse(scope); return Array.isArray(value) ? value : []; } catch { return []; } }
export function readProofRows(rows: Rows, account: string): InitializationReadSnapshot {
 const own = (r: CanonicalStoredRow[]) => r.filter(v => v.scope === account);
 const scoped = (r: CanonicalStoredRow[]) => r.filter(v => scopeParts(v.scope)[0] === account);
 return { profiles: own(rows.canonicalProfiles), intents: own(rows.canonicalInitialIntents), artifacts: own(rows.canonicalInitialArtifacts), controls: scoped(rows.datasetControls), roots: scoped(rows.roots), datasets: scoped(rows.datasets), checkpoints: scoped(rows.checkpoints) };
}
/** Only this request, target identity and account-wide request/library collisions enter CAS. */
export function relevant(rows: Rows, account: string, library: string, requestId: string): unknown {
 const ownProfiles = rows.canonicalProfiles.filter(row => row.scope === account);
 const ownIntents = rows.canonicalInitialIntents.filter(row => row.scope === account);
 const matchedProfiles = ownProfiles.filter(row => { const p = row.value as CanonicalLibraryProfile; return row.key === key(account, library) || p.initialization?.requestId === requestId; });
 const relevantLibraries = new Set([library, ...matchedProfiles.map(row => (row.value as CanonicalLibraryProfile).identity.libraryId)]);
 const matchesLibrary = (scope: string) => { const parts = scopeParts(scope); return parts[0] === account && typeof parts[1] === 'string' && relevantLibraries.has(parts[1]); };
 const selectedIntents = ownIntents.filter(row => { const i = row.value as CanonicalLibraryInitializationIntent; const id = 'retired' in i ? i.identity : i.request.profile.identity; return i.requestId === requestId || id.libraryId === library; });
 const canonical = Object.fromEntries(CANONICAL_STORES.map(name => [name, rows[name].filter(row => matchesLibrary(row.scope))]));
 return { peer: rows.canonicalPeers.filter(row => row.key === account), profiles: matchedProfiles, intents: selectedIntents,
   artifacts: rows.canonicalInitialArtifacts.filter(row => row.scope === account && relevantLibraries.has(String(scopeParts(row.key)[1]))), canonical };
}
/** Collect only target/collision metadata, then indexed target-library occupancy. Resource bodies are never read. */
function collect(tx: IDBTransaction, account: string, library: string, requestId: string, callback: (rows: Rows) => void): void {
 const rows = Object.fromEntries(stores.map(name => [name, []])) as unknown as Rows;
 let pending = 4;
 const metadataDone = () => {
  if (--pending) return;
  rows.canonicalProfiles = rows.canonicalProfiles.filter(row => { const p = row.value as CanonicalLibraryProfile; return row.key === key(account, library) || p.initialization?.requestId === requestId; });
  rows.canonicalInitialIntents = rows.canonicalInitialIntents.filter(row => { const i = row.value as CanonicalLibraryInitializationIntent; const identity = 'retired' in i ? i.identity : i.request.profile.identity; return i.requestId === requestId || identity.libraryId === library; });
  const libraries = new Set([library, ...rows.canonicalProfiles.map(row => (row.value as CanonicalLibraryProfile).identity.libraryId)]);
  rows.canonicalInitialArtifacts = rows.canonicalInitialArtifacts.filter(row => libraries.has(String(scopeParts(row.key)[1])));
  let cursors = 0;
  const finished = () => { if (--cursors === 0) callback(rows); };
  for (const lib of libraries) for (const name of CANONICAL_STORES) {
   const identity = key(account, lib), prefix = identity.slice(0, -1) + ',';
   const range = name === 'datasetControls' || name === 'datasetAccess' ? IDBKeyRange.only(identity) : IDBKeyRange.bound(prefix, prefix + '\uffff');
   const store = tx.objectStore(name), index = store.index('scope'); cursors++;
   const valuesNeeded = name === 'roots' || name === 'datasets' || name === 'checkpoints' || name === 'datasetControls';
   const cursor = valuesNeeded ? index.openCursor(range) : index.openKeyCursor(range);
   cursor.onsuccess = () => {
    const item = cursor.result; if (!item) { finished(); return; }
    if (valuesNeeded) rows[name].push((item as IDBCursorWithValue).value as CanonicalStoredRow);
    else rows[name].push({ key: String(item.primaryKey), scope: String(item.key), value: null });
    item.continue();
   };
  }
  if (!cursors) callback(rows);
 };
 const peer = tx.objectStore('canonicalPeers').get(account); peer.onsuccess = () => { if (peer.result) rows.canonicalPeers.push(peer.result as CanonicalStoredRow); metadataDone(); };
 for (const name of ['canonicalProfiles', 'canonicalInitialIntents', 'canonicalInitialArtifacts'] as const) {
  const request = tx.objectStore(name).index('scope').getAll(account);
  request.onsuccess = () => { rows[name] = request.result as CanonicalStoredRow[]; metadataDone(); };
 }
}
export function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, lease: CanonicalPrincipalLease, signal: AbortSignal, library: string, requestId: string, action: (rows: Rows, tx: IDBTransaction) => T): Promise<T> {
 return new Promise<T>((resolve, reject) => {
  current(lease, signal); const tx = db.transaction([...stores], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
  let result: T | undefined, failure: unknown, called = false;
  const abort = () => { try { tx.abort(); } catch { /* already completed */ } };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  tx.oncomplete = () => { signal.removeEventListener('abort', abort); if (!called) reject(new Error('snapshot-missing')); else resolve(result as T); };
  tx.onabort = () => { signal.removeEventListener('abort', abort); reject(failure ?? tx.error ?? new DOMException('Aborted', 'AbortError')); };
  try { collect(tx, lease.accountId, library, requestId, rows => { try { current(lease, signal); result = action(rows, tx); called = true; current(lease, signal); } catch (error) { failure = error; abort(); } }); }
  catch (error) { failure = error; abort(); }
 });
}
export function loadIntent(db: IDBDatabase, lease: CanonicalPrincipalLease, signal: AbortSignal, requestId: string): Promise<CanonicalLibraryInitializationIntent | null> {
 return new Promise((resolve, reject) => {
  current(lease, signal); const tx = db.transaction('canonicalInitialIntents', 'readonly'); let value: CanonicalLibraryInitializationIntent | null = null;
  const abort = () => { try { tx.abort(); } catch { /* finished */ } }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const request = tx.objectStore('canonicalInitialIntents').get(key(lease.accountId, requestId));
  request.onsuccess = () => { const row = request.result as CanonicalStoredRow | undefined; if (row) value = row.value as CanonicalLibraryInitializationIntent; };
  tx.oncomplete = () => { signal.removeEventListener('abort', abort); try { current(lease, signal); resolve(value); } catch (error) { reject(error); } };
  tx.onabort = () => { signal.removeEventListener('abort', abort); reject(tx.error ?? new DOMException('Aborted', 'AbortError')); };
 });
}
/** OWNER namespace lease only; this does not implement r5 library-bounded provider authorization. */
export class CanonicalIndexedDbPrepare {
 private readonly factory: IDBFactory; private readonly name: string;
 constructor(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME) { this.factory = factory; this.name = name; }
 async prepare(lease: CanonicalPrincipalLease, request: CanonicalInitializeRequest, signal: AbortSignal): Promise<InitializationOutcome> {
  current(lease, signal); const fixed = await makeInitializationIntent(request, lease.accountId); current(lease, signal);
  if ('retired' in fixed) throw new Error('invalid-initialization-intent');
  const library = fixed.request.profile.identity.libraryId, requestId = fixed.requestId;
  const db = await openCanonicalDatabase(this.factory, this.name);
  try {
   current(lease, signal);
   const captured = await transaction(db, 'readonly', lease, signal, library, requestId, rows => structuredClone(rows));
   const valid = await validateInitializationRead(readProofRows(captured, lease.accountId), lease.accountId); current(lease, signal);
   const intent = valid.intents.find(value => value.requestId === requestId), profile = valid.profiles.find(value => value.initialization?.requestId === requestId);
   if (intent || profile) {
    const digest = intent ? intent.requestSha256 : profile!.initialization!.requestSha256;
    const identity = intent ? ('retired' in intent ? intent.identity : intent.request.profile.identity) : profile!.identity;
    if (digest !== fixed.requestSha256 || canonicalJson(identity) !== canonicalJson(fixed.request.profile.identity)) throw new EditRejected('dataset-request-reused');
   } else if (valid.intents.some(value => !('retired' in value) && value.request.profile.identity.libraryId === library)) throw new EditRejected('dataset-library-request-pending');
   const result: InitializationOutcome = profile ? { status: 'accepted', receipt: initializationReceipt(profile) } : intent ? intent.result ?? { status: 'pending' } : { status: 'pending' };
   const expected = canonicalJson(relevant(captured, lease.accountId, library, requestId));
   const committed = await lease.withCommitGuard(() => transaction(db, 'readwrite', lease, signal, library, requestId, (rows, tx) => {
    if (canonicalJson(relevant(rows, lease.accountId, library, requestId)) !== expected) throw new Error('retry-snapshot');
    if (!intent && !profile) tx.objectStore('canonicalInitialIntents').add({ key: key(lease.accountId, requestId), scope: lease.accountId, value: fixed });
    return result;
   }));
   current(lease, signal); return committed;
  } finally { db.close(); }
 }
}
