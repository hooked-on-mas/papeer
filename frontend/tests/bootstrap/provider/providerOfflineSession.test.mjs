import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderOfflineSession } from '../../../src/features/bootstrap/provider/ProviderOfflineSession.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup() {
  const calls = [], listeners = new Set(), handle = Object.freeze({}), session = Object.freeze({});
  const proof = { scope: { accountId: 'account-A', libraryId: 'library-A', epoch: 'epoch-A' } };
  let retained = null, available = true, leave = { status: 'allowed' };
  const facade = {
    async recoverEnrollment() { return null; },
    async revokeEnrollment(proof, secret, signal) { calls.push(['revokeEnrollment', proof, signal]); return { status: 'revoked' }; },
    async enroll(p, secret, id, signal) { calls.push(['enroll', p, id, signal]); return { requestId: id, status: 'accepted' }; },
    async unlock() { calls.push(['unlock']); return { session, choices: [{ handle, title: 'Private library' }] }; },
    async open(s, h) { calls.push(['open', s, h]); return { lease: {}, handle: {}, requestId: 'activation-A' }; },
    async lock(s) { calls.push(['lock', s]); },
    async revoke(s, h) { calls.push(['revoke', s, h]); },
  };
  const bridge = { getFacade: () => facade, retained: () => retained, available: () => available,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    async prepareLeave() { calls.push(['prepareLeave']); if (leave.status === 'allowed') retained = null; return leave; },
    async openInstalled(target, signal) { calls.push(['openInstalled', target, signal]); return true; },
  };
  const controller = new ProviderOfflineSession(bridge);
  const publish = () => listeners.forEach(fn => fn());
  return { controller, facade, bridge, calls, handle, session, proof, publish,
    setRetained(value) { retained = value; publish(); }, setLeave(value) { leave = value; }, setAvailable(value) { available = value; publish(); } };
}

test('choices appear only after unlock; forged handles never reach host or open bridge', async () => {
  const s = setup(), waiting = deferred(); s.facade.unlock = () => waiting.promise;
  const work = s.controller.unlock('synthetic-passphrase');
  assert.deepEqual(s.controller.getSnapshot().choices, []); assert.equal(s.controller.getSnapshot().busy, true);
  waiting.resolve({ session: s.session, choices: [{ handle: s.handle, title: 'Private library' }] }); await work;
  await s.controller.open({}); assert.equal(s.calls.length, 0);
  await s.controller.open(s.handle);
  assert.equal(s.calls[0][0], 'open'); assert.equal(s.calls[1][0], 'openInstalled');
  s.controller.dispose();
});

test('failed unlock exposes no secret, names or raw host error', async () => {
  const s = setup(), secret = 'distinctive-synthetic-secret';
  s.facade.unlock = async () => { throw new Error(secret + ' raw host details'); };
  await s.controller.unlock(secret);
  assert.equal(s.controller.getSnapshot().error, true); assert.deepEqual(s.controller.getSnapshot().choices, []);
  assert.doesNotMatch(JSON.stringify(s.controller.getSnapshot()), /distinctive|raw host|Private library/);
  s.controller.dispose();
});

test('unknown enrollment retains exact request ID through retry and blocks other scope', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  let attempt = 0;
  s.facade.enroll = async (p, secret, id) => { s.calls.push(['enroll', id]); return { requestId: id, status: ++attempt === 1 ? 'unknown' : 'accepted' }; };
  await s.controller.enroll('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().pendingGuard, true); assert.equal(s.controller.getSnapshot().canUnlock, false);
  s.setRetained({ proof: { scope: { ...s.proof.scope, libraryId: 'library-B' } }, provider: true, offline: false, locked: false });
  await s.controller.enroll('synthetic-passphrase'); assert.equal(s.calls.length, 1);
  s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  await s.controller.enroll('synthetic-passphrase');
  assert.equal(s.calls[0][1], s.calls[1][1]); assert.equal(s.controller.getSnapshot().pendingGuard, false);
  assert.equal(s.controller.getSnapshot().outcome, 'accepted'); assert.equal(s.controller.getSnapshot().canEnroll, false);
  s.controller.dispose();
});

