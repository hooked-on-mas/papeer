import { ALL_CANONICAL_STORES, PROVIDER_DATABASE_VERSION, supportedCanonicalSchema } from '../canonicalIndexedDbSchema.ts';
import { LocalHostAuthority } from '../localHostAuthority.ts';
import type { HostLease } from '../../../features/bootstrap/bootstrapPorts.ts';
import { openExisting } from '../canonicalHostTransaction.ts';

/** Fixed production partition. Never request versionchange on the existing local database. */
export const CLOUD_PROVIDER_DATABASE_NAME = 'papeer-shared-cloud-v1';
const hostLock = 'papeer-shared-cloud-v1:host';
const cancelled = () => new DOMException('Cancelled', 'AbortError');

/** Fresh schema9 only. An occupied older/unknown cache is refused, never migrated or reset. */
function openCloudSchema(signal: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const request = indexedDB.open(CLOUD_PROVIDER_DATABASE_NAME, PROVIDER_DATABASE_VERSION);
    let failure: unknown, blocked = false;
    const abort = () => {
      failure ??= cancelled();
      try { request.transaction?.abort(); } catch { /* A completed transaction cannot be cancelled. */ }
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    request.onblocked = () => {
      // IDBOpenDBRequest cannot be cancelled before upgrade. Keep the host lock
      // until this exact request actually settles; do not queue another opener.
      blocked = true; failure = new Error('cloud-cache-blocked');
    };
    request.onupgradeneeded = event => {
      const tx = request.transaction!;
      try {
        if (blocked || signal.aborted) throw failure ?? cancelled();
        if (event.oldVersion !== 0) throw new Error('cloud-cache-version-unsupported');
        for (const name of ALL_CANONICAL_STORES) {
          const store = request.result.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('scope', 'scope', { unique: false });
        }
        if (signal.aborted) throw cancelled();
      } catch (error) { failure = error; tx.abort(); }
    };
    request.onerror = () => { cleanup(); reject(failure ?? request.error ?? new Error('cloud-cache-open-failed')); };
    request.onsuccess = () => {
      cleanup(); const db = request.result;
      try {
        if (blocked || signal.aborted) throw failure ?? cancelled();
        if (db.version !== PROVIDER_DATABASE_VERSION || !supportedCanonicalSchema(db)
          || db.objectStoreNames.length !== ALL_CANONICAL_STORES.length) throw new Error('cloud-cache-schema-invalid');
        const tx = db.transaction([...ALL_CANONICAL_STORES], 'readonly');
        for (const name of ALL_CANONICAL_STORES) {
          const store = tx.objectStore(name);
          if (store.keyPath !== 'key' || !store.indexNames.contains('scope') || store.index('scope').keyPath !== 'scope'
            || store.index('scope').unique) throw new Error('cloud-cache-schema-invalid');
        }
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error('cloud-cache-schema-invalid')); };
        tx.oncomplete = () => {
          if (signal.aborted) { db.close(); reject(cancelled()); }
          else { db.onversionchange = () => db.close(); resolve(db); }
        };
      } catch (error) { db.close(); reject(error); }
    };
  });
}

export type CloudProviderCacheOwner = Readonly<{
  authority: LocalHostAuthority;
  lease: HostLease;
  /** The host first drains its runtime/resources/replication, then releases this owner. */
  close(): Promise<void>;
}>;

/** Internal fixed host composition only: no names, authority, grant or verifier are caller inputs.
 * First product policy permits one cloud host per origin/storage partition. Other tabs
 * can keep using their existing local database; no legacy watcher is asked to close.
 */
export async function acquireCloudProviderCache(signal: AbortSignal, mode: 'online' | 'existing-only' = 'online'): Promise<CloudProviderCacheOwner> {
  if (signal.aborted) throw cancelled();
  if (!navigator.locks) throw new Error('cloud-cache-locks-unavailable');
  let deliver!: (owner: CloudProviderCacheOwner) => void;
  let fail!: (reason: unknown) => void;
  const acquired = new Promise<CloudProviderCacheOwner>((resolve, reject) => { deliver = resolve; fail = reject; });
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  let published = false;
  const abortAcquisition = () => { if (!published) fail(cancelled()); };
  signal.addEventListener('abort', abortAcquisition, { once: true });
  // Web Locks forbids combining ifAvailable with signal. The callback/opening
  // checks the acquisition signal; no queued/steal request exists here.
  const flight = navigator.locks.request(hostLock, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('cloud-cache-in-use');
    let authority: LocalHostAuthority | undefined;
    try {
      const db = mode === 'existing-only' ? await openExisting(indexedDB, CLOUD_PROVIDER_DATABASE_NAME, signal) : await openCloudSchema(signal);
      try {
        if (db.version !== PROVIDER_DATABASE_VERSION || db.objectStoreNames.length !== ALL_CANONICAL_STORES.length)
          throw new Error('cloud-cache-schema-invalid');
      } finally { db.close(); }
      authority = new LocalHostAuthority(indexedDB, CLOUD_PROVIDER_DATABASE_NAME);
      const context = await authority.discover(signal);
      const lease = context.status === 'ready' ? context.lease
        : mode === 'online' && context.status === 'setup-required' && context.reason === 'absent' ? await authority.provision(signal)
        : (() => { throw new Error('cloud-cache-owner-recovery-required'); })();
      authority.captureRecord(authority.captureNamespaceOwner(lease, signal));
      if (signal.aborted) throw cancelled();
      const owned = authority;
      let closing: Promise<void> | undefined;
      published = true; signal.removeEventListener('abort', abortAcquisition);
      deliver(Object.freeze({ authority: owned, lease, close: () => closing ??= Promise.resolve().then(() => {
        owned.close(); release();
      }).then(() => flight) }));
      await lifetime;
    } finally { authority?.close(); }
  });
  void flight.catch(fail).finally(() => signal.removeEventListener('abort', abortAcquisition));
  return acquired;
}
