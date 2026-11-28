import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page, Response } from 'playwright-core';
import type { EditWriteRequest } from '../../../src/runtime/edits/contracts.ts';
import type { BatchReceipt, EditScope, RepositoryState } from '../../../src/runtime/edits/ports.ts';
import { InstalledTrial } from '../../lib/trialRelease.ts';

function body(response: Response) { return response.request().postDataJSON() as EditWriteRequest & { scope: EditScope }; }
async function durable(page: Page, documentId: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/edits/commit' && value.request().method() === 'POST');
  await action(); const reply = await response; assert.equal(reply.status(), 200);
  const request = body(reply), result = await reply.json() as { status: string; receipt: BatchReceipt };
  assert.equal(request.batch.targetId, documentId); assert.ok(request.history);
  assert.equal(request.history.operationId, request.batch.id); assert.equal(request.history.afterVersion, request.batch.id);
  assert.equal(result.status, 'durable'); assert.equal(result.receipt.durable, true);
  assert.equal(result.receipt.id, request.batch.id); assert.equal(result.receipt.targetId, documentId);
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
  return { request, receipt: result.receipt };
}
async function draw(page: Page, y: number) {
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true }); await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * y); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * y, { steps: 12 }); await page.mouse.up();
}
const ink = (page: Page) => page.locator('[data-reader-root] [data-ink-id]').evaluateAll(elements => elements.map(element => ({
  id: element.getAttribute('data-ink-id'), drawing: element.innerHTML,
})));

test('installed trial release saves A/B, undoes B, cold-reopens the same notebook and closes packaged sidecar', { timeout: 300_000 }, async t => {
  const manifest = process.env.PAPEER_SHARED_TRIAL_TEST_MANIFEST, results = process.env.PAPEER_SHARED_TRIAL_TEST_RESULTS;
  assert.ok(manifest && results, 'dedicated trial runner requires installed manifest and a fresh checkpoint results path');
  const app = new InstalledTrial(manifest, results); let passed = false, failure: unknown;
  t.signal.addEventListener('abort', () => { void app.finish(false, new Error('installed trial test aborted or timed out')).catch(() => undefined); }, { once: true });
  t.after(() => app.finish(passed, failure));
  try {
    let page = await app.launch(); t.diagnostic('installed trial release and packaged sidecar paths verified');
    await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
    const library = 'Installed trial library', notebook = 'Installed trial notebook';
    await page.getByLabel('新しいライブラリの名前').fill(library);
    await page.getByRole('button', { name: '作成', exact: true }).click();
    await page.getByRole('button', { name: '確認しました', exact: true }).click();
    await page.getByRole('button', { name: library, exact: true }).click();
    await page.getByLabel('新しい資料の名前', { exact: true }).fill(notebook);
    await page.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
    await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
    const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    const a = await durable(page, documentId, () => draw(page, .25));
    await page.waitForFunction(() => document.querySelectorAll('[data-reader-root] [data-ink-id]').length === 1);
    const first = (await ink(page))[0]; assert.ok(first?.id);
    const b = await durable(page, documentId, () => draw(page, .4));
    await page.waitForFunction(() => document.querySelectorAll('[data-reader-root] [data-ink-id]').length === 2);
    const second = (await ink(page)).find(value => value.id !== first.id); assert.ok(second?.id);
    assert.notEqual(a.request.batch.id, b.request.batch.id);
    const undo = await durable(page, documentId, () => page.getByRole('button', { name: '元に戻す', exact: true }).click());
    assert.equal(undo.request.history?.action?.kind, 'undo'); assert.equal(undo.request.history?.action?.operationId, b.request.batch.id);
    await page.waitForFunction(id => {
      const values = [...document.querySelectorAll('[data-reader-root] [data-ink-id]')];
      return values.length === 1 && values[0].getAttribute('data-ink-id') === id;
    }, first.id);
    assert.deepEqual(await ink(page), [first]);
    Object.assign(app.evidence, { documentId, scope: a.request.scope, A: first, B: second,
      batches: [a.request.batch.id, b.request.batch.id, undo.request.batch.id], receipts: [a.receipt, b.receipt, undo.receipt] });
    t.diagnostic('A, B and Undo(B) each have actual packaged-sidecar durable receipts');
    page = await app.coldRestart();
    await page.getByRole('button', { name: library, exact: true }).click();
    const reading = page.waitForResponse(value => {
      if (new URL(value.url()).pathname !== '/api/edits/read' || value.request().method() !== 'POST') return false;
      return (value.request().postDataJSON() as { targetId?: string }).targetId === documentId;
    });
    await page.getByRole('button', { name: notebook, exact: true }).click();
    const read = await reading; assert.equal(read.status(), 200); assert.deepEqual((read.request().postDataJSON() as { scope: unknown }).scope, a.request.scope);
    const state = await read.json() as RepositoryState;
    assert.deepEqual(state.checkpoint.batches.map(value => value.id).sort(), [a.request.batch.id, b.request.batch.id, undo.request.batch.id].sort());
    for (const expected of [a, b, undo]) {
      assert.deepEqual(state.checkpoint.batches.find(value => value.id === expected.request.batch.id), expected.request.batch);
      assert.deepEqual(state.receipts.find(value => value.id === expected.receipt.id), expected.receipt);
    }
    assert.ok(state.history.some(value => value.action?.kind === 'undo' && value.action.operationId === b.request.batch.id));
    await page.getByRole('heading', { name: notebook, exact: true }).waitFor();
    assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
    await page.waitForFunction(id => {
      const values = [...document.querySelectorAll('[data-reader-root] [data-ink-id]')];
      return values.length === 1 && values[0].getAttribute('data-ink-id') === id;
    }, first.id);
    assert.deepEqual(await ink(page), [first]);
    await page.screenshot({ path: `${app.resultDirectory}/restored-A.png` });
    app.evidence.coldRestored = { sameScope: true, sameDocumentId: true, exactBatchAndReceiptReadback: true, AOnly: true };
    await app.closeNormally(); passed = true;
  } catch (error) { failure = error; throw error; }
  finally { await app.finish(passed, failure); }
});
