import type { LocalHostAuthority, HostOperation } from './localHostAuthority.ts';
import { canonicalJson } from '../../runtime/edits/editModel.ts';
/** Shared schema for the existing canonical database. No separate bootstrap database. */
export const CANONICAL_DATABASE_NAME = 'papeer-shared-edits';
export const CANONICAL_DATABASE_VERSION = 8;
export const PROVIDER_DATABASE_VERSION = 9;
export const CANONICAL_STORES = ['roots', 'edits', 'projections', 'pages', 'resources', 'resourceBytes', 'checkpoints', 'intents', 'datasets', 'datasetControls', 'datasetAccess'] as const;
export const BOOTSTRAP_STORES = ['canonicalPeers', 'canonicalProfiles', 'canonicalInitialIntents', 'canonicalInitialArtifacts'] as const;
export const LOCAL_GRANT_STORE = 'canonicalLocalGrant';
export const PROVIDER_STORES = ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts'] as const;
export const BASE_CANONICAL_STORES = [...CANONICAL_STORES, ...BOOTSTRAP_STORES, LOCAL_GRANT_STORE] as const;
export const ALL_CANONICAL_STORES = [...BASE_CANONICAL_STORES, ...PROVIDER_STORES] as const;
/** Version8 remains usable locally until explicit owner-controlled provider upgrade. */
export function supportedCanonicalSchema(db: IDBDatabase): boolean {
 return (db.version === CANONICAL_DATABASE_VERSION || db.version === PROVIDER_DATABASE_VERSION)
  && (db.version === 8 ? BASE_CANONICAL_STORES : ALL_CANONICAL_STORES).every(name => db.objectStoreNames.contains(name));
}

/** Explicit write-side open: upgrades the same database and preserves all existing rows. */
export function openCanonicalDatabase(factory: IDBFactory, name = CANONICAL_DATABASE_NAME): Promise<IDBDatabase> {
 return new Promise((resolve, reject) => {
  // No downgrade of an already provider-upgraded database. Normal local provision stays on schema8.
  const probe = factory.open(name); probe.onerror = () => reject(probe.error);
  probe.onsuccess = () => {
   const current = probe.result;
   if (current.version >= CANONICAL_DATABASE_VERSION) {
    if (!supportedCanonicalSchema(current)) { current.close(); reject(new Error('canonical-schema-invalid')); return; }
    current.onversionchange = () => current.close(); resolve(current); return;
   }
   current.close(); const opening = factory.open(name, CANONICAL_DATABASE_VERSION); let failed = false;
   opening.onupgradeneeded = () => { if (failed) { opening.transaction?.abort();return; } for (const storeName of BASE_CANONICAL_STORES) {
    if (opening.result.objectStoreNames.contains(storeName)) continue;
    const store = opening.result.createObjectStore(storeName, { keyPath: 'key' }); store.createIndex('scope', 'scope', { unique: false });
   } };
   opening.onblocked = () => { failed = true; reject(new Error('canonical-database-blocked')); };
   opening.onerror = () => reject(opening.error ?? new Error('canonical-database-open'));
   opening.onsuccess = () => { const db = opening.result; if (failed) { db.close(); return; } db.onversionchange = () => db.close(); resolve(db); };
  };
 });
}

