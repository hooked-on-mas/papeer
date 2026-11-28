import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDF_TEXT_HOLD_MS, decidePdfTextPending, movePdfTextPending, drainPdfPointerContacts,
  pdfContactTerminalEffect, settlePdfPointerContact, beginPdfLongPressMotion, observePdfLongPressMotion, movePdfTextPointerSelection, pdfHandleMotion, pdfHandleMovePoint, observePdfHandleMotion,
  type PdfPointerPhase, type PdfTextPending } from '../../../src/features/reader/pdf/pdfTextGesture.ts';

const pending = (): PdfTextPending => ({ startX: 10, startY: 20, x: 10, y: 20, maxDistance: 0, deadline: 100 + PDF_TEXT_HOLD_MS });
test('handle grab offset follows the actual two-dimensional caret and preserves no-motion up', () => {
  for (const down of [{ x: 90, y: 130 }, { x: 110, y: 145 }]) {
    const motion = pdfHandleMotion([{ left: 100, top: 100, width: 0, height: 20 }], down);
    assert.ok(motion); assert.equal(pdfHandleMovePoint(motion, down), null);
    const moved = observePdfHandleMotion(motion, { x: down.x + 12, y: down.y - 3 });
    assert.deepEqual(pdfHandleMovePoint(moved, { x: down.x + 12, y: down.y - 3 }), { x: 112, y: 107 });
    const returned = observePdfHandleMotion(moved, down);
    assert.deepEqual(pdfHandleMovePoint(returned, down), { x: 100, y: 110 });
    assert.deepEqual(pdfHandleMovePoint(observePdfHandleMotion(returned, down), down), { x: 100, y: 110 });
    assert.deepEqual(pdfHandleMovePoint(observePdfHandleMotion(motion, { x: down.x + 1, y: down.y }), { x: down.x + 1, y: down.y }), { x: 101, y: 110 });
  }
  const rotated = pdfHandleMotion([{ left: 20, top: 30, width: 10, height: 0 }], { x: 25, y: 40 });
  assert.ok(rotated); assert.deepEqual(pdfHandleMovePoint(observePdfHandleMotion(rotated, { x: 26, y: 41 }), { x: 26, y: 41 }), { x: 26, y: 31 });
});
test('handle admission rejects missing, invalid and ambiguous caret rectangles', () => {
  assert.equal(pdfHandleMotion([], { x: 1, y: 1 }), null);
  assert.equal(pdfHandleMotion([{ left: 1, top: 1, width: 0, height: 0 }], { x: 1, y: 1 }), null);
  assert.equal(pdfHandleMotion([{ left: NaN, top: 1, width: 1, height: 1 }], { x: 1, y: 1 }), null);
  assert.equal(pdfHandleMotion([{ left: 1, top: 1, width: 1, height: 1 }, { left: 2, top: 1, width: 1, height: 1 }], { x: 1, y: 1 }), null);
});
test('the 450ms deadline and 8 CSS px slop share a one-shot distance decision', () => {
  assert.equal(decidePdfTextPending(pending(), 549), 'pending');
  assert.equal(decidePdfTextPending(movePdfTextPending(pending(), 18, 20), 550), 'select');
  assert.equal(decidePdfTextPending(movePdfTextPending(pending(), 18.001, 20), 549), 'pan');
});
test('a delayed timer cannot reinterpret an observed out-and-back pan as a long press', () => {
  const moved = movePdfTextPending(pending(), 30, 20);
  const returned = movePdfTextPending(moved, 10, 20);
  assert.equal(returned.maxDistance, 20);
  assert.equal(decidePdfTextPending(returned, 1000), 'pan');
});
test('window terminal, synchronous lostcapture and later React up finish once', () => {
  const inventory = new Map([[7, { ending: false }]]);
  let ends = 0;
  assert.equal(settlePdfPointerContact(inventory, 7, () => {
    ends++;
    assert.equal(settlePdfPointerContact(inventory, 7, () => { ends++; }), false);
    assert.equal(inventory.has(7), true, 'contact stays counted while terminal semantics execute');
  }), true);
  assert.equal(settlePdfPointerContact(inventory, 7, () => { ends++; }), false);
  assert.equal(ends, 1); assert.equal(inventory.size, 0);
});
test('terminal cleanup still removes the exact contact when a callback rejects', () => {
  const inventory = new Map([[3, { ending: false }], [4, { ending: false }]]);
  assert.throws(() => settlePdfPointerContact(inventory, 3, () => { throw new Error('refused'); }));
  assert.equal(inventory.has(3), false); assert.equal(inventory.has(4), true);
});
test('pinch transition drains the remaining and later-added finger until all up', () => {
  const inventory = new Map<number, { ending: boolean; phase: PdfPointerPhase; pending: boolean }>([
    [1, { ending: false, phase: 'pinch', pending: false }], [2, { ending: false, phase: 'pinch', pending: false }],
  ]);
  let draining = false;
  settlePdfPointerContact(inventory, 1, contact => {
    const effect = pdfContactTerminalEffect(contact.phase, 'pointerup');
    assert.equal(effect.drain, true); assert.equal(effect.maySwipe, false);
    draining = effect.drain;
    drainPdfPointerContacts(inventory, item => { item.pending = false; });
  });
  inventory.set(3, { ending: false, phase: draining ? 'drain' : 'raw', pending: false });
  assert.equal(inventory.get(2)?.phase, 'drain'); assert.equal(inventory.get(3)?.phase, 'drain');
  for (const id of [2, 3]) settlePdfPointerContact(inventory, id, contact => {
    assert.equal(pdfContactTerminalEffect(contact.phase, 'pointerup').maySwipe, false);
  });
  assert.equal(inventory.size, 0);
});
test('pending tap, pointercancel and lostcapture never commit a selection or swipe', () => {
  assert.deepEqual(pdfContactTerminalEffect('text-pending', 'pointerup'), { clear: true, finishSelection: false, drain: false, maySwipe: false });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    for (const phase of ['text-selecting', 'pan', 'pinch'] as const) {
      const effect = pdfContactTerminalEffect(phase, type);
      assert.equal(effect.clear, true); assert.equal(effect.finishSelection, false);
      assert.equal(effect.drain, true); assert.equal(effect.maySwipe, false);
    }
  }
});
test('timer-first long press preserves the whole word through same-position move and up', () => {
  let selected = 'whole word', moves = 0;
  const port = { move() { moves++; selected = 'short'; return true; } };
  const point = { x: 10, y: 20 };
  let motion = beginPdfLongPressMotion(point);
  for (const sample of [point, point]) { // unchanged pointermove, then native pointerup
    motion = observePdfLongPressMotion(motion, sample);
    assert.equal(movePdfTextPointerSelection(port, sample, 'focus', motion), false);
  }
  assert.equal(selected, 'whole word'); assert.equal(moves, 0);
});
test('deadline resolved by move/up initializes extension after pending slop, not before it', () => {
  for (const terminal of ['pointermove', 'pointerup']) {
    const last = movePdfTextPending(pending(), 16, 20);
    assert.equal(decidePdfTextPending(last, 550), 'select', terminal);
    // This sample selected the word; applying that same sample as extension is forbidden.
    const motion = beginPdfLongPressMotion(last);
    let moves = 0;
    assert.equal(movePdfTextPointerSelection({ move() { moves++; return true; } }, last, 'focus', motion), false);
    assert.equal(moves, 0, terminal);
  }
});
test('pre-hold out-and-back inside slop does not count as movement of the selected word', () => {
  const out = movePdfTextPending(pending(), 17, 20), back = movePdfTextPending(out, 10, 20);
  assert.equal(decidePdfTextPending(back, 550), 'select');
  const motion = observePdfLongPressMotion(beginPdfLongPressMotion(back), back);
  let moves = 0;
  movePdfTextPointerSelection({ move() { moves++; return true; } }, back, 'focus', motion);
  assert.equal(moves, 0);
});
test('actual post-hold movement extends, and returning to the hold point remains a drag', () => {
  const origin = { x: 10, y: 20 }, extended = { x: 110, y: 20 };
  let motion = beginPdfLongPressMotion(origin);
  const seen: number[] = [];
  const port = { move(point: { x: number }) { seen.push(point.x); return true; } };
  motion = observePdfLongPressMotion(motion, extended);
  assert.equal(movePdfTextPointerSelection(port, extended, 'focus', motion), true);
  motion = observePdfLongPressMotion(motion, origin);
  assert.equal(movePdfTextPointerSelection(port, origin, 'focus', motion), true);
  assert.deepEqual(seen, [110, 10]);
  // Direct mouse/pen and handle drags have no long-press guard.
  assert.equal(movePdfTextPointerSelection(port, origin, 'anchor', null), true);
});


