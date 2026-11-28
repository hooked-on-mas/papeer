import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`dataset control: atomic pointer/outbox, scope freeze, restart, rollback and v5 upgrade (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-dataset-control', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-edits.json'), 'utf8'));
  const pdfBytes = [...readFileSync(path.resolve(frontend, '../tests/fixtures', fixture.resource.file))];
  const result = await page.evaluate(async ({ fixture, pdfBytes }) => {
    // @ts-expect-error -- Vite loads real native production adapters.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository, scopeKey } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Common lifecycle/control transaction on native IndexedDB.
    const { DatasetTransitionSession, activeDatasetScope } = await import('/src/runtime/edits/DatasetTransitionSession.ts');
    // @ts-expect-error -- Common publication capture.
    const { prepareDatasetPublication } = await import('/src/runtime/edits/datasetPublication.ts');
    // @ts-expect-error -- Shared wire format for both hosts.
    const { createDriveEditTransfer } = await import('/src/adapters/drive/editTransfer.ts');
    // @ts-expect-error -- Actual PDF.js inspection, not a fixture-only repository.
    const { pdfResourceInspection } = await import('/src/adapters/browser/pdfResources.ts');
    // @ts-expect-error -- JSON equality ignores key insertion order.
    const { canonicalJson } = await import('/src/runtime/edits/editModel.ts');
    const base = 'papeer-control-' + crypto.randomUUID(), live = base + '-live', upgrade = base + '-upgrade', opened: any[] = [];
    const scope = { ...fixture.datasetManifest.scope, epoch: 'source' }, targetScope = { ...scope, epoch: 'target' };
    const open = (scope: any, name = live) => { const db = new IndexedDbEditDatabase(scope, name); opened.push(db); return db; };
    const expect = (value: unknown, message: string) => { if (!value) throw new Error(message); };
    const objects = new Map<string, Map<string, any>>(), bodies = new Map<string, any>();
    const storage = {
      async bindAccount() { return this; }, assertCurrent() {},
      sharedEditFiles: async (ns: string) => [...(objects.get(ns)?.keys() ?? [])].map(id => ({ id: ns + id })),
      annotation: async (id: string) => structuredClone(objects.get(id.slice(0, 64))!.get(id.slice(64))),
      saveSharedEdit: async (ns: string, _folder: string, id: string, value: any) => {
        if (!objects.has(ns)) objects.set(ns, new Map()); const values = objects.get(ns)!;
        if (values.has(id)) expect(canonicalJson(values.get(id)) === canonicalJson(value), 'resume changed the captured plan/IDs');
        values.set(id, structuredClone(value));
      },
      saveSharedResource: async (ns: string, _folder: string, resource: any) => {
        bodies.set(ns + resource.metadata.id, structuredClone(resource)); if (!objects.has(ns)) objects.set(ns, new Map());
        objects.get(ns)!.set(resource.metadata.id, { kind: 'resource', metadata: resource.metadata, blobId: ns + resource.metadata.id });
      },
      sharedResource: async (ns: string, metadata: any) => structuredClone(bodies.get(ns + metadata.id).bytes),
    };
    const transfer = (scope: any) => createDriveEditTransfer(storage, scope, 'folder');
    try {
      let sourceDb = open(scope), targetDb = open(targetScope);
      let source = new DurableEditRepository(scope, sourceDb, pdfResourceInspection), target = new DurableEditRepository(targetScope, targetDb, pdfResourceInspection);
      const input = { ...fixture.resource.metadata, bytes: Uint8Array.from(pdfBytes), expected: fixture.resource.metadata };
      await source.storeResource(input); await source.installCheckpoint(fixture.checkpoint);
      await new DatasetTransitionSession(source, transfer(scope), crypto.randomUUID(), async () => true).start(await prepareDatasetPublication(source, crypto.randomUUID()));
      const markdown = fixture.batches.find((batch: any) => batch.kind === 'markdown'); await source.commit(markdown);
      const peer = crypto.randomUUID(); await source.acknowledgeImport(markdown.id, peer);
      await target.storeResource(input); await target.installCheckpoint(await source.checkpoint());
      expect((await target.commit(markdown)).status === 'aborted', 'unactivated staging accepted normal editing');
      const plan = await prepareDatasetPublication(target, crypto.randomUUID());
      const faulty = new DurableEditRepository(targetScope, { transaction: (run: (tx: any) => Promise<unknown>) => targetDb.transaction((tx: any) => run({ ...tx,
        putControl: (record: any) => { tx.putControl(record); if (record.transition.phase === 'activated') throw new Error('quota-after-pointer'); },
      })) }, pdfResourceInspection);
      let aborted = false; try { await new DatasetTransitionSession(faulty, transfer(targetScope), crypto.randomUUID(), async () => true).start(plan); } catch { aborted = true; }
      expect(aborted && (await source.datasetControl()).transition.phase === 'published', 'native abort leaked the active pointer');
      expect((await target.pendingRecords()).length === 0 && (await source.pendingRecords()).length === 1, 'native abort partially copied the outbox');
      expect((await source.commit(markdown)).status === 'aborted', 'source freeze was not durable');
      await sourceDb.close(); await targetDb.close(); sourceDb = open(scope); targetDb = open(targetScope);
      source = new DurableEditRepository(scope, sourceDb, pdfResourceInspection); target = new DurableEditRepository(targetScope, targetDb, pdfResourceInspection);
      expect(canonicalJson((await target.datasetControl()).transition.publication) === canonicalJson(plan), 'restart lost the durable plan');
      const recovery = new DatasetTransitionSession(target, transfer(targetScope), crypto.randomUUID(), async () => true);
      await recovery.resume(); expect(canonicalJson(await activeDatasetScope(source)) === canonicalJson(targetScope), 'restart could not complete activation');
      expect((await target.receipt(markdown.id)).upload === 'pending' && (await target.receipt(markdown.id)).importedBy.includes(peer), 'activation lost pending/import obligations');
      let rejected = false; try { await source.initialize(fixture.document); } catch { rejected = true; }
      expect(rejected, 'inactive writer bypassed the pointer through initialize');
      const child = { kind: 'markdown', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: fixture.markdown.id, parents: [markdown.id], content: 'new epoch pending', imageResources: [] };
      expect((await target.commit(child)).status === 'durable', 'active target cannot edit');
      await recovery.rollback(); expect(canonicalJson(await activeDatasetScope(target)) === canonicalJson(scope), 'rollback did not restore the source pointer');
      expect((await target.pendingRecords()).length === 2 && (await source.pendingRecords()).length === 1, 'rollback mixed new edits into old source or lost them');
      expect((await target.commit(child)).status === 'aborted', 'quarantined writer remains active');
      const other = { ...scope, accountId: 'other' }, otherDb = open(other);
      expect(!await new DurableEditRepository(other, otherDb, pdfResourceInspection).datasetControl(), 'control leaked across accounts');
      // Upgrade a fully populated v5 dataset: completion alone must not invent an active pointer.
      const old = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(upgrade, 5);
        request.onupgradeneeded = () => { for (const name of ['roots', 'edits', 'projections', 'pages', 'resources', 'resourceBytes', 'checkpoints', 'intents', 'datasets']) {
          const store = request.result.createObjectStore(name, { keyPath: 'key' }); store.createIndex('scope', 'scope');
        } };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const ns = scopeKey(fixture.datasetManifest.scope), row = (id: string, value: any) => ({ key: JSON.stringify([ns, id]), scope: ns, value });
      const tx = old.transaction(['roots', 'edits', 'resources', 'resourceBytes', 'intents', 'datasets'], 'readwrite');
      for (const root of fixture.checkpoint.roots) tx.objectStore('roots').put(row(root.id, root));
      for (const record of fixture.checkpoint.edits) tx.objectStore('edits').put(row(record.batch.id, { ...record, receipt: {
        id: record.batch.id, targetId: record.batch.targetId, durable: true, upload: 'pending', importedBy: [],
      } }));
      tx.objectStore('resources').put(row(input.id, fixture.resource.metadata)); tx.objectStore('resourceBytes').put(row(input.sha256, input.bytes));
      tx.objectStore('intents').put(row(fixture.document.id, fixture.intents[0])); tx.objectStore('datasets').put(row(fixture.datasetManifest.id, fixture.datasetManifest));
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); old.close();
      const upgraded = new DurableEditRepository(fixture.datasetManifest.scope, open(fixture.datasetManifest.scope, upgrade), pdfResourceInspection);
      expect((await upgraded.installedDatasets()).length === 1 && (await upgraded.pendingRecords()).length === fixture.checkpoint.edits.length, 'v5 upgrade lost completion/outbox');
      expect((await upgraded.readIntent(fixture.document.id)).id === fixture.intents[0].id && !await upgraded.datasetControl(), 'v5 upgrade lost the journal or invented activation');
      return ['atomic pointer and receipt copy', 'source freeze', 'restart', 'rollback quarantine', 'account isolation', 'v5 schema upgrade'];
    } finally {
      for (const db of opened) await db.close();
      for (const name of [live, upgrade]) await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
  }, { fixture, pdfBytes });
  assert.equal(result.length, 6);
});
}
