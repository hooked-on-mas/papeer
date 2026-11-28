import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit, type BrowserContext } from 'playwright-core';
import type * as Fixture from './fixtures/libraryResolutionCold.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`public factory IndexedDB Library resolution survives postcommit reply loss and cold owner restart (${engine})`, { timeout: 240_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..'), scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-library-resolution-'));
  let context: BrowserContext | undefined;
  const errors: string[] = [], external: string[] = [];
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: path.join(scratch, 'vite-cache'), optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  t.after(async () => {
    try { await context?.close(); }
    finally {
      try { await server.close(); }
      finally {
        assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
        assert.ok(path.basename(scratch).startsWith('paper-desk-library-resolution-'));
        await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  });
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, profile = path.join(scratch, 'profile');
  const options = { databaseName: `library-resolution-${crypto.randomUUID()}`, title: `storage contract ${engine}` };
  const open = async () => {
    const settings = { headless: true, viewport: { width: 1000, height: 680 } };
    context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { ...settings, channel: 'msedge' }) : await webkit.launchPersistentContext(profile, settings);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.origin + url.pathname); return route.abort(); }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      return route.continue();
    });
    const page = context.pages()[0] ?? await context.newPage();page.on('pageerror', error => errors.push(error.stack ?? String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin + '/e2e/fixtures/editRepository.html');return page;
  };
  const close = async (page: Awaited<ReturnType<typeof open>>) => {
    await page.evaluate(async () => {
      // @ts-expect-error -- Vite source fixture import; not a production hook.
      const fixture = await import('/e2e/fixtures/libraryResolutionCold.ts');await fixture.closeOwner();
    });
    await context!.close();context = undefined;
  };
  let page = await open();
  const first = await page.evaluate<Awaited<ReturnType<typeof Fixture.prepare>>, typeof options>(async options => {
    // @ts-expect-error -- Actual production factory and actual IndexedDB, isolated source fixture.
    const fixture = await import('/e2e/fixtures/libraryResolutionCold.ts');return fixture.prepare(options);
  }, options);
  assert.equal(first.guardedLeaveRefused, true);
  assert.equal(first.attempts.length, 1);assert.deepEqual(first.attempts[0], first.request);
  assert.equal(first.committed.receipt.durable, true);assert.deepEqual(first.committed.batch, first.request);
  t.diagnostic(JSON.stringify({ engine, phase: 'real-durable-receipt-and-intent-before-unexpected-owner-close', resolutionId: first.request.id }));
  // This is deliberate owner interruption despite a refused guarded leave, not a naturally allowed UI close.
  await close(page);page = await open();
  const recovered = await page.evaluate<Awaited<ReturnType<typeof Fixture.recover>>, typeof options>(async options => {
    // @ts-expect-error -- Fresh browser/module instances reacquire actual grant/admission themselves.
    const fixture = await import('/e2e/fixtures/libraryResolutionCold.ts');return fixture.recover(options);
  }, options);
  assert.notEqual(recovered.generation, first.generation);assert.deepEqual(recovered.scope, first.scope);
  assert.deepEqual(recovered.intent, first.intent);assert.deepEqual(recovered.rawBefore.intents, first.storage.intents);
  assert.deepEqual(recovered.rawBefore.root, first.storage.root);assert.deepEqual(recovered.rawBefore.edits, first.storage.edits);
  assert.deepEqual(recovered.rawBefore.projections, first.storage.projections);
  assert.deepEqual(recovered.attempts, [first.request]);assert.deepEqual(recovered.heads, [first.request.id]);
  assert.deepEqual(recovered.selected, { ...first.selected, version: first.request.id });
  assert.deepEqual(recovered.selected.items.find(item => item.id === first.templateId)?.metadata, { 'papeer.note-template': 'v1' });
  assert.equal(recovered.selected.deletions.find(record => record.itemIds.includes(first.deletedId))?.active, true);
  const resolution = recovered.rawAfter.edits.filter(edit => edit.batch.kind === 'resolution');
  assert.equal(resolution.length, 1);assert.deepEqual(resolution[0], first.committed);assert.equal(recovered.rawAfter.intents.length, 0);
  assert.deepEqual(recovered.rawAfter.root, first.storage.root);assert.deepEqual(recovered.rawAfter.edits, first.storage.edits);
  assert.deepEqual(recovered.rawAfter.projections, first.storage.projections);
  t.diagnostic(JSON.stringify({ engine, phase: 'cold-registry-retry-exact-request-no-extra-resolution', resolutionId: first.request.id }));
  await close(page);page = await open();
  const confirmed = await page.evaluate<Awaited<ReturnType<typeof Fixture.confirm>>, typeof options>(async options => {
    // @ts-expect-error -- Second cold read independently confirms journal cleanup and full projection persistence.
    const fixture = await import('/e2e/fixtures/libraryResolutionCold.ts');return fixture.confirm(options);
  }, options);
  assert.notEqual(confirmed.generation, recovered.generation);assert.deepEqual(confirmed.scope, first.scope);
  assert.deepEqual(confirmed.selected, recovered.selected);assert.deepEqual(confirmed.heads, [first.request.id]);
  assert.deepEqual(confirmed.raw.edits, recovered.rawAfter.edits);assert.deepEqual(confirmed.raw.intents, []);
  assert.deepEqual(confirmed.raw.root, first.storage.root);assert.deepEqual(confirmed.raw.projections, first.storage.projections);
  await close(page);assert.deepEqual(errors, []);assert.deepEqual(external, []);
  t.diagnostic(JSON.stringify({ engine, phase: 'second-cold-storage-confirmation', resolutionId: first.request.id, scope: 'local physical IDB contract only; no ordinary remote or Native claim' }));
});
