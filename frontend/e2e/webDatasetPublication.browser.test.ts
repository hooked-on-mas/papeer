import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`completed dataset: real PDF inspection, manifest-last publication, atomic IDB import, upgrade and restart (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-dataset-publication', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-edits.json'), 'utf8'));
  const pdfBytes = [...readFileSync(path.resolve(frontend, '../tests/fixtures', fixture.resource.file))];
  const evidence = await page.evaluate(async ({ fixture, pdfBytes }) => {
    // @ts-expect-error -- Vite loads actual production modules on native IndexedDB.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository, scopeKey } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Common transport envelope, no browser-specific replication policy.
    const { createDriveEditTransfer } = await import('/src/adapters/drive/editTransfer.ts');
    // @ts-expect-error -- Common dataset publication/import path.
    const { prepareDatasetPublication, publishDataset, importPublishedDataset } = await import('/src/runtime/edits/datasetPublication.ts');
    // @ts-expect-error -- Vite browser import.
    const { canonicalJson } = await import('/src/runtime/edits/editModel.ts');
    // @ts-expect-error -- Independent PDF.js resource inspection on both engines.
    const { pdfResourceInspection } = await import('/src/adapters/browser/pdfResources.ts');
    const scope = fixture.datasetManifest.scope, prefix = 'papeer-dataset-test-' + crypto.randomUUID();
    const names = ['source', 'target', 'upgrade'].map(value => prefix + '-' + value), databases: any[] = [];
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const open = (name: string) => { const db = new IndexedDbEditDatabase(scope, name); databases.push(db); return db; };
    try {
      const sourceDb = open(names[0]), source = new DurableEditRepository(scope, sourceDb, pdfResourceInspection);
      await source.storeResource({ ...fixture.resource.metadata, bytes: Uint8Array.from(pdfBytes), expected: fixture.resource.metadata });
      await source.installCheckpoint(fixture.checkpoint);
      const publication = await prepareDatasetPublication(source, fixture.datasetManifest.id);
      expect(canonicalJson(publication.manifest) === canonicalJson(fixture.datasetManifest), 'Python/TypeScript complete manifest differs');
      const objects = new Map<string, any>(), bodies = new Map<string, any>(), events: string[] = [];
      let loseManifestReply = true;
      const transfer = createDriveEditTransfer({
        async bindAccount() { return this; }, assertCurrent() {},
        sharedEditFiles: async () => [...objects.keys()].reverse().map(id => ({ id })),
        annotation: async (id: string) => structuredClone(objects.get(id)),
        saveSharedEdit: async (_namespace: string, _folder: string, id: string, value: any) => {
          if (objects.has(id)) expect(canonicalJson(objects.get(id)) === canonicalJson(value), 'retry changed immutable payload');
          objects.set(id, structuredClone(value)); events.push(value.kind);
          if (value.kind === 'dataset-manifest' && loseManifestReply) throw new Error('manifest-response-lost');
        },
        saveSharedResource: async (_namespace: string, _folder: string, resource: any) => {
          bodies.set(resource.metadata.id, structuredClone(resource)); events.push('resource');
          objects.set(resource.metadata.id, { kind: 'resource', metadata: resource.metadata, blobId: resource.metadata.id });
        },
        sharedResource: async (_namespace: string, metadata: any) => structuredClone(bodies.get(metadata.id).bytes),
      }, scope, 'folder');
      let uncertain = false; try { await publishDataset(publication, source, transfer); } catch { uncertain = true; }
      expect(uncertain && events.join(',') === 'resource,repository-checkpoint,dataset-manifest', 'publication was not manifest-last');
      const count = objects.size; loseManifestReply = false; await publishDataset(publication, source, transfer);
      expect(objects.size === count, 'upload retry created another logical publication');
      let targetDb = open(names[1]), target = new DurableEditRepository(scope, targetDb, pdfResourceInspection);
      const faulty = new DurableEditRepository(scope, { transaction: (run: (tx: any) => Promise<unknown>) => targetDb.transaction((tx: any) => run({ ...tx,
        putDataset: (manifest: any) => { tx.putDataset(manifest); throw new Error('quota-after-completion'); },
      })) }, pdfResourceInspection);
      let aborted = false;
      try { await importPublishedDataset(faulty, transfer, publication.manifest.id, crypto.randomUUID()); } catch { aborted = true; }
      expect(aborted && (await target.installedDatasets()).length === 0, 'native abort leaked a completion marker');
      let absent = false; try { await target.read(scope.libraryId); } catch { absent = true; }
      expect(absent && !await target.receipt(fixture.checkpoint.edits[0].batch.id), 'native abort leaked catalog/content/receipt');
      const peerId = crypto.randomUUID();
      await importPublishedDataset(target, transfer, publication.manifest.id, peerId);
      await targetDb.close(); targetDb = open(names[1]); target = new DurableEditRepository(scope, targetDb, pdfResourceInspection);
      expect(canonicalJson(await target.installedDatasets()) === canonicalJson([publication.manifest]), 'restart lost completion');
      expect(canonicalJson(await target.checkpoint()) === canonicalJson(publication.checkpoint), 'restart lost the frozen dataset');
      expect((await target.read(fixture.document.id)).waiting.length === 1, 'restart discarded a parent-waiting edit');
      const sent = events.length; await importPublishedDataset(target, transfer, publication.manifest.id, peerId);
      expect(events.length === sent, 'restart duplicated import acknowledgements');
      const isolatedDb = new IndexedDbEditDatabase({ ...scope, accountId: 'other' }, names[1]); databases.push(isolatedDb);
      expect((await new DurableEditRepository({ ...scope, accountId: 'other' }, isolatedDb).installedDatasets()).length === 0, 'completion leaked to another account');
      // Upgrade the previous native DB schema without erasing its recovery journal/outbox.
      const old = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(names[2], 4);
        request.onupgradeneeded = () => {
          for (const name of ['roots', 'edits', 'projections', 'pages', 'resources', 'resourceBytes', 'checkpoints', 'intents']) {
            const store = request.result.createObjectStore(name, { keyPath: 'key' }); store.createIndex('scope', 'scope');
          }
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const namespace = scopeKey(scope), row = (id: string, value: any) => ({ key: JSON.stringify([namespace, id]), scope: namespace, value });
      const tx = old.transaction(['roots', 'edits', 'intents'], 'readwrite');
      tx.objectStore('roots').put(row(fixture.document.id, fixture.document));
      tx.objectStore('edits').put(row(fixture.editRecords[0].batch.id, { ...fixture.editRecords[0], receipt: {
        id: fixture.editRecords[0].batch.id, targetId: fixture.document.id, durable: true, upload: 'pending', importedBy: [],
      } }));
      tx.objectStore('intents').put(row(fixture.document.id, fixture.intents[0]));
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); old.close();
      const upgraded = new DurableEditRepository(scope, open(names[2]), pdfResourceInspection);
      expect((await upgraded.pendingRecords()).length === 1 && (await upgraded.readIntent(fixture.document.id)).id === fixture.intents[0].id, 'schema upgrade erased pending data');
      expect((await upgraded.installedDatasets()).length === 0, 'schema upgrade invented dataset completion');
      return ['actual PDF dimensions', 'manifest-last and same-ID retry', 'atomic native abort', 'restart and receipts', 'account isolation', 'v4-to-v6 journal preservation'];
    } finally {
      for (const db of databases) await db.close();
      for (const name of names) await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      });
    }
  }, { fixture, pdfBytes });
  assert.equal(evidence.length, 6);
});
}
