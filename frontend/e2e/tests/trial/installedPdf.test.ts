import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Page, Response } from 'playwright-core';
import type { EditWriteRequest } from '../../../src/runtime/edits/contracts.ts';
import type { BatchReceipt, EditScope, RepositoryState } from '../../../src/runtime/edits/ports.ts';
import { InstalledTrial } from '../../lib/trialRelease.ts';

const repo = path.resolve(import.meta.dirname, '../../../..');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function safeFixture(value: string) {
  const resolved = fs.realpathSync(value);
  const within = (root: string) => { const relative = path.relative(fs.realpathSync(root), resolved); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
  assert.ok(within(path.join(repo, 'tests', 'fixtures')) || within(path.join(repo, 'checkpoints')), 'PDF fixture must be in isolated repository fixture/checkpoints');
  assert.equal(path.extname(resolved).toLowerCase(), '.pdf'); return resolved;
}
async function gesture(page: Page, label: string, points: [number, number][]) {
  const surface = page.getByLabel(label, { exact: true }); await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  const [first, ...rest] = points;
  await page.mouse.move(box.x + box.width * first[0], box.y + box.height * first[1]); await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 10 });
  await page.mouse.up();
}
async function durable(page: Page, documentId: string, action: () => Promise<unknown>) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/commit' && response.request().method() === 'POST');
  await action(); const reply: Response = await waiting; assert.equal(reply.status(), 200);
  const request = reply.request().postDataJSON() as EditWriteRequest & { scope: EditScope };
  const result = await reply.json() as { status: string; receipt: BatchReceipt };
  assert.equal(request.batch.targetId, documentId); assert.ok(request.history);
  assert.equal(result.status, 'durable'); assert.equal(result.receipt.durable, true); assert.equal(result.receipt.id, request.batch.id);
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
  return { request, receipt: result.receipt };
}
function interaction(directory: string, phase: string, expectedPath: string | null, state: 'pending' | 'complete') {
  const value = { phase, expectedPath, state, updatedAt: new Date().toISOString(), action: phase === 'pdf-cancel' ? 'cancel' : 'save' };
  const target = path.join(directory, 'interaction-request.json'), temporary = path.join(directory, 'interaction-request.pending.json');
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temporary, target);
}
async function waitForFile(file: string, signal: AbortSignal) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    signal.throwIfAborted();
    if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0) return;
    await delay(250, undefined, { signal });
  }
  throw new Error(`native-save-file-timeout:${file}`);
}
async function saveDialog(page: Page, directory: string, phase: string, file: string, trigger: () => Promise<unknown>, signal: AbortSignal) {
  assert.equal(fs.existsSync(file), false, `output must be fresh: ${file}`);
  await trigger(); interaction(directory, phase, file, 'pending');
  await Promise.all([waitForFile(file, signal), page.getByRole('status').filter({ hasText: /保存しました/ }).waitFor({ timeout: 180_000 })]);
  interaction(directory, phase, file, 'complete');
  return fs.readFileSync(file);
}

