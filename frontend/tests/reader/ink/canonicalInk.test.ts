import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inkObjectFromDraft, projectInkObject } from '../../../src/features/reader/ink/canonicalInk.ts';
import { advanceInkDraft, beginInkDraft, finishInkDraft } from '../../../src/features/ink/inkDraft.ts';
import { textPoints, type InkStroke } from '../../../src/features/ink/inkGeometry.ts';
import { transformInkPoint } from '../../../src/runtime/edits/annotationGeometry.ts';

const page = { widthPt: 600, heightPt: 900 };
test('new completed gestures construct all seven canonical kinds without changing their geometry', () => {
  const drafts: InkStroke[] = ['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse'].map(kind =>
    finishInkDraft(advanceInkDraft(beginInkDraft(kind, kind as Parameters<typeof beginInkDraft>[1], [.2, .3], '#123456', .003), [.2, .3], [[.7, .6]], 1.5), 1.5)!);
  drafts.push({ id: 'text', kind: 'text', color: '#123456', width: .003, text: 'Hello\n世界', points: textPoints('Hello\n世界', [.2, .3], .02, 1.5) });
  for (const draft of drafts) {
    const before = structuredClone(draft), annotation = inkObjectFromDraft(draft, page), projected = projectInkObject(annotation, page);
    assert.equal(annotation.id, draft.id);
    assert.equal(projected.kind, draft.kind);
    assert.equal(projected.points.length, draft.points.length);
    projected.points.forEach((p, i) => p.forEach((value, j) => assert.ok(Math.abs(value - draft.points[i][j]) < 1e-10)));
    assert.deepEqual(draft, before);
  }
});

test('projection keeps transformed arrow shaft handles first and never mutates canonical attributes', () => {
  const annotation = inkObjectFromDraft(finishInkDraft(advanceInkDraft(beginInkDraft('arrow', 'arrow', [.2, .3], '#123456', .003), [.2, .3], [[.7, .6]], 1.5), 1.5)!, page);
  assert.equal(annotation.geometry.kind, 'arrow');
  if (annotation.geometry.kind !== 'arrow') return;
  annotation.geometry.head = 'both'; annotation.geometry.preferredHeadLengthPt = 50;
  annotation.style.opacity = .71;
  annotation.transform = { x: 12, y: 34, rotationRad: .7, scaleX: 1.2, scaleY: .6 };
  const before = structuredClone(annotation), projected = projectInkObject(annotation, page);
  [annotation.geometry.start, annotation.geometry.end].forEach((p, i) => {
    const expected = transformInkPoint(annotation, p);
    assert.deepEqual(projected.points[i], [expected.x / page.widthPt, expected.y / page.heightPt]);
  });
  assert.equal(projected.points.length, 9);
  assert.equal(projected.arrowHeadLength, 50 / 600);
  assert.deepEqual(annotation, before);
});

test('constructor rejects unfinished/degenerate or malformed shapes while accepting a pen dot', () => {
  for (const kind of ['line', 'arrow', 'rectangle', 'ellipse'] as const) {
    assert.throws(() => inkObjectFromDraft(beginInkDraft(kind, kind, [.2, .3], '#123456', .003), page));
  }
  assert.equal(inkObjectFromDraft(beginInkDraft('dot', 'pen', [.2, .3], '#123456', .003), page).geometry.kind, 'path');
  const arrow = advanceInkDraft(beginInkDraft('a', 'arrow', [.2, .3], '#123456', .003), [.2, .3], [[.7, .6]], 1.5);
  arrow.points[4][0] += .01;
  assert.throws(() => inkObjectFromDraft(arrow, page));
});