test('host loss after enrollment dispatch keeps unknown ID and ignores late acceptance', async () => {
  const s = setup(), waiting = deferred(), sent = deferred(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  let firstId;
  s.facade.enroll = (p, secret, id) => { firstId = id; sent.resolve(); return waiting.promise; };
  const work = s.controller.enroll('synthetic-passphrase'); await sent.promise; s.controller.hostLost();
  waiting.resolve({ requestId: firstId, status: 'accepted' }); await work;
  assert.equal(s.controller.getSnapshot().outcome, 'unknown'); assert.equal(s.controller.getSnapshot().pendingGuard, true);
  s.facade.enroll = async (p, secret, id) => { assert.equal(id, firstId); return { requestId: id, status: 'accepted' }; };
  await s.controller.enroll('synthetic-passphrase'); assert.equal(s.controller.getSnapshot().pendingGuard, false);
  s.controller.dispose();
});

for (const method of ['lock', 'revoke']) test(`${method} refuses dirty leave before changing host/session, then allows guarded leave`, async () => {
  const s = setup(); await s.controller.unlock('synthetic-passphrase');
  s.setRetained({ proof: s.proof, provider: true, offline: true, locked: false });
  s.setLeave({ status: 'refused', reason: 'current-blocked', targets: [] });
  await s.controller[method](s.handle);
  assert.equal(s.calls.some(call => call[0] === method), false);
  assert.equal(s.controller.getSnapshot().phase, 'unlocked'); assert.equal(s.controller.getSnapshot().choices.length, 1);
  s.setLeave({ status: 'allowed' }); await s.controller[method](s.handle);
  assert.equal(s.calls.filter(call => call[0] === method).length, 1);
  assert.equal(s.controller.getSnapshot().phase, 'locked'); assert.deepEqual(s.controller.getSnapshot().choices, []);
  s.controller.dispose();
});

test('late unlock after host loss is retired without exposing choices', async () => {
  const s = setup(), waiting = deferred(); s.facade.unlock = () => waiting.promise;
  const work = s.controller.unlock('synthetic-passphrase'); s.controller.hostLost();
  waiting.resolve({ session: s.session, choices: [{ handle: s.handle, title: 'Private library' }] }); await work;
  assert.deepEqual(s.calls, [['lock', s.session]]); assert.deepEqual(s.controller.getSnapshot().choices, []);
  assert.equal(s.controller.getSnapshot().phase, 'locked'); s.controller.dispose();
});

test('duplicate operations join no new host call; unavailable bootstrap starts none', async () => {
  const s = setup(), waiting = deferred(); let count = 0;
  s.facade.unlock = () => { count++; return waiting.promise; };
  const first = s.controller.unlock('synthetic-passphrase'); await s.controller.unlock('synthetic-passphrase');
  assert.equal(count, 1); waiting.resolve({ session: s.session, choices: [] }); await first;
  s.controller.hostLost(); s.setAvailable(false); await s.controller.unlock('synthetic-passphrase'); assert.equal(count, 1);
  s.controller.dispose();
});

test('no-op bridge notification keeps exact snapshot object and causes no publish loop', () => {
  const s = setup(), before = s.controller.getSnapshot(); let count = 0;
  s.controller.subscribe(() => count++); s.publish(); s.publish();
  assert.equal(s.controller.getSnapshot(), before); assert.equal(count, 0); s.controller.dispose();
});

test('failed lock after guarded leave drops local handles and allows fresh unlock', async () => {
  const s = setup(); await s.controller.unlock('synthetic-passphrase');
  s.facade.lock = async () => { throw new Error('host-lock-response-lost'); };
  await s.controller.lock();
  assert.equal(s.controller.getSnapshot().phase, 'locked'); assert.equal(s.controller.getSnapshot().canUnlock, true);
  assert.deepEqual(s.controller.getSnapshot().choices, []); assert.equal(s.controller.getSnapshot().error, true);
  s.controller.dispose();
});

test('forced host loss retires display capability without voluntarily closing the retained runtime', async () => {
  const s = setup(); await s.controller.unlock('synthetic-passphrase');
  s.setRetained({ proof: s.proof, provider: true, offline: true, locked: true }); s.calls.length = 0;
  s.controller.hostLost();
  assert.deepEqual(s.calls, []); assert.equal(s.controller.getSnapshot().canUnlock, true);
  assert.equal(s.controller.getSnapshot().offlineActive, true); assert.deepEqual(s.controller.getSnapshot().choices, []);
  s.controller.dispose();
});

test('ordinary local-only runtime cannot enroll a provider authorization', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: false, offline: false, locked: false });
  assert.equal(s.controller.getSnapshot().canEnroll, false);
  await s.controller.enroll('synthetic-passphrase'); assert.equal(s.calls.length, 0); s.controller.dispose();
});

