// B13-b (T05, T04 button path): real-pointer hierarchy drag and drop in the ordinary Web entry. UI-created content only; the catalog is read back from IndexedDB.
// Playwright dragTo drives native HTML5 drag events; a document-level recorder keeps what the browser really dispatched (defaultPrevented = the product accepted the drop).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Locator, Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { catalogOf, catalogUntil, createFolderUi, editsUntil, createItemUi, locateCatalog, expectRenderedChildren, persistedChildren, selectRoot, showCatalog } from '../../support/ordinaryCatalog.ts';
import type { LibrarySnapshot } from '../../../src/runtime/edits/contracts.ts';

type DndRecord = { type: string; target: string | null; prevented: boolean };

async function installRecorder(page: Page) {
  // Capture phase: the product stops propagation of a handled drop, so a bubbling listener would never see it.
  // The event objects are kept and defaultPrevented is read afterwards (= the final decision of the product's handlers).
  await page.evaluate(() => {
    const store: { type: string; target: string | null; event: Event }[] = []; (globalThis as unknown as { __dnd: typeof store }).__dnd = store;
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, event => {
      const row = (event.target as Element | null)?.closest?.('[role="treeitem"]') ?? null;
      store.push({ type, target: row?.getAttribute('aria-label') ?? null, event });
    }, true);
  });
}
const takeRecords = (page: Page): Promise<DndRecord[]> => page.evaluate(() => {
  const g = globalThis as unknown as { __dnd: { type: string; target: string | null; event: Event }[] };
  return g.__dnd.splice(0).map(entry => ({ type: entry.type, target: entry.target, prevented: entry.event.defaultPrevented }));
});

