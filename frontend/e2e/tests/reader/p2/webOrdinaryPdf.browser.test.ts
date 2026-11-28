import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { committed, durable, inks, resource } from './ordinaryStorage.ts';
import { gesture, ordinaryWeb } from './ordinaryWeb.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 imports rotated CropBox PDF, draws canonical ink and restores resource after restart (${engine})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const fixture = path.resolve(import.meta.dirname, '../../../../../tests/fixtures/shared-coordinate-pages.pdf');
  const title = 'shared-coordinate-pages.pdf';
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(fixture);
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
  const published = await committed(page, documentId);
  const background = published.root.pages[0].background; assert.equal(background.kind, 'pdf');
  if (background.kind !== 'pdf') throw new Error('PDF background missing');
  const stored = await resource(page, published.namespace, background.resourceId);
  const source = await readFile(fixture), sourceSha256 = createHash('sha256').update(source).digest('hex');
  assert.equal(stored.metadata.sha256, sourceSha256);
  assert.equal(stored.actualSha256, sourceSha256);
  assert.equal(stored.byteLength, source.byteLength);
  assert.equal(published.root.pages.length, 5);
  // Independent authored fixture has nonzero CropBoxes, rotations 0/90/180/270,
  // and non-default UserUnits. These are physical points, not screen pixels.
  const expected = [[810, 1050], [1400, 1080], [675, 875], [1225, 945], [719.97052, 931.57312]];
  published.root.pages.forEach((physical, index) => {
    assert.ok(Math.abs(physical.widthPt - expected[index][0]) < .01);
    assert.ok(Math.abs(physical.heightPt - expected[index][1]) < .01);
    assert.equal(physical.background.kind, 'pdf');
    if (physical.background.kind === 'pdf') assert.equal(physical.background.pdfPage, index + 1);
  });
  await page.getByLabel('ページ番号', { exact: true }).fill('2');
  await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  await page.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  await page.getByLabel('描画の種類', { exact: true }).selectOption('arrow');
  await page.getByLabel('書き込みの色', { exact: true }).fill('#228855');
  await page.getByLabel('線の太さ', { exact: true }).selectOption('0.006');
  await gesture(page, [[.2, .3], [.45, .4]], 'PDF書き込みレイヤー');
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  const beforeRestart = await inks(page), ids = beforeRestart.map(value => value.id);
  const saved = await durable(page, documentId, ids, 1);
  const batch = saved.edits[0].batch; assert.equal(batch.kind, 'page');
  if (batch.kind !== 'page') throw new Error('expected actual page edit');
  assert.equal(batch.expected.pageId, published.root.pages[1].id);
  const annotation = batch.changes.find(change => change.type === 'create');
  assert.ok(annotation && annotation.type === 'create' && annotation.annotation.kind === 'ink');
  if (annotation.annotation.kind !== 'ink') throw new Error('expected canonical ink');
  assert.equal(annotation.annotation.geometry.kind, 'arrow');
  assert.equal(annotation.annotation.style.color, '#228855');
  assert.equal(annotation.annotation.style.widthPt, 8.4);
  assert.equal(annotation.annotation.style.highlighter, false);
  const reopened = await app.restart(title);
  await reopened.getByLabel('ページ番号', { exact: true }).fill('2');
  await reopened.getByLabel('ページ番号', { exact: true }).press('Enter');
  await reopened.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  const restored = await durable(reopened, documentId, ids, 1);
  assert.deepEqual(restored.root, published.root);
  assert.deepEqual(restored.edits, saved.edits);
  assert.deepEqual(await inks(reopened), beforeRestart);
  assert.deepEqual(await resource(reopened, restored.namespace, background.resourceId), stored);
  t.diagnostic(JSON.stringify({ engine, documentId, importedSha256: sourceSha256,
    physicalPoints: published.root.pages.map(value => [value.widthPt, value.heightPt]), logicalPage: batch.expected.pageId,
    durableBatch: batch.id, resourceRenderedAfterColdRestart: true }));
});
