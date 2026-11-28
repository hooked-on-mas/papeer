import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinarySaved, ordinarySnapshot } from '../../../support/ordinaryDocument.ts';
import { readerTranslationPages } from '../../../../src/features/reader/readerSurfaceModel.ts';
import { committed, resource } from '../p2/ordinaryStorage.ts';
import { gesture, ordinaryWeb } from '../p2/ordinaryWeb.ts';

async function choose(page: Page, label: string, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByLabel(label, { exact: true }).click();
  await (await chooser).setFiles(file);
}
async function translation(page: Page, file: string, ids: string[], replacing: boolean) {
  await choose(page, '取り込む訳文PDF', file);
  for (let i = 0; i < ids.length; i++) await page.getByLabel(`訳文${i + 1}ページに対応する原文ページ`, { exact: true }).selectOption(ids[i]);
  await page.getByRole('button', { name: replacing ? '訳文PDFを入れ替える' : '訳文PDFを登録する', exact: true }).click();
  await page.getByRole('button', { name: '訳文PDFの取込を取り消す', exact: true }).waitFor({ state: 'hidden' });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary standalone PDF background preserves page and ink, invalidates mapping and supports explicit remap history (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'background-origin.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  let phase = 'import';
  try {
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
    await page.getByRole('heading', { name: 'background-origin.pdf', exact: true }).waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    await page.getByRole('button', { name: '資料一覧', exact: true }).click();
    const initial = await committed(page, id), ids = initial.root.pages.map(p => p.id);
    assert.equal(ids.length, 2);
    const original = page.locator('[data-reader-surface="original"]'), translated = page.locator('[data-reader-surface="translated"]');
    const ref = page.locator('[data-reader-reference]');
    await original.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    await gesture(page, [[.15, .3], [.4, .35]], 'PDF書き込みレイヤー');
    const inkSaved = await ordinarySaved(page, id, 1), oldPage = ordinarySnapshot(inkSaved).pages[0];
    assert.equal(oldPage.annotations.length, 1);
    phase = 'initial-mapping';
    await translation(page, file, ids, false);
    const mapped = await ordinarySaved(page, id, 2), mappedDoc = ordinarySnapshot(mapped);
    assert.equal(readerTranslationPages(mappedDoc).get(ids[0])?.status, 'available');
    await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
    await ref.locator('.react-pdf__Page[data-page-number="1"] canvas').waitFor();
    phase = 'background-stage';
    await choose(page, '差し替える原文PDF', file);
    await page.getByLabel('取り込むPDFページ', { exact: true }).selectOption('2');
    assert.equal(await page.getByLabel('PDFページの配置', { exact: true }).count(), 0, 'standalone UI only exposes background replacement');
    await page.getByRole('button', { name: '次のページ', exact: true }).click();
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
    assert.deepEqual(await committed(page, id), mapped);
    await page.getByRole('button', { name: 'PDFページを適用', exact: true }).click();
    await page.getByRole('button', { name: 'PDF取込を取り消す', exact: true }).waitFor({ state: 'hidden' });
    const changed = await ordinarySaved(page, id, 3), changedDoc = ordinarySnapshot(changed), changedPage = changedDoc.pages[0];
    assert.deepEqual(changedDoc.pages.map(p => p.id), ids);
    assert.deepEqual(changedPage.annotations, oldPage.annotations);
    assert.notEqual(changedPage.backgroundRevision, oldPage.backgroundRevision);
    assert.equal(changedPage.background.kind, 'pdf');
    if (changedPage.background.kind !== 'pdf') throw new Error('PDF background required');
    assert.equal(changedPage.background.pdfPage, 2);
    assert.deepEqual(changedDoc.translation?.bindings, mappedDoc.translation?.bindings, 'old correspondences are retained with their old revision');
    assert.equal(readerTranslationPages(changedDoc).get(ids[0])?.status, 'missing');
    await original.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
    await ref.getByText('固定されたページを表示できません。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '訳文', exact: true }).click();
    await translated.getByText('このページの訳文はまだありません。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '原文', exact: true }).click();
    phase = 'explicit-remapping';
    await translation(page, file, ids, true);
    const remapped = await ordinarySaved(page, id, 4), remappedDoc = ordinarySnapshot(remapped);
    assert.equal(readerTranslationPages(remappedDoc).get(ids[0])?.status, 'available');
    assert.equal(remappedDoc.translation?.bindings[0].original.backgroundRevision, remappedDoc.pages[0].backgroundRevision);
    assert.notDeepEqual(remappedDoc.translation?.pages.map(p => p.id), mappedDoc.translation?.pages.map(p => p.id));
    phase = 'mapping-and-background-history';
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    const undoMapping = ordinarySnapshot(await ordinarySaved(page, id, 5));
    assert.deepEqual(undoMapping.pages[0].background, changedPage.background);
    assert.equal(readerTranslationPages(undoMapping).get(ids[0])?.status, 'missing');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    const undoBackground = ordinarySnapshot(await ordinarySaved(page, id, 6));
    assert.deepEqual(undoBackground.pages[0].background, oldPage.background);
    assert.deepEqual(undoBackground.pages[0].annotations, oldPage.annotations);
    assert.equal(readerTranslationPages(undoBackground).get(ids[0])?.status, 'available');
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    const redoBackground = ordinarySnapshot(await ordinarySaved(page, id, 7));
    assert.deepEqual(redoBackground.pages[0].background, changedPage.background);
    assert.equal(readerTranslationPages(redoBackground).get(ids[0])?.status, 'missing');
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    const final = await ordinarySaved(page, id, 8), finalDoc = ordinarySnapshot(final);
    assert.equal(readerTranslationPages(finalDoc).get(ids[0])?.status, 'available');
    assert.deepEqual(finalDoc.pages[0].annotations, oldPage.annotations);
    const resourceIds = [...new Set([initial.root.pages[0], changedPage, ...mappedDoc.translation!.pages, ...remappedDoc.translation!.pages]
      .flatMap(p => p.background.kind === 'pdf' ? [p.background.resourceId] : []))];
    const resources = await Promise.all(resourceIds.map(resourceId => resource(page, final.namespace, resourceId)));
    assert.equal(resourceIds.length, 4);
    phase = 'cold-restart';
    const reopened = await app.restart('background-origin.pdf');
    assert.deepEqual(await ordinarySaved(reopened, id, 8), final);
    assert.deepEqual(await Promise.all(resourceIds.map(resourceId => resource(reopened, final.namespace, resourceId))), resources);
    await reopened.locator('[data-reader-surface="original"] [data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
    await reopened.locator(`[data-reader-surface="original"] [data-ink-id="${oldPage.annotations[0].id}"]`).waitFor();
    t.diagnostic(JSON.stringify({ engine, documentId: id, pageIds: ids, exactEdits: 8, sameIdBackground: true,
      staleMappingRetained: true, explicitRemapping: true, undoRedoBoth: true, resources: resourceIds.length, coldRestart: true }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), alerts: await page.getByRole('alert').allTextContents().catch(() => []),
      status: await page.getByRole('status').allTextContents().catch(() => []), active: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 300)).catch(() => null) }));
    throw error;
  }
});
