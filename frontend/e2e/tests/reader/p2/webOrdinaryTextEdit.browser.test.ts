import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FONT_PT, LINE, centerFraction, doubleClickAt, drawnText, frameFraction, regionPressed, textGeometry, textbox } from './ordinaryText.ts';
import { H, W, button, byId, expectSelection, inkOf, lastChanges, near, snapshotOf } from './ordinaryInk.ts';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** B14-3c (F07): creating a text and re-editing its body from the ordinary toolbar. The frame stays inside the page; Undo, Redo and a cold restart keep the stored log. Mouse only.
 *  Values come from the real DOM and the real IndexedDB edit log. */
const FRACTION = .008; // tolerance for a selection frame, as a fraction of the page layer
const PT = 3; // pt tolerance for a position that follows the pointer (WebKit drifted by up to ~1.7 pt in B14-2)

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary P2 text: a new text, re-editing its body by the 文字 tool and by double click, the in-page frame fit, Undo and restart (${engine})`, { timeout: 300_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 text edit ${engine}`;
    const documentId = await createNotebook(page, title);
    const text = textbox(page), confirm = button(page, '確定'), cancel = button(page, 'キャンセル');
    // The colour and width preferences are used by a new text: widthPt = .015 x 595.28 = 8.9292.
    await page.getByLabel('書き込みの色', { exact: true }).fill('#aa3300');
    await page.getByLabel('線の太さ', { exact: true }).selectOption('0.015');

    // 1. A new two-line text. The draft writes nothing until 確定. "Hello" and "World" are 5 ASCII characters = 3 font sizes each.
    await button(page, '文字').click();
    await gesture(page, [[.2, .2]]);
    await text.fill('Hello\nWorld');
    assert.equal((await committed(page, documentId)).edits.length, 0, 'a draft writes nothing before 確定');
    await confirm.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
    const a = (await inks(page))[0].id;
    const created = await durable(page, documentId, [a], 1);
    assert.deepEqual(lastChanges(created), [['create', a]]);
    const first = byId(inkOf(snapshotOf(created)), a), gFirst = textGeometry(first);
    assert.equal(gFirst.text, 'Hello\nWorld'); assert.equal(gFirst.fontFamily, 'sans-serif');
    near(gFirst.fontSizePt, 14.882, 1e-9, 'font size'); near(gFirst.fontSizePt, FONT_PT, 1e-9, 'font size from the page width');
    near(gFirst.widthPt, 3 * 14.882, 1e-9, 'width: the widest line'); near(gFirst.widthPt, 44.646, 1e-9, 'literal 44.646 pt');
    near(gFirst.heightPt, 2 * LINE * 14.882, 1e-9, 'height: two lines'); near(gFirst.heightPt, 38.6932, 1e-9, 'literal 38.6932 pt');
    near(first.transform.x, .2 * W, PT, 'x follows the click'); near(first.transform.y, .2 * H, PT, 'y follows the click');
    assert.deepEqual([first.transform.rotationRad, first.transform.scaleX, first.transform.scaleY], [0, 1, 1]);
    assert.equal(first.style.color, '#aa3300'); near(first.style.widthPt, 8.9292, 1e-6, 'width preference .015 x 595.28');
    assert.deepEqual(await drawnText(page, a), [{ text: 'Hello', fill: '#aa3300', fontSize: 14.882 }, { text: 'World', fill: '#aa3300', fontSize: 14.882 }]);
    assert.equal(await regionPressed(page), true, 'a confirmed text switches to the selection tool');
    await expectSelection(page, frameFraction(first), FRACTION, 'the confirmed text is selected');

    // 2. A text near the right edge is moved left so that it stays inside the page: a 15-character ASCII line is 9 font sizes wide = 133.938 pt, so its right edge is
    //    exactly the page width and its left edge is 595.28 - 133.938 = 461.342 pt, whatever the click position.
    await button(page, '文字').click();
    await gesture(page, [[.9, .5]]);
    await text.fill('Right edge text');
    await confirm.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
    const b = (await inks(page)).map(value => value.id).find(value => value !== a)!;
    const both = await durable(page, documentId, [a, b], 2);
    assert.deepEqual(lastChanges(both), [['create', b]]);
    const rightText = byId(inkOf(snapshotOf(both)), b), gRight = textGeometry(rightText);
    near(gRight.widthPt, 9 * 14.882, 1e-9, 'width of 15 ASCII characters'); near(gRight.widthPt, 133.938, 1e-9, 'literal 133.938 pt');
    near(rightText.transform.x, 461.342, 1e-6, 'x is pulled back so that the right edge is the page width'); near(rightText.transform.x + gRight.widthPt, 595.28, 1e-6, 'right edge');
    near(rightText.transform.y, .5 * H, PT, 'y follows the click');
    assert.deepEqual(inkOf(snapshotOf(both)).map(value => value.id), [a, b], 'stored order: A then B');

    // 3. Re-edit A with the 文字 tool: the draft opens with the stored text and writes nothing until 確定. The new body has three lines, the longest has 5 non-ASCII
    //    characters = 5 font sizes. The id, order, transform and style are kept; the font size is kept; the box is recomputed.
    await button(page, '文字').click();
    await gesture(page, [centerFraction(first)]);
    await text.waitFor();
    assert.equal(await text.inputValue(), 'Hello\nWorld', 'the draft opens with the stored text');
    await text.fill('Hello\nWorld\n日本語です');
    assert.equal((await committed(page, documentId)).edits.length, 2, 'the re-edit draft writes nothing before 確定');
    await confirm.click();
    await text.waitFor({ state: 'detached' });
    const edited = await durable(page, documentId, [a, b], 3);
    assert.deepEqual(lastChanges(edited), [['update', a]], 'one update of A only');
    const afterEdit = inkOf(snapshotOf(edited));
    assert.deepEqual(afterEdit.map(value => value.id), [a, b], 'the order is kept');
    const threeLine = byId(afterEdit, a), gThree = textGeometry(threeLine);
    assert.equal(gThree.text, 'Hello\nWorld\n日本語です');
    near(gThree.fontSizePt, 14.882, 1e-9, 'the font size is kept'); assert.equal(gThree.fontFamily, 'sans-serif');
    near(gThree.widthPt, 5 * 14.882, 1e-9, 'width: the widest line is 5 full-width characters'); near(gThree.widthPt, 74.41, 1e-9, 'literal 74.41 pt');
    near(gThree.heightPt, 3 * LINE * 14.882, 1e-9, 'height: three lines'); near(gThree.heightPt, 58.0398, 1e-9, 'literal 58.0398 pt');
    assert.deepEqual(threeLine.transform, first.transform, 'the transform is kept');
    assert.deepEqual(threeLine.style, first.style, 'the style is kept');
    assert.deepEqual(byId(afterEdit, b), rightText, 'B is untouched');
    assert.deepEqual(await drawnText(page, a), [{ text: 'Hello', fill: '#aa3300', fontSize: 14.882 }, { text: 'World', fill: '#aa3300', fontSize: 14.882 },
      { text: '日本語です', fill: '#aa3300', fontSize: 14.882 }]);
    assert.equal(await regionPressed(page), true, 'the selection tool is active again');
    await expectSelection(page, frameFraction(threeLine), FRACTION, 'the re-edited text is selected');

    // 4. Double click on the selected text (selection tool) opens the same draft. Confirming it unchanged writes nothing; キャンセル after typing writes nothing.
    await doubleClickAt(page, centerFraction(threeLine));
    await text.waitFor();
    assert.equal(await text.inputValue(), 'Hello\nWorld\n日本語です', 'double click opens the draft with the stored text');
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();
    await text.waitFor({ state: 'detached' });
    await doubleClickAt(page, centerFraction(threeLine));
    await text.waitFor();
    await text.fill('discarded');
    await cancel.click();
    await text.waitFor({ state: 'detached' });
    const unchanged = await durable(page, documentId, [a, b], 3);
    assert.deepEqual(unchanged.edits, edited.edits, 'an unchanged confirmation and a cancelled edit wrote nothing');
    const drawingsBeforeWide = await inks(page);

    // 5. Re-edit to a line wider than the page: 50 full-width characters = 744.1 pt. The text is scaled to 98% of the page width (583.3744 pt, scale .784) and moved so that
    //    its right edge is the page width (x = 11.9056); y and the geometry are kept apart from the new body.
    await doubleClickAt(page, centerFraction(threeLine));
    await text.waitFor();
    await text.fill('あ'.repeat(50));
    await confirm.click();
    await text.waitFor({ state: 'detached' });
    const wide = await durable(page, documentId, [a, b], 4);
    assert.deepEqual(lastChanges(wide), [['update', a]]);
    const wideText = byId(inkOf(snapshotOf(wide)), a), gWide = textGeometry(wideText);
    near(gWide.widthPt, 50 * 14.882, 1e-9, 'stored local width'); near(gWide.widthPt, 744.1, 1e-9, 'literal 744.1 pt');
    near(gWide.heightPt, LINE * 14.882, 1e-9, 'one line');
    near(wideText.transform.scaleX, .784, 1e-9, 'scale = .98 x 595.28 / 744.1'); near(wideText.transform.scaleY, .784, 1e-9, 'similarity keeps the aspect');
    near(wideText.transform.x, 11.9056, 1e-6, 'x = 595.28 - 583.3744'); near(wideText.transform.x + gWide.widthPt * wideText.transform.scaleX, 595.28, 1e-6, 'right edge is the page width');
    near(wideText.transform.y, threeLine.transform.y, 1e-9, 'y is kept'); assert.equal(wideText.transform.rotationRad, 0);
    assert.deepEqual(wideText.style, threeLine.style);
    await expectSelection(page, { x: .02, y: threeLine.transform.y / H, width: .98, height: LINE * 14.882 * .784 / H }, FRACTION, 'the frame follows the fitted text');
    assert.deepEqual(await drawnText(page, a), [{ text: 'あ'.repeat(50), fill: '#aa3300', fontSize: 14.882 }]);
    const drawingsWide = await inks(page);
    assert.notDeepEqual(drawingsWide, drawingsBeforeWide, 'the drawing changed');

    // 6. Undo restores the three-line text exactly; Redo restores the fitted text exactly (one operation each).
    await button(page, '元に戻す').click();
    const undone = await durable(page, documentId, [a, b], 5);
    assert.deepEqual(inkOf(snapshotOf(undone)), afterEdit, 'Undo restores the stored state of step 3');
    assert.deepEqual(await inks(page), drawingsBeforeWide);
    await button(page, 'やり直す').click();
    const redone = await durable(page, documentId, [a, b], 6);
    assert.deepEqual(inkOf(snapshotOf(redone)), inkOf(snapshotOf(wide)), 'Redo restores the stored state of step 5');
    assert.deepEqual(await inks(page), drawingsWide);

    // 7. Lock: the 文字 tool is disabled and a double click on the text opens no draft; nothing is written.
    await button(page, '編集をロック').click();
    await button(page, '編集ロックを解除').waitFor();
    assert.equal(await button(page, '文字').isDisabled(), true, 'the text tool is disabled while locked');
    await doubleClickAt(page, centerFraction(wideText));
    assert.equal(await text.count(), 0, 'a locked page opens no text draft');
    await button(page, '編集ロックを解除').click();
    await button(page, '編集をロック').waitFor();
    const settled = await durable(page, documentId, [a, b], 6);
    assert.deepEqual(settled.edits, redone.edits, 'locking wrote nothing');

    // Cold restart: the same stored log and drawings, no draft open, nothing selected.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [a, b], 6);
    assert.deepEqual(restarted.edits, settled.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(inkOf(snapshotOf(restarted)), inkOf(snapshotOf(wide)));
    assert.deepEqual(await inks(reopened), drawings);
    assert.equal(await textbox(reopened).count(), 0, 'no draft is open after the restart');
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only',
      observed: { firstX: first.transform.x, firstY: first.transform.y, rightEdgeX: rightText.transform.x, fittedX: wideText.transform.x, fittedScale: wideText.transform.scaleX } }));
  });
}
