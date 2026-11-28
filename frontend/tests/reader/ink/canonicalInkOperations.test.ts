import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyCanonicalInkOperation } from '../../../src/features/reader/ink/canonicalInkOperations.ts';
import { DocumentEditSession } from '../../../src/features/reader/edit/DocumentEditSession.ts';
import { annotationPoints, transformInkPoint } from '../../../src/runtime/edits/annotationGeometry.ts';
import { projectInkObject } from '../../../src/features/reader/ink/canonicalInk.ts';
import type { DocumentSnapshot, InkObject, Page, PageAnnotation } from '../../../src/runtime/edits/contracts.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const arrow: InkObject = { kind: 'ink', id: '00000000-0000-4000-8000-000000000001', geometry: { kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 80, y: 40 }, head: 'both', headLengthPt: 10, preferredHeadLengthPt: 24 },
  style: { color: '#123456', widthPt: 2, opacity: .63, highlighter: false },
  transform: { x: 200, y: 220, scaleX: 1.2, scaleY: .7, rotationRad: .35 } };
const text: InkObject = { ...structuredClone(arrow), id: '00000000-0000-4000-8000-000000000002', geometry: { kind: 'text', widthPt: 70, heightPt: 35, text: '世界', fontSizePt: 20, fontFamily: 'serif' },
  transform: { ...arrow.transform, x: 370, y: 300 } };
const sticky: PageAnnotation = { kind: 'sticky', id: '00000000-0000-4000-8000-000000000003', text: 'keep', anchor: { x: 50, y: 50 }, color: null, metadata: { label: '', createdAt: null } };
function page(annotations: PageAnnotation[] = [arrow, sticky, text]): Page {
  return { ...structuredClone(fixture.document.pages[0]), widthPt: 600, heightPt: 900, annotations: structuredClone(annotations) };
}
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }

test('group similarity preserves raw geometry, style and non-ink while moving physical points correctly', () => {
  const base = page(), before = structuredClone(base), center: [number, number] = [.5, .5], delta: [number, number] = [.03, -.02], scale = 1.3, angle = .4;
  const result = applyCanonicalInkOperation(base, { type: 'transform', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], center, delta, scale, angle });
  assert.deepEqual(base, before); assert.equal(result.changes.length, 2); assert.deepEqual(result.createdIds, []);
  assert.equal(result.annotations[1], base.annotations[1]);
  for (const i of [0, 2]) {
    const old = base.annotations[i] as InkObject, next = result.annotations[i] as InkObject;
    assert.deepEqual(next.geometry, old.geometry); assert.deepEqual(next.style, old.style);
    const point = { x: 17, y: 9 }, a = transformInkPoint(old, point), b = transformInkPoint(next, point);
    near(b.x, 300 + scale * ((a.x - 300) * Math.cos(angle) - (a.y - 450) * Math.sin(angle)) + 18);
    near(b.y, 450 + scale * ((a.x - 300) * Math.sin(angle) + (a.y - 450) * Math.cos(angle)) - 18);
  }
  assert.deepEqual(applyCanonicalInkOperation(base, { type: 'transform', ids: ['00000000-0000-4000-8000-000000000001'], center, delta: [0, 0], scale: 1, angle: 0 }).changes, []);
});

test('style changes only specified fields and expresses width in visible page proportions', () => {
  const base = page();
  const result = applyCanonicalInkOperation(base, { type: 'style', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], color: '#abcdef', width: .01 });
  for (const index of [0, 2]) {
    const old = base.annotations[index] as InkObject, updated = result.annotations[index] as InkObject;
    assert.deepEqual(updated.geometry, old.geometry); assert.deepEqual(updated.transform, old.transform);
    assert.equal(updated.style.opacity, old.style.opacity); assert.equal(updated.style.highlighter, old.style.highlighter);
    near(updated.style.widthPt * Math.max(updated.transform.scaleX, updated.transform.scaleY), 6);
  }
  assert.deepEqual(applyCanonicalInkOperation(base, { type: 'style', ids: ['00000000-0000-4000-8000-000000000001'], color: arrow.style.color }).changes, []);
});

