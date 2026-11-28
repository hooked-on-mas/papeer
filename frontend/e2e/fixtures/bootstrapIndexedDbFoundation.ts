import { CanonicalIndexedDbFoundation } from '../../e2e/support/raw-core/canonicalIndexedDbFoundation.ts';
import { openCanonicalReadonly } from '../../src/adapters/browser/canonicalIndexedDbSchema.ts';
import type { CanonicalPrincipalLease } from '../../src/runtime/edits/canonicalInitializationStorage.ts';
const peer1 = '00000000-0000-4000-8000-000000000001', peer2 = '00000000-0000-4000-8000-000000000002';
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
function testLease(controller: AbortController): CanonicalPrincipalLease {
  return { accountId: 'fixture-account', generation: 'fixture-generation', assertCurrent() { if (controller.signal.aborted) throw new DOMException('revoked', 'AbortError'); },
    async withCommitGuard<T>(commit: () => Promise<T>) { if (controller.signal.aborted) throw new DOMException('revoked', 'AbortError'); return commit(); } };
}
async function erase(name: string) { await req(indexedDB.deleteDatabase(name)); }
async function cases() {
  const name = `bootstrap-foundation-${crypto.randomUUID()}`; const controller = new AbortController(), lease = testLease(controller);
  const provider = new CanonicalIndexedDbFoundation(indexedDB, name), signal = controller.signal;
  try {
    const before = await openCanonicalReadonly(indexedDB, name);
    const absent = before.status === 'uninitialized';
    const namesAfterRead = await indexedDB.databases();
    const neverCreated = !namesAfterRead.some(row => row.name === name);
    const opening = indexedDB.open(name, 6);
    opening.onupgradeneeded = () => { const store = opening.result.createObjectStore('roots', { keyPath: 'key' }); store.createIndex('scope', 'scope'); };
    const old = await req(opening); const tx = old.transaction('roots', 'readwrite'); tx.objectStore('roots').put({ key: 'old', scope: 'old', value: 'preserved' }); await done(tx); old.close();
    const oldRead = await openCanonicalReadonly(indexedDB, name); const oldUninitialized = oldRead.status === 'uninitialized';
    const [a, b] = await Promise.all([provider.getOrCreatePeer(lease, peer1, signal), provider.getOrCreatePeer(lease, peer2, signal)]);
    const reopened = await openCanonicalReadonly(indexedDB, name); if (reopened.status !== 'ready') throw new Error('upgrade missing');
    const read = reopened.database.transaction('roots', 'readonly'), saved = await req(read.objectStore('roots').get('old')); await done(read); reopened.database.close();
    const cancelled = new AbortController(); cancelled.abort(); let rejected = false;
    try { await provider.getOrCreatePeer(testLease(cancelled), peer2, cancelled.signal); } catch { rejected = true; }
    const again = await provider.getOrCreatePeer(lease, peer2, signal);
    return { absent, neverCreated, oldUninitialized, sameWinner: a.peerId === b.peerId && a.peerId === again.peerId, preserved: saved?.value === 'preserved', rejected };
  } finally { await erase(name); }
}
Object.assign(window, { bootstrapFoundationCases: cases });
