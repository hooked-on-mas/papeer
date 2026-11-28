import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FONT_PT, LINE, drawnText, frameFraction, textGeometry, textbox } from './ordinaryText.ts';
import { button, byId, drawRect, expectSelection, inkOf, lastChanges, near, snapshotOf } from './ordinaryInk.ts';
import { durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** B14-3c (F07): what the ordinary toolbar REFUSES. Degenerate shapes and blank text write nothing; a refusal is proved by a positive control that is stored afterwards
 *  (a delayed refused write would show up as an extra stored edit, and every count below is exact). Mouse only. Values come from the real DOM and the real IndexedDB edit log. */
const FRACTION = .008; // tolerance for a selection frame, as a fraction of the page layer
const PT = 3; // pt tolerance for a position that follows the pointer (WebKit drifted by up to ~1.7 pt in B14-2)

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary P2 text and shape refusals: degenerate frames and blank text write nothing, a confirmed text and a rectangle do (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 text refusals ${engine}`;
    const documentId = await createNotebook(page, title);
    const kind = page.getByLabel('描画の種類', { exact: true });

    // 1. Degenerate frames: a click without a drag, and a flat rectangle or ellipse (zero height or zero width), draw nothing.
    for (const shape of ['rectangle', 'ellipse', 'line', 'arrow']) {
      await kind.selectOption(shape);
      await gesture(page, [[.3, .3]]);
    }
    await kind.selectOption('rectangle'); await gesture(page, [[.2, .5], [.5, .5]]); // zero height
    await kind.selectOption('ellipse'); await gesture(page, [[.2, .55], [.5, .55]]); // zero height
    await kind.selectOption('rectangle'); await gesture(page, [[.6, .4], [.6, .7]]); // zero width
    assert.equal((await inks(page)).length, 0, 'no degenerate frame is drawn');
    // Positive control (the same tools can write): a real rectangle is the first and only stored edit.
    const rectId = await drawRect(page, documentId, [], 1, [.2, .6], [.4, .65]);
    const controlled = await durable(page, documentId, [rectId], 1);
    assert.deepEqual(lastChanges(controlled), [['create', rectId]], 'the first stored edit is the control rectangle: the seven refused gestures wrote nothing');

    // 2. Blank text: the 確定 button is disabled for an empty draft and for whitespace only, Ctrl+Enter does not confirm, Escape and キャンセル discard.
    const text = textbox(page), confirm = button(page, '確定'), cancel = button(page, 'キャンセル');
    await button(page, '文字').click();
    await gesture(page, [[.3, .3]]);
    await text.waitFor();
    assert.equal(await text.inputValue(), '', 'a new draft starts empty');
    assert.equal(await confirm.isDisabled(), true, 'an empty draft cannot be confirmed');
    await text.fill('   \n\t ');
    assert.equal(await confirm.isDisabled(), true, 'a whitespace-only draft cannot be confirmed');
    await text.press('Control+Enter');
    assert.equal(await text.count(), 1, 'Ctrl+Enter on a whitespace-only draft does not confirm: the draft stays open');
    assert.equal((await inks(page)).length, 1, 'no text was drawn');
    await text.press('Escape');
    await text.waitFor({ state: 'detached' });
    await gesture(page, [[.3, .3]]);
    await text.waitFor();
    await text.fill('  ');
    await cancel.click();
    await text.waitFor({ state: 'detached' });
    assert.equal((await inks(page)).length, 1, 'a cancelled blank draft draws nothing');

    // 3. A real text is the second stored edit (positive control for the text path): "x" is one ASCII character = 0.6 font sizes, but a text box is never narrower than one font size.
    await gesture(page, [[.3, .3]]);
    await text.fill('x');
    assert.equal(await confirm.isDisabled(), false, 'a non-blank draft can be confirmed');
    await confirm.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
    const textId = (await inks(page)).map(value => value.id).find(value => value !== rectId)!;
    const created = await durable(page, documentId, [rectId, textId], 2);
    assert.deepEqual(lastChanges(created), [['create', textId]], 'exactly one create: the blank drafts and the refused shapes wrote nothing');
    const first = byId(inkOf(snapshotOf(created)), textId), g = textGeometry(first);
    assert.equal(g.text, 'x'); assert.equal(g.fontFamily, 'sans-serif');
    near(g.fontSizePt, FONT_PT, 1e-9, 'font size'); near(g.fontSizePt, 14.882, 1e-9, 'font size literal');
    near(g.widthPt, 14.882, 1e-9, 'width: one ASCII character (0.6 font sizes) is raised to the minimum of one font size'); near(g.widthPt, FONT_PT, 1e-9, 'minimum width = one font size');
    near(g.heightPt, LINE * 14.882, 1e-9, 'one line height'); near(g.heightPt, 19.3466, 1e-9, 'literal 19.3466 pt');
    near(first.transform.x, .3 * 595.28, PT, 'x follows the click'); near(first.transform.y, .3 * 841.89, PT, 'y follows the click');
    assert.deepEqual([first.transform.rotationRad, first.transform.scaleX, first.transform.scaleY], [0, 1, 1]);
    assert.equal(first.style.color, '#dc2626', 'the default colour'); near(first.style.widthPt, .003 * 595.28, 1e-6, 'width preference .003 x 595.28');
    assert.deepEqual(await drawnText(page, textId), [{ text: 'x', fill: '#dc2626', fontSize: 14.882 }]);
    assert.equal(await text.count(), 0, 'the draft is closed after the confirmation');
    assert.equal(await button(page, '範囲選択').getAttribute('aria-pressed'), 'true', 'a confirmed text switches to the selection tool');
    await expectSelection(page, frameFraction(first), FRACTION, 'the confirmed text is selected');

    // 4. Re-editing an existing text: the 文字 tool on the text opens the draft with its text; a blank value (empty or whitespace) cannot be confirmed
    //    and Ctrl+Enter does not confirm it; キャンセル leaves the stored text and the drawing as they were.
    const drawingsBefore = await inks(page);
    await button(page, '文字').click();
    const point: [number, number] = [(first.transform.x + g.widthPt / 2) / 595.28, (first.transform.y + g.heightPt / 2) / 841.89];
    await gesture(page, [point]);
    await text.waitFor();
    assert.equal(await text.inputValue(), 'x', 'the draft opens with the stored text');
    await text.fill('');
    assert.equal(await confirm.isDisabled(), true, 'an emptied text cannot be confirmed');
    await text.press('Control+Enter');
    assert.equal(await text.count(), 1, 'Ctrl+Enter on the emptied text does not confirm');
    await text.fill(' \n ');
    assert.equal(await confirm.isDisabled(), true, 'a whitespace-only text cannot be confirmed');
    await text.press('Escape');
    await text.waitFor({ state: 'detached' });
    await gesture(page, [point]);
    await text.fill('');
    await cancel.click();
    await text.waitFor({ state: 'detached' });
    const settled = await durable(page, documentId, [rectId, textId], 2);
    assert.deepEqual(settled.edits, created.edits, 'nothing was written by the refused re-edits');
    assert.deepEqual(byId(inkOf(snapshotOf(settled)), textId), first, 'the stored text is unchanged');
    assert.deepEqual(await inks(page), drawingsBefore, 'the drawing is unchanged');
    assert.deepEqual(await drawnText(page, textId), [{ text: 'x', fill: '#dc2626', fontSize: 14.882 }]);

    // Cold restart: the same stored log and drawings, no draft open.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [rectId, textId], 2);
    assert.deepEqual(restarted.edits, settled.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(await inks(reopened), drawings);
    assert.equal(await textbox(reopened).count(), 0, 'no draft is open after the restart');
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only',
      observed: { textX: first.transform.x, textY: first.transform.y, widthPt: g.widthPt, heightPt: g.heightPt } }));
  });
}
