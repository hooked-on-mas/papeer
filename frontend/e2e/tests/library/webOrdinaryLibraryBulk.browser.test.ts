import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import { committed } from '../reader/p2/ordinaryStorage.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { LibrarySnapshot, Snapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';

async function catalog(page: Page, namespace: string, libraryId: string) {
  const data = await page.evaluate(async ({ namespace, libraryId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onblocked = () => reject(new Error('catalog observation blocked'));
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try { return await new Promise<{ root: Snapshot; edits: StoredEdit[]; intents: number }>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits', 'intents'], 'readonly');
      const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
      tx.onabort = () => reject(tx.error ?? new Error('catalog read aborted'));
      tx.oncomplete = () => {
        const root = roots.result.find((row: { scope: string; value: Snapshot }) => row.scope === namespace && row.value.id === libraryId);
        if (!root) { reject(new Error('catalog root missing')); return; }
        resolve({ root: root.value, edits: edits.result.filter((row: { scope: string; value: StoredEdit }) => row.scope === namespace && row.value.batch.targetId === libraryId).map((row: { value: StoredEdit }) => row.value),
          intents: intents.result.filter((row: { scope: string; key: string }) => row.scope === namespace && JSON.parse(row.key)[1] === libraryId).length });
      };
    }); } finally { db.close(); }
  }, { namespace, libraryId });
  const graph = new EditGraph({ version: 1, libraryId, root: data.root, batches: data.edits.map(value => value.batch) });
  const heads = graph.getView().heads; assert.equal(heads.length, 1);
  const snapshot = graph.snapshot(heads[0]); assert.equal(snapshot?.kind, 'library');
  return { ...data, snapshot: snapshot as LibrarySnapshot };
}
async function catalogUntil(page: Page, namespace: string, libraryId: string, predicate: (value: LibrarySnapshot) => boolean) {
  const deadline = Date.now() + 30_000;
  for (;;) { const value = await catalog(page, namespace, libraryId);
    if (!value.intents && value.edits.every(edit => edit.receipt.durable && edit.history) && predicate(value.snapshot)) return value;
    assert.ok(Date.now() < deadline, 'catalog transaction did not settle'); await delay(50);
  }
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary multi-item metadata and related links share one catalog history (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page, phase = 'create-note';
  const noteTitle = `Bulk note ${engine}`, titles = [`Bulk one ${engine}.pdf`, `Bulk two ${engine}.pdf`];
  const openCatalog = async () => { const button = page.getByRole('button', { name: '資料一覧', exact: true });
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click(); };
  try {
    await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteTitle);
    await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor();
    const noteId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(noteId);
    const content = 'The related note body remains unchanged.';
    await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(content);
    const noteBefore = await ordinaryMarkdownSaved(page, noteId, content, 1);
    const namespace = noteBefore.namespace, libraryId = JSON.parse(namespace)[1] as string;
    const pdfBytes = await readFile(path.resolve(import.meta.dirname, '../../../../tests/fixtures/sample.pdf'));
    const pdfs = [] as Awaited<ReturnType<typeof committed>>[];
    for (const title of titles) {
      phase = `import-${title}`; await openCatalog();
      await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles({ name: title, mimeType: 'application/pdf', buffer: pdfBytes });
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
      pdfs.push(await committed(page, id));
    }
    const ids = pdfs.map(pdf => pdf.root.id); await openCatalog();
    let previous = await catalogUntil(page, namespace, libraryId, value => ids.every(id => value.items.some(item => item.id === id)));
    const oneOperation = async (predicate: (value: LibrarySnapshot) => boolean) => {
      const next = await catalogUntil(page, namespace, libraryId, predicate);
      const added = next.edits.filter(edit => !previous.edits.some(old => old.batch.id === edit.batch.id));
      assert.equal(added.length, 1, 'each user command has exactly one durable catalog batch');
      assert.equal(added[0].batch.targetId, libraryId); assert.equal(added[0].receipt.durable, true); assert.ok(added[0].history);
      previous = next; return added[0];
    };
    phase = 'bulk-tags-and-read';
    for (const title of titles) await page.getByLabel(`「${title}」を選択`, { exact: true }).check();
    await page.getByText('2件を選択', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'タグを追加', exact: true }).click();
    const tags = page.getByRole('form', { name: 'タグ編集', exact: true });
    await tags.getByLabel('タグ（1行に1つ）', { exact: true }).fill('shared\nreview');
    await tags.getByRole('button', { name: 'タグを適用', exact: true }).click(); await tags.waitFor({ state: 'hidden' });
    const tagBatch = await oneOperation(value => ids.every(id => value.items.find(item => item.id === id)?.tags.join(',') === 'shared,review'));
    assert.equal(tagBatch.batch.kind, 'library');
    if (tagBatch.batch.kind !== 'library') throw new Error('catalog batch kind');
    assert.deepEqual(tagBatch.batch.changes.filter(change => change.type === 'put-item').map(change => change.item.id).sort(), [...ids].sort());
    await page.getByRole('button', { name: '既読にする', exact: true }).click();
    await oneOperation(value => ids.every(id => value.items.find(item => item.id === id)?.read === true));
    phase = 'bibliography-five-fields';
    await page.getByRole('button', { name: `「${titles[0]}」の書誌情報を編集`, exact: true }).click();
    const bibliography = page.getByRole('form', { name: '書誌情報の編集', exact: true });
    const fields = { author: '山田太郎', year: '2025', venue: 'Journal of Testing', doi: '10.1000/bulk', arxiv_id: '2501.00001' };
    for (const [label, value] of [['筆頭著者', fields.author], ['出版年', fields.year], ['掲載誌', fields.venue], ['DOI', fields.doi], ['arXiv ID', fields.arxiv_id]])
      await bibliography.getByLabel(label, { exact: true }).fill(value);
    await bibliography.getByRole('button', { name: '書誌情報を保存', exact: true }).click(); await bibliography.waitFor({ state: 'hidden' });
    await oneOperation(value => Object.entries(fields).every(([key, val]) => value.items.find(item => item.id === ids[0])?.metadata[key] === val));
    assert.deepEqual(previous.snapshot.items.find(item => item.id === ids[1])?.metadata, {});
    phase = 'bulk-related-add';
    await page.getByRole('button', { name: '関連を追加', exact: true }).click();
    await page.getByLabel('関連付ける資料', { exact: true }).selectOption(noteId);
    await page.getByRole('button', { name: '関連を保存', exact: true }).click();
    await page.getByRole('button', { name: '関連を保存', exact: true }).waitFor({ state: 'hidden' });
    const linked = (value: LibrarySnapshot) => ids.every(id => value.links.some(link => link.pdfId === id && link.noteId === noteId));
    await oneOperation(linked); assert.equal(previous.snapshot.links.length, 2);
    phase = 'unlink-and-history';
    const catalogContent = (value: LibrarySnapshot) => ({ ...value, version: null,
      links: [...value.links].sort((a, b) => `${a.pdfId}:${a.noteId}`.localeCompare(`${b.pdfId}:${b.noteId}`)) });
    const linkedSnapshot = catalogContent(previous.snapshot);
    await page.getByRole('button', { name: `「${titles[0]}」と「${noteTitle}」の関連を解除`, exact: true }).click();
    const unlinkBatch = await oneOperation(value => value.links.length === 1 && value.links[0].pdfId === ids[1]);
    const unlinkedSnapshot = catalogContent(previous.snapshot);
    await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
    const undone = await oneOperation(linked); assert.deepEqual(catalogContent(previous.snapshot), linkedSnapshot);
    assert.equal(undone.history?.action?.operationId, unlinkBatch.batch.id);
    await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
    const redone = await oneOperation(value => value.links.length === 1 && value.links[0].pdfId === ids[1]);
    assert.equal(redone.history?.action?.operationId, unlinkBatch.batch.id);
    assert.deepEqual(catalogContent(previous.snapshot), unlinkedSnapshot);
    assert.deepEqual(previous.snapshot.items.find(item => item.id === noteId)?.tags, []);
    assert.equal(previous.snapshot.items.find(item => item.id === noteId)?.read, false);
    const finalCatalog = previous;
    assert.deepEqual(await ordinaryMarkdownSaved(page, noteId, content, 1), noteBefore);
    for (const [index, id] of ids.entries()) assert.deepEqual(await committed(page, id), pdfs[index]);
    phase = 'cold-restart-library'; page = await app.restartLibrary();
    phase = 'cold-restart-note'; await page.getByRole('button', { name: noteTitle, exact: true }).click();
    await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor(); await openCatalog();
    const restored = await catalogUntil(page, namespace, libraryId, value => value.links.length === 1);
    assert.deepEqual(restored, finalCatalog);
    assert.deepEqual(await ordinaryMarkdownSaved(page, noteId, content, 1), noteBefore);
    for (const [index, id] of ids.entries()) assert.deepEqual(await committed(page, id), pdfs[index]);
    t.diagnostic(JSON.stringify({ engine, ids, noteId, bulkTargets: 2, bibliographyFields: 5, relatedAddTargets: 2,
      exactCatalogAndBodyAndReceiptRestart: true, ordinaryUiOnly: true }));
  } catch (error) {
    const body = page.isClosed() ? '<previous page closed during restart>' : await page.locator('body').innerText().catch(() => '<body unavailable>');
    t.diagnostic(JSON.stringify({ engine, phase, body: body.slice(-9000), originalError: String(error) })); throw error;
  }
});

