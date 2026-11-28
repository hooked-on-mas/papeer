import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopBootstrapHost } from '../src/adapters/desktop/bootstrapEntry.ts';
import { createDesktopCloseController } from '../src/adapters/desktop/desktopWindowClose.ts';
import { createRecoveryClose, recoveryCloseHost } from '../src/adapters/desktop/NativeRecoveryClose.ts';
import { bootstrapRoutes } from '../src/adapters/desktop/canonicalBootstrapWire.ts';
import { createDesktopBootstrapHostDriver } from '../src/adapters/desktop/bootstrapHostDriver.ts';
import type { CanonicalInitializeRequest } from '../src/runtime/edits/contracts.ts';
import type { ActiveLibraryProof, NativePreparationStatus } from '../src/features/bootstrap/bootstrapPorts.ts';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const peer = { version: 1 as const, accountId: 'fixture-namespace', peerId: '00000000-0000-4000-8000-000000000001' };

for (const first of ['pending', 'http-error', 'transport-error', 'malformed'] as const) test(`recovery preserves actual driver status after ${first} and retries close`, async () => {
  const env = browserGlobals('unit-test-token');
  try {
    let shutdowns = 0, statuses = 0, exits = 0;
    const fetcher: typeof fetch = async input => {
      const endpoint = new URL(String(input)).pathname;
      if (endpoint.endsWith('/status')) { statuses++; return Response.json({ state: 'running', scope: 'native-preparation-only' }); }
      if (endpoint === '/shutdown') {
        shutdowns++;
        if (shutdowns > 1) return Response.json({ stopped: true });
        if (first === 'pending') return Response.json({ stopped: false });
        if (first === 'http-error') return new Response('', { status: 503 });
        if (first === 'transport-error') throw new Error('offline');
        return new Response('{');
      }
      throw new Error('unexpected-route');
    };
    const base = createDesktopBootstrapHost({ fetcher }), raw = base.session.getNativePreparation(); assert.ok(raw);
    const recovery = createRecoveryClose(base.session, raw, { ...recoveryCloseHost(fetcher), exit: async () => { exits++; } });
    await recovery.close.request(); assert.equal(recovery.close.getSnapshot(), 'failed'); assert.equal(exits, 0);
    assert.equal((await recovery.facade.status(new AbortController().signal)).state, 'running'); assert.equal(statuses, 1);
    await recovery.close.request(); assert.equal(exits, 1); assert.equal(shutdowns, 2);
  } finally { env.restore(); }
});

test('recovery close fences active and synchronously re-entered mutations', async () => {
  let release!: (value: NativePreparationStatus) => void;
  // A facade action remains owned while its promise is unresolved.
  const pending = new Promise<NativePreparationStatus>(resolve => { release = resolve; });
  let starts = 0, attempt: Promise<unknown> | undefined;
  const raw = { status: async () => ({ state: 'idle' as const, scope: 'native-preparation-only' as const }),
    start: async () => { starts++; return pending; }, resume: async () => pending, abandon: async () => pending };
  const recovery = createRecoveryClose({ close: async () => ({ status: 'allowed' }) }, raw, { shutdown: async () => {}, exit: async () => {} });
  const active = recovery.facade.start(new AbortController().signal); await recovery.close.request();
  assert.equal(recovery.close.getSnapshot(), 'refused'); release({ state: 'running', scope: 'native-preparation-only' }); await active;
  recovery.close.subscribe(() => { if (recovery.close.getSnapshot() === 'closing') attempt = recovery.facade.start(new AbortController().signal); });
  await recovery.close.request(); await assert.rejects(attempt!, /maintenance-operation-pending/); assert.equal(starts, 1);
});

for (const failed of ['session', 'exit'] as const) test(`recovery retains confirmed drain after ${failed} failure`, async () => {
  let shutdowns = 0, closes = 0, exits = 0;
  const value: NativePreparationStatus = { state: 'idle', scope: 'native-preparation-only' };
  const raw = { status: async () => value, start: async () => value, resume: async () => value, abandon: async () => value };
  const recovery = createRecoveryClose({ close: async () => { closes++; if (failed === 'session' && closes === 1) throw new Error('transient'); return { status: 'allowed' }; } }, raw,
    { shutdown: async () => { shutdowns++; }, exit: async () => { exits++; if (failed === 'exit' && exits === 1) throw new Error('transient'); } });
  await recovery.close.request(); assert.equal(recovery.close.getSnapshot(), 'failed');
  await assert.rejects(recovery.facade.start(new AbortController().signal), /maintenance-operation-pending/);
  await recovery.close.request(); assert.equal(shutdowns, 1); assert.equal(exits, failed === 'exit' ? 2 : 1);
});

/** Test double for the loopback sidecar: records every request, enforces the bearer, and answers like the D2 routes. */
function sidecar(options: { grant?: 'absent' | 'ready'; hold?: unknown; presence?: unknown; maintenance?: unknown } = {}) {
  const seen: { path: string; lease: string | null; admission: string | null; body: unknown }[] = [];
  let provisioned = options.grant === 'ready', request: CanonicalInitializeRequest | null = null, executed = false;
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(init?.method, 'POST');
    assert.equal(headers.get('Authorization'), 'Bearer unit-test-token');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path: url.pathname, lease: headers.get('X-Papeer-Host-Lease'), admission: headers.get('X-Papeer-Admission'), body });
    const receipt = () => request && ({ requestId: request.control.id, identity: request.profile.identity,
      initialScope: request.control.transition.publication.manifest.scope, manifestId: request.control.transition.publication.manifest.id, peerId: peer.peerId });
    switch (url.pathname) {
      case '/api/edits/legacy-maintenance/status': return json(options.maintenance ?? { state: 'idle', scope: 'native-preparation-only' });
      case bootstrapRoutes.hold: return json(options.hold ?? null);
      case bootstrapRoutes.legacyPresence: return json(options.presence ?? 'clear');
      case bootstrapRoutes.readContext: return json(provisioned ? { status: 'ready', leaseId: 'lease-read' } : { status: 'setup-required', reason: 'absent' });
      case bootstrapRoutes.provisionContext: provisioned = true; return json({ status: 'ready', leaseId: 'lease-provision' });
      case bootstrapRoutes.discover: return json({ libraries: [], creations: [], canCreateLibrary: true });
      case bootstrapRoutes.peer: return json(peer);
      case bootstrapRoutes.prepare: request = structuredClone(body.request); return json({ status: 'pending' });
      case bootstrapRoutes.execute: executed = true; return json({ status: 'accepted', receipt: receipt() });
      case bootstrapRoutes.query: return json(executed ? { status: 'accepted', receipt: receipt() } : request ? { status: 'pending' } : { status: 'not-found' });
      case bootstrapRoutes.release: return json({ status: 'released' });
      default: throw new Error('unexpected route ' + url.pathname);
    }
  };
  return { fetcher, seen, paths: () => seen.map(item => item.path) };
}

