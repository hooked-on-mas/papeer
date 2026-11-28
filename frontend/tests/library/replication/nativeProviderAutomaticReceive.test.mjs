import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopProviderOwner } from '../../../src/adapters/desktop/provider/providerOwner.ts';
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const idle = { running: false, suspended: false, error: '' };

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], pending = [], revoked = [];
  const bridge = {
    async call(route, body, signal, grant, admission) {
      const name = route.split('/').at(-1);
      if (name === 'connect') return {};
      if (name === 'status' && !route.includes('/replication/')) return { connecting: false };
      if (name === 'finish-connect') return { leaseId: 'lease', operationId: 'operation' };
      if (name === 'open') { assert.equal(admission, 'private-admission'); assert.equal(grant.active, true); return { replicationId: 'private-replication' }; }
      if (name === 'suspend') { calls.push(name); return { ...idle, suspended: true }; }
      if (name === 'resume' || name === 'flush') {
        assert.equal(grant.active, true); calls.push(name);
        return new Promise((resolve, reject) => pending.push({ resolve, reject, name }));
      }
      throw new Error('unexpected ' + route);
    },
    admission: () => 'private-admission', revoke: grant => revoked.push(grant),
    disconnect: async () => {}, cancelAttempt: async () => {},
    resumeRetained: async () => {}, settleResume: async () => {}, discardResumed: async () => {}, installed: value => value,
  };
  const owner = createDesktopProviderOwner(bridge), signal = new AbortController().signal;
  const grant = await owner.connect(signal), replication = await owner.openReplication(grant, { scope: {} }, signal);
  t.after(async () => { for (const item of pending) item.resolve(idle); await replication.suspendAndWait().catch(() => {}); });
  return { owner, grant, replication, calls, pending, revoked, signal };
}

test('no view: only resume starts automatic receive, at five seconds after completion', async t => {
  const f = await fixture(t);
  t.mock.timers.tick(15000); await settle(); assert.deepEqual(f.calls, []);
  const first = f.replication.resume(); await settle(); assert.deepEqual(f.calls, ['resume']);
  f.pending[0].resolve(idle); await first; await settle();
  t.mock.timers.tick(4999); await settle(); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1); await settle(); assert.deepEqual(f.calls, ['resume', 'flush']);
  f.pending[1].resolve(idle); await settle();
});

