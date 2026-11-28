import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { W, button, byId, drawRect, drawn, expectSelection, inkOf, lastChanges, near, snapshotOf, sortedPairs } from './ordinaryInk.ts';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** B14-3b (F10): restyling the SELECTED objects from the ordinary toolbar (colour, width, favourite). Mouse only. Values are read from the real DOM and the real IndexedDB edit log. */
const FRACTION = .008; // tolerance for a selection frame, as a fraction of the page layer
/** What the real SVG draws for one ink: stroke colour and opacity exactly, stroke width to 1e-6. */
async function expectDrawn(page: Page, id: string, expected: { stroke: string; strokeWidth: number; opacity: number }) {
  const actual = await drawn(page, id);
  assert.deepEqual({ stroke: actual.stroke, opacity: actual.opacity }, { stroke: expected.stroke, opacity: expected.opacity }, `${id} drawn colour and opacity`);
  near(actual.strokeWidth, expected.strokeWidth, 1e-6, `${id} drawn stroke width`);
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary P2 restyle of selected ink: colour, width, favourite and highlighter write exact style updates, leave the preferences alone, undo and survive restart (${engine})`, { timeout: 300_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 restyle ${engine}`;
    const documentId = await createNotebook(page, title);
    const color = page.getByLabel('書き込みの色', { exact: true }), width = page.getByLabel('線の太さ', { exact: true });
    const favourites = page.getByLabel('お気に入りのペン', { exact: true });
    // Defaults before anything is changed.
    assert.equal(await color.inputValue(), '#dc2626'); assert.equal(await width.inputValue(), '0.003');
    // 1. With nothing selected the toolbar changes the PREFERENCES only: no edit is written. The favourite keeps (#225588, .006).
    await color.fill('#225588'); await width.selectOption('0.006');
    await button(page, '現在のペンをお気に入りに追加').click();
    assert.equal(await favourites.locator('option').count(), 2, 'one favourite plus the placeholder');
    assert.equal((await committed(page, documentId)).edits.length, 0, 'preference changes write no edit');
    // A and B take (#225588, .006): widthPt is .006 x 595.28 = 3.57168. A just-drawn shape stays selected (see step 8), so the 読む tool clears the selection before a preference is changed.
    const a = await drawRect(page, documentId, [], 1, [.1, .10], [.3, .15]);
    const b = await drawRect(page, documentId, [a], 2, [.5, .10], [.7, .15]);
    await button(page, '読む').click(); await expectSelection(page, null, FRACTION, 'the 読む tool clears the selection');
    // C takes the next preference (#aa3300, .015): widthPt 8.9292.
    await color.fill('#aa3300'); await width.selectOption('0.015');
    assert.equal((await committed(page, documentId)).edits.length, 2, 'with nothing selected the colour and width boxes write no edit');
    const c = await drawRect(page, documentId, [a, b], 3, [.1, .50], [.4, .58]);
    await button(page, '読む').click();
    // H is a highlighter stroke with the separate highlighter preference (#facc15, .025): widthPt 14.882.
    await page.getByLabel('描画の種類', { exact: true }).selectOption('highlighter');
    await gesture(page, [[.5, .5], [.7, .52]]);
    await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 4);
    const h = (await inks(page)).map(value => value.id).find(value => ![a, b, c].includes(value))!;
    const created = await durable(page, documentId, [a, b, c, h], 4);
    const first = inkOf(snapshotOf(created));
    assert.deepEqual(first.map(value => value.id), [a, b, c, h]);
    assert.equal(snapshotOf(created).pages[0].widthPt, W);
    for (const [id, expected] of [[a, ['#225588', 3.57168]], [b, ['#225588', 3.57168]], [c, ['#aa3300', 8.9292]], [h, ['#facc15', 14.882]]] as const) {
      assert.equal(byId(first, id).style.color, expected[0], `${id} colour`); near(byId(first, id).style.widthPt, expected[1], 1e-6, `${id} widthPt`);
    }
    assert.equal(byId(first, h).style.highlighter, true); assert.equal(byId(first, a).style.highlighter, false);
    const highlighterOpacity = byId(first, h).style.opacity;
    assert.equal(highlighterOpacity, .3, 'a highlighter is stored with opacity 0.3');
    assert.equal(byId(first, a).style.opacity, 1);
    await expectDrawn(page, a, { stroke: '#225588', strokeWidth: byId(first, a).style.widthPt, opacity: 1 });

    // 2. Colour of the selected A and B. The toolbar shows the first selected object's colour and width.
    await button(page, '範囲選択').click();
    await gesture(page, [[.05, .05], [.75, .2]]);
    await expectSelection(page, { x: .1, y: .1, width: .6, height: .05 }, FRACTION, 'band over A and B');
    assert.equal(await color.inputValue(), '#225588', 'the colour box shows the selection');
    assert.equal(await width.inputValue(), '0.006', 'the width box shows the selection');
    await color.fill('#00aa55');
    const recoloured = await durable(page, documentId, [a, b, c, h], 5);
    assert.deepEqual(lastChanges(recoloured), sortedPairs([['update', a], ['update', b]]), 'only the selected A and B are updated');
    const second = inkOf(snapshotOf(recoloured));
    for (const id of [a, b]) assert.deepEqual(byId(second, id), { ...byId(first, id), style: { ...byId(first, id).style, color: '#00aa55' } }, `${id}: only the colour changed`);
    for (const id of [c, h]) assert.deepEqual(byId(second, id), byId(first, id), `${id} is untouched`);
    await expectDrawn(page, a, { stroke: '#00aa55', strokeWidth: 3.57168, opacity: 1 });
    assert.equal((await drawn(page, c)).stroke, '#aa3300', 'the unselected C is still drawn in its own colour');
    await expectSelection(page, { x: .1, y: .1, width: .6, height: .05 }, FRACTION, 'the selection stays after a restyle');
    assert.equal(await color.inputValue(), '#00aa55');

    // 3. Width of the selection (scale 1): widthPt = .025 x 595.28 = 14.882, colour kept.
    await width.selectOption('0.025');
    const widened = await durable(page, documentId, [a, b, c, h], 6);
    assert.deepEqual(lastChanges(widened), sortedPairs([['update', a], ['update', b]]));
    const third = inkOf(snapshotOf(widened));
    for (const id of [a, b]) {
      assert.deepEqual(byId(third, id), { ...byId(second, id), style: { ...byId(second, id).style, widthPt: byId(third, id).style.widthPt } });
      near(byId(third, id).style.widthPt, 14.882, 1e-6, `${id} widthPt`); assert.equal(byId(third, id).style.color, '#00aa55');
    }
    assert.equal((await drawn(page, b)).strokeWidth, byId(third, b).style.widthPt, 'the drawn stroke width is the stored width');

    // 4. After enlarging by 1.1 the stored width compensates the scale: the on-page width stays .04 x 595.28 = 23.8112.
    await button(page, '書き込みを拡大').click();
    await durable(page, documentId, [a, b, c, h], 7);
    await width.selectOption('0.04');
    const scaled = await durable(page, documentId, [a, b, c, h], 8);
    const fourth = inkOf(snapshotOf(scaled));
    for (const id of [a, b]) {
      near(byId(fourth, id).transform.scaleX, 1.1, 1e-12, `${id} scaleX`);
      near(byId(fourth, id).style.widthPt, 23.8112 / 1.1, 1e-6, `${id} widthPt is divided by the scale`);
      near(byId(fourth, id).style.widthPt * byId(fourth, id).transform.scaleX, 23.8112, 1e-9, `${id} on-page width`);
    }
    near(Number(await width.inputValue()), .04, 1e-9, 'the width box shows the on-page width again');

    // 5. A favourite applies BOTH colour and width to the selected object (C only, picked by a click on its top edge).
    await gesture(page, [[.25, .5]]);
    await expectSelection(page, { x: .1, y: .5, width: .3, height: .08 }, FRACTION, 'click on C');
    await favourites.selectOption('0');
    const favoured = await durable(page, documentId, [a, b, c, h], 9);
    assert.deepEqual(lastChanges(favoured), sortedPairs([['update', c]]));
    const fifth = inkOf(snapshotOf(favoured));
    assert.deepEqual(byId(fifth, c), { ...byId(fourth, c), style: { ...byId(fourth, c).style, color: '#225588', widthPt: byId(fifth, c).style.widthPt } });
    near(byId(fifth, c).style.widthPt, 3.57168, 1e-6, 'C widthPt from the favourite');
    for (const id of [a, b, h]) assert.deepEqual(byId(fifth, id), byId(fourth, id), `${id} untouched by the favourite`);

    // 6. A mixed selection (C and the highlighter H): the colour changes for both, the highlighter stays translucent and its width stays.
    await gesture(page, [[.05, .45], [.75, .62]]);
    await expectSelection(page, { x: .1, y: .5, width: .6, height: .08 }, FRACTION, 'band over C and H');
    await color.fill('#7733cc');
    const mixed = await durable(page, documentId, [a, b, c, h], 10);
    assert.deepEqual(lastChanges(mixed), sortedPairs([['update', c], ['update', h]]));
    const sixth = inkOf(snapshotOf(mixed));
    assert.deepEqual(byId(sixth, h), { ...byId(fifth, h), style: { ...byId(fifth, h).style, color: '#7733cc' } }, 'H: colour only; still a highlighter with its opacity and width');
    assert.equal(byId(sixth, h).style.highlighter, true); assert.equal(byId(sixth, h).style.opacity, highlighterOpacity);
    assert.deepEqual(byId(sixth, c), { ...byId(fifth, c), style: { ...byId(fifth, c).style, color: '#7733cc' } });
    for (const id of [a, b]) assert.deepEqual(byId(sixth, id), byId(fifth, id));
    assert.equal((await drawn(page, h)).stroke, '#7733cc'); assert.equal((await drawn(page, h)).opacity, highlighterOpacity);

    // 7. Undo restores the previous styles exactly (one new stored edit), Redo applies them again.
    await button(page, '元に戻す').click();
    const undone = await durable(page, documentId, [a, b, c, h], 11);
    assert.deepEqual(inkOf(snapshotOf(undone)), fifth, 'Undo restores every style and transform');
    assert.equal((await drawn(page, h)).stroke, '#facc15');
    await button(page, 'やり直す').click();
    const redone = await durable(page, documentId, [a, b, c, h], 12);
    assert.deepEqual(inkOf(snapshotOf(redone)), sixth, 'Redo applies the same styles again');
    assert.equal((await drawn(page, h)).stroke, '#7733cc');

    // 8. None of the restyles touched the preferences: with the selection cleared the toolbar shows (#aa3300, .015). A new rectangle D uses them,
    //    and, being just drawn, D is the selection: the colour box then restyles D alone (current behaviour, fixed here).
    await gesture(page, [[.8, .8]]);
    await expectSelection(page, null, FRACTION, 'click on empty page');
    assert.equal(await color.inputValue(), '#aa3300'); assert.equal(await width.inputValue(), '0.015');
    const d = await drawRect(page, documentId, [a, b, c, h], 13, [.55, .70], [.8, .78]);
    const withD = inkOf(snapshotOf(await durable(page, documentId, [a, b, c, h, d], 13)));
    assert.equal(byId(withD, d).style.color, '#aa3300'); near(byId(withD, d).style.widthPt, 8.9292, 1e-6, 'D widthPt from the unchanged preference');
    await expectSelection(page, { x: .55, y: .7, width: .25, height: .08 }, FRACTION, 'a just-drawn shape is selected');
    await color.fill('#118833');
    const recoloured2 = await durable(page, documentId, [a, b, c, h, d], 14);
    assert.deepEqual(lastChanges(recoloured2), sortedPairs([['update', d]]), 'the colour box restyles the just-drawn D only');
    const withD2 = inkOf(snapshotOf(recoloured2));
    assert.deepEqual(byId(withD2, d), { ...byId(withD, d), style: { ...byId(withD, d).style, color: '#118833' } });
    for (const id of [a, b, c, h]) assert.deepEqual(byId(withD2, id), byId(withD, id));
    await gesture(page, [[.9, .9]]);
    assert.equal(await color.inputValue(), '#aa3300', 'the restyle of D did not change the preference');

    // 9. Lock: with a selection made, locking drops it and the style controls are disabled; nothing is written.
    await button(page, '範囲選択').click();
    await gesture(page, [[.05, .05], [.75, .2]]);
    // A and B were enlarged by 1.1 about their common centre, so the frame is x .07-.73, y .0975-.1525.
    await expectSelection(page, { x: .07, y: .0975, width: .66, height: .055 }, FRACTION, 'band over the enlarged A and B');
    await button(page, '編集をロック').click(); await button(page, '編集ロックを解除').waitFor();
    for (const control of [color, width, favourites, button(page, '現在のペンをお気に入りに追加')]) assert.equal(await control.isDisabled(), true, 'style controls are disabled while locked');
    await button(page, '編集ロックを解除').click(); await button(page, '編集をロック').waitFor();
    const settled = await durable(page, documentId, [a, b, c, h, d], 14);

    // 10. Cold restart: the same stored log and drawings, the preferences and favourite restored, nothing selected.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [a, b, c, h, d], 14);
    assert.deepEqual(restarted.edits, settled.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(await inks(reopened), drawings);
    assert.deepEqual(inkOf(snapshotOf(restarted)), withD2);
    await expectDrawn(reopened, h, { stroke: '#7733cc', strokeWidth: 14.882, opacity: highlighterOpacity });
    assert.equal(await reopened.getByLabel('書き込みの色', { exact: true }).inputValue(), '#aa3300');
    assert.equal(await reopened.getByLabel('線の太さ', { exact: true }).inputValue(), '0.015');
    assert.equal(await reopened.getByLabel('お気に入りのペン', { exact: true }).locator('option').count(), 2);
    await expectSelection(reopened, null, FRACTION, 'selection is not persisted');
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, highlighterOpacity, touchCoverage: 'mouse only',
      observed: { aWidthPt: byId(withD2, a).style.widthPt, cWidthPt: byId(withD2, c).style.widthPt, hWidthPt: byId(withD2, h).style.widthPt, aScaleX: byId(withD2, a).transform.scaleX } satisfies Record<string, number> }));
  });
}
