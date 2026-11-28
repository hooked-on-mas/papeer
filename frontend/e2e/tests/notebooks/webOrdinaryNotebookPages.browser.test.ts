import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { DocumentSnapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { documentContent } from '../../../src/runtime/edits/documentPages.ts';
import { committed } from '../reader/p2/ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';

type Observation = Awaited<ReturnType<typeof committed>>;
/** Pure readback of real stored operations; no session/repository construction or write authority. */
function snapshot(value: Observation): DocumentSnapshot {
  let current = value.root; const rest = [...value.edits];
  while (rest.length) {
    const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version);
    assert.ok(index >= 0, 'expected this ordinary case to have one complete linear history');
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
    assert.ok(Date.now() < until, `expected ${count} exact durable operations with history`); await delay(50);
  }
}
async function jump(page: Page, number: number) {
  const input = page.getByLabel('ページ番号', { exact: true });
  await input.fill(String(number)); await input.press('Enter'); assert.equal(await input.inputValue(), String(number));
}
async function intents(page: Page, id: string) {
  return page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('papeer-shared-edits');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing IDB required')); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<unknown[]>((resolve, reject) => { const tx = db.transaction('intents', 'readonly'), r = tx.objectStore('intents').getAll();
      tx.oncomplete = () => resolve(r.result.filter((row: { key: string }) => (JSON.parse(row.key) as string[])[1] === id)); tx.onabort = () => reject(tx.error); }); }
    finally { db.close(); }
  }, id);
}
async function pageAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'ページ操作', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
type Fault = { enabled: boolean; attempts: StoredEdit[] };
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary notebook pages share ink structure history, exact retry and cold restart (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `P3 paper history ${engine}`;
  let phase = 'create';
  try {
    const id = await createNotebook(page, title), initial = await committed(page, id);
    assert.equal(initial.root.pages.length, 1); const firstId = initial.root.pages[0].id;
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    await gesture(page, [[.2, .25], [.45, .3]]);
    const a = snapshot(await saved(page, id, 1)).pages[0].annotations; assert.equal(a.length, 1);
    phase = 'duplicate-add-move';
    await pageAction(page, 'ページ複製');
    const duplicated = snapshot(await saved(page, id, 2));
    assert.equal(duplicated.pages.length, 2); const copy = duplicated.pages[1], copyId = copy.id;
    assert.notEqual(copyId, firstId); assert.notEqual(copy.annotations[0].id, a[0].id);
    assert.deepEqual(copy.annotations.map(value => ({ ...value, id: '' })), a.map(value => ({ ...value, id: '' })));
    await page.getByRole('button', { name: 'ページ追加', exact: true }).click();
    const added = snapshot(await saved(page, id, 3)), blankId = added.pages[2].id;
    assert.deepEqual(added.pages.map(value => value.id), [firstId, copyId, blankId]); assert.deepEqual(added.pages[2].annotations, []);
    await pageAction(page, '前へ移動');
    assert.deepEqual(snapshot(await saved(page, id, 4)).pages.map(value => value.id), [firstId, blankId, copyId]);
    await gesture(page, [[.25, .6], [.5, .65]]);
    const inked = snapshot(await saved(page, id, 5)), b = inked.pages[1].annotations; assert.equal(b.length, 1); assert.notEqual(b[0].id, a[0].id);
    phase = 'delete-and-history';
    await pageAction(page, 'ページ削除');
    const deleted = snapshot(await saved(page, id, 6));
    assert.deepEqual(deleted.pages.map(value => value.id), [firstId, copyId]);
    assert.deepEqual(deleted.deletedPages.find(value => value.id === blankId)?.annotations, b);
    const undoOrders = [[firstId, blankId, copyId], [firstId, blankId, copyId], [firstId, copyId, blankId], [firstId, copyId], [firstId], [firstId]];
    for (let i = 0; i < undoOrders.length; i++) {
      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      const value = snapshot(await saved(page, id, 7 + i)); assert.deepEqual(value.pages.map(page => page.id), undoOrders[i]);
      if (i === 0) assert.deepEqual(value.pages[1].annotations, b);
      if (i === 1) assert.deepEqual(value.pages[1].annotations, []);
    }
    const undone = snapshot(await committed(page, id)); assert.deepEqual(undone.pages[0].annotations, []);
    const redoOrders = [[firstId], [firstId, copyId], [firstId, copyId, blankId], [firstId, blankId, copyId], [firstId, blankId, copyId], [firstId, copyId]];
    for (let i = 0; i < redoOrders.length; i++) {
      await page.getByRole('button', { name: 'やり直す', exact: true }).click();
      assert.deepEqual(snapshot(await saved(page, id, 13 + i)).pages.map(page => page.id), redoOrders[i]);
    }
    const beforeFailure = await committed(page, id), beforeState = snapshot(beforeFailure);
    assert.deepEqual(documentContent(beforeState).pages, documentContent(deleted).pages);
    await jump(page, 1);
    phase = 'real-structure-abort';
    await page.evaluate(documentId => {
      const probe: Fault = { enabled: true, attempts: [] }; (globalThis as unknown as { notebookFault: Fault }).notebookFault = probe;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        const row = value as { value?: StoredEdit }, edit = row.value;
        if (this.name === 'edits' && edit?.batch.targetId === documentId && edit.batch.kind === 'document' && edit.batch.changes.some(change => change.type === 'insert')) {
          probe.attempts.push(structuredClone(edit));
          if (probe.enabled) { this.transaction.abort(); throw new DOMException('P3 structure transaction abort', 'AbortError'); }
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }, id);
    await pageAction(page, 'ページ複製');
    const failure = page.getByRole('alert').filter({ has: page.getByRole('button', { name: '再試行', exact: true }) }); await failure.waitFor();
    assert.deepEqual(await committed(page, id), { ...beforeFailure, pendingIntents: 1 }, 'aborted structure transaction has no partial durable page, ink or history');
    const retained = await intents(page, id); assert.equal(retained.length, 1);
    await page.getByLabel('ページ番号', { exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し、保存を確認してから切り替えてください。' }).waitFor();
    assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
    assert.deepEqual(await intents(page, id), retained, 'blocked transition preserves the full exact journal intent');
    await page.evaluate(() => { (globalThis as unknown as { notebookFault: Fault }).notebookFault.enabled = false; });
    await failure.getByRole('button', { name: '再試行', exact: true }).click();
    const after = await saved(page, id, 19), attempts = await page.evaluate(() => (globalThis as unknown as { notebookFault: Fault }).notebookFault.attempts);
    assert.ok(attempts.length >= 2); for (const attempt of attempts) { assert.deepEqual(attempt.batch, attempts[0].batch); assert.deepEqual(attempt.history, attempts[0].history); }
    assert.equal(after.edits.filter(edit => edit.batch.id === attempts[0].batch.id).length, 1);
    const operation = attempts[0].batch; assert.equal(operation.kind, 'document'); if (operation.kind !== 'document') throw new Error('structure command required');
    const insertion = operation.changes.find(change => change.type === 'insert'); assert.ok(insertion?.type === 'insert');
    const final = snapshot(after); assert.deepEqual(final.pages.map(value => value.id), [firstId, insertion.page.id, copyId]);
    assert.deepEqual(final.deletedPages.find(value => value.id === blankId)?.annotations, b);
    phase = 'cold-restart';
    const reopened = await app.restart(title); assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
    const restarted = await saved(reopened, id, 19); assert.deepEqual(restarted.edits, after.edits); assert.deepEqual(snapshot(restarted), final); assert.equal(restarted.pendingIntents, 0);
    t.diagnostic(JSON.stringify({ engine, id, firstId, copyId, deletedPageId: blankId, retriedPageId: insertion.page.id, durableOperations: 19, exactHistoryRetry: true, coldRestart: true }));
  } catch(error) { console.error(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
});