/** Node has no window; give the driver the few globals it reads and restore them afterwards. */
function browserGlobals(token: string | undefined) {
  const target = globalThis as Record<string, unknown>;
  const saved = { window: target.window, addEventListener: target.addEventListener, removeEventListener: target.removeEventListener,
    indexedDB: target.indexedDB, localStorage: target.localStorage };
  const listeners = new Map<string, Set<() => void>>();
  target.window = { __PAPEER_PORT: 4321, ...(token ? { __PAPEER_TOKEN: token } : {}) };
  // The Node tests use an empty browser storage platform. Native browser admission is exercised in real Tauri.
  target.localStorage = { length: 0, key: () => null, getItem: () => null };
  target.indexedDB = { databases: async () => [], open: () => {
    const request: { error: DOMException | null; transaction: { abort(): void };
      onupgradeneeded: (() => void) | null; onerror: (() => void) | null } = {
      error: null, transaction: { abort() { queueMicrotask(() => { request.error = new DOMException('Missing database', 'AbortError'); request.onerror?.(); }); } },
      onupgradeneeded: null, onerror: null,
    };
    queueMicrotask(() => request.onupgradeneeded?.());
    return request;
  } };
  target.addEventListener = (name: string, listener: () => void) => { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(listener); };
  target.removeEventListener = (name: string, listener: () => void) => { listeners.get(name)?.delete(listener); };
  return {
    listeners,
    restore() {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete target[key]; else target[key] = value; }
    },
  };
}

test('PC factory: explicit local setup, fixed creation and final close go through the real driver routes only', async () => {
  const env = browserGlobals('unit-test-token');
  try {
    const server = sidecar(), order: string[] = [];
    const { session, close } = createDesktopBootstrapHost({ fetcher: server.fetcher,
      closeHost: { shutdown: async () => { order.push('shutdown'); }, exit: async () => { order.push('exit'); } } });
    await session.start();
    assert.equal(session.getSnapshot().phase, 'setup-required');
    assert.deepEqual(server.paths(), ['/api/edits/legacy-maintenance/status', bootstrapRoutes.hold, bootstrapRoutes.legacyPresence, bootstrapRoutes.readContext]);
    assert.equal(server.seen.every(item => item.lease === null), true);
    await session.provisionLocal();
    assert.equal(session.getSnapshot().phase, 'choosing');
    const discover = server.seen.find(item => item.path === bootstrapRoutes.discover)!;
    assert.equal(discover.lease, 'lease-provision'); assert.deepEqual(discover.body, {});
    await session.createLibrary('Papers'); await flush();
    assert.equal(session.getSnapshot().creation?.stage, 'accepted');
    const prepare = server.seen.find(item => item.path === bootstrapRoutes.prepare)!, execute = server.seen.find(item => item.path === bootstrapRoutes.execute)!;
    const sent = (prepare.body as { request: CanonicalInitializeRequest }).request;
    assert.equal(prepare.lease, 'lease-provision'); assert.equal(sent.profile.title, 'Papers');
    assert.deepEqual(execute.body, { requestId: sent.control.id });
    // After the explicit provision every request carries the lease; none carries a grant, path or namespace chosen by the page.
    const afterProvision = server.seen.slice(server.paths().indexOf(bootstrapRoutes.provisionContext) + 1);
    assert.equal(afterProvision.every(item => item.lease === 'lease-provision'), true);
    await close.request();
    assert.equal(session.getSnapshot().phase, 'closed');
    assert.deepEqual(order, ['shutdown', 'exit']);
    const release = server.seen.filter(item => item.path === bootstrapRoutes.release);
    assert.deepEqual(release.map(item => item.lease), ['lease-provision']);
    assert.equal(env.listeners.get('pagehide')?.size ?? 0, 0, 'driver removes its pagehide listener on close');
  } finally { env.restore(); }
});

test('PC factory: an existing grant reuses a fresh lease; an active hold fails closed before any lease', async () => {
  const env = browserGlobals('unit-test-token');
  try {
    const ready = sidecar({ grant: 'ready' }), first = createDesktopBootstrapHost({ fetcher: ready.fetcher, closeHost: { shutdown: async () => {}, exit: async () => {} } });
    await first.session.start();
    assert.equal(first.session.getSnapshot().phase, 'choosing');
    assert.equal(ready.seen.find(item => item.path === bootstrapRoutes.discover)!.lease, 'lease-read');
    assert.equal(ready.paths().includes(bootstrapRoutes.provisionContext), false, 'cold start never provisions implicitly');
    await first.session.close();

    const held = sidecar({ hold: { version: 1 } }), second = createDesktopBootstrapHost({ fetcher: held.fetcher });
    await second.session.start();
    assert.equal(second.session.getSnapshot().phase, 'recovery-required');
    assert.deepEqual(held.paths(), ['/api/edits/legacy-maintenance/status', bootstrapRoutes.hold], 'a malformed or active hold stops before the local context is read');
    await second.session.close();
  } finally { env.restore(); }
});

