import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium','webkit'] as const) test(`native desktop driver gate (${engine})`, { timeout:90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname,'..');
  const server = await createServer({ root:frontend, configFile:path.join(frontend,'vite.config.ts'), logLevel:'error', server:{ port:0 } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel:'msedge',headless:true }) : await webkit.launch({ headless:true });
  t.after(() => browser.close()); const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror',error => errors.push(String(error)));
  await page.addInitScript(() => window.addEventListener('unhandledrejection',event => { throw new Error(String(event.reason)); }));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/nativeDesktopDriver.html`);
  const result = await page.evaluate(() => (window as unknown as { nativeDesktopDriverCases(): Promise<Record<string,boolean>> }).nativeDesktopDriverCases());
  assert.deepEqual(result,{ forged:true, detached:true, aborted:true, draftsLocked:true, same:true, resumed:true, captured:true, closed:true });
  assert.deepEqual(errors,[]);
});
