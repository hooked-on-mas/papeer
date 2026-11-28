import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit, type BrowserContext } from 'playwright-core';
import type * as Fixture from '../../../fixtures/provider/providerJoinPreparation.ts';
for (const engine of ['chromium', 'webkit'] as const) test(`host composition real local authority provider JOIN immutable IDB plan and cold query (${engine})`, { timeout: 240_000 }, async t => {
 const frontend = path.resolve(import.meta.dirname, '../../../..'), scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-provider-prepare-'));
 let context: BrowserContext | undefined;
 const errors: string[] = [], external: string[] = [];
 const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), cacheDir: path.join(scratch, 'cache'), logLevel: 'error',
  optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] }, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
 t.after(async () => { try { await context?.close(); } finally { try { await server.close(); } finally {
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); assert.ok(path.basename(scratch).startsWith('paper-desk-provider-prepare-'));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
 } } });
 await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
 const origin = `http://127.0.0.1:${address.port}`, profile = path.join(scratch, 'profile'), database = `provider-preparation-${crypto.randomUUID()}`;
 const open = async () => {
  context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true }) : await webkit.launchPersistentContext(profile, { headless: true });
  await context.route('**/*', route => { const url = new URL(route.request().url());
   if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.origin + url.pathname); return route.abort(); }
   if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' }); return route.continue(); });
  const page = context.pages()[0] ?? await context.newPage();page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin + '/e2e/fixtures/editRepository.html', { waitUntil: 'domcontentloaded' }); return page;
 };
 const close = async () => { await context!.close();context = undefined; };
 let page = await open();
 const prepared = await page.evaluate<Awaited<ReturnType<typeof Fixture.prepare>>, string>(async name => {
  // @ts-expect-error -- Vite source fixture, no production hook.
  const fixture = await import('/e2e/fixtures/provider/providerJoinPreparation.ts');return fixture.prepare(name);
 }, database);
 assert.equal(prepared.outcome.status, 'unknown'); assert.equal(prepared.raw.canonicalProfiles.length, 1);assert.equal(prepared.beforeUpgradeVersion, 8);await close();page = await open();
 const recovered = await page.evaluate<Awaited<ReturnType<typeof Fixture.recover>>, typeof prepared>(async input => {
  // @ts-expect-error -- Fresh public factory/issuer; stored JSON does not issue a capability.
  const fixture = await import('/e2e/fixtures/provider/providerJoinPreparation.ts');return fixture.recover(input);
 }, prepared);
 assert.notEqual(recovered.generation, prepared.generation);assert.deepEqual(recovered.raw, prepared.raw);assert.deepEqual(recovered.first, recovered.retry);
 await close();page = await open();
 const confirmed = await page.evaluate<Awaited<ReturnType<typeof Fixture.lateGeneration>>, typeof prepared>(async input => {
  // @ts-expect-error -- Third cold host; synchronous monotonic provider generation fence.
  const fixture = await import('/e2e/fixtures/provider/providerJoinPreparation.ts');return fixture.lateGeneration(input);
 }, prepared);
 assert.notEqual(confirmed.generation, recovered.generation);assert.deepEqual(confirmed.confirmed, recovered.first);assert.deepEqual(confirmed.raw, prepared.raw);assert.equal(confirmed.refused, true);
 assert.deepEqual(errors, []);assert.deepEqual(external, []);await close();
 t.diagnostic(JSON.stringify({ engine, requestId: prepared.requestId, coldHosts: 3, profileActivated: false,
  scope: 'real local-IDB preparation/query/replay only; synthetic provider, injected postcommit owner loss; no transport, OAuth, Native or activation claim' }));
});