test('paste clones canonical attributes, assigns supplied IDs and preserves stacking order', () => {
  const base = page(), source = [arrow, text], saved = structuredClone(source);
  const result = applyCanonicalInkOperation(base, { type: 'paste', annotations: source, sourceWidthPt: 1200, ids: ['00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006'], delta: [0, 0] });
  assert.deepEqual(result.annotations.map(a => a.id), ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006']);
  assert.deepEqual(result.createdIds, ['00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006']); assert.deepEqual(source, saved);
  for (let i = 0; i < 2; i++) {
    const copy = result.annotations[3 + i] as InkObject;
    assert.deepEqual(copy.geometry, source[i].geometry); assert.deepEqual(copy.style, source[i].style);
    near(copy.transform.x, source[i].transform.x / 2); near(copy.transform.scaleY, source[i].transform.scaleY / 2);
    assert.notEqual(copy.geometry, source[i].geometry);
  }
});

test('boundary fitting uses true rotated ellipse extrema and uniformly preserves the whole group', () => {
  const ellipse: InkObject = { ...structuredClone(arrow), id: '00000000-0000-4000-8000-000000000004', geometry: { kind: 'ellipse', widthPt: 1000, heightPt: 240 },
    transform: { x: 590, y: -50, rotationRad: .327, scaleX: 1.4, scaleY: .8 } };
  const base = page([ellipse, text]);
  const result = applyCanonicalInkOperation(base, { type: 'transform', ids: ['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002'], center: [0, 0], delta: [.1, 0], scale: 1, angle: 0 });
  const next = result.annotations as InkObject[];
  for (const a of next) for (const p of annotationPoints(a)) {
    assert.ok(p.x >= -1e-9 && p.x <= 600 + 1e-9); assert.ok(p.y >= -1e-9 && p.y <= 900 + 1e-9);
  }
  const factor = next[0].transform.scaleX / ellipse.transform.scaleX;
  assert.ok(factor < 1); near(next[1].transform.scaleX / text.transform.scaleX, factor);
  near(next[0].transform.scaleY / ellipse.transform.scaleY, factor);
  assert.deepEqual(next[0].geometry, ellipse.geometry); assert.deepEqual(next[0].style, ellipse.style);
});

test('invalid commands reject atomically, and create/delete retain unrelated annotations', () => {
  const base = page(), before = structuredClone(base);
  for (const operation of [
    { type: 'style' as const, ids: ['00000000-0000-4000-8000-000000000001'], width: NaN },
    { type: 'style' as const, ids: ['00000000-0000-4000-8000-000000000001'], color: 'red' },
    { type: 'delete' as const, ids: ['missing'] },
    { type: 'delete' as const, ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'] },
    { type: 'delete' as const, ids: ['00000000-0000-4000-8000-000000000003'] },
    { type: 'paste' as const, annotations: [arrow], sourceWidthPt: 600, ids: ['00000000-0000-4000-8000-000000000001'] },
    { type: 'paste' as const, annotations: [arrow], sourceWidthPt: 0, ids: ['new'] },
  ]) assert.throws(() => applyCanonicalInkOperation(base, operation));
  assert.deepEqual(base, before);
  const created = applyCanonicalInkOperation(base, { type: 'create', drafts: [{ id: '00000000-0000-4000-8000-000000000007', kind: 'pen', points: [[.2, .3]], color: '#123456', width: .003 }] });
  assert.deepEqual(created.createdIds, ['00000000-0000-4000-8000-000000000007']); assert.equal(created.changes.length, 1);
  const deleted = applyCanonicalInkOperation({ ...base, annotations: created.annotations }, { type: 'delete', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000007'] });
  assert.deepEqual(deleted.annotations.map(a => a.id), ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002']); assert.equal(deleted.changes.length, 2);
});

test('semantic edits are grouped in the real document session history and survive reload, Undo and Redo', async () => {
  const initial: DocumentSnapshot = { ...structuredClone(fixture.document), pages: [page()] };
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'semantic' }, new EditMemoryDatabase());
  await repository.initialize(initial);
  const session = new DocumentEditSession(repository, initial.id); await session.refresh();
  const token = Symbol('surface'), pageId = initial.pages[0].id; session.claimPage(pageId, token);
  const moved = applyCanonicalInkOperation(initial.pages[0], { type: 'transform', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], center: [.5, .5], scale: 1.1, angle: .2, delta: [.01, 0] });
  assert.equal((await session.editPage(pageId, token, moved.changes)).status, 'applied');
  const styled = applyCanonicalInkOperation(session.getSnapshot().document!.pages[0], { type: 'style', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], color: '#abcdef' });
  await session.editPage(pageId, token, styled.changes);
  const pasted = applyCanonicalInkOperation(session.getSnapshot().document!.pages[0], { type: 'paste', annotations: [arrow, text], sourceWidthPt: 600, ids: ['00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006'] });
  await session.editPage(pageId, token, pasted.changes);
  const reloaded = new DocumentEditSession(repository, initial.id); assert.equal(await reloaded.refresh(), true);
  assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, pasted.annotations);
  await reloaded.undo(); assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, styled.annotations);
  await reloaded.undo(); assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, moved.annotations);
  await reloaded.undo(); assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, initial.pages[0].annotations);
  const again = new DocumentEditSession(repository, initial.id); await again.refresh();
  await again.redo(); await again.redo(); await again.redo();
  assert.deepEqual(again.getSnapshot().document!.pages[0].annotations, pasted.annotations);
});

