import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForSnapshot } from '../e2e/support/waitForSnapshot.ts';

test('awaited false observations are polled until true and return the accepted snapshot', async () => {
  let reads = 0;
  const snapshot = await waitForSnapshot(async () => ({ ready: ++reads === 3, reads }), value => value.ready, 1000);
  assert.deepEqual(snapshot, { ready: true, reads: 3 }); assert.equal(reads, 3);
});

test('false times out with evidence and read failures propagate without retry', async () => {
  await assert.rejects(waitForSnapshot(async () => ({ ready: false }), value => value.ready, 0), /snapshot did not settle.*false/);
  const failure = new Error('clipboard-denied'); let reads = 0;
  await assert.rejects(waitForSnapshot(async () => { reads++; throw failure; }, () => true), error => error === failure);
  assert.equal(reads, 1);
  await assert.rejects(waitForSnapshot(() => new Promise<never>(() => {}), () => true, 10), /snapshot read timed out/);
});
