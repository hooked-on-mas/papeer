import type { LegacyBackupEntry, LegacyBackupKey, LegacyBackupManifest, LegacyBackupPlan } from '../../runtime/edits/contracts.ts';
import { EditRejected } from '../../runtime/edits/editModel.ts';
import { resourceHash } from '../../runtime/edits/contentPublication.ts';
import { assertLegacyBackupPlan, compareBackupKeys, legacyInventoryHash, type LegacyBackupObjectStore } from '../../migrations/legacyBackup.ts';
import { IndexedDbLegacyBackupStore } from './legacyBackupStore.ts';
import { StoredLegacyBackup, type LegacyBackupSink } from '../../migrations/storedLegacyBackup.ts';
import { encodeLegacyValue } from './legacyStructuredValue.ts';
import { isLegacyIndexedDbName } from './legacySourceNames.ts';
export { discoverLegacyIndexedDbNames } from './legacySourceNames.ts';

type IndexSchema = { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean };
type StoreSchema = { name: string; keyPath: string | string[] | null; autoIncrement: boolean; indexes: IndexSchema[] };

/** Atomic readonly snapshot of every store, including empty/unknown stores, before any old app initialization. */
export class LegacyIndexedDbBackup extends StoredLegacyBackup {
  private readonly name: string;
  private readonly factory: IDBFactory;
  constructor(sourceId: string, name: string, factory: IDBFactory = indexedDB, store: LegacyBackupObjectStore = new IndexedDbLegacyBackupStore()) {
    super({ kind: 'browser-indexed-db', id: sourceId }, store);
    if (!isLegacyIndexedDbName(name)) throw new EditRejected('backup-source-identity');
    this.name = name; this.factory = factory;
  }
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name); let failed = false;
      // Opening an absent DB would create it. Abort that creation; inventory must never alter legacy input.
      request.onupgradeneeded = () => { failed = true; request.transaction!.abort(); reject(new EditRejected('backup-source-missing')); };
      request.onerror = () => { failed = true; reject(request.error); };
      request.onblocked = () => { failed = true; reject(new EditRejected('backup-database-blocked')); };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) db.close();
        else { db.onversionchange = () => db.close(); resolve(db); }
      };
    });
  }
  protected async snapshot(id: string, sink?: LegacyBackupSink): Promise<LegacyBackupPlan> {
    const entries: LegacyBackupEntry[] = [], containers: LegacyBackupKey[] = [['objects'], ['stores']];
    const binaries = new Set<string>(), metadata: { schema: StoreSchema; path: string }[] = [];
    const add = async (key: LegacyBackupKey, bytes: Uint8Array) => {
      const entry = { key, sha256: await resourceHash(bytes), byteLength: bytes.byteLength };
      entries.push(entry); await sink?.(entry, bytes);
    };
    const db = await this.open();
    try {
      const names = Array.from(db.objectStoreNames);
      if (names.length) await new Promise<void>((resolve, reject) => {
        // Keep the single snapshot transaction alive while hashing, reading Blobs and awaiting the sink.
        // Advance cursors only inside a request callback, when the transaction is active. No record queue
        // or body cache survives an iteration: memory is bounded by the largest structured record.
        const tx = db.transaction(names, 'readonly');
        let running = true, finished = false, failure: unknown, advance: (() => void) | undefined;
        tx.oncomplete = () => finished ? resolve() : reject(new EditRejected('backup-source-read-aborted'));
        tx.onabort = () => { running = false; reject(failure ?? tx.error ?? new EditRejected('backup-source-read-aborted')); };
        tx.onerror = () => { /* The abort event settles the complete snapshot. */ };
        const fail = (error: unknown) => {
          failure = error; running = false;
          try { tx.abort(); } catch { reject(error); }
        };
        const keepAlive = () => {
          const request = tx.objectStore(names[0]).count('');
          request.onsuccess = () => {
            if (!running) return;
            try { const next = advance; advance = undefined; next?.(); if (running) keepAlive(); }
            catch (error) { fail(error); }
          };
        };
        const schemas = names.map(name => {
          const store = tx.objectStore(name);
          const indexes = Array.from(store.indexNames, name => {
            const index = store.index(name); return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          });
          return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
        });
        const startStore = async (index: number): Promise<void> => {
          if (!running) return;
          if (index === schemas.length) { finished = true; running = false; return; }
          const schema = schemas[index];
          // JSON escaping preserves damaged UTF-16 names without putting them in scalar manifest keys.
          const path = await resourceHash(new TextEncoder().encode(JSON.stringify(schema.name)));
          if (!running) return;
          metadata.push({ schema, path }); containers.push(['stores', path], ['stores', path, 'records']);
          advance = () => {
            const request = tx.objectStore(schema.name).openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { void startStore(index + 1).catch(fail); return; }
              void (async () => {
                const keyBytes = (await encodeLegacyValue(cursor.primaryKey)).bytes;
                const encoded = await encodeLegacyValue({ key: cursor.primaryKey, value: cursor.value });
                if (!running) return;
                await add(['stores', path, 'records', await resourceHash(keyBytes)], encoded.bytes);
                for (const [hash, bytes] of encoded.objects) {
                  if (!running) return;
                  if (!binaries.has(hash)) { await add(['objects', hash], bytes); binaries.add(hash); }
                }
                if (running) advance = () => cursor.continue();
              })().catch(fail);
            };
          };
        };
        keepAlive(); void startStore(0).catch(fail);
      });
      await add(['database.json'], new TextEncoder().encode(JSON.stringify({ format: 'papeer-legacy-indexed-db', version: 1, name: db.name, databaseVersion: db.version, stores: metadata })));
    } finally { db.close(); }
    entries.sort((a, b) => compareBackupKeys(a.key, b.key)); containers.sort(compareBackupKeys);
    const manifest: LegacyBackupManifest = { version: 1, id, source: structuredClone(this.source), entries, containers, inventorySha256: '' };
    manifest.inventorySha256 = await legacyInventoryHash(manifest);
    // Content identity, not an assertion that every old writer stopped or that a key generator is restorable.
    const plan = { manifest, observationSha256: manifest.inventorySha256 }; await assertLegacyBackupPlan(plan);
    return plan;
  }
}
