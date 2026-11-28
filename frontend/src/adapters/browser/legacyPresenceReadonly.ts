import { discoverLegacyIndexedDbNames, readLegacyLocalStorageEntries } from './legacySourceNames.ts';

type LegacyStorage = Pick<Storage, 'length' | 'key' | 'getItem'>;
const cancelled = () => new DOMException('Cancelled', 'AbortError');
const check = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };

function inquiry<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { check(signal); return action(); }).then(value => { check(signal); return value; })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Inspect the already-enumerated database without creating/upgrading it or reading document bodies. */
function databaseHasRecords(factory: IDBFactory, name: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    let request: IDBOpenDBRequest, db: IDBDatabase | undefined, tx: IDBTransaction | undefined, settled = false;
    const finish = (error: unknown, present = false) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort); db?.close();
      if (error) reject(error); else resolve(present);
    };
    const abort = () => { finish(cancelled()); try { tx?.abort(); } catch { /* completed */ } };
    signal.addEventListener('abort', abort, { once: true });
    try { request = factory.open(name); } catch (error) { finish(error); return; }
    request.onupgradeneeded = () => { try { request.transaction?.abort(); } finally { finish(new Error('backup-source-missing')); } };
    request.onblocked = () => finish(new Error('backup-database-blocked'));
    request.onerror = () => finish(request.error ?? new Error('backup-database-open'));
    request.onsuccess = () => {
      const opened = request.result;
      if (settled || signal.aborted) { opened.close(); finish(cancelled()); return; }
      db = opened;
      db.onversionchange = () => { finish(new Error('backup-source-changed')); try { tx?.abort(); } catch { /* completed */ } };
      const names = Array.from(db.objectStoreNames);
      if (db.version !== 1 || names.length !== 3 || ['libraries', 'files', 'annotations'].some(store => !names.includes(store))) {
        finish(new Error('legacy-database-unverifiable')); return;
      }
      try {
        tx = db.transaction(names, 'readonly');
        const counts = names.map(store => tx!.objectStore(store).count());
        tx.oncomplete = () => {
          if (signal.aborted) { finish(cancelled()); return; }
          if (counts.some(count => !Number.isSafeInteger(count.result) || count.result < 0)) { finish(new Error('legacy-database-unverifiable')); return; }
          finish(null, counts.some(count => count.result > 0));
        };
        tx.onabort = () => finish(tx?.error ?? new Error('legacy-database-read-aborted'));
      } catch (error) { finish(error); }
    };
  });
}

/** A bounded readonly presence check, not migration, adoption, backup or a claim that legacy writers stopped. */
export async function readLegacyWebPresenceReadonly(signal: AbortSignal,
  factory: IDBFactory = indexedDB, storage: LegacyStorage = localStorage): Promise<'clear' | 'legacy-present'> {
  check(signal);
  const localBefore = readLegacyLocalStorageEntries(storage);
  const names = await inquiry(signal, () => discoverLegacyIndexedDbNames(factory));
  let present = localBefore.length > 0;
  for (const name of names) { if (await databaseHasRecords(factory, name, signal)) present = true; }
  const after = await inquiry(signal, () => discoverLegacyIndexedDbNames(factory));
  check(signal);
  if (JSON.stringify(names) !== JSON.stringify(after) || JSON.stringify(localBefore) !== JSON.stringify(readLegacyLocalStorageEntries(storage))) {
    throw new Error('backup-source-changed');
  }
  return present ? 'legacy-present' : 'clear';
}