test('handle out-and-back restores its logical origin instead of assuming an inverse DOM hit-test', () => {
  for (const inverse of ['unsupported', 'different-logical'] as const) for (const endpoint of ['anchor', 'focus'] as const) {
    const down = { x: 90, y: 130 }, origin = 14;
    let logical = origin, hitTests = 0, restored = 0, currentLifetime = true, sameGeometry = true;
    const base = pdfHandleMotion([{ left: 100, top: 100, width: 0, height: 20 }], down); assert.ok(base);
    const start = { ...base, restoreOrigin: (actualEndpoint: typeof endpoint) => {
      if (!currentLifetime || !sameGeometry || actualEndpoint !== endpoint) return false;
      restored++; logical = origin; return true;
    } };
    const port = { move(point: { x: number; y: number }) {
      hitTests++;
      // r74 returned a non-Text/out-of-layer caret at the original pixel: refuse
      // the hit-test and keep the last supported selection. Also cover a wrong offset.
      if (point.x === 100 && inverse === 'unsupported') return false;
      logical = point.x === 100 ? 16 : inverse === 'unsupported' ? 16 : 18; return true;
    } };
    const outward = { x: down.x + 12, y: down.y }, moved = observePdfHandleMotion(start, outward);
    const outPoint = pdfHandleMovePoint(moved, outward); assert.ok(outPoint);
    assert.equal(movePdfTextPointerSelection(port, outPoint, endpoint, null, { motion: moved, point: outward }), true);
    assert.equal(logical, inverse === 'unsupported' ? 16 : 18); assert.equal(hitTests, 1); assert.equal(restored, 0, 'non-origin still uses the ordinary DOM move');
    const returned = observePdfHandleMotion(moved, down), originPoint = pdfHandleMovePoint(returned, down); assert.ok(originPoint);
    const returnedResult = movePdfTextPointerSelection(port, originPoint, endpoint, null, { motion: returned, point: down });
    assert.equal(logical, origin, inverse);
    assert.equal(returnedResult, true); assert.equal(hitTests, 1); assert.equal(restored, 1);
    // Pointerup at that same point cannot re-hit the DOM and extend the selection again.
    assert.equal(movePdfTextPointerSelection(port, originPoint, endpoint, null, { motion: returned, point: down }), true);
    assert.equal(logical, origin); assert.equal(hitTests, 1); assert.equal(restored, 2);
    sameGeometry = false;
    assert.equal(movePdfTextPointerSelection(port, originPoint, endpoint, null, { motion: returned, point: down }), false);
    assert.equal(hitTests, 1); assert.equal(restored, 2, 'a geometry refusal never falls back to hit-testing');
    sameGeometry = true;
    currentLifetime = false;
    assert.equal(movePdfTextPointerSelection(port, originPoint, endpoint, null, { motion: returned, point: down }), false);
    assert.equal(hitTests, 1); assert.equal(restored, 2, 'a rejected old lifetime never falls back to hit-testing');
  }
});

test('origin restoration leaves no-motion, long-press and physical cancellation behavior unchanged', () => {
  for (const inverse of ['unsupported', 'different-logical'] as const) {
  const down = { x: 90, y: 130 }, base = pdfHandleMotion([{ left: 100, top: 100, width: 0, height: 20 }], down); assert.ok(base);
  let restored = 0, moved = 0;
  const motion = { ...base, restoreOrigin: () => { restored++; return true; } }, port = { move() { moved++; return inverse === 'different-logical'; } };
  assert.equal(pdfHandleMovePoint(motion, down), null, 'an unmoved click still supplies no move');
  const returned = observePdfHandleMotion(observePdfHandleMotion(motion, { x: down.x + 12, y: down.y }), down);
  assert.equal(movePdfTextPointerSelection(port, { x: 100, y: 110 }, 'focus', beginPdfLongPressMotion(down),
    { motion: returned, point: down }), false, 'the existing unextended long-press guard remains first');
  assert.equal(restored, 0); assert.equal(moved, 0);
  assert.deepEqual(pdfContactTerminalEffect('text-selecting', 'pointercancel'),
    { clear: true, finishSelection: false, drain: true, maySwipe: false });
  }
});
