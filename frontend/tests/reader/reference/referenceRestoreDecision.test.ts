import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeBeforeReferenceResize, referenceReportCurrent, referenceRestoreDecision, referenceInputReady, referenceGestureContinues, referenceDrawSettled, referenceTouchAdmission, type ReferenceRestoreIntent } from '../../../src/features/reader/reference/referenceRestoreDecision.ts';
import { scrollDeltaForZoomAnchor, scrollForPlace } from '../../../src/features/reader/navigation/readingPlace.ts';

const saved = { x: .4, y: .6 };
const anchor = { x: .7, y: .3, atX: 350, atY: 140 };
const latest = { x: .2, y: .8, atX: 120, atY: 420 };
const view = { scrollTop: 0, scrollLeft: 0, clientWidth: 400, clientHeight: 500, page: { left: 0, top: 0, width: 800, height: 1000 } };

test('resize captures native offsets before a deferred scroll notification using old viewport geometry', () => {
  const before = { ...view, scrollTop: 100, scrollLeft: 40 };
  // The new viewport dimensions are deliberately absent: its center must not replace the old one.
  assert.deepEqual(placeBeforeReferenceResize({ x: .3, y: .1 }, before,
    { top: 350, left: 120, maxTop: 900, maxLeft: 700 }), { x: .4, y: .35 });
});

test('layout clamps retain the held axis while another native scroll is still captured', () => {
  const before = { ...view, scrollTop: 800, scrollLeft: 600 };
  assert.deepEqual(placeBeforeReferenceResize({ x: 1, y: .8 }, before,
    { top: 500, left: 500, maxTop: 500, maxLeft: 700 }), { x: .875, y: .8 });
  assert.deepEqual(placeBeforeReferenceResize({ x: 1, y: .8 }, before,
    { top: 400, left: 300, maxTop: 600, maxLeft: 300 }), { x: 1, y: .4 });
});

test('missing geometry, invalid offsets and unchanged scroll cannot replace held reference place', () => {
  const live = { top: 0, left: 0, maxTop: 500, maxLeft: 400 };
  assert.equal(placeBeforeReferenceResize(saved, null, live), saved);
  assert.equal(placeBeforeReferenceResize(null, view, live), null);
  assert.equal(placeBeforeReferenceResize(saved, view, live), saved);
  assert.equal(placeBeforeReferenceResize(saved, view, { ...live, top: NaN }), saved);
});

test('initial, remount and resize place intents wait for proof and consume once', () => {
  for (const trigger of ['initial', 'remount', 'resize']) {
    let intent: ReferenceRestoreIntent | null = { kind: 'place', place: saved };
    assert.deepEqual(referenceRestoreDecision(intent, false), { apply: 'none', consume: false }, trigger);
    const ready = referenceRestoreDecision(intent, true);
    assert.equal(ready.apply, 'place', trigger);
    assert.deepEqual(scrollForPlace(saved, view), { top: 600, left: 120 });
    if (ready.consume) intent = null;
    assert.deepEqual(referenceRestoreDecision(intent, true), { apply: 'none', consume: false }, trigger);
  }
});

test('latest explicit anchor replaces older place and anchor, sharp does not restore old place', () => {
  let intent: ReferenceRestoreIntent | null = { kind: 'place', place: saved };
  intent = { kind: 'zoom', anchor };
  intent = { kind: 'zoom', anchor: latest };
  const preview = referenceRestoreDecision(intent, false);
  assert.deepEqual(preview, { apply: 'anchor', consume: false });
  assert.deepEqual(scrollDeltaForZoomAnchor(latest, { left: 10, top: 20, width: 800, height: 1000 }), { left: 50, top: 400 });
  const sharp = referenceRestoreDecision(intent, true);
  assert.equal(sharp.apply, 'anchor');
  if (sharp.consume) intent = null;
  assert.deepEqual(referenceRestoreDecision(intent, true), { apply: 'none', consume: false });
});

test('old target, pane, producer, zoom and layout cannot report', () => {
  assert.equal(referenceReportCurrent(true, true, true, true, 4, 4), true);
  assert.equal(referenceReportCurrent(false, true, true, true, 4, 4), false);
  assert.equal(referenceReportCurrent(true, false, true, true, 4, 4), false);
  assert.equal(referenceReportCurrent(true, true, false, true, 4, 4), false);
  assert.equal(referenceReportCurrent(true, true, true, false, 4, 4), false);
  assert.equal(referenceReportCurrent(true, true, true, true, 3, 4), false);
});

test('pending draw rejects new input while admitted same lease continues', () => {
  assert.equal(referenceInputReady(true, true, true, false), false);
  assert.equal(referenceInputReady(true, true, false, true), false);
  assert.equal(referenceInputReady(true, true, true, true), true);
  assert.equal(referenceGestureContinues(true, true, true, true), true);
  assert.equal(referenceGestureContinues(false, true, true, true), false);
  assert.equal(referenceGestureContinues(true, false, true, true), false);
  assert.equal(referenceGestureContinues(true, true, false, true), false);
});

test('live binding invalidation immediately blocks new admission but not an admitted lease', () => {
  let current = true; const binding = { isCurrent: () => current };
  assert.equal(referenceDrawSettled(binding, binding, true, true), true);
  current = false;
  assert.equal(referenceDrawSettled(binding, binding, true, true), false);
  assert.equal(referenceInputReady(true, true, true, referenceDrawSettled(binding, binding, true, true)), false);
  assert.equal(referenceGestureContinues(true, true, true, true), true);
});

test('continuation rejects preservation guard changes even when readiness is the only bypass', () => {
  for (const reason of ['scope', 'append', 'navigation', 'deleted', 'drain']) {
    assert.equal(referenceGestureContinues(true, true, true, false), false, reason);
  }
  assert.equal(referenceGestureContinues(true, true, true, true), true);
  assert.equal(referenceInputReady(true, false, true, false), false);
});

test('second touch bypasses readiness only while preservation and same-gesture facts hold', () => {
  assert.equal(referenceTouchAdmission(false, true, true), true);
  assert.equal(referenceTouchAdmission(false, true, false), false);
  assert.equal(referenceTouchAdmission(false, false, true), false);
  assert.equal(referenceTouchAdmission(false, false, false), false);
});
