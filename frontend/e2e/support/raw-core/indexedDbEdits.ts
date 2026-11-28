// Test-only raw Core/migration fixture; never a production authorization port.
import type { ResourceMetadata, Snapshot, EditIntentRecord, DatasetManifest, DatasetControlRecord } from '../../../src/runtime/edits/contracts.ts';
import type { EditScope, ResourceInspectionPort } from '../../../src/runtime/edits/ports.ts';
import { canonicalJson } from '../../../src/runtime/edits/editModel.ts';
import { DurableEditRepository, scopeKey, type EditDatabase, type EditTransaction, type StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { datasetAccess, datasetIdentityKey, type DatasetAccess } from '../../../src/runtime/edits/datasetControl.ts';

import { CANONICAL_STORES as STORES, openCanonicalDatabase } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';
type StoredRow<T> = { key: string; scope: string; value: T };
const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed'));
});

/** Projection, batch, outbox receipt, and history use the same IndexedDB transaction. */
export class IndexedDbEditDatabase implements EditDatabase {
  private database?: Promise<IDBDatabase>;
  private readonly namespace: string;
  private readonly identity: string;
  private readonly name: string;
  private readonly factory: IDBFactory;
  private closed = false;
  constructor(scope: EditScope, name = 'papeer-shared-edits', factory: IDBFactory = indexedDB) {
    this.namespace = scopeKey(scope); this.identity = datasetIdentityKey(scope); this.name = name; this.factory = factory;
  }
  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('Edit database is closed'));
    if (this.database) return this.database;
    const pending = openCanonicalDatabase(this.factory, this.name).then(database => {
      if (this.closed) { database.close(); throw new Error('Edit database is closed'); }
      return database;
    });
    this.database = pending;
    void pending.catch(() => { if (this.database === pending) this.database = undefined; });
    return pending;
  }
  async close(): Promise<void> { this.closed = true; await this.database?.then(database => database.close(), () => undefined); }
  async transaction<T>(run: (transaction: EditTransaction) => Promise<T>): Promise<T> {
    const database = await this.open();
    const tx = database.transaction([...STORES], 'readwrite', { durability: 'strict' });
    const completion = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => { /* onabort is the authoritative transaction result. */ };
    });
    // Attach now, so a request failure cannot leave an unhandled rejection while abort is awaited.
    void completion.catch(() => undefined);
    const key = (id: string, scope?: EditScope) => {
      if (scope && datasetIdentityKey(scope) !== this.identity) throw new Error('dataset-scope');
      return JSON.stringify([scope ? scopeKey(scope) : this.namespace, id]);
    };
    const put = (store: typeof STORES[number], id: string, value: unknown) => {
      tx.objectStore(store).put({ key: key(id), scope: this.namespace, value });
    };
    const port: EditTransaction = {
      control: async () => (await request(tx.objectStore('datasetControls').get(this.identity)) as StoredRow<DatasetControlRecord> | undefined)?.value,
      access: async () => (await request(tx.objectStore('datasetAccess').get(this.identity)) as StoredRow<DatasetAccess> | undefined)?.value,
      putControl: record => {
        tx.objectStore('datasetControls').put({ key: this.identity, scope: this.identity, value: record });
        tx.objectStore('datasetAccess').put({ key: this.identity, scope: this.identity, value: datasetAccess(record) });
      },
      scopedState: async scope => {
        if (datasetIdentityKey(scope) !== this.identity) throw new Error('dataset-scope');
        const ns = scopeKey(scope);
        const rows = await Promise.all(['roots', 'edits', 'intents', 'datasets'].map(name => request(tx.objectStore(name).index('scope').getAll(ns))));
        return { roots: (rows[0] as StoredRow<Snapshot>[]).map(row => row.value), edits: (rows[1] as StoredRow<StoredEdit>[]).map(row => row.value),
          intents: (rows[2] as StoredRow<EditIntentRecord>[]).map(row => ({ targetId: JSON.parse(row.key)[1] as string, record: row.value })),
          datasets: (rows[3] as StoredRow<DatasetManifest>[]).map(row => row.value) };
      },
      putScopedEdit: (scope, edit) => {
        if (datasetIdentityKey(scope) !== this.identity) throw new Error('dataset-scope');
        const ns = scopeKey(scope);
        tx.objectStore('edits').put({ key: JSON.stringify([ns, edit.batch.id]), scope: ns, value: edit });
      },
      datasets: async () => (await request(tx.objectStore('datasets').index('scope').getAll(this.namespace)) as StoredRow<DatasetManifest>[]).map(row => row.value),
      putDataset: manifest => put('datasets', manifest.id, manifest),
      root: async id => (await request(tx.objectStore('roots').get(key(id))) as StoredRow<Snapshot> | undefined)?.value,
      intent: async id => (await request(tx.objectStore('intents').get(key(id))) as StoredRow<EditIntentRecord> | undefined)?.value,
      intents: async () => (await request(tx.objectStore('intents').index('scope').getAll(this.namespace)) as StoredRow<EditIntentRecord>[])
        .map(row => ({ targetId: JSON.parse(row.key)[1] as string, record: row.value })),
      putIntent: (id, record) => { if (record) put('intents', id, record); else tx.objectStore('intents').delete(key(id)); },
      roots: async () => (await request(tx.objectStore('roots').index('scope').getAll(this.namespace)) as StoredRow<Snapshot>[]).map(row => row.value),
      edits: async targetId => (await request(tx.objectStore('edits').index('scope').getAll(this.namespace)) as StoredRow<StoredEdit>[])
        .map(row => row.value).filter(edit => targetId === undefined || edit.batch.targetId === targetId),
      editById: async batchId => (await request(tx.objectStore('edits').get(key(batchId))) as StoredRow<StoredEdit> | undefined)?.value,
      putRoot: snapshot => put('roots', snapshot.id, snapshot),
      putEdit: edit => put('edits', edit.batch.id, edit),
      resource: async (id, scope) => (await request(tx.objectStore('resources').get(key(id, scope))) as StoredRow<ResourceMetadata> | undefined)?.value,
      resourceBytes: async (hash, scope) => (await request(tx.objectStore('resourceBytes').get(key(hash, scope))) as StoredRow<Uint8Array> | undefined)?.value,
      putResource: resource => {
        put('resources', resource.metadata.id, resource.metadata);
        put('resourceBytes', resource.metadata.sha256, resource.bytes);
      },
      hasCheckpoint: async hash => !!await request(tx.objectStore('checkpoints').get(key(hash))),
      rememberCheckpoint: hash => put('checkpoints', hash, true),
      pruneProjections: async (targetId, versions) => {
        type Projection = { id: string; version: string; pages?: string[]; deletedPages?: string[]; translation?: { pages: string[] } };
        const projections = await request(tx.objectStore('projections').index('scope').getAll(this.namespace)) as StoredRow<Projection>[];
        const retained = new Set<string>();
        for (const row of projections) if (row.value.id === targetId) {
          if (!versions.includes(row.value.version)) { tx.objectStore('projections').delete(row.key); continue; }
          for (const id of [...(row.value.pages ?? []), ...(row.value.deletedPages ?? []), ...(row.value.translation?.pages ?? [])]) retained.add(id);
        }
        const pages = await request(tx.objectStore('pages').index('scope').getAllKeys(this.namespace));
        for (const storedKey of pages) {
          const [, id] = JSON.parse(String(storedKey)) as [string, string];
          if (id.startsWith(`${targetId}:`) && !retained.has(id)) tx.objectStore('pages').delete(storedKey);
        }
      },
      putProjection: snapshot => {
        if (snapshot.kind !== 'document') { put('projections', `${snapshot.id}:${snapshot.version}`, snapshot); return; }
        // Unchanged pages keep their immutable identity; never serialize background PDF bytes per stroke.
        const project = (page: typeof snapshot.pages[number]) => {
          const pageKey = [snapshot.id, page.id, page.backgroundRevision, page.lifecycleVersion, page.annotationVersion].join(':');
          const existing = tx.objectStore('pages').get(key(pageKey));
          existing.onsuccess = () => {
            if (!existing.result) put('pages', pageKey, page);
            else if (canonicalJson(existing.result.value) !== canonicalJson(page)) tx.abort();
          };
          return pageKey;
        };
        put('projections', `${snapshot.id}:${snapshot.version}`, { ...snapshot, pages: snapshot.pages.map(project), deletedPages: snapshot.deletedPages.map(project),
          ...(snapshot.translation ? { translation: { ...snapshot.translation, pages: snapshot.translation.pages.map(project) } } : {}) });
      },
    };
    // Hashing resource bodies yields to WebCrypto. Keep this transaction alive until
    // validation and its marker/pointer writes finish, so no writer can race them.
    let running = true;
    const keepAlive = () => { if (running) tx.objectStore('datasetControls').get(this.identity).onsuccess = keepAlive; };
    keepAlive();
    try { const result = await run(port); running = false; await completion; return result; }
    catch (error) { running = false; try { tx.abort(); } catch { /* Already aborted or completed. */ } await completion.catch(() => undefined); throw error; }
  }
}
export function createIndexedDbEditRepository(scope: EditScope, name?: string, factory?: IDBFactory, inspection?: ResourceInspectionPort) {
  const database = new IndexedDbEditDatabase(scope, name, factory);
  return { repository: new DurableEditRepository(scope, database, inspection), close: () => database.close() };
}