test('confirmed revoke permits fresh online enrollment of the same Library', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  await s.controller.enroll('synthetic-passphrase'); s.setRetained(null);
  await s.controller.unlock('synthetic-passphrase'); await s.controller.revoke(s.handle);
  s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  assert.equal(s.controller.getSnapshot().canEnroll, true); s.controller.dispose();
});

test('durable revoke followed by lost response does not suppress later host-checked enrollment', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  await s.controller.enroll('synthetic-passphrase'); s.setRetained(null); await s.controller.unlock('synthetic-passphrase');
  s.facade.revoke = async () => { throw new Error('offline-revoke-unknown'); };
  await s.controller.revoke(s.handle);
  assert.equal(s.controller.getSnapshot().error, true); assert.equal(s.controller.getSnapshot().phase, 'locked');
  s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  assert.equal(s.controller.getSnapshot().canEnroll, true);
  await s.controller.enroll('synthetic-passphrase'); assert.equal(s.calls.filter(call => call[0] === 'enroll').length, 2);
  s.controller.dispose();
});

test('revocation invalidating its own admission clears old display suppression during callback', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  await s.controller.enroll('synthetic-passphrase'); s.setRetained(null); await s.controller.unlock('synthetic-passphrase');
  s.facade.revoke = async () => { s.controller.hostLost(); };
  await s.controller.revoke(s.handle);
  assert.equal(s.controller.getSnapshot().phase, 'locked'); assert.deepEqual(s.controller.getSnapshot().choices, []);
  s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  assert.equal(s.controller.getSnapshot().canEnroll, true); s.controller.dispose();
});

test('fresh controller resumes host-authenticated durable pending request after cold restart', async () => {
  const s = setup(), durableId = '11111111-2222-4333-8444-555555555555';
  s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.recoverEnrollment = async (proof, secret, signal) => {
    assert.equal(proof, s.proof); assert.equal(secret, 'synthetic-passphrase'); assert.equal(signal.aborted, false);
    return { requestId: durableId, status: 'pending' };
  };
  s.facade.enroll = async (proof, secret, id) => { assert.equal(id, durableId); s.calls.push(['enroll', id]); return { requestId: id, status: 'accepted' }; };
  await s.controller.enroll('synthetic-passphrase');
  assert.equal(s.calls.length, 1); assert.equal(s.controller.getSnapshot().outcome, 'accepted');
  assert.equal(s.controller.getSnapshot().pendingGuard, false); s.controller.dispose();
});

test('host-authenticated accepted grant needs no duplicate enrollment request', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.recoverEnrollment = async () => ({ requestId: '11111111-2222-4333-8444-555555555555', status: 'accepted' });
  await s.controller.enroll('synthetic-passphrase');
  assert.equal(s.calls.length, 0); assert.equal(s.controller.getSnapshot().outcome, 'accepted'); s.controller.dispose();
});