test('native bootstrap rejects malformed unknown context and discovery responses', async () => {
  const env = browserGlobals('unit-test-token');
  try {
    let badContext = true;
    const fetcher: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      const value = path === bootstrapRoutes.readContext ? (badContext ? null : { status: 'ready', leaseId: 'lease' })
        : path === bootstrapRoutes.discover ? { libraries: [null], creations: [], canCreateLibrary: true } : {};
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const driver = createDesktopBootstrapHostDriver(fetcher), signal = new AbortController().signal;
    await assert.rejects(driver.readLocalContext(signal), /invalid-context-response/);
    badContext = false;
    const result = await driver.readLocalContext(signal);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    await assert.rejects(driver.discover(result.lease, signal), /invalid-discovery-response/);
    await driver.close();
  } finally { env.restore(); }
});

test('PC startup refuses legacy data without a hold, and rejects unverified presence', async () => {
  const env = browserGlobals('unit-test-token');
  try {
    for (const presence of ['legacy-present', { status: 'clear' }]) {
      const server = sidecar({ presence });
      const host = createDesktopBootstrapHost({ fetcher: server.fetcher });
      await host.session.start();
      assert.equal(host.session.getSnapshot().phase, 'recovery-required');
      assert.deepEqual(server.paths(), ['/api/edits/legacy-maintenance/status', bootstrapRoutes.hold, bootstrapRoutes.legacyPresence]);
      await host.session.close();
    }
  } finally { env.restore(); }
});

test('PC startup checks separate maintenance status before any hold or grant read', async () => {
  const env = browserGlobals('unit-test-token');
  try {
    for (const maintenance of [{ state: 'recovery-required', phase: 'not-collected', scope: 'native-preparation-only' }, { state: 'idle' }]) {
      const server = sidecar({ maintenance }), host = createDesktopBootstrapHost({ fetcher: server.fetcher });
      await host.session.start();
      assert.equal(host.session.getSnapshot().phase, 'recovery-required');
      assert.deepEqual(server.paths(), ['/api/edits/legacy-maintenance/status']);
      await host.session.close();
    }
  } finally { env.restore(); }
});

test('retained Native proof classification survives pagehide and close without restoring any authority', async () => {
  const env = browserGlobals('unit-test-token');
  const scope = { accountId: '00000000-0000-4000-8000-000000000011', libraryId: '00000000-0000-4000-8000-000000000012', epoch: '00000000-0000-4000-8000-000000000013' };
  const signal = new AbortController().signal, seen: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname, headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer unit-test-token');assert.equal(init?.method, 'POST');
    seen.push(pathname);
    const admission = { scope, peerId: peer.peerId, fingerprint: 'a'.repeat(64) };
    let value: unknown;
    switch (pathname) {
      case bootstrapRoutes.readContext: value = { status: 'ready', leaseId: 'local-lease' };break;
      case bootstrapRoutes.discover: value = { libraries: [{ handleId: 'local-library', title: 'Local', status: 'available' }], creations: [], canCreateLibrary: true };break;
      case bootstrapRoutes.inspect: value = { ...admission, admissionId: 'admission' };break;
      case bootstrapRoutes.revalidate: value = admission;break;
      case '/api/edits/provider-owner/connect': value = {};break;
      case '/api/edits/provider-owner/status': value = { connecting: false };break;
      case '/api/edits/provider-owner/finish-connect': value = { leaseId: 'provider-lease', operationId: 'provider-operation' };break;
      case '/api/edits/provider-owner/open-installed': value = { leaseId: 'provider-lease', handleId: 'provider-library', requestId: crypto.randomUUID() };break;
      case '/api/edits/provider-owner/replication/open': value = { replicationId: 'replication' };break;
      case bootstrapRoutes.release: value = {};break;
      default: throw new Error('unexpected operational HTTP ' + pathname);
    }
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const driver = createDesktopBootstrapHostDriver(fetcher), other = createDesktopBootstrapHostDriver(fetcher);
  try {
    const issueLocal = async (owner: typeof driver) => {
      const context = await owner.readLocalContext(signal);assert.equal(context.status, 'ready');
      if (context.status !== 'ready') throw new Error('expected local lease');
      const discovery = await owner.discover(context.lease, signal);
      return owner.inspect(context.lease, discovery.libraries[0].handle, signal);
    };
    const local = await issueLocal(driver), foreign = await issueLocal(other);
    const provider = driver.getProvider!()!, grant = await provider.connect(signal);
    const target = await provider.openInstalled(grant, crypto.randomUUID(), signal);
    const cloud = await driver.inspect(target.lease, target.handle, signal);
    const resources = await Promise.all([driver.openScope(local, signal), driver.openScope(cloud, signal)]);
    const replication = await driver.openReplication!(cloud, signal);
    const forged = { scope: cloud.scope } as ActiveLibraryProof;
    const classify = () => {
      assert.equal(driver.storageKind!(local), 'local');assert.equal(driver.storageKind!(cloud), 'google-drive');
      assert.throws(() => driver.storageKind!(forged), /invalid-admission/);
      assert.throws(() => driver.storageKind!(foreign), /invalid-admission/);
      assert.throws(() => other.storageKind!(cloud), /invalid-admission/);
    };
    const denied = async () => {
      const before = seen.length;
      for (const [index, proof] of [local, cloud].entries()) {
        await assert.rejects(driver.revalidate(proof, signal), /invalid-admission/);
        await assert.rejects(driver.openScope(proof, signal), /invalid-admission/);
        await assert.rejects(resources[index].repository.read(scope.libraryId), /gate-operation-stale/);
        await assert.rejects(resources[index].repository.storeResource({ id: crypto.randomUUID(), bytes: new Uint8Array([1]), sha256: 'a'.repeat(64), mediaType: 'application/octet-stream' }), /gate-operation-stale/);
        await assert.rejects(resources[index].reauthorize!(proof, signal), /invalid-admission/);
        await assert.rejects(async () => driver.openReplication!(proof, signal), /provider-unavailable/);
      }
      await assert.rejects(replication.flush(), /provider-unavailable/);
      assert.equal(seen.length, before, 'retired capabilities cannot dispatch HTTP');
    };
    classify();
    const observed: string[] = [];
    driver.subscribeInvalidation(() => observed.push(driver.storageKind!(cloud)));
    assert.doesNotThrow(() => { for (const callback of [...env.listeners.get('pagehide')!]) callback(); });
    assert.ok(observed.length > 0);assert.ok(observed.every(kind => kind === 'google-drive'));
    classify();await denied();
    await driver.close();await other.close();
    classify();await denied();
  } finally { await driver.close();await other.close();env.restore(); }
});

