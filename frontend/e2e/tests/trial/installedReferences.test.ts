import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Page, Locator } from 'playwright-core';
import type { EditWriteRequest } from '../../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { BatchReceipt, EditScope, RepositoryState } from '../../../src/runtime/edits/ports.ts';
import { InstalledTrial } from '../../lib/trialRelease.ts';

const repo = path.resolve(import.meta.dirname, '../../../..');
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
function fixture(value: string) {
  const file = fs.realpathSync(value);
  assert.ok(['tests/fixtures', 'checkpoints'].some(root => {
    const relative = path.relative(fs.realpathSync(path.join(repo, root)), file);
    return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }));
  assert.equal(path.extname(file).toLowerCase(), '.pdf');
  const bytes = fs.readFileSync(file); assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  return { file, bytes };
}
async function stroke(layer: Locator) {
  await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box);
  const page = layer.page(); await page.mouse.move(box.x + box.width * .2, box.y + Math.min(120, box.height * .3));
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .5, box.y + Math.min(180, box.height * .45), { steps: 12 }); await page.mouse.up();
}
async function commit(page: Page, id: string, action: () => Promise<unknown>) {
  const waiting = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/commit' && r.request().method() === 'POST');
  await action(); const reply = await waiting; assert.equal(reply.status(), 200);
  const request = reply.request().postDataJSON() as EditWriteRequest & { scope: EditScope };
  const result = await reply.json() as { status: string; receipt: BatchReceipt };
  assert.equal(request.batch.targetId, id); assert.ok(request.history); assert.equal(result.status, 'durable');
  assert.equal(result.receipt.durable, true); assert.equal(result.receipt.id, request.batch.id);
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
  return { request, receipt: result.receipt };
}
async function chooseTranslation(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser'); await page.getByLabel('取り込む訳文PDF', { exact: true }).click();
  await (await chooser).setFiles(file);
}