test('installed B2 PDF import, annotations, native saves, cold restart and natural close', { timeout: 900_000 }, async t => {
  const manifest = process.env.PAPEER_SHARED_TRIAL_TEST_MANIFEST, results = process.env.PAPEER_SHARED_TRIAL_TEST_RESULTS;
  const configuredFixture = process.env.PAPEER_SHARED_TRIAL_PDF_FIXTURE;
  assert.ok(manifest && results && configuredFixture, 'installed trial manifest, fresh results and isolated PDF fixture are required');
  const fixture = safeFixture(configuredFixture), source = fs.readFileSync(fixture), title = path.basename(fixture);
  assert.equal(source.subarray(0, 5).toString('ascii'), '%PDF-');
  const app = new InstalledTrial(manifest, results, 'frontend/e2e/tests/trial/installedPdf.test.ts');
  let passed = false, failure: unknown;
  t.signal.addEventListener('abort', () => { void app.finish(false, new Error('installed B2 trial aborted or timed out')).catch(() => undefined); }, { once: true });
  t.after(() => app.finish(passed, failure));
  try {
    let page = await app.launch();
    const library = `Installed B2 PDF trial ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByRole('button', { name: 'Installed trial library', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: library, exact: true }).count(), 0, 'B2 library must be fresh');
    await page.getByLabel('新しいライブラリの名前').fill(library);
    await page.getByRole('button', { name: '作成', exact: true }).click();
    await page.getByRole('button', { name: '確認しました', exact: true }).click();
    await page.getByRole('button', { name: library, exact: true }).click();
    const stored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/store-resource' && response.request().method() === 'POST');
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(fixture);
    const resourceReply = await stored; assert.equal(resourceReply.status(), 200);
    const metadata = await resourceReply.json() as { id: string; sha256: string; byteLength: number; pdfPages?: unknown[] };
    assert.equal(metadata.sha256, hash(source)); assert.equal(metadata.byteLength, source.byteLength); assert.ok((metadata.pdfPages?.length ?? 0) >= 2);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
    await page.getByRole('button', { name: '資料一覧', exact: true }).click();
    await page.getByLabel('ページ番号', { exact: true }).fill('2'); await page.getByLabel('ページ番号', { exact: true }).press('Enter');
    await page.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    const stroke = await durable(page, documentId, () => gesture(page, 'PDF書き込みレイヤー', [[.2, .3], [.45, .4]]));
    await page.getByRole('button', { name: '文字', exact: true }).click();
    await gesture(page, 'PDF書き込みレイヤー', [[.25, .65]]);
    await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill('日本語の書き出し');
    const text = await durable(page, documentId, () => page.getByRole('button', { name: '確定', exact: true }).click());
    await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
    await gesture(page, '注釈の配置と選択', [[.5, .5]]);
    const form = page.getByRole('region', { name: '注釈を編集', exact: true });
    await form.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill('付箋の日本語');
    const sticky = await durable(page, documentId, () => form.getByRole('button', { name: '確定', exact: true }).click());
    const expected = [stroke, text, sticky];
    Object.assign(app.evidence, { library, documentId, scope: stroke.request.scope, fixture: { path: fixture, sha256: hash(source), byteLength: source.length }, metadata,
      batches: expected.map(value => value.request.batch.id), receipts: expected.map(value => value.receipt) });
    const pdfFile = path.join(app.resultDirectory, 'b2-annotated.pdf');
    const pdf = await saveDialog(page, app.resultDirectory, 'pdf-save', pdfFile,
      () => page.getByRole('button', { name: 'PDFを書き出す', exact: true }).click(), t.signal);
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    // Independent local PDF inspection; no server or authority is injected into the installed app.
    const inspect = `import json,sys,pymupdf
pymupdf.TOOLS.mupdf_display_errors(False)
pymupdf.TOOLS.mupdf_warnings(reset=True)
out=[]
for name in sys.argv[1:]:
 d=pymupdf.open(name)
 out.append([{'rect':list(p.rect),'crop':list(p.cropbox),'rotation':p.rotation,'unit':d.xref_get_key(p.xref,'UserUnit'),'text':p.get_text(),'drawings':len(p.get_drawings()),'notes':[a.info['content'] for a in p.annots() or []]} for p in d])
print(json.dumps({'pages':out,'warnings':pymupdf.TOOLS.mupdf_warnings(reset=True)},ensure_ascii=True))`;
    const inspection = spawnSync(path.join(repo, '.venv', 'Scripts', 'python.exe'), ['-c', inspect, fixture, pdfFile], { encoding: 'utf8', windowsHide: true });
    assert.equal(inspection.status, 0, inspection.stderr);
    const checked = JSON.parse(inspection.stdout) as { pages: { rect: number[]; crop: number[]; rotation: number; unit: string[]; text: string; drawings: number; notes: string[] }[][]; warnings: string };
    assert.equal(checked.warnings, '', 'independent PDF parser reported an error');
    const [original, exported] = checked.pages; assert.equal(exported.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.deepEqual(exported[i].rect, original[i].rect); assert.deepEqual(exported[i].crop, original[i].crop);
      assert.equal(exported[i].rotation, original[i].rotation); assert.deepEqual(exported[i].unit, original[i].unit);
    }
    assert.ok(exported[1].text.includes('日本語の書き出し'), 'exported Japanese ink text must be extractable');
    assert.ok(exported[1].notes.includes('付箋の日本語'), 'exported sticky note must be present');
    assert.ok(exported[1].drawings > original[1].drawings, 'export must contain the new pen stroke');
    await page.getByLabel('切り抜き先', { exact: true }).selectOption('download');
    await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
    const pngFile = path.join(app.resultDirectory, 'b2-capture.png');
    const png = await saveDialog(page, app.resultDirectory, 'png-save', pngFile,
      () => gesture(page, 'PDF書き込みレイヤー', [[.15, .15], [.7, .75]]), t.signal);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await page.getByRole('button', { name: 'PDFを書き出す', exact: true }).click();
    interaction(app.resultDirectory, 'pdf-cancel', null, 'pending');
    await page.getByRole('status').filter({ hasText: '保存を取り消しました。' }).waitFor({ timeout: 180_000 });
    interaction(app.resultDirectory, 'pdf-cancel', null, 'complete');
    app.evidence.nativeDialogs = { pdf: { path: pdfFile, sha256: hash(pdf), bytes: pdf.length, physicalPageMetadataAndJapaneseVerified: true }, png: { path: pngFile, sha256: hash(png), bytes: png.length }, cancelObserved: true };
    page = await app.coldRestart();
    await page.getByRole('button', { name: 'Installed trial library', exact: true }).waitFor();
    await page.getByRole('button', { name: library, exact: true }).click();
    const reading = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/read'
      && response.request().method() === 'POST' && (response.request().postDataJSON() as { targetId?: string }).targetId === documentId);
    const readingResource = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/read-resource'
      && response.request().method() === 'POST' && (response.request().postDataJSON() as { resourceId?: string }).resourceId === metadata.id);
    await page.getByRole('button', { name: title, exact: true }).click();
    const read = await reading; assert.equal(read.status(), 200);
    const state = await read.json() as RepositoryState;
    assert.deepEqual((read.request().postDataJSON() as { scope: unknown }).scope, stroke.request.scope);
    for (const value of expected) {
      assert.deepEqual(state.checkpoint.batches.find(batch => batch.id === value.request.batch.id), value.request.batch);
      assert.deepEqual(state.receipts.find(receipt => receipt.id === value.receipt.id), value.receipt);
    }
    const resource = await readingResource; assert.equal(resource.status(), 200);
    const loaded = await resource.json() as { metadata: typeof metadata; dataBase64: string };
    assert.deepEqual(loaded.metadata, metadata); assert.equal(hash(Buffer.from(loaded.dataBase64, 'base64')), hash(source));
    await page.getByRole('button', { name: '資料一覧', exact: true }).click();
    await page.getByLabel('ページ番号', { exact: true }).fill('2'); await page.getByLabel('ページ番号', { exact: true }).press('Enter');
    await page.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2 && document.querySelectorAll('[data-sticky-id]').length === 1);
    await page.screenshot({ path: path.join(app.resultDirectory, 'b2-restored.png') });
    app.evidence.coldRestored = { sameScope: true, sameDocumentId: true, exactBatchesAndReceipts: true, sameResourceHash: true, visibleAnnotations: true };
    await app.closeNormally(); passed = true;
  } catch (error) { failure = error; throw error; }
  finally { await app.finish(passed, failure); }
});
