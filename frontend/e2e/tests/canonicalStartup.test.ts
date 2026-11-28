import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { EditWriteRequest } from '../../src/runtime/edits/contracts.ts';
import type { BatchReceipt } from '../../src/runtime/edits/ports.ts';
import { scenario } from '../lib/app.ts';

const libraryName = 'P1 isolated library';
const noteName = 'P1 blank notebook';

async function durableCommit(page: Page, documentId: string, action: () => Promise<void>) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/edits/commit' && value.request().method() === 'POST');
  await action();
  const reply = await response;
  assert.equal(reply.status(), 200);
  const sent = reply.request().postDataJSON() as EditWriteRequest;
  assert.equal(sent.batch.targetId, documentId);
  assert.ok(sent.batch.id);
  assert.ok(sent.history);
  assert.equal(sent.history.operationId, sent.batch.id);
  assert.equal(sent.history.afterVersion, sent.batch.id);
  const body = await reply.json() as { status?: string; receipt?: BatchReceipt };
  assert.equal(body.status, 'durable', JSON.stringify(body));
  assert.ok(body.receipt);
  assert.equal(body.receipt.durable, true);
  assert.equal(body.receipt.id, sent.batch.id);
  assert.equal(body.receipt.targetId, documentId);
  await page.getByRole('status').filter({ hasText: /端末保存済み/ }).first().waitFor();
  return sent;
}

async function draw(page: Page, y: number) {
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * y, { steps: 10 });
  await page.mouse.up();
}

scenario('通常起動から手書き保存・Undo・再起動', { seed: false, timeout: 300_000 }, async (initial, t) => {
  let app = initial, page = app.page;
  t.diagnostic('phase: isolated ordinary entry and local setup');
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  await page.getByLabel('新しいライブラリの名前').fill(libraryName);
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByText(`${libraryName}: 作成しました。一覧を更新してください。`, { exact: true }).waitFor();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  await page.getByRole('button', { name: libraryName, exact: true }).click();
  t.diagnostic('phase: create and open blank notebook');
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteName);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document');
  assert.ok(documentId); assert.match(documentId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  t.diagnostic('phase: draw and durably commit A');
  const a = await durableCommit(page, documentId, () => draw(page, .3));
  const ink = page.locator('[data-reader-root] [data-ink-id]');
  await page.waitForFunction(() => document.querySelectorAll('[data-reader-root] [data-ink-id]').length === 1);
  const firstId = await ink.first().getAttribute('data-ink-id'); assert.ok(firstId);
  const firstSvg = await ink.first().evaluate(element => element.innerHTML);
  t.diagnostic('phase: draw and durably commit B');
  const b = await durableCommit(page, documentId, () => draw(page, .4));
  assert.notEqual(b.batch.id, a.batch.id);
  await page.waitForFunction(() => document.querySelectorAll('[data-reader-root] [data-ink-id]').length === 2);
  const ids = await ink.evaluateAll(elements => elements.map(element => element.getAttribute('data-ink-id')));
  const secondId = ids.find(id => id !== firstId); assert.ok(secondId);
  assert.equal(new Set(ids).size, 2);
  t.diagnostic('phase: Undo B and durably commit inverse');
  const undo = await durableCommit(page, documentId, () => page.getByRole('button', { name: '元に戻す', exact: true }).click());
  assert.notEqual(undo.batch.id, b.batch.id);
  assert.equal(undo.history?.action?.kind, 'undo');
  assert.equal(undo.history?.action?.operationId, b.batch.id);
  await page.waitForFunction(() => document.querySelectorAll('[data-reader-root] [data-ink-id]').length === 1);
  assert.equal(await ink.first().getAttribute('data-ink-id'), firstId);
  assert.equal(await page.locator(`[data-ink-id="${secondId}"]`).count(), 0);
  assert.equal(await ink.first().evaluate(element => element.innerHTML), firstSvg);

  t.diagnostic('phase: controlled restart with same isolated data and WebView profile');
  app = await app.restart(); page = app.page;
  await page.getByRole('button', { name: libraryName, exact: true }).click();
  await page.getByRole('button', { name: noteName, exact: true }).click();
  await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
  await page.waitForFunction(id => {
    const values = [...document.querySelectorAll('[data-reader-root] [data-ink-id]')];
    return values.length === 1 && values[0].getAttribute('data-ink-id') === id;
  }, firstId);
  assert.equal(await page.locator(`[data-ink-id="${secondId}"]`).count(), 0);
  assert.equal(await page.locator('[data-reader-root] [data-ink-id]').first().evaluate(element => element.innerHTML), firstSvg);
  t.diagnostic('phase: same document and A restored, B absent');
});
