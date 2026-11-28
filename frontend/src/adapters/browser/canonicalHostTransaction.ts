import { LOCAL_GRANT_STORE, supportedCanonicalSchema } from './canonicalIndexedDbSchema.ts';
import { canonicalJson } from '../../runtime/edits/editModel.ts';
import type { LocalHostAuthority, HostOperation, PersistentTuple } from './localHostAuthority.ts';
const key = (...parts: string[]) => JSON.stringify(parts);
type Row = { key: string; scope: string; value: unknown };
export function openExisting(factory: IDBFactory, name: string, signal: AbortSignal, assertCurrent?: () => void): Promise<IDBDatabase> {
 return new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
  const request = factory.open(name); let failed = false, created = false;
  request.onupgradeneeded = () => { created = true; request.transaction?.abort(); };
  request.onblocked = () => { failed = true; reject(new Error('canonical-database-blocked')); };
  request.onerror = () => { if (!failed) reject(created ? new Error('canonical-database-absent') : request.error ?? new Error('canonical-database-open')); };
  request.onsuccess = () => {
   const db = request.result;
   if (failed || signal.aborted) { db.close(); if (!failed) reject(new DOMException('Cancelled', 'AbortError')); return; }
   try { assertCurrent?.(); } catch (error) { db.close(); reject(error); return; }
   if (!supportedCanonicalSchema(db)) { db.close(); reject(new Error('canonical-schema-invalid')); return; }
   try {
    const tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
    for (const storeName of Array.from(db.objectStoreNames)) {
     const store = tx.objectStore(storeName);
     if (store.keyPath !== 'key' || !store.indexNames.contains('scope') || store.index('scope').keyPath !== 'scope' || store.index('scope').unique) throw new Error('canonical-schema-invalid');
    }
   } catch (error) { db.close(); reject(error); return; }
   resolve(db);
  };
 });
}
/** Trusted host adapter helper: enqueue only IDB requests, invoke finish in a request callback; never await crypto, fetch or timers inside transaction. */
export async function canonicalHostTransaction<T>(authority: LocalHostAuthority, operation: HostOperation, stores: readonly string[], mode: IDBTransactionMode,
 enqueue: (tx: IDBTransaction, tuple: PersistentTuple | null, finish: (result: T) => void) => void,
 evidence?: { sent(): void; aborted(): void; completed(result: unknown): void }, assertAdditionalOwner?: () => void): Promise<T> {
 assertAdditionalOwner?.(); const initial = authority.captureRecord(operation); const db = await authority.openOperation(operation);
 try {
  authority.captureRecord(operation); authority.watchOperationDatabase(operation, db);
  const names = [...new Set([...stores, LOCAL_GRANT_STORE, 'canonicalProfiles', 'datasetControls', 'canonicalPeers', 'datasets', ...(initial.tuple?.provider ? ['canonicalProviderBindings'] : []), ...(initial.offline ? ['canonicalProviderArtifacts'] : [])])];
  return await new Promise<T>((resolve, reject) => {
   const tx = db.transaction(names, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); if (mode === 'readwrite') evidence?.sent(); let result: T | undefined, finished = false, finishing = false, failure: unknown;
   let unregister: (() => void) | undefined;
   const abort = () => { try { tx.abort(); } catch { /* completed */ } };
   try { unregister = authority.register(operation, tx); } catch (error) { failure = error; abort(); }
   operation.signal.addEventListener('abort', abort, { once: true }); if (operation.signal.aborted) abort();
   tx.onabort = () => { if (mode === 'readwrite') evidence?.aborted(); unregister?.(); operation.signal.removeEventListener('abort', abort); reject(failure ?? tx.error ?? new DOMException('Aborted', 'AbortError')); };
   tx.oncomplete = () => { if (mode === 'readwrite') evidence?.completed(result); unregister?.(); operation.signal.removeEventListener('abort', abort); try { assertAdditionalOwner?.(); authority.captureRecord(operation); if (!finished) throw new Error('host-transaction-incomplete'); resolve(result as T); } catch (error) { reject(error); } };
   const verify = (next: () => void) => {
    try {
     assertAdditionalOwner?.(); const captured = authority.captureRecord(operation), grant = tx.objectStore(LOCAL_GRANT_STORE).get('primary-local-context');
     grant.onsuccess = () => { try {
      assertAdditionalOwner?.(); authority.captureRecord(operation); const row = grant.result as Row | undefined;
      if (!row || row.key !== 'primary-local-context' || row.scope !== 'primary-local-context' || canonicalJson(row.value) !== canonicalJson(captured.grant)) throw new Error('host-grant-changed');
      if (!captured.tuple) { next(); return; }
      const tuple = captured.tuple, identity = key(tuple.scope.accountId, tuple.scope.libraryId), ns = key(tuple.scope.accountId, tuple.scope.libraryId, tuple.scope.epoch);
      const profile = tx.objectStore('canonicalProfiles').get(identity), control = tx.objectStore('datasetControls').get(identity), peer = tx.objectStore('canonicalPeers').get(tuple.scope.accountId);
      const manifestId = (tuple.manifest as { id: string }).id, manifest = tx.objectStore('datasets').get(key(ns, manifestId));
      const linked = tuple.provider;
      if (linked && linked.ownerNamespace !== captured.grant.namespaceId) throw new Error('provider-owner-changed');
      const binding = linked ? tx.objectStore('canonicalProviderBindings').get(key(linked.ownerNamespace, tuple.scope.accountId, tuple.scope.libraryId, tuple.scope.epoch)) : null;
      const offlineHeader = captured.offline ? tx.objectStore('canonicalProviderArtifacts').get(captured.offline.header.key) : null;
      const offlineGrant = captured.offline ? tx.objectStore('canonicalProviderArtifacts').get(captured.offline.grant.key) : null;
      let remaining = 4 + (binding ? 1 : 0) + (captured.offline ? 2 : 0); const check = () => { if (--remaining) return; try {
       authority.captureRecord(operation);
       const p = profile.result as Row | undefined, c = control.result as Row | undefined, d = peer.result as Row | undefined, m = manifest.result as Row | undefined;
       if (!p || p.scope !== tuple.scope.accountId || !c || c.scope !== identity || !d || d.scope !== tuple.scope.accountId || !m || m.scope !== ns
         || canonicalJson(p.value) !== canonicalJson(tuple.profile) || canonicalJson(c.value) !== canonicalJson(tuple.control)
         || canonicalJson(d.value) !== canonicalJson(tuple.peer) || canonicalJson(m.value) !== canonicalJson(tuple.manifest)) throw new Error('host-admission-changed');
       if (linked) {
        const row = binding?.result as Row | undefined;
        if (!row || row.key !== key(linked.ownerNamespace, tuple.scope.accountId, tuple.scope.libraryId, tuple.scope.epoch)
         || row.scope !== linked.ownerNamespace || canonicalJson(row.value) !== canonicalJson(linked.binding)
         || linked.binding.state !== 'active') throw new Error('provider-binding-changed');
       }
       if (captured.offline && (canonicalJson(offlineHeader?.result) !== canonicalJson(captured.offline.header)
         || canonicalJson(offlineGrant?.result) !== canonicalJson(captured.offline.grant))) throw new Error('offline-grant-changed');
       next();
      } catch (error) { failure = error; abort(); } };
      profile.onsuccess = check; control.onsuccess = check; peer.onsuccess = check; manifest.onsuccess = check;
      if (binding) binding.onsuccess = check;
      if (offlineHeader) offlineHeader.onsuccess = check;
      if (offlineGrant) offlineGrant.onsuccess = check;
     } catch (error) { failure = error; abort(); } };
    } catch (error) { failure = error; abort(); }
   };
   verify(() => { try { const captured = authority.captureRecord(operation); enqueue(tx, captured.tuple, value => {
    if (finishing) { failure = new Error('host-transaction-finished'); abort(); return; }
    finishing = true;
    const complete = () => { result = value; finished = true; };
    if (mode === 'readonly') {
     // The initial persisted tuple belongs to this same immutable readonly snapshot.
     // In-memory lifetime/owner checks remain mandatory at finish and oncomplete.
     try { assertAdditionalOwner?.(); authority.captureRecord(operation); complete(); }
     catch (error) { failure = error; abort(); }
    } else verify(complete);
   }); } catch (error) { failure = error; abort(); } });
  });
 } finally { authority.releaseOperationDatabase(operation, db); }
}
