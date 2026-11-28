import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

async function select(page: Page, id: string) {
  await page.getByRole('button', { name: 'なげなわ', exact: true }).click();
  const item = page.locator(`[data-ink-id="${id}"]`); await item.scrollIntoViewIfNeeded();
  const box = await item.boundingBox(); assert.ok(box);
  const left = box.x - 12, right = box.x + box.width + 12, top = box.y - 12, bottom = box.y + box.height + 12;
  await page.mouse.move(left, top); await page.mouse.down();
  for (const [x, y] of [[right, top], [right, bottom], [left, bottom], [left, top]]) await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'コピー', exact: true }).click({ trial: true });
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 selection clipboard and atomic partial erase retain exact history (${engine})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const documentId = await createNotebook(page, `P2 selection ${engine}`);
  await page.getByLabel('描画の種類', { exact: true }).selectOption('rectangle');
  await gesture(page, [[.2, .2], [.4, .3]]);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  const original = (await inks(page))[0]; await durable(page, documentId, [original.id], 1);
  await select(page, original.id);
  await page.getByRole('button', { name: 'コピー', exact: true }).click();
  await page.getByRole('button', { name: '貼り付け', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
  const copied = (await inks(page)).find(value => value.id !== original.id)!;
  const duplicated = await durable(page, documentId, [original.id, copied.id], 2);
  const created = duplicated.edits.flatMap(value => value.batch.kind === 'page' ? value.batch.changes.flatMap(change =>
    change.type === 'create' && change.annotation.kind === 'ink' ? [change.annotation] : []) : []);
  const source = created.find(value => value.id === original.id), copy = created.find(value => value.id === copied.id);
  assert.ok(source && copy); assert.deepEqual(copy.geometry, source.geometry); assert.deepEqual(copy.style, source.style);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await durable(page, documentId, [original.id], 3);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await durable(page, documentId, [original.id, copied.id], 4);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await durable(page, documentId, [original.id], 5);

  await page.getByLabel('描画の種類', { exact: true }).selectOption('pen');
  await gesture(page, [[.15, .6], [.65, .6]]);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
  const path = (await inks(page)).find(value => value.id !== original.id)!;
  await durable(page, documentId, [original.id, path.id], 6);
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('部分消しゴム', { exact: true }).check();
  await gesture(page, [[.4, .55], [.4, .65]]);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 3);
  const fragments = (await inks(page)).map(value => value.id);
  const erased = await durable(page, documentId, fragments, 7);
  const latest = erased.edits.find(value => value.batch.kind === 'page'
    && value.batch.changes.some(change => change.type === 'update' && change.annotation.id === path.id));
  assert.ok(latest, 'one atomic committed batch replaces the erased path with fragments');
  if (latest.batch.kind === 'page') {
    assert.equal(latest.batch.changes.filter(change => change.type === 'update').length, 1);
    assert.equal(latest.batch.changes.filter(change => change.type === 'create').length, 1);
  }
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await durable(page, documentId, [original.id, path.id], 8);
  assert.deepEqual((await inks(page)).find(value => value.id === path.id), path);
  assert.equal((await committed(page, documentId)).pendingIntents, 0);
});
