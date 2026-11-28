import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { InkObject } from '../../../../src/runtime/edits/contracts.ts';
import { H, W, button, byId, drawRect, durableCount, expectSelection, headBatch, inkOf, lastChanges, near, rectOf, snapshotOf, sortedPairs } from './ordinaryInk.ts';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** B14-3b (F11): the ordinary toolbar's copy / cut / duplicate / paste on notebooks, same page, another page and another document. Mouse only.
 *  Values are read from the real DOM and the real IndexedDB edit log. Not covered: PDF pages, the translated pane, touch, keyboard shortcuts. */
const FRACTION = .008; // tolerance for a selection frame, as a fraction of the page layer
const OFFSET = .025 * W; // a paste is shifted by 2.5% of the page width in both directions: 14.882 pt
const commands = ['コピー', '切り取り', '複製', '削除'];
const enabled = async (page: Page, names: string[]) => Promise.all(names.map(async name => !(await button(page, name).isDisabled())));

/** Wait for `count` stored edits showing exactly the strokes now in the DOM (their number is `domCount`). */
async function settle(page: Page, documentId: string, count: number, domCount: number) {
  await page.waitForFunction(expected => document.querySelectorAll('[data-ink-id]').length === expected, domCount);
  return durable(page, documentId, (await inks(page)).map(value => value.id), count);
}
/** `copy` moved by the paste offset: the stored geometry and style are the same, the transform is shifted by (OFFSET, OFFSET). */
function expectShifted(original: InkObject, pasted: InkObject, what: string, dx = OFFSET, dy = OFFSET) {
  assert.deepEqual(pasted.geometry, original.geometry, `${what}: geometry`); assert.deepEqual(pasted.style, original.style, `${what}: style`);
  near(pasted.transform.x, original.transform.x + dx, 1e-9, `${what} x`); near(pasted.transform.y, original.transform.y + dy, 1e-9, `${what} y`);
  assert.deepEqual([pasted.transform.rotationRad, pasted.transform.scaleX, pasted.transform.scaleY], [original.transform.rotationRad, original.transform.scaleX, original.transform.scaleY], `${what}: rotation and scale`);
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary P2 clipboard on one page: copy, paste, duplicate, cut and paste at the edge write exact edits, keep the clipboard apart, undo and the clipboard is gone after restart (${engine})`, { timeout: 300_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 clipboard ${engine}`;
    const documentId = await createNotebook(page, title);
    // A x .1-.3 y .10-.15, B x .5-.7 y .10-.15, C x .1-.4 y .50-.58 (a different size from A), E x .75-.99 y .85-.97 (at the right edge).
    const a = await drawRect(page, documentId, [], 1, [.1, .10], [.3, .15]);
    const b = await drawRect(page, documentId, [a], 2, [.5, .10], [.7, .15]);
    const c = await drawRect(page, documentId, [a, b], 3, [.1, .50], [.4, .58]);
    const e = await drawRect(page, documentId, [a, b, c], 4, [.75, .85], [.99, .97]);
    const base = await durable(page, documentId, [a, b, c, e], 4), first = inkOf(snapshotOf(base));
    assert.equal(snapshotOf(base).pages[0].widthPt, W); assert.equal(snapshotOf(base).pages[0].heightPt, H);
    assert.ok(byId(first, e).transform.x + rectOf(byId(first, e)).widthPt < W, 'E starts inside the page');
    // E, just drawn, is the selection: its clipboard commands are enabled and Paste is not (nothing copied yet). The 読む tool clears the selection: all disabled.
    assert.deepEqual(await enabled(page, [...commands, '貼り付け']), [true, true, true, true, false], 'a just-drawn shape is selected; the clipboard is empty');
    await button(page, '読む').click();
    assert.deepEqual(await enabled(page, [...commands, '貼り付け']), [false, false, false, false, false]);

    // 1. Copy A and B (band): the clipboard fills, nothing is written, the Paste button enables.
    await button(page, '範囲選択').click();
    await gesture(page, [[.05, .05], [.75, .2]]);
    await expectSelection(page, { x: .1, y: .1, width: .6, height: .05 }, FRACTION, 'band over A and B');
    await button(page, 'コピー').click();
    assert.deepEqual((await committed(page, documentId)).edits, base.edits, 'copy writes no edit');
    assert.deepEqual(await enabled(page, ['貼り付け']), [true]);

    // 2. Paste: ONE batch creates two new objects (A', B') shifted by (14.882, 14.882) pt, on top, and they become the selection.
    await button(page, '貼り付け').click();
    const pasted = await settle(page, documentId, 5, 6);
    const pairs = lastChanges(pasted); assert.deepEqual(pairs.map(pair => pair[0]), ['create', 'create']);
    const second = inkOf(snapshotOf(pasted));
    assert.deepEqual(second.slice(0, 4), first, 'the four originals are unchanged and keep their order');
    const [a1, b1] = second.slice(4);
    assert.ok(![a, b, c, e].includes(a1.id) && ![a, b, c, e].includes(b1.id) && a1.id !== b1.id, 'the copies have new ids');
    expectShifted(byId(first, a), a1, 'A copy'); expectShifted(byId(first, b), b1, 'B copy');
    near(OFFSET, 14.882, 1e-9, 'the offset is 14.882 pt');
    await expectSelection(page, { x: .125, y: .1 + OFFSET / H, width: .6, height: .05 }, FRACTION, 'the pasted pair is selected');
    assert.equal(await button(page, '範囲選択').getAttribute('aria-pressed'), 'true', 'the region tool is active after a paste');

    // 3. Duplicate C (click on its top edge): a copy of the SELECTION, shifted the same way; the clipboard (A, B) is not replaced.
    await gesture(page, [[.25, .5]]);
    await expectSelection(page, { x: .1, y: .5, width: .3, height: .08 }, FRACTION, 'click on C');
    await button(page, '複製').click();
    const duplicated = await settle(page, documentId, 6, 7);
    assert.deepEqual(lastChanges(duplicated).map(pair => pair[0]), ['create']);
    const third = inkOf(snapshotOf(duplicated)); assert.deepEqual(third.slice(0, 6), second);
    const c1 = third[6]; assert.notEqual(c1.id, c); expectShifted(byId(first, c), c1, 'C duplicate');
    // 4. Paste again: still A and B (the duplicate did not touch the clipboard), at the same shifted place as the first pair.
    await button(page, '貼り付け').click();
    const repasted = await settle(page, documentId, 7, 9);
    const fourth = inkOf(snapshotOf(repasted)); assert.deepEqual(fourth.slice(0, 7), third);
    const [a2, b2] = fourth.slice(7);
    expectShifted(byId(first, a), a2, 'second A copy'); expectShifted(byId(first, b), b2, 'second B copy');
    assert.notEqual(a2.id, a1.id); assert.deepEqual(a2.transform, a1.transform, 'a second paste lands on the first paste (the clipboard keeps the original position)');
    const beforeCut = fourth.map(value => value.id);

    // 5. Cut E (click on its top edge): copy + delete in one batch; E leaves the DOM and the stored page.
    await gesture(page, [[.87, .85]]);
    await expectSelection(page, { x: .75, y: .85, width: .24, height: .12 }, FRACTION, 'click on E');
    await button(page, '切り取り').click();
    const cut = await settle(page, documentId, 8, 8);
    assert.deepEqual(lastChanges(cut), sortedPairs([['delete', e]]));
    const afterCut = inkOf(snapshotOf(cut)); assert.deepEqual(afterCut.map(value => value.id), beforeCut.filter(id => id !== e));
    await expectSelection(page, null, FRACTION, 'the selection is empty after a cut');
    // 6. Paste E near the right edge: shifted down by 14.882 pt but pulled back so its right edge is exactly the page edge (595.28 pt).
    await button(page, '貼り付け').click();
    const edge = await settle(page, documentId, 9, 9);
    const fifth = inkOf(snapshotOf(edge)), e2 = fifth[fifth.length - 1];
    assert.equal(fifth.length, afterCut.length + 1); assert.notEqual(e2.id, e);
    assert.deepEqual(e2.geometry, byId(first, e).geometry); assert.deepEqual(e2.style, byId(first, e).style);
    near(e2.transform.x + rectOf(e2).widthPt, W, 1e-6, 'E copy right edge is the page edge');
    assert.ok(e2.transform.x < byId(first, e).transform.x + OFFSET - 1, 'it was pulled back from x + 14.882');
    near(e2.transform.y, byId(first, e).transform.y + OFFSET, 1e-9, 'E copy y (not clamped)');
    // 7. Undo twice: the pasted copy goes, then the cut is undone and E returns with its own id, geometry, style and place in the order.
    await button(page, '元に戻す').click();
    const undonePaste = await settle(page, documentId, 10, 8);
    assert.deepEqual(inkOf(snapshotOf(undonePaste)), afterCut, 'Undo of the paste restores the state after the cut');
    await button(page, '元に戻す').click();
    const undoneCut = await settle(page, documentId, 11, 9);
    assert.deepEqual(inkOf(snapshotOf(undoneCut)), fourth, 'Undo of the cut restores E and the whole page exactly, in order');
    await button(page, 'やり直す').click();
    const redoneCut = await settle(page, documentId, 12, 8);
    assert.deepEqual(inkOf(snapshotOf(redoneCut)), afterCut, 'Redo of the cut removes E again');

    // 8. Lock: copy, cut, duplicate, delete and paste are all disabled (the clipboard still holds E) and nothing is written.
    await button(page, '編集をロック').click(); await button(page, '編集ロックを解除').waitFor();
    assert.deepEqual(await enabled(page, [...commands, '貼り付け']), [false, false, false, false, false], 'clipboard commands are refused while locked');
    await button(page, '編集ロックを解除').click(); await button(page, '編集をロック').waitFor();
    assert.deepEqual(await enabled(page, ['貼り付け']), [true], 'the clipboard is still there after unlocking');
    const settled = await durable(page, documentId, afterCut.map(value => value.id), 12);
    assert.deepEqual(settled.edits, redoneCut.edits, 'lock wrote no edit');

    // 9. Cold restart: the same stored log and drawings. The clipboard is a session value: it is gone and Paste is disabled.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, afterCut.map(value => value.id), 12);
    assert.deepEqual(restarted.edits, settled.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(await inks(reopened), drawings);
    assert.deepEqual(await enabled(reopened, [...commands, '貼り付け']), [false, false, false, false, false], 'after a restart nothing is selected and the clipboard is empty');
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only',
      observed: { offset: OFFSET, copyAx: a1.transform.x - byId(first, a).transform.x, edgeCopyRight: e2.transform.x + rectOf(e2).widthPt } }));
  });

  test(`ordinary P2 clipboard across pages and documents: a paste lands on another page and in another document of a different paper size, scaled by the width ratio (${engine})`, { timeout: 300_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, titleX = `P2 clipboard X ${engine}`, titleY = `P2 clipboard Y ${engine}`;
    const jump = async (number: number, domCount: number) => {
      const input = page.getByLabel('ページ番号', { exact: true });
      await input.fill(String(number)); await input.press('Enter'); assert.equal(await input.inputValue(), String(number));
      await page.waitForFunction(expected => document.querySelectorAll('[data-ink-id]').length === expected, domCount);
    };
    const documentX = await createNotebook(page, titleX);
    const r1 = await drawRect(page, documentX, [], 1, [.1, .10], [.3, .20]);
    const r2 = await drawRect(page, documentX, [r1], 2, [.5, .30], [.7, .40]);
    const drawnX = await durable(page, documentX, [r1, r2], 2), originals = inkOf(snapshotOf(drawnX));
    await button(page, '範囲選択').click();
    await gesture(page, [[.05, .05], [.75, .45]]);
    await expectSelection(page, { x: .1, y: .1, width: .6, height: .3 }, FRACTION, 'band over R1 and R2');
    await button(page, 'コピー').click();

    // 1. Another page of the same document: add a blank page (a document batch), go there, paste.
    await button(page, 'ページ追加').click();
    const added = await durableCount(page, documentX, 3), pageIds = snapshotOf(added).pages.map(value => value.id);
    assert.equal(pageIds.length, 2); assert.deepEqual(snapshotOf(added).pages[1].annotations, []);
    await jump(2, 0);
    assert.deepEqual(await enabled(page, ['貼り付け']), [true], 'the clipboard follows the user to another page');
    await button(page, '貼り付け').click();
    const onPage2 = await settle(page, documentX, 4, 2);
    const batch = headBatch(onPage2); assert.equal(batch.kind, 'page');
    if (batch.kind === 'page') assert.equal(batch.expected.pageId, pageIds[1], 'the paste is a page batch for page 2');
    const snapshot2 = snapshotOf(onPage2);
    assert.deepEqual(inkOf(snapshot2, 0), originals, 'page 1 is untouched');
    const copies = inkOf(snapshot2, 1); assert.equal(copies.length, 2);
    expectShifted(byId(originals, r1), copies[0], 'R1 on page 2'); expectShifted(byId(originals, r2), copies[1], 'R2 on page 2');
    assert.ok(copies.every(value => !originals.some(original => original.id === value.id)), 'new ids');
    await expectSelection(page, { x: .125, y: .1 + OFFSET / H, width: .6, height: .3 }, FRACTION, 'the pasted pair is selected on page 2');
    await jump(1, 2);
    assert.deepEqual((await inks(page)).map(value => value.id).sort(), [r1, r2].sort(), 'page 1 shows only the originals');

    // 2. Another document with another paper size: A5 (148 x 210 mm). A paste scales by (A5 width / A4 width) about the page origin.
    const A5W = 148 * 72 / 25.4;
    const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
    if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
    const documentY = await createNotebook(page, titleY);
    assert.notEqual(documentY, documentX);
    await button(page, '用紙設定').click();
    const dialog = page.getByRole('dialog', { name: '用紙設定', exact: true });
    await dialog.getByLabel('用紙サイズ', { exact: true }).selectOption('A5');
    await dialog.getByRole('button', { name: '適用', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const paperY = await durableCount(page, documentY, 1);
    near(snapshotOf(paperY).pages[0].widthPt, A5W, 1e-6, 'Y is an A5 page');
    assert.deepEqual(await enabled(page, ['貼り付け']), [true], 'the clipboard follows the user to another document');
    await button(page, '貼り付け').click();
    const inY = await settle(page, documentY, 2, 2);
    const batchY = headBatch(inY); assert.equal(batchY.kind, 'page'); assert.equal(batchY.targetId, documentY);
    const pagesY = snapshotOf(inY).pages; const placed = inkOf(snapshotOf(inY)); assert.equal(placed.length, 2);
    const ratio = pagesY[0].widthPt / W; near(ratio, 148 / 210, 2e-5, 'the width ratio is A5 / A4 = 148 / 210');
    for (const [index, original] of originals.entries()) {
      const copy = placed[index];
      assert.deepEqual(copy.geometry, original.geometry, 'the local geometry is not rewritten'); assert.deepEqual(copy.style, original.style, 'the stored width is not rewritten');
      near(copy.transform.scaleX, 148 / 210, 2e-5, 'scaleX is the width ratio'); near(copy.transform.scaleY, 148 / 210, 2e-5, 'scaleY is the width ratio');
      near(copy.transform.scaleX, pagesY[0].widthPt / W, 1e-9, 'scaleX is exactly (Y width / X width)');
      near(copy.transform.x, original.transform.x * ratio + .025 * pagesY[0].widthPt, 1e-6, `copy ${index} x`);
      near(copy.transform.y, original.transform.y * ratio + .025 * pagesY[0].widthPt, 1e-6, `copy ${index} y`);
      assert.equal(copy.transform.rotationRad, 0);
    }
    // 3. The first document did not change; Y's log is exactly paper change + paste.
    assert.deepEqual((await committed(page, documentX)).edits, onPage2.edits, 'pasting into Y wrote nothing to X');

    // 4. Cold restart: both documents keep their logs; the clipboard is gone.
    const reopened = await app.restart(titleY);
    const restartedY = await durable(reopened, documentY, placed.map(value => value.id), 2);
    assert.deepEqual(restartedY.edits, inY.edits, 'Y survives cold restart');
    assert.deepEqual(await enabled(reopened, ['貼り付け', ...commands]), [false, false, false, false, false]);
    assert.deepEqual((await committed(reopened, documentX)).edits, onPage2.edits, 'X survives cold restart');
    t.diagnostic(JSON.stringify({ engine, documentX, documentY, touchCoverage: 'mouse only', observed: { ratio, a5Width: pagesY[0].widthPt, copyScaleX: placed[0].transform.scaleX } }));
  });
}