test('reshape keeps both arrow heads and original transform, and edits tilted canonical box axes', () => {
  const base = page(), stroke = projectInkObject(arrow, base), end = stroke.points[1];
  const result = applyCanonicalInkOperation(base, { type: 'reshape', id: arrow.id, hit: { part: 'handle', index: 1 }, start: end, end: [end[0] + .08, end[1] + .03], keepAspect: false });
  const changed = result.annotations[0] as InkObject;
  assert.equal(changed.geometry.kind, 'arrow');
  if (changed.geometry.kind !== 'arrow' || arrow.geometry.kind !== 'arrow') return;
  assert.equal(changed.geometry.head, 'both'); assert.equal(changed.geometry.preferredHeadLengthPt, arrow.geometry.preferredHeadLengthPt);
  assert.deepEqual(changed.geometry.start, arrow.geometry.start); assert.deepEqual(changed.transform, arrow.transform); assert.deepEqual(changed.style, arrow.style);
  const projected = projectInkObject(changed, base); near(projected.points[1][0], end[0] + .08); near(projected.points[1][1], end[1] + .03);
  for (const kind of ['rect', 'ellipse'] as const) {
    const shape: InkObject = { ...structuredClone(arrow), geometry: { kind, widthPt: 90, heightPt: 60 } };
    const shapePage = page([shape]), view = projectInkObject(shape, shapePage), at = view.points[0];
    const updated = applyCanonicalInkOperation(shapePage, { type: 'reshape', id: shape.id, hit: { part: 'handle', index: 0 }, start: at, end: [at[0] + .03, at[1] + .01], keepAspect: false }).annotations[0] as InkObject;
    assert.equal(updated.geometry.kind, kind); assert.deepEqual(updated.style, shape.style);
    assert.equal(updated.transform.rotationRad, shape.transform.rotationRad); assert.equal(updated.transform.scaleX, shape.transform.scaleX); assert.equal(updated.transform.scaleY, shape.transform.scaleY);
    const fixedIndex = kind === 'rect' ? 2 : 32;
    const next = projectInkObject(updated, shapePage);
    near(next.points[fixedIndex][0], view.points[fixedIndex][0]); near(next.points[fixedIndex][1], view.points[fixedIndex][1]);
  }
});

