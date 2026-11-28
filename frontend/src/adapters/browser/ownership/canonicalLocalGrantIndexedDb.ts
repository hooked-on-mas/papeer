import { assertLocalOwnerGrant, makeLocalOwnerGrant, type CanonicalLocalOwnerGrant } from '../../../runtime/edits/canonicalLocalGrant.ts';
import { CANONICAL_DATABASE_NAME, CANONICAL_DATABASE_VERSION, LOCAL_GRANT_STORE, openCanonicalDatabase, supportedCanonicalSchema } from '.././canonicalIndexedDbSchema.ts';

const KEY = 'primary-local-context';
type Discovery = { status: 'ready'; grant: CanonicalLocalOwnerGrant } | { status: 'setup-required'; reason: 'absent' | 'schema-upgrade' } | { status: 'recovery-required'; reason: string } | { status: 'blocked'; reason: string };
type Row = { key: string; scope: string; value: unknown };
const check = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };

/** Open without a version; abort an implicit create and close a late success. */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name); let created = false, failed = false;
    request.onupgradeneeded = () => { created = true; request.transaction?.abort(); };
    request.onblocked = () => { failed = true; reject(new Error('canonical-database-blocked')); };
    request.onerror = () => { if (failed) return; if (created && request.error?.name === 'AbortError') resolve(null); else reject(request.error ?? new Error('storage-error')); };
    request.onsuccess = () => { if (failed) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

/** Atomic snapshot; readwrite locks all existing stores during occupancy check and insert. */
function inspect(db: IDBDatabase, write: boolean, signal: AbortSignal): Promise<CanonicalLocalOwnerGrant | null> {
  check(signal);
  const names = Array.from(db.objectStoreNames), hasGrant = names.includes(LOCAL_GRANT_STORE);
  if (!names.length) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, write ? 'readwrite' : 'readonly'); let failure: unknown, result: CanonicalLocalOwnerGrant | null = null;
    const cancel = () => { try { tx.abort(); } catch { /* already complete */ } };
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    tx.onabort = () => { signal.removeEventListener('abort', cancel); reject(failure ?? tx.error ?? new DOMException('Aborted', 'AbortError')); };
    tx.oncomplete = () => { signal.removeEventListener('abort', cancel); try { check(signal); resolve(result); } catch (error) { reject(error); } };
    const counts = names.filter(n => n !== LOCAL_GRANT_STORE).map(n => tx.objectStore(n).count());
    const grantStore = hasGrant ? tx.objectStore(LOCAL_GRANT_STORE) : null;
    const keys = grantStore ? grantStore.getAllKeys(undefined, 2) : null;
    const row = grantStore ? grantStore.get(KEY) : null;
    const finish = row ?? counts[counts.length - 1];
    if (!finish) { if (write) { failure = new Error('recovery-required'); cancel(); } return; }
    finish.onsuccess = () => {
      try {
        check(signal);
        if (grantStore && (grantStore.keyPath !== 'key' || !grantStore.indexNames.contains('scope') || grantStore.index('scope').keyPath !== 'scope' || grantStore.index('scope').unique)) throw new Error('recovery-required');
        const grantKeys = keys?.result ?? [];
        if (grantKeys.length) {
          if (grantKeys.length !== 1 || grantKeys[0] !== KEY || !row?.result) throw new Error('recovery-required');
          const value = row.result as Row;
          if (value.key !== KEY || value.scope !== KEY) throw new Error('recovery-required');
          assertLocalOwnerGrant(value.value); result = structuredClone(value.value); return;
        }
        if (counts.some(count => count.result !== 0)) throw new Error('ungranted-canonical-state');
        if (write) {
          if (!hasGrant) throw new Error('recovery-required');
          result = makeLocalOwnerGrant(() => crypto.randomUUID());
          tx.objectStore(LOCAL_GRANT_STORE).add({ key: KEY, scope: KEY, value: result });
        }
      } catch (error) { failure = error; cancel(); }
    };
  });
}

/** Readonly discovery never creates or upgrades the DB. */
export async function discoverLocalGrant(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME, signal: AbortSignal = new AbortController().signal): Promise<Discovery> {
  check(signal); let db: IDBDatabase | null = null;
  try {
    db = await openExisting(factory, name); check(signal);
    if (!db) return { status:'setup-required', reason:'absent' };
    const grant = await inspect(db, false, signal); check(signal);
    if (db.version >= 8 && !supportedCanonicalSchema(db)) return { status:'recovery-required', reason:'schema-invalid' };
    if (grant) { if (db.version < 8) return { status:'recovery-required', reason:'schema-invalid' }; return { status:'ready', grant }; }
    return { status:'setup-required', reason: db.version < CANONICAL_DATABASE_VERSION ? 'schema-upgrade' : 'absent' };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message === 'canonical-database-blocked') return { status:'blocked', reason:'database-blocked' };
    return { status:'recovery-required', reason: message === 'ungranted-canonical-state' ? message : 'storage-error' };
  } finally { db?.close(); }
}

/** Called only by an explicit, host-authorized local provision operation. */
export async function provisionLocalGrant(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME, signal: AbortSignal = new AbortController().signal): Promise<CanonicalLocalOwnerGrant> {
  check(signal); const db = await openCanonicalDatabase(factory, name);
  try { check(signal); if (!supportedCanonicalSchema(db)) throw new Error('recovery-required'); const grant = await inspect(db, true, signal); check(signal); if (!grant) throw new Error('recovery-required'); return grant; }
  finally { db.close(); }
}
