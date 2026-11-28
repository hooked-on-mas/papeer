import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import type { Snapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';
import { ordinaryWeb, gesture } from './ordinaryWeb.ts';
import { resource } from './ordinaryStorage.ts';

const dialog = (page: Page) => page.getByRole('dialog', { name: '引用をノートへ追加', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });

/** Read only physical storage; never obtains application bindings or write authority. */
async function stored(page: Page, id: string) {
  const rows = await page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('papeer-shared-edits');
      opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('existing database required')); };
      opening.onerror = () => reject(opening.error); opening.onsuccess = () => resolve(opening.result);
    });
    try {
      return await new Promise<{ root: Snapshot; edits: StoredEdit[]; namespace: string }>((resolve, reject) => {
        const tx = db.transaction(['roots', 'edits'], 'readonly');
        const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll();
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => {
          const root = roots.result.find((row: { value: Snapshot }) => row.value.id === id);
          if (!root) { reject(new Error('UI-created root missing')); return; }
          resolve({ root: root.value, namespace: root.scope, edits: edits.result.filter((row: { scope: string; value: StoredEdit }) =>
            row.scope === root.scope && row.value.batch.targetId === id).map((row: { value: StoredEdit }) => row.value) });
        };
      });
    } finally { db.close(); }
  }, id);
  const graph = new EditGraph({ version: 1, libraryId: JSON.parse(rows.namespace)[1], root: rows.root, batches: rows.edits.map(row => row.batch) });
  const view = graph.getView(); assert.equal(view.heads.length, 1);
  return { ...rows, snapshot: graph.snapshot(view.heads[0])! };
}
async function markdown(page: Page, id: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) {
    const value = await stored(page, id);
    if (value.snapshot.kind === 'markdown' && value.snapshot.appendIds.length === count && value.edits.every(edit => edit.receipt.durable)) return value;
    assert.ok(Date.now() < until, 'append did not become durable'); await delay(50);
  }
}
async function open(page: Page, title: string) {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary quote, image and retained annotation append (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page;
  let phase = 'create-note';
  try {
  const noteTitle = `Append destination ${engine}`;
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteTitle);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
  const noteId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(noteId);
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill('Preserved prefix 日本語');
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).waitFor();
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  phase = 'import-pdf';
  const root = path.resolve(import.meta.dirname, '../../../../..'), pdf = path.join(app.scratch, 'append-source.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), pdf], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(pdf);
  await page.getByRole('heading', { name: 'append-source.pdf', exact: true }).waitFor();
  const sourceId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(sourceId);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  await page.getByRole('button', { name: '読む', exact: true }).click();
  phase = 'managed-selection';
  const layer = page.locator('.react-pdf__Page[data-page-number="1"] .textLayer[tabindex="0"]');
  await page.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
  await layer.locator('span[role="presentation"]').first().waitFor();
  await layer.focus(); await page.keyboard.press('Enter');
  await page.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]').filter({ hasText: '本文の選択操作を開始しました' }).waitFor({ state: 'attached' });
  for (let n = 0; n < 8; n++) await page.keyboard.press('Shift+ArrowRight');
  await page.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]').filter({ hasText: /^8文字を選択しました/ }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '選択した文章をノートへ追加', exact: true }).click();
  await dialog(page).getByLabel('追加先のノート', { exact: true }).selectOption(noteId);
  await page.evaluate(noteId => {
    const probe = { enabled: true, attempts: [] as StoredEdit[] };
    (globalThis as unknown as { appendFault: typeof probe }).appendFault = probe;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const row = value as { value?: StoredEdit };
      if (this.name === 'edits' && row.value?.batch.targetId === noteId && row.value.batch.kind === 'markdown' && row.value.batch.appendId) {
        probe.attempts.push(structuredClone(row.value));
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('P2 actual append commit abort', 'AbortError'); }
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  }, noteId);
  await dialog(page).getByRole('button', { name: 'ノートへ追加', exact: true }).click();
  phase = 'quote-commit-abort-visible';
  await dialog(page).getByRole('alert').waitFor();
  const failedQuote = await stored(page, noteId); assert.ok(failedQuote.snapshot.kind === 'markdown');
  assert.equal(failedQuote.snapshot.appendIds.length, 0, 'aborted commit never enters durable content');
  await page.evaluate(() => { (globalThis as unknown as { appendFault: { enabled: boolean } }).appendFault.enabled = false; });
  await dialog(page).getByRole('button', { name: '再試行', exact: true }).click();
  phase = 'quote-retry';
  await dialog(page).getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
  const quoted = await markdown(page, noteId, 1); assert.ok(quoted.snapshot.kind === 'markdown');
  const quoteAttempts = await page.evaluate(() => (globalThis as unknown as { appendFault: { attempts: StoredEdit[] } }).appendFault.attempts);
  assert.ok(quoteAttempts.length >= 2);
  for (const attempt of quoteAttempts) assert.deepEqual(attempt.batch, quoteAttempts[0].batch, 'commit retry retains the exact batch');
  assert.equal(quoted.edits.filter(edit => edit.batch.kind === 'markdown' && edit.batch.appendId).length, 1);
  assert.match(quoted.snapshot.content, /^Preserved prefix 日本語/); assert.match(quoted.snapshot.content, /papeer:\/\/citation\//);
  assert.ok(quoted.snapshot.content.includes(sourceId));
  await dialog(page).getByRole('button', { name: '閉じる', exact: true }).click();
  phase = 'image';
  await page.getByLabel('切り抜き先', { exact: true }).selectOption('note');
  await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
  await gesture(page, [[.1, .15], [.65, .5]], 'PDF書き込みレイヤー');
  await dialog(page).getByLabel('追加先のノート', { exact: true }).selectOption(noteId);
  await page.evaluate(() => { (globalThis as unknown as { appendFault: { enabled: boolean } }).appendFault.enabled = true; });
  await dialog(page).getByRole('button', { name: 'ノートへ追加', exact: true }).click();
  await dialog(page).getByRole('alert').waitFor();
  const abortedImage = await markdown(page, noteId, 1); assert.ok(abortedImage.snapshot.kind === 'markdown');
  assert.equal(abortedImage.snapshot.imageResources.length, 0);
  await page.evaluate(() => { (globalThis as unknown as { appendFault: { enabled: boolean } }).appendFault.enabled = false; });
  await dialog(page).getByRole('button', { name: '再試行', exact: true }).click();
  await dialog(page).getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
  const image = await markdown(page, noteId, 2); assert.ok(image.snapshot.kind === 'markdown');
  const imageAttempts = (await page.evaluate(() => (globalThis as unknown as { appendFault: { attempts: StoredEdit[] } }).appendFault.attempts)).slice(quoteAttempts.length);
  assert.ok(imageAttempts.length >= 2);
  for (const attempt of imageAttempts) assert.deepEqual(attempt.batch, imageAttempts[0].batch);
  assert.equal(image.snapshot.imageResources.length, 1);
  const imageResource = await resource(page, image.namespace, image.snapshot.imageResources[0].resourceId);
  assert.ok(imageResource.byteLength > 100); assert.equal(imageResource.actualSha256, imageResource.metadata.sha256);
  await dialog(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
  // Let Playwright scroll this exact target into view; normalized coordinates on
  // a taller-than-viewport PDF layer can otherwise fall below the visible pane.
  await page.getByLabel('注釈の配置と選択', { exact: true }).click({ position: { x: 100, y: 140 } });
  const form = page.getByRole('region', { name: '注釈を編集', exact: true });
  await form.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill('Frozen append 日本語');
  await form.getByRole('button', { name: '確定', exact: true }).click();
  const toggle = panel(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await panel(page).locator('li').filter({ hasText: 'Frozen append 日本語' }).waitFor();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    const probe = { enabled: true, attempted: '' };
    (globalThis as unknown as { appendScratchFault: typeof probe }).appendScratchFault = probe;
    Storage.prototype.setItem = function (key, value) {
      if (probe.enabled && key.startsWith('paper-desk.annotation-append.v1:')) {
        probe.attempted = value; throw new DOMException('P2 append scratch quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await panel(page).getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).click();
  phase = 'scratch-abort-visible';
  await dialog(page).getByRole('alert').waitFor();
  const scratchRequest = await page.evaluate(() => {
    const probe = (globalThis as unknown as { appendScratchFault: { enabled: boolean; attempted: string } }).appendScratchFault;
    probe.enabled = false; return JSON.parse(probe.attempted);
  });
  await panel(page).getByLabel('検索', { exact: true }).fill('no matching rows');
  await dialog(page).getByRole('button', { name: '再試行', exact: true }).click();
  phase = 'scratch-retry';
  await dialog(page).getByLabel('新しいノートの名前', { exact: true }).fill('Recovered append note');
  // Fail a real transaction after its legitimate intent journal, never install content or authority.
  await page.evaluate(() => {
    const probe = { attempts: [] as StoredEdit[] };
    (globalThis as unknown as { appendPublicationFault: typeof probe }).appendPublicationFault = probe;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'edits' && (value as { value?: StoredEdit }).value?.publication) {
        probe.attempts.push(structuredClone((value as { value: StoredEdit }).value));
        this.transaction.abort(); throw new DOMException('P2 publication storage failure', 'AbortError');
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await dialog(page).getByRole('button', { name: 'ノートを作成して追加', exact: true }).click();
  phase = 'publication-abort-visible';
  await dialog(page).getByRole('alert').waitFor();
  const retained = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('paper-desk.annotation-append.v1:')).map(([, value]) => JSON.parse(value)));
  assert.equal(retained.length, 1); const saved = retained[0]; assert.ok(saved.creation.identity.itemId);
  assert.deepEqual(saved.request, scratchRequest.request, 'filter changes and scratch retry retain the original immutable export');
  const publicationAttempts = await page.evaluate(() => (globalThis as unknown as { appendPublicationFault: { attempts: StoredEdit[] } }).appendPublicationFault.attempts);
  assert.ok(publicationAttempts.length > 0, 'the real publication storage transaction was aborted');
  page = await app.restart('append-source.pdf');
  await dialog(page).getByRole('button', { name: '再試行', exact: true }).click();
  await dialog(page).getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
  const appended = await markdown(page, saved.creation.identity.itemId, 1); assert.ok(appended.snapshot.kind === 'markdown');
  const catalog = await stored(page, JSON.parse(appended.namespace)[1]); assert.ok(catalog.snapshot.kind === 'library');
  assert.equal(catalog.snapshot.items.filter(item => item.id === saved.creation.identity.itemId || item.title === 'Recovered append note').length, 1);
  const publication = catalog.edits.find(edit => edit.batch.id === saved.creation.identity.batchId);
  assert.ok(publication?.publication);
  for (const attempt of publicationAttempts) {
    assert.deepEqual(publication.batch, attempt.batch);
    assert.deepEqual(publication.publication, attempt.publication, 'restart publication retry preserves exact original note identity and content');
  }
  assert.match(appended.snapshot.content, /Frozen append 日本語/);
  assert.deepEqual(appended.snapshot.appendIds, [saved.request.id]);
  assert.equal(appended.edits.filter(edit => edit.batch.kind === 'markdown' && edit.batch.appendId).length, 1);
  assert.deepEqual(appended.snapshot.content.split('Frozen append 日本語').length - 1, 1);
  await dialog(page).getByRole('button', { name: '追加先を開く', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), saved.creation.identity.itemId);
  await open(page, noteTitle); const after = await markdown(page, noteId, 2);
  assert.deepEqual(after.snapshot, image.snapshot);
  phase = 'complete';
  t.diagnostic(JSON.stringify({ engine, sourceId, noteId, recoveredNoteId: saved.creation.identity.itemId, appendId: saved.request.id,
    realResource: imageResource, quoteImageAppends: 2, recoveredAnnotationAppends: 1, quoteAttempts: quoteAttempts.map(value => value.batch.id),
    imageAttempts: imageAttempts.map(value => value.batch.id), publicationAttempts: publicationAttempts.map(value => value.batch.id), scratchRequestId: scratchRequest.request.id, actualIdbAbort: true }));
  } catch (error) {
    console.error(JSON.stringify({ engine, phase, error: String(error), body: await page.locator('body').innerText().catch(String) }));
    throw error;
  }
});
