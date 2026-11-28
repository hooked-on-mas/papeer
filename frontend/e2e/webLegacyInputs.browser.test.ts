import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`fixed multi-source migration input set survives IDB abort, lost reply, reload and late input (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-legacy-inputs', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const names = { backup: 'inputs-fixture-' + crypto.randomUUID(), source: 'papeer-documents:inputs-fixture-' + crypto.randomUUID() };
  const saved = await page.evaluate(async names => {
    // @ts-expect-error -- Production common controller via Vite.
    const { prepareMigrationInputs } = await import('/src/migrations/legacyInputs.ts');
    // @ts-expect-error -- Production IndexedDB artifacts.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Production raw source collectors.
    const { LegacyLocalStorageBackup } = await import('/src/adapters/browser/legacyLocalStorage.ts');
    // @ts-expect-error -- Production raw source collector.
    const { LegacyIndexedDbBackup } = await import('/src/adapters/browser/legacyIndexedDb.ts');
    const create = (name: string, version: number, upgrade: (db: IDBDatabase, tx: IDBTransaction) => void) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, version); request.onupgradeneeded = () => upgrade(request.result, request.transaction!);
      request.onerror = () => reject(request.error); request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const hold = { version: 1, runId: crypto.randomUUID() }, peerId = crypto.randomUUID();
    await create(names.backup, 2, (db, tx) => {
      for (const name of ['plans', 'objects', 'manifests', 'holds']) db.createObjectStore(name);
      tx.objectStore('holds').put(hold, 'origin'); tx.objectStore('plans').put({ preserve: 'v2 artifact' }, 'preserve');
    });
    await create(names.source, 1, db => { db.createObjectStore('pending').put({ draft: '保全\ud800', bytes: new Uint8Array([0, 255]) }, 'raw'); });
    localStorage.setItem('papeer-note-session:pending', 'unchanged draft');
    const store = new IndexedDbLegacyBackupStore(names.backup);
    const ports = [new LegacyIndexedDbBackup('offline-input', names.source, indexedDB, store), new LegacyLocalStorageBackup('origin-input', localStorage, store)];
    const sources = [{ kind: 'browser-indexed-db', id: 'offline-input' }, { kind: 'browser-local-storage', id: 'origin-input' }];
    const discover = async () => ports.map((port, index) => ({ peerId, source: sources[index], port }));
    const catalog = { version: 1, runId: hold.runId, identity: { accountId: 'fixture', libraryId: crypto.randomUUID() }, peers: [{ id: peerId, sources }] };
    const nativeAdd = IDBObjectStore.prototype.add; let aborted = false;
    try {
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativeAdd.call(this, value, key); if (this.name === 'inputs') this.transaction.abort(); return request;
      };
      try { await prepareMigrationInputs(catalog, discover, store); } catch { aborted = true; }
    } finally { IDBObjectStore.prototype.add = nativeAdd; }
    if (!aborted || await store.inputs(hold.runId)) throw new Error('aborted input set became durable');
    const uncertain = { readHold: () => store.readHold(), inputs: (id: string) => store.inputs(id), prepareInputs: async (value: unknown) => { await store.prepareInputs(value); throw new Error('reply-lost'); } };
    let lost = false; try { await prepareMigrationInputs(catalog, discover, uncertain); } catch { lost = true; }
    const fixed = await store.inputs(hold.runId);
    if (!lost || !fixed) throw new Error('response loss erased durable input set');
    return { fixed, peerId };
  }, names);
  await page.reload();
  const evidence = await page.evaluate(async ({ names, fixed, peerId }) => {
    // @ts-expect-error -- Production common controller via Vite.
    const { prepareMigrationInputs, captureMigrationInputs } = await import('/src/migrations/legacyInputs.ts');
    // @ts-expect-error -- Production IndexedDB artifacts.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Production raw source collectors.
    const { LegacyLocalStorageBackup } = await import('/src/adapters/browser/legacyLocalStorage.ts');
    // @ts-expect-error -- Production raw source collector.
    const { LegacyIndexedDbBackup } = await import('/src/adapters/browser/legacyIndexedDb.ts');
    const store = new IndexedDbLegacyBackupStore(names.backup);
    const ports = [new LegacyIndexedDbBackup('offline-input', names.source, indexedDB, store), new LegacyLocalStorageBackup('origin-input', localStorage, store)];
    const found = ports.map((port, index) => ({ peerId, source: fixed.catalog.peers[0].sources[index], port })), discover = async () => found;
    const recovered = await prepareMigrationInputs(fixed.catalog, discover, store, () => { throw new Error('replaced durable plan'); });
    if (JSON.stringify(recovered) !== JSON.stringify(fixed)) throw new Error('reload changed inputs');
    const nativeAdd = IDBObjectStore.prototype.add; let aborted = false;
    try {
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativeAdd.call(this, value, key);
        if (this.name === 'manifests' && key === fixed.inputs[1].plan.manifest.id) this.transaction.abort(); return request;
      };
      try { await captureMigrationInputs(fixed, discover, store); } catch { aborted = true; }
    } finally { IDBObjectStore.prototype.add = nativeAdd; }
    if (!aborted || !await ports[0].load(fixed.inputs[0].plan.manifest.id) || await ports[1].load(fixed.inputs[1].plan.manifest.id)) throw new Error('partial input capture was not isolated');
    await captureMigrationInputs(fixed, discover, store);
    let missing = false; try { await captureMigrationInputs(fixed, async () => found.slice(1), store); } catch { missing = true; }
    if (!missing) throw new Error('missing source passed coverage');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(names.source); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put('late draft', 'late');
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    } finally { db.close(); }
    let late = false; try { await captureMigrationInputs(fixed, discover, store); } catch { late = true; }
    if (!late || localStorage.getItem('papeer-note-session:pending') !== 'unchanged draft') throw new Error('late input accepted or old draft changed');
    const artifacts = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(names.backup); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = artifacts.transaction('plans', 'readonly'), request = tx.objectStore('plans').get('preserve');
      const old = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); });
      if (JSON.stringify(old) !== JSON.stringify({ preserve: 'v2 artifact' })) throw new Error('v2 upgrade lost old backup');
      return { version: artifacts.version, inputs: fixed.inputs.length, late, missing, aborted };
    } finally { artifacts.close(); }
  }, { names, ...saved });
  assert.deepEqual(evidence, { version: 3, inputs: 2, late: true, missing: true, aborted: true });
});
}
