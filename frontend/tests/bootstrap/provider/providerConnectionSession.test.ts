import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderConnectionSession } from '../../../src/features/bootstrap/provider/ProviderConnectionSession.ts';
import type { ProviderGrant, ProviderInstalledLibrary, ProviderOwnerFacade, ProviderRecoveryRequest, RemoteLibraryHandle } from '../../../src/features/bootstrap/bootstrapPorts.ts';
import type { ProviderConnectionBridge } from '../../../src/features/bootstrap/provider/providerConnectionPorts.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
/** Product coordination only. No fixture capability is accepted by a real host or provider. */
function harness() {
  const choice = Object.freeze({}) as RemoteLibraryHandle, grant = Object.freeze({}) as ProviderGrant;
  const calls = { connect: 0, list: 0, preload: 0, prepared: [] as { id: string; title: string; handle?: RemoteLibraryHandle }[], executed: [] as string[], opened: [] as string[], acknowledged: [] as string[], disconnected: 0 };
  const rows = new Map<string, ProviderRecoveryRequest>(), acknowledged = new Set<string>();
  const listeners = new Set<() => void>();
  const invalidation = new Set<() => void>();
  let retained: ReturnType<ProviderConnectionBridge['retained']> = null, allowLeave = true;
  const emit = () => listeners.forEach(listener => listener());
  const target = (requestId: string): ProviderInstalledLibrary => ({ requestId, lease: {} as ProviderInstalledLibrary['lease'], handle: {} as ProviderInstalledLibrary['handle'] });
  const facade: ProviderOwnerFacade = {
    subscribeInvalidation(listener) { invalidation.add(listener); return () => { invalidation.delete(listener); }; },
    async preload() { calls.preload++; return { configured: true }; },
    connect() { calls.connect++; return Promise.resolve(grant); },
    async list() { calls.list++; return [{ handle: choice, title: 'Shared Library', status: 'available' }]; },
    async recoveries() { return [...rows.values()].filter(row => !acknowledged.has(row.requestId)); },
    async prepareCreate(_grant, title, requestId) { calls.prepared.push({ id: requestId, title }); rows.set(requestId, { requestId, title, action: 'create', status: 'pending' }); return { requestId, status: 'pending' }; },
    async prepareJoin(_grant, handle, requestId) { calls.prepared.push({ id: requestId, title: 'Shared Library', handle }); rows.set(requestId, { requestId, title: 'Shared Library', action: 'join', status: 'pending' }); return { requestId, status: 'pending' }; },
    async query(_grant, requestId) { return { requestId, status: rows.get(requestId)?.status ?? 'not-found' }; },
    async execute(_grant, requestId) { calls.executed.push(requestId); const row = rows.get(requestId); if (row) rows.set(requestId, { ...row, status: 'accepted' }); return { requestId, status: 'accepted' }; },
    async acknowledge(_grant, requestId) { calls.acknowledged.push(requestId); acknowledged.add(requestId); },
    async openSelected() { return null; },
    async openInstalled(_grant, requestId) { return target(requestId); },
    async openReplication() { throw new Error('not part of view coordination'); },
    async disconnect() { calls.disconnected++; },
  };
  const bridge: ProviderConnectionBridge = {
    async getFacade() { return facade; }, retained: () => retained,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async openInstalled(installed, signal, beforeActivate) { await beforeActivate?.(); signal.throwIfAborted(); calls.opened.push(installed.requestId); retained = { kind: 'google-drive', requestId: installed.requestId, locked: false }; emit(); return true; },
    async prepareDisconnect() { if (!allowLeave) return { status: 'refused', reason: 'dirty', targets: [] }; retained = null; emit(); return { status: 'allowed' }; },
  };
  const session = new ProviderConnectionSession(bridge);
  return { session, facade, calls, rows, grant, choice, target, bridge, loseProvider() { invalidation.forEach(listener => listener()); }, setRetained(value: typeof retained) { retained = value; emit(); }, refuseLeave(value: boolean) { allowLeave = !value; } };
}
async function ready(h: ReturnType<typeof harness>) { await h.session.prepare(); await h.session.connect(); }