test('close controller never forces: a refusal keeps the window, a grant stops the sidecar before exit', async () => {
  const order: string[] = []; let allowed = false, shutdownFails = false;
  const session = { close: async () => { order.push('close'); return allowed ? { status: 'allowed' as const } : { status: 'refused' as const, reason: 'dirty', targets: [] }; } };
  const controller = createDesktopCloseController(session, { shutdown: async () => { order.push('shutdown'); if (shutdownFails) throw new Error('gone'); }, exit: async () => { order.push('exit'); } });
  const states: string[] = []; controller.subscribe(() => states.push(controller.getSnapshot()));
  await controller.request();
  assert.deepEqual(order, ['close']); assert.equal(controller.getSnapshot(), 'refused');
  allowed = true; shutdownFails = true;
  await Promise.all([controller.request(), controller.request()]);
  assert.deepEqual(order, ['close', 'close', 'shutdown', 'exit'], 'concurrent requests share one flight and an unreachable sidecar does not keep the window');
  assert.deepEqual(states, ['closing', 'refused', 'closing']);
  const failing = createDesktopCloseController({ close: async () => ({ status: 'allowed' as const }) }, { shutdown: async () => {}, exit: async () => { throw new Error('exit'); } });
  await failing.request(); assert.equal(failing.getSnapshot(), 'failed');
});


