import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import path from 'node:path';
const frontend = path.resolve(import.meta.dirname, '..');
for (const engine of ['chromium', 'webkit'] as const) test(`canonical initialization faults and races (${engine})`, { timeout: 120_000 }, async t => {
 const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } }); await server.listen(); t.after(() => server.close());
 const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true }); t.after(() => browser.close());
 const page = await browser.newPage(); const errors: string[] = [];
 page.on('pageerror', error => errors.push(String(error)));
 await page.addInitScript(() => { window.addEventListener('unhandledrejection', event => { throw new Error('unhandled rejection: ' + String(event.reason)); }); });
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/bootstrapIndexedDbFault.html`);
 const result = await page.evaluate(() => (window as unknown as { bootstrapFaultCases(): Promise<unknown> }).bootstrapFaultCases());
 assert.deepEqual(result, { lateExecuteClosed: true, lateAckClosed: true, quota: true, quotaSame: true, revoked: true, revokeSame: true, injected: 2, stable: true, stableAfterAck: true, readback: true, lostStable: true, rejected: true, rejectedReplay: true, reused: true, bodyReads: 0 });
 assert.deepEqual(errors, []);
});
