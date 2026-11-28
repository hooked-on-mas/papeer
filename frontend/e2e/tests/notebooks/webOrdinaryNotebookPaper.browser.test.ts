import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page as StoredPage } from '../../../src/runtime/edits/contracts.ts';
import { committed, durable, inks } from '../reader/p2/ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';

type Observation = Awaited<ReturnType<typeof committed>>;
function replaced(before: Observation, after: Observation): StoredPage {
  const known = new Set(before.edits.map(edit => edit.batch.id));
  const added = after.edits.filter(edit => !known.has(edit.batch.id));
  assert.equal(added.length, 1);
  const batch = added[0].batch;
  assert.equal(batch.kind, 'document');
  if (batch.kind !== 'document') throw new Error('document edit required');
  assert.equal(batch.changes.length, 1);
  const change = batch.changes[0];
  assert.equal(change.type, 'replace');
  if (change.type !== 'replace') throw new Error('page replacement required');
  return change.page;
}
function close(a: number, b: number) { assert.ok(Math.abs(a - b) < 1e-7, `${a} differs from ${b}`); }

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary notebook paper preserves physical ink, refuses overflow and explicitly fits (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const title = `P3 paper geometry ${engine}`, id = await createNotebook(page, title);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(page, [[.80, .80], [.88, .87]]);
  const inkIds = (await inks(page)).map(value => value.id); assert.equal(inkIds.length, 1);
  const initial = await durable(page, id, inkIds, 1), original = initial.root.pages[0];
  const ink = initial.edits.flatMap(edit => edit.batch.kind === 'page'
    ? edit.batch.changes.flatMap(change => change.type === 'create' && change.annotation.kind === 'ink' ? [change.annotation] : []) : [])[0];
  assert.ok(ink);

  await page.getByRole('button', { name: '用紙設定', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '用紙設定', exact: true });
  await dialog.getByLabel('罫線', { exact: true }).selectOption('grid5');
  await dialog.getByLabel('用紙色', { exact: true }).selectOption('cream');
  await dialog.getByRole('button', { name: '適用', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const themed = await durable(page, id, inkIds, 2), themedPage = replaced(initial, themed);
  assert.equal(themedPage.id, original.id);
  close(themedPage.widthPt, original.widthPt); close(themedPage.heightPt, original.heightPt);
  assert.deepEqual(themedPage.annotations, [ink], 'changing paper appearance preserves all physical ink geometry and style');
  assert.deepEqual(themedPage.background, { kind: 'paper', spec: { template: 'grid5', color: 'cream' } });

  await page.getByRole('button', { name: '用紙設定', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '用紙設定', exact: true });
  await dialog.getByLabel('幅（mm）', { exact: true }).fill('-1');
  await dialog.getByRole('button', { name: '適用', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '正の数' }).waitFor();
  assert.deepEqual(await committed(page, id), themed, 'invalid dimensions create no edit or intent');
  await dialog.getByLabel('用紙サイズ', { exact: true }).selectOption('A5');
  await dialog.getByRole('button', { name: '適用', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'はみ出します' }).waitFor();
  assert.equal(await dialog.getByLabel('用紙サイズ', { exact: true }).inputValue(), 'A5');
  assert.deepEqual(await committed(page, id), themed, 'overflow refusal preserves the complete durable document and history');
  await dialog.getByRole('button', { name: '縦横比を保って収める', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const fitted = await durable(page, id, inkIds, 3), fitPage = replaced(themed, fitted), fitInk = fitPage.annotations[0];
  assert.equal(fitPage.id, original.id); assert.equal(fitInk.kind, 'ink');
  if (fitInk.kind !== 'ink') throw new Error('ink required');
  close(fitPage.widthPt, 148 * 72 / 25.4); close(fitPage.heightPt, 210 * 72 / 25.4);
  const scale = Math.min(fitPage.widthPt / original.widthPt, fitPage.heightPt / original.heightPt, 1);
  close(fitInk.transform.scaleX, ink.transform.scaleX * scale); close(fitInk.transform.scaleY, ink.transform.scaleY * scale);
  close(fitInk.transform.x, ink.transform.x * scale + (fitPage.widthPt - original.widthPt * scale) / 2);
  close(fitInk.transform.y, ink.transform.y * scale + (fitPage.heightPt - original.heightPt * scale) / 2);
  assert.deepEqual(fitInk.geometry, ink.geometry); assert.deepEqual(fitInk.style, ink.style); assert.equal(fitInk.id, ink.id);

  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await durable(page, id, inkIds, 4), restored = replaced(fitted, undone);
  close(restored.widthPt, original.widthPt); close(restored.heightPt, original.heightPt);
  assert.deepEqual(restored.annotations, [ink]); assert.deepEqual(restored.background, themedPage.background);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  const redone = await durable(page, id, inkIds, 5), repeated = replaced(undone, redone);
  assert.deepEqual(repeated.annotations, fitPage.annotations);
  close(repeated.widthPt, fitPage.widthPt); close(repeated.heightPt, fitPage.heightPt);
  const reopened = await app.restart(title);
  assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
  const afterRestart = await durable(reopened, id, inkIds, 5);
  assert.deepEqual(afterRestart, redone, 'same durable batches, receipts and no pending intent after complete browser restart');
  await reopened.getByRole('button', { name: '用紙設定', exact: true }).click();
  const saved = reopened.getByRole('dialog', { name: '用紙設定', exact: true });
  assert.equal(await saved.getByLabel('用紙サイズ', { exact: true }).inputValue(), 'A5');
  assert.equal(await saved.getByLabel('罫線', { exact: true }).inputValue(), 'grid5');
  assert.equal(await saved.getByLabel('用紙色', { exact: true }).inputValue(), 'cream');
  await saved.getByRole('button', { name: 'キャンセル', exact: true }).click();
  t.diagnostic(JSON.stringify({ engine, documentId: id, pageId: original.id, scale, durableBatches: 5,
    preservedPhysicalInk: true, invalidAndOverflowRefused: true, explicitFit: true, undoRedo: true, coldRestart: true }));
});
