import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { DocumentSnapshot, PageAnnotation } from '../../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { annotationPoints } from '../../../src/runtime/edits/annotationGeometry.ts';
import { committed } from '../reader/p2/ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
const mm = 72 / 25.4;
type Observation = Awaited<ReturnType<typeof committed>>;
function document(value: Observation): DocumentSnapshot {
  let snapshot = value.root; const pending = [...value.edits];
  while (pending.length) { const index = pending.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === snapshot.version);
    assert.ok(index >= 0, 'one complete actual stored history required'); snapshot = applyBatch(snapshot, pending.splice(index, 1)[0].batch) as DocumentSnapshot; }
  return snapshot;
}
async function saved(page: Page, id: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) { const value = await committed(page, id);
    if (value.edits.length === count && !value.pendingIntents && value.edits.every(edit => edit.receipt.durable && edit.history)) {
      await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor(); return value; }
    assert.ok(Date.now() < until, `expected ${count} durable annotation/paper operations`); await delay(50); }
}
function close(a: number, b: number) { assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`); }
function assertFit(before: PageAnnotation[], after: PageAnnotation[], scale: number, dx: number, dy: number) {
  assert.deepEqual(after.map(a => a.id), before.map(a => a.id));
  for (const [index, value] of after.entries()) {
    const original = before[index];
    if (value.kind === 'ink' && original.kind === 'ink') {
      assert.deepEqual(value.geometry, original.geometry); assert.deepEqual(value.style, original.style);
      close(value.transform.x, original.transform.x * scale + dx); close(value.transform.y, original.transform.y * scale + dy);
      close(value.transform.scaleX, original.transform.scaleX * scale); close(value.transform.scaleY, original.transform.scaleY * scale);
      close(value.style.widthPt * value.transform.scaleX, original.style.widthPt * original.transform.scaleX * scale);
      close(value.style.widthPt * value.transform.scaleY, original.style.widthPt * original.transform.scaleY * scale);
      assert.equal(value.transform.rotationRad, original.transform.rotationRad);
    } else if (value.kind === 'sticky' && original.kind === 'sticky') {
      close(value.anchor.x, original.anchor.x * scale + dx); close(value.anchor.y, original.anchor.y * scale + dy);
      assert.deepEqual({ ...value, anchor: original.anchor }, original);
    } else assert.fail('ordinary paper case expects only ink/text/sticky, not fabricated PDF highlight');
  }
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary paper orientation and custom boundary preserve ink text and sticky through fit Undo restart (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `P3 paper annotations ${engine}`;
  let phase = 'create-annotations';
  try {
    const id = await createNotebook(page, title);
    await page.getByLabel('線の太さ', { exact: true }).selectOption('0.006');
    await page.getByRole('button', { name: 'ペン', exact: true }).click(); await gesture(page, [[.1, .85], [.3, .9]]); await saved(page, id, 1);
    await page.getByRole('button', { name: '文字', exact: true }).click(); await gesture(page, [[.2, .7]]);
    await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill('紙の向き 日本語');
    await page.getByRole('button', { name: '確定', exact: true }).click(); await saved(page, id, 2);
    await page.getByRole('button', { name: '付箋を貼る', exact: true }).click(); await gesture(page, [[.7, .94]]);
    const form = page.getByRole('region', { name: '注釈を編集', exact: true });
    await form.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill('下端の付箋');
    await form.getByLabel('注釈の分類', { exact: true }).fill('用紙境界'); await form.getByRole('button', { name: '確定', exact: true }).click();
    const original = await saved(page, id, 3), source = document(original).pages[0];
    assert.deepEqual(source.annotations.map(a => a.kind), ['ink', 'ink', 'sticky']);
    const text = source.annotations[1]; assert.ok(text.kind === 'ink' && text.geometry.kind === 'text'); assert.equal(text.geometry.text, '紙の向き 日本語');
    phase = 'orientation-refusal-fit';
    await page.getByRole('button', { name: '用紙設定', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '用紙設定', exact: true });
    await dialog.getByLabel('用紙サイズ', { exact: true }).selectOption('A4'); await dialog.getByLabel('用紙の向き', { exact: true }).selectOption('landscape');
    const submittedWidthMm = Number(await dialog.getByLabel('幅（mm）', { exact: true }).inputValue());
    const submittedHeightMm = Number(await dialog.getByLabel('高さ（mm）', { exact: true }).inputValue());
    close(submittedWidthMm, 297); close(submittedHeightMm, 210);
    const submittedWidthPt = submittedWidthMm * mm, submittedHeightPt = submittedHeightMm * mm;
    await dialog.getByRole('button', { name: '適用', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'はみ出します' }).waitFor();
    assert.deepEqual(await committed(page, id), original, 'orientation refusal preserves exact annotation/history/receipt state');
    await dialog.getByRole('button', { name: '縦横比を保って収める', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const fitted = await saved(page, id, 4), fittedPage = document(fitted).pages[0];
    close(fittedPage.widthPt, 297 * mm); close(fittedPage.heightPt, 210 * mm); assert.equal(fittedPage.id, source.id);
    const scale = Math.min(submittedWidthPt / source.widthPt, submittedHeightPt / source.heightPt, 1);
    const dx = (submittedWidthPt - source.widthPt * scale) / 2, dy = (submittedHeightPt - source.heightPt * scale) / 2;
    assertFit(source.annotations, fittedPage.annotations, scale, dx, dy);
    phase = 'custom-boundary';
    const maxY = Math.max(...fittedPage.annotations.flatMap(a => annotationPoints(a).map(p => p.y)));
    const sticky = fittedPage.annotations.find(a => a.kind === 'sticky'); assert.ok(sticky?.kind === 'sticky'); close(maxY, sticky.anchor.y);
    await page.getByRole('button', { name: '用紙設定', exact: true }).click(); dialog = page.getByRole('dialog', { name: '用紙設定', exact: true });
    await dialog.getByLabel('幅（mm）', { exact: true }).fill('307'); await dialog.getByLabel('高さ（mm）', { exact: true }).fill('0');
    await dialog.getByRole('button', { name: '適用', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '正の数' }).waitFor(); assert.deepEqual(await committed(page, id), fitted);
    await dialog.getByLabel('高さ（mm）', { exact: true }).fill(String((maxY - 1) / mm));
    await dialog.getByRole('button', { name: '適用', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'はみ出します' }).waitFor(); assert.deepEqual(await committed(page, id), fitted);
    await dialog.getByLabel('高さ（mm）', { exact: true }).fill(String(maxY / mm)); await dialog.getByRole('button', { name: '適用', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const bounded = await saved(page, id, 5), boundedPage = document(bounded).pages[0]; close(boundedPage.widthPt, 307 * mm); close(boundedPage.heightPt, maxY);
    assert.deepEqual(boundedPage.annotations, fittedPage.annotations, 'custom boundary keeps physical positions and widths without implicit rescaling');
    phase = 'undo-redo-restart';
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); const undoCustom = document(await saved(page, id, 6)).pages[0]; assert.deepEqual(undoCustom.annotations, fittedPage.annotations); close(undoCustom.heightPt, fittedPage.heightPt);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); const undoFit = document(await saved(page, id, 7)).pages[0]; assert.deepEqual(undoFit.annotations, source.annotations); close(undoFit.widthPt, source.widthPt); close(undoFit.heightPt, source.heightPt);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); assert.deepEqual(document(await saved(page, id, 8)).pages[0].annotations, fittedPage.annotations);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); const redone = await saved(page, id, 9); assert.deepEqual(document(redone).pages[0].annotations, boundedPage.annotations);
    const reopened = await app.restart(title); assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
    const restored = await saved(reopened, id, 9); assert.deepEqual(restored, redone);
    await reopened.getByRole('button', { name: '用紙設定', exact: true }).click(); const finalDialog = reopened.getByRole('dialog', { name: '用紙設定', exact: true });
    assert.equal(await finalDialog.getByLabel('用紙サイズ', { exact: true }).inputValue(), 'custom'); close(Number(await finalDialog.getByLabel('幅（mm）', { exact: true }).inputValue()), 307); close(Number(await finalDialog.getByLabel('高さ（mm）', { exact: true }).inputValue()) * mm, maxY);
    await finalDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
    t.diagnostic(JSON.stringify({ engine, id, pageId: source.id, durableOperations: 9, annotationKinds: ['path', 'text', 'sticky'], landscapeFit: true, customBoundaryPt: maxY, paperHighlightUi: false, coldRestart: true }));
  } catch(error) { console.error(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
});