test('offline pending save reports the local guard and keeps the retained editor for retry', async () => {
  const h = harness(), requestId = crypto.randomUUID(); h.setRetained({ kind: 'google-drive', requestId, locked: false });
  const connect = h.facade.connect; h.facade.connect = () => { throw new Error('offline-pending'); };
  await h.session.prepare(); await h.session.connect();
  assert.equal(h.session.getSnapshot().error, '編集中の入力や保存途中の内容があります。端末への保存を確認してから、もう一度接続してください。');
  assert.deepEqual(h.bridge.retained(), { kind: 'google-drive', requestId, locked: false });
  assert.equal(h.calls.disconnected, 0); assert.deepEqual(h.calls.opened, []);
  h.facade.connect = connect; await h.session.connect();
  assert.equal(h.session.getSnapshot().error, ''); assert.deepEqual(h.calls.opened, [requestId]); await h.session.close();
});

test('SDK preparation never signs in; the explicit connect call starts in the same event stack', async () => {
  const h = harness(); await h.session.prepare(); assert.equal(h.calls.connect, 0);
  const connected = h.session.connect(); assert.equal(h.calls.connect, 1); await connected;
  assert.equal(h.session.getSnapshot().canCreate, true); assert.equal(h.session.getSnapshot().choices[0].title, 'Shared Library');
  await h.session.close();
});
test('unknown create keeps its fixed ID, refuses close/new operations, and query/execute opens exactly that request', async () => {
  const h = harness(); await ready(h); const prepare = h.facade.prepareCreate;
  h.facade.prepareCreate = async (...args) => { const outcome = await prepare(...args); return { ...outcome, status: 'unknown' }; };
  await h.session.create('Original title'); const request = h.session.getSnapshot().request!;
  assert.equal(request.status, 'unknown'); assert.equal(h.session.canLeave(), false); assert.equal((await h.session.close()).status, 'refused');
  await h.session.create('Must not replace original'); assert.equal(h.calls.prepared.length, 1);
  await h.session.prepare(); assert.equal(h.calls.preload, 1); assert.equal(h.session.getSnapshot().request!.requestId, request.requestId);
  await h.session.retry(); assert.deepEqual(h.calls.executed, [request.requestId]); assert.deepEqual(h.calls.opened, [request.requestId]);
  assert.equal(h.calls.prepared.length, 1); assert.equal(h.session.getSnapshot().pendingGuard, false); await h.session.close();
});
test('not-found after a failed in-memory CREATE reuses the same UUID and the full Unicode title', async () => {
  const h = harness(); await ready(h); const original = h.facade.prepareCreate, attempted: string[] = [];
  h.facade.prepareCreate = async (...args) => { attempted.push(args[2]); if (attempted.length === 1) throw new Error('lost before durable prepare'); return original(...args); };
  const title = '𠮷'.repeat(200); await h.session.create(title); await h.session.retry();
  assert.equal(attempted.length, 2); assert.equal(attempted[0], attempted[1]); assert.equal(h.calls.prepared[0].title, title);
  assert.deepEqual(h.calls.opened, [attempted[0]]); await h.session.close();
});
test('cold JOIN recovery executes its durable ID without a renderer selection or a new prepare', async () => {
  const h = harness(), requestId = crypto.randomUUID(); h.rows.set(requestId, { requestId, title: 'Recovered Library', action: 'join', status: 'pending' });
  await ready(h); assert.equal(h.session.getSnapshot().pendingGuard, true); assert.equal(h.session.getSnapshot().canJoin, false);
  await h.session.retry(); assert.deepEqual(h.calls.prepared, []); assert.deepEqual(h.calls.executed, [requestId]); assert.deepEqual(h.calls.opened, [requestId]);
  assert.equal(h.rows.get(requestId)?.status, 'accepted'); assert.equal(h.session.getSnapshot().pendingGuard, false); await h.session.close();
});
test('multiple durable recoveries are confirmed in sequence before an editor opens', async () => {
  const h = harness(), first = crypto.randomUUID(), second = crypto.randomUUID();
  for (const requestId of [first, second]) h.rows.set(requestId, { requestId, title: requestId, action: 'join', status: 'pending' });
  await ready(h); await h.session.retry(); assert.deepEqual(h.calls.opened, []);
  assert.equal(h.session.getSnapshot().request!.requestId, second); assert.equal(h.session.canLeave(), false);
  await h.session.retry(); assert.deepEqual(h.calls.executed, [first, second]); assert.deepEqual(h.calls.opened, [second]);
  assert.equal(h.session.getSnapshot().pendingGuard, false); await h.session.close();
});
test('cancelled connect cannot adopt a late grant or call list', async () => {
  const h = harness(), login = deferred<ProviderGrant>(); h.facade.connect = () => login.promise;
  await h.session.prepare(); const flight = h.session.connect(), cancelled = h.session.cancelConnect(); login.resolve(h.grant);
  await Promise.all([flight, cancelled]); assert.equal(h.session.getSnapshot().connected, false); assert.equal(h.calls.list, 0);
  assert.equal(h.session.getSnapshot().canConnect, true); await h.session.close();
});
test('reconnect restores exactly the retained runtime before enabling any new operation', async () => {
  const h = harness(), requestId = crypto.randomUUID(); h.setRetained({ kind: 'google-drive', requestId, locked: true });
  await ready(h); assert.deepEqual(h.calls.opened, [requestId]); assert.equal(h.session.getSnapshot().canCreate, false); assert.equal(h.session.getSnapshot().canJoin, false);
  h.refuseLeave(true); assert.equal((await h.session.disconnect()).status, 'refused'); assert.equal(h.calls.disconnected, 0);
  h.refuseLeave(false); assert.equal((await h.session.disconnect()).status, 'allowed'); assert.equal(h.calls.disconnected, 1); await h.session.close();
});
test('cached selected Library opens its existing host request without another JOIN installation', async () => {
  const h = harness(), requestId = crypto.randomUUID(); await ready(h); h.facade.openSelected = async () => h.target(requestId);
  await h.session.join(h.choice); assert.deepEqual(h.calls.prepared, []); assert.deepEqual(h.calls.opened, [requestId]);
  assert.equal(h.session.getSnapshot().request!.requestId, requestId); await h.session.close();
});
test('failed acknowledgement does not turn a known activated library back into unknown', async () => {
  const h = harness(), requestId = crypto.randomUUID(); h.rows.set(requestId, { requestId, title: 'Retained', action: 'join', status: 'pending' });
  h.facade.acknowledge = async () => { throw new Error('ack reply lost'); }; await ready(h); await h.session.retry();
  assert.equal(h.session.getSnapshot().request!.status, 'accepted'); assert.equal(h.session.getSnapshot().pendingGuard, false);
  assert.equal(h.session.canLeave(), true); await h.session.close();
});
test('a returned foreign request ID cannot open an editor or release the original pending guard', async () => {
  const h = harness(); await ready(h); h.facade.prepareCreate = async () => ({ requestId: crypto.randomUUID(), status: 'accepted' });
  await h.session.create('Keep request'); assert.deepEqual(h.calls.opened, []); assert.equal(h.session.getSnapshot().request!.status, 'unknown');
  assert.equal(h.session.getSnapshot().pendingGuard, true);
});
test('raw provider failures and authorization URLs never enter view state', async () => {
  const h = harness(); h.facade.connect = async () => { throw new Error('https://accounts.invalid/auth?token=must-not-display'); };
  await ready(h); assert.equal(h.session.getSnapshot().connected, false);
  assert.ok(!JSON.stringify(h.session.getSnapshot()).includes('must-not-display')); await h.session.close();
});
test('chooser credential loss preserves an unknown request and permits reauthentication without any retained editor', async () => {
  const h = harness(); await ready(h); const prepare = h.facade.prepareCreate;
  h.facade.prepareCreate = async (...args) => { const result = await prepare(...args); return { ...result, status: 'unknown' }; };
  await h.session.create('Keep A'); const requestId = h.session.getSnapshot().request!.requestId; h.loseProvider();
  assert.equal(h.session.getSnapshot().connected, false); assert.equal(h.session.getSnapshot().canConnect, true);
  assert.equal(h.session.getSnapshot().pendingGuard, true); assert.deepEqual(h.session.getSnapshot().choices, []);
  await h.session.connect(); await h.session.retry(); assert.deepEqual(h.calls.opened, [requestId]); assert.equal(h.calls.prepared.length, 1); await h.session.close();
});
test('the expected old-generation invalidation at sign-in does not cancel its own fresh connection', async () => {
  const h = harness(); h.facade.connect = () => { h.loseProvider(); return Promise.resolve(h.grant); };
  await ready(h); assert.equal(h.session.getSnapshot().connected, true); assert.equal(h.session.getSnapshot().canJoin, true); await h.session.close();
});
test('explicit disconnect may revoke its grant without reporting its own successful logout as a refusal', async () => {
  const h = harness(); await ready(h); h.facade.disconnect = async () => { h.calls.disconnected++; h.loseProvider(); };
  assert.equal((await h.session.disconnect()).status, 'allowed'); assert.equal(h.calls.disconnected, 1);
  assert.equal(h.session.getSnapshot().connected, false); assert.equal(h.session.getSnapshot().canConnect, true); await h.session.close();
});
test('principal mismatch without a callback retains the original request and offers the correct-account reconnect', async () => {
  const h = harness(); await ready(h); h.facade.prepareCreate = async (_grant, title, requestId) => {
    h.calls.prepared.push({ id: requestId, title }); return { requestId, status: 'unknown' };
  };
  await h.session.create('Account A original'); const requestId = h.session.getSnapshot().request!.requestId;
  h.facade.query = async () => { throw new Error('provider-principal-changed'); }; await h.session.retry();
  assert.equal(h.session.getSnapshot().connected, false); assert.equal(h.session.getSnapshot().canConnect, true);
  assert.equal(h.session.getSnapshot().request!.requestId, requestId); assert.equal(h.session.getSnapshot().pendingGuard, true);
  assert.equal(h.calls.prepared.length, 1); assert.deepEqual(h.calls.opened, []);
});
test('credential loss while SDK preparation is pending leaves an explicit preparation retry', async () => {
  const h = harness(), sdk = deferred<{ configured: boolean }>(); h.facade.preload = () => sdk.promise;
  const flight = h.session.prepare(); await Promise.resolve(); h.loseProvider(); sdk.resolve({ configured: true }); await flight;
  assert.equal(h.session.getSnapshot().phase, 'unavailable'); assert.equal(h.session.getSnapshot().connected, false);
  await h.session.prepare(); assert.equal(h.session.getSnapshot().canConnect, true); await h.session.close();
});
test('a known invalid title creates no pending request and can be corrected without an unknown-result lock', async () => {
  const h = harness(); await ready(h);
  await h.session.create('𠮷'.repeat(201)); assert.deepEqual(h.calls.prepared, []);
  assert.equal(h.session.getSnapshot().request, null); assert.equal(h.session.getSnapshot().pendingGuard, false);
  assert.equal(h.session.getSnapshot().canCreate, true); assert.ok(h.session.getSnapshot().error.includes('200'));
  await h.session.create('Corrected'); assert.equal(h.calls.prepared.length, 1); assert.equal(h.calls.opened.length, 1); await h.session.close();
});


