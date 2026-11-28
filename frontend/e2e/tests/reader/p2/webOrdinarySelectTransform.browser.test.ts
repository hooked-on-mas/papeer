import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { InkObject, PageAnnotation } from '../../../../src/runtime/edits/contracts.ts';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

/** B14-3a (F08 / F09): ordinary notebook, mouse only. Selection and transform results are read from the real DOM and the real IndexedDB edit log. */
const W = 595.28, H = 841.89; // the notebook's blank A4 page in pt (also read back from the stored root)
const PT = 3; // pt tolerance for values that follow the pointer (WebKit drifted by up to ~1.7 pt in B14-2)
const FRACTION = .008; // tolerance for a DOM position, as a fraction of the page layer
type Committed = Awaited<ReturnType<typeof committed>>;
type Frame = { x: number; y: number; width: number; height: number };

const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

/** The head state of the page's annotations, replayed from the stored edit log (the log is one linear chain in these tests). */
function replay(observed: Committed): InkObject[] {
  const byParent = new Map(observed.edits.map(edit => [edit.batch.parents[0], edit.batch] as const));
  assert.equal(byParent.size, observed.edits.length, 'the stored edits form one linear chain');
  let annotations: PageAnnotation[] = [];
  for (let batch = byParent.get(observed.rootVersion); batch; batch = byParent.get(batch.id)) {
    assert.equal(batch.kind, 'page');
    if (batch.kind !== 'page') break;
    for (const change of batch.changes) {
      if (change.type === 'create') annotations = [...annotations, change.annotation];
      else if (change.type === 'update') annotations = annotations.map(value => value.id === change.annotation.id ? change.annotation : value);
      else if (change.type === 'delete') annotations = annotations.filter(value => value.id !== change.id);
      else annotations = change.ids.map(id => annotations.find(value => value.id === id)!);
    }
  }
  return annotations.map(value => { assert.equal(value.kind, 'ink'); return value as InkObject; });
}
/** The newest stored batch's changes as `[type, id]` pairs sorted by id. */
function lastChanges(observed: Committed): (readonly [string, string])[] {
  const parents = new Set(observed.edits.map(edit => edit.batch.parents[0]));
  const heads = observed.edits.filter(edit => !parents.has(edit.batch.id));
  assert.equal(heads.length, 1, 'exactly one head batch');
  const batch = heads[0].batch; assert.equal(batch.kind, 'page');
  if (batch.kind !== 'page') return [];
  return batch.changes.map(change => [change.type, change.type === 'delete' ? change.id : change.type === 'order' ? '' : change.annotation.id] as const)
    .sort((x, y) => x[1] < y[1] ? -1 : 1);
}
const sorted = (pairs: (readonly [string, string])[]) => [...pairs].sort((x, y) => x[1] < y[1] ? -1 : 1);
const rect = (annotation: InkObject) => {
  const g = annotation.geometry; assert.equal(g.kind, 'rect');
  if (g.kind !== 'rect') throw new Error('rect geometry expected');
  return g;
};
const corners = (annotation: InkObject) => {
  const g = rect(annotation), t = annotation.transform, c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad);
  return [[0, 0], [g.widthPt, 0], [g.widthPt, g.heightPt], [0, g.heightPt]].map(([x, y]) => ({ x: t.x + c * x * t.scaleX - s * y * t.scaleY, y: t.y + s * x * t.scaleX + c * y * t.scaleY }));
};
const centerOf = (annotation: InkObject) => { const [p, , q] = corners(annotation); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
const boxOf = (values: InkObject[]) => {
  const points = values.flatMap(corners);
  return { left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) };
};
/** A point turned by `angle` (radians, y down) about `about`: the plane rotation the selection's frame centre is fixed under. */
const turned = (point: { x: number; y: number }, about: { x: number; y: number }, angle: number) => ({
  x: about.x + (point.x - about.x) * Math.cos(angle) - (point.y - about.y) * Math.sin(angle),
  y: about.y + (point.x - about.x) * Math.sin(angle) + (point.y - about.y) * Math.cos(angle) });
