// Test-only injection. No product hook or production lease is introduced.
import { CanonicalIndexedDbStorage } from '../../e2e/support/raw-core/canonicalIndexedDbStorage.ts';
import { createIndexedDbEditRepository } from '../../e2e/support/raw-core/indexedDbEdits.ts';
import { checkpointHash } from '../../src/runtime/edits/datasetManifest.ts';
import type { CanonicalInitializeRequest, RepositoryCheckpoint } from '../../src/runtime/edits/contracts.ts';
import type { CanonicalPrincipalLease } from '../../src/runtime/edits/canonicalInitializationStorage.ts';
const key = (...parts: string[]) => JSON.stringify(parts);
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('aborted')); });
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
function lease(controller: AbortController, account: string): CanonicalPrincipalLease {
 return { accountId: account, generation: 'fixture', assertCurrent() { if (controller.signal.aborted) throw new DOMException('revoked', 'AbortError'); }, async withCommitGuard<T>(fn: () => Promise<T>) { this.assertCurrent(); return fn(); } };
}
async function request(account: string, peer: string, libraryId: string = crypto.randomUUID()): Promise<CanonicalInitializeRequest> {
 const identity = { accountId: account, libraryId }, scope = { ...identity, epoch: crypto.randomUUID() }, requestId = crypto.randomUUID();
 const checkpoint: RepositoryCheckpoint = { version: 1, libraryId, roots: [{ kind: 'library', id: libraryId, version: crypto.randomUUID(), items: [], folders: [], links: [], deletions: [] }], edits: [] };
 const manifest = { version: 1 as const, id: crypto.randomUUID(), scope, checkpointSha256: await checkpointHash(checkpoint), resources: [] };
 return { expectedPeerId: peer, profile: { version: 1, revision: crypto.randomUUID(), identity, title: 'Fixture library', remote: null }, control: { version: 1, id: requestId, identity, epochs: [scope.epoch], active: manifest, transition: { id: requestId, mode: 'initialize', source: null, phase: 'activated', publication: { manifest, checkpoint, checkpointObjectId: crypto.randomUUID() } } } };
}
async function cases() {
 const name = `bootstrap-fault-${crypto.randomUUID()}`, account = 'fixture-owner', main = new AbortController(), owner = lease(main, account), signal = main.signal;
 const first = new CanonicalIndexedDbStorage(indexedDB, name), second = new CanonicalIndexedDbStorage(indexedDB, name);
 const originalAdd = IDBObjectStore.prototype.add, originalGet = IDBObjectStore.prototype.get, originalGetAll = IDBObjectStore.prototype.getAll, originalCursor = IDBObjectStore.prototype.openCursor;
 const indexGet = IDBIndex.prototype.get, indexGetAll = IDBIndex.prototype.getAll, indexCursor = IDBIndex.prototype.openCursor;
 let injection: 'quota' | 'revoke' | null = null, armed: AbortController | null = null, injected = 0, bodyReads = 0;
 IDBObjectStore.prototype.add = function(value: unknown, id?: IDBValidKey) {
  if (this.name === 'projections' && injection) { const mode = injection; injection = null; injected++; if (mode === 'revoke') armed?.abort(); this.transaction.abort(); throw new DOMException(mode === 'quota' ? 'injected quota' : 'injected revocation', mode === 'quota' ? 'QuotaExceededError' : 'AbortError'); }
  return id === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, id);
 };
 IDBObjectStore.prototype.get = function(id: IDBValidKey | IDBKeyRange) { if (this.name === 'resourceBytes') bodyReads++; return originalGet.call(this, id); };
 IDBObjectStore.prototype.getAll = function(query?: IDBValidKey | IDBKeyRange | null, count?: number) { if (this.name === 'resourceBytes') bodyReads++; return originalGetAll.call(this, query, count); };
 IDBObjectStore.prototype.openCursor = function(query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) { if (this.name === 'resourceBytes') bodyReads++; return originalCursor.call(this, query, direction); };
 IDBIndex.prototype.get = function(query: IDBValidKey | IDBKeyRange) { if (this.objectStore.name === 'resourceBytes') bodyReads++; return indexGet.call(this, query); };
 IDBIndex.prototype.getAll = function(query?: IDBValidKey | IDBKeyRange | null, count?: number) { if (this.objectStore.name === 'resourceBytes') bodyReads++; return indexGetAll.call(this, query, count); };
 IDBIndex.prototype.openCursor = function(query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) { if (this.objectStore.name === 'resourceBytes') bodyReads++; return indexCursor.call(this, query, direction); };
 try {
  const [peerA, peerB] = await Promise.all([first.getOrCreatePeer(owner, crypto.randomUUID(), signal), second.getOrCreatePeer(owner, crypto.randomUUID(), signal)]);
  if (peerA.peerId !== peerB.peerId) throw new Error('peer race diverged');
  // Seed unrelated opaque bytes directly as test setup; bootstrap must use key cursors only.
  const db = await req(indexedDB.open(name)); const seed = db.transaction('resourceBytes', 'readwrite');
  seed.objectStore('resourceBytes').put({ key: key(key(account, crypto.randomUUID(), crypto.randomUUID()), 'blob'), scope: key(account, crypto.randomUUID(), 'other'), value: new Uint8Array(1024 * 1024) }); await done(seed); db.close();
  const fixed = await request(account, peerA.peerId), id = fixed.control.id, scope = fixed.control.transition.publication.manifest.scope;
  const [p1, p2] = await Promise.allSettled([first.prepare(owner, fixed, signal), second.prepare(owner, fixed, signal)]);
  if (p1.status === 'rejected' && p2.status === 'rejected') throw new Error('both prepare attempts failed');
  if ((await first.query(owner, id, signal)).status !== 'pending') throw new Error('fixed intent not durable');
  const snapshot = async () => { const raw = await req(indexedDB.open(name)); const names = ['roots', 'projections', 'checkpoints', 'datasets', 'datasetControls', 'datasetAccess', 'canonicalProfiles', 'canonicalInitialArtifacts', 'canonicalInitialIntents'];
   const tx = raw.transaction(names, 'readonly'); const requests = names.map(n => tx.objectStore(n).getAll()); await done(tx); const all = requests.map(v => v.result); raw.close(); return JSON.stringify(all); };
  const before = await snapshot();
  // Native open succeeds, then generation is revoked before the provider's onsuccess handler.
  // Keep a reference solely to guarantee cleanup even when the regression leaks it.
  const lateOpen = async (operation: 'execute' | 'acknowledge') => {
   const revokedController = new AbortController(); let acquired: IDBDatabase | undefined, closeCalls = 0;
   const originalClose = IDBDatabase.prototype.close;
   IDBDatabase.prototype.close = function() { if (this === acquired) closeCalls++; return originalClose.call(this); };
   const intercepted = new Proxy(indexedDB, { get(target, property) {
    if (property === 'open') return (dbName: string, version?: number) => {
     const opening = version === undefined ? target.open(dbName) : target.open(dbName, version);
     opening.addEventListener('success', () => { acquired = opening.result; revokedController.abort(); }, { once: true });
     return opening;
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
   } });
   try {
    const storage = new CanonicalIndexedDbStorage(intercepted, name); let failed = false;
    try { if (operation === 'execute') await storage.execute(lease(revokedController, account), id, revokedController.signal);
      else await storage.acknowledge(lease(revokedController, account), id, revokedController.signal); } catch { failed = true; }
    const closed = !!acquired && closeCalls === 1;
    return failed && closed && (await first.query(owner, id, signal)).status === 'pending' && before === await snapshot();
   } finally { if (acquired && closeCalls === 0) originalClose.call(acquired); IDBDatabase.prototype.close = originalClose; }
  };
  const lateExecuteClosed = await lateOpen('execute'), lateAckClosed = await lateOpen('acknowledge');
  injection = 'quota'; let quota = false; try { await first.execute(owner, id, signal); } catch (error) { quota = error instanceof DOMException && error.name === 'QuotaExceededError'; }
  const quotaSame = before === await snapshot() && (await first.query(owner, id, signal)).status === 'pending';
  const cancelled = new AbortController(); armed = cancelled; injection = 'revoke'; let revoked = false;
  try { await first.execute(lease(cancelled, account), id, cancelled.signal); } catch { revoked = cancelled.signal.aborted; }
  const revokeSame = before === await snapshot() && (await first.query(owner, id, signal)).status === 'pending';
  const [a, b] = await Promise.allSettled([first.execute(owner, id, signal), second.execute(owner, id, signal)]);
  if (a.status === 'rejected' && b.status === 'rejected') throw new Error('both execute attempts failed');
  // A losing snapshot CAS can be retried with the exact fixed request ID.
  const accepted = await first.execute(owner, id, signal), recovered = await new CanonicalIndexedDbStorage(indexedDB, name).query(owner, id, signal);
  const stable = JSON.stringify(accepted) === JSON.stringify(recovered) && accepted.status === 'accepted';
  await first.acknowledge(owner, id, signal); const afterAck = await second.execute(owner, id, signal);
  const stableAfterAck = JSON.stringify(afterAck) === JSON.stringify(accepted);
  const repo = createIndexedDbEditRepository(scope, name, indexedDB); let readback = false;
  try { const state = await repo.repository.read(scope.libraryId); readback = state.checkpoint.root.id === scope.libraryId && state.heads.length === 1 && state.history.length === 0 && state.checkpoint.batches.length === 0; } finally { await repo.close(); }
  // Simulate transport reply loss after the real transaction has committed.
  const lostRequest = await request(account, peerA.peerId), lostId = lostRequest.control.id;
  await first.prepare(owner, lostRequest, signal);
  const lostLease: CanonicalPrincipalLease = { ...owner, async withCommitGuard<T>(fn: () => Promise<T>) { await fn(); throw new Error('injected reply loss'); } };
  let replyLost = false; try { await first.execute(lostLease, lostId, signal); } catch { replyLost = true; }
  const recoveredLost = await new CanonicalIndexedDbStorage(indexedDB, name).query(owner, lostId, signal);
  await second.acknowledge(owner, lostId, signal);
  const lostReplay = await first.execute(owner, lostId, signal);
  const lostStable = replyLost && recoveredLost.status === 'accepted' && JSON.stringify(recoveredLost) === JSON.stringify(lostReplay);
  // A different fixed request for the installed library yields a durable rejection, then compact reservation.
  const collision = await request(account, peerA.peerId, scope.libraryId), cid = collision.control.id;
  await first.prepare(owner, collision, signal); const rejected = await first.execute(owner, cid, signal); await first.acknowledge(owner, cid, signal);
  const replayRejected = await second.query(owner, cid, signal); let reused = false;
  try { await second.prepare(owner, { ...collision, profile: { ...collision.profile, title: 'different' } }, signal); } catch { reused = true; }
  return { lateExecuteClosed, lateAckClosed, quota, quotaSame, revoked, revokeSame, injected, stable, stableAfterAck, readback, lostStable, rejected: rejected.status === 'rejected', rejectedReplay: JSON.stringify(rejected) === JSON.stringify(replayRejected), reused, bodyReads };
 } finally {
  IDBObjectStore.prototype.add = originalAdd; IDBObjectStore.prototype.get = originalGet; IDBObjectStore.prototype.getAll = originalGetAll; IDBObjectStore.prototype.openCursor = originalCursor; IDBIndex.prototype.get = indexGet; IDBIndex.prototype.getAll = indexGetAll; IDBIndex.prototype.openCursor = indexCursor;
  await req(indexedDB.deleteDatabase(name));
 }
}
Object.assign(window, { bootstrapFaultCases: cases });