test('automatic retained readmission uses a fresh grant and exact request without OAuth, listing or prepare', async () => {
  const h = harness(); await ready(h); const requestId = crypto.randomUUID(), fresh = Object.freeze({}) as ProviderGrant;
  h.setRetained({ kind: 'google-drive', requestId, locked: true });
  const before = { connect: h.calls.connect, list: h.calls.list, preload: h.calls.preload };
  h.facade.resumeRetained = async (actual, signal) => { assert.equal(actual, requestId); assert.equal(signal.aborted, false); return { grant: fresh, target: h.target(actual) }; };
  assert.equal(await h.session.resumeRetained(), true);
  assert.deepEqual(h.calls.opened, [requestId]); assert.equal(h.session.getSnapshot().connected, true);
  assert.deepEqual({ connect: h.calls.connect, list: h.calls.list, preload: h.calls.preload }, before);
  assert.deepEqual(h.calls.prepared, []); assert.deepEqual(h.calls.executed, []);
  assert.equal(h.session.getSnapshot().canCreate, false); await h.session.close();
});

test('failed or mismatched automatic readmission leaves retained authority locked and permits manual reconnect', async () => {
  for (const mismatch of [false, true]) {
    const h = harness(); await ready(h); const requestId = crypto.randomUUID();
    h.setRetained({ kind: 'google-drive', requestId, locked: true });
    h.facade.resumeRetained = async () => mismatch ? { grant: h.grant, target: h.target(crypto.randomUUID()) } : null;
    assert.equal(await h.session.resumeRetained(), false); assert.deepEqual(h.calls.opened, []);
    assert.equal(h.session.getSnapshot().connected, false); assert.equal(h.session.getSnapshot().canConnect, true);
    await h.session.connect(); assert.deepEqual(h.calls.opened, [requestId]); await h.session.close();
  }
});

