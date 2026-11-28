import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** R03 (A07): one eraser gesture over several strokes; the durable write is aborted at the real IndexedDB transaction. */
type Fault = { enabled: boolean; attempts: StoredEdit[]; restore: () => void };
const probeName = 'eraseFault';

/** Abort the `edits` put of the first batch that carries the given change type for this notebook; every attempt is recorded. */
async function injectAbort(page: Page, documentId: string, type: 'delete' | 'update') {
  await page.evaluate(({ documentId, type, probeName }) => {
    const probe: Fault = { enabled: true, attempts: [], restore: () => {} };
    (globalThis as unknown as Record<string, Fault>)[probeName] = probe;
    const put = IDBObjectStore.prototype.put;
    probe.restore = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      const edit = (value as { value?: StoredEdit }).value;
      if (this.name === 'edits' && edit?.batch.targetId === documentId && edit.batch.kind === 'page'
        && edit.batch.changes.some(change => change.type === type)) {
        probe.attempts.push(structuredClone(edit));
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('R03 erase transaction abort', 'AbortError'); }
      }
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  }, { documentId, type, probeName });
}
const attempts = (page: Page) => page.evaluate(name => (globalThis as unknown as Record<string, Fault>)[name].attempts, probeName);
const allowWrites = (page: Page) => page.evaluate(name => { (globalThis as unknown as Record<string, Fault>)[name].enabled = false; }, probeName);
const removeProbe = (page: Page) => page.evaluate(name => { (globalThis as unknown as Record<string, Fault>)[name].restore(); }, probeName);

/** The journal intents the app keeps for this notebook (read-only IndexedDB observation). */
async function intents(page: Page, documentId: string) {
  return page.evaluate(async documentId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing IDB required')); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      return await new Promise<unknown[]>((resolve, reject) => { const tx = db.transaction('intents', 'readonly'), request = tx.objectStore('intents').getAll();
        tx.oncomplete = () => resolve(request.result.filter((row: { key: string }) => (JSON.parse(row.key) as string[])[1] === documentId));
        tx.onabort = () => reject(tx.error); });
    } finally { db.close(); }
  }, documentId);
}