/** Owner-controlled versionchange. The exact stored grant is checked INSIDE the upgrade transaction before any store is created. */
export function openProviderDatabase(factory: IDBFactory, name: string, authority: LocalHostAuthority, operation: HostOperation): Promise<IDBDatabase> {
 const captured = authority.captureRecord(operation);
 if (captured.family !== 'namespace-owner' || captured.tuple !== null) throw new Error('provider-upgrade-owner-invalid');
 const expected = captured.grant, signal = operation.signal;
 const assertOwner = () => { authority.captureRecord(operation); };
 const register = (tx: IDBTransaction) => authority.register(operation, tx);
 return new Promise((resolve, reject) => {
  assertOwner(); const request = factory.open(name, PROVIDER_DATABASE_VERSION); let failure: unknown, failed = false, unregister: (() => void) | undefined;
  const abort = () => { try { request.transaction?.abort(); } catch { /* settled */ } };
  signal.addEventListener('abort', abort, { once: true });
  const cleanup = () => { unregister?.(); signal.removeEventListener('abort', abort); };
  request.onupgradeneeded = event => {
   if (failed) { request.transaction?.abort();return; }
   const tx = request.transaction!;
   try {
    assertOwner(); unregister = register(tx);
    if (event.oldVersion !== CANONICAL_DATABASE_VERSION || !BASE_CANONICAL_STORES.every(name => request.result.objectStoreNames.contains(name))) throw new Error('provider-upgrade-source-invalid');
    const grant = tx.objectStore(LOCAL_GRANT_STORE).get('primary-local-context');
    grant.onsuccess = () => { try {
     assertOwner(); if (signal.aborted || !grant.result || grant.result.key !== 'primary-local-context' || grant.result.scope !== 'primary-local-context'
      || canonicalJson(grant.result.value) !== canonicalJson(expected)) throw new Error('provider-upgrade-owner-changed');
     for (const storeName of PROVIDER_STORES) { const store = request.result.createObjectStore(storeName, { keyPath: 'key' });store.createIndex('scope', 'scope', { unique: false }); }
     assertOwner();
    } catch (error) { failure = error; tx.abort(); } };
   } catch (error) { failure = error; tx.abort(); }
  };
  request.onblocked = () => { failed = true; cleanup();reject(new Error('provider-upgrade-blocked')); };
  request.onerror = () => { cleanup();reject(failure ?? request.error ?? new Error('provider-upgrade-failed')); };
  request.onsuccess = () => {
   cleanup(); const db = request.result;
   if (failed) { db.close();return; }
   try { assertOwner(); if (!supportedCanonicalSchema(db) || db.version !== PROVIDER_DATABASE_VERSION) throw new Error('provider-schema-invalid'); }
   catch (error) { db.close(); reject(error);return; }
   // Already-upgraded database still requires the same exact owner before delivery.
   const tx = db.transaction(LOCAL_GRANT_STORE, 'readonly'), grant = tx.objectStore(LOCAL_GRANT_STORE).get('primary-local-context');
   tx.onabort = () => { db.close();reject(tx.error); };
   tx.oncomplete = () => { try { assertOwner(); if (!grant.result || canonicalJson(grant.result.value) !== canonicalJson(expected)) throw new Error('provider-upgrade-owner-changed');
    db.onversionchange = () => db.close();resolve(db); } catch (error) { db.close();reject(error); } };
  };
 });
}

export type ReadonlyCanonicalOpen = { status: 'uninitialized' } | { status: 'ready'; database: IDBDatabase };
/** No version argument; abort creation and never upgrade a pre-existing database. */
export function openCanonicalReadonly(factory: IDBFactory, name = CANONICAL_DATABASE_NAME): Promise<ReadonlyCanonicalOpen> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(name); let created = false, failed = false;
    opening.onupgradeneeded = () => { created = true; opening.transaction?.abort(); };
    opening.onblocked = () => { failed = true; reject(new Error('canonical-database-blocked')); };
    opening.onerror = () => {
      if (failed) return;
      if (created && opening.error?.name === 'AbortError') resolve({ status: 'uninitialized' });
      else reject(opening.error ?? new Error('canonical-database-open'));
    };
    opening.onsuccess = () => {
      const db = opening.result; if (failed) { db.close(); return; }
      if (!supportedCanonicalSchema(db)) {
        db.close(); resolve({ status: 'uninitialized' }); return;
      }
      db.onversionchange = () => db.close(); resolve({ status: 'ready', database: db });
    };
  });
}