test('Native replication coalesces one trailing pass without losing later work or stop fences', { timeout: 30_000 }, async () => {
  const env = browserGlobals('unit-test-token');
  const scope = { accountId: '00000000-0000-4000-8000-000000000011', libraryId: '00000000-0000-4000-8000-000000000012', epoch: '00000000-0000-4000-8000-000000000013' };
  const signal = new AbortController().signal, seen: string[] = [];
  let committedRevision = 0, tearingDown = false;
  const inFlight = new Set<Promise<void>>();
  const watch = (promise: Promise<void>) => { inFlight.add(promise); void promise.catch(() => undefined); return promise; };
  const held: { path: string; snapshot: number; answer(value: { running: boolean; suspended: boolean; error: string }): void; fail(): void }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer unit-test-token');
    seen.push(pathname);
    if (pathname.endsWith('/replication/flush') || pathname.endsWith('/replication/resume')) {
      if (tearingDown) return new Response(JSON.stringify({ running: false, suspended: false, error: '' }));
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        held.push({ path: pathname, snapshot: committedRevision,
          answer: value => { if (settled) return; settled = true; resolve(new Response(JSON.stringify(value))); },
          fail: () => { if (settled) return; settled = true; reject(new Error('synthetic reply lost')); } });
      });
    }
    const admission = { scope, peerId: peer.peerId, fingerprint: 'a'.repeat(64) };
    let value: unknown;
    switch (pathname) {
      case '/api/edits/provider-owner/connect': value = {}; break;
      case '/api/edits/provider-owner/status': value = { connecting: false }; break;
      case '/api/edits/provider-owner/finish-connect': value = { leaseId: 'provider-lease', operationId: 'provider-operation' }; break;
      case '/api/edits/provider-owner/open-installed': value = { leaseId: 'provider-lease', handleId: 'provider-library', requestId: crypto.randomUUID() }; break;
      case bootstrapRoutes.inspect: value = { ...admission, admissionId: 'admission' }; break;
      case '/api/edits/provider-owner/replication/open': value = { replicationId: 'replication' }; break;
      case '/api/edits/provider-owner/replication/suspend': value = { running: false, suspended: true, error: '' }; break;
      case bootstrapRoutes.release: value = {}; break;
      default: throw new Error('unexpected operational HTTP ' + pathname);
    }
    return new Response(JSON.stringify(value));
  };
  const driver = createDesktopBootstrapHostDriver(fetcher), idle = { running: false, suspended: false, error: '' };
  try {
    const provider = driver.getProvider!()!, grant = await provider.connect(signal);
    const target = await provider.openInstalled(grant, crypto.randomUUID(), signal), proof = await driver.inspect(target.lease, target.handle, signal);
    const actual = await driver.openReplication!(proof, signal);
    const replication = { ...actual, flush: () => watch(actual.flush()), resume: () => watch(actual.resume()),
      suspendAndWait: () => watch(actual.suspendAndWait()) };
    const first = replication.flush(); await flush(); assert.equal(held.length, 1); assert.equal(held[0].snapshot, 0);
    assert.equal(replication.getSnapshot().running, true, 'pending actual HTTP is busy before any server snapshot');
    const busySnapshot = replication.getSnapshot(); assert.equal(replication.getSnapshot(), busySnapshot, 'snapshot identity stays stable without a state transition');
    // A commit after the first pass's pending-records snapshot needs a later pass.
    committedRevision = 1;
    const second = replication.flush(), third = replication.flush(); assert.equal(second, third); assert.equal(second, first);
    await flush(); assert.equal(held.length, 1, 'overlap queues once rather than issuing concurrent HTTP');
    held[0].answer(idle); await first; await flush(); assert.equal(held.length, 2); assert.equal(held[1].snapshot, 1);
    await Promise.all([second, third]);
    assert.equal(held.length, 2, 'joined callers complete while the retained tail is still held');
    assert.equal(replication.getSnapshot().running, true, 'busy stays continuous while the queued tail becomes active');
    let tailNotifications = 0; const unsubscribeTail = replication.subscribe(() => { tailNotifications++; });
    held[1].fail(); await flush();
    assert.equal(replication.getSnapshot().error, 'provider-replication-failed', 'unawaited tail failure is observable');
    assert.ok(tailNotifications > 0); unsubscribeTail();
    assert.equal(replication.getSnapshot().running, false, 'failed tail is idle after actual work settles');
    const failed = replication.flush(); const failedObserved = assert.rejects(failed, /synthetic reply lost/);
    await flush(); assert.equal(held.length, 3); held[2].fail(); await failedObserved;

    const active = replication.flush(); await flush(); const queued = replication.flush();
    assert.equal(queued, active, 'queued work does not replace the current public flight');
    let drained = false; const stop = replication.suspendAndWait().then(() => { drained = true; });
    await flush(); assert.ok(seen.some(path => path.endsWith('/replication/suspend'))); assert.equal(drained, false);
    assert.equal(held.length, 4, 'queued pass must not dispatch after suspend');
    assert.equal(replication.getSnapshot().running, false, 'suspend retires old-epoch busy while actual drain remains pending');
    held[3].answer({ running: true, suspended: false, error: '' }); await active; await stop;
    assert.equal(replication.getSnapshot().suspended, true, 'late old response cannot revive the stopped epoch');

    const resumed = replication.resume(); await flush(); assert.equal(held.length, 5);
    assert.equal(replication.getSnapshot().running, true, 'pending resume is busy even before the backend reports its state');
    const requestedAfterResume = replication.flush(); await flush(); assert.equal(held.length, 5);
    held[4].answer(idle); await Promise.all([resumed, requestedAfterResume]); await flush(); assert.equal(held.length, 6);
    assert.equal(replication.getSnapshot().running, true, 'resume completion cannot expose idle between its retained tail');
    held[5].answer(idle); await requestedAfterResume; await flush();
    assert.equal(replication.getSnapshot().running, false, 'resume and all retained tail HTTP settled');
    const old = replication.flush(); await flush(); const newer = replication.resume(); await flush();
    held[7].answer(idle); await newer; held[6].answer({ running: true, suspended: false, error: '' }); await old;
    assert.equal(replication.getSnapshot().running, false, 'old-epoch running response cannot overwrite newer idle');
    const stale = replication.flush(); await flush(); const latest = replication.resume(); await flush();
    held[8].answer(idle); await stale;
    assert.equal(replication.getSnapshot().running, true, 'old-epoch idle completion cannot clear a newer pending resume');
    held[9].answer(idle); await latest;
    assert.equal(replication.getSnapshot().running, false, 'newer resume alone determines current idle');

    const retiring = replication.flush(); await flush(); const notDispatched = replication.flush();
    const retired = [assert.rejects(retiring, /host-unavailable|provider-unavailable/), assert.rejects(notDispatched, /host-unavailable|provider-unavailable/)];
    const beforeInvalidation = held.length;
    for (const callback of [...env.listeners.get('pagehide')!]) callback();
    held[10].answer(idle); await Promise.all(retired); await flush();
    assert.equal(held.length, beforeInvalidation, 'grant invalidation denies queued HTTP');
  } finally {
    tearingDown = true;
    for (const reply of held) reply.answer(idle);
    await Promise.allSettled([...inFlight]);
    try { await driver.close(); } finally { env.restore(); }
  }
});


