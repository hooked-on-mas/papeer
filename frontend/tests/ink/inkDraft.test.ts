import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceInkDraft, beginInkDraft, finishInkDraft, type DrawingKind } from '../../src/features/ink/inkDraft.ts';
import { boundsOf, type Point } from '../../src/features/ink/inkGeometry.ts';

test('a shape has the same page geometry through coalesced moves or a release-only drag', () => {
  for (const kind of ['line', 'arrow', 'rectangle', 'ellipse'] as const) {
    const start: Point = [.2, .3], end: Point = [.7, .6];
    const draft = beginInkDraft('shape', kind, start, '#112233', .003);
    const moved = advanceInkDraft(draft, start, [[.4, .4], end], 1.5);
    const released = advanceInkDraft(draft, start, [end], 1.5);
    assert.deepEqual(finishInkDraft(moved, 1.5), finishInkDraft(released, 1.5));
    assert.equal(moved.kind, kind);
    assert.equal(moved.points.length, { line: 2, arrow: 5, rectangle: 5, ellipse: 65 }[kind]);
    assert.deepEqual(draft.points, [start], 'updating preview must not mutate an earlier history value');
  }
});

test('Shift makes physical squares and circles even on landscape and portrait pages', () => {
  for (const ratio of [.5, 2]) for (const kind of ['rectangle', 'ellipse'] as const) {
    const start: Point = [.4, .4];
    const draft = advanceInkDraft(beginInkDraft('shape', kind, start, '#112233', .003), start, [[.6, .5]], ratio, { shift: true });
    const box = boundsOf([draft])!;
    assert.ok(Math.abs(box.width - box.height * ratio) < 1e-12);
  }
});

test('taps and zero-area boxes do not create invisible objects; pen dots remain valid', () => {
  for (const kind of ['line', 'arrow', 'rectangle', 'ellipse'] as const) {
    const start: Point = [.2, .3];
    const initial = beginInkDraft('shape', kind, start, '#112233', .003);
    assert.equal(finishInkDraft(initial, 1.5), null);
    assert.equal(finishInkDraft(advanceInkDraft(initial, start, [[.2001, .3001]], 1.5), 1.5), null);
    if (kind === 'rectangle' || kind === 'ellipse') {
      assert.equal(finishInkDraft(advanceInkDraft(initial, start, [[.6, .3]], 1.5), 1.5), null);
    }
  }
  assert.equal(finishInkDraft(beginInkDraft('dot', 'pen', [.2, .3], '#112233', .003), 1.5)?.points.length, 1);
});

test('arrows drawn at page edges stay inside the page and retain their shape', () => {
  const start: Point = [.2, .99];
  const stroke = finishInkDraft(advanceInkDraft(beginInkDraft('arrow', 'arrow', start, '#112233', .003), start, [[.8, .99]], 1), 1)!;
  assert.ok(stroke.points.every(point => point.every(value => value >= 0 && value <= 1)));
  assert.equal(stroke.points[1][1], stroke.points[3][1]);
  assert.equal(stroke.arrowHeadLength, .025);
});

test('long paths preserve their origin and enforce the point budget across coalesced input', () => {
  const start: Point = [0, 0];
  let stroke = beginInkDraft('long', 'pen', start, '#112233', .003);
  const samples: Point[] = Array.from({ length: 21000 }, (_, i) => [i % 2, (i % 3) / 2]);
  stroke = advanceInkDraft(stroke, start, samples, 1);
  assert.equal(stroke.points.length, 20000);
  assert.deepEqual(stroke.points[0], start);
  assert.equal(advanceInkDraft(stroke, start, [[.2, .8]], 1).points.length, 20000);
});

test('straight highlighter is a shared policy, with horizontal Shift constraint', () => {
  const start: Point = [.1, .2], end: Point = [.8, .6];
  for (const kind of ['highlighter'] satisfies DrawingKind[]) {
    const draft = beginInkDraft('highlight', kind, start, '#112233', .02);
    assert.deepEqual(advanceInkDraft(draft, start, [end], 2, { straightHighlighter: true }).points, [start, end]);
    assert.deepEqual(advanceInkDraft(draft, start, [end], 2, { shift: true }).points, [start, [.8, .2]]);
  }
});
