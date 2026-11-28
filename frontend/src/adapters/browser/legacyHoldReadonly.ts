import { validateLegacyMigrationHold, type LegacyMigrationHold } from '../../runtime/edits/contracts.ts';

export const LEGACY_BACKUP_DATABASE_NAME = 'papeer-migration-backups';
const LEGACY_BACKUP_DATABASE_VERSION = 3;

/**
 * Readonly check of the migration hold. An absent database is clear and is never created; an existing database
 * whose hold store cannot be verified is an error (fail closed), never clear.
 */
export function readLegacyHoldRecordReadonly(signal: AbortSignal, factory: IDBFactory = indexedDB, name = LEGACY_BACKUP_DATABASE_NAME): Promise<LegacyMigrationHold | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    let request: IDBOpenDBRequest, tx: IDBTransaction | undefined, absent = false, settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const finish = (hold: LegacyMigrationHold | null) => { if (!settled) { settled = true; cleanup(); resolve(hold); } };
    const abort = () => {
      fail(new DOMException('Cancelled', 'AbortError'));
      try { tx?.abort(); } catch { /* completed */ }
      try { request?.transaction?.abort(); } catch { /* completed */ }
    };
    signal.addEventListener('abort', abort, { once: true });
    try { request = factory.open(name); } catch (error) { fail(error); return; }
    request.onupgradeneeded = () => {
      // Opening without a requested version upgrades only a missing database. Roll back its creation.
      absent = true;
      try { request.transaction!.abort(); } catch (error) { fail(error); }
    };
    request.onblocked = () => fail(new Error('legacy-hold-blocked'));
    request.onerror = () => {
      if (settled) return;
      if (signal.aborted) { abort(); return; }
      if (absent && request.error?.name === 'AbortError') finish(null);
      else fail(request.error ?? new Error('legacy-hold-open'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled || signal.aborted) { db.close(); fail(new DOMException('Cancelled', 'AbortError')); return; }
      if (db.version !== LEGACY_BACKUP_DATABASE_VERSION || !db.objectStoreNames.contains('holds')) { db.close(); fail(new Error('legacy-hold-unverifiable')); return; }
      let get: IDBRequest;
      try { tx = db.transaction('holds', 'readonly'); get = tx.objectStore('holds').get('origin'); } catch (error) { db.close(); fail(error); return; }
      tx.oncomplete = () => {
        db.close();
        if (signal.aborted) { abort(); return; }
        try { if (get.result === undefined) { finish(null); return; } validateLegacyMigrationHold(get.result); finish(get.result); } catch (error) { fail(error); }
      };
      tx.onabort = () => { db.close(); fail(signal.aborted ? new DOMException('Cancelled', 'AbortError') : tx?.error ?? new Error('legacy-hold-aborted')); };
    };
  });
}

/** BootstrapHostDriver uses normalized admission; the outer startup gate needs the actual validated record. */
export async function readLegacyHoldReadonly(signal: AbortSignal, factory: IDBFactory = indexedDB, name = LEGACY_BACKUP_DATABASE_NAME): Promise<'clear' | 'held'> {
  return await readLegacyHoldRecordReadonly(signal, factory, name) === null ? 'clear' : 'held';
}