test('page loss during automatic readmission cannot adopt a late result or clear a newer connection', async () => {
  const h = harness(); await ready(h); const requestId = crypto.randomUUID();
  h.setRetained({ kind: 'google-drive', requestId, locked: true });
  const held = deferred<{ grant: ProviderGrant; target: ProviderInstalledLibrary } | null>();
  let signal!: AbortSignal;
  h.facade.resumeRetained = (_id, active) => { signal = active; return held.promise; };
  const resuming = h.session.resumeRetained(); h.loseProvider(); assert.equal(signal.aborted, true);
  held.resolve({ grant: Object.freeze({}) as ProviderGrant, target: h.target(requestId) });
  assert.equal(await resuming, false); assert.deepEqual(h.calls.opened, []);
  await h.session.connect(); assert.equal(h.session.getSnapshot().connected, true);
  assert.deepEqual(h.calls.opened, [requestId]); await h.session.close();
});


test('fresh authority remains attempt-owned until complete adoption and rejects late failed handoff', async () => {
  const h = harness(); await ready(h); const requestId = crypto.randomUUID(), fresh = Object.freeze({}) as ProviderGrant;
  h.setRetained({ kind: 'google-drive', requestId, locked: true });
  const settled: Array<{ grant: ProviderGrant; accepted: boolean }> = [];
  h.facade.resumeRetained = async () => ({ grant: fresh, target: h.target(requestId) });
  h.facade.settleRetainedResume = (grant, accepted) => { settled.push({ grant, accepted }); };
  const original = h.bridge.openInstalled;
  h.bridge.openInstalled = async () => false;
  assert.equal(await h.session.resumeRetained(), false); assert.deepEqual(settled, [{ grant: fresh, accepted: false }]);
  h.bridge.openInstalled = original; settled.length = 0;
  assert.equal(await h.session.resumeRetained(), true); assert.deepEqual(settled, [{ grant: fresh, accepted: true }]);
  await h.session.refresh(); assert.deepEqual(settled, [{ grant: fresh, accepted: true }]);
  await h.session.close();
});


