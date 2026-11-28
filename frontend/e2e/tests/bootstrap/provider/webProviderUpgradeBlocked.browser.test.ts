import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import type * as Fixture from '../../../fixtures/provider/providerUpgradeBlocked.ts';
for (const engine of ['chromium', 'webkit'] as const) for (const mode of ['provider', 'base'] as const) test(`${mode} schema upgrade blocked rejection cannot commit after late foreign close (${engine})`, { timeout: 90_000 }, async t => {
 const frontend = path.resolve(import.meta.dirname, '../../../..');
 const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
  optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] }, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
 await server.listen();t.after(() => server.close());const address = server.httpServer?.address();assert.ok(address && typeof address !== 'string');
 const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });t.after(() => browser.close());
 const page = await browser.newPage(), errors: string[] = [], external: string[] = [], origin = `http://127.0.0.1:${address.port}`;
 page.on('pageerror', error => errors.push(String(error)));page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
 await page.route('**/*', route => { const url = new URL(route.request().url());
  if (url.origin !== origin || url.pathname.startsWith('/api/')) { external.push(url.origin + url.pathname);return route.abort(); }
  if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });return route.continue(); });
 await page.goto(origin + '/e2e/fixtures/editRepository.html', { waitUntil: 'domcontentloaded' });
 const result = await page.evaluate<Awaited<ReturnType<typeof Fixture.exerciseBlockedUpgrade>> | Awaited<ReturnType<typeof Fixture.exerciseBaseBlockedUpgrade>>, typeof mode>(async mode => {
  // @ts-expect-error -- Isolated source contract fixture; no production hook or raw grant seed.
  const fixture = await import('/e2e/fixtures/provider/providerUpgradeBlocked.ts');return mode === 'provider' ? fixture.exerciseBlockedUpgrade() : fixture.exerciseBaseBlockedUpgrade();
 }, mode);
 assert.equal(result.rejected, mode === 'provider' ? 'Error: provider-upgrade-blocked' : 'Error: canonical-database-blocked');assert.ok(result.versionChangeSeen > 0);assert.equal(result.after.version, mode === 'provider' ? 8 : 1);
 assert.deepEqual(result.after, result.before);if ('rediscoveredStatus' in result) assert.equal(result.rediscoveredStatus, 'ready');assert.deepEqual(errors, []);assert.deepEqual(external, []);
 t.diagnostic(JSON.stringify({ engine, mode, rejected: result.rejected, lateVersion: result.after.version, allRowsUnchanged: true, scope: 'real local-IDB blocked/late-open contract; no dirty-tab coordination or provider activation claim' }));
});
