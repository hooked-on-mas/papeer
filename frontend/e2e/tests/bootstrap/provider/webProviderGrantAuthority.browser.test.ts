import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import path from 'node:path';

const frontend = path.resolve(import.meta.dirname, '../../../..');
for (const engine of ['chromium', 'webkit'] as const) test(`provider issuer real local authority, synthetic provider (${engine})`, { timeout: 90000 }, async t => {
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', optimizeDeps: { entries: ['e2e/fixtures/provider/providerGrantAuthority.html'] }, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close()); const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}/e2e/fixtures/provider/providerGrantAuthority.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as unknown as { exerciseProviderGrantAuthority?: unknown }).exerciseProviderGrantAuthority === 'function');
  await page.evaluate(() => (window as unknown as { exerciseProviderGrantAuthority(): Promise<void> }).exerciseProviderGrantAuthority());
  assert.deepEqual(errors, []);
});
