// B13-b (T06): where keyboard focus really is (document.activeElement) when the focused tree row collapses away, is removed by Undo, or is deleted.
// plan F26 "削除後focus". Observation of the rendered tree only; the catalog is read back to know what was really committed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { activeElementState, catalogOf, catalogUntil, createFolderUi, createItemUi, editsUntil, expectRenderedChildren, locateCatalog, renderedRows, selectRoot, showCatalog }
  from '../../support/ordinaryCatalog.ts';

/** Polls document.activeElement until it belongs to the expected tree row (bounded), else fails with what really held focus. */
async function expectFocusInRow(page: Page, expected: { folderId?: string; itemId?: string }, what: string) {
  const matches = () => page.evaluate(({ folderId, itemId }) => {
    const row = document.activeElement?.closest('[role="treeitem"]');
    return !!row && (folderId ? row.getAttribute('data-folder-id') === folderId : row.getAttribute('data-library-item') === itemId);
  }, expected);
  const deadline = Date.now() + 10_000;
  while (!await matches() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(await matches(), `${what}: focus is ${JSON.stringify(await activeElementState(page))}`);
}
const rovingRow = async (page: Page) => (await renderedRows(page)).filter(row => row.tabIndex === 0).map(row => row.folderId ?? row.id);

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary tree focus follows logical rows through collapse, undo removal and deletion (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'build', observed = page;
  const seen: Record<string, unknown> = {};
  try {
    const Z = await createFolderUi(page, 'Fo Z');
    await selectRoot(page);
    const R = await createItemUi(page, 'Fo R', 'markdown');
    await showCatalog(page); await selectRoot(page);
    const P = await createFolderUi(page, 'Fo P');
    const C = await createFolderUi(page, 'Fo C');
    const F = await createFolderUi(page, 'Fo F');
    const catalog = await locateCatalog(page);
    const built = await catalogUntil(page, catalog, value => value.folders.length === 4 && value.items.length === 1);
    await expectRenderedChildren(page, null, [Z, R, P], 'root order');
    await expectRenderedChildren(page, C, [F], 'F is visible under C');
    const row = (id: string) => page.locator(`[data-folder-id="${id}"], [data-library-item="${id}"]`).first();

    phase = 'collapse-ancestor-without-focus-transfer';
    await row(F).focus();
    await expectFocusInRow(page, { folderId: F }, 'precondition: F row is focused');
    await page.getByLabel('「Fo P」を閉じる', { exact: true }).dispatchEvent('click');   // a click that does not move focus (as a pointer click on a button does in Safari)
    await expectRenderedChildren(page, null, [Z, R, P], 'root rows after collapse');
    assert.equal(await row(F).count(), 0, 'F is no longer rendered after its ancestor collapsed');
    seen.collapseNoTransfer = await activeElementState(page);
    await expectFocusInRow(page, { folderId: P }, 'collapsing the ancestor of the focused row moves focus to the nearest surviving ancestor');
    assert.deepEqual(await rovingRow(page), [P], 'the single tab stop is the ancestor row');

    phase = 'collapse-with-real-click';
    await page.getByLabel('「Fo P」を開く', { exact: true }).click();
    await expectRenderedChildren(page, C, [F], 'F is visible again');
    await row(F).focus();
    await page.getByLabel('「Fo P」を閉じる', { exact: true }).click();
    await expectRenderedChildren(page, null, [Z, R, P], 'root rows after the second collapse');
    seen.collapseRealClick = await activeElementState(page);
    await expectFocusInRow(page, { folderId: P }, 'after a real click on the ancestor toggle, focus is on the ancestor row');

    phase = 'undo-removes-the-focused-row';
    await page.getByLabel('「Fo P」を開く', { exact: true }).click();
    await expectRenderedChildren(page, C, [F], 'F is visible once more');
    await row(F).focus();
    const beforeUndo = await catalogOf(page, catalog);
    await page.keyboard.press('Control+z');
    await editsUntil(page, catalog, beforeUndo.edits.length + 1, 'keyboard undo');
    await expectRenderedChildren(page, C, [], 'the undone folder F is no longer a child of C');
    assert.equal(await row(F).count(), 0);
    seen.undoRemoval = await activeElementState(page);
    await expectFocusInRow(page, { folderId: C }, 'undo removed the focused folder: focus moves to its parent row');

    phase = 'delete-through-the-form';
    await row(R).focus();
    await expectFocusInRow(page, { itemId: R }, 'precondition: R row is focused');
    await page.getByLabel('「Fo R」を削除', { exact: true }).click();
    await page.getByRole('button', { name: '削除を確定', exact: true }).click();
    await catalogUntil(page, catalog, value => value.deletions.some(deletion => deletion.active && deletion.itemIds.includes(R)), 'deletion of R');
    await expectRenderedChildren(page, null, [Z, P], 'R is gone from the rendered root');
    seen.deleteViaForm = await activeElementState(page);
    seen.deleteViaFormTabStop = await rovingRow(page);
    t.diagnostic(JSON.stringify({ engine, seen, built: built.edits.length }));
    assert.deepEqual(await rovingRow(page), [P], 'after deleting R the single tab stop is the nearest surviving row (P)');
    await expectFocusInRow(page, { folderId: P }, 'after deleting the focused item, keyboard focus is on the nearest surviving row, not lost to the page');
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), seen, closed: observed.isClosed(), body: observed.isClosed() ? '<closed>' : (await observed.locator('body').innerText({ timeout: 3_000 }).catch(e => `<unavailable: ${String(e).slice(0, 120)}>`)).slice(0, 3000) }));
    throw error;
  }
});
