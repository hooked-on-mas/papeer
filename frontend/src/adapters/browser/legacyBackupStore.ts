import { validateId, validateLegacyMigrationHold, type LegacyMigrationHold, type LegacyBackupEntry, type LegacyBackupManifest, type LegacyBackupPlan } from '../../runtime/edits/contracts.ts';
import { canonicalJson, EditRejected } from '../../runtime/edits/editModel.ts';
import { resourceHash } from '../../runtime/edits/contentPublication.ts';
import { assertLegacyBackupManifest, assertLegacyBackupPlan, type LegacyBackupObjectStore } from '../../migrations/legacyBackup.ts';
import { assertMigrationInputSet, type LegacyMigrationInputStore } from '../../migrations/legacyInputs.ts';
import type { LegacyMigrationInputSet } from '../../runtime/edits/contracts.ts';

/** Device-local immutable artifacts, separate from legacy input and active editing databases. */
export class IndexedDbLegacyBackupStore implements LegacyBackupObjectStore, LegacyMigrationInputStore {
  private factory: IDBFactory;
  private name: string;
  constructor(name = 'papeer-migration-backups', factory: IDBFactory = indexedDB) { this.name = name; this.factory = factory; }
  private open(signal?: AbortSignal): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const request = this.factory.open(this.name, 3);
      let failed = false;
      const fail = (reason: unknown) => { failed = true; signal?.removeEventListener('abort', abort); reject(reason); };
      const abort = () => fail(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request.onupgradeneeded = () => {
        if (failed) { request.transaction?.abort(); return; }
        for (const name of ['plans', 'objects', 'manifests', 'holds', 'inputs']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('backup-database-blocked'));
      request.onsuccess = () => { signal?.removeEventListener('abort', abort); if (failed) request.result.close(); else resolve(request.result); };
    });
  }
  private async write(run: (tx: IDBTransaction) => void): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['plans', 'objects', 'manifests', 'holds', 'inputs'], 'readwrite');
        let failure: unknown;
        const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { /* Already aborted. */ } };
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? tx.error ?? new Error('backup-transaction-aborted'));
        tx.onerror = () => { /* onabort settles the transaction. */ };
        try { run(tx); } catch (error) { abort(error); }
        tx.addEventListener('error', () => { failure ??= tx.error; });
      });
    } finally { db.close(); }
  }
  private async read<T>(store: string, key: IDBValidKey, signal?: AbortSignal): Promise<T | undefined> {
    const db = await this.open(signal);
    try {
      signal?.throwIfAborted();
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly'), request = tx.objectStore(store).get(key);
        const abort = () => { try { tx.abort(); } catch { /* Already settled. */ } };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
        tx.oncomplete = () => { cleanup(); resolve(request.result as T | undefined); };
        tx.onabort = () => { cleanup(); reject(signal?.aborted ? signal.reason : tx.error ?? request.error); };
      });
    } finally { db.close(); }
  }
  private immutable(tx: IDBTransaction, store: string, key: string, value: unknown) {
    const target = tx.objectStore(store), request = target.get(key);
    request.onsuccess = () => {
      if (request.result !== undefined) {
        if (canonicalJson(request.result) !== canonicalJson(value)) { tx.abort(); return; }
      } else target.add(value, key);
    };
  }
  async prepare(plan: LegacyBackupPlan): Promise<void> {
    const stable = structuredClone(plan); await assertLegacyBackupPlan(stable);
    await this.write(tx => this.immutable(tx, 'plans', stable.manifest.id, stable));
  }
  async putObject(entry: LegacyBackupEntry, value: Uint8Array): Promise<void> {
    const bytes = Uint8Array.from(value), stable = structuredClone(entry);
    if (bytes.byteLength !== stable.byteLength || await resourceHash(bytes) !== stable.sha256) throw new EditRejected('backup-object-hash');
    await this.write(tx => {
      const store = tx.objectStore('objects'), get = store.get(stable.sha256);
      get.onsuccess = () => {
        if (get.result === undefined) store.add(bytes.buffer, stable.sha256);
        else {
          const old = get.result instanceof ArrayBuffer ? new Uint8Array(get.result) : undefined;
          if (!old || old.length !== bytes.length || old.some((value, index) => value !== bytes[index])) tx.abort();
        }
      };
    });
  }
  async publish(manifest: LegacyBackupManifest): Promise<void> {
    const stable = structuredClone(manifest); await assertLegacyBackupManifest(stable);
    await this.write(tx => {
      const plan = tx.objectStore('plans').get(stable.id);
      plan.onsuccess = () => {
        if (!plan.result || canonicalJson(plan.result.manifest) !== canonicalJson(stable)) { tx.abort(); return; }
        for (const entry of stable.entries) {
          const object = tx.objectStore('objects').get(entry.sha256);
          object.onsuccess = () => { if (!(object.result instanceof ArrayBuffer) || object.result.byteLength !== entry.byteLength) tx.abort(); };
        }
        // Requests above and immutable publication share one native transaction. No WebCrypto await inside it.
        this.immutable(tx, 'manifests', stable.id, stable);
      };
    });
  }
  async plan(id: string): Promise<LegacyBackupPlan | undefined> {
    validateId(id);
    const value = await this.read<LegacyBackupPlan>('plans', id);
    if (value) { await assertLegacyBackupPlan(value); if (value.manifest.id !== id) throw new EditRejected('backup-plan-identity'); }
    return value;
  }
  async readHold(signal?: AbortSignal): Promise<LegacyMigrationHold | undefined> {
    const value = await this.read<LegacyMigrationHold>('holds', 'origin', signal);
    if (value !== undefined) validateLegacyMigrationHold(value); return value;
  }
  async hold(value: LegacyMigrationHold): Promise<void> {
    const stable = structuredClone(value); validateLegacyMigrationHold(stable);
    await this.write(tx => this.immutable(tx, 'holds', 'origin', stable));
  }
  async prepareInputs(value: LegacyMigrationInputSet): Promise<void> {
    const stable = structuredClone(value); await assertMigrationInputSet(stable);
    await this.write(tx => {
      const hold = tx.objectStore('holds').get('origin');
      hold.onsuccess = () => {
        if (canonicalJson(hold.result ?? null) !== canonicalJson({ version: 1, runId: stable.catalog.runId })) { tx.abort(); return; }
        this.immutable(tx, 'inputs', stable.catalog.runId, stable);
      };
    });
  }
  async inputs(runId: string): Promise<LegacyMigrationInputSet | undefined> {
    validateId(runId);
    const value = await this.read<LegacyMigrationInputSet>('inputs', runId);
    if (value !== undefined) {
      await assertMigrationInputSet(value);
      if (value.catalog.runId !== runId) throw new EditRejected('migration-input-set-identity');
    }
    return value;
  }
  async object(entry: LegacyBackupEntry): Promise<Uint8Array> {
    const value = await this.read<ArrayBuffer>('objects', entry.sha256);
    if (!(value instanceof ArrayBuffer)) throw new EditRejected('backup-object-missing');
    const bytes = new Uint8Array(value);
    if (bytes.byteLength !== entry.byteLength || await resourceHash(bytes) !== entry.sha256) throw new EditRejected('backup-object-hash');
    return bytes;
  }
  async reference(id: string): Promise<LegacyBackupManifest | undefined> {
    validateId(id);
    const value = await this.read<LegacyBackupManifest>('manifests', id);
    if (value) { await assertLegacyBackupManifest(value); if (value.id !== id) throw new EditRejected('backup-manifest-identity'); }
    return value;
  }
  async manifest(id: string): Promise<LegacyBackupManifest | undefined> {
    const value = await this.reference(id); if (value) for (const entry of value.entries) await this.object(entry); return value;
  }
}