/** Every rectangle's centre is where a rotation by `angle` about the frame centre of `before` puts it. */
function expectTurnedAbout(before: InkObject[], after: InkObject[], angle: number) {
  const box = boxOf(before), about = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  for (const old of before) {
    const expected = turned(centerOf(old), about, angle), actual = centerOf(byId(after, old.id));
    near(actual.x, expected.x, 1e-6, `${old.id} centre x`); near(actual.y, expected.y, 1e-6, `${old.id} centre y`);
  }
}
const byId = (values: InkObject[], id: string) => { const found = values.find(value => value.id === id); assert.ok(found, `annotation ${id} exists`); return found; };
const shapeOf = (values: InkObject[]) => values.map(value => ({ id: value.id, geometry: value.geometry, transform: value.transform }));

/** The selection frame the layer draws, as a fraction of the page layer, or null when nothing is selected. */
async function selection(page: Page): Promise<Frame | null> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-ink-selection] rect'), svg = document.querySelector('svg[aria-label="ノート書き込みレイヤー"]');
    if (!frame || !svg) return null;
    const height = Number(svg.getAttribute('viewBox')!.split(' ')[3]), n = (name: string) => Number(frame.getAttribute(name));
    return { x: (n('x') + 3) / 1000, y: (n('y') + 3) / height, width: (n('width') - 6) / 1000, height: (n('height') - 6) / height };
  });
}
async function expectSelection(page: Page, expected: Frame | null, what: string) {
  const frame = await selection(page);
  if (!expected) { assert.equal(frame, null, `${what}: nothing is selected`); return; }
  assert.ok(frame, `${what}: a selection frame is drawn`);
  for (const key of ['x', 'y', 'width', 'height'] as const) near(frame[key], expected[key], FRACTION, `${what} ${key}`);
}
/** A handle's centre as a fraction of the page layer, read from the SVG attributes (no pixel rounding). */
async function handle(page: Page, name: string): Promise<[number, number]> {
  return page.evaluate(name => {
    const element = document.querySelector(`[data-ink-handle="${name}"]`), svg = document.querySelector('svg[aria-label="ノート書き込みレイヤー"]');
    if (!element || !svg) throw new Error(`handle ${name} absent`);
    return [Number(element.getAttribute('cx')) / 1000, Number(element.getAttribute('cy')) / Number(svg.getAttribute('viewBox')!.split(' ')[3])] as [number, number];
  }, name);
}
async function drawRect(page: Page, documentId: string, known: string[], editCount: number, from: [number, number], to: [number, number]) {
  await page.getByLabel('描画の種類', { exact: true }).selectOption('rectangle');
  await gesture(page, [from, to]);
  await page.waitForFunction(expected => document.querySelectorAll('[data-ink-id]').length === expected, known.length + 1);
  const id = (await inks(page)).map(value => value.id).find(value => !known.includes(value))!;
  await durable(page, documentId, [...known, id], editCount);
  return id;
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const commands = ['コピー', '切り取り', '複製', '削除', '15度回転', '書き込みを拡大', '書き込みを縮小'];
const commandsEnabled = (page: Page) => Promise.all(commands.map(async name => !(await button(page, name).isDisabled())));
const none = commands.map(() => false), all = commands.map(() => true);

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary P2 rectangle and lasso selection: one, several, replaced, empty, overlap and lock write nothing and survive restart (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 select ${engine}`;
    const documentId = await createNotebook(page, title);
    // Page layer fractions: A x .1-.3 y .10-.15, B x .5-.7 y .10-.15, C x .1-.3 y .50-.55 (D, drawn later, x .2-.4 y .05-.12).
    const a = await drawRect(page, documentId, [], 1, [.1, .10], [.3, .15]);
    const b = await drawRect(page, documentId, [a], 2, [.5, .10], [.7, .15]);
    const c = await drawRect(page, documentId, [a, b], 3, [.1, .50], [.3, .55]);
    const drawn = await durable(page, documentId, [a, b, c], 3);
    near(rect(byId(replay(drawn), a)).widthPt, .2 * W, PT, 'A width');
    assert.equal(drawn.root.kind, 'document');
    if (drawn.root.kind === 'document') { assert.equal(drawn.root.pages[0].widthPt, W); assert.equal(drawn.root.pages[0].heightPt, H); }
    await button(page, '範囲選択').click();
    await expectSelection(page, null, 'region tool just chosen');
    assert.deepEqual(await commandsEnabled(page), none, 'selection commands are disabled with nothing selected');

    // 1. A rubber band that completely encloses A and B (not C) selects the two.
    await gesture(page, [[.05, .05], [.75, .2]]);
    await expectSelection(page, { x: .1, y: .1, width: .6, height: .05 }, 'band over A and B');
    assert.deepEqual(await commandsEnabled(page), all, 'selection commands are enabled for a selection');
    // 2. A second band elsewhere (starting outside the selected frame) replaces the selection.
    await gesture(page, [[.05, .45], [.35, .6]]);
    await expectSelection(page, { x: .1, y: .5, width: .2, height: .05 }, 'band over C replaces the selection');
    // 3. A band that completely encloses nothing (only half of B) selects nothing.
    await gesture(page, [[.4, .05], [.6, .2]]);
    await expectSelection(page, null, 'band over half of B');
    assert.deepEqual(await commandsEnabled(page), none);
    // 4. A click on A's top edge selects A; a click on empty page clears it.
    await gesture(page, [[.2, .10]]);
    await expectSelection(page, { x: .1, y: .1, width: .2, height: .05 }, 'click on A');
    await gesture(page, [[.8, .8]]);
    await expectSelection(page, null, 'click on empty page');
    // 5. Overlap: D crosses A. A click where both edges pass picks the newest (topmost) one; a click only on A picks A.
    const d = await drawRect(page, documentId, [a, b, c], 4, [.2, .05], [.4, .12]);
    assert.deepEqual(replay(await committed(page, documentId)).map(value => value.id), [a, b, c, d], 'D is stored after A, so it is drawn on top');
    await button(page, '範囲選択').click();
    await gesture(page, [[.2, .10]]);
    await expectSelection(page, { x: .2, y: .05, width: .2, height: .07 }, 'click where D and A overlap picks D');
    await gesture(page, [[.12, .10]]);
    await expectSelection(page, { x: .1, y: .1, width: .2, height: .05 }, 'click on A only picks A');
    await gesture(page, [[.8, .8]]);
    await expectSelection(page, null, 'click on empty page again');
    // 6. Lasso: a polygon enclosing A and C completely (not B; D only partly) selects A and C, and a command then changes exactly those.
    await button(page, 'なげなわ').click();
    await gesture(page, [[.05, .05], [.35, .05], [.35, .6], [.05, .6]]);
    await expectSelection(page, { x: .1, y: .1, width: .2, height: .45 }, 'lasso around A and C');
    const before = replay(await committed(page, documentId));
    await button(page, '15度回転').click();
    const rotated = await durable(page, documentId, [a, b, c, d], 5);
    assert.deepEqual(lastChanges(rotated), sorted([['update', a], ['update', c]]), 'only the lassoed A and C changed');
    const after = replay(rotated);
    assert.deepEqual(shapeOf([byId(after, b), byId(after, d)]), shapeOf([byId(before, b), byId(before, d)]), 'B and D are untouched');
    for (const id of [a, c]) near(byId(after, id).transform.rotationRad, 0.2617993877991494, 1e-9, 'rotated by 15 degrees');
    // 7. Lock: tools and commands are refused, the selection is dropped, nothing is written; unlock restores them.
    await button(page, '編集をロック').click();
    await button(page, '編集ロックを解除').waitFor();
    await expectSelection(page, null, 'locking drops the selection');
    for (const name of ['範囲選択', 'なげなわ', 'ペン', '消しゴム']) assert.equal(await button(page, name).isDisabled(), true, `${name} is disabled while locked`);
    assert.deepEqual(await commandsEnabled(page), none);
    await gesture(page, [[.05, .05], [.75, .2]]);
    await expectSelection(page, null, 'a band over a locked layer selects nothing');
    await button(page, '編集ロックを解除').click();
    await button(page, '編集をロック').waitFor();
    await button(page, '範囲選択').click();
    await gesture(page, [[.6, .10]]);
    await expectSelection(page, { x: .5, y: .1, width: .2, height: .05 }, 'after unlock a click on B selects B');
    // Hide: the strokes leave the DOM and the tools are refused; show brings the same drawings back.
    const shown = await inks(page);
    await button(page, '書き込みを非表示').click();
    await button(page, '書き込みを表示').waitFor();
    assert.equal((await inks(page)).length, 0, 'hidden writing is not in the DOM');
    assert.equal(await button(page, '範囲選択').isDisabled(), true);
    await button(page, '書き込みを表示').click();
    assert.deepEqual(await inks(page), shown, 'the same four drawings return');
    // Nothing above wrote anything except the one rotate.
    const settled = await durable(page, documentId, [a, b, c, d], 5);
    assert.deepEqual(settled.edits, rotated.edits, 'selection, lock and hide wrote no edit');

    // Cold restart: the same stored log and drawings, nothing selected, no selection command enabled.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [a, b, c, d], 5);
    assert.deepEqual(restarted.edits, settled.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(await inks(reopened), drawings);
    assert.equal(await selection(reopened), null, 'selection is not persisted');
    assert.deepEqual(await commandsEnabled(reopened), none);
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only' }));
  });

  test(`ordinary P2 scale and rotate buttons store exact transforms, clamp inside the page, undo and survive restart (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 buttons ${engine}`;
    const documentId = await createNotebook(page, title);
    // A x .2-.4 y .3-.4 and B x .5-.7 y .3-.4: stored in pt as fractions of 595.28 x 841.89.
    const a = await drawRect(page, documentId, [], 1, [.2, .3], [.4, .4]);
    const b = await drawRect(page, documentId, [a], 2, [.5, .3], [.7, .4]);
    const created = await durable(page, documentId, [a, b], 2);
    const first = replay(created);
    near(byId(first, a).transform.x, .2 * W, PT, 'A x'); near(byId(first, a).transform.y, .3 * H, PT, 'A y');
    near(rect(byId(first, a)).widthPt, .2 * W, PT, 'A width'); near(rect(byId(first, a)).heightPt, .1 * H, PT, 'A height');
    near(byId(first, b).transform.x, .5 * W, PT, 'B x');
    for (const id of [a, b]) assert.deepEqual([byId(first, id).transform.rotationRad, byId(first, id).transform.scaleX, byId(first, id).transform.scaleY], [0, 1, 1]);
    const start = boxOf(first);
    await button(page, '範囲選択').click();
    await gesture(page, [[.1, .2], [.8, .5]]);
    await expectSelection(page, { x: .2, y: .3, width: .5, height: .1 }, 'band over A and B');

    // 拡大: scale 1.1 about the selection's centre, both rectangles, one batch.
    await button(page, '書き込みを拡大').click();
    const grown = await durable(page, documentId, [a, b], 3);
    assert.deepEqual(lastChanges(grown), sorted([['update', a], ['update', b]]));
    const big = replay(grown);
    for (const id of [a, b]) {
      assert.deepEqual([byId(big, id).transform.scaleX, byId(big, id).transform.scaleY, byId(big, id).transform.rotationRad], [1.1, 1.1, 0], 'scale 1.1 stored exactly');
      assert.deepEqual(rect(byId(big, id)), rect(byId(first, id)), 'the local geometry is not rewritten');
    }
    const grownBox = boxOf(big);
    near((grownBox.left + grownBox.right) / 2, (start.left + start.right) / 2, 1e-6, 'centre x kept'); near((grownBox.top + grownBox.bottom) / 2, (start.top + start.bottom) / 2, 1e-6, 'centre y kept');
    near(grownBox.right - grownBox.left, 1.1 * (start.right - start.left), 1e-6, 'width x1.1'); near(grownBox.bottom - grownBox.top, 1.1 * (start.bottom - start.top), 1e-6, 'height x1.1');
    near(grownBox.right - grownBox.left, .55 * W, PT * 1.1, 'width literal'); near(grownBox.bottom - grownBox.top, .11 * H, PT * 1.1, 'height literal');
    await expectSelection(page, { x: .175, y: .295, width: .55, height: .11 }, 'the frame follows the enlarged selection');
    const drawingsGrown = await inks(page);

    // 縮小: 1 / 1.1 brings the first state back.
    await button(page, '書き込みを縮小').click();
    const shrunk = await durable(page, documentId, [a, b], 4);
    const small = replay(shrunk);
    for (const id of [a, b]) {
      near(byId(small, id).transform.scaleX, 1, 1e-9, 'scale back to 1'); near(byId(small, id).transform.scaleY, 1, 1e-9, 'scale back to 1');
      near(byId(small, id).transform.x, byId(first, id).transform.x, 1e-6, 'x back'); near(byId(small, id).transform.y, byId(first, id).transform.y, 1e-6, 'y back');
    }
    await expectSelection(page, { x: .2, y: .3, width: .5, height: .1 }, 'the frame is back');
    const drawingsSmall = await inks(page);

    // 15度回転: every rectangle turns by exactly pi/12, the pair turns rigidly about the selection's centre.
    await button(page, '15度回転').click();
    const turned = await durable(page, documentId, [a, b], 5);
    assert.deepEqual(lastChanges(turned), sorted([['update', a], ['update', b]]));
    const spun = replay(turned);
    for (const id of [a, b]) {
      near(byId(spun, id).transform.rotationRad, 0.2617993877991494, 1e-12, 'rotation pi/12');
      near(byId(spun, id).transform.scaleX, 1, 1e-9, 'scale kept'); assert.deepEqual(rect(byId(spun, id)), rect(byId(small, id)));
    }
    expectTurnedAbout(small, spun, 0.2617993877991494);
    assert.notDeepEqual(await inks(page), drawingsSmall, 'the drawn rectangles changed');
    const drawingsSpun = await inks(page);

    // Undo and Redo restore exactly, one operation each.
    await button(page, '元に戻す').click();
    const undone = await durable(page, documentId, [a, b], 6);
    assert.deepEqual(shapeOf(replay(undone)), shapeOf(small), 'undo of the rotation restores the stored state');
    assert.deepEqual(await inks(page), drawingsSmall);
    await button(page, 'やり直す').click();
    const redone = await durable(page, documentId, [a, b], 7);
    assert.deepEqual(shapeOf(replay(redone)), shapeOf(spun));
    assert.deepEqual(await inks(page), drawingsSpun);
    assert.notDeepEqual(drawingsSmall, drawingsGrown);

    // In-page constraint: E (x .2-.8) grows about its centre. Five clicks still fit; the sixth would be wider than the page, so the group is
    // scaled to 98% of the page width and moved to the left edge.
    const e = await drawRect(page, documentId, [a, b], 8, [.2, .6], [.8, .65]);
    const drawnE = replay(await committed(page, documentId)); const width0 = rect(byId(drawnE, e)).widthPt;
    near(width0, .6 * W, PT, 'E width'); near(byId(drawnE, e).transform.x, .2 * W, PT, 'E x');
    await button(page, '範囲選択').click();
    await gesture(page, [[.1, .55], [.9, .7]]);
    await expectSelection(page, { x: .2, y: .6, width: .6, height: .05 }, 'band over E');
    let count = 8, fitted = replay(await committed(page, documentId));
    for (let click = 1; click <= 5; click++) {
      await button(page, '書き込みを拡大').click();
      const step = await durable(page, documentId, [a, b, e], ++count);
      assert.deepEqual(lastChanges(step), [['update', e]], 'only E changes');
      fitted = replay(step);
      near(byId(fitted, e).transform.scaleX, 1.1 ** click, 1e-9, `E scale after ${click} clicks`);
      const box = boxOf([byId(fitted, e)]);
      assert.ok(box.left > 0 && box.right < W, `E stays inside the page after ${click} clicks: ${JSON.stringify(box)}`);
      near((box.left + box.right) / 2, centerOf(byId(drawnE, e)).x, 1e-6, 'E grows about its centre');
    }
    const fifth = fitted;
    await button(page, '書き込みを拡大').click();
    const clamped = await durable(page, documentId, [a, b, e], ++count);
    fitted = replay(clamped);
    const limit = boxOf([byId(fitted, e)]);
    near(limit.right - limit.left, .98 * W, 1e-6, 'E is scaled to 98% of the page width'); near(limit.right - limit.left, 583.3744, 1e-6, 'literal 583.3744 pt');
    near(limit.left, 0, 1e-6, 'E is moved to the left edge'); near(limit.right, 583.3744, 1e-6, 'E right edge');
    near(byId(fitted, e).transform.scaleX, .98 * W / width0, 1e-9, 'E scale from the clamp'); near(byId(fitted, e).transform.scaleY, byId(fitted, e).transform.scaleX, 1e-9, 'similarity keeps the aspect');
    assert.ok(limit.top > 0 && limit.bottom < H, 'E stays inside vertically');
    await expectSelection(page, { x: 0, y: limit.top / H, width: .98, height: (limit.bottom - limit.top) / H }, 'the frame follows the clamped E');
    await button(page, '元に戻す').click();
    const unclamped = await durable(page, documentId, [a, b, e], ++count);
    assert.deepEqual(shapeOf(replay(unclamped)), shapeOf(fifth), 'undo of the clamped step restores the fifth state');

    // Cold restart.
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [a, b, e], count);
    assert.deepEqual(restarted.edits, unclamped.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(shapeOf(replay(restarted)), shapeOf(replay(unclamped)));
    assert.deepEqual(await inks(reopened), drawings);
    assert.equal(await selection(reopened), null, 'selection is not persisted');
    assert.deepEqual(await commandsEnabled(reopened), none);
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only',
      observed: { clampedWidthPt: limit.right - limit.left, clampedLeftPt: limit.left, clampedScale: byId(fitted, e).transform.scaleX, firstWidthPt: rect(byId(first, a)).widthPt } }));
  });

  test(`ordinary P2 handle drags move, resize and rotate a selection with stored literals, undo and survive restart (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page, title = `P2 handles ${engine}`;
    const documentId = await createNotebook(page, title);
    // P x .1-.2 y .20-.25 and Q x .3-.4 y .20-.25.
    const p = await drawRect(page, documentId, [], 1, [.1, .2], [.2, .25]);
    const q = await drawRect(page, documentId, [p], 2, [.3, .2], [.4, .25]);
    const created = await durable(page, documentId, [p, q], 2);
    const first = replay(created);
    await button(page, '範囲選択').click();
    await gesture(page, [[.05, .15], [.45, .3]]);
    await expectSelection(page, { x: .1, y: .2, width: .3, height: .05 }, 'band over P and Q');
    assert.equal(await page.locator('[data-ink-handle]').count(), 5, 'four resize handles and one rotation handle');

    // Move: drag inside the frame by (+.10, +.05) of the page layer.
    await gesture(page, [[.25, .225], [.35, .275]]);
    const moved = await durable(page, documentId, [p, q], 3);
    assert.deepEqual(lastChanges(moved), sorted([['update', p], ['update', q]]));
    const afterMove = replay(moved);
    for (const id of [p, q]) {
      near(byId(afterMove, id).transform.x - byId(first, id).transform.x, .1 * W, 2, `${id} moved right by 59.528 pt`);
      near(byId(afterMove, id).transform.y - byId(first, id).transform.y, .05 * H, 2, `${id} moved down by 42.0945 pt`);
      assert.deepEqual([byId(afterMove, id).transform.scaleX, byId(afterMove, id).transform.scaleY, byId(afterMove, id).transform.rotationRad], [1, 1, 0]);
      assert.deepEqual(rect(byId(afterMove, id)), rect(byId(first, id)));
    }
    near(byId(afterMove, q).transform.x - byId(afterMove, p).transform.x, byId(first, q).transform.x - byId(first, p).transform.x, 1e-6, 'the pair moves as one');
    await expectSelection(page, { x: .2, y: .25, width: .3, height: .05 }, 'the frame moved');

    // Resize: drag the bottom-right corner handle to twice its distance from the opposite (top-left) corner.
    const anchor = (await selection(page))!, corner = await handle(page, '2');
    const goal: [number, number] = [anchor.x + 2 * (corner[0] - anchor.x), anchor.y + 2 * (corner[1] - anchor.y)];
    const boxMoved = boxOf(afterMove);
    await gesture(page, [corner, goal]);
    const resized = await durable(page, documentId, [p, q], 4);
    assert.deepEqual(lastChanges(resized), sorted([['update', p], ['update', q]]));
    const afterResize = replay(resized), boxResized = boxOf(afterResize);
    for (const id of [p, q]) {
      near(byId(afterResize, id).transform.scaleX, 2, .03, 'scale about 2'); assert.equal(byId(afterResize, id).transform.scaleX, byId(afterResize, id).transform.scaleY);
      assert.equal(byId(afterResize, id).transform.rotationRad, 0);
    }
    near(byId(afterResize, p).transform.scaleX, byId(afterResize, q).transform.scaleX, 1e-9, 'one scale for the group');
    near(boxResized.left, boxMoved.left, 1e-6, 'the opposite corner stays: left'); near(boxResized.top, boxMoved.top, 1e-6, 'the opposite corner stays: top');
    near((boxResized.right - boxResized.left) / (boxMoved.right - boxMoved.left), 2, .03, 'width doubled');
    await expectSelection(page, { x: .2, y: .25, width: .6, height: .1 }, 'the frame doubled from its top-left corner');

    // Rotate: Shift snaps to 15-degree steps; drag the rotation handle from straight above the centre to 30 degrees clockwise of that.
    const frame = (await selection(page))!, grip = await handle(page, 'rotate');
    const ratio = H / W, centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const radius = (centre[1] - grip[1]) * ratio, to: [number, number] = [centre[0] + radius * Math.cos(-Math.PI / 3), centre[1] + radius * Math.sin(-Math.PI / 3) / ratio];
    near(grip[0], centre[0], FRACTION, 'the rotation handle is above the centre');
    const boxBefore = boxOf(afterResize);
    await page.keyboard.down('Shift');
    try { await gesture(page, [grip, to]); } finally { await page.keyboard.up('Shift'); }
    const rotated = await durable(page, documentId, [p, q], 5);
    assert.deepEqual(lastChanges(rotated), sorted([['update', p], ['update', q]]));
    const afterRotate = replay(rotated);
    for (const id of [p, q]) {
      near(byId(afterRotate, id).transform.rotationRad, Math.PI / 6, 1e-9, 'rotation snapped to pi/6');
      assert.equal(byId(afterRotate, id).transform.scaleX, byId(afterResize, id).transform.scaleX);
      assert.deepEqual(rect(byId(afterRotate, id)), rect(byId(afterResize, id)));
    }
    expectTurnedAbout(afterResize, afterRotate, Math.PI / 6);
    assert.notEqual(boxOf(afterRotate).bottom, boxBefore.bottom, 'the extent changed with the turn');
    const drawingsRotated = await inks(page);

    // Undo the rotation only, then restart.
    await button(page, '元に戻す').click();
    const undone = await durable(page, documentId, [p, q], 6);
    assert.deepEqual(shapeOf(replay(undone)), shapeOf(afterResize), 'undo restores the resized state');
    assert.notDeepEqual(await inks(page), drawingsRotated);
    const drawings = await inks(page);
    const reopened = await app.restart(title);
    const restarted = await durable(reopened, documentId, [p, q], 6);
    assert.deepEqual(restarted.edits, undone.edits, 'the same persisted batches survive cold restart');
    assert.deepEqual(await inks(reopened), drawings);
    assert.equal(await selection(reopened), null, 'selection is not persisted');
    t.diagnostic(JSON.stringify({ engine, documentId, editsAtEnd: restarted.edits.length, touchCoverage: 'mouse only',
      observed: { moveDeltaPt: [byId(afterMove, p).transform.x - byId(first, p).transform.x, byId(afterMove, p).transform.y - byId(first, p).transform.y],
        resizeScale: byId(afterResize, p).transform.scaleX, rotationRad: byId(afterRotate, p).transform.rotationRad } }));
  });
}
