import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`edit storage: bounded projections, historical branches and atomic resource verification (${engine})`, { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-edit-storage-review', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-edits.json'), 'utf8'));
  const pdfBytes = [...readFileSync(path.resolve(frontend, '../tests/fixtures', fixture.resource.file))];
  const result = await page.evaluate(async ({ fixture, pdfBytes }) => {
    // @ts-expect-error -- Real production adapter loaded by Vite.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Vite browser import.
    const { EditGraph } = await import('/src/runtime/edits/editGraph.ts');
    const scope = fixture.datasetManifest.scope, name = 'review-storage-' + crypto.randomUUID(), resourceName = name + '-resources';
    const opened: any[] = [];
    const open = (name: string, epoch = scope.epoch) => { const db = new IndexedDbEditDatabase({ ...scope, epoch }, name); opened.push(db); return db; };
    const expect = (value: unknown, message: string) => { if (!value) throw new Error(message); };
    const counts = async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const tx = db.transaction(['edits', 'projections', 'pages'], 'readonly');
        return await Promise.all(['edits', 'projections', 'pages'].map(store => new Promise<number>((resolve, reject) => {
          const request = tx.objectStore(store).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        })));
      } finally { db.close(); }
    };
    try {
      const database = open(name), repository = new DurableEditRepository(scope, database);
      await repository.initialize(fixture.document);
      let parent = fixture.document.version, annotationVersion = fixture.document.pages[0].annotationVersion;
      const batches: any[] = [];
      for (let index = 0; index < 80; index++) {
        const batch = structuredClone(fixture.batches[0]); batch.id = crypto.randomUUID(); batch.parents = [parent];
        batch.expected.annotationVersion = annotationVersion; batch.changes[0].annotation.id = crypto.randomUUID();
        batch.changes[0].annotation.geometry = { kind: 'path', points: Array.from({ length: 20 }, (_, x) => ({ x, y: x })) };
        expect((await repository.commit(batch)).status === 'durable', 'cumulative commit');
        batches.push(batch); parent = annotationVersion = batch.id;
      }
      expect(JSON.stringify(await counts()) === JSON.stringify([80, 2, 3]), 'old derived pages must be reclaimed');
      await database.close();
      const restarted = new DurableEditRepository(scope, open(name)), graph = new EditGraph((await restarted.read(fixture.document.id)).checkpoint);
      expect(graph.snapshot(batches[0].id).pages[0].annotations.length === 1, 'evicted historical version');
      const branch = structuredClone(batches[1]); branch.id = crypto.randomUUID(); branch.changes[0].annotation.id = crypto.randomUUID();
      await restarted.receive([branch]);
      expect(JSON.stringify(await counts()) === JSON.stringify([81, 3, 4]), 'all conflicting heads must retain projections');

      const resourceDb = open(resourceName), resourceRepo = new DurableEditRepository(scope, resourceDb, { inspectPdf: async () => fixture.resource.metadata.pdfPages });
      await resourceRepo.storeResource({ ...fixture.resource.metadata, bytes: new Uint8Array(pdfBytes) });
      const initial = fixture.datasetControls.initial;
      await resourceRepo.replaceDatasetControl(initial[0], null);
      await resourceRepo.installDataset(fixture.datasetManifest, fixture.checkpoint);
      await resourceRepo.replaceDatasetControl(initial[1], initial[0].id);
      await resourceDb.transaction(async (tx: any) => tx.putResource({ metadata: fixture.resource.metadata, bytes: new Uint8Array(pdfBytes.length).fill(120) }));
      let rejected = false;
      // Invoke the pointer write from another epoch to exercise scoped body reads.
      const other = new DurableEditRepository({ ...scope, epoch: 'controller' }, open(resourceName, 'controller'));
      try { await other.replaceDatasetControl(initial[2], initial[1].id); } catch (error) { rejected = String(error).includes('resource-hash'); }
      expect(rejected, 'activation accepted corrupt existing resource bytes');
      expect((await resourceRepo.datasetControl()).id === initial[1].id, 'failed hash check changed active pointer');
      let collision = false;
      try { await resourceRepo.storeResource({ ...fixture.resource.metadata, bytes: new Uint8Array(pdfBytes) }); } catch { collision = true; }
      expect(collision, 'storeResource refused corrupt byte collision');
      await resourceDb.transaction(async (tx: any) => tx.putResource({ metadata: fixture.resource.metadata, bytes: new Uint8Array(pdfBytes) }));
      await other.replaceDatasetControl(initial[2], initial[1].id);
      expect((await resourceRepo.datasetControl()).id === initial[2].id, 'verified retry failed');
      return true;
    } finally {
      for (const db of opened) await db.close();
      for (const value of [name, resourceName]) await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(value); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
  }, { fixture, pdfBytes });
  assert.equal(result, true);
});
}
