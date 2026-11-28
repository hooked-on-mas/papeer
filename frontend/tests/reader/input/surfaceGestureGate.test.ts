import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SurfaceGestureGate } from '../../../src/features/reader/input/surfaceGestureGate.ts';

test('surface selection consumes all fingers through the final up or cancel', () => {
  const gate = new SurfaceGestureGate();
  assert.equal(gate.down(1), false);
  gate.begin(1);
  assert.equal(gate.down(2), true);
  assert.equal(gate.end(1), true);
  assert.equal(gate.owns(2), true);
  assert.equal(gate.down(3), true);
  assert.equal(gate.end(2), true);
  assert.equal(gate.end(3), true);
  assert.equal(gate.down(4), false);
});

test('unrelated active pointers remain untouched and disposal clears ownership', () => {
  const gate = new SurfaceGestureGate(); gate.begin(7);
  assert.equal(gate.owns(6), false); assert.equal(gate.end(6), false);
  assert.equal(gate.owns(7), true);
  gate.clear(); assert.equal(gate.owns(7), false); assert.equal(gate.down(8), false);
});
