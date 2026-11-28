// B13-f (1), T29: the ink toolbar preferences (the ten stored items) on the ordinary Web notebook screen: set through the real toolbar, read back from the real
// localStorage record, restored after a cold restart, and separate for each Library. Mouse-driven headless engines only (no touch, no Pencil, no real finger drawing).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { createNotebook, ordinaryWeb } from './ordinaryWeb.ts';
import { INK_PREFIX, catalogLibraryIds, createAndOpenLibrary, onlyRecord, storedRecords, switchToLibrary } from '../../../support/ordinaryWorkspace.ts';

const initial = { color: '#dc2626', width: 0.003, highColor: '#facc15', highWidth: 0.025, straight: true, partial: false, eraserRadius: 10, highlightOnly: false, fingerDraw: false, presets: [] };

async function toolbarState(page: Page) {
  const color = () => page.getByLabel('書き込みの色', { exact: true }).inputValue();
  const width = () => page.getByLabel('線の太さ', { exact: true }).inputValue();
  const kind = page.getByLabel('描画の種類', { exact: true });
  const state: Record<string, unknown> = { fingerDraw: await page.getByRole('checkbox', { name: '指で描く', exact: true }).isChecked() };
  await kind.selectOption('pen'); state.color = await color(); state.width = await width();
  await kind.selectOption('highlighter'); state.highColor = await color(); state.highWidth = await width();
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  state.eraserRadius = await page.getByLabel('消しゴムの大きさ', { exact: true }).inputValue();
  state.partial = await page.getByLabel('部分消しゴム', { exact: true }).isChecked();
  state.highlightOnly = await page.getByLabel('蛍光ペンだけ消す', { exact: true }).isChecked();
  state.presets = await page.getByLabel('お気に入りのペン', { exact: true }).locator('option').evaluateAll(options => options.slice(1).map(option => option.textContent));
  return state;
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary ink toolbar preferences (colour, width, highlighter, eraser, finger, favourites) survive cold restart and stay per Library (${engine})`, { timeout: 400_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page;
  const title = `T29 ink ${engine}`; await createNotebook(page, title);
  const kind = page.getByLabel('描画の種類', { exact: true });
  // The ordinary toolbar offers no control for the stored "straight" item (only a retired ink toolbar had one), so it can only be observed in the record.
  assert.equal(await page.getByRole('checkbox', { name: '直線' }).count(), 0, 'no straight-line preference checkbox in the ordinary notebook toolbar (the 直線 option of the drawing kind is a shape, not this preference)');
  assert.equal(await page.getByLabel('書き込みの色', { exact: true }).inputValue(), initial.color);
  assert.equal(await page.getByRole('checkbox', { name: '指で描く', exact: true }).isChecked(), false);
  assert.equal((await storedRecords(page, INK_PREFIX)).length, 0, 'an untouched Library stores no ink preference record');
  // Pen colour, width and a favourite.
  await page.getByLabel('書き込みの色', { exact: true }).fill('#225588');
  await page.getByLabel('線の太さ', { exact: true }).selectOption('0.006');
  await page.getByRole('button', { name: '現在のペンをお気に入りに追加', exact: true }).click();
  await page.getByRole('checkbox', { name: '指で描く', exact: true }).check();
  // Highlighter colour and width are stored apart from the pen's.
  await kind.selectOption('highlighter');
  await page.getByLabel('書き込みの色', { exact: true }).fill('#123456');
  await page.getByLabel('線の太さ', { exact: true }).selectOption('0.04');
  await page.getByRole('button', { name: '現在のペンをお気に入りに追加', exact: true }).click();
  await kind.selectOption('pen');
  assert.equal(await page.getByLabel('書き込みの色', { exact: true }).inputValue(), '#225588', 'the pen colour is not the highlighter colour');
  // Eraser radius, partial erase, highlighter-only erase.
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('消しゴムの大きさ', { exact: true }).selectOption('20');
  await page.getByLabel('部分消しゴム', { exact: true }).check();
  await page.getByLabel('蛍光ペンだけ消す', { exact: true }).check();
  const expected = { version: 1, preferences: { ...initial, color: '#225588', width: 0.006, highColor: '#123456', highWidth: 0.04, partial: true, eraserRadius: 20,
    highlightOnly: true, fingerDraw: true, presets: [{ color: '#225588', width: 0.006 }, { color: '#123456', width: 0.04 }] } };
  const stored = await onlyRecord(page, INK_PREFIX);
  assert.deepEqual(JSON.parse(stored.raw), expected, 'the real localStorage record holds all ten items');
  assert.ok((await catalogLibraryIds(page)).includes(stored.scope[1]), 'the record key names the real Library catalog id');
  const live = await toolbarState(page);
  page = await app.restart(title);
  const restored = await toolbarState(page);
  assert.deepEqual(restored, live, 'every toolbar value after a cold restart equals the value before it');
  assert.equal(restored.color, '#225588'); assert.equal(restored.highColor, '#123456'); assert.equal(restored.width, '0.006'); assert.equal(restored.highWidth, '0.04');
  assert.equal(restored.eraserRadius, '20'); assert.equal(restored.partial, true); assert.equal(restored.highlightOnly, true); assert.equal(restored.fingerDraw, true);
  assert.equal((restored.presets as string[]).length, 2);
  assert.equal((await onlyRecord(page, INK_PREFIX)).raw, stored.raw, 'restoring rewrites nothing');
  // A second Library starts from the initial values and keeps its own.
  const second = `T29 second ${engine}`; await createAndOpenLibrary(page, second);
  await createNotebook(page, `${title} B`);
  assert.equal(await page.getByLabel('書き込みの色', { exact: true }).inputValue(), initial.color, 'a new Library does not inherit the first Library colour');
  assert.equal(await page.getByRole('checkbox', { name: '指で描く', exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel('お気に入りのペン', { exact: true }).locator('option').count(), 1, 'no favourites yet');
  await page.getByLabel('書き込みの色', { exact: true }).fill('#00aa00');
  const records = await storedRecords(page, INK_PREFIX);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.scope[1]).sort(), await catalogLibraryIds(page), 'one record per real Library catalog id');
  assert.equal(records.find(record => record.key === stored.key)?.raw, stored.raw, 'the first Library record is byte-identical');
  await switchToLibrary(page, app.library);
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByLabel('書き込みの色', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('書き込みの色', { exact: true }).inputValue(), '#225588');
  t.diagnostic(JSON.stringify({ engine, items: 10, restoredThroughUi: 9, straight: 'record only (no ordinary control)', libraries: 2, coldRestarts: 1 }));
});