test('failed asynchronous ownership ACK cannot publish a connected runtime and invokes exact cleanup', async () => {
  const h = harness(); await ready(h); const requestId = crypto.randomUUID(), fresh = Object.freeze({}) as ProviderGrant;
  h.setRetained({ kind: 'google-drive', requestId, locked: true });
  const settled: boolean[] = [];
  h.facade.resumeRetained = async () => ({ grant: fresh, target: h.target(requestId) });
  h.facade.settleRetainedResume = async (actual, accepted) => {
    assert.equal(actual, fresh); settled.push(accepted); if (accepted) throw new Error('ack response lost');
  };
  assert.equal(await h.session.resumeRetained(), false); assert.deepEqual(settled, [true, false]);
  assert.deepEqual(h.calls.opened, []); assert.equal(h.session.getSnapshot().connected, false);
  assert.equal(h.session.getSnapshot().canConnect, true); await h.session.close();
});


test('page loss after positive ownership ACK but before editor activation still retires that exact fresh grant', async () => {
  const h = harness(); await ready(h); const requestId = crypto.randomUUID(), fresh = Object.freeze({}) as ProviderGrant;
  h.setRetained({ kind: 'google-drive', requestId, locked: true }); const settled: Array<[ProviderGrant, boolean]> = [];
  h.facade.resumeRetained = async () => ({ grant: fresh, target: h.target(requestId) });
  h.facade.settleRetainedResume = async (grant, accepted) => { settled.push([grant, accepted]); if (accepted) h.loseProvider(); };
  assert.equal(await h.session.resumeRetained(), false); assert.deepEqual(settled, [[fresh, true], [fresh, false]]);
  assert.deepEqual(h.calls.opened, []); assert.equal(h.session.getSnapshot().connected, false);
  await h.session.connect(); assert.equal(h.session.getSnapshot().connected, true); assert.deepEqual(h.calls.opened, [requestId]);
  await h.session.close();
});

