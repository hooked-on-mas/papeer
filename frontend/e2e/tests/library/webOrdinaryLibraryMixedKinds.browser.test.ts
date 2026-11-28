// B13-b (T01, T06 reveal/focus part): one folder holding every item kind created through the ordinary UI (Markdown, hand-written note, imported PDF,
// owned attachment, owned child note). Order, nesting and per-kind controls are checked against the persisted catalog, the reveal after creation against the DOM.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { activeElementState, catalogOf, catalogUntil, createFolderUi, createItemUi, editsUntil, expectRenderedChildren, locateCatalog, persistedChildren, showCatalog, waitCatalogClosed }
  from '../../support/ordinaryCatalog.ts';

const pdfFixture = path.resolve(import.meta.dirname, '../../../../tests/fixtures/shared-coordinate-pages.pdf');

async function focusedRow(page: Page, expected: { folderId?: string; itemId?: string }, what: string) {
  await page.waitForFunction(({ folderId, itemId }) => {
    const active = document.activeElement;
    return active?.getAttribute('role') === 'treeitem' && (folderId ? active.getAttribute('data-folder-id') === folderId : active.getAttribute('data-library-item') === itemId);
  }, expected, { timeout: 15_000 }).catch(async () => { assert.fail(`${what}: ${JSON.stringify(await activeElementState(page))}`); });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary mixed-kind folder: order, nesting, per-kind controls, reveal, keyboard reorder and restart (${engine})`, { timeout: 360_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'create-folder', observed = page;
  try {
    const mix = await createFolderUi(page, 'Mix');
    phase = 'created-folder-is-focused';
    await focusedRow(page, { folderId: mix }, 'a newly created folder holds keyboard focus');
    const catalog = await locateCatalog(page);

    phase = 'create-markdown-notebook-pdf-in-folder';
    const markdown = await createItemUi(page, 'Mix M1', 'markdown');
    await showCatalog(page);
    // Reveal: the folder was opened for the creation and the new row is visible without any manual expansion.
    assert.equal(await page.locator(`[data-folder-id="${mix}"]`).getAttribute('aria-expanded'), 'true', 'the creation target folder is expanded');
    assert.equal(await page.locator(`[data-library-item="${markdown}"]`).isVisible(), true, 'the created Markdown row is visible in its folder');
    assert.equal(await page.locator(`[data-library-item="${markdown}"] button[aria-current="page"]`).count(), 1, 'the created and opened item is marked as the current page');
    const notebook = await createItemUi(page, 'Mix N1', 'notebook');
    await showCatalog(page);
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(pdfFixture);
    const withPdf = await catalogUntil(page, catalog, value => value.items.some(item => item.kind === 'pdf'), 'PDF import');
    const pdf = withPdf.snapshot.items.find(item => item.kind === 'pdf')!;
    assert.equal(pdf.folderId, mix, 'the PDF was imported into the selected folder');
    await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id, pdf.id);
    await waitCatalogClosed(page);

    phase = 'attachment-and-owned-child';
    await showCatalog(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('「Mix M1」にファイルを添付', { exact: true }).click();
    await (await chooser).setFiles({ name: 'mix-evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('mixed kind attachment') });
    const withAttachment = await catalogUntil(page, catalog, value => value.items.some(item => item.kind === 'attachment'), 'attachment import');
    const attachment = withAttachment.snapshot.items.find(item => item.kind === 'attachment')!;
    assert.equal(attachment.ownerId, markdown);
    await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id, attachment.id);
    await waitCatalogClosed(page);
    await showCatalog(page);
    await page.getByLabel('「Mix M1」に付属ノートを作成', { exact: true }).click();
    const child = await createItemUi(page, 'Mix M1 child', 'markdown');
    await showCatalog(page);
    const built = await catalogUntil(page, catalog, value => value.items.some(item => item.id === child), 'owned child note');
    assert.deepEqual(new Set(built.snapshot.items.map(item => item.kind)), new Set(['markdown', 'notebook', 'pdf', 'attachment']), 'the catalog holds all four kinds');

    phase = 'persisted-order-matches-rendered-order';
    const siblings = persistedChildren(built.snapshot, mix);
    assert.deepEqual(siblings.map(row => row.kind), ['markdown', 'notebook', 'pdf'], 'items are appended in creation order, mixed kinds in one sibling list');
    assert.deepEqual(siblings.map(row => row.id), [markdown, notebook, pdf.id]);
    assert.equal(new Set(siblings.map(row => row.position)).size, 3, 'positions are distinct');
    await expectRenderedChildren(page, mix, siblings.map(row => row.id), 'rendered folder children follow the persisted positions');
    const owned = built.snapshot.items.filter(item => item.ownerId === markdown).sort((a, b) => a.position - b.position);
    assert.deepEqual(owned.map(item => item.kind), ['attachment', 'markdown'], 'owned items keep their own order under the owner');
    await expectRenderedChildren(page, markdown, owned.map(item => item.id), 'owned attachment and child note are nested directly under their owner');
    const levels = new Map((await page.locator('[role="tree"] [role="treeitem"]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-library-item') ?? node.getAttribute('data-folder-id'), Number(node.getAttribute('aria-level'))]))) as [string, number][]);
    assert.deepEqual([levels.get(mix), levels.get(markdown), levels.get(attachment.id)], [1, 2, 3], 'folder > item > owned item nesting depth');

    phase = 'per-kind-controls';
    const has = async (id: string, label: string) => await page.locator(`[data-library-item="${id}"]`).getByLabel(label, { exact: true }).count();
    const title = (id: string) => built.snapshot.items.find(item => item.id === id)!.title;
    assert.equal(await has(pdf.id, `「${title(pdf.id)}」の書誌情報を編集`), 1, 'a PDF has the bibliography control');
    for (const id of [markdown, notebook]) {
      assert.equal(await has(id, `「${title(id)}」の書誌情報を編集`), 0, 'a note has no bibliography control');
      assert.equal(await has(id, `「${title(id)}」に付属ノートを作成`), 1); assert.equal(await has(id, `「${title(id)}」にファイルを添付`), 1);
    }
    for (const label of ['の書誌情報を編集', 'に付属ノートを作成', 'にファイルを添付', 'に関連を追加', 'を独立させる'])
      assert.equal(await has(attachment.id, `「${title(attachment.id)}」${label}`), 0, `an owned attachment has no ${label} control`);
    assert.equal(await has(attachment.id, `「${title(attachment.id)}」を改名`), 1); assert.equal(await has(attachment.id, `「${title(attachment.id)}」を削除`), 1);
    assert.equal(await has(child, `「${title(child)}」を独立させる`), 1, 'an owned note can be made independent');
    for (const label of ['に付属ノートを作成', 'にファイルを添付', 'に関連を追加']) assert.equal(await has(child, `「${title(child)}」${label}`), 0, `an owned note has no ${label} control`);

    phase = 'keyboard-reorder-mixed-kinds';
    const before = await catalogOf(page, catalog);
    await page.getByLabel(`「${title(pdf.id)}」を移動・並べ替え`, { exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByLabel('「Mix M1」の前へ移動', { exact: true }).focus(); await page.keyboard.press('Enter');
    const moved = await editsUntil(page, catalog, before.edits.length + 1, 'reorder batch');
    assert.deepEqual(persistedChildren(moved.snapshot, mix).map(row => row.id), [pdf.id, markdown, notebook], 'a PDF moves before a Markdown note among mixed siblings');
    assert.deepEqual(moved.snapshot.items.filter(item => item.ownerId === markdown), before.snapshot.items.filter(item => item.ownerId === markdown), 'owned items are untouched by moving their owner\'s sibling');
    await expectRenderedChildren(page, mix, [pdf.id, markdown, notebook], 'rendered order follows the reorder');
    await focusedRow(page, { itemId: pdf.id }, 'after a keyboard reorder the moved row keeps keyboard focus');

    phase = 'restart';
    const reopened = await app.restartLibrary(); observed = reopened;
    const final = await catalogUntil(reopened, catalog, () => true);
    assert.deepEqual(final, moved, 'the catalog (batches, receipts, history) survives a browser restart');
    await showCatalog(reopened);
    await expectRenderedChildren(reopened, mix, [pdf.id, markdown, notebook], 'the restored tree shows the reordered mixed siblings');
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), closed: observed.isClosed(), body: observed.isClosed() ? '<closed>' : (await observed.locator('body').innerText({ timeout: 3_000 }).catch(error => `<unavailable: ${String(error).slice(0, 120)}>`)).slice(0, 4000) }));
    throw error;
  }
});
