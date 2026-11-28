import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium','webkit'] as const) test(`local grant storage (${engine})`, { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root:frontend, configFile:path.join(frontend,'vite.config.ts'), logLevel:'error', server:{ port:0 } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel:'msedge', headless:true }) : await webkit.launch({ headless:true });
  t.after(() => browser.close()); const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => window.addEventListener('unhandledrejection', event => { throw new Error(String(event.reason)); }));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/canonicalLocalGrant.html`);
  const result = await page.evaluate(() => (window as unknown as { canonicalLocalGrantCases(): Promise<Record<string,boolean>> }).canonicalLocalGrantCases());
  assert.deepEqual(result, { fixture:true, absent:true, noCreate:true, readonlyOld:true, oldVersion:true, winner:true, same:true, corrupt:true, refused:true, stillCorrupt:true, ungranted:true, noAdoption:true, preserved:true });
  assert.deepEqual(errors, []);
});