test('failed recovery creates no phantom pending request and permits a corrected secret', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.recoverEnrollment = async () => { throw new Error('synthetic-wrong-secret'); };
  await s.controller.enroll('synthetic-wrong-secret');
  assert.equal(s.controller.getSnapshot().pendingGuard, false); assert.equal(s.controller.getSnapshot().canEnroll, true);
  assert.equal(s.calls.length, 0); assert.equal(s.controller.getSnapshot().error, true);
  s.facade.recoverEnrollment = async () => null;
  await s.controller.enroll('synthetic-passphrase'); assert.equal(s.controller.getSnapshot().outcome, 'accepted'); s.controller.dispose();
});

test('late recovery after host loss cannot start a new enrollment or publish acceptance', async () => {
  const s = setup(), waiting = deferred(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.recoverEnrollment = () => waiting.promise;
  const work = s.controller.enroll('synthetic-passphrase'); s.controller.hostLost();
  waiting.resolve({ requestId: '11111111-2222-4333-8444-555555555555', status: 'accepted' }); await work;
  assert.equal(s.calls.length, 0); assert.equal(s.controller.getSnapshot().outcome, 'none'); s.controller.dispose();
});

test('online permission revocation keeps the current editor and never asks to leave or lock it', async () => {
  const s = setup(), runtime = { proof: s.proof, provider: true, offline: false, locked: false };
  s.setRetained(runtime); await s.controller.revokeEnrollment('synthetic-passphrase');
  assert.equal(s.bridge.retained(), runtime); assert.deepEqual(s.calls.map(call => call[0]), ['revokeEnrollment']);
  assert.equal(s.controller.getSnapshot().revocation, 'revoked'); assert.equal(s.controller.getSnapshot().pendingGuard, false);
  assert.equal(s.controller.getSnapshot().canEnroll, true); s.controller.dispose();
});

test('local, offline or locked runtime cannot invoke online permission revocation', async () => {
  const s = setup();
  for (const flags of [{ provider: false, offline: false, locked: false }, { provider: true, offline: true, locked: false }, { provider: true, offline: false, locked: true }]) {
    s.setRetained({ proof: s.proof, ...flags }); assert.equal(s.controller.getSnapshot().canRevokeEnrollment, false);
    await s.controller.revokeEnrollment('synthetic-passphrase');
  }
  assert.deepEqual(s.calls, []); s.controller.dispose();
});

test('definite pre-effect secret failure leaves no phantom pending revocation', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.revokeEnrollment = async () => { throw new Error('distinctive-synthetic-wrong-secret'); };
  await s.controller.revokeEnrollment('distinctive-synthetic-wrong-secret');
  assert.equal(s.controller.getSnapshot().pendingGuard, false); assert.equal(s.controller.getSnapshot().error, true);
  assert.equal(s.controller.getSnapshot().canRevokeEnrollment, true);
  assert.doesNotMatch(JSON.stringify(s.controller.getSnapshot()), /distinctive-synthetic/);
  s.facade.revokeEnrollment = async () => ({ status: 'revoked' }); await s.controller.revokeEnrollment('correct-synthetic-secret');
  assert.equal(s.controller.getSnapshot().error, false); assert.equal(s.controller.getSnapshot().revocation, 'revoked'); s.controller.dispose();
});

