import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfSelectionKeyIntent, pdfSelectionHandleVisible, routeReaderSelectionKey, type ReaderSelectionKeyPort } from '../../../src/features/reader/input/readerSelectionKeys.ts';
const baseline = { started: false, target: 'body' as const, contact: false, current: true,
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
test('unstarted body gives arrows to Reader and only plain Enter starts selection', () => {
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'ArrowRight' }), 'pass');
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'Enter' }), 'start');
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'Enter', shiftKey: true }), 'blocked');
});
test('started body owns movement refusals, stale token and contact without Reader fallback', () => {
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.equal(pdfSelectionKeyIntent({ ...baseline, key, started: true, contact: true }), 'blocked');
    assert.equal(pdfSelectionKeyIntent({ ...baseline, key, started: true, current: false }), 'blocked');
    assert.equal(pdfSelectionKeyIntent({ ...baseline, key, started: true, altKey: true }), 'blocked');
  }
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'PageDown', started: true }), 'blocked');
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'ArrowRight', started: true, shiftKey: true }), 'move');
});
test('toolbar/form focus releases selection key ownership; Ctrl/Cmd+C reaches native copy event', () => {
  for (const key of ['ArrowLeft', 'Home', 'Enter', 'Escape'])
    assert.equal(pdfSelectionKeyIntent({ ...baseline, key, started: true, target: 'other' }), 'pass');
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'c', started: true, ctrlKey: true }), 'pass');
  assert.equal(pdfSelectionKeyIntent({ ...baseline, key: 'C', started: true, metaKey: true }), 'pass');
});
test('blocked and handled close the sole bubble route; a repeated notification cannot execute twice', () => {
  for (const result of ['blocked', 'handled'] as const) {
    let calls = 0, prevents = 0, fallbacks = 0, prevented = false;
    const event = { get defaultPrevented() { return prevented; }, preventDefault() { prevents++; prevented = true; } } as KeyboardEvent;
    const port: ReaderSelectionKeyPort = { handleKey() { calls++; return result; } };
    if (!routeReaderSelectionKey(event, port)) fallbacks++;
    if (!routeReaderSelectionKey(event, port)) fallbacks++;
    assert.equal(calls, 1); assert.equal(prevents, 1); assert.equal(fallbacks, 0);
  }
});
test('pass preserves button/native-copy behavior and ordinary Reader route', () => {
  let prevented = false;
  const event = { defaultPrevented: false, preventDefault() { prevented = true; } } as KeyboardEvent;
  assert.equal(routeReaderSelectionKey(event, { handleKey: () => 'pass' }), false);
  assert.equal(prevented, false);
});
test('endpoint equality retains the focused handle and its following key cannot reach Reader', () => {
  for (const endpoint of ['anchor', 'focus'] as const) {
    assert.equal(pdfSelectionHandleVisible(endpoint, true, endpoint), true);
    assert.equal(pdfSelectionHandleVisible(endpoint === 'anchor' ? 'focus' : 'anchor', true, endpoint), false);
    assert.equal(pdfSelectionKeyIntent({ ...baseline, started: true, target: 'handle', key: 'ArrowRight' }), 'move');
    assert.equal(pdfSelectionKeyIntent({ ...baseline, started: true, target: 'handle', key: 'Escape' }), 'clear');
    assert.equal(pdfSelectionKeyIntent({ ...baseline, started: true, target: 'handle', key: 'PageDown' }), 'blocked');
  }
  assert.equal(pdfSelectionHandleVisible('anchor', true, null), false);
  assert.equal(pdfSelectionHandleVisible('focus', false, null), true);
});
