import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { DocumentSnapshot } from '../../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { committed, resource } from '../reader/p2/ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';

function snapshot(value: Awaited<ReturnType<typeof committed>>): DocumentSnapshot {
  let current = value.root; const rest = [...value.edits];
  while (rest.length) {
    const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version);
    assert.ok(index >= 0, 'a complete linear durable history is required');
    current = applyBatch(current, rest.splice(index, 1)[0].batch) as DocumentSnapshot;
  }
  return current;
}
async function saved(page: Page, id: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) {
    const value = await committed(page, id);
    if (value.edits.length === count && !value.pendingIntents && value.edits.every(edit => edit.receipt.durable && edit.history)) {
      await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor(); return value;
    }
    assert.ok(Date.now() < until, `${count} durable edits required`); await delay(50);
  }
}
async function importPage(page: Page, file: string, physical: number, mode: 'insert' | 'replace') {
  await page.getByLabel('ノートに取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByLabel('取り込むPDFページ', { exact: true }).locator('option').nth(1).waitFor({ state: 'attached' });
  await page.getByLabel('取り込むPDFページ', { exact: true }).selectOption(String(physical));
  await page.getByLabel('PDFページの配置', { exact: true }).selectOption(mode);
}
async function applied(page: Page) {
  await page.getByRole('button', { name: 'PDFページを適用', exact: true }).click();
  await page.getByRole('button', { name: 'PDF取込を取り消す', exact: true }).waitFor({ state: 'hidden' });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary mixed notebook imports and replaces same-ID PDF background with ink and history (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const title = `P3 mixed notebook ${engine}`, id = await createNotebook(page, title);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(page, [[.15, .25], [.40, .32]]);
  const paperSaved = await saved(page, id, 1), paper = snapshot(paperSaved).pages[0];
  assert.equal(paper.background.kind, 'paper'); assert.equal(paper.annotations.length, 1);
  const root = path.resolve(import.meta.dirname, '../../../..'), file = path.join(app.scratch, 'mixed-pages.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  const expectedHash = createHash('sha256').update(await readFile(file)).digest('hex');

  await importPage(page, file, 1, 'insert');
  assert.deepEqual(await committed(page, id), paperSaved, 'staging a resource does not publish a partial page edit');
  await applied(page);
  const inserted = await saved(page, id, 2), mixed = snapshot(inserted);
  assert.equal(mixed.pages.length, 2); assert.deepEqual(mixed.pages[0], paper);
  const pdf = mixed.pages[1]; assert.notEqual(pdf.id, paper.id); assert.equal(pdf.background.kind, 'pdf');
  if (pdf.background.kind !== 'pdf') throw new Error('PDF page required');
  assert.equal(pdf.background.pdfPage, 1); assert.equal(pdf.annotations.length, 0);
  const firstResource = await resource(page, inserted.namespace, pdf.background.resourceId);
  assert.equal(firstResource.actualSha256, expectedHash); assert.equal(firstResource.metadata.pdfPages?.length, 2);
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  const main = page.locator('[data-reader-surface="original"]'), ref = page.locator('[data-reader-reference]');
  await main.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] .react-pdf__Page__canvas').waitFor();
  await gesture(page, [[.2, .4], [.5, .45]], 'PDF書き込みレイヤー');
  const written = await saved(page, id, 3), originalPdf = snapshot(written).pages[1];
  assert.equal(originalPdf.annotations.length, 1);
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await ref.locator('.react-pdf__Page[data-page-number="1"] .react-pdf__Page__canvas').waitFor();
  await importPage(page, file, 2, 'replace');
  await page.getByRole('button', { name: '前のページ', exact: true }).click();
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2', 'a staged import holds navigation at its captured target');
  assert.deepEqual(await committed(page, id), written);
  await applied(page);
  const replaced = await saved(page, id, 4), changed = snapshot(replaced);
  assert.equal(changed.pages.length, 2); assert.deepEqual(changed.pages[0], paper);
  const replacement = changed.pages[1];
  assert.equal(replacement.id, originalPdf.id); assert.notEqual(replacement.backgroundRevision, originalPdf.backgroundRevision);
  assert.deepEqual(replacement.annotations, originalPdf.annotations, 'same-ID replacement keeps physical ink unchanged');
  assert.equal(replacement.background.kind, 'pdf');
  if (replacement.background.kind !== 'pdf') throw new Error('PDF background required');
  assert.equal(replacement.background.pdfPage, 2); assert.notEqual(replacement.background.resourceId, pdf.background.resourceId);
  await main.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] .react-pdf__Page__canvas').waitFor();
  await ref.getByText('固定されたページを表示できません。', { exact: true }).waitFor();
  assert.equal(await ref.locator('.react-pdf__Page__canvas').count(), 0, 'the pinned old revision never silently changes background');

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await saved(page, id, 5), undoPage = snapshot(undone).pages[1];
  assert.equal(undoPage.id, originalPdf.id); assert.deepEqual(undoPage.background, originalPdf.background);
  assert.deepEqual(undoPage.annotations, originalPdf.annotations);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  const redone = await saved(page, id, 6), redoPage = snapshot(redone).pages[1];
  assert.equal(redoPage.id, originalPdf.id); assert.deepEqual(redoPage.background, replacement.background); assert.deepEqual(redoPage.annotations, originalPdf.annotations);
  await page.getByRole('button', { name: '現在のページに置き換える', exact: true }).click();
  await ref.locator('.react-pdf__Page[data-page-number="2"] .react-pdf__Page__canvas').waitFor();
  const secondResource = await resource(page, redone.namespace, replacement.background.resourceId);
  assert.equal(secondResource.actualSha256, expectedHash);
  const reopened = await app.restart(title);
  assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
  assert.deepEqual(await saved(reopened, id, 6), redone);
  assert.deepEqual(await resource(reopened, redone.namespace, pdf.background.resourceId), firstResource);
  assert.deepEqual(await resource(reopened, redone.namespace, replacement.background.resourceId), secondResource);
  const input = reopened.getByLabel('ページ番号', { exact: true });
  await input.fill('2'); await input.press('Enter');
  const reopenedMain = reopened.locator('[data-reader-surface="original"]');
  await reopenedMain.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] .react-pdf__Page__canvas').waitFor();
  assert.deepEqual(await reopenedMain.locator('[data-ink-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-ink-id'))), originalPdf.annotations.map(a => a.id));
  await input.fill('1'); await input.press('Enter');
  await reopenedMain.locator(`[data-paper-page="${paper.id}"]`).waitFor();
  assert.deepEqual(await reopenedMain.locator('[data-ink-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-ink-id'))), paper.annotations.map(a => a.id));
  t.diagnostic(JSON.stringify({ engine, documentId: id, paperPageId: paper.id, pdfPageId: pdf.id, exactEdits: 6,
    sameIdBackgroundReplacement: true, resourcesRetained: true, oldPinRefused: true, undoRedo: true, coldRestart: true }));
});
