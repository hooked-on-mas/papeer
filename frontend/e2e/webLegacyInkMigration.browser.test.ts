import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import { legacyInkFixture } from '../tests/support/legacyInkFixture.ts';
import { legacyBookmarkFixture } from '../tests/support/legacyBookmarkFixture.ts';

for (const engine of ['chromium', 'webkit'] as const) {
test(`legacy annotation conversion: ink, stickies and unindexed highlights survive atomic IDB abort, reload, Undo and Redo (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-legacy-ink', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-edits.json'), 'utf8'));
  const document = structuredClone(fixture.document);
  document.pages[1].widthPt = 842; document.pages[1].heightPt = 595;
  const sources = document.pages.map((p: any, index: number) => ({ ink: legacyInkFixture(p.widthPt, p.heightPt), bookmarks: legacyBookmarkFixture('old-notebook', index + 1) }));
  const name = 'papeer-migration-test-' + crypto.randomUUID(), scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'migration' };
  const converted = await page.evaluate(async ({ scope, name, document, sources }) => {
    // @ts-expect-error -- Vite browser import, production common converter.
    const { convertLegacyAnnotationsPage } = await import('/src/migrations/legacyAnnotations.ts');
    // @ts-expect-error -- Vite browser import, real native transactions.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Vite browser import, common edit/history session.
    const { DocumentEditSession } = await import('/src/features/reader/edit/DocumentEditSession.ts');
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const before = JSON.stringify(sources);
    for (const [index, page] of document.pages.entries()) {
      const result = await convertLegacyAnnotationsPage(page, sources[index].ink, sources[index].bookmarks, { libraryId: scope.libraryId, documentId: document.id,
        sourceDocumentId: 'old-notebook', side: 'original', sourcePageId: String(index + 1), sourcePageNumber: index + 1, sourceRevision: null });
      expect(result.status === 'converted', JSON.stringify(result)); document.pages[index] = result.page;
    }
    expect(JSON.stringify(sources) === before, 'conversion mutated the saved source');
    const db = new IndexedDbEditDatabase(scope, name), repository = new DurableEditRepository(scope, db);
    try {
      const faulty = new DurableEditRepository(scope, { transaction: (run: (tx: any) => Promise<unknown>) => db.transaction((tx: any) => run({ ...tx,
        putRoot: (root: any) => { tx.putRoot(root); throw new Error('quota-after-migrated-root'); },
      })) });
      let aborted = false; try { await faulty.initialize(document); } catch { aborted = true; }
      expect(aborted && (await repository.checkpoint()).roots.length === 0, 'native abort exposed a partially imported document');
      await repository.initialize(document); await repository.initialize(document);
      const session = new DocumentEditSession(repository, document.id); await session.refresh();
      const owner = Symbol(), page = document.pages[1]; session.claimPage(page.id, owner);
      await session.editPage(page.id, owner, [{ type: 'delete', id: page.annotations[page.annotations.length - 1].id }]);
      expect(session.getSnapshot().document.pages[1].annotations.length === sources[1].ink.length + sources[1].bookmarks.length - 1, 'imported highlight is not editable');
      return document;
    } finally { await db.close(); }
  }, { scope, name, document, sources });
  await page.reload();
  const restored = await page.evaluate(async ({ scope, name, document }) => {
    // @ts-expect-error -- Vite browser import.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Vite browser import.
    const { DocumentEditSession } = await import('/src/features/reader/edit/DocumentEditSession.ts');
    const db = new IndexedDbEditDatabase(scope, name), repository = new DurableEditRepository(scope, db);
    try {
      const session = new DocumentEditSession(repository, document.id); await session.refresh();
      if (!session.getSnapshot().canUndo) throw new Error('reload lost history');
      await session.undo(); const restored = structuredClone(session.getSnapshot().document);
      await session.redo();
      if (session.getSnapshot().document.pages[1].annotations.length !== document.pages[1].annotations.length - 1) throw new Error('redo failed');
      if ((await repository.pendingRecords()).length !== 3) throw new Error('reload lost the edit/Undo/Redo outbox');
      return restored;
    } finally {
      await db.close();
      await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    }
  }, { scope, name, document: converted });
  assert.deepEqual(restored.pages.map((p: any) => p.annotations), converted.pages.map((p: any) => p.annotations), 'reload/Undo changed physical geometry or preferred head sizes');
});
}