test('Native direct replication failure is observable, retry clears it, and retired failures cannot publish', { timeout: 30_000 }, async () => {
  const env = browserGlobals('unit-test-token');
  const scope = { accountId: '00000000-0000-4000-8000-000000000011', libraryId: '00000000-0000-4000-8000-000000000012', epoch: '00000000-0000-4000-8000-000000000013' };
  const signal = new AbortController().signal, idle = { running: false, suspended: false, error: '' };
  let tearingDown = false;
  const inFlight = new Set<Promise<void>>();
  const watch = (promise: Promise<void>) => { inFlight.add(promise); void promise.catch(() => undefined); return promise; };
  const held: { answer(): void; fail(): void }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer unit-test-token');
    if (pathname.endsWith('/replication/flush') || pathname.endsWith('/replication/resume')) {
      if (tearingDown) return new Response(JSON.stringify(idle));
      return new Promise<Response>(resolve => {
        let settled = false;
        const reply = (response: Response) => { if (settled) return; settled = true; resolve(response); };
        held.push({ answer: () => reply(new Response(JSON.stringify(idle))), fail: () => reply(new Response('{}', { status: 400 })) });
      });
    }
    let value: unknown;
    switch (pathname) {
      case '/api/edits/provider-owner/connect': value = {}; break;
      case '/api/edits/provider-owner/status': value = { connecting: false }; break;
      case '/api/edits/provider-owner/finish-connect': value = { leaseId: 'provider-lease', operationId: 'provider-operation' }; break;
      case '/api/edits/provider-owner/open-installed': value = { leaseId: 'provider-lease', handleId: 'provider-library', requestId: crypto.randomUUID() }; break;
      case bootstrapRoutes.inspect: value = { scope, peerId: peer.peerId, fingerprint: 'a'.repeat(64), admissionId: 'admission' }; break;
      case '/api/edits/provider-owner/replication/open': value = { replicationId: 'replication' }; break;
      case '/api/edits/provider-owner/replication/suspend': value = { ...idle, suspended: true }; break;
      case bootstrapRoutes.release: value = {}; break;
      default: throw new Error('unexpected operational HTTP ' + pathname);
    }
    return new Response(JSON.stringify(value));
  };
  const driver = createDesktopBootstrapHostDriver(fetcher);
  try {
    const provider = driver.getProvider!()!, grant = await provider.connect(signal);
    const target = await provider.openInstalled(grant, crypto.randomUUID(), signal), proof = await driver.inspect(target.lease, target.handle, signal);
    const replication = await driver.openReplication!(proof, signal);
    let notifications = 0, previousError = replication.getSnapshot().error; replication.subscribe(() => { const error=replication.getSnapshot().error; if (error && error !== previousError) notifications++; previousError=error; });
    assert.equal(replication.getSnapshot().error, '');
    const direct = watch(replication.flush()), directRejected = assert.rejects(direct, /native-request-failed/);
    await flush(); assert.equal(held.length, 1); held[0].fail(); await directRejected;
    assert.equal(replication.getSnapshot().error, 'provider-replication-failed');
    assert.equal(notifications, 1, 'direct rejected RPC publishes one generic failure');
    const retry = watch(replication.flush()); await flush(); assert.equal(held.length, 2); held[1].answer(); await retry;
    assert.equal(replication.getSnapshot().error, '', 'same current grant successful retry clears the banner');

    const old = watch(replication.flush()), oldRejected = assert.rejects(old, /native-request-failed/);
    await flush(); const current = watch(replication.resume()); await flush(); assert.equal(held.length, 4);
    held[3].answer(); await current; const afterCurrent = replication.getSnapshot(), currentNotifications = notifications;
    held[2].fail(); await oldRejected;
    assert.equal(replication.getSnapshot(), afterCurrent); assert.equal(notifications, currentNotifications, 'old epoch failure is ignored');

    const retiring = watch(replication.flush()), retiringRejected = assert.rejects(retiring, /native-request-failed/);
    await flush(); const stop = watch(replication.suspendAndWait()); await flush();
    const suspended = replication.getSnapshot(), suspendedNotifications = notifications;
    held[4].fail(); await retiringRejected; await stop;
    assert.equal(replication.getSnapshot(), suspended); assert.equal(notifications, suspendedNotifications, 'suspended epoch failure is ignored');

    const resumed = watch(replication.resume()); await flush(); held[5].answer(); await resumed;
    const revoked = watch(replication.flush()), revokedRejected = assert.rejects(revoked, /host-unavailable|provider-unavailable|native-request-failed/);
    await flush(); const beforeRevoke = replication.getSnapshot(), beforeNotifications = notifications;
    for (const callback of [...env.listeners.get('pagehide')!]) callback();
    held[6].fail(); await revokedRejected;
    assert.equal(replication.getSnapshot(), beforeRevoke); assert.equal(notifications, beforeNotifications, 'revoked grant failure is ignored');
    assert.equal(held.length, 7, 'failure reporting never starts another HTTP pass');
  } finally {
    tearingDown = true; for (const reply of held) reply.answer();
    await Promise.allSettled([...inFlight]);
    try { await driver.close(); } finally { env.restore(); }
  }
});


test('pagehide during retained resume cancels its attempt and cannot adopt the late grant', async () => {
  const env = browserGlobals('unit-test-token'), signal = new AbortController().signal;
  const requestId = crypto.randomUUID(), calls: string[] = [];
  let deliver!: (value: Response) => void, started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path.endsWith('/resume-retained')) { started(); return new Promise(resolve => { deliver = resolve; }); }
    let value: unknown = {};
    if (path.endsWith('/status')) value = { connecting: false };
    else if (path.endsWith('/finish-connect')) value = { leaseId:'old-lease', operationId:'old-op' };
    else if (path.endsWith('/open-installed')) value = { leaseId:'old-lease', handleId:'old-handle', requestId };
    return new Response(JSON.stringify(value));
  };
  const driver = createDesktopBootstrapHostDriver(fetcher);
  try {
    const provider = driver.getProvider!()!, original = await provider.connect(signal);
    await provider.openInstalled(original, requestId, signal);
    for (const callback of [...env.listeners.get('pagehide')!]) callback();
    const flight = provider.resumeRetained!(requestId, signal); await pending;
    for (const callback of [...env.listeners.get('pagehide')!]) callback();
    deliver(new Response(JSON.stringify({ leaseId:'new-lease', operationId:'new-op',
      installed:{ leaseId:'new-lease', handleId:'new-handle', requestId } })));
    assert.equal(await flight, null);
    assert.ok(calls.some(path => path.endsWith('/cancel-resume')));
    assert.ok(calls.some(path => path.endsWith('/discard-resumed')));
    await assert.rejects(provider.list(original, signal), /provider-unavailable/);
  } finally { await driver.close(); env.restore(); }
});


