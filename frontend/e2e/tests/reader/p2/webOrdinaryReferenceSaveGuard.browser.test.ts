import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';
import { committed } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`pinned reference guards an actual failed edit and exact retry (${engine})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const otherTitle = `Guard destination ${engine}`;
  await createNotebook(page, otherTitle);
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'reference-save-guard.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: 'reference-save-guard.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const before = await committed(page, id), ref = page.locator('[data-reader-reference]');
  await page.locator('[data-reader-surface="original"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await ref.locator('.react-pdf__Page[data-page-number="1"] canvas').waitFor();
  const identity = await ref.locator('[data-canonical-page]').getAttribute('data-canonical-page'); assert.ok(identity);
  await page.evaluate(documentId => {
    const probe = { enabled: true, attempts: [] as StoredEdit[] };
    (globalThis as unknown as { referenceSaveFault: typeof probe }).referenceSaveFault = probe;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const row = value as { value?: StoredEdit };
      if (this.name === 'edits' && row.value?.batch.targetId === documentId && row.value.batch.kind === 'page') {
        probe.attempts.push(structuredClone(row.value));
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('P2 reference save abort', 'AbortError'); }
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  }, id);
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await gesture(page, [[.2, .4]], 'PDF書き込みレイヤー');
  await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill('保持する保存失敗');
  await page.getByRole('button', { name: '確定', exact: true }).click();
  await page.getByRole('alert').filter({ has: page.getByRole('button', { name: '再試行', exact: true }) }).waitFor();
  const failed = await committed(page, id); assert.deepEqual(failed.edits, before.edits);
  await page.getByRole('button', { name: '固定を解除', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /入力や保存/ }).waitFor();
  await ref.locator(`[data-canonical-page="${identity}"]`).waitFor();
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: otherTitle, exact: true }).click();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
  await ref.locator(`[data-canonical-page="${identity}"]`).waitFor();
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し、保存を確認してから切り替えてください。' }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
  await ref.locator(`[data-canonical-page="${identity}"]`).waitFor();
  await page.evaluate(() => { (globalThis as unknown as { referenceSaveFault: { enabled: boolean } }).referenceSaveFault.enabled = false; });
  await page.getByRole('alert').filter({ has: page.getByRole('button', { name: '再試行', exact: true }) }).getByRole('button', { name: '再試行', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).waitFor();
  const after = await committed(page, id);
  const attempts = await page.evaluate(() => (globalThis as unknown as { referenceSaveFault: { attempts: StoredEdit[] } }).referenceSaveFault.attempts);
  assert.ok(attempts.length >= 2); for (const attempt of attempts) assert.deepEqual(attempt.batch, attempts[0].batch);
  assert.equal(after.edits.filter(edit => edit.batch.id === attempts[0].batch.id).length, 1);
  assert.equal(after.edits.length, before.edits.length + 1);
  assert.equal(after.pendingIntents, 0); assert.ok(after.edits.find(edit => edit.batch.id === attempts[0].batch.id)?.receipt.durable);
  await ref.locator(`[data-canonical-page="${identity}"]`).waitFor();
  t.diagnostic(JSON.stringify({ engine, id, exactRetry: true, durableOnce: true, pinnedReferenceRetained: true }));
});
