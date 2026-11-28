import assert from 'node:assert/strict';
import { test } from 'node:test';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 seven tools, text draft, filtered erase and durable Undo survive restart (${engine})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const title = `P2 seven tools ${engine}`, documentId = await createNotebook(page, title);
  const created: string[] = [];
  let count = 0;
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await page.getByLabel('書き込みの色', { exact: true }).fill('#225588');
  await page.getByLabel('線の太さ', { exact: true }).selectOption('0.006');
  await page.getByRole('button', { name: '現在のペンをお気に入りに追加', exact: true }).click();
  for (const [offset, kind] of ['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse'].entries()) {
    await page.getByLabel('描画の種類', { exact: true }).selectOption(kind);
    await gesture(page, [[.15, .12 + offset * .10], [.40, .14 + offset * .10]]);
    await page.waitForFunction(expected => document.querySelectorAll('[data-ink-id]').length === expected, ++count);
    const ids = (await inks(page)).map(value => value.id);
    created.push(ids.find(id => !created.includes(id))!);
    await durable(page, documentId, created, count);
  }
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await gesture(page, [[.15, .8]]);
  await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill('Ordinary P2\n未確定から保存');
  assert.equal((await committed(page, documentId)).edits.length, 6, 'text draft does not commit prematurely');
  await page.getByRole('button', { name: '確定', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 7);
  created.push((await inks(page)).map(value => value.id).find(id => !created.includes(id))!);
  const saved = await durable(page, documentId, created, 7);
  const annotations = saved.edits.flatMap(edit => edit.batch.kind === 'page'
    ? edit.batch.changes.flatMap(change => change.type === 'create' && change.annotation.kind === 'ink' ? [change.annotation] : []) : []);
  const byId = created.map(id => { const annotation = annotations.find(value => value.id === id); assert.ok(annotation); return annotation; });
  assert.deepEqual(byId.map(value => value.geometry.kind), ['path', 'path', 'line', 'arrow', 'rect', 'ellipse', 'text']);
  assert.equal(byId[0].style.highlighter, false);
  assert.equal(byId[1].style.highlighter, true);
  assert.equal(byId[0].style.color, '#225588');
  assert.equal(byId[6].geometry.kind, 'text');
  if (byId[6].geometry.kind === 'text') assert.equal(byId[6].geometry.text, 'Ordinary P2\n未確定から保存');

  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('部分消しゴム', { exact: true }).uncheck();
  await page.getByLabel('蛍光ペンだけ消す', { exact: true }).check();
  await gesture(page, [[.25, .08], [.25, .27]]);
  await durable(page, documentId, created.filter(id => id !== created[1]), 8);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const restored = await durable(page, documentId, created, 9);
  const beforeRestart = await inks(page);
  const reopened = await app.restart(title);
  assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
  const restarted = await durable(reopened, documentId, created, 9);
  assert.deepEqual(restarted.identity, saved.identity);
  assert.deepEqual(restarted.edits, restored.edits, 'same persisted batches, receipt and history survive cold restart');
  assert.deepEqual(await inks(reopened), beforeRestart, 'all seven canonical IDs and drawings survive cold restart');
  await reopened.getByRole('button', { name: 'ペン', exact: true }).click();
  assert.equal(await reopened.getByLabel('書き込みの色', { exact: true }).inputValue(), '#225588');
  assert.equal(await reopened.getByLabel('線の太さ', { exact: true }).inputValue(), '0.006');
  assert.equal(await reopened.getByLabel('お気に入りのペン', { exact: true }).locator('option').count(), 2);
  await reopened.getByLabel('書き込みの色', { exact: true }).fill('#112233');
  await reopened.getByLabel('お気に入りのペン', { exact: true }).selectOption('0');
  assert.equal(await reopened.getByLabel('書き込みの色', { exact: true }).inputValue(), '#225588');
  t.diagnostic(JSON.stringify({ engine, documentId, kinds: byId.map(value => value.geometry.kind),
    durableBatches: restarted.edits.map(value => value.batch.id), browserRestarted: true,
    touchCoverage: 'not exercised by mouse suite', preferences: 'color, width and favorite restored after cold restart' }));
});
