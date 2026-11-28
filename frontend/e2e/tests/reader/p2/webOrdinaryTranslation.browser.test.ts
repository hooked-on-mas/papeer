import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Page, Locator } from 'playwright-core';
import { committed, resource } from './ordinaryStorage.ts';
import { ordinaryWeb } from './ordinaryWeb.ts';

const surface = (page: Page) => page.locator('[data-reader-surface="translated"]');
async function stroke(layer: Locator) {
  await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box);
  const page = layer.page();
  await page.mouse.move(box.x + box.width * .2, box.y + Math.min(120, box.height * .3)); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + Math.min(180, box.height * .45), { steps: 12 }); await page.mouse.up();
}
async function edits(page: Page, id: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) {
    const value = await committed(page, id);
    if (value.edits.length === count && value.pendingIntents === 0 && value.edits.every(edit => edit.receipt.durable)) return value;
    assert.ok(Date.now() < until, `expected ${count} durable operations`);
    await new Promise(resolve => setTimeout(resolve, 75));
  }
}
async function chooseTranslation(page: Page, file: string) {
  // Exercise the enabled file control and the actual chooser event; setInputFiles
  // alone bypasses actionability and the pointer/focus terminals of a user click.
  const choosing = page.waitForEvent('filechooser');
  await page.getByLabel('取り込む訳文PDF', { exact: true }).click();
  await (await choosing).setFiles(file);
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 explicit translated PDF mapping, sparse filter, replacement Undo and restart (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..');
  let phase = 'original-import';
  try {
  const original = path.join(root, 'tests/fixtures/shared-coordinate-pages.pdf');
  const translated = path.join(app.scratch, 'translated-navigation.pdf');
  const generated = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), translated], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(original);
  await page.getByRole('heading', { name: 'shared-coordinate-pages.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const published = await committed(page, id); assert.equal(published.root.pages.length, 5);
  phase = 'translation-stage';
  await page.waitForFunction(() => { const file = document.querySelector<HTMLInputElement>('[aria-label="取り込む訳文PDF"]'); return !!file && !file.disabled; });
  await chooseTranslation(page, translated);
  const first = page.getByLabel('訳文1ページに対応する原文ページ', { exact: true }); await first.waitFor();
  assert.equal(await first.inputValue(), '', 'no translation correspondence is inferred');
  assert.equal(await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('heading', { name: 'shared-coordinate-pages.pdf', exact: true }).waitFor();
  await first.selectOption(published.root.pages[0].id);
  await page.getByLabel('訳文2ページに対応する原文ページ', { exact: true }).selectOption(published.root.pages[2].id);
  await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).click();
  phase = 'translation-published';
  const installed = await edits(page, id, 1); const mapping = installed.edits[0].batch;
  assert.equal(mapping.kind, 'document'); if (mapping.kind !== 'document') throw new Error('translation document operation required');
  const change = mapping.changes.find(value => value.type === 'translation'); assert.ok(change?.type === 'translation' && change.translation);
  const pool = change.translation.pages; assert.equal(pool.length, 2); assert.deepEqual(change.translation.bindings.map(value => value.original.pageId), [published.root.pages[0].id, published.root.pages[2].id]);
  assert.equal(pool[0].background.kind, 'pdf'); if (pool[0].background.kind !== 'pdf') throw new Error('translated PDF required');
  const savedResource = await resource(page, installed.namespace, pool[0].background.resourceId);
  assert.equal(savedResource.actualSha256, pool[0].background.sourceRevision);
  await page.getByRole('button', { name: '左右', exact: true }).click();
  phase = 'translation-split-render';
  await surface(page).locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
  await surface(page).click({ position: { x: 30, y: 35 } });
  await surface(page).and(page.locator('[data-active-surface="true"]')).waitFor();
  await page.getByRole('button', { name: '読む', exact: true }).click();
  await page.getByRole('button', { name: '本文検索', exact: true }).click();
  await page.getByLabel('PDF本文検索', { exact: true }).fill('反復検索');
  phase = 'translation-search';
  await page.getByRole('status').filter({ hasText: /^4件$/ }).waitFor();
  await page.getByRole('button', { name: '次の結果', exact: true }).click();
  await surface(page).locator('[data-pdf-search-hit]').first().waitFor();
  assert.equal((await committed(page, id)).edits.length, 1, 'search is read-only');
  await page.getByLabel('ページ番号', { exact: true }).fill('1'); await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  // Explicit page-number destinations intentionally leave the sparse filter.
  await page.getByLabel('訳文があるページだけ', { exact: true }).check();
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '3');
  assert.equal(await page.getByRole('button', { name: '次のページ', exact: true }).isDisabled(), true);
  await surface(page).locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  phase = 'translation-ink';
  await stroke(surface(page).getByLabel('PDF書き込みレイヤー', { exact: true }));
  const drawn = await edits(page, id, 2); const inkBatch = drawn.edits.find(edit => edit.batch.kind === 'page')?.batch;
  assert.ok(inkBatch);
  assert.equal(inkBatch.kind, 'page'); if (inkBatch.kind !== 'page') throw new Error('translated ink operation required');
  assert.equal(inkBatch.expected.pageId, pool[1].id);
  const visible = await surface(page).locator('[data-ink-id]').getAttribute('data-ink-id'); assert.ok(visible);
  await chooseTranslation(page, translated);
  phase = 'translation-replacement';
  await page.getByLabel('訳文1ページに対応する原文ページ', { exact: true }).selectOption('none');
  await page.getByLabel('訳文2ページに対応する原文ページ', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: '訳文PDFを入れ替える', exact: true }).click();
  await edits(page, id, 3);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await edits(page, id, 4);
  await surface(page).locator(`[data-ink-id="${visible}"]`).waitFor();
  page = await app.restart('shared-coordinate-pages.pdf');
  phase = 'translation-restart';
  await page.getByLabel('ページ番号', { exact: true }).fill('3'); await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  await surface(page).locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  await surface(page).locator(`[data-ink-id="${visible}"]`).waitFor();
  const restored = await edits(page, id, 4); assert.deepEqual(restored.edits, undone.edits);
  assert.deepEqual(await resource(page, restored.namespace, pool[0].background.resourceId), savedResource);
  t.diagnostic(JSON.stringify({ engine, documentId: id, mappingInferred: false, sparseOriginalPages: [1, 3], translatedSearchHits: 4,
    translatedInkPage: pool[1].id, replacementUndone: true, exactOperationsAfterRestart: 4, resourceSha256: savedResource.actualSha256 }));
  } catch (error) {
    const directory = path.join(root, 'checkpoints/shared-app/2026-10-29-p2-references/translation-r1', `failure-${engine}-${process.pid}`);
    fs.mkdirSync(directory);
    const details = { phase, error: String(error), alerts: await page.getByRole('alert').allTextContents().catch(() => []),
      status: await page.getByRole('status').allTextContents().catch(() => []),
      panel: await page.getByRole('region', { name: '訳文PDFの取込', exact: true }).textContent().catch(() => null),
      // Catch-only observation of the already loaded input module; no owner,
      // binding, repository, session or application state is installed or changed.
      inputInventory: await page.evaluate(async () => {
        const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/usePdfPointerInput\.ts(?:\?|$)/.test(name));
        if (!url) return null;
        const input = await import(/* @vite-ignore */ url), root = document.querySelector<HTMLElement>('[data-reader-root]');
        return { hasContact: input.hasPdfPointerContact(root), draining: input.isPdfPointerDraining(root) };
      }).catch(() => null) };
    fs.writeFileSync(path.join(directory, 'details.json'), JSON.stringify(details, null, 2));
    await page.screenshot({ path: path.join(directory, 'screen.png') }).catch(() => undefined);
    t.diagnostic(JSON.stringify(details)); throw error;
  }
});
