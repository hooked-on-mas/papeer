import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, webkit, type Browser, type Page } from 'playwright-core';

/** Raw observations before/after admission: no source upgrade or writer is used here. */
async function rawSources(page: Page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(info => info.name!).sort();
    const databases = [];
    for (const name of names.filter(name => name.startsWith('papeer-documents:'))) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name); request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('source disappeared')); };
        request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
      });
      try {
        const stores = [];
        for (const store of Array.from(db.objectStoreNames)) {
          const rows = await new Promise<unknown[]>((resolve, reject) => {
            const tx = db.transaction(store, 'readonly'), values = tx.objectStore(store).getAll(), keys = tx.objectStore(store).getAllKeys();
            tx.oncomplete = () => resolve(values.result.map((value, index) => [keys.result[index],
              value instanceof ArrayBuffer ? { bytes: Array.from(new Uint8Array(value)) } : value]));
            tx.onabort = () => reject(tx.error);
          });
          stores.push({ store, rows });
        }
        databases.push({ name, version: db.version, stores });
      } finally { db.close(); }
    }
    return { names, databases, local: Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)),
      session: Object.entries(sessionStorage).sort(([a], [b]) => a.localeCompare(b)) };
  });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Web entry preserves legacy data without a migration hold (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..'), tempRoot = path.resolve(tmpdir());
  const scratch = await mkdtemp(path.join(tempRoot, 'paper-desk-web-legacy-presence-'));
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  let server: ViteDevServer | undefined, browser: Browser | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { assert.equal(path.dirname(scratch), tempRoot); assert.ok(path.basename(scratch).startsWith('paper-desk-web-legacy-presence-'));
        await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    }
  });
  server = await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'),
    logLevel: 'error', cacheDir: path.join(scratch, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  for (const source of ['local-draft', 'offline-records', 'unknown-schema', 'empty-offline'] as const) {
    console.info(JSON.stringify({ event: 'legacy-presence', engine, source, phase: 'seed' }));
    const context = await browser.newContext(), page = await context.newPage();
    page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(30_000);
    const requested: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.route(`${url}__legacy_seed__`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Isolated legacy source</title>' }));
      await page.goto(`${url}__legacy_seed__`);
      await page.evaluate(async source => {
        sessionStorage.setItem('papeer-google-session:v1', 'original credential bytes');
        if (source === 'local-draft') { localStorage.setItem('papeer-notes:v1:old:pending', '{malformed original draft'); return; }
        const request = indexedDB.open('papeer-documents:/old/install/', source === 'unknown-schema' ? 2 : 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('libraries');
          if (source === 'unknown-schema') return;
          request.result.createObjectStore('files'); request.result.createObjectStore('annotations');
          if (source === 'offline-records') {
            request.transaction!.objectStore('files').put(new Uint8Array([0, 255, 19]).buffer, 'original-file');
            request.transaction!.objectStore('annotations').put('{malformed original ink', 'original-annotation');
          }
        };
        await new Promise<void>((resolve, reject) => { request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
      }, source);
      const before = await rawSources(page);
      page.on('request', request => requested.push(new URL(request.url()).pathname));
      console.info(JSON.stringify({ event: 'legacy-presence', engine, source, phase: 'ordinary-entry' }));
      await page.goto(url);
      if (source === 'empty-offline') {
        await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).waitFor();
        assert.equal(await page.locator('#root').getAttribute('data-startup-state'), 'running');
      } else {
        const state = source === 'unknown-schema' ? 'unavailable' : 'legacy-present';
        await page.locator(`#root[data-startup-state="${state}"]`).waitFor();
        if (state === 'legacy-present') await page.getByText('以前の保存データが見つかりました。', { exact: false }).waitFor();
        await page.getByRole('button', { name: '起動を再試行', exact: true }).click();
        await page.locator(`#root[data-startup-state="${state}"]`).waitFor();
        assert.equal(await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).count(), 0);
        assert.ok(!requested.some(path => /\/(?:WebApp|LegacyWebConnection|legacyBackupStore|noteStore)\.(?:tsx|ts)/.test(path)),
          'the blocked entry must not import the editing composition or old writers');
      }
      assert.deepEqual(await rawSources(page), before, 'admission never changes original bytes, schemas or database names');
      assert.deepEqual(errors, []);
      console.info(JSON.stringify({ event: 'legacy-presence', engine, source, phase: 'preserved' }));
    } finally { await context.close(); }
  }
});