test('text editing preserves font, style and transform, while new edge text fits without clipping', () => {
  const base = page(), operation = { type: 'text' as const, id: text.id, text: 'Changed\n本文', at: [.9, .9] as [number, number], color: '#ffffff', width: .08 };
  const changed = applyCanonicalInkOperation(base, operation).annotations[2] as InkObject;
  assert.equal(changed.geometry.kind, 'text');
  if (changed.geometry.kind !== 'text' || text.geometry.kind !== 'text') return;
  assert.equal(changed.geometry.fontFamily, text.geometry.fontFamily); assert.equal(changed.geometry.fontSizePt, text.geometry.fontSizePt);
  assert.deepEqual(changed.transform, text.transform); assert.deepEqual(changed.style, text.style);
  assert.equal(changed.geometry.text, operation.text); assert.equal(changed.geometry.heightPt, 52);
  assert.deepEqual(applyCanonicalInkOperation(base, { ...operation, text: text.geometry.text }).changes, []);
  const created = applyCanonicalInkOperation(base, { ...operation, id: '10000000-0000-4000-8000-000000000001', at: [1, 1] });
  const added = created.annotations[created.annotations.length - 1] as InkObject;
  assert.deepEqual(created.createdIds, [added.id]);
  for (const p of annotationPoints(added)) assert.ok(p.x >= -1e-9 && p.x <= base.widthPt + 1e-9 && p.y >= -1e-9 && p.y <= base.heightPt + 1e-9);
  assert.throws(() => applyCanonicalInkOperation(base, { ...operation, id: arrow.id }));
  assert.throws(() => applyCanonicalInkOperation(base, { ...operation, text: '   ' }));
});

const pathInk: InkObject = { ...structuredClone(arrow), id: '20000000-0000-4000-8000-000000000001', geometry: { kind: 'path', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] },
  style: { ...arrow.style, highlighter: true, opacity: .47 }, transform: { x: 100, y: 150, rotationRad: .25, scaleX: 1.3, scaleY: .6 } };
const eraseSeed = '30000000-0000-4000-8000-000000000001';
function erasing(base: Page) {
  const center = transformInkPoint(pathInk, { x: 150, y: 0 });
  return { type: 'erase' as const, path: [[center.x / base.widthPt, center.y / base.heightPt]] as [number, number][], radius: .02, partial: true, highlightOnly: false, fragmentIdSeed: eraseSeed };
}

test('partial erase deterministically splits in local coordinates and places fragments at original stacking position', () => {
  const base = page([pathInk, sticky, text]), before = structuredClone(base), operation = erasing(base);
  const result = applyCanonicalInkOperation(base, operation);
  assert.deepEqual(base, before); assert.deepEqual(result, applyCanonicalInkOperation(base, operation));
  assert.deepEqual(result.annotations.map(a => a.id), [pathInk.id, eraseSeed, sticky.id, text.id]);
  assert.deepEqual(result.createdIds, [eraseSeed]); assert.equal(result.changes[result.changes.length - 1]?.type, 'order');
  for (const fragment of result.annotations.slice(0, 2) as InkObject[]) {
    assert.deepEqual(fragment.transform, pathInk.transform); assert.deepEqual(fragment.style, pathInk.style);
    assert.equal(fragment.geometry.kind, 'path');
    if (fragment.geometry.kind === 'path') for (const point of fragment.geometry.points) near(point.y, 0);
  }
  const first = result.annotations[0] as InkObject, second = result.annotations[1] as InkObject;
  if (first.geometry.kind !== 'path' || second.geometry.kind !== 'path') return;
  assert.deepEqual(first.geometry.points[0], { x: 0, y: 0 }); assert.deepEqual(second.geometry.points[second.geometry.points.length - 1], { x: 300, y: 0 });
  assert.ok(first.geometry.points[first.geometry.points.length - 1].x < 150); assert.ok(second.geometry.points[0].x > 150);
  assert.throws(() => applyCanonicalInkOperation(base, { ...operation, fragmentIdSeed: sticky.id }));
  const nonHigh = { ...pathInk, style: { ...pathInk.style, highlighter: false } };
  assert.deepEqual(applyCanonicalInkOperation(page([nonHigh]), { ...operation, highlightOnly: true }).changes, []);
  assert.deepEqual(applyCanonicalInkOperation(base, { ...operation, partial: false }).annotations.map(a => a.id), [sticky.id, text.id]);
});

