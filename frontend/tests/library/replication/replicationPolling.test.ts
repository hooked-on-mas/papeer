import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { startReplicationPolling } from '../../../src/features/library/replication/replicationPolling.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('a long periodic pass schedules the next delay from completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const held = gate(); let calls = 0, running = false;
  const stop = startReplicationPolling(() => running, () => { calls++; running = true; return held.promise.finally(() => { running = false; }); }); t.after(stop);
  t.mock.timers.tick(3000); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(3000); await settle(); t.mock.timers.tick(3000); await settle();
  t.mock.timers.tick(2900); held.resolve(); await settle();
  t.mock.timers.tick(100); await settle(); assert.equal(calls, 1, 'no immediate pass at 12 seconds');
  t.mock.timers.tick(2899); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2); stop();
});

test('queued tail remains busy after a joined pass and readmission uses the current replica', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const held = gate(); let replica = { running: false }, calls = 0, reads = 0;
  const stop = startReplicationPolling(() => { reads++; return replica.running; }, () => { calls++; return held.promise; }); t.after(stop);
  t.mock.timers.tick(3000); await settle(); assert.equal(calls, 1);
  replica.running = true; held.resolve(); await settle();
  t.mock.timers.tick(3000); await settle(); assert.equal(calls, 1, 'queued tail is still busy');
  replica = { running: false }; t.mock.timers.tick(3000); await settle();
  assert.equal(calls, 2, 'readmitted idle replica permits the next pass'); assert.equal(reads, 3); stop();
});

test('stop before first tick and between tick and microtask prevents synchronization', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let calls = 0;
  const stopBefore = startReplicationPolling(() => false, async () => { calls++; }); t.after(stopBefore);
  stopBefore(); t.mock.timers.tick(3000); await settle(); assert.equal(calls, 0);
  const stopAfterTick = startReplicationPolling(() => false, async () => { calls++; }); t.after(stopAfterTick);
  t.mock.timers.tick(3000); stopAfterTick(); await settle(); t.mock.timers.tick(3000); await settle(); assert.equal(calls, 0);
});

test('a rejected pass retries after a bounded delay and stopping prevents rearm', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const held = gate(); let calls = 0;
  const stop = startReplicationPolling(() => false, () => { calls++; return calls === 1 ? Promise.reject(new Error('offline')) : held.promise; }); t.after(stop);
  t.mock.timers.tick(3000); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(2999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  stop(); held.resolve(); await settle(); t.mock.timers.tick(10000); await settle(); assert.equal(calls, 2);
});