/** Drag the entry's move handle onto a row at a vertical fraction of that row (0.1 before / 0.5 inside / 0.9 after). */
async function dragEntry(handle: Locator, target: Locator, fraction: number) {
  const box = await target.boundingBox(); assert.ok(box && box.height > 0);
  await handle.dragTo(target, { targetPosition: { x: Math.max(8, box.width - 24), y: Math.max(1, Math.min(box.height - 1, box.height * fraction)) } });
}
const placement = (snapshot: LibrarySnapshot) => ({
  items: snapshot.items.map(item => ({ id: item.id, ownerId: item.ownerId, folderId: item.folderId, position: item.position })),
  folders: snapshot.folders.map(folder => ({ id: folder.id, parentId: folder.parentId, position: folder.position })),
});

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary hierarchy pointer drag and drop: three drop zones, cycle refusal, buttons, undo and restart (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'build-hierarchy';
  let observed = page;
  try {
    const P = await createFolderUi(page, 'Drag P');
    const C = await createFolderUi(page, 'Drag C');           // created while "Drag P" is selected: a child of P
    await selectRoot(page);
    const S = await createFolderUi(page, 'Drag S');
    await selectRoot(page);
    const N = await createItemUi(page, 'Drag N', 'markdown');  // root level
    await showCatalog(page);
    const catalog = await locateCatalog(page);
    const baseline = await catalogUntil(page, catalog, value => value.folders.length === 3 && value.items.length === 1);
    assert.deepEqual(persistedChildren(baseline.snapshot, null).map(row => row.id), [P, S, N], 'baseline root order');
    assert.equal(baseline.snapshot.folders.find(folder => folder.id === C)!.parentId, P);
    await installRecorder(page);
    const row = (id: string) => page.locator(`[data-folder-id="${id}"], [data-library-item="${id}"]`).first();
    const grip = (label: string) => page.getByLabel(`「${label}」を移動・並べ替え`, { exact: true });
    let edits = baseline.edits.length;

    const step = async (name: string, source: string, sourceId: string, targetId: string, fraction: number, predicate: (value: LibrarySnapshot) => boolean) => {
      phase = name;
      await dragEntry(grip(source), row(targetId), fraction);
      const after = await catalogUntil(page, catalog, predicate, name);
      assert.equal(after.edits.length, ++edits, `${name}: one dropped move is exactly one catalog batch`);
      const events = await takeRecords(page);
      const over = events.filter(event => event.type === 'dragover'), drop = events.filter(event => event.type === 'drop');
      assert.ok(over.some(event => event.prevented), `${name}: the browser saw an accepted dragover`);
      assert.equal(drop.length, 1, `${name}: the browser dispatched exactly one drop`);
      assert.equal(drop[0].prevented, true, `${name}: the drop was handled by the product`);
      void sourceId;
      return after;
    };

    await step('drop-after-folder', 'Drag N', N, P, 0.9, value => value.items.find(item => item.id === N)!.position > value.folders.find(folder => folder.id === P)!.position
      && persistedChildren(value, null).map(row => row.id).join() === [P, N, S].join());
    let state = await catalogOf(page, catalog);
    assert.equal(state.snapshot.items.find(item => item.id === N)!.folderId, null, 'dropping after a root folder stays at the root');
    await expectRenderedChildren(page, null, [P, N, S], 'rendered root order follows the persisted order after "after"');

    await step('drop-before-folder', 'Drag S', S, P, 0.1, value => persistedChildren(value, null).map(row => row.id).join() === [S, P, N].join());
    await expectRenderedChildren(page, null, [S, P, N], 'rendered root order follows the persisted order after "before"');

    await step('drop-inside-folder-item', 'Drag N', N, S, 0.5, value => value.items.find(item => item.id === N)!.folderId === S);
    state = await catalogOf(page, catalog);
    assert.deepEqual(persistedChildren(state.snapshot, S).map(row => row.id), [N]);
    assert.deepEqual(persistedChildren(state.snapshot, null).map(row => row.id), [S, P]);

    await step('drop-inside-folder-folder', 'Drag C', C, S, 0.5, value => value.folders.find(folder => folder.id === C)!.parentId === S);
    state = await catalogOf(page, catalog);
    assert.deepEqual(persistedChildren(state.snapshot, S).map(row => row.id), [N, C], 'an inside drop appends at the end of the folder');
    assert.deepEqual(persistedChildren(state.snapshot, P).map(row => row.id), []);
    const afterMoves = state;

    phase = 'button-path-cycle-candidates';
    await grip('Drag S').click();
    await page.getByRole('group', { name: '移動・並べ替えの対象', exact: true }).waitFor();
    // A count of 0 only means something when the descendant row is really rendered (a non-descendant "into" button is asserted below).
    assert.equal(await row(C).count(), 1, 'the descendant folder row "Drag C" is rendered while the move mode is open');
    assert.equal(await row(C).isVisible(), true, 'and visible');
    assert.equal(await page.getByLabel('「Drag C」の中へ移動', { exact: true }).count(), 0, 'no "into" button for a descendant');
    assert.equal(await page.getByLabel('「Drag C」の前へ移動', { exact: true }).count(), 0, 'no "before" button for a descendant (it would land inside the source)');
    assert.equal(await page.getByLabel('「Drag C」の後へ移動', { exact: true }).count(), 0, 'no "after" button for a descendant');
    assert.equal(await page.getByLabel('「Drag P」の中へ移動', { exact: true }).count(), 1, 'a non-descendant folder is offered');
    await page.getByRole('button', { name: '移動・並べ替えを取り消す', exact: true }).click();
    assert.deepEqual((await catalogOf(page, catalog)).edits, afterMoves.edits, 'choosing and cancelling a move writes nothing');

    phase = 'pointer-cycle-refusals';
    await takeRecords(page);
    const overCounts: string[] = [];
    const refusals: [string, string, number][] = [['Drag S', C, 0.5], ['Drag S', C, 0.1], ['Drag S', S, 0.5], ['Drag S', N, 0.9]];
    for (const [source, targetId, fraction] of refusals) {
      await dragEntry(grip(source), row(targetId), fraction);
      const events = await takeRecords(page);
      assert.ok(events.some(event => event.type === 'dragstart'), `drag of ${source} really started`);
      // The refusal must be observed on the intended row: at least one dragover whose target row is that row, and every one of them left unprevented.
      const targetLabel = await row(targetId).getAttribute('aria-label'); assert.ok(targetLabel);
      const over = events.filter(event => event.type === 'dragover' && event.target === targetLabel);
      overCounts.push(`${targetLabel}@${fraction}:${over.length}`);
      assert.ok(over.length >= 1, `the browser dispatched at least one dragover on the cyclic target row ${targetLabel} (got targets ${JSON.stringify([...new Set(events.filter(event => event.type === 'dragover').map(event => event.target))])})`);
      assert.ok(over.every(event => !event.prevented), `the product refuses every dragover on the cyclic target ${targetLabel} at ${fraction}`);
      assert.equal(events.filter(event => event.type === 'drop').length, 0, `no drop is delivered for a cyclic target (${targetLabel} at ${fraction})`);
      const unchanged = await catalogOf(page, catalog);
      assert.deepEqual(unchanged.edits, afterMoves.edits, `a refused cyclic drop writes no batch (${targetId} at ${fraction})`);
      assert.deepEqual(placement(unchanged.snapshot), placement(afterMoves.snapshot));
    }

    t.diagnostic(`cyclic refusals: dragover events recorded on the target row (row@fraction:count) ${overCounts.join(' ')}`);

    phase = 'undo-redo';
    let count = (await catalogOf(page, catalog)).edits.length;
    for (let index = 0; index < 4; index++) {
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await editsUntil(page, catalog, ++count, 'undo of a dropped move');   // each undo is one more journaled batch
    }
    const undone = await catalogOf(page, catalog);
    assert.deepEqual(placement(undone.snapshot), placement(baseline.snapshot), 'four undos restore the original placement');
    for (let index = 0; index < 4; index++) {
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await editsUntil(page, catalog, ++count, 'redo of a dropped move');
    }
    const redone = await catalogOf(page, catalog);
    assert.deepEqual(placement(redone.snapshot), placement(afterMoves.snapshot), 'four redos reproduce the dropped placement');

    phase = 'restart';
    const reopened = await app.restartLibrary(); observed = reopened;
    const again = await catalogUntil(reopened, catalog, () => true);
    assert.deepEqual(again, redone, 'the whole catalog (batches, receipts, history) survives a browser restart');
    await showCatalog(reopened);
    const sRow = reopened.locator(`[data-folder-id="${S}"]`);
    await reopened.locator(`[data-folder-id="${S}"][aria-expanded]`).waitFor();   // expandable only once its children are rendered (rev-drag-r1: reading it too early failed)
    if (await sRow.getAttribute('aria-expanded') !== 'true') await reopened.getByLabel('「Drag S」を開く', { exact: true }).click();
    await expectRenderedChildren(reopened, S, [N, C], 'the restored tree shows the dropped placement');
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), closed: observed.isClosed(), body: observed.isClosed() ? '<closed>' : (await observed.locator('body').innerText({ timeout: 3_000 }).catch(error => `<unavailable: ${String(error).slice(0, 120)}>`)).slice(0, 4000) }));
    throw error;
  }
});