test('unknown revocation permits only same-Library authorized retry and keeps transition guard', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.revokeEnrollment = async proof => { s.calls.push(['revokeEnrollment', proof]); return { status: 'unknown' }; };
  await s.controller.revokeEnrollment('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().pendingGuard, true); assert.equal(s.controller.getSnapshot().canEnroll, false);
  assert.equal(s.controller.getSnapshot().canUnlock, false); assert.equal(s.controller.getSnapshot().canRevokeEnrollment, true);
  s.setRetained({ proof: { scope: { ...s.proof.scope, libraryId: 'other-Library' } }, provider: true, offline: false, locked: false });
  await s.controller.revokeEnrollment('synthetic-passphrase'); assert.equal(s.calls.length, 1);
  s.controller.hostLost(); s.setRetained({ proof: { scope: { ...s.proof.scope } }, provider: true, offline: false, locked: false });
  s.facade.revokeEnrollment = async () => ({ status: 'revoked' }); await s.controller.revokeEnrollment('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().pendingGuard, false); assert.equal(s.controller.getSnapshot().revocation, 'revoked'); s.controller.dispose();
});

test('host loss during revocation keeps unknown scope and ignores a late successful callback', async () => {
  const s = setup(), waiting = deferred(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  let signal;
  s.facade.revokeEnrollment = async (_proof, _secret, captured) => { signal = captured; return waiting.promise; };
  const work = s.controller.revokeEnrollment('synthetic-passphrase'); s.controller.hostLost();
  assert.equal(signal.aborted, true); waiting.resolve({ status: 'revoked' }); await work;
  assert.equal(s.controller.getSnapshot().pendingGuard, true); assert.equal(s.controller.getSnapshot().revocation, 'unknown');
  s.facade.revokeEnrollment = async () => ({ status: 'revoked' }); await s.controller.revokeEnrollment('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().pendingGuard, false); s.controller.dispose();
});

test('unresolved enrollment must be reconciled before permission revocation starts', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.enroll = async (_proof, _secret, id) => ({ requestId: id, status: 'unknown' });
  await s.controller.enroll('synthetic-passphrase'); await s.controller.revokeEnrollment('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().canRevokeEnrollment, false); assert.equal(s.calls.length, 0); s.controller.dispose();
});

test('malformed successful revocation result is uncertain and cannot clear the guard', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  s.facade.revokeEnrollment = async () => null;
  await s.controller.revokeEnrollment('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().revocation, 'unknown'); assert.equal(s.controller.getSnapshot().pendingGuard, true); s.controller.dispose();
});

test('an accepted notice cannot falsely label another Library as enabled', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  await s.controller.enroll('synthetic-passphrase'); assert.equal(s.controller.getSnapshot().outcome, 'accepted');
  s.setRetained({ proof: { scope: { ...s.proof.scope, libraryId: 'other' } }, provider: true, offline: false, locked: false });
  assert.equal(s.controller.getSnapshot().outcome, 'none'); assert.equal(s.controller.getSnapshot().canEnroll, true); s.controller.dispose();
});

test('a revoked notice is scoped to the Library whose permission was changed', async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  await s.controller.revokeEnrollment('synthetic-passphrase'); assert.equal(s.controller.getSnapshot().revocation, 'revoked');
  s.setRetained({ proof: { scope: { ...s.proof.scope, libraryId: 'other' } }, provider: true, offline: false, locked: false });
  assert.equal(s.controller.getSnapshot().revocation, 'none'); s.controller.dispose();
});

for (const malformed of [undefined, 'unexpected-status']) test(`malformed enrollment status ${String(malformed)} retains fixed ID and guard`, async () => {
  const s = setup(); s.setRetained({ proof: s.proof, provider: true, offline: false, locked: false });
  let dispatched;
  s.facade.enroll = async (_proof, _secret, id) => { dispatched = id; return { requestId: id, status: malformed }; };
  await s.controller.enroll('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().outcome, 'unknown'); assert.equal(s.controller.getSnapshot().pendingGuard, true);
  s.facade.enroll = async (_proof, _secret, id) => { assert.equal(id, dispatched); return { requestId: id, status: 'accepted' }; };
  await s.controller.enroll('synthetic-passphrase');
  assert.equal(s.controller.getSnapshot().outcome, 'accepted'); assert.equal(s.controller.getSnapshot().pendingGuard, false); s.controller.dispose();
});
