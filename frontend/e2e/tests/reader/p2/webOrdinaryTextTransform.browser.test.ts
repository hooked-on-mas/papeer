import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FONT_PT, centerFraction, drawnText, frameFraction, handleOf, regionPressed, textGeometry, textbox } from './ordinaryText.ts';
import { H, W, button, byId, expectSelection, inkOf, lastChanges, near, selection, snapshotOf } from './ordinaryInk.ts';
import { durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** B14-3c (F07): moving, rotating and scaling a text from the ordinary toolbar and its frame handles, re-editing the transformed text, and restyling its colour.
 *  Mouse only. Values come from the real DOM and the real IndexedDB edit log. */
const FRACTION = .008; // tolerance for a selection frame, as a fraction of the page layer
const PT = 3; // pt tolerance for a position that follows the pointer (WebKit drifted by up to ~1.7 pt in B14-2)
const MOVE_PT = 2; // pt tolerance for a drag distance (as in the B14-3a handle-drag test)

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary P2 text: move, handle rotation, 15 degree rotation and scale keep the body, re-editing a turned text keeps its transform, colour restyle, Undo and restart (${engine})`, { timeout: 300_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 text transform ${engine}`;
    const documentId = await createNotebook(page, title);
    const text = textbox(page), confirm = button(page, '確定');

    // Two texts with the default colour (#dc2626): T "Move me" (7 ASCII characters = 4.2 font sizes = 62.5044 pt wide) and U "日本語" (3 full-width = 44.646 pt).
    await button(page, '文字').click();
    await gesture(page, [[.3, .3]]);
    await text.fill('Move me');
    await confirm.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
    const t1 = (await inks(page))[0].id;
    await durable(page, documentId, [t1], 1);
    await button(page, '文字').click();
    await gesture(page, [[.6, .6]]);
    await text.fill('日本語');
    await confirm.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
    const u = (await inks(page)).map(value => value.id).find(value => value !== t1)!;
    const created = await durable(page, documentId, [t1, u], 2);
    const first = inkOf(snapshotOf(created)), tFirst = byId(first, t1), uFirst = byId(first, u), gT = textGeometry(tFirst);
    near(gT.widthPt, 4.2 * 14.882, 1e-9, 'T width'); near(gT.widthPt, 62.5044, 1e-9, 'literal 62.5044 pt'); near(gT.heightPt, 19.3466, 1e-9, 'T height');
    near(textGeometry(uFirst).widthPt, 44.646, 1e-9, 'U width'); near(FONT_PT, 14.882, 1e-9, 'font size');
    near(tFirst.transform.x, .3 * W, PT, 'T x'); near(tFirst.transform.y, .3 * H, PT, 'T y'); near(uFirst.transform.x, .6 * W, PT, 'U x');

    // 1. A click on T with the selection tool selects T only; the frame is T's box. (U is selected right after its creation and is replaced.)
    await button(page, '範囲選択').click();
    await gesture(page, [centerFraction(tFirst)]);
    await expectSelection(page, frameFraction(tFirst), FRACTION, 'click on T');

    // 2. Move: drag inside the frame by (+.10, +.05) of the page layer: T alone is updated, by 59.528 pt right and 42.0945 pt down; the body, scale and rotation are kept.
    const [cx, cy] = centerFraction(tFirst);
    await gesture(page, [[cx, cy], [cx + .1, cy + .05]]);
    const moved = await durable(page, documentId, [t1, u], 3);
    assert.deepEqual(lastChanges(moved), [['update', t1]], 'only T changes');
    const tMoved = byId(inkOf(snapshotOf(moved)), t1);
    near(tMoved.transform.x - tFirst.transform.x, .1 * W, MOVE_PT, 'T moved right by 59.528 pt'); near(tMoved.transform.y - tFirst.transform.y, .05 * H, MOVE_PT, 'T moved down by 42.0945 pt');
    assert.deepEqual([tMoved.transform.rotationRad, tMoved.transform.scaleX, tMoved.transform.scaleY], [0, 1, 1]);
    assert.deepEqual(tMoved.geometry, tFirst.geometry, 'the body and the box are not rewritten'); assert.deepEqual(tMoved.style, tFirst.style);
    assert.deepEqual(byId(inkOf(snapshotOf(moved)), u), uFirst, 'U is untouched');
    await expectSelection(page, frameFraction(tMoved), FRACTION, 'the frame moved with T');

    // 3. Rotation handle: with Shift the angle snaps to 15 degree steps; a drag from straight above the frame centre to 30 degrees clockwise gives pi/6.
    //    The text turns about the centre of its frame, so its centre stays where it was.
    const frame = (await selection(page))!, grip = await handleOf(page, 'rotate');
    const ratio = H / W, centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const radius = (centre[1] - grip[1]) * ratio, to: [number, number] = [centre[0] + radius * Math.cos(-Math.PI / 3), centre[1] + radius * Math.sin(-Math.PI / 3) / ratio];
    near(grip[0], centre[0], FRACTION, 'the rotation handle is above the centre');
    await page.keyboard.down('Shift');
    try { await gesture(page, [grip, to]); } finally { await page.keyboard.up('Shift'); }
    const turned = await durable(page, documentId, [t1, u], 4);
    assert.deepEqual(lastChanges(turned), [['update', t1]]);
    const tTurned = byId(inkOf(snapshotOf(turned)), t1);
    near(tTurned.transform.rotationRad, Math.PI / 6, 1e-9, 'rotation snapped to pi/6'); near(tTurned.transform.rotationRad, 0.5235987755982988, 1e-9, 'literal 0.5236 rad');
    assert.equal(tTurned.transform.scaleX, 1); assert.deepEqual(tTurned.geometry, tMoved.geometry);
    const before = centerFraction(tMoved), after = centerFraction(tTurned);
    near(after[0] * W, before[0] * W, 1e-6, 'the centre stays: x'); near(after[1] * H, before[1] * H, 1e-6, 'the centre stays: y');
    const drawingsTurned = await inks(page);

    // 4. 15度回転: pi/6 + pi/12 = pi/4 in total, about the same centre. 書き込みを拡大: scale 1.1 about the same centre; the local box is not rewritten.
    await button(page, '15度回転').click();
    const quarter = await durable(page, documentId, [t1, u], 5);
    assert.deepEqual(lastChanges(quarter), [['update', t1]]);
    const tQuarter = byId(inkOf(snapshotOf(quarter)), t1);
    near(tQuarter.transform.rotationRad, Math.PI / 4, 1e-9, 'rotation pi/4'); near(tQuarter.transform.rotationRad, 0.7853981633974483, 1e-9, 'literal 0.7854 rad');
    const q = centerFraction(tQuarter);
    near(q[0] * W, before[0] * W, 1e-6, 'the centre stays after 15 degrees: x'); near(q[1] * H, before[1] * H, 1e-6, 'the centre stays after 15 degrees: y');
    assert.notDeepEqual(await inks(page), drawingsTurned, 'the drawn text turned');
    await button(page, '書き込みを拡大').click();
    const grown = await durable(page, documentId, [t1, u], 6);
    assert.deepEqual(lastChanges(grown), [['update', t1]]);
    const tGrown = byId(inkOf(snapshotOf(grown)), t1);
    assert.deepEqual([tGrown.transform.scaleX, tGrown.transform.scaleY], [1.1, 1.1], 'scale 1.1 stored exactly');
    near(tGrown.transform.rotationRad, Math.PI / 4, 1e-9, 'rotation kept'); assert.deepEqual(tGrown.geometry, tMoved.geometry, 'the local box is not rewritten');
    const grownCentre = centerFraction(tGrown);
    near(grownCentre[0] * W, before[0] * W, 1e-6, 'the centre stays after the scale: x'); near(grownCentre[1] * H, before[1] * H, 1e-6, 'the centre stays after the scale: y');
    assert.deepEqual(byId(inkOf(snapshotOf(grown)), u), uFirst, 'U is untouched by every step');
    const drawingsGrown = await inks(page);

    // 5. Re-edit the turned and scaled text with the 文字 tool (the click is on the centre of the turned box). The id, rotation, scale, position and style are kept; the font size
    //    stays 14.882 (the scale lives in the transform); the box is recomputed for the 11-character body "Move me too" = 6.6 font sizes = 98.2212 pt.
    await button(page, '文字').click();
    await gesture(page, [centerFraction(tGrown)]);
    await text.waitFor();
    assert.equal(await text.inputValue(), 'Move me', 'the draft opens with the stored text');
    await text.fill('Move me too');
    await confirm.click();
    await text.waitFor({ state: 'detached' });
    const reedited = await durable(page, documentId, [t1, u], 7);
    assert.deepEqual(lastChanges(reedited), [['update', t1]]);
    const tReedited = byId(inkOf(snapshotOf(reedited)), t1), gRe = textGeometry(tReedited);
    assert.equal(gRe.text, 'Move me too'); near(gRe.fontSizePt, 14.882, 1e-9, 'font size kept (not multiplied by the scale)');
    near(gRe.widthPt, 6.6 * 14.882, 1e-9, 'new width'); near(gRe.widthPt, 98.2212, 1e-9, 'literal 98.2212 pt'); near(gRe.heightPt, 19.3466, 1e-9, 'one line');
    assert.deepEqual(tReedited.transform, tGrown.transform, 'rotation, scale and position are kept');
    assert.deepEqual(tReedited.style, tGrown.style);
    assert.deepEqual(await drawnText(page, t1), [{ text: 'Move me too', fill: '#dc2626', fontSize: 14.882 }]);
    assert.deepEqual(await drawnText(page, u), [{ text: '日本語', fill: '#dc2626', fontSize: 14.882 }]);
    assert.equal(await regionPressed(page), true, 'the selection tool is active again with T selected');
    const drawingsReedited = await inks(page);

    // 6. Colour restyle of the selected text: only its style colour changes (the body and transform are kept); U keeps its colour; the preference is not changed.
    await page.getByLabel('書き込みの色', { exact: true }).fill('#00aa55');
    const recoloured = await durable(page, documentId, [t1, u], 8);
    assert.deepEqual(lastChanges(recoloured), [['update', t1]], 'only T is restyled');
    const tColour = byId(inkOf(snapshotOf(recoloured)), t1);
    assert.equal(tColour.style.color, '#00aa55'); assert.deepEqual({ ...tColour.style, color: '' }, { ...tReedited.style, color: '' }, 'only the colour changed in the style');
    assert.deepEqual(tColour.geometry, tReedited.geometry); assert.deepEqual(tColour.transform, tReedited.transform);
    assert.deepEqual(await drawnText(page, t1), [{ text: 'Move me too', fill: '#00aa55', fontSize: 14.882 }]);
    assert.deepEqual(await drawnText(page, u), [{ text: '日本語', fill: '#dc2626', fontSize: 14.882 }]);
    await button(page, '読む').click();
    assert.equal(await page.getByLabel('書き込みの色', { exact: true }).inputValue(), '#dc2626', 'the colour preference was not changed by the restyle');

    // 7. Undo twice (colour, then the re-edit) and Redo twice: each restores the stored state of its step exactly, one operation each.
    await button(page, '元に戻す').click();
    const undoColour = await durable(page, documentId, [t1, u], 9);
    assert.deepEqual(inkOf(snapshotOf(undoColour)), inkOf(snapshotOf(reedited)), 'Undo of the colour restores the re-edited state');
    await button(page, '元に戻す').click();
    const undoEdit = await durable(page, documentId, [t1, u], 10);
    assert.deepEqual(inkOf(snapshotOf(undoEdit)), inkOf(snapshotOf(grown)), 'Undo of the re-edit restores the scaled state (body "Move me")');
    assert.deepEqual(await inks(page), drawingsGrown);
    await button(page, 'やり直す').click();
    const redoEdit = await durable(page, documentId, [t1, u], 11);
    assert.deepEqual(inkOf(snapshotOf(redoEdit)), inkOf(snapshotOf(reedited)));
    assert.deepEqual(await inks(page), drawingsReedited);
    await button(page, 'やり直す').click();
    const redoColour = await durable(page, documentId, [t1, u], 12);
    assert.deepEqual(inkOf(snapshotOf(redoColour)), inkOf(snapshotOf(recoloured)));

    // Cold restart: the same stored log and drawings, nothing selected, no draft.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [t1, u], 12);
    assert.deepEqual(restarted.edits, redoColour.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(inkOf(snapshotOf(restarted)), inkOf(snapshotOf(recoloured)));
    assert.deepEqual(await inks(reopened), drawings);
    assert.equal(await selection(reopened), null, 'selection is not persisted');
    assert.equal(await textbox(reopened).count(), 0, 'no draft is open after the restart');
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only',
      observed: { moveDeltaPt: [tMoved.transform.x - tFirst.transform.x, tMoved.transform.y - tFirst.transform.y], handleRotationRad: tTurned.transform.rotationRad,
        quarterRad: tQuarter.transform.rotationRad, scale: tGrown.transform.scaleX, centrePt: [before[0] * W, before[1] * H] } }));
  });
}