test('retired Native replication drains held HTTP without old STOP authority and fresh admission stays usable', { timeout: 10_000 }, async () => {
  const env = browserGlobals('unit-test-token'), signal = new AbortController().signal;
  const scope = { accountId: '00000000-0000-4000-8000-000000000011', libraryId: '00000000-0000-4000-8000-000000000012', epoch: '00000000-0000-4000-8000-000000000013' };
  const requestId = crypto.randomUUID(), idle = { running: false, suspended: false, error: '' };
  const seen: { path: string; lease: string | null; operation: string | null }[] = [], inFlight = new Set<Promise<void>>();
  const watch = (promise: Promise<void>) => { inFlight.add(promise); void promise.catch(() => undefined); return promise; };
  let releaseOld: (() => void) | undefined, oldSignal: AbortSignal | null | undefined, failLiveStop = false, tearingDown = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, headers = new Headers(init?.headers), lease = headers.get('X-Papeer-Host-Lease');
    assert.equal(headers.get('Authorization'), 'Bearer unit-test-token');
    seen.push({ path, lease, operation: headers.get('X-Papeer-Provider-Operation') });
    if (path.endsWith('/replication/flush') && lease === 'old-lease' && !tearingDown) {
      oldSignal = init?.signal;
      return new Promise<Response>(resolve => { let done = false; releaseOld = () => { if (!done) { done = true; resolve(new Response(JSON.stringify(idle))); } }; });
    }
    if (path.endsWith('/replication/suspend') && failLiveStop && !tearingDown) return new Response('{}', { status: 400 });
    let value: unknown;
    if (path.endsWith('/connect')) value = {};
    else if (path.endsWith('/status')) value = { connecting: false };
    else if (path.endsWith('/finish-connect')) value = { leaseId: 'old-lease', operationId: 'old-op' };
    else if (path.endsWith('/open-installed')) value = { leaseId: 'old-lease', handleId: 'old-handle', requestId };
    else if (path.endsWith('/resume-retained')) {
      assert.equal(lease, 'old-lease'); assert.equal(headers.get('X-Papeer-Provider-Operation'), 'old-op');
      assert.equal(JSON.parse(String(init?.body)).requestId, requestId);
      value = { leaseId: 'fresh-lease', operationId: 'fresh-op', installed: { leaseId: 'fresh-lease', handleId: 'fresh-handle', requestId } };
    } else if (path === bootstrapRoutes.inspect) value = { scope, peerId: peer.peerId, fingerprint: 'a'.repeat(64), admissionId: lease === 'fresh-lease' ? 'fresh-admission' : 'old-admission' };
    else if (path === bootstrapRoutes.revalidate) value = { scope, peerId: peer.peerId, fingerprint: 'a'.repeat(64) };
    else if (path.endsWith('/replication/open')) value = { replicationId: lease === 'fresh-lease' ? 'fresh-replication' : 'old-replication' };
    else if (path.includes('/replication/')) value = path.endsWith('/suspend') ? { ...idle, suspended: true } : idle;
    else if (path.endsWith('/acknowledge-resume') || path.endsWith('/cancel-resume') || path.endsWith('/discard-resumed') || path === bootstrapRoutes.release) value = {};
    else throw new Error('unexpected operational HTTP ' + path);
    return new Response(JSON.stringify(value));
  };
  const driver = createDesktopBootstrapHostDriver(fetcher);
  try {
    const provider = driver.getProvider!()!, original = await provider.connect(signal), target = await provider.openInstalled(original, requestId, signal);
    const oldProof = await driver.inspect(target.lease, target.handle, signal), old = await driver.openReplication!(oldProof, signal);
    const pending = watch(old.flush()), rejected = assert.rejects(pending, /host-unavailable|provider-unavailable/);
    await flush(); assert.ok(releaseOld); const queued = watch(old.flush()); assert.equal(queued, pending);
    for (const callback of [...env.listeners.get('pagehide')!]) callback();
    assert.equal(oldSignal?.aborted, true, 'pagehide aborts the actual owned HTTP signal');
    const callsBeforeDrain = seen.length; let settled = false;
    const drain = watch(old.suspendAndWait()); void drain.then(() => { settled = true; }, () => { settled = true; });
    await flush(); assert.equal(settled, false, 'local retired stop still awaits the actual unsettled HTTP');
    assert.equal(seen.length, callsBeforeDrain, 'retired stop cannot dispatch old authority');
    releaseOld!(); await rejected; await drain;
    assert.equal(old.getSnapshot().suspended, true);
    const afterDrain = seen.length;
    await assert.rejects(old.flush(), /provider-unavailable/); await assert.rejects(old.resume(), /provider-unavailable/);
    assert.equal(seen.length, afterDrain, 'retired flush/resume and cancelled tail cannot dispatch HTTP');
    const resumed = await provider.resumeRetained!(requestId, signal); assert.ok(resumed); assert.notEqual(resumed.grant, original);
    const freshProof = await driver.inspect(resumed.target.lease, resumed.target.handle, signal);
    assert.equal(driver.sameAdmission(oldProof, freshProof), true); await driver.revalidate(freshProof, signal);
    const fresh = await driver.openReplication!(freshProof, signal); await provider.settleRetainedResume!(resumed.grant, true); await fresh.flush();
    assert.ok(seen.some(row => row.path.endsWith('/replication/flush') && row.lease === 'fresh-lease' && row.operation === 'fresh-op'));
    assert.equal(seen.filter(row => row.path.endsWith('/connect')).length, 1, 'retained readmission never starts OAuth again');
    failLiveStop = true; await assert.rejects(fresh.suspendAndWait(), /native-request-failed/);
    assert.equal(seen.filter(row => row.path.endsWith('/replication/suspend') && row.lease === 'fresh-lease').length, 1, 'live stop still reaches authority and propagates failure');
    assert.equal(seen.filter(row => row.path.endsWith('/replication/suspend') && row.lease === 'old-lease').length, 0);
  } finally {
    tearingDown = true; releaseOld?.(); await Promise.allSettled([...inFlight]);
    try { await driver.close(); } finally { env.restore(); }
  }
});

