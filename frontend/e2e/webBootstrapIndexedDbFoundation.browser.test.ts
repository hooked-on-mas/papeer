import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit, type Page } from 'playwright-core';
import path from 'node:path';
const frontend = path.resolve(import.meta.dirname, '..');
async function monitorErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => { window.addEventListener('unhandledrejection', event => { throw new Error('unhandled rejection: ' + String(event.reason)); }); });
  return errors;
}
for (const engine of ['chromium', 'webkit'] as const) test(`canonical IndexedDB foundation (${engine})`, { timeout: 90_000 }, async t => {
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close()); const page = await browser.newPage(); const errors = await monitorErrors(page);
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/bootstrapIndexedDbFoundation.html`);
  const result = await page.evaluate(() => (window as unknown as { bootstrapFoundationCases(): Promise<Record<string, boolean>> }).bootstrapFoundationCases());
  assert.deepEqual(result, { absent: true, neverCreated: true, oldUninitialized: true, sameWinner: true, preserved: true, rejected: true });
  assert.deepEqual(errors, []);
});

for (const engine of ['chromium', 'webkit'] as const) test(`canonical IndexedDB read proof (${engine})`, { timeout: 90_000 }, async t => {
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close()); const page = await browser.newPage(); const errors = await monitorErrors(page);
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/bootstrapIndexedDbRead.html`);
  const result = await page.evaluate(() => (window as unknown as { bootstrapReadCases(): Promise<Record<string, boolean>> }).bootstrapReadCases());
  assert.deepEqual(result, { accepted: true, isolated: true, missingControl: true, missingCheckpoint: true, tampered: true, missingProfile: true, nullProfile: true, importedList: true, queryAfterAck: true });
  assert.deepEqual(errors, []);
});

for (const engine of ['chromium', 'webkit'] as const) test(`canonical IndexedDB prepare replay (${engine})`, { timeout: 90_000 }, async t => {
 const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } }); await server.listen(); t.after(() => server.close());
 const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true }); t.after(() => browser.close());
 const page = await browser.newPage(); const errors = await monitorErrors(page); await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/bootstrapIndexedDbPrepare.html`);
 const result = await page.evaluate(() => (window as unknown as { bootstrapPrepareCases(): Promise<unknown> }).bootstrapPrepareCases());
 assert.deepEqual(result, { first: 'pending', replay: 'pending', persisted: 'pending', collision: true, count: 1, originalTitle: true });
 assert.deepEqual(errors, []);
});

for (const engine of ['chromium', 'webkit'] as const) test(`canonical IndexedDB execute and normal repository (${engine})`, { timeout: 90_000 }, async t => {
 const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } }); await server.listen(); t.after(() => server.close());
 const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true }); t.after(() => browser.close());
 const page = await browser.newPage(); const errors = await monitorErrors(page); await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/bootstrapIndexedDbExecute.html`);
 const result = await page.evaluate(() => (window as unknown as { bootstrapExecuteCases(): Promise<unknown> }).bootstrapExecuteCases());
 const expected = { pending: 'pending', accepted: 'accepted', replay: 'accepted', pendingRetained: true, cancelRetained: true, receiptStable: true, root: true, head: true, history: true, batches: true, manifest: true };
 assert.deepEqual(result, { first: expected, second: expected });
 assert.deepEqual(errors, []);
});
