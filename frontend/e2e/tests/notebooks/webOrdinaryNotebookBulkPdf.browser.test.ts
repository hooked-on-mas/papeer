import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { ordinarySaved, ordinarySnapshot } from '../../support/ordinaryDocument.ts';
import { committed, resource } from '../reader/p2/ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';

type BulkFault = { enabled: boolean; attempts: StoredEdit[] };
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary notebook whole-PDF insertion is one atomic retryable history operation (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const title = `P3 bulk PDF ${engine}`, id = await createNotebook(page, title);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(page, [[.2, .3], [.4, .35]]);
  const original = await ordinarySaved(page, id, 1), paper = ordinarySnapshot(original).pages[0];
  const root = path.resolve(import.meta.dirname, '../../../..'), file = path.join(app.scratch, 'bulk-pages.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  const chooser = page.waitForEvent('filechooser');
  await page.getByLabel('ノートに取り込むPDF', { exact: true }).click(); await (await chooser).setFiles(file);
  await page.getByLabel('PDFページの配置', { exact: true }).selectOption('insert-all');
  await page.getByRole('button', { name: 'PDFページを適用', exact: true }).waitFor();
  await page.evaluate(documentId => {
    const probe: BulkFault = { enabled: true, attempts: [] };
    (globalThis as unknown as { bulkFault: BulkFault }).bulkFault = probe;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      const edit = (value as { value?: StoredEdit }).value;
      if (this.name === 'edits' && edit?.batch.targetId === documentId && edit.batch.kind === 'document'
        && edit.batch.changes.filter(change => change.type === 'insert').length === 2) {
        probe.attempts.push(structuredClone(edit));
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('P3 bulk transaction abort', 'AbortError'); }
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  }, id);
  await page.getByRole('button', { name: 'PDFページを適用', exact: true }).click();
  const error = page.getByRole('alert').filter({ has: page.getByRole('button', { name: '再試行', exact: true }) });
  await error.waitFor();
  assert.deepEqual(await committed(page, id), { ...original, pendingIntents: 1 }, 'the aborted transaction publishes neither of its two pages');
  const attemptsBefore = await page.evaluate(() => (globalThis as unknown as { bulkFault: BulkFault }).bulkFault.attempts);
  assert.ok(attemptsBefore.length >= 1);
  const attempt = attemptsBefore[0].batch;
  assert.equal(attempt.kind, 'document');
  if (attempt.kind !== 'document') throw new Error('one document batch required');
  const inserts = attempt.changes.filter(change => change.type === 'insert'); assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map(change => change.index), [1, 2]);
  assert.deepEqual(inserts.map(change => change.page.background.kind === 'pdf' ? change.page.background.pdfPage : null), [1, 2]);
  const insertedIds = inserts.map(change => change.page.id);
  assert.equal(new Set([paper.id, ...insertedIds]).size, 3);
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し、保存を確認してから切り替えてください。' }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
  await page.evaluate(() => { (globalThis as unknown as { bulkFault: BulkFault }).bulkFault.enabled = false; });
  await error.getByRole('button', { name: '再試行', exact: true }).click();
  const inserted = await ordinarySaved(page, id, 2), mixed = ordinarySnapshot(inserted);
  const attempts = await page.evaluate(() => (globalThis as unknown as { bulkFault: BulkFault }).bulkFault.attempts);
  assert.ok(attempts.length >= 2);
  for (const row of attempts) { assert.deepEqual(row.batch, attemptsBefore[0].batch); assert.deepEqual(row.history, attemptsBefore[0].history); }
  assert.equal(inserted.edits.filter(edit => edit.batch.id === attempt.id).length, 1);
  assert.deepEqual(mixed.pages.map(p => p.id), [paper.id, ...insertedIds]);
  assert.deepEqual(mixed.pages[0], paper);
  const bg = mixed.pages[1].background; assert.equal(bg.kind, 'pdf');
  if (bg.kind !== 'pdf') throw new Error('PDF background required');
  assert.ok(mixed.pages.slice(1).every(p => p.background.kind === 'pdf' && p.background.resourceId === bg.resourceId));
  const stored = await resource(page, inserted.namespace, bg.resourceId);
  assert.equal(stored.actualSha256, bg.sourceRevision); assert.equal(stored.metadata.pdfPages?.length, 2);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = ordinarySnapshot(await ordinarySaved(page, id, 3));
  assert.deepEqual(undone.pages, [paper]);
  assert.deepEqual(undone.deletedPages.map(p => p.id).sort(), [...insertedIds].sort());
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  const redone = await ordinarySaved(page, id, 4), restored = ordinarySnapshot(redone);
  assert.deepEqual(restored.pages.map(p => p.id), [paper.id, ...insertedIds]);
  assert.deepEqual(restored.pages.map(p => p.background), mixed.pages.map(p => p.background));
  const reopened = await app.restart(title);
  assert.deepEqual(await ordinarySaved(reopened, id, 4), redone);
  assert.deepEqual(await resource(reopened, redone.namespace, bg.resourceId), stored);
  for (const [number, physical] of [[2, 1], [3, 2]]) {
    const input = reopened.getByLabel('ページ番号', { exact: true }); await input.fill(String(number)); await input.press('Enter');
    await reopened.locator(`[data-reader-surface="original"] [data-rendered="true"] .react-pdf__Page[data-page-number="${physical}"] canvas`).waitFor();
  }
  t.diagnostic(JSON.stringify({ engine, documentId: id, pageIds: restored.pages.map(p => p.id), exactEdits: 4,
    oneBulkBatch: true, realTransactionAbort: true, sameBatchRetry: true, undoRedoBothPages: true, coldRestart: true }));
});
