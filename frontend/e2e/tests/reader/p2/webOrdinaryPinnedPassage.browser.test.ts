import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';
import { committed } from './ordinaryStorage.ts';
import { ordinaryWeb } from './ordinaryWeb.ts';

async function noteEdits(page: Page, id: string) {
  return page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('papeer-shared-edits'); r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing database required')); }; r.onblocked = () => reject(new Error('storage observation blocked')); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<StoredEdit[]>((resolve, reject) => { const tx = db.transaction('edits', 'readonly'), r = tx.objectStore('edits').getAll();
      tx.oncomplete = () => resolve(r.result.map((row: { value: StoredEdit }) => row.value).filter((row: StoredEdit) => row.batch.targetId === id)); tx.onabort = () => reject(tx.error); }); }
    finally { db.close(); }
  }, id);
}
async function selectPassage(page: Page) {
  const main = page.locator('[data-reader-surface="original"]');
  const layer = main.locator('.react-pdf__Page[data-page-number="2"] .textLayer[tabindex="0"]');
  await main.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] .react-pdf__Page__canvas').waitFor();
  await layer.locator('span[role="presentation"]').first().waitFor();
  await layer.focus(); assert.equal(await layer.evaluate(element => document.activeElement === element), true); await page.keyboard.press('Enter');
  const live = page.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]');
  try { await live.filter({ hasText: '本文の選択操作を開始しました' }).waitFor({ state: 'attached', timeout: 10000 }); }
  catch (error) { console.log(JSON.stringify({ selectionDiagnostic: await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 500), live: [...document.querySelectorAll('[data-managed-pdf-selection-overlay] [aria-live]')].map(e => e.textContent), alerts: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent), statuses: [...document.querySelectorAll('[role=status]')].map(e => e.textContent), dialogs: [...document.querySelectorAll('[role=dialog]')].map(e => e.textContent?.slice(0, 400)), textLayer: !!document.querySelector('[data-reader-surface=original] .react-pdf__Page[data-page-number="2"] .textLayer[tabindex="0"]') })) })); throw error; }
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
  await live.filter({ hasText: /^8文字を選択しました/ }).waitFor({ state: 'attached' });
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary pinned reference passage quote and highlight target main page (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const noteTitle = `Pinned quote destination ${engine}`;
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteTitle);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await note.waitFor();
  const noteId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(noteId);
  await note.fill('Pinned passage prefix');
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).waitFor();
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'pinned-passage.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true }); assert.equal(authored.status, 0, authored.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: 'pinned-passage.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const original = await committed(page, id); assert.equal(original.root.pages.length, 2);
  const main = page.locator('[data-reader-surface="original"]'), ref = page.locator('[data-reader-reference]');
  await main.locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await ref.locator(`[data-canonical-page="${original.root.pages[0].id}"] .react-pdf__Page__canvas`).waitFor();
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await page.getByRole('button', { name: '読む', exact: true }).click();
  await selectPassage(page);
  await page.getByRole('button', { name: '選択した文章をノートへ追加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '引用をノートへ追加', exact: true });
  await dialog.getByLabel('追加先のノート', { exact: true }).selectOption(noteId);
  await dialog.getByRole('button', { name: 'ノートへ追加', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
  let edits = await noteEdits(page, noteId), until = Date.now() + 30_000;
  while (!edits.some(e => e.batch.kind === 'markdown' && e.batch.appendId && e.receipt.durable)) { assert.ok(Date.now() < until); await delay(50); edits = await noteEdits(page, noteId); }
  const appends = edits.filter(e => e.batch.kind === 'markdown' && e.batch.appendId); assert.equal(appends.length, 1);
  const quote = appends[0].batch; assert.equal(quote.kind, 'markdown'); if (quote.kind !== 'markdown') throw new Error('Markdown batch required');
  assert.ok(quote.content.includes('Pinned passage prefix')); assert.ok(quote.content.includes(`/citation/${original.identity.libraryId}/${id}/${original.root.pages[1].id}?`));
  assert.equal(quote.content.includes(`/citation/${original.identity.libraryId}/${id}/${original.root.pages[0].id}?`), false);
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await main.locator('.react-pdf__Page[data-page-number="2"] .textLayer[tabindex="0"]').focus(); await page.keyboard.press('Escape');
  await selectPassage(page);
  await page.getByRole('button', { name: '選択した文章をハイライト', exact: true }).click();
  const form = page.getByRole('region', { name: '注釈を編集', exact: true });
  await form.getByRole('textbox', { name: '本文ハイライトのコメント', exact: true }).fill('Pinned passage highlight');
  await form.getByRole('button', { name: '確定', exact: true }).click();
  until = Date.now() + 30_000; let after = await committed(page, id);
  while (!after.edits.some(e => e.batch.kind === 'page' && e.receipt.durable)) { assert.ok(Date.now() < until); await delay(50); after = await committed(page, id); }
  assert.equal(after.edits.length, 1); const batch = after.edits[0].batch; assert.equal(batch.kind, 'page'); if (batch.kind !== 'page') throw new Error('page batch required');
  assert.equal(batch.expected.pageId, original.root.pages[1].id); assert.ok(batch.changes.some(c => c.type === 'create' && c.annotation.kind === 'highlight'));
  await ref.locator(`[data-canonical-page="${original.root.pages[0].id}"]`).waitFor();
  assert.equal(await ref.locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
  t.diagnostic(JSON.stringify({ engine, id, noteId, pinnedPage: original.root.pages[0].id, passagePage: original.root.pages[1].id, quoteAppendOnce: true, highlightDurable: true }));
});
