import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, preview, type PreviewServer, type ViteDevServer } from 'vite';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';
import type { CanonicalLibraryProfile, Snapshot } from '../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../src/runtime/edits/repository.ts';

type Row<T> = { key: string; scope: string; value: T };
type Ink = { id: string; drawing: string };

/** Storage observation only: no repository/session import, grant injection, seeding or write transaction. */
async function committed(page: Page, documentId: string) {
  return page.evaluate(async documentId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('canonical database absent')); };
      request.onblocked = () => reject(new Error('canonical observation blocked'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const rows = await new Promise<{
        profiles: Row<CanonicalLibraryProfile>[]; roots: Row<Snapshot>[]; edits: Row<StoredEdit>[]; intents: Row<unknown>[];
      }>((resolve, reject) => {
        const tx = db.transaction(['canonicalProfiles', 'roots', 'edits', 'intents'], 'readonly');
        const profiles = tx.objectStore('canonicalProfiles').getAll(), roots = tx.objectStore('roots').getAll();
        const edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
        tx.oncomplete = () => resolve({ profiles: profiles.result, roots: roots.result, edits: edits.result, intents: intents.result });
        tx.onabort = () => reject(tx.error ?? new Error('canonical observation aborted'));
      });
      if (rows.profiles.length !== 1) throw new Error('expected exactly one UI-created Library');
      const root = rows.roots.find(row => row.value.id === documentId);
      if (!root || root.value.kind !== 'document') throw new Error('UI-created notebook root absent');
      return {
        identity: rows.profiles[0].value.identity, namespace: root.scope, rootVersion: root.value.version,
        edits: rows.edits.filter(row => row.scope === root.scope && row.value.batch.targetId === documentId).map(row => row.value),
        pendingIntents: rows.intents.filter(row => row.scope === root.scope && (JSON.parse(row.key) as string[])[1] === documentId).length,
      };
    } finally { db.close(); }
  }, documentId);
}

const inks = (page: Page) => page.locator('[data-ink-id]').evaluateAll(elements => elements.map(element => ({
  id: element.getAttribute('data-ink-id')!, drawing: element.innerHTML,
}))) as Promise<Ink[]>;

async function durable(page: Page, documentId: string, ids: string[], count: number) {
  await page.waitForFunction(expected => {
    const actual = [...document.querySelectorAll('[data-ink-id]')].map(element => element.getAttribute('data-ink-id')).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  }, ids);
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).waitFor();
  const deadline = Date.now() + 30_000;
  let observation = await committed(page, documentId);
  while (observation.edits.length !== count || observation.pendingIntents !== 0 || observation.edits.some(edit => !edit.receipt.durable)) {
    assert.ok(Date.now() < deadline, `durability not observed: ${JSON.stringify(observation)}`);
    await delay(50); observation = await committed(page, documentId);
  }
  return observation;
}