test('automatic timer waits through active pass and the queued durable tail', async t => {
  const f = await fixture(t), first = f.replication.resume(); await settle();
  const joined = f.replication.flush(); assert.equal(joined, first);
  t.mock.timers.tick(20000); await settle(); assert.equal(f.calls.length, 1);
  f.pending[0].resolve(idle); await first; await settle(); assert.equal(f.calls.length, 2);
  t.mock.timers.tick(20000); await settle(); assert.equal(f.calls.length, 2);
  f.pending[1].resolve(idle); await settle();
  t.mock.timers.tick(4999); await settle(); assert.equal(f.calls.length, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(f.calls.length, 3);
  f.pending[2].resolve(idle); await settle();
});

test('automatic errors retry; manual pass replaces the pending deadline', async t => {
  const f = await fixture(t), first = f.replication.resume(); await settle(); f.pending[0].resolve(idle); await first; await settle();
  t.mock.timers.tick(2000); const manual = f.replication.flush(); await settle(); f.pending[1].resolve(idle); await manual; await settle();
  t.mock.timers.tick(3000); await settle(); assert.equal(f.calls.length, 2);
  t.mock.timers.tick(2000); await settle(); assert.equal(f.calls.length, 3);
  f.pending[2].reject(new Error('temporary network')); await settle(); assert.equal(f.replication.getSnapshot().error, 'provider-replication-failed');
  t.mock.timers.tick(5000); await settle(); assert.equal(f.calls.length, 4); f.pending[3].resolve(idle); await settle();
});

test('suspended resume failure retries resume, then invalidation cannot revive old grant', async t => {
  const f = await fixture(t), first = f.replication.resume(); await settle(); f.pending[0].resolve(idle); await first; await settle();
  await f.replication.suspendAndWait();
  const retry = f.replication.resume(), observed = assert.rejects(retry, /temporary network/); await settle();
  f.pending[1].reject(new Error('temporary network')); await observed; await settle();
  t.mock.timers.tick(5000); await settle(); assert.equal(f.pending[2].name, 'resume');
  f.pending[2].resolve(idle); await settle();
  f.owner.invalidateOperation('operation'); assert.equal(f.revoked.length, 1);
  t.mock.timers.tick(30000); await settle(); assert.equal(f.pending.length, 3);
  let returned; assert.doesNotThrow(() => { returned = f.replication.resume(); }); await assert.rejects(returned, /provider-unavailable/);
});

test('suspend prevents late pass from rearming; explicit resume starts a fresh generation', async t => {
  const f = await fixture(t), first = f.replication.resume(); await settle();
  const stop = f.replication.suspendAndWait(); await settle(); f.pending[0].resolve(idle); await Promise.all([first, stop]); await settle();
  t.mock.timers.tick(15000); await settle(); assert.equal(f.pending.length, 1);
  const again = f.replication.resume(); await settle(); f.pending[1].resolve(idle); await again; await settle();
  t.mock.timers.tick(5000); await settle(); assert.equal(f.pending.length, 3); f.pending[2].resolve(idle); await settle();
  await f.replication.suspendAndWait(); t.mock.timers.tick(15000); await settle(); assert.equal(f.pending.length, 3);
});

test('disconnect stops scheduled receive and revoked resume rejects asynchronously', async t => {
  const f = await fixture(t), first = f.replication.resume(); await settle(); f.pending[0].resolve(idle); await first; await settle();
  await f.owner.disconnect(f.grant, f.signal); t.mock.timers.tick(30000); await settle(); assert.equal(f.pending.length, 1);
  let later; assert.doesNotThrow(() => { later = f.replication.resume(); }); await assert.rejects(later, /provider-unavailable/);
});

test('switching grant retires old in-flight work and only the new generation polls', async t => {
  const f = await fixture(t), first = f.replication.resume(), oldResult = assert.rejects(first, /provider-unavailable/); await settle();
  const replacement = await f.owner.connect(f.signal);
  f.pending[0].resolve(idle); await oldResult; await settle();
  t.mock.timers.tick(10000); await settle(); assert.equal(f.pending.length, 1);
  const next = await f.owner.openReplication(replacement, { scope: {} }, f.signal);
  try {
    const resumed = next.resume(); await settle(); f.pending[1].resolve(idle); await resumed; await settle();
    t.mock.timers.tick(5000); await settle(); assert.equal(f.pending.length, 3); f.pending[2].resolve(idle); await settle();
  } finally { await next.suspendAndWait(); }
});

test('three-second view flushes keep the owner timer from adding duplicate passes', async t => {
  const f = await fixture(t), first = f.replication.resume(); await settle(); f.pending[0].resolve(idle); await first; await settle();
  for (let n = 1; n <= 4; n++) {
    t.mock.timers.tick(3000); await settle(); assert.equal(f.pending.length, n);
    const view = f.replication.flush(); await settle(); assert.equal(f.pending.length, n + 1);
    f.pending[n].resolve(idle); await view; await settle();
  }
  assert.equal(f.calls.filter(name => name === 'flush').length, 4);
});

test('revocation while a pass and a queued tail are pending sends no later pass', async t => {
  const f = await fixture(t), first = f.replication.resume(), result = assert.rejects(first, /provider-unavailable/); await settle();
  const joined = f.replication.flush(); assert.equal(joined, first);
  f.owner.invalidateOperation('operation'); f.pending[0].resolve(idle); await result; await settle();
  t.mock.timers.tick(30000); await settle(); assert.equal(f.pending.length, 1);
});