test('prepare auto-reconnects via reconnectSaved when available, falls back cleanly when null, releases on close, and respects explicit disconnect', async () => {
  let savedAvailable = true, reconnectCalls = 0, released = 0;
  const h = harness();
  h.facade.reconnectSaved = async () => { reconnectCalls++; return savedAvailable ? h.grant : null; };
  h.facade.releaseOnClose = async () => { released++; };
  await h.session.prepare();
  assert.equal(reconnectCalls, 1);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.session.getSnapshot().connected, true);
  assert.equal(h.session.getSnapshot().choices[0].title, 'Shared Library');
  assert.equal((await h.session.close()).status, 'allowed');
  assert.equal(released, 1);
  assert.equal(h.calls.disconnected, 0);

  const fallback = harness(); savedAvailable = false;
  fallback.facade.reconnectSaved = async () => { return savedAvailable ? fallback.grant : null; };
  await fallback.session.prepare();
  assert.equal(fallback.session.getSnapshot().connected, false);
  assert.equal(fallback.session.getSnapshot().canConnect, true);
  assert.equal(fallback.session.getSnapshot().error, '');
  await fallback.session.connect();
  assert.equal((await fallback.session.disconnect()).status, 'allowed');
  assert.equal(fallback.calls.disconnected, 1);
  savedAvailable = true;
  let postDisconnectReconnect = 0;
  fallback.facade.reconnectSaved = async () => { postDisconnectReconnect++; return fallback.grant; };
  await fallback.session.prepare();
  assert.equal(postDisconnectReconnect, 0);
  assert.equal(fallback.session.getSnapshot().connected, false);
  await fallback.session.close();
});

test('prepare retires saved grant via releaseOnClose when afterConnected fails or close aborts in flight', async () => {
  const h = harness();
  const retired: ProviderGrant[] = [];
  h.facade.reconnectSaved = async () => h.grant;
  h.facade.releaseOnClose = async grant => { retired.push(grant); };
  h.facade.list = async () => { throw new Error('provider-unavailable'); };
  await h.session.prepare();
  assert.deepEqual(retired, [h.grant]);
  assert.equal(h.calls.disconnected, 0);
  assert.equal(h.session.getSnapshot().connected, false);
  assert.equal(h.session.getSnapshot().phase, 'connect-ready');
  assert.equal(h.session.getSnapshot().error, '');
  await h.session.close();

  const closing = harness();
  const closedRetired: ProviderGrant[] = [];
  const entered = deferred<void>(), gate = deferred<void>();
  closing.facade.reconnectSaved = async () => { entered.resolve(); await gate.promise; return closing.grant; };
  closing.facade.releaseOnClose = async grant => { closedRetired.push(grant); };
  const preparing = closing.session.prepare();
  await entered.promise;
  const closePromise = closing.session.close();
  gate.resolve();
  await preparing;
  assert.equal((await closePromise).status, 'allowed');
  assert.deepEqual(closedRetired, [closing.grant]);
  assert.equal(closing.calls.disconnected, 0);
});
