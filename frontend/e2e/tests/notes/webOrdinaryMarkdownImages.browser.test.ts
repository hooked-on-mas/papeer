import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { MarkdownSnapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { assertOrdinaryMarkdownText } from '../../support/ordinaryMarkdown.ts';
function png() {
  function chunk(type: string, data: Buffer) { const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([size, body, checksum]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(3); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.from([0, 20, 100, 220, 20, 100, 220, 20, 100, 220]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}
async function stored(page: Page, id: string) {
  return page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('papeer-shared-edits'); r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing IDB required')); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<{ root: MarkdownSnapshot; edits: StoredEdit[]; intents: number }>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits', 'intents'], 'readonly'), roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
      tx.oncomplete = () => { const root = roots.result.find((row: { value: MarkdownSnapshot }) => row.value.id === id)?.value; if (!root || root.kind !== 'markdown') { reject(new Error('ordinary Markdown root absent')); return; }
        resolve({ root, edits: edits.result.map((row: { value: StoredEdit }) => row.value).filter((edit: StoredEdit) => edit.batch.targetId === id), intents: intents.result.filter((row: { key: string }) => JSON.parse(row.key)[1] === id).length }); }; tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }, id);
}
function snapshot(value: Awaited<ReturnType<typeof stored>>) {
  let current = value.root; const rest = [...value.edits];
  while (rest.length) { const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version); assert.ok(index >= 0); current = applyBatch(current, rest.splice(index, 1)[0].batch) as MarkdownSnapshot; }
  return current;
}
async function saved(page: Page, id: string, content?: string) {
  const until = Date.now() + 30_000;
  for (;;) { const value = await stored(page, id), current = snapshot(value);
    if (!value.intents && value.edits.every(edit => edit.receipt.durable) && (content === undefined || current.content === content)) {
      await page.getByRole('status').filter({ hasText: /^(端末保存済み|送信済み)/ }).first().waitFor(); return { value, current }; }
    assert.ok(Date.now() < until, 'Markdown durable content did not settle'); await delay(50); }
}
type Probe = { enabled: boolean; reads: number; failures: number; created: string[]; revoked: string[] };
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Markdown image recovery lightbox release and single editor ownership (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `P3 images owner ${engine}`; let phase = 'create', documentId = '';
  try {
    await page.getByLabel('新しい資料の名前', { exact: true }).fill(title); await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown'); await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    let editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    documentId = id;
    await page.getByRole('button', { name: '資料一覧', exact: true }).click();
    await editor.fill('画像と編集所有\n'); await editor.blur(); await saved(page, id, '画像と編集所有\n');
    await page.getByLabel('追加する画像', { exact: true }).setInputFiles({ name: 'ordinary-blue.png', mimeType: 'image/png', buffer: png() });
    await page.waitForFunction(() => !document.querySelector('[role=status]')?.textContent?.includes('画像を保存中'));
    const until = Date.now() + 30_000; let uploaded = await saved(page, id);
    while (uploaded.current.imageResources.length !== 1) { assert.ok(Date.now() < until); await delay(50); uploaded = await saved(page, id); }
    const resource = uploaded.current.imageResources[0];
    assert.equal(resource.sha256, createHash('sha256').update(png()).digest('hex'));
    phase = 'read-failure-retry';
    await page.evaluate(resourceId => {
      const probe: Probe = { enabled: true, reads: 0, failures: 0, created: [], revoked: [] }; (globalThis as unknown as { imageProbe: Probe }).imageProbe = probe;
      const get = IDBObjectStore.prototype.get; IDBObjectStore.prototype.get = function(query) {
        if (this.name === 'resources' && typeof query === 'string' && (JSON.parse(query) as string[])[1] === resourceId) { probe.reads++; if (probe.enabled) { probe.failures++; this.transaction.abort(); throw new DOMException('actual Markdown image read abort', 'AbortError'); } }
        return get.call(this, query);
      };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = object => { const url = create(object); probe.created.push(url); return url; };
      URL.revokeObjectURL = url => { probe.revoked.push(url); revoke(url); };
    }, resource.resourceId);
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'ordinary-blue.png（読み込めませんでした）' }).waitFor();
    await page.evaluate(() => { (globalThis as unknown as { imageProbe: Probe }).imageProbe.enabled = false; });
    await page.getByRole('button', { name: '画像を再試行: ordinary-blue.png', exact: true }).click();
    const image = page.getByRole('img', { name: 'ordinary-blue.png', exact: true });
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>('img[alt="ordinary-blue.png"]'); return img?.complete && img.naturalWidth === 3 && img.naturalHeight === 2; });
    const url = await image.getAttribute('src'); assert.ok(url && url.startsWith('blob:'));
    await page.getByRole('button', { name: 'ordinary-blue.pngを拡大', exact: true }).click();
    const lightbox = page.getByRole('dialog', { name: '画像の拡大表示', exact: true }); await lightbox.waitFor(); assert.equal(await lightbox.getByRole('img').getAttribute('src'), url);
    await page.keyboard.press('Escape'); await lightbox.waitFor({ state: 'hidden' });
    await page.getByLabel('画像を読み込む', { exact: true }).uncheck(); await image.waitFor({ state: 'detached' });
    await page.waitForFunction(url => (globalThis as unknown as { imageProbe: Probe }).imageProbe.revoked.includes(url), url);
    await page.getByLabel('画像を読み込む', { exact: true }).check(); await image.waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt="ordinary-blue.png"]')?.naturalWidth === 3);
    assert.notEqual(await image.getAttribute('src'), url); assert.deepEqual((await saved(page, id)).value.edits, uploaded.value.edits, 'render/failure/toggle/lightbox never writes a document edit');
    phase = 'unsafe-urls-and-ownership';
    await page.getByRole('button', { name: '編集', exact: true }).click(); editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
    const urls = uploaded.current.content + '\n[safe](https://example.test/paper)\n[unsafe](javascript:alert(1))\n![blocked](file:///secret.png)\n![relative](media/old.png)\n';
    await editor.fill(urls); await editor.blur(); await saved(page, id, urls);
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    const safe = page.getByRole('link', { name: 'safe', exact: true }); assert.equal(await safe.getAttribute('target'), '_blank'); assert.equal(await safe.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.getByRole('link', { name: 'unsafe', exact: true }).count(), 0);
    assert.equal(await page.locator('img[src^="file:"],img[src^="media/"],a[href^="javascript:"]').count(), 0);
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await delay(600); // Separate a real CodeMirror typing history group, not a product save/admission hook.
    editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.press('Control+End'); await page.keyboard.insertText('owner-history'); await editor.blur();
    const ownerText = urls + 'owner-history'; await saved(page, id, ownerText);
    phase = 'move-editor-right'; await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
    const right = page.getByRole('complementary', { name: '右側の編集', exact: true }); editor = right.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    await assertOrdinaryMarkdownText(editor, ownerText);
    phase = 'right-editor-keyboard-undo'; await editor.press('Control+z'); await assertOrdinaryMarkdownText(editor, urls); await editor.blur(); await saved(page, id, urls);
    phase = 'right-editor-keyboard-redo'; await editor.press('Control+y'); await assertOrdinaryMarkdownText(editor, ownerText); await editor.blur(); const final = await saved(page, id, ownerText);
    await page.getByRole('button', { name: '中央で編集', exact: true }).click(); assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
    const probe = await page.evaluate(() => (globalThis as unknown as { imageProbe: Probe }).imageProbe); assert.ok(probe.failures >= 1 && probe.reads >= 2);
    phase = 'restart'; const reopened = await app.restart(title); assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
    const restored = await saved(reopened, id, ownerText); assert.deepEqual(restored.value, final.value); assert.deepEqual(restored.current.imageResources, [resource]);
    await reopened.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await reopened.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('img[alt="ordinary-blue.png"]'); return image?.complete && image.naturalWidth === 3 && image.naturalHeight === 2; });
    t.diagnostic(JSON.stringify({ engine, id, resourceId: resource.resourceId, failedReads: probe.failures, lightbox: true, releaseOnDisable: true, unsafeAndLegacyRelativeRejected: true, singleEditorAfterMoves: true, textUndoRedoAfterMove: true, coldRestart: true }));
  } catch(error) { console.error(JSON.stringify({ phase, error: String(error), stored: documentId ? await stored(page, documentId).catch(String) : null,
    editor: await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).evaluateAll(elements => elements.map(element => ({ focused: element.contains(document.activeElement),
      lines: [...element.querySelectorAll('.cm-line')].map(line => line.textContent), placement: element.closest('[data-editor-placement]')?.getAttribute('data-editor-placement') }))).catch(String), body: await page.locator('body').innerText().catch(String) })); throw error; }
});
