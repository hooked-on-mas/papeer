import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { committed } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

type Fault = { enabled: boolean; failures: number; reads: number };
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary fixed reference resource failure and document draft guard (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const other = `reference guard destination ${engine}`;
  await createNotebook(page, other);
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'reference-lifecycle.pdf');
  const generated = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: 'reference-lifecycle.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  if (await catalog.getAttribute('aria-expanded') === 'true') await catalog.click();
  const before = await committed(page, id), background = before.root.pages[0].background;
  assert.equal(background.kind, 'pdf'); if (background.kind !== 'pdf') throw new Error('PDF required');
  await page.locator('[data-reader-surface="original"] [data-rendered="true"] .react-pdf__Page canvas').waitFor();
  const ref = page.locator('[data-reader-reference]');
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await ref.locator('[data-rendered="true"] .react-pdf__Page canvas').waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.getByLabel('取り込む訳文PDF', { exact: true }).click(); await (await chooser).setFiles(file);
  const first = page.getByLabel('訳文1ページに対応する原文ページ', { exact: true });
  await first.selectOption(before.root.pages[0].id);
  await page.getByLabel('訳文2ページに対応する原文ページ', { exact: true }).selectOption(before.root.pages[1].id);
  await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).click();
  await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => { const input = document.querySelector<HTMLInputElement>('[aria-label="取り込む訳文PDF"]'); return !!input && !input.disabled; });
  await page.getByRole('button', { name: '訳文', exact: true }).click();
  try { await page.locator('[data-reader-surface="translated"] [data-rendered="true"] .react-pdf__Page canvas').waitFor(); } catch (error) {
    t.diagnostic(JSON.stringify({ display: await page.locator('[data-document-display]').getAttribute('data-document-display').catch(() => null),
      translatedText: await page.locator('[data-reader-surface="translated"]').innerText().catch(() => null),
      originalText: await page.locator('[data-reader-surface="original"]').innerText().catch(() => null),
      alerts: await page.getByRole('alert').allTextContents(), statuses: await page.getByRole('status').allTextContents(),
      translationPanel: await page.getByRole('region', { name: '訳文PDFの取込', exact: true }).innerText().catch(() => null),
      translatedButton: { pressed: await page.getByRole('button', { name: '訳文', exact: true }).getAttribute('aria-pressed'), disabled: await page.getByRole('button', { name: '訳文', exact: true }).isDisabled() },
      committed: await committed(page, id).catch(e => String(e)) })); throw error;
  }
  const translated = await committed(page, id);
  const translation = translated.edits.find(e => e.batch.kind === 'document')?.batch;
  assert.ok(translation && translation.kind === 'document');
  const change = translation.changes.find(c => c.type === 'translation'); assert.ok(change?.type === 'translation' && change.translation);
  const translatedBackground = change.translation.pages[0].background; assert.equal(translatedBackground.kind, 'pdf');
  if (translatedBackground.kind !== 'pdf') throw new Error('translated PDF required');
  await page.evaluate(resourceId => {
    const fault: Fault = { enabled: true, failures: 0, reads: 0 };
    (globalThis as unknown as { referenceReadFault: Fault }).referenceReadFault = fault;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'resources' && typeof key === 'string' && (JSON.parse(key) as string[])[1] === resourceId) {
        fault.reads++; if (fault.enabled) { fault.failures++; this.transaction.abort(); throw new DOMException('reference read abort', 'AbortError'); }
      }
      return get.call(this, key);
    };
  }, translatedBackground.resourceId);
  await page.getByRole('button', { name: '現在のページに置き換える', exact: true }).click();
  try { await ref.getByRole('alert').waitFor({ timeout: 8000 }); } catch (error) {
    t.diagnostic(JSON.stringify({ fault: await page.evaluate(() => (globalThis as unknown as { referenceReadFault: Fault }).referenceReadFault), refText: await ref.innerText(), refHtml: (await ref.innerHTML()).slice(0, 3000), alerts: await page.getByRole('alert').allTextContents() })); throw error;
  }
  assert.ok(await page.evaluate(() => (globalThis as unknown as { referenceReadFault: Fault }).referenceReadFault.failures) > 0);
  await page.locator('[data-reader-surface="translated"] [data-rendered="true"] .react-pdf__Page canvas').waitFor();
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
  await page.evaluate(() => { (globalThis as unknown as { referenceReadFault: Fault }).referenceReadFault.enabled = false; });
  await ref.getByRole('button', { name: 'PDFを再取得', exact: true }).click();
  await ref.locator('[data-rendered="true"] .react-pdf__Page canvas').waitFor();
  assert.equal(await ref.locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await gesture(page, [[.2, .4]], 'PDF書き込みレイヤー');
  const draft = page.getByRole('textbox', { name: '書き込みテキスト', exact: true }); await draft.fill('移動しない下書き');
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: other, exact: true }).click();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
  await draft.waitFor(); assert.equal(await draft.inputValue(), '移動しない下書き');
  await ref.locator('.react-pdf__Page canvas').waitFor();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  const after = await committed(page, id); assert.deepEqual(after, translated);
  await page.getByRole('button', { name: other, exact: true }).click();
  await page.getByRole('heading', { name: other, exact: true }).waitFor();
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: 'reference-lifecycle.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).waitFor();
  t.diagnostic(JSON.stringify({ engine, id, resourceFailure: true, isolatedRetry: true, draftDocumentLeaveRefused: true, successfulLeaveDiscardsReference: true, referenceActionsAddedEdits: 0 }));
});