test('installed trial translated PDF, fixed reference, Markdown image append and cold restart', { timeout: 900_000 }, async t => {
  const manifest = process.env.PAPEER_SHARED_TRIAL_TEST_MANIFEST, results = process.env.PAPEER_SHARED_TRIAL_TEST_RESULTS;
  const originalPath = process.env.PAPEER_SHARED_TRIAL_PDF_FIXTURE, translatedPath = process.env.PAPEER_SHARED_TRIAL_TRANSLATED_PDF_FIXTURE;
  assert.ok(manifest && results && originalPath && translatedPath, 'trial manifest, result directory and two isolated PDF fixtures required');
  const original = fixture(originalPath), translated = fixture(translatedPath), title = path.basename(original.file);
  const app = new InstalledTrial(manifest, results, 'frontend/e2e/tests/trial/installedReferences.test.ts');
  let passed = false, failure: unknown;
  t.signal.addEventListener('abort', () => { void app.finish(false, new Error('trial aborted or timed out')).catch(() => undefined); }, { once: true });
  t.after(() => app.finish(passed, failure));
  try {
    let page = await app.launch(); const library = `Installed reference ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByRole('button', { name: 'Installed trial library', exact: true }).waitFor();
    await page.getByLabel('新しいライブラリの名前').fill(library); await page.getByRole('button', { name: '作成', exact: true }).click();
    await page.getByRole('button', { name: '確認しました', exact: true }).click(); await page.getByRole('button', { name: library, exact: true }).click();
    const noteTitle = `Native capture destination ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteTitle);
    await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
    const noteId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(noteId);
    const notePrefix = await commit(page, noteId, () => page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill('Native preserved prefix 日本語'));
    const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
    if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
    const originalLoaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read-resource' && r.request().method() === 'POST');
    const originalStored = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/store-resource' && r.request().method() === 'POST');
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(original.file);
    const originalReply = await originalStored; assert.equal(originalReply.status(), 200); const originalMeta = await originalReply.json();
    const originalLoadReply = await originalLoaded; assert.equal(originalLoadReply.status(), 200); const originalLoad = await originalLoadReply.json();
    assert.deepEqual(originalLoad.metadata, originalMeta); assert.equal(hash(Buffer.from(originalLoad.dataBase64, 'base64')), hash(original.bytes));
    assert.equal(originalMeta.sha256, hash(original.bytes)); assert.equal(originalMeta.byteLength, original.bytes.length); assert.ok(originalMeta.pdfPages.length >= 2);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    await page.getByRole('button', { name: '資料一覧', exact: true }).click();
    const originalRead = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read' && r.request().method() === 'POST' && r.request().postDataJSON().targetId === id);
    await page.getByRole('button', { name: '同期', exact: true }).click(); const readReply = await originalRead; assert.equal(readReply.status(), 200);
    const originalState = await readReply.json() as RepositoryState;
    await page.getByLabel('取り込む訳文PDF', { exact: true }).waitFor({ state: 'visible' });
    const translatedStored = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/store-resource' && r.request().method() === 'POST');
    await chooseTranslation(page, translated.file); const translatedReply = await translatedStored; assert.equal(translatedReply.status(), 200);
    const translatedMeta = await translatedReply.json(); assert.equal(translatedMeta.sha256, hash(translated.bytes)); assert.equal(translatedMeta.byteLength, translated.bytes.length); assert.equal(translatedMeta.pdfPages.length, 2);
    const first = page.getByLabel('訳文1ページに対応する原文ページ', { exact: true }); await first.waitFor();
    assert.equal(await first.inputValue(), '');
    const options = await first.locator('option').evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value).filter(v => v && v !== 'none'));
    assert.ok(options.length >= 2); await first.selectOption(options[0]);
    await page.getByLabel('訳文2ページに対応する原文ページ', { exact: true }).selectOption(options[1]);
    const mapping = await commit(page, id, () => page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).click());
    assert.equal(mapping.request.batch.kind, 'document');
    if (mapping.request.batch.kind !== 'document') throw new Error('translation document batch required');
    const change = mapping.request.batch.changes.find(c => c.type === 'translation'); assert.ok(change?.type === 'translation' && change.translation);
    assert.deepEqual(change.translation.bindings.map(v => v.original.pageId), options.slice(0, 2));
    const translatedPage = change.translation.pages[0]; assert.equal(translatedPage.background.kind, 'pdf');
    if (translatedPage.background.kind !== 'pdf') throw new Error('translated page must reference PDF');
    assert.equal(translatedPage.background.resourceId, translatedMeta.id); assert.equal(translatedPage.background.sourceRevision, hash(translated.bytes));
    await page.getByRole('button', { name: '左右', exact: true }).click();
    const translatedSurface = page.locator('[data-reader-surface="translated"]');
    await translatedSurface.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
    await translatedSurface.click({ position: { x: 30, y: 35 } }); await translatedSurface.and(page.locator('[data-active-surface="true"]')).waitFor();
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    const ink = await commit(page, id, () => stroke(translatedSurface.getByLabel('PDF書き込みレイヤー', { exact: true })));
    assert.equal(ink.request.batch.kind, 'page'); if (ink.request.batch.kind !== 'page') throw new Error('page batch required');
    assert.equal(ink.request.batch.expected.pageId, translatedPage.id);
    const inkId = await translatedSurface.locator('[data-ink-id]').getAttribute('data-ink-id'); assert.ok(inkId);
    await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
    const reference = page.locator('[data-reader-reference]');
    await reference.locator(`[data-canonical-page="${translatedPage.id}"] .react-pdf__Page__canvas`).waitFor();
    assert.equal(await reference.locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
    await page.locator('[data-reader-surface="original"]').click({ position: { x: 30, y: 35 } });
    await page.getByRole('button', { name: '次のページ', exact: true }).click();
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
    await reference.locator(`[data-canonical-page="${translatedPage.id}"]`).waitFor();
    await page.getByRole('button', { name: '文字', exact: true }).click();
    const layer = page.locator('[data-reader-surface="original"]').getByLabel('PDF書き込みレイヤー', { exact: true });
    await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box); await page.mouse.click(box.x + box.width * .3, box.y + box.height * .4);
    const text = page.getByRole('textbox', { name: '書き込みテキスト', exact: true }); await text.fill('未確定');
    await page.getByRole('button', { name: '固定を解除', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /入力や保存/ }).waitFor(); await text.waitFor(); assert.equal(await text.inputValue(), '未確定');
    await reference.locator(`[data-canonical-page="${translatedPage.id}"]`).waitFor();
    await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
    // The actual PDF capture enters a UI-created Markdown destination through its own writer.
    await page.getByLabel('切り抜き先', { exact: true }).selectOption('note');
    await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
    await stroke(layer);
    const appendDialog = page.getByRole('dialog', { name: '引用をノートへ追加', exact: true });
    await appendDialog.getByLabel('追加先のノート', { exact: true }).selectOption(noteId);
    const imageStored = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/store-resource' && r.request().method() === 'POST');
    const appended = await commit(page, noteId, () => appendDialog.getByRole('button', { name: 'ノートへ追加', exact: true }).click());
    await appendDialog.getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
    assert.equal(appended.request.batch.kind, 'markdown');
    if (appended.request.batch.kind !== 'markdown') throw new Error('destination Markdown append required');
    assert.ok(appended.request.batch.appendId); assert.equal(appended.request.batch.imageResources.length, 1);
    assert.match(appended.request.batch.content, /^Native preserved prefix 日本語/);
    assert.ok(appended.request.batch.content.includes(id));
    const imageStoredReply = await imageStored; assert.equal(imageStoredReply.status(), 200);
    const imageMetadata = await imageStoredReply.json();
    assert.equal(imageMetadata.mediaType, 'image/png'); assert.ok(imageMetadata.byteLength > 100);
    assert.deepEqual(appended.request.batch.imageResources, [{ resourceId: imageMetadata.id, sha256: imageMetadata.sha256 }]);
    assert.deepEqual(appended.request.scope, mapping.request.scope);
    await appendDialog.getByRole('button', { name: '閉じる', exact: true }).click();
    Object.assign(app.evidence, { library, documentId: id, scope: mapping.request.scope,
      fixtures: { original: { sha256: hash(original.bytes), bytes: original.bytes.length }, translated: { sha256: hash(translated.bytes), bytes: translated.bytes.length } },
      originalMeta, translatedMeta, originalHeads: originalState.heads, translatedPageId: translatedPage.id,
      batches: [mapping, ink].map(v => v.request.batch.id), receipts: [mapping, ink].map(v => v.receipt), inkId,
      noteAppend: { noteId, noteTitle, prefixBatch: notePrefix.request.batch, prefixReceipt: notePrefix.receipt,
        batch: appended.request.batch, receipt: appended.receipt, imageMetadata, faultInjection: false } });
    page = await app.coldRestart(); await page.getByRole('button', { name: library, exact: true }).click();
    const originalReload = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read-resource' && r.request().method() === 'POST' && r.request().postDataJSON().resourceId === originalMeta.id);
    const translatedReload = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read-resource' && r.request().method() === 'POST' && r.request().postDataJSON().resourceId === translatedMeta.id);
    const reload = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read' && r.request().method() === 'POST' && r.request().postDataJSON().targetId === id);
    await page.getByRole('button', { name: title, exact: true }).click(); const restoredReply = await reload; assert.equal(restoredReply.status(), 200);
    const restored = await restoredReply.json() as RepositoryState; assert.deepEqual(restoredReply.request().postDataJSON().scope, mapping.request.scope);
    for (const entry of [mapping, ink]) { assert.deepEqual(restored.checkpoint.batches.find(b => b.id === entry.request.batch.id), entry.request.batch); assert.deepEqual(restored.receipts.find(r => r.id === entry.receipt.id), entry.receipt); }
    assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
    await page.getByRole('button', { name: '資料一覧', exact: true }).click();
    await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).waitFor();
    await page.getByLabel('ページ番号', { exact: true }).fill('1'); await page.getByLabel('ページ番号', { exact: true }).press('Enter');
    await page.getByRole('button', { name: '左右', exact: true }).click();
    const restoredTranslated = page.locator('[data-reader-surface="translated"]');
    await restoredTranslated.locator(`[data-ink-id="${inkId}"]`).waitFor();
    for (const [response, metadata, bytes] of [[await originalReload, originalMeta, original.bytes], [await translatedReload, translatedMeta, translated.bytes]] as const) {
      assert.equal(response.status(), 200); const resource = await response.json(); assert.deepEqual(resource.metadata, metadata); assert.equal(hash(Buffer.from(resource.dataBase64, 'base64')), hash(bytes));
    }
    await page.screenshot({ path: path.join(app.resultDirectory, 'reference-restored.png') });
    app.evidence.coldRestored = { sameDocumentAndScope: true, exactBatchesAndReceipts: true, translatedInkVisible: true, referenceEphemeral: true };
    // Read the destination and its PNG through ordinary navigation/preview after a full process restart.
    const noteRead = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read' && r.request().method() === 'POST' && r.request().postDataJSON().targetId === noteId);
    const restoredCatalog = page.getByRole('button', { name: '資料一覧', exact: true });
    if (await restoredCatalog.getAttribute('aria-expanded') !== 'true') await restoredCatalog.click();
    await page.getByRole('button', { name: noteTitle, exact: true }).click();
    const noteReply = await noteRead; assert.equal(noteReply.status(), 200);
    const noteState = await noteReply.json() as RepositoryState;
    assert.deepEqual(noteReply.request().postDataJSON().scope, mapping.request.scope);
    assert.equal(noteState.checkpoint.root.id, noteId); assert.equal(noteState.checkpoint.root.kind, 'markdown');
    for (const entry of [notePrefix, appended]) {
      assert.deepEqual(noteState.checkpoint.batches.find(batch => batch.id === entry.request.batch.id), entry.request.batch);
      assert.deepEqual(noteState.receipts.find(receipt => receipt.id === entry.receipt.id), entry.receipt);
    }
    assert.equal(noteState.checkpoint.batches.filter(batch => batch.kind === 'markdown' && batch.appendId).length, 1);
    assert.equal(noteState.heads.length, 1);
    const noteSnapshot = new EditGraph(noteState.checkpoint).snapshot(noteState.heads[0]); assert.ok(noteSnapshot?.kind === 'markdown');
    assert.equal(noteSnapshot.content, appended.request.batch.content);
    assert.deepEqual(noteSnapshot.appendIds, [appended.request.batch.appendId]);
    await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
    assert.match(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).innerText(), /Native preserved prefix 日本語/);
    const imageRead = page.waitForResponse(r => new URL(r.url()).pathname === '/api/edits/read-resource' && r.request().method() === 'POST' && r.request().postDataJSON().resourceId === imageMetadata.id);
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    const imageReply = await imageRead; assert.equal(imageReply.status(), 200);
    const imageResource = await imageReply.json(); assert.deepEqual(imageResource.metadata, imageMetadata);
    const imageBytes = Buffer.from(imageResource.dataBase64, 'base64');
    assert.equal(hash(imageBytes), imageMetadata.sha256); assert.equal(imageBytes.length, imageMetadata.byteLength);
    assert.equal(imageBytes.subarray(1, 4).toString('ascii'), 'PNG');
    fs.writeFileSync(path.join(app.resultDirectory, 'capture-appended.png'), imageBytes, { flag: 'wx' });
    const previewImage = page.locator('.summary-prose img');
    await previewImage.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.summary-prose img')].some(image => image.complete && image.naturalWidth > 0));
    assert.equal(await previewImage.evaluate(image => (image as HTMLImageElement).naturalWidth > 0), true);
    await page.screenshot({ path: path.join(app.resultDirectory, 'append-restored.png') });
    app.evidence.noteAppendRestored = { sameDestinationAndScope: true, exactBatchAndReceipt: true, oneAppend: true,
      exactContent: true, imageReadSha256: hash(imageBytes), imageBytes: imageBytes.length, imageArtifact: 'capture-appended.png', imageVisible: true };
    await app.closeNormally(); passed = true;
  } catch (error) { failure = error; throw error; } finally { await app.finish(passed, failure); }
});
