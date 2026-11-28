import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`durable intent: document reload, uncertain save, queued Undo, native abort and stale tab (${engine})`, { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-edit-intent', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-edits.json'), 'utf8'));
  for (let index = 0; index < fixture.intents.length; index++) {
    const name = `intent-restart-${crypto.randomUUID()}`;
    const scope = { accountId: 'fixture-account', libraryId: fixture.libraryId, epoch: `intent-${index}` };
    await page.evaluate(async ({ fixture, index, name, scope }) => {
      // @ts-expect-error -- Vite browser import; actual IndexedDB, no storage mock.
      const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
      // @ts-expect-error -- Vite browser import.
      const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
      const db = new IndexedDbEditDatabase(scope, name), repository = new DurableEditRepository(scope, db);
      await repository.initialize(fixture.document);
      const record = fixture.intents[index];
      if (record.intent.dispatched) await repository.commit(record.intent.request.batch, record.intent.request.history);
      if (record.intent.inverse) await repository.commit(record.intent.inverse.batch, record.intent.inverse.history);
      if ((await repository.replaceIntent(fixture.document.id, record, null)).status !== 'written') throw new Error('intent not saved');
      await db.close();
    }, { fixture, index, name, scope });
    await page.reload(); // Lose all session/lifecycle instances before recovering from native storage.
    const result = await page.evaluate(async ({ fixture, index, name, scope }) => {
      // @ts-expect-error -- Vite browser import.
      const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
      // @ts-expect-error -- Vite browser import.
      const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
      // @ts-expect-error -- Shared document lifecycle, not a test-only replay routine.
      const { DocumentEditSession } = await import('/src/features/reader/edit/DocumentEditSession.ts');
      const db = new IndexedDbEditDatabase(scope, name), repository = new DurableEditRepository(scope, db);
      if ((await repository.pendingIntents()).length !== 1) throw new Error('unopened document recovery was not discoverable');
      const session = new DocumentEditSession(repository, fixture.document.id);
      if (!await session.refresh() || session.canNavigate()) throw new Error('recovery did not restore the pending guard');
      if (session.getSnapshot().document.pages[0].annotations.length !== 1) throw new Error('recovery lost the original content');
      await session.retry();
      const read = await repository.read(fixture.document.id), record = fixture.intents[index];
      const inkCount = session.getSnapshot().document.pages[0].annotations.length;
      if (inkCount !== (record.intent.undoRequested ? 0 : 1)) throw new Error('recovered Undo was not respected');
      if (!session.canNavigate() || await repository.readIntent(fixture.document.id)) throw new Error('intent cleanup was not durable');
      if (record.intent.inverse && read.heads[0] !== record.intent.inverse.batch.id) throw new Error('recovery allocated a duplicate inverse');
      const other = new IndexedDbEditDatabase({ ...scope, accountId: 'other' }, name);
      if ((await new DurableEditRepository({ ...scope, accountId: 'other' }, other).pendingIntents()).length) throw new Error('account journal leak');
      await other.close(); await db.close();
      await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(name); deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
      return read.checkpoint.batches.length;
    }, { fixture, index, name, scope });
    assert.equal(result, index > 1 ? 2 : 1);
  }
  const result = await page.evaluate(async fixture => {
    // @ts-expect-error -- Vite browser import.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Vite browser import.
    const { DocumentEditSession } = await import('/src/features/reader/edit/DocumentEditSession.ts');
    // @ts-expect-error -- Vite browser import.
    const { EditIntentJournal } = await import('/src/runtime/edits/intentJournal.ts');
    const name = `intent-failure-${crypto.randomUUID()}`, scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'intent' };
    const db = new IndexedDbEditDatabase(scope, name), repository = new DurableEditRepository(scope, db);
    await repository.initialize(fixture.document);
    let fail = true;
    const faulty = new DurableEditRepository(scope, { transaction: (run: (tx: any) => Promise<unknown>) => db.transaction((tx: any) => run({ ...tx,
      putIntent: (id: string, record: any) => { tx.putIntent(id, record); if (fail) throw new Error('quota'); },
    })) });
    const session = new DocumentEditSession(faulty, fixture.document.id); await session.refresh();
    const token = Symbol(), page = fixture.document.pages[0].id;
    session.claimPage(page, token); await session.editPage(page, token, fixture.batches[0].changes);
    if (session.getSnapshot().phase !== 'aborted' || session.canNavigate()) throw new Error('journal quota lost the guard');
    if ((await repository.pending()).length || (await repository.pendingIntents()).length) throw new Error('journal native abort partially committed');
    if (session.getSnapshot().document.pages[0].annotations.length !== 1) throw new Error('journal quota lost in-memory content');
    fail = false; await session.retry();
    const first = new EditIntentJournal(repository, fixture.document.id), stale = new EditIntentJournal(repository, fixture.document.id);
    await Promise.all([first.load(), stale.load()]); await first.save(fixture.intents[0].intent);
    let refused = false; try { await stale.save(fixture.intents[0].intent); } catch { refused = true; }
    if (!refused) throw new Error('stale tab replaced another owner');
    await first.clear(); await db.close();
    await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(name); deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
    return session.canNavigate();
  }, fixture);
  assert.equal(result, true);
});
}
