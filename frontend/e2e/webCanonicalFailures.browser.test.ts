import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';
import type { EditIntentRecord } from '../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../src/runtime/edits/repository.ts';

type Row<T> = { key: string; scope: string; value: T };
type Probe = { enabled: boolean; attempts: StoredEdit[] };

/** Fail the actual storage transaction, after the real intent journal has been written. */
async function installStorageFault(page: Page, documentId: string, enabled: boolean) {
  await page.evaluate(({ documentId, enabled }) => {
    const host = globalThis as unknown as { __p1StorageFault: Probe };
    const probe: Probe = { enabled, attempts: [] };
    host.__p1StorageFault = probe;
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const row = value as Partial<Row<StoredEdit>>;
      if (this.name === 'edits' && row.value?.batch?.targetId === documentId) {
        probe.attempts.push(structuredClone(row.value));
        if (probe.enabled) {
          this.transaction.abort();
          throw new DOMException('P1 actual transaction storage failure', 'AbortError');
        }
      }
      return key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key);
    };
  }, { documentId, enabled });
}

const attempts = (page: Page) => page.evaluate(() => (globalThis as unknown as { __p1StorageFault: Probe }).__p1StorageFault.attempts);
const setFault = (page: Page, enabled: boolean) => page.evaluate(enabled => {
  (globalThis as unknown as { __p1StorageFault: Probe }).__p1StorageFault.enabled = enabled;
}, enabled);

/** Read raw durable rows; never call the app's sessions or repository in the oracle. */
const storage = (page: Page, documentId: string) => page.evaluate(async documentId => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('papeer-shared-edits');
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('expected existing canonical database')); };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => resolve(opening.result);
  });
  try {
    return await new Promise<{ edits: StoredEdit[]; intents: EditIntentRecord[] }>((resolve, reject) => {
      const tx = db.transaction(['edits', 'intents'], 'readonly');
      const edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
      tx.onabort = () => reject(tx.error);
      tx.oncomplete = () => resolve({
        edits: (edits.result as Row<StoredEdit>[]).map(row => row.value).filter(value => value.batch.targetId === documentId),
        intents: (intents.result as Row<EditIntentRecord>[]).filter(row => (JSON.parse(row.key) as string[])[1] === documentId).map(row => row.value),
      });
    });
  } finally { db.close(); }
}, documentId);

async function untilStored(page: Page, documentId: string, edits: number, intents: number) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await storage(page, documentId);
    if (value.edits.length === edits && value.intents.length === intents) return value;
    assert.ok(Date.now() < deadline, JSON.stringify(value));
    await delay(50);
  }
}

