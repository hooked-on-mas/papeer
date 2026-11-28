import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`legacy offline PDF/annotations survive raw IndexedDB backup, reload, abort and concurrent input (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-legacy-idb-backup', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const suffix = crypto.randomUUID(), sourceName = 'papeer-documents:/fixture/' + suffix, backupName = 'backup-idb-fixture-' + suffix;
  const pdf = Array.from(readFileSync(path.resolve(frontend, '../tests/fixtures/sample.pdf')));
  const saved = await page.evaluate(async ({ sourceName, backupName, pdf }) => {
    // @ts-expect-error -- Vite executes the actual legacy input adapter.
    const { OfflineLibraryStore } = await import('/src/web/offlineLibrary.ts');
    // @ts-expect-error -- Vite loads production source collector against native IndexedDB.
    const { LegacyIndexedDbBackup, discoverLegacyIndexedDbNames } = await import('/src/adapters/browser/legacyIndexedDb.ts');
    // @ts-expect-error -- Vite browser module.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Vite common verified capture entry.
    const { captureLegacyBackup } = await import('/src/migrations/legacyBackup.ts');
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const store = new IndexedDbLegacyBackupStore(backupName);
    const missing = sourceName + '/missing', absent = new LegacyIndexedDbBackup('missing', missing, indexedDB, store);
    let missingRejected = false; try { await absent.inventory(crypto.randomUUID()); } catch { missingRejected = true; }
    expect(missingRejected && !(await indexedDB.databases()).some(db => db.name === missing), 'inventory created a missing database');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(sourceName, 1);
      request.onupgradeneeded = () => {
        for (const name of ['libraries', 'files', 'annotations']) request.result.createObjectStore(name);
        request.result.createObjectStore('empty'); const indexed = request.result.createObjectStore('extra', { keyPath: 'id' });
        indexed.createIndex('by-owner', ['owner', 'id'], { unique: false });
        const raw = request.result.createObjectStore('raw');
        const value: any = { buffer: new Uint8Array([0, 255, 127, 128]).buffer, text: '\ud800😀', id: 23n, when: new Date(42), list: new Array(3) };
        value.view = new Uint8Array(value.buffer, 1, 2); value.self = value; value.map = new Map([[value, new Set([value])]]);
        raw.add(value, [new Date(100), 'compound-key', new Uint8Array([7, 8]).buffer]);
        indexed.add({ id: 'note', owner: 'paper', draft: 'must survive' });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); db.close();
    const legacy = new OfflineLibraryStore(sourceName), file = { id: 'pdf-version', sha256: 'a'.repeat(64), size: pdf.length, mime: 'application/pdf' };
    await legacy.saveLibrary('library', { version: 1, revision: 'source-7', updated_at: '2026-10-25T00:00:00Z', items: [], attachments: [], files: {} });
    await legacy.saveFile('library', file, new Blob([new Uint8Array(pdf)], { type: file.mime }));
    await legacy.saveAnnotation('library', 'local:acknowledged', { operationId: 'acknowledged', ink: ['未送信\ud800', { width: -0 }], malformed: '{bad JSON' });
    await legacy.saveAnnotation('library', 'list', [{ id: 'remote', name: 'ink-remote.json', size: '0' }]);
    const port = new LegacyIndexedDbBackup('offline-fixture', sourceName, indexedDB, store), plan = await port.inventory(crypto.randomUUID());
    await store.prepare(plan);
    const discovered = await discoverLegacyIndexedDbNames();
    expect(discovered.includes(sourceName) && !discovered.includes(backupName), 'discovery skipped old source or included existing backup output');
    const nativeTransaction = IDBDatabase.prototype.transaction, nativeAdd = IDBObjectStore.prototype.add; let sourceWrites = 0, aborted = false;
    try {
      IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
        if (this.name === sourceName && args[1] !== 'readonly') { sourceWrites++; throw new Error('backup wrote to source'); }
        return nativeTransaction.apply(this, args);
      };
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativeAdd.call(this, value, key);
        if (this.name === 'manifests' && key === plan.manifest.id) this.transaction.abort(); return request;
      };
      try { await captureLegacyBackup(port, plan); } catch { aborted = true; }
      expect(aborted && !await port.load(plan.manifest.id), 'aborted publication leaked completion');
      expect(!!await port.plan(plan.manifest.id) && sourceWrites === 0, 'abort lost fixed plan or modified source');
      expect(JSON.stringify(await port.inventory(plan.manifest.id)) === JSON.stringify(plan), 'abort changed original records');
    } finally { IDBDatabase.prototype.transaction = nativeTransaction; IDBObjectStore.prototype.add = nativeAdd; }
    return { plan, file };
  }, { sourceName, backupName, pdf });
  await page.reload();
  const evidence = await page.evaluate(async ({ sourceName, backupName, pdf, plan, file }) => {
    // @ts-expect-error -- Vite executes production adapters.
    const { LegacyIndexedDbBackup } = await import('/src/adapters/browser/legacyIndexedDb.ts');
    // @ts-expect-error -- Vite browser import.
    const { OfflineLibraryStore } = await import('/src/web/offlineLibrary.ts');
    // @ts-expect-error -- Vite browser import.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Vite verified raw-value reader.
    const { decodeLegacyValue } = await import('/src/adapters/browser/legacyStructuredValue.ts');
    // @ts-expect-error -- Vite common capture/read entry used by both hosts.
    const { captureLegacyBackup, readLegacyBackupEntry } = await import('/src/migrations/legacyBackup.ts');
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const store = new IndexedDbLegacyBackupStore(backupName), port = new LegacyIndexedDbBackup('offline-fixture', sourceName, indexedDB, store);
    const legacy = new OfflineLibraryStore(sourceName);
    try {
      expect(JSON.stringify(await port.plan(plan.manifest.id)) === JSON.stringify(plan), 'reload lost fixed source plan');
      const uncertain = { inventory: port.inventory, plan: port.plan, load: port.load, assertCurrent: port.assertCurrent, object: port.object,
        capture: async (input: any) => { await port.capture(input); throw new Error('response-lost'); } };
      let lost = false; try { await captureLegacyBackup(uncertain, plan); } catch { lost = true; }
      expect(lost && !!await port.load(plan.manifest.id), 'response loss erased completed backup');
      const manifest = await captureLegacyBackup(port, plan);
      const metadata = JSON.parse(new TextDecoder().decode(await readLegacyBackupEntry(port, manifest, ['database.json'])));
      expect(metadata.name === sourceName && metadata.databaseVersion === 1 && metadata.stores.length === 6, 'schema identity/stores changed');
      const decoded = new Map<string, any[]>();
      for (const { schema, path } of metadata.stores) {
        const records = [];
        for (const entry of manifest.entries.filter((entry: any) => entry.key[0] === 'stores' && entry.key[1] === path)) {
          records.push(await decodeLegacyValue(await readLegacyBackupEntry(port, manifest, entry.key), async (hash: string) => readLegacyBackupEntry(port, manifest, ['objects', hash])));
        }
        decoded.set(schema.name, records);
        if (schema.name === 'extra') expect(JSON.stringify(schema.indexes[0].keyPath) === '["owner","id"]' && schema.keyPath === 'id', 'indexes/keyPath not retained');
      }
      expect(decoded.get('empty')?.length === 0, 'empty store disappeared');
      expect(decoded.get('annotations')?.some(row => row.value.operationId === 'acknowledged' && row.value.ink[0] === '未送信\ud800' && Object.is(row.value.ink[1].width, -0)), 'acknowledged/raw annotations changed');
      const raw = decoded.get('raw')![0];
      expect(raw.key[0].getTime() === 100 && raw.key[1] === 'compound-key' && new Uint8Array(raw.key[2])[1] === 8, 'compound primary key changed');
      expect(raw.value.self === raw.value && raw.value.view.buffer === raw.value.buffer && raw.value.view[0] === 255 && raw.value.id === 23n, 'structured references or binary data changed');
      expect(raw.value.map.get(raw.value).has(raw.value) && !(0 in raw.value.list), 'graph identities or sparse array lost');
      expect(JSON.stringify(Array.from(new Uint8Array(decoded.get('files')![0].value))) === JSON.stringify(pdf), 'cached PDF body changed');
      const originalPdf = new Uint8Array(await (await legacy.file('library', file)).arrayBuffer());
      expect(JSON.stringify(Array.from(originalPdf)) === JSON.stringify(pdf) && (await legacy.libraries())[0].manifest.revision === 'source-7', 'backup altered offline readability');
      await port.assertCurrent(plan);
      const drift = await port.inventory(crypto.randomUUID()), put = store.putObject.bind(store); let lateWrite: Promise<void> | undefined;
      store.putObject = async (entry: any, bytes: Uint8Array) => {
        // The writer waits behind the readonly snapshot, then commits before the final current-input check.
        lateWrite ??= legacy.saveAnnotation('library', 'local:late', { draft: 'arrived during capture' });
        await put(entry, bytes);
      };
      let rejected = false; try { await captureLegacyBackup(port, drift); } catch { rejected = true; }
      await lateWrite;
      store.putObject = put;
      expect(rejected && !await port.load(drift.manifest.id) && !!await port.plan(drift.manifest.id), 'late source leaked completion or erased plan');
      expect(!!await port.load(plan.manifest.id) && (await legacy.annotation('library', 'local:late')).draft === 'arrived during capture', 'late input/old snapshot was discarded');
      const next = await port.inventory(crypto.randomUUID()); let count = 0;
      store.putObject = async (entry: any, bytes: Uint8Array) => { if (++count === 2) throw new DOMException('capacity', 'QuotaExceededError'); await put(entry, bytes); };
      let quota = false; try { await captureLegacyBackup(port, next); } catch { quota = true; } store.putObject = put;
      expect(quota && !await port.load(next.manifest.id) && !!await port.plan(next.manifest.id), 'quota lost plan or published partial data');
      await captureLegacyBackup(port, next); await port.assertCurrent(next);
      // Completed artifacts remain readable even after the original database disappears.
      await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(sourceName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
      expect(!!await port.load(next.manifest.id), 'artifact still depends on original source');
      return ['readonly input', 'missing DB creation aborted', 'schema/empty stores', 'PDF bytes', 'acknowledged/raw annotations', 'structured identities', 'native abort/reload', 'response loss', 'late writer', 'quota/retry', 'source-independent artifact'];
    } finally {
      for (const name of [sourceName, backupName]) await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('fixture-database-blocked'));
      });
    }
  }, { sourceName, backupName, pdf, ...saved });
  assert.equal(evidence.length, 11);
  await page.evaluate(async ({ sourceName, blobRecords }) => {
    // @ts-expect-error -- Vite browser module.
    const { LegacyIndexedDbBackup } = await import('/src/adapters/browser/legacyIndexedDb.ts');
    // @ts-expect-error -- Vite browser hash implementation.
    const { resourceHash } = await import('/src/runtime/edits/contentPublication.ts');
    const name = sourceName + '/stream', count = 12, size = 512 * 1024;
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('records'); request.result.createObjectStore('empty');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error(`stream fixture creation: ${request.error}`));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        for (let i = 0; i < count; i++) {
          const bytes = new Uint8Array(size).fill(i);
          tx.objectStore('records').add(blobRecords ? new Blob([bytes]) : bytes.buffer, i);
        }
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(`stream fixture seed: ${tx.error}`));
      });
    } finally { db.close(); }
    let fixed: any, published: any, tx: IDBTransaction | undefined, read = 0, saved = 0, abort = true, prepared = false;
    const nativeTransaction = IDBDatabase.prototype.transaction;
    const descriptor = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, 'value')!;
    const store = {
      prepare: async (plan: any) => { fixed = structuredClone(plan); prepared = true; },
      putObject: async (entry: any, bytes: Uint8Array) => {
        expect(prepared, 'record reached sink before durable plan');
        expect(await resourceHash(bytes) === entry.sha256, 'streamed body hash changed');
        if (entry.key[0] !== 'objects') return;
        expect(bytes.byteLength === size, 'binary body changed');
        // No body is retained by this sink. A delayed sink must stop cursor progress.
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(read === saved + 1, 'more than one record is outstanding');
        saved++;
        if (abort && saved === 2) tx!.abort();
      },
      publish: async (manifest: any) => { published = structuredClone(manifest); },
      plan: async () => structuredClone(fixed), manifest: async () => structuredClone(published),
      reference: async () => structuredClone(published), object: async () => { throw new Error('discard sink'); },
    };
    try {
      const port = new LegacyIndexedDbBackup('bounded-fixture', name, indexedDB, store);
      const plan = await port.inventory(crypto.randomUUID()).catch((error: unknown) => { throw new Error(`stream inventory: ${String(error)}`); });
      IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
        const result = nativeTransaction.apply(this, args);
        if (this.name === name && !tx) { expect(prepared, 'source snapshot started before durable plan'); tx = result; }
        return result;
      };
      Object.defineProperty(IDBCursorWithValue.prototype, 'value', { ...descriptor, get(this: IDBCursorWithValue) {
        if (this.source instanceof IDBObjectStore && this.source.transaction === tx) {
          expect(read === saved, 'collector fetched another record before persisting its predecessor'); read++;
        }
        return descriptor.get!.call(this);
      } });
      let failed = false; try { await port.capture(plan); } catch { failed = true; }
      expect(failed && !published && JSON.stringify(fixed) === JSON.stringify(plan), 'source abort published completion or lost plan');
      expect(read === 2 && saved === 2, 'source abort did not stop cursor');
      abort = false; tx = undefined; read = 0; saved = 0; prepared = false;
      try { await port.capture(plan); } catch (error) { throw new Error(`stream retry failed after ${read} reads/${saved} saves: ${String(error)}`); }
      expect(read === count && saved === count, 'retry skipped or queued records');
      expect(JSON.stringify(published) === JSON.stringify(plan.manifest), 'retry changed fixed artifact');
    } finally {
      IDBDatabase.prototype.transaction = nativeTransaction; Object.defineProperty(IDBCursorWithValue.prototype, 'value', descriptor);
      await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
  // Windows Playwright WebKit rejects Blob/File persistence even in ordinary readwrite transactions
  // (UnknownError: Error preparing Blob/File data). Cover its native buffer path and test Blob reads
  // in Chromium; WebKit on other platforms still exercises the Blob path.
  }, { sourceName, blobRecords: engine === 'chromium' || process.platform !== 'win32' });
});
}