async function draw(page: Page, y: number) {
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * y, { steps: 12 });
  await page.mouse.up();
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Web entry creates a notebook, saves A, undoes B and survives browser restart (${engine})`, { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-canonical-startup-'));
  let server: ViteDevServer | PreviewServer | undefined, context: BrowserContext | undefined;
  const errors: string[] = [], externalRequests: string[] = [];
  let phase = 'starting', activePage: Page | undefined;
  const mark = (stage: string, evidence: Record<string, unknown> = {}) => {
    phase = stage;
    // Emit before teardown: a stuck close must not hide the last completed application operation.
    console.info(JSON.stringify({ event: 'ordinary-web-startup', engine, phase, ...evidence }));
  };
  t.after(async () => {
    try { await context?.close(); }
    finally {
      try { await server?.close(); }
      finally {
        assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()), 'cleanup must stay under the test temporary root');
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });
  t.after(() => { if (errors.length || externalRequests.length) t.diagnostic(JSON.stringify({ errors, externalRequests })); });
  const built = process.env.PAPEER_WEB_BUILT === '1';
  t.diagnostic(`server mode: ${built ? 'built web-dist preview' : 'source dev server'}`);
  if (built) {
    server = await preview({ configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  } else {
    const development = await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'),
      logLevel: 'error', cacheDir: path.join(scratch, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
    await development.listen(); server = development;
  }
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const profile = path.join(scratch, 'profile');
  const launch = async () => {
    const options = { headless: true, viewport: { width: 1440, height: 1080 } };
    const opened = engine === 'chromium'
      ? await chromium.launchPersistentContext(profile, { ...options, channel: 'msedge' })
      : await webkit.launchPersistentContext(profile, options);
    opened.on('page', page => page.on('pageerror', error => errors.push(error.stack ?? String(error))));
    opened.on('request', request => { if (new URL(request.url()).origin !== new URL(url).origin) externalRequests.push(request.url()); });
    const page = opened.pages()[0] ?? await opened.newPage();
    page.on('pageerror', error => errors.push(error.stack ?? String(error)));
    page.setDefaultTimeout(30_000);
    return { opened, page };
  };

  try {
  let running = await launch(); context = running.opened;
  const page = running.page;
  activePage = page; mark('first-browser-started');
  await page.goto(url);
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  mark('local-context-provisioned');
  const libraryName = `通常起動の本棚 ${engine}`, notebookName = `通常起動の白紙 ${engine}`;
  await page.getByLabel('新しいライブラリの名前').fill(libraryName);
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  mark('library-created-and-acknowledged');
  await page.getByRole('button', { name: libraryName, exact: true }).click();
  await page.getByText('資料を選択してください。', { exact: true }).waitFor();
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(notebookName);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('heading', { name: notebookName, exact: true }).waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document');
  assert.match(documentId ?? '', /^[0-9a-f-]{36}$/); assert.ok(documentId);
  mark('notebook-opened', { documentId });
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await draw(page, .2);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  const strokeA = (await inks(page))[0]; assert.ok(strokeA);
  const savedA = await durable(page, documentId, [strokeA.id], 1);
  mark('A-durable', { documentId, strokeA: strokeA.id, batches: savedA.edits.map(edit => edit.batch.id) });
  await draw(page, .35);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
  const strokeB = (await inks(page)).find(ink => ink.id !== strokeA.id); assert.ok(strokeB);
  const savedB = await durable(page, documentId, [strokeA.id, strokeB.id], 2);
  mark('B-durable', { documentId, strokeB: strokeB.id, batches: savedB.edits.map(edit => edit.batch.id) });
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await durable(page, documentId, [strokeA.id], 3);
  const undo = undone.edits.find(edit => edit.history?.action?.kind === 'undo'); assert.ok(undo);
  const batchB = savedB.edits.find(edit => !savedA.edits.some(before => before.batch.id === edit.batch.id)); assert.ok(batchB);
  assert.equal(undo.history?.action?.operationId, batchB.batch.id, 'Undo compensates B, preserving A');
  assert.deepEqual(await inks(page), [strokeA]);
  mark('Undo-durable-A-preserved', { documentId, undoBatch: undo.batch.id, undoneBatch: batchB.batch.id });

  // Persistent context.close ends the entire browser; reopening uses only the same on-disk profile.
  mark('closing-first-browser');
  await context.close(); context = undefined;
  mark('first-browser-closed');
  running = await launch(); context = running.opened;
  const reopened = running.page;
  activePage = reopened; mark('second-browser-started');
  await reopened.goto(url);
  await reopened.getByRole('button', { name: libraryName, exact: true }).click();
  await reopened.getByText('資料を選択してください。', { exact: true }).waitFor();
  await reopened.getByRole('button', { name: notebookName, exact: true }).click();
  await reopened.getByRole('heading', { name: notebookName, exact: true }).waitFor();
  assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
  await reopened.getByRole('button', { name: '資料一覧', exact: true }).click();
  const restored = await durable(reopened, documentId, [strokeA.id], 3);
  assert.deepEqual(restored.identity, savedA.identity);
  assert.equal(restored.namespace, savedA.namespace);
  assert.deepEqual(restored.edits.map(edit => edit.batch.id).sort(), undone.edits.map(edit => edit.batch.id).sort());
  assert.deepEqual(await inks(reopened), [strokeA], 'same A ID and drawing survive; B stays undone');
  mark('cold-restart-A-restored', { documentId, library: restored.identity, strokeA: strokeA.id,
    durableBatches: restored.edits.map(edit => edit.batch.id) });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, [], 'ordinary local startup never contacts a backend or Google');
  t.diagnostic(JSON.stringify({ engine, documentId, library: restored.identity, namespace: restored.namespace,
    strokeA: strokeA.id, strokeB: strokeB.id, durableBatches: restored.edits.map(edit => edit.batch.id), browserRestarted: true }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'ordinary-web-startup-failed', engine, phase, error: String(error), errors, externalRequests }));
    if (activePage && !activePage.isClosed()) {
      const observation = await Promise.race([
        activePage.evaluate(() => ({ url: location.href, startupState: document.getElementById('root')?.dataset.startupState,
          documentId: document.querySelector('[data-content-document]')?.getAttribute('data-content-document'),
          statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
          inks: [...document.querySelectorAll('[data-ink-id]')].map(element => ({ id: element.getAttribute('data-ink-id'), drawing: element.innerHTML }))
        })).catch(cause => ({ observationError: String(cause) })),
        delay(2_000).then(() => ({ observationTimeout: true })),
      ]);
      console.error(JSON.stringify({ event: 'ordinary-web-startup-observation', engine, phase, observation }));
    }
    throw error;
  }
});
