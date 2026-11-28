import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, webkit, type Browser, type Page, type Request } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) for (const host of ['desktop', 'web'] as const) {
test(`production ${host} entry checks migration admission before legacy imports or startup mutations (${engine})`, { timeout: 120_000 }, async t => {
  let currentPhase = 'starting';
  const mark = (phase: string) => {
    currentPhase = phase;
    console.info(JSON.stringify({ event: 'legacy-startup-phase', engine, host, phase }));
  };
  const testTempRoot = path.resolve(tmpdir()), prefix = `paper-desk-startup-hold-${engine}-${host}-`;
  const scratch = await mkdtemp(path.join(testTempRoot, prefix));
  let server: ViteDevServer | undefined, browser: Browser | undefined, page: Page | undefined;
  const pendingRequests = new Map<Request, string>();
  t.after(async () => {
    try {
      if (browser) { mark('browser-close-start'); await browser.close(); mark('browser-closed'); }
    } finally {
      try {
        if (server) { mark('server-close-start'); await server.close(); mark('server-closed'); }
      } finally {
        assert.equal(path.dirname(path.resolve(scratch)), testTempRoot, 'cleanup must stay inside the test temporary root');
        assert.ok(path.basename(scratch).startsWith(prefix), 'cleanup must target this test temporary directory');
        mark('cache-cleanup-start'); await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); mark('cache-cleaned');
      }
    }
  });
  try {
  mark('create-server-start');
  const frontend = path.resolve(import.meta.dirname, '..');
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: path.join(scratch, 'vite-cache'), optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  mark('server-listen-start');
  await server.listen(); mark('server-listening');
  mark('browser-launch-start');
  browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  mark('browser-launched');
  page = await browser.newPage();
  page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(30_000);
  const requested: string[] = [], failedFonts: string[] = [];
  mark('page-created');
  page.context().on('close', () => mark('browser-context-closed'));
  page.on('console', message => { if (message.text().startsWith('legacy-startup-seed:')) mark(message.text()); });
  page.on('pageerror', error => console.error(JSON.stringify({ event: 'legacy-startup-pageerror', engine, host, error: error.stack ?? String(error) })));
  page.on('request', request => { requested.push(new URL(request.url()).pathname); pendingRequests.set(request, request.url()); });
  page.on('requestfinished', request => { pendingRequests.delete(request); });
  page.on('requestfailed', request => { pendingRequests.delete(request); });
  page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).pathname.endsWith('.woff2')) failedFonts.push(response.url()); });
  await page.addInitScript(() => { (window as any).__PAPEER_PORT = 8000; (window as any).__PAPEER_TOKEN = 'startup-fixture'; });
  let desktopHold: unknown = { version: 1, runId: crypto.randomUUID() }, reads = 0;
  await page.route('http://127.0.0.1:8000/**', async route => {
    const request = route.request(), headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(new URL(request.url()).pathname, '/api/edits/legacy-startup/read');
    assert.equal(request.headers().authorization, 'Bearer startup-fixture'); reads++;
    await route.fulfill({ json: desktopHold, headers });
  });
  await page.route('https://accounts.google.com/**', route => route.abort());
  await page.route('https://www.googleapis.com/**', route => route.abort());
  mark('seed-page-goto-start');
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  mark('seed-page-loaded');
  const original = [['paper-desk-storage', '{raw original preferences'], ['paperdesk-draft', 'raw unsaved draft'], ['papeer-notes:v1:pending', 'pending body']];
  mark('seed-evaluate-start');
  await page.evaluate(async ({ original }) => {
    const mark = (phase: string) => console.info(`legacy-startup-seed:${phase}`);
    mark('local-storage-start');
    for (const [key, value] of original) localStorage.setItem(key, value);
    sessionStorage.setItem('papeer-google-session:v1', 'invalid grant must not be read/cleared before admission');
    mark('v1-database-open-start');
    // Seed v1 artifacts and prove that adding the hold store does not rewrite old plans/objects/markers.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('papeer-migration-backups', 1);
      request.onupgradeneeded = () => {
        for (const name of ['plans', 'objects', 'manifests']) request.result.createObjectStore(name);
        request.transaction!.objectStore('plans').put({ legacy: 'raw plan' }, 'preserve');
        request.transaction!.objectStore('objects').put(new Uint8Array([0, 255, 1]).buffer, 'preserve');
        request.transaction!.objectStore('manifests').put({ legacy: 'raw marker' }, 'preserve');
      };
      request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error);
    });
    mark('v1-database-seeded');
    // @ts-expect-error -- Real production IndexedDB adapter, not an in-memory hold mock.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    mark('production-backup-adapter-imported');
    const store = new IndexedDbLegacyBackupStore(), hold = { version: 1, runId: crypto.randomUUID() }, nativeAdd = IDBObjectStore.prototype.add;
    let aborted = false;
    try {
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativeAdd.call(this, value, key); if (this.name === 'holds') this.transaction.abort(); return request;
      };
      mark('abort-hold-write-start');
      try { await store.hold(hold); } catch { aborted = true; }
      mark('abort-hold-write-settled');
    } finally { IDBObjectStore.prototype.add = nativeAdd; }
    if (!aborted || await store.readHold()) throw new Error('native abort leaked startup admission');
    mark('aborted-hold-readback-complete');
    await store.hold(hold);
    mark('valid-hold-written');
    let conflict = false; try { await store.hold({ version: 1, runId: crypto.randomUUID() }); } catch { conflict = true; }
    mark('conflicting-hold-write-settled');
    if (!conflict || JSON.stringify(await store.readHold()) !== JSON.stringify(hold)) throw new Error('another run replaced the fixed admission record');
    mark('hold-readback-complete');
  }, { original });
  mark('seed-evaluate-complete');
  const entry = host === 'desktop' ? 'index.html' : 'web/index.html';
  mark('production-entry-goto-start');
  await page.goto(`${server.resolvedUrls!.local[0]}${entry}`);
  mark('production-entry-loaded-await-held');
  await page.locator('#root[data-startup-state="held"]').waitFor();
  mark('first-held-gate-observed');
  await page.getByRole('button', { name: '起動を再試行', exact: true }).click();
  mark('retry-clicked-await-held');
  await page.locator('#root[data-startup-state="held"]').waitFor();
  mark('retry-held-gate-observed-reload-start');
  await page.reload(); await page.locator('#root[data-startup-state="held"]').waitFor();
  mark('reload-held-gate-observed');
  assert.ok(!requested.some(value => /\/(?:DesktopApp|WebApp)\.tsx/.test(value)), 'blocked entry imported an old runtime');
  mark('original-state-readback-start');
  const state = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-migration-backups'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const values: unknown[] = [];
    try {
      for (const name of ['plans', 'objects', 'manifests']) {
        const tx = db.transaction(name, 'readonly'), request = tx.objectStore(name).get('preserve');
        values.push(await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(request.result instanceof ArrayBuffer ? Array.from(new Uint8Array(request.result)) : request.result); tx.onabort = () => reject(tx.error); }));
      }
    } finally { db.close(); }
    return { raw: ['paper-desk-storage', 'paperdesk-draft', 'papeer-notes:v1:pending'].map(key => [key, localStorage.getItem(key)]),
      grant: sessionStorage.getItem('papeer-google-session:v1'), values };
  });
  assert.deepEqual(state.raw, original); assert.deepEqual(state.values, [{ legacy: 'raw plan' }, [0, 255, 1], { legacy: 'raw marker' }]);
  assert.equal(state.grant, 'invalid grant must not be read/cleared before admission');
  mark('original-state-readback-asserted');
  mark('corrupt-hold-start');
  if (host === 'desktop') { desktopHold = { version: 1, runId: 'damaged' }; assert.ok(reads >= 3); }
  else await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-migration-backups'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = db.transaction('holds', 'readwrite'); tx.objectStore('holds').put({ version: 1, runId: 'damaged' }, 'origin');
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    } finally { db.close(); }
  });
  mark('corrupt-hold-ready-reload-start');
  await page.reload(); await page.locator('#root[data-startup-state="unavailable"]').waitFor();
  mark('corruption-gate-observed-fonts-wait-start');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  mark('fonts-ready');
  assert.deepEqual(failedFonts, []);
  assert.ok(!requested.some(value => /\/(?:DesktopApp|WebApp)\.tsx/.test(value)));
  mark('all-assertions-complete');
  } catch (error) {
    console.error(JSON.stringify({ event: 'legacy-startup-failed', engine, host, phase: currentPhase,
      error: String(error), url: page?.url(), pendingRequests: [...pendingRequests.values()] }));
    if (page && !page.isClosed()) {
      const observation = await Promise.race([
        page.evaluate(() => ({ url: location.href, readyState: document.readyState,
          startupState: document.getElementById('root')?.dataset.startupState,
          rootText: document.getElementById('root')?.textContent,
          statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
        })).catch(cause => ({ observationError: String(cause) })),
        delay(2_000).then(() => ({ observationTimeout: true })),
      ]);
      console.error(JSON.stringify({ event: 'legacy-startup-observation', engine, host, phase: currentPhase,
        observation, pendingRequests: [...pendingRequests.values()] }));
    }
    throw error;
  }
});
}