const ink = (page: Page) => page.locator('[data-ink-id]').evaluateAll(nodes => nodes.map(node => ({
  id: node.getAttribute('data-ink-id'), drawing: node.innerHTML,
})));

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Web retains failed edit and Undo intent through retry and cold restart (${engine})`, { timeout: 240_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-canonical-failure-'));
  let context: BrowserContext | undefined;
  const errors: string[] = [];
  const server = await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'),
    logLevel: 'error', cacheDir: path.join(scratch, 'vite-cache'), server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  t.after(async () => {
    try { await context?.close(); }
    finally {
      try { await server.close(); }
      finally {
        assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
        assert.ok(path.basename(scratch).startsWith('paper-desk-canonical-failure-'));
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`, profile = path.join(scratch, 'profile');
  const launch = async () => {
    const options = { headless: true, viewport: { width: 1440, height: 1080 } };
    context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { ...options, channel: 'msedge' })
      : await webkit.launchPersistentContext(profile, options);
    const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(25_000);
    page.on('pageerror', error => errors.push(error.stack ?? String(error)));
    await page.goto(url); return page;
  };
  const libraryName = `failure library ${engine}`, noteName = `failure note ${engine}`;
  let page = await launch();
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  await page.getByLabel('新しいライブラリの名前').fill(libraryName);
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  await page.getByRole('button', { name: libraryName, exact: true }).click();
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteName);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('heading', { name: noteName, exact: true }).waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await installStorageFault(page, documentId, true);
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  const box = await layer.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .25); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .3, { steps: 10 }); await page.mouse.up();
  await page.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).waitFor();
  const failed = await untilStored(page, documentId, 0, 1);
  const original = failed.intents[0].intent.request; assert.ok('batch' in original);
  const firstInk = await ink(page); assert.equal(firstInk.length, 1);
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存を確認してから切り替え' }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
  assert.deepEqual(await ink(page), firstInk);
  const failedAttempts = await attempts(page);
  assert.ok(failedAttempts.length > 0, 'the real edit transaction reached the injected storage failure');
  assert.ok(failedAttempts.every(value => value.batch.id === original.batch.id));
  console.info(JSON.stringify({ engine, phase: 'failed-commit-retained', documentId, batchId: original.batch.id }));

  // Exercise the real lifecycle listeners with real IDB authority, without fabricating a proof.
  // This deterministic event test is distinct from an operating-system BFCache/wake test.
  const retained = await page.locator('[data-content-document]').elementHandle(); assert.ok(retained);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.getByRole('heading', { name: noteName, exact: true }).waitFor();
  assert.equal(await retained.evaluate(node => node.isConnected && node === document.querySelector('[data-content-document]')), true);
  assert.deepEqual(await ink(page), firstInk);
  assert.deepEqual((await untilStored(page, documentId, 0, 1)).intents[0].intent.request, original);
  console.info(JSON.stringify({ engine, phase: 'same-owner-and-pending-input-after-page-lifecycle', batchId: original.batch.id }));

  // The failed edit's durable intent, rather than a live JS object, must reconstruct its exact request.
  await context!.close(); context = undefined; page = await launch();
  await page.getByRole('button', { name: libraryName, exact: true }).click();
  await page.getByRole('button', { name: noteName, exact: true }).click();
  await page.getByRole('heading', { name: noteName, exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  assert.deepEqual(await ink(page), firstInk);
  assert.deepEqual((await untilStored(page, documentId, 0, 1)).intents[0].intent.request, original);
  await installStorageFault(page, documentId, false);
  await page.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).click();
  const saved = await untilStored(page, documentId, 1, 0);
  assert.equal(saved.edits[0].batch.id, original.batch.id); assert.equal(saved.edits[0].receipt.durable, true);
  assert.deepEqual(saved.edits[0].batch, original.batch); assert.deepEqual(saved.edits[0].history, original.history);
  console.info(JSON.stringify({ engine, phase: 'same-edit-recovered-after-cold-restart', batchId: original.batch.id }));

  await setFault(page, true);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await page.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).waitFor();
  const failedUndo = await untilStored(page, documentId, 1, 1);
  const inverse = failedUndo.intents[0].intent.request; assert.ok('batch' in inverse);
  assert.equal(inverse.history?.action?.kind, 'undo'); assert.equal(inverse.history?.action?.operationId, original.batch.id);
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存を確認してから切り替え' }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
  await setFault(page, false);
  await page.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).click();
  const undone = await untilStored(page, documentId, 2, 0);
  assert.deepEqual(undone.edits.map(value => value.batch.id).sort(), [original.batch.id, inverse.batch.id].sort());
  const durableInverse = undone.edits.find(value => value.batch.id === inverse.batch.id); assert.ok(durableInverse);
  assert.deepEqual(durableInverse.batch, inverse.batch); assert.deepEqual(durableInverse.history, inverse.history);
  assert.equal(durableInverse.receipt.durable, true);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 0);
  await context!.close(); context = undefined; page = await launch();
  await page.getByRole('button', { name: libraryName, exact: true }).click();
  await page.getByRole('button', { name: noteName, exact: true }).click();
  await page.getByRole('heading', { name: noteName, exact: true }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
  await untilStored(page, documentId, 2, 0);
  assert.deepEqual(await ink(page), []);
  assert.deepEqual(errors, []);
  console.info(JSON.stringify({ engine, phase: 'failed-undo-retried-and-cold-restored', documentId, undoId: inverse.batch.id }));
});