test('erase stacking order, reshape and text are atomic history entries through durable reload and full Undo/Redo', async () => {
  const initial: DocumentSnapshot = { ...structuredClone(fixture.document), pages: [page([pathInk, arrow, sticky, text])] };
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'semantic-expanded' }, new EditMemoryDatabase());
  await repository.initialize(initial);
  const session = new DocumentEditSession(repository, initial.id); await session.refresh();
  const token = Symbol('surface'), pageId = initial.pages[0].id; session.claimPage(pageId, token);
  const erased = applyCanonicalInkOperation(initial.pages[0], erasing(initial.pages[0]));
  await session.editPage(pageId, token, erased.changes);
  assert.deepEqual(session.getSnapshot().document!.pages[0].annotations, erased.annotations);
  const end = projectInkObject(arrow, initial.pages[0]).points[1];
  const reshaped = applyCanonicalInkOperation(session.getSnapshot().document!.pages[0], { type: 'reshape', id: arrow.id, hit: { part: 'handle', index: 1 }, start: end, end: [end[0] + .04, end[1]], keepAspect: false });
  await session.editPage(pageId, token, reshaped.changes);
  const edited = applyCanonicalInkOperation(session.getSnapshot().document!.pages[0], { type: 'text', id: text.id, text: 'After', at: [0, 0], color: '#ffffff', width: .02 });
  await session.editPage(pageId, token, edited.changes);
  const reloaded = new DocumentEditSession(repository, initial.id); await reloaded.refresh();
  assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, edited.annotations);
  await reloaded.undo(); assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, reshaped.annotations);
  await reloaded.undo(); assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, erased.annotations);
  await reloaded.undo(); assert.deepEqual(reloaded.getSnapshot().document!.pages[0].annotations, initial.pages[0].annotations);
  const again = new DocumentEditSession(repository, initial.id); await again.refresh();
  await again.redo(); await again.redo(); await again.redo();
  assert.deepEqual(again.getSnapshot().document!.pages[0].annotations, edited.annotations);
});

test('a rotated ellipse handle stops at its true page extent without translating its fixed end or scaling its width', () => {
  const ellipse: InkObject = { ...structuredClone(arrow), geometry: { kind: 'ellipse', widthPt: 200, heightPt: 100 },
    transform: { x: 350, y: 100, rotationRad: .327, scaleX: 1.2, scaleY: .7 } };
  const base = page([ellipse]), projected = projectInkObject(ellipse, base);
  const result = applyCanonicalInkOperation(base, { type: 'reshape', id: ellipse.id, hit: { part: 'handle', index: 0 }, start: projected.points[0], end: [1, .8], keepAspect: false });
  const changed = result.annotations[0] as InkObject, next = projectInkObject(changed, base);
  near(next.points[32][0], projected.points[32][0]); near(next.points[32][1], projected.points[32][1]);
  assert.deepEqual(changed.style, ellipse.style);
  assert.equal(changed.transform.scaleX, ellipse.transform.scaleX); assert.equal(changed.transform.scaleY, ellipse.transform.scaleY);
  const maximum = Math.max(...annotationPoints(changed).map(point => point.x));
  assert.ok(maximum <= base.widthPt + 1e-8); assert.ok(maximum > base.widthPt - 1e-6);
});

test('repeated eraser samples do not change fragments, local geometry or generated IDs', () => {
  const base = page([pathInk, sticky, text]), operation = erasing(base);
  const expected = applyCanonicalInkOperation(base, operation);
  const repeated = applyCanonicalInkOperation(base, { ...operation, path: Array.from({ length: 2000 }, () => operation.path[0]) });
  assert.deepEqual(repeated, expected);
});