// The actual driver owns the leases/proofs. Only loopback transport is synthetic;
// no authority object is passed into the factory or resurrected after pagehide.
async function nativeWireDenialHarness() {
  const env = browserGlobals('unit-test-token'), caller = new AbortController();
  const scope = { accountId: '00000000-0000-4000-8000-000000000021', libraryId: '00000000-0000-4000-8000-000000000022', epoch: '00000000-0000-4000-8000-000000000023' };
  const leases = new Set<string>(); let sequence = 0;
  let deny: { status: number; held: 'fetch' | 'json' | null; entered(): void; release?: () => void; signal?: AbortSignal | null } | undefined;
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, headers = new Headers(init?.headers), lease = headers.get('X-Papeer-Host-Lease');
    assert.equal(headers.get('Authorization'), 'Bearer unit-test-token');
    if (path === bootstrapRoutes.readContext) {
      const leaseId = `wire-lease-${++sequence}`; leases.add(leaseId); return reply({ status: 'ready', leaseId });
    }
    if (path === bootstrapRoutes.release) return reply({});
    assert.ok(lease && leases.has(lease), 'transport receives only a lease issued through the actual driver');
    if (path === bootstrapRoutes.discover) return reply({ libraries: [{ handleId: `handle-${lease}`, title: 'Current local Library', status: 'available' }], creations: [], canCreateLibrary: true });
    if (path === bootstrapRoutes.inspect) return reply({ scope, peerId: peer.peerId, fingerprint: 'd'.repeat(64), admissionId: `admission-${lease}` });
    assert.equal(headers.get('X-Papeer-Admission'), `admission-${lease}`);
    if (path === bootstrapRoutes.revalidate && deny) {
      const fault = deny; deny = undefined; fault.signal = init?.signal;
      const body = { detail: fault.status === 403 ? 'canonical-authority-denied' : 'unauthorized' };
      if (fault.held === 'fetch') return new Promise<Response>(resolve => {
        let settled = false; fault.release = () => { if (!settled) { settled = true; resolve(reply(body, fault.status)); } }; fault.entered();
      });
      const response = reply(body, fault.status);
      if (fault.held === 'json') Object.defineProperty(response, 'json', { value: () => new Promise<unknown>(resolve => {
        let settled = false; fault.release = () => { if (!settled) { settled = true; resolve(body); } }; fault.entered();
      }) });
      else fault.entered();
      return response;
    }
    if (path === bootstrapRoutes.revalidate) return reply({ scope, peerId: peer.peerId, fingerprint: 'd'.repeat(64) });
    if (path === '/api/edits/pending-records') return reply([]);
    throw new Error('unexpected wire denial test route ' + path);
  };
  const driver = createDesktopBootstrapHostDriver(fetcher);
  const issue = async () => {
    const context = await driver.readLocalContext(caller.signal); assert.equal(context.status, 'ready');
    if (context.status !== 'ready') throw new Error('actual local context required');
    const found = await driver.discover(context.lease, caller.signal);
    const proof = await driver.inspect(context.lease, found.libraries[0].handle, caller.signal);
    return { proof, resources: await driver.openScope(proof, caller.signal) };
  };
  return { env, caller, scope, driver, issue,
    fault(status: number, held: 'fetch' | 'json' | null) {
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      const value = { status, held, entered } as NonNullable<typeof deny>; deny = value;
      return { started, release: () => value.release?.(), signal: () => value.signal };
    },
    hide() { for (const callback of [...env.listeners.get('pagehide')!]) callback(); },
    async close() { try { await driver.close(); } finally { env.restore(); } },
  };
}

for (const status of [401, 403] as const) for (const held of ['fetch', 'json'] as const)
test(`retired Native generic denial ${status} after held ${held} cannot revoke a fresh admission`, { timeout: 10_000 }, async () => {
  const fixture = await nativeWireDenialHarness(); let release: (() => void) | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    const old = await fixture.issue(), fault = fixture.fault(status, held); release = fault.release;
    const rejected = assert.rejects(fixture.driver.revalidate(old.proof, fixture.caller.signal), /Cancelled|host-unavailable|native-request-failed/);
    pending.push(rejected); await fault.started;
    assert.equal(fixture.caller.signal.aborted, false);
    fixture.hide(); assert.equal(fault.signal()?.aborted, true, 'pagehide aborts the actual private wire controller');
    assert.equal(fixture.caller.signal.aborted, false, 'caller acquisition signal remains alive');
    assert.throws(() => old.resources.readerState.read(fixture.scope.libraryId), /gate-operation-stale/);
    const fresh = await fixture.issue(); assert.notEqual(fresh.proof, old.proof);
    await fixture.driver.revalidate(fresh.proof, fixture.caller.signal);
    let invalidations = 0; const unsubscribe = fixture.driver.subscribeInvalidation(() => { invalidations++; });
    try {
      release(); await rejected;
      // BEFORE fix this fails: the old generic non-OK branch globally invalidates the fresh lease.
      await fixture.driver.revalidate(fresh.proof, fixture.caller.signal);
      assert.deepEqual(await fresh.resources.repository.pendingRecords(), []);
      assert.equal(fresh.resources.readerState.read(fixture.scope.libraryId), null);
      assert.deepEqual(fresh.resources.markdownDrafts.targets(), []);
      assert.equal(invalidations, 0, 'late retired denial cannot publish a fresh-owner invalidation');
      await assert.rejects(fixture.driver.revalidate(old.proof, fixture.caller.signal), /invalid-admission/);
    } finally { unsubscribe(); }
  } finally { release?.(); await Promise.allSettled(pending); await fixture.close(); }
});

for (const status of [401, 403] as const)
test(`current Native generic denial ${status} still revokes its actual admission`, { timeout: 10_000 }, async () => {
  const fixture = await nativeWireDenialHarness();
  try {
    const current = await fixture.issue(); let invalidations = 0;
    const unsubscribe = fixture.driver.subscribeInvalidation(() => { invalidations++; });
    try {
      fixture.fault(status, null);
      await assert.rejects(fixture.driver.revalidate(current.proof, fixture.caller.signal), /native-request-failed/);
      assert.ok(invalidations > 0);
      await assert.rejects(fixture.driver.revalidate(current.proof, fixture.caller.signal), /invalid-admission/);
      await assert.rejects(current.resources.repository.pendingRecords(), /gate-operation-stale/);
      assert.throws(() => current.resources.readerState.read(fixture.scope.libraryId), /gate-operation-stale/);
    } finally { unsubscribe(); }
  } finally { await fixture.close(); }
});