const cases = [
  { mode: 'whole', type: 'delete' as const, partial: false, y: [.2, .7], inksAfter: 0 },
  { mode: 'partial', type: 'update' as const, partial: true, y: [.25, .5], inksAfter: 5 },
];
for (const engine of ['chromium', 'webkit'] as const) for (const scenario of cases) test(`ordinary erase of several strokes survives an aborted IndexedDB write: ${scenario.mode} (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `R03 erase ${scenario.mode} ${engine}`;
  let phase = 'draw';
  try {
    const documentId = await createNotebook(page, title);
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    const ids: string[] = [];
    for (const [index, y] of [.3, .45, .6].entries()) {
      await gesture(page, [[.2, y], [.6, y]]);
      await page.waitForFunction(count => document.querySelectorAll('[data-ink-id]').length === count, index + 1);
      ids.push((await inks(page)).map(value => value.id).find(id => !ids.includes(id))!);
      await durable(page, documentId, ids, index + 1);
    }
    const drawn = await durable(page, documentId, ids, 3), drawnInks = await inks(page);
    assert.equal(drawnInks.length, 3); assert.equal(drawn.edits.length, 3);

    phase = 'erase-with-abort';
    await page.getByRole('button', { name: '消しゴム', exact: true }).click();
    const partial = page.getByLabel('部分消しゴム', { exact: true });
    if (scenario.partial) await partial.check(); else await partial.uncheck();
    await injectAbort(page, documentId, scenario.type);
    await gesture(page, [[.4, scenario.y[0]], [.4, scenario.y[1]]]);
    const failure = page.getByRole('alert').filter({ has: page.getByRole('button', { name: '再試行', exact: true }) });
    await failure.waitFor();
    assert.match(await failure.innerText(), /書き込みを保存できません。内容を保持しています。再試行してください。/);
    // Nothing durable: the same three drawing batches, one retained journal intent, no erase batch.
    assert.deepEqual(await committed(page, documentId), { ...drawn, pendingIntents: 1 }, 'aborted erase transaction left no partial durable batch, receipt or history');
    assert.equal((await intents(page, documentId)).length, 1);
    // The screen shows the whole gesture or nothing of it: never a mix of erased and original strokes.
    const failedInks = await inks(page);
    assert.equal(failedInks.length, scenario.inksAfter);
    if (scenario.partial) {
      assert.deepEqual(failedInks.filter(value => value.id === ids[2]), [drawnInks[2]], 'untouched stroke is exactly as drawn');
      for (const id of ids.slice(0, 2)) assert.notDeepEqual(failedInks.find(value => value.id === id), drawnInks[ids.indexOf(id)], 'both crossed strokes were cut');
    }
    const failedAttempts = await attempts(page); assert.equal(failedAttempts.length, 1);
    const operation = failedAttempts[0].batch; assert.equal(operation.kind, 'page'); if (operation.kind !== 'page') throw new Error('page batch required');
    if (scenario.partial) {
      assert.deepEqual(operation.changes.map(change => change.type).sort(), ['create', 'create', 'order', 'update', 'update']);
      assert.deepEqual(operation.changes.flatMap(change => change.type === 'update' ? [change.annotation.id] : []).sort(), [ids[0], ids[1]].sort());
    } else {
      assert.deepEqual(operation.changes.map(change => change.type), ['delete', 'delete', 'delete']);
      assert.deepEqual(operation.changes.flatMap(change => change.type === 'delete' ? [change.id] : []).sort(), [...ids].sort());
    }

    phase = 'retry';
    await allowWrites(page);
    await failure.getByRole('button', { name: '再試行', exact: true }).click();
    const afterIds = failedInks.map(value => value.id);
    const retried = await durable(page, documentId, afterIds, 4);
    const allAttempts = await attempts(page); assert.equal(allAttempts.length, 2, 'one aborted write and one retry of the same operation');
    for (const attempt of allAttempts) { assert.deepEqual(attempt.batch, allAttempts[0].batch); assert.deepEqual(attempt.history, allAttempts[0].history); }
    assert.equal(retried.edits.filter(edit => edit.batch.id === allAttempts[0].batch.id).length, 1, 'retry produced exactly one durable erase batch');
    assert.equal(retried.edits.filter(edit => edit.batch.kind === 'page' && edit.batch.changes.some(change => change.type === scenario.type)).length, 1);
    for (const edit of drawn.edits) assert.deepEqual(retried.edits.find(value => value.batch.id === edit.batch.id), edit, 'earlier batches are untouched');
    assert.equal((await intents(page, documentId)).length, 0);
    assert.deepEqual(await inks(page), failedInks, 'the retry does not change what the screen already showed');
    await removeProbe(page);

    phase = 'cold-restart';
    const reopened = await app.restart(title);
    assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
    const restarted = await durable(reopened, documentId, afterIds, 4);
    assert.deepEqual(restarted.edits, retried.edits); assert.deepEqual(await inks(reopened), failedInks);
    assert.equal(restarted.pendingIntents, 0);

    phase = 'single-undo-redo';
    await reopened.getByRole('button', { name: '元に戻す', exact: true }).click();
    const undone = await durable(reopened, documentId, ids, 5);
    assert.deepEqual(await inks(reopened), drawnInks, 'one Undo restores every erased stroke exactly as drawn');
    for (const edit of retried.edits) assert.deepEqual(undone.edits.find(value => value.batch.id === edit.batch.id), edit);
    await reopened.getByRole('button', { name: 'やり直す', exact: true }).click();
    await durable(reopened, documentId, afterIds, 6);
    assert.deepEqual(await inks(reopened), failedInks, 'Redo re-applies the same erase');
    t.diagnostic(JSON.stringify({ engine, mode: scenario.mode, documentId, strokes: ids, erasedBatch: allAttempts[0].batch.id, abortedAttempts: 1, retried: true, durableEdits: 6, coldRestart: true }));
  } catch (error) { console.error(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
});
