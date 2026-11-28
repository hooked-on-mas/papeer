import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BootstrapSession } from '../src/features/bootstrap/BootstrapSession.ts';
import { createDesktopBootstrapHostDriver } from '../src/adapters/desktop/bootstrapHostDriver.ts';
import { initialRequest } from '../src/features/bootstrap/initialRequest.ts';
import type { BootstrapHostDriver, HostLease, LibraryHandle, ActiveLibraryProof, ScopeResources } from '../src/features/bootstrap/bootstrapPorts.ts';
import type { CanonicalInitializeRequest } from '../src/runtime/edits/contracts.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const peer = { version: 1 as const, accountId: 'fixture-namespace', peerId: id(1) };
const handle = {} as LibraryHandle, lease = {} as HostLease;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
 let pending: CanonicalInitializeRequest | null = null, prepareCalls = 0, executeCalls = 0, losePrepare = false, loseBefore = false, attempted: CanonicalInitializeRequest | null = null, invalidate = () => {}, hold: 'clear' | 'held' = 'clear';
 let gate: Promise<void> | null = null, onGate = () => {}, closed = 0, proofEpoch = 'epoch', driverClosed = 0;
 let reauthFails = false, executePending = false, closeGate: Promise<void> | null = null, closeEntered = () => {};
 let prepareGate: Promise<void> | null = null, executeGate: Promise<void> | null = null, creationEntered = () => {}, creationSignal: AbortSignal | null = null;
 let resourceGate: Promise<void> | null = null, resourceEntered = () => {}, openSignal: AbortSignal | null = null;
 const scope = { accountId: peer.accountId, libraryId: id(2), epoch: 'epoch' };
 const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
 const proof = () => ({ scope: { ...scope, epoch: proofEpoch } } as ActiveLibraryProof);
 const resources = { repository, peerId: peer.peerId, readerState: { scope, read: () => undefined, write: () => {} },
  markdownDrafts: { scope, targets: () => [], read: () => undefined, write: () => {}, remove: () => {} },
  markdownImages: { scope }, appendDrafts: { scope, read: () => undefined }, reauthorize: async () => { if (reauthFails) throw new Error('reauthorize-denied'); }, close: async () => { closed++; resourceEntered(); if (resourceGate) await resourceGate; } } as unknown as ScopeResources;
 const api = { getOrCreatePeer: async () => peer,
  prepare: async (value: CanonicalInitializeRequest, signal: AbortSignal) => { prepareCalls++; creationSignal = signal; attempted = structuredClone(value); if (loseBefore) { loseBefore = false; throw new Error('lost-before-commit'); } if (pending && JSON.stringify(pending) !== JSON.stringify(value)) throw new Error('changed'); pending = structuredClone(value); if (prepareGate) { creationEntered(); await prepareGate; } if (losePrepare) { losePrepare = false; throw new Error('lost'); } return { status: 'pending' as const }; },
  query: async () => pending ? { status: 'pending' as const } : { status: 'not-found' as const },
  execute: async (_id: string, signal: AbortSignal) => { executeCalls++; creationSignal = signal; if (!pending) throw new Error('missing'); if (executeGate) { creationEntered(); await executeGate; } if (executePending) return { status: 'pending' as const }; return { status: 'accepted' as const, receipt: { requestId: pending.control.id, identity: pending.profile.identity, initialScope: pending.control.transition.publication.manifest.scope, manifestId: pending.control.transition.publication.manifest.id, peerId: peer.peerId } }; },
  acknowledge: async () => {} };
 const driver: BootstrapHostDriver = { readHold: async () => hold, readLocalContext: async () => ({ status: 'ready', lease }), provisionLocalContext: async () => lease,
  discover: async () => ({ libraries: [{ handle, title: 'one', status: 'available' }], creations: [], canCreateLibrary: true }), initialization: () => api,
  inspect: async () => proof(), openScope: async (_proof, signal) => { openSignal = signal; return resources; }, revalidate: async () => { if (gate) { onGate(); await gate; } }, sameAdmission: (a, b) => a.scope.epoch === b.scope.epoch,
  subscribeInvalidation: fn => { invalidate = fn; return () => { invalidate = () => {}; }; }, close: async () => { driverClosed++; closeEntered(); if (closeGate) await closeGate; } };
 return { driver, repository, scope, invalidate: () => invalidate(), lose: () => { losePrepare = true; }, loseBefore: () => { loseBefore = true; }, setExecutePending: (value: boolean) => { executePending = value; }, attempted: () => attempted, pending: () => pending,
  setCreationGate: (phase: 'prepare' | 'execute', value: Promise<void>, entered: () => void) => { if (phase === 'prepare') prepareGate = value; else executeGate = value; creationEntered = entered; }, creationSignal: () => creationSignal,
  counts: () => ({ prepareCalls, executeCalls, closed, driverClosed }), signal: () => openSignal, setResourceGate: (value: Promise<void>, entered: () => void) => { resourceGate = value; resourceEntered = entered; }, failReauth: () => { reauthFails = true; }, setCloseGate: (value: Promise<void>, entered: () => void) => { closeGate = value; closeEntered = entered; }, setHold: (value: 'clear' | 'held') => { hold = value; }, setGate: (value: Promise<void> | null, entered: () => void = () => {}) => { gate = value; onGate = entered; }, changeEpoch: () => { proofEpoch = 'other'; } };
}

test('builder fixes an empty publication only after the selected peer', async () => {
 let n = 10; const request = await initialRequest('  Library  ', peer, () => id(n++));
 assert.equal(request.profile.title, 'Library'); assert.equal(request.expectedPeerId, peer.peerId);
 assert.equal(request.control.id, request.control.transition.id); assert.equal(request.control.active?.scope.libraryId, request.profile.identity.libraryId);
 assert.equal(request.control.transition.publication.checkpoint.edits.length, 0); assert.equal(request.control.transition.publication.checkpoint.roots.length, 1);
});
test('unknown prepare recovery preserves exact fixed request and only executes durable pending', async () => {
 const f = fixture(), session = new BootstrapSession(f.driver); await session.start(); f.lose(); await session.createLibrary('Name');
 const id = session.getSnapshot().creation!.requestId, original = JSON.stringify(f.pending()); assert.equal(session.getSnapshot().creation?.stage, 'unknown');
 assert.equal(f.counts().executeCalls, 0); await session.recoverCreation(id);
 assert.equal(JSON.stringify(f.pending()), original); assert.equal(session.getSnapshot().creation?.stage, 'accepted'); assert.equal(f.counts().executeCalls, 1);
});
test('pending creation refuses close until recovery and acknowledgement complete', async () => {
 const f = fixture(), session = new BootstrapSession(f.driver); f.setExecutePending(true);
 await session.start(); await session.createLibrary('Pending');
 const requestId = session.getSnapshot().creation?.requestId; assert.ok(requestId);
 assert.equal(session.getSnapshot().creation?.stage, 'pending');
 assert.equal((await session.prepareClose()).status, 'refused');
 assert.equal((await session.close()).status, 'refused');
 assert.equal(session.getSnapshot().creation?.requestId, requestId); assert.equal(f.counts().driverClosed, 0);
 f.setExecutePending(false); await session.recoverCreation(requestId);
 assert.equal(session.getSnapshot().creation?.stage, 'accepted');
 await session.acknowledgeCreation(requestId); assert.equal(session.getSnapshot().creation, null);
 assert.equal((await session.close()).status, 'allowed'); assert.equal(f.counts().driverClosed, 1);
});
for (const phase of ['prepare', 'execute'] as const) test(`close refuses without cancelling in-flight creation ${phase}`, { timeout: 5_000 }, async () => {
 const f = fixture(), session = new BootstrapSession(f.driver), gate = deferred(), entered = deferred();
 f.setCreationGate(phase, gate.promise, entered.resolve); await session.start();
 const creation = session.createLibrary('In flight'); await entered.promise;
 const request = f.pending(); assert.ok(request); const requestId = request.control.id;
 assert.equal(session.getSnapshot().creation?.stage, phase === 'prepare' ? 'preparing' : 'pending');
 try {
  assert.equal((await session.close()).status, 'refused');
  assert.equal(f.creationSignal()?.aborted, false); assert.equal(f.counts().driverClosed, 0);
  assert.equal(session.getSnapshot().creation?.requestId, requestId);
 } finally { gate.resolve(); }
 await creation;
 assert.equal(session.getSnapshot().phase, 'choosing'); assert.equal(session.getSnapshot().creation?.stage, 'accepted');
 assert.equal(session.getSnapshot().creation?.requestId, requestId);
 await session.acknowledgeCreation(requestId); assert.equal((await session.close()).status, 'allowed');
});
test('unknown creation close refusal preserves the same recoverable request', async () => {
 const f = fixture(), session = new BootstrapSession(f.driver); await session.start(); f.lose(); await session.createLibrary('Unknown');
 const requestId = session.getSnapshot().creation?.requestId; assert.ok(requestId);
 assert.equal(session.getSnapshot().creation?.stage, 'unknown'); assert.equal((await session.close()).status, 'refused');
 assert.equal(f.counts().driverClosed, 0); await session.recoverCreation(requestId);
 assert.equal(session.getSnapshot().creation?.requestId, requestId); assert.equal(session.getSnapshot().creation?.stage, 'accepted');
 await session.acknowledgeCreation(requestId); assert.equal((await session.close()).status, 'allowed');
});
test('hold fails closed and stale admission never publishes its candidate', async () => {
 const f = fixture(), session = new BootstrapSession(f.driver); f.setHold('held'); await session.start(); assert.equal(session.getSnapshot().phase, 'recovery-required');
 f.setHold('clear'); await session.start(); const gate = deferred(), entered = deferred(); f.setGate(gate.promise, entered.resolve);
 await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const opening = session.openLibrary(handle); await entered.promise; session.cancelPendingView(); gate.resolve(); await opening;
 assert.equal(session.getActiveRuntime(), null); assert.equal(f.counts().closed, 1);
});
test('retained runtime is one owner; scope guard refusal and ABA loss preserve it', async () => {
 const f = fixture(), session = new BootstrapSession(f.driver); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 await session.start(); await session.openLibrary(handle); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 const release = runtime.binding.sessions.registerScopeViewGuard(() => false); assert.equal((await session.returnToChooser()).status, 'refused'); assert.equal(session.getActiveRuntime(), runtime);
 f.invalidate(); assert.equal(session.getActiveRuntime(), null); assert.equal(session.getRetainedRuntime(), runtime);
 await session.start(); f.changeEpoch(); await session.restoreRetained(); assert.equal(session.getActiveRuntime(), null); assert.equal(session.getRetainedRuntime(), runtime);
 release(); assert.equal(f.counts().closed, 0);
});


test('host loss during pending recovery prevents late registry activation', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 f.invalidate(); await session.start(); const gate = deferred(), entered = deferred(), original = f.repository.pendingIntents;
 f.repository.pendingIntents = async () => { entered.resolve(); await gate.promise; return original(); };
 const restoring = session.restoreRetained(); await entered.promise; f.invalidate(); gate.resolve(); await restoring;
 assert.equal(runtime.binding.sessions.getSnapshot().active, false); assert.equal(session.getActiveRuntime(), null); assert.equal(session.getRetainedRuntime(), runtime);
});

test('failed host gate reauthorization retains locked owner and draft guard', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 const release = runtime.binding.sessions.registerScopeViewGuard(() => false); f.invalidate(); await session.start(); f.failReauth(); await session.restoreRetained();
 assert.equal(session.getActiveRuntime(), null); assert.equal(session.getRetainedRuntime(), runtime); assert.equal(runtime.binding.sessions.getSnapshot().active, false);
 assert.equal((await runtime.binding.sessions.prepareLeave()).status, 'refused'); release();
});

test('concurrent close shares one flight and blocks new start until driver closes', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle); assert.ok(session.getActiveRuntime());
 const gate = deferred(), entered = deferred(); f.setCloseGate(gate.promise, entered.resolve);
 const first = session.close(), second = session.close(); assert.equal(first, second); await entered.promise;
 await session.start(); assert.equal(f.counts().driverClosed, 1); assert.equal(f.counts().closed, 1);
 gate.resolve(); assert.equal((await first).status, 'allowed'); assert.equal((await second).status, 'allowed');
 assert.equal(session.getSnapshot().phase, 'closed'); assert.equal(f.counts().closed, 1); assert.equal(f.counts().driverClosed, 1);
});


test('dirty close refusal preserves admitted gate, active runtime and form owner', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 let text = 'unsaved'; const release = runtime.binding.sessions.registerScopeViewGuard(() => !text);
 assert.equal((await session.close()).status, 'refused'); assert.equal(session.getActiveRuntime(), runtime);
 assert.equal(runtime.binding.sessions.getSnapshot().active, true); assert.equal(f.signal()?.aborted, false); assert.equal(text, 'unsaved');
 assert.equal(f.counts().closed, 0); assert.equal(f.counts().driverClosed, 0); text = ''; release();
});

for (const timing of ['before-transfer', 'after-transfer'] as const) test(`close adopts an existing leave ${timing}`, async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle);
 const readGate = deferred(), readEntered = deferred(), resourceGate = deferred(), resourceEntered = deferred();
 const original = f.repository.pendingIntents; let first = true;
 f.repository.pendingIntents = async () => { if (first) { first = false; readEntered.resolve(); await readGate.promise; } return original(); };
 f.setResourceGate(resourceGate.promise, resourceEntered.resolve);
 const leaving = session.returnToChooser(); await readEntered.promise;
 let closing: Promise<{ status: string }>;
 if (timing === 'before-transfer') { closing = session.close(); readGate.resolve(); await resourceEntered.promise; }
 else { readGate.resolve(); await resourceEntered.promise; closing = session.close(); }
 const repeated = session.close(); assert.equal(closing, repeated); resourceGate.resolve();
 assert.equal((await leaving).status, 'allowed'); assert.equal((await closing).status, 'allowed');
 assert.equal(f.counts().closed, 1); assert.equal(f.counts().driverClosed, 1); assert.equal(session.getSnapshot().phase, 'closed');
});

test('close cancels an unadmitted candidate and waits for its one cleanup', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); const gate = deferred(), entered = deferred(); f.setGate(gate.promise, entered.resolve);
 const opening = session.openLibrary(handle); await entered.promise; const close = session.close(); gate.resolve();
 await opening; assert.equal((await close).status, 'allowed'); assert.equal(f.counts().closed, 1); assert.equal(f.counts().driverClosed, 1);
 assert.equal(session.getActiveRuntime(), null); assert.equal(session.getSnapshot().phase, 'closed');
});


test('builder captures peer identity before asynchronous checkpoint hash', async () => {
 const mutable = { ...peer }; let n = 100; const building = initialRequest('Captured', mutable, () => id(n++));
 mutable.accountId = 'changed-namespace'; mutable.peerId = id(999);
 const request = await building;
 assert.equal(request.profile.identity.accountId, peer.accountId); assert.equal(request.expectedPeerId, peer.peerId);
 assert.equal(request.control.identity.accountId, peer.accountId);
});

test('uncommitted unknown request cannot be displaced by recovery or ack of another ID', async () => {
 const f = fixture(), session = new BootstrapSession(f.driver); await session.start(); f.loseBefore(); await session.createLibrary('fixed A');
 const first = f.attempted(); assert.ok(first); const requestId = first.control.id, exact = JSON.stringify(first);
 assert.equal(f.pending(), null); assert.equal(session.getSnapshot().creation?.stage, 'unknown');
 await session.recoverCreation(id(999)); await session.acknowledgeCreation(id(999));
 assert.equal(session.getSnapshot().creation?.requestId, requestId); assert.equal(f.counts().prepareCalls, 1);
 await session.recoverCreation(requestId); assert.equal(JSON.stringify(f.attempted()), exact); assert.equal(JSON.stringify(f.pending()), exact);
 assert.equal(session.getSnapshot().creation?.stage, 'accepted'); assert.equal(f.counts().executeCalls, 1);
});

test('terminal cancellation and availability changes cannot revive a closed session', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle);
 assert.equal((await session.close()).status, 'allowed'); session.cancelPendingView(); session.setPageAvailable(false); session.setPageAvailable(true);
 await session.start(); assert.equal((await session.close()).status, 'allowed');
 assert.equal(session.getSnapshot().phase, 'closed'); assert.equal(f.counts().closed, 1); assert.equal(f.counts().driverClosed, 1);
});


test('provider persisted return re-admits the same runtime and form owners without OAuth or local discovery', { timeout: 5_000 }, async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const requestId = crypto.randomUUID(), selected = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').RemoteLibraryHandle;
 const firstGrant = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderGrant;
 const freshGrant = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderGrant;
 const target = () => ({ requestId, lease: {} as HostLease, handle });
 let oauth = 0, local = 0, resumes = 0, admission = 0;
 const retired = new WeakSet<ActiveLibraryProof>(); let latest: ActiveLibraryProof | undefined;
 f.driver.readLocalContext = async () => { local++; throw new Error('provider return must not discover local storage'); };
 f.driver.provisionLocalContext = async () => { local++; throw new Error('provider return must not provision local storage'); };
 f.driver.storageKind = () => 'google-drive';
 f.driver.inspect = async () => { admission++; latest = { scope: { ...f.scope } } as ActiveLibraryProof; return latest; };
 f.driver.revalidate = async proof => { if (retired.has(proof)) throw new Error('old-proof-invalid'); };
 f.driver.openReplication = async () => ({ scope: f.scope, getSnapshot: () => ({ running: false, suspended: false, error: '' }),
  subscribe: () => () => {}, suspend() {}, async suspendAndWait() {}, async flush() {}, async resume() {} });
 const ackEntered = deferred(), ackReleased = deferred();
 const facade = {
  async preload() { return { configured: true }; }, async connect() { oauth++; return firstGrant; },
  async recoveries() { return []; }, async list() { return [{ handle: selected, title: 'Cloud', status: 'available' as const }]; },
  async openSelected() { return target(); }, async disconnect() {},
  async resumeRetained(actual: string, signal: AbortSignal) { assert.equal(actual, requestId); signal.throwIfAborted(); resumes++; return { grant: freshGrant, target: target() }; },
  async settleRetainedResume(grant: typeof freshGrant, accepted: boolean) { assert.equal(grant, freshGrant); assert.equal(accepted, true); ackEntered.resolve(); await ackReleased.promise; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade;
 f.driver.getProvider = () => facade;
 const session = new BootstrapSession(f.driver), provider = session.getProviderConnection()!;
 await provider.prepare(); await provider.connect(); await provider.join(selected);
 const runtime = session.getActiveRuntime(); assert.ok(runtime); const sessions = runtime.binding.sessions, inkSettings = runtime.binding.inkSettings;
 const oldProof = latest!; let leaveGuardCalled = 0; const release = sessions.registerScopeViewGuard(() => { leaveGuardCalled++; return false; });
 retired.add(oldProof); session.setPageAvailable(false); assert.equal(session.getActiveRuntime(), null);
 assert.equal(session.getRetainedRuntime(), runtime); assert.equal(sessions.getSnapshot().active, false);
 const resumed = session.resumePage();
 try { await Promise.race([ackEntered.promise, resumed.then(() => { throw new Error('readmission ended before ownership ACK'); })]); assert.equal(session.getActiveRuntime(), null); assert.equal(session.getSnapshot().locked, true); assert.equal(session.getRetainedRuntime(), runtime); }
 finally { ackReleased.resolve(); }
 await resumed; assert.equal(resumes, 1); assert.equal(oauth, 1); assert.equal(local, 0); assert.equal(admission, 2);
 assert.equal(session.getActiveRuntime(), runtime); assert.equal(runtime.binding.sessions, sessions); assert.equal(runtime.binding.inkSettings, inkSettings);
 assert.notEqual(runtime.proof, oldProof); await assert.rejects(f.driver.revalidate(oldProof, new AbortController().signal));
 assert.equal((await session.returnToChooser()).status, 'refused'); assert.ok(leaveGuardCalled > 0);
 release(); await session.close();
});

for (const method of ['resume', 'connect'] as const) test(`unknown offline enrollment permits only retained provider ${method} and preserves fixed request`, async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const requestId = crypto.randomUUID(), selected = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').RemoteLibraryHandle;
 const grant = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderGrant;
 const target = () => ({ requestId, lease: {} as HostLease, handle });
 let foreign = false, resumeCalls = 0, connectCalls = 0, disconnectCalls = 0, firstId = '';
 f.driver.storageKind = () => 'google-drive';
 f.driver.inspect = async () => ({ scope: { ...f.scope, epoch: foreign ? 'foreign' : f.scope.epoch } } as ActiveLibraryProof);
 f.driver.openReplication = async () => ({ scope: f.scope, getSnapshot: () => ({ running: false, suspended: false, error: '' }),
  subscribe: () => () => {}, suspend() {}, async suspendAndWait() {}, async flush() {}, async resume() {} });
 f.driver.getProvider = () => ({
  async preload() { return { configured: true }; }, async connect() { connectCalls++; return grant; },
  async recoveries() { return []; }, async list() { return [{ handle: selected, title: 'Cloud', status: 'available' as const }]; },
  async openSelected() { return target(); }, async openInstalled() { return target(); }, async disconnect() { disconnectCalls++; },
  async resumeRetained() { resumeCalls++; return { grant, target: target() }; }, async settleRetainedResume() {},
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 f.driver.getOffline = () => ({ async recoverEnrollment() { return null; },
  async enroll(_proof: ActiveLibraryProof, _secret: string, id: string) { if (!firstId) { firstId = id; return { requestId: id, status: 'unknown' as const }; }
   assert.equal(id, firstId); return { requestId: id, status: 'accepted' as const }; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), provider = session.getProviderConnection()!, offline = session.getOfflineConnection()!;
 await provider.prepare(); await provider.connect(); await provider.join(selected);
 const runtime = session.getActiveRuntime(); assert.ok(runtime);
 assert.equal(provider.getSnapshot().busy, false); assert.equal(offline.getSnapshot().canEnroll, true, 'provider flight settlement republishes offline availability');
 await offline.enroll('synthetic passphrase'); assert.equal(offline.getSnapshot().pendingGuard, true);
 assert.equal((await session.returnToChooser()).status, 'refused');
 session.setPageAvailable(false); assert.equal(session.getRetainedRuntime(), runtime);
 if (method === 'resume') await session.resumePage();
 else {
  session.setPageAvailable(true); foreign = true; await provider.connect();
  assert.equal(session.getActiveRuntime(), null); assert.equal(session.getRetainedRuntime(), runtime);
  foreign = false; await provider.connect();
 }
 assert.equal(session.getActiveRuntime(), runtime); assert.equal(offline.getSnapshot().pendingGuard, true);
 assert.equal(method === 'resume' ? resumeCalls : connectCalls, method === 'resume' ? 1 : 3);
 assert.equal((await provider.disconnect()).status, 'refused'); assert.equal(disconnectCalls, 0);
 await offline.enroll('synthetic passphrase'); assert.equal(offline.getSnapshot().pendingGuard, false);
 assert.equal(offline.getSnapshot().outcome, 'accepted'); await session.close();
});

test('retained provider readmission waits for an in-flight offline enrollment to settle', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const requestId = crypto.randomUUID(), selected = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').RemoteLibraryHandle;
 const grant = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderGrant, target = () => ({ requestId, lease: {} as HostLease, handle });
 const entered = deferred(), release = deferred(); let resumes = 0;
 f.driver.storageKind = () => 'google-drive';
 f.driver.openReplication = async () => ({ scope: f.scope, getSnapshot: () => ({ running: false, suspended: false, error: '' }),
  subscribe: () => () => {}, suspend() {}, async suspendAndWait() {}, async flush() {}, async resume() {} });
 f.driver.getProvider = () => ({ async preload() { return { configured: true }; }, async connect() { return grant; },
  async recoveries() { return []; }, async list() { return [{ handle: selected, title: 'Cloud', status: 'available' as const }]; }, async openSelected() { return target(); }, async disconnect() {},
  async resumeRetained() { resumes++; return { grant, target: target() }; }, async settleRetainedResume() {},
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 f.driver.getOffline = () => ({ async recoverEnrollment() { return null; }, async enroll(_proof: ActiveLibraryProof, _secret: string, id: string) {
  entered.resolve(); await release.promise; return { requestId: id, status: 'accepted' as const }; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), provider = session.getProviderConnection()!, offline = session.getOfflineConnection()!;
 await provider.prepare(); await provider.connect(); await provider.join(selected); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 const flight = offline.enroll('synthetic passphrase'); await entered.promise;
 session.setPageAvailable(false); await session.resumePage(); assert.equal(resumes, 0); assert.equal(session.getActiveRuntime(), null);
 release.resolve(); await flight; assert.equal(offline.getSnapshot().pendingGuard, true);
 await session.resumePage(); assert.equal(resumes, 1); assert.equal(session.getActiveRuntime(), runtime);
 await offline.enroll('synthetic passphrase'); assert.equal(offline.getSnapshot().pendingGuard, false); await session.close();
});

test('unknown offline enrollment refuses provider disconnect without closing the retained runtime', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const requestId = crypto.randomUUID(), selected = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').RemoteLibraryHandle;
 const grant = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderGrant;
 let disconnects = 0, pending = true;
 f.driver.storageKind = () => 'google-drive';
 f.driver.openReplication = async () => ({ scope: f.scope, getSnapshot: () => ({ running: false, suspended: false, error: '' }),
  subscribe: () => () => {}, suspend() {}, async suspendAndWait() {}, async flush() {}, async resume() {} });
 f.driver.getProvider = () => ({ async preload() { return { configured: true }; }, async connect() { return grant; },
  async recoveries() { return []; }, async list() { return [{ handle: selected, title: 'Cloud', status: 'available' as const }]; },
  async openSelected() { return { requestId, lease: {} as HostLease, handle }; }, async disconnect() { disconnects++; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 f.driver.getOffline = () => ({ async recoverEnrollment() { return null; }, async enroll(_proof: ActiveLibraryProof, _secret: string, id: string) {
  return { requestId: id, status: pending ? 'unknown' as const : 'accepted' as const }; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), provider = session.getProviderConnection()!, offline = session.getOfflineConnection()!;
 await provider.prepare(); await provider.connect(); await provider.join(selected); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 await offline.enroll('synthetic passphrase'); assert.equal(offline.getSnapshot().pendingGuard, true);
 assert.equal((await provider.disconnect()).status, 'refused'); assert.equal(disconnects, 0); assert.equal(session.getActiveRuntime(), runtime);
 pending = false; await offline.enroll('synthetic passphrase'); assert.equal(offline.getSnapshot().pendingGuard, false); await session.close();
});

test('cold bootstrap settlement enables the offline unlock controller', async () => {
 const f = fixture(); f.driver.readLocalContext = async () => ({ status: 'setup-required', reason: 'absent' });
 f.driver.getOffline = () => ({} as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!;
 await session.start(); assert.equal(session.getSnapshot().phase, 'setup-required');
 assert.equal(offline.getSnapshot().canUnlock, true); await session.close();
});

test('local Library leave settlement enables the offline unlock controller', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 f.driver.getOffline = () => ({} as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!;
 await session.start(); await session.openLibrary(handle); assert.ok(session.getActiveRuntime());
 assert.equal(offline.getSnapshot().canUnlock, false); assert.equal((await session.returnToChooser()).status, 'allowed');
 assert.equal(offline.getSnapshot().canUnlock, true); await session.close();
});

test('page return republishes offline availability without creating a new host session', async () => {
 const f = fixture(); f.driver.getOffline = () => ({} as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!;
 await session.start(); assert.equal(offline.getSnapshot().canUnlock, true);
 session.setPageAvailable(false); assert.equal(offline.getSnapshot().canUnlock, false);
 session.setPageAvailable(true); assert.equal(offline.getSnapshot().canUnlock, false);
 await session.resumePage(); assert.equal(offline.getSnapshot().canUnlock, true); await session.close();
});

for (const outcome of ['setup-required', 'recovery-required'] as const) test(`offline unlock becomes available only after initial ${outcome} reconciliation`, async () => {
 const f = fixture(), entered = deferred(), release = deferred();
 f.driver.getOffline = () => ({} as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 f.driver.readHold = async () => { entered.resolve(); await release.promise; return 'clear'; };
 f.driver.readLocalContext = async () => outcome === 'setup-required' ? { status: 'setup-required', reason: 'absent' }
  : { status: 'recovery-required', reason: 'synthetic-storage-error' };
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!;
 assert.equal(session.getSnapshot().phase, 'idle'); assert.equal(offline.getSnapshot().canUnlock, false);
 const starting = session.start(); await entered.promise;
 assert.equal(session.getSnapshot().phase, 'checking'); assert.equal(offline.getSnapshot().canUnlock, false);
 release.resolve(); await starting;
 assert.equal(session.getSnapshot().phase, outcome); assert.equal(offline.getSnapshot().canUnlock, true);
 await session.close();
});

test('held storage remains subject to host unlock refusal and can be checked again', async () => {
 const f = fixture(); f.setHold('held'); let calls = 0;
 f.driver.getOffline = () => ({ async unlock() { calls++; throw new Error('host-hold-active'); } } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!;
 await session.start(); assert.equal(session.getSnapshot().phase, 'recovery-required');
 await offline.unlock('synthetic passphrase'); assert.equal(calls, 1); assert.equal(offline.getSnapshot().error, true); assert.deepEqual(offline.getSnapshot().choices, []);
 f.setHold('clear'); await session.start(); assert.equal(session.getSnapshot().phase, 'choosing'); assert.equal(offline.getSnapshot().canUnlock, true); await session.close();
});

test('locked retained offline runtime offers fresh unlock after page return', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const token = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').OfflineUnlockSession, requestId = crypto.randomUUID();
 const choice = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').OfflineLibraryHandle;
 f.driver.storageKind = () => 'google-drive'; f.driver.providerOffline = () => true;
 f.driver.getOffline = () => ({ async unlock() { return { session: token, choices: [{ handle: choice, title: 'Synthetic' }] }; },
  async open() { return { lease, handle, requestId }; }, async lock() {},
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!;
 await session.start(); await offline.unlock('synthetic passphrase'); await offline.open(choice); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 session.setPageAvailable(false); assert.equal(offline.getSnapshot().canUnlock, false); await session.resumePage();
 assert.equal(session.getRetainedRuntime(), runtime); assert.equal(session.getSnapshot().locked, true); assert.equal(offline.getSnapshot().canUnlock, true);
 await offline.unlock('synthetic passphrase'); await offline.open(choice);
 assert.equal(session.getActiveRuntime(), runtime); await session.close();
});

test('offline reconnect refuses a real dirty Markdown session before dispatching provider connect', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const noteId = crypto.randomUUID(); await f.repository.initialize({ kind: 'markdown', id: noteId, version: crypto.randomUUID(), content: 'base', appendIds: [], imageResources: [] });
 const token = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').OfflineUnlockSession;
 const choice = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').OfflineLibraryHandle;
 let connects = 0;
 f.driver.storageKind = () => 'google-drive'; f.driver.providerOffline = () => true;
 f.driver.getProvider = () => ({ async preload() { return { configured: true }; }, async connect() { connects++; throw new Error('unexpected-provider-connect'); },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 f.driver.getOffline = () => ({ async unlock() { return { session: token, choices: [{ handle: choice, title: 'Synthetic' }] }; },
  async open() { return { lease, handle, requestId: crypto.randomUUID() }; }, async lock() {},
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!, provider = session.getProviderConnection()!;
 await session.start(); await offline.unlock('synthetic passphrase'); await offline.open(choice); const runtime = session.getActiveRuntime(); assert.ok(runtime);
 const markdown = runtime.binding.sessions.getMarkdown(noteId); assert.equal(await markdown.refresh(), true);
 assert.equal(markdown.editText('unsaved local change'), true); assert.equal(markdown.canLeave(), false);
 await provider.prepare(); await provider.connect();
 assert.equal(connects, 0); assert.equal(session.getActiveRuntime(), runtime); assert.equal(markdown.getSnapshot().content, 'unsaved local change');
 assert.equal(provider.getSnapshot().error, '編集中の入力や保存途中の内容があります。端末への保存を確認してから、もう一度接続してください。');
 await markdown.flush(); assert.equal(markdown.canLeave(), true); await session.close();
});

test('scoped invalidation affects only the current Bootstrap runtime proof', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 let notify: ((event: { affectsLease(lease: HostLease): boolean; affectsProof(proof: ActiveLibraryProof): boolean }) => void) | undefined;
 f.driver.subscribeScopedInvalidation = listener => { notify = listener; return () => { notify = undefined; }; };
 const session = new BootstrapSession(f.driver); await session.start(); await session.openLibrary(handle); const runtime = session.getActiveRuntime(); assert.ok(runtime); assert.ok(notify);
 notify({ affectsLease: () => true, affectsProof: () => false }); assert.equal(session.getActiveRuntime(), runtime);
 notify({ affectsLease: () => false, affectsProof: proof => proof === runtime.proof }); assert.equal(session.getActiveRuntime(), null); assert.equal(session.getRetainedRuntime(), runtime);
});

for (const status of [403, 401] as const) test(`stale Desktop admission cleanup ${status} ${status === 403 ? 'preserves' : 'fences'} an independent Bootstrap runtime`, async () => {
 const globals = globalThis as unknown as Record<string, unknown>, saved = { window:globals.window, addEventListener:globals.addEventListener, removeEventListener:globals.removeEventListener };
 globals.window = { __PAPEER_PORT:4321, __PAPEER_TOKEN:'offline-unit-token' }; globals.addEventListener = () => {}; globals.removeEventListener = () => {};
 const scope = { accountId:id(1), libraryId:id(2), epoch:id(3) }; let cleanupCalls = 0;
 const fetcher: typeof fetch = async input => {
  const path = new URL(String(input)).pathname; let body: unknown, code = 200;
  if (path.endsWith('/local-context/read')) body = { status:'ready', leaseId:'old-lease' };
  else if (path.endsWith('/offline/unlock')) body = { unlockSession:'old-session', choices:[{ handle:'old-choice', title:'Library' }] };
  else if (path.endsWith('/offline/open')) body = { leaseId:'old-lease', handleId:'old-handle', requestId:id(4), authorizationMode:'provider-offline' };
  else if (path.endsWith('/inspect') || path.endsWith('/revalidate')) body = { admissionId:'old-admission', scope, peerId:id(5), fingerprint:'a'.repeat(64), authorizationMode:'provider-offline' };
  else if (path.endsWith('/release')) { cleanupCalls++; code=status; body={ detail:status === 403 ? 'canonical-authority-denied' : 'unauthorized' }; }
  else if (path.endsWith('/offline/lock')) body={status:'locked'}; else throw new Error('unexpected route '+path);
  return new Response(JSON.stringify(body),{status:code,headers:{'Content-Type':'application/json'}});
 };
 const desktop=createDesktopBootstrapHostDriver(fetcher), signal=new AbortController().signal, f=fixture();
 f.driver.subscribeInvalidation=desktop.subscribeInvalidation; f.driver.subscribeScopedInvalidation=desktop.subscribeScopedInvalidation;
 try {
  const offline=desktop.getOffline!(), opened=await offline.unlock('secret with sufficient length',signal), target=await offline.open(opened.session,opened.choices[0]!.handle,signal);
  const proof=await desktop.inspect(target.lease,target.handle,signal), old=await desktop.openScope(proof,signal);
  await f.repository.initialize({kind:'library',id:f.scope.libraryId,version:id(8),items:[],folders:[],links:[],deletions:[]});
  const bootstrap=new BootstrapSession(f.driver); await bootstrap.start(); await bootstrap.openLibrary(handle); const runtime=bootstrap.getActiveRuntime(); assert.ok(runtime);
  await old.close(); assert.equal(cleanupCalls,1);
  if (status === 403) { assert.equal(bootstrap.getActiveRuntime(),runtime); assert.equal(runtime.binding.sessions.getSnapshot().active,true); }
  else { assert.equal(bootstrap.getActiveRuntime(),null); assert.equal(bootstrap.getRetainedRuntime(),runtime); }
 } finally { await desktop.close(); for (const [name,value] of Object.entries(saved)) { if (value === undefined) delete globals[name]; else globals[name]=value; } }
});

test('unlocked offline reconnectSaved refuses dirty session, keeps clean session on null, and transitions offline to online when accepted', async () => {
 const f = fixture(); await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 const noteId = crypto.randomUUID(); await f.repository.initialize({ kind: 'markdown', id: noteId, version: crypto.randomUUID(), content: 'base', appendIds: [], imageResources: [] });
 const token = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').OfflineUnlockSession;
 const choice = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').OfflineLibraryHandle;
 const grant = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderGrant;
 const remoteChoice = Object.freeze({}) as import('../src/features/bootstrap/bootstrapPorts.ts').RemoteLibraryHandle;
 const reqId = id(9);
 let offlineMode = true, reconnectCalls = 0, nextGrant: typeof grant | null = grant;
 f.driver.storageKind = () => 'google-drive';
 f.driver.providerOffline = proof => (proof as ActiveLibraryProof & { offlineFlag?: boolean }).offlineFlag ?? offlineMode;
 f.driver.inspect = async () => ({ scope: f.scope, offlineFlag: offlineMode } as unknown as ActiveLibraryProof);
 f.driver.openReplication = async () => ({
  scope: f.scope, getSnapshot: () => ({ running: false, suspended: false, error: '' }),
  subscribe: () => () => {}, suspend: () => {}, suspendAndWait: async () => {}, flush: async () => {}, resume: async () => {},
 });
 f.driver.getProvider = () => ({
  async preload() { return { configured: true }; },
  async reconnectSaved() { reconnectCalls++; return nextGrant; },
  async connect() { return grant; },
  async recoveries() { return []; },
  async list() { return [{ handle: remoteChoice, title: 'Synthetic', status: 'available' }]; },
  async openInstalled(_g: unknown, requestId: string) { offlineMode = false; return { lease, handle, requestId }; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 f.driver.getOffline = () => ({
  async unlock() { return { session: token, choices: [{ handle: choice, title: 'Synthetic' }] }; },
  async open() { return { lease, handle, requestId: reqId }; },
  async lock() {},
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const session = new BootstrapSession(f.driver), offline = session.getOfflineConnection()!, provider = session.getProviderConnection()!;
 await session.start(); await offline.unlock('synthetic passphrase'); await offline.open(choice);
 const runtime = session.getActiveRuntime(); assert.ok(runtime);
 const markdown = runtime.binding.sessions.getMarkdown(noteId); assert.equal(await markdown.refresh(), true);
 assert.equal(markdown.editText('unsaved offline edit'), true);
 await provider.prepare();
 assert.equal(reconnectCalls, 0); assert.equal(provider.getSnapshot().phase, 'connect-ready');
 assert.equal(session.getActiveRuntime(), runtime); assert.equal(markdown.getSnapshot().content, 'unsaved offline edit');
 await markdown.flush(); assert.equal(markdown.canLeave(), true);

 // When saved credentials return null, the clean offline session remains unlocked and online flag unchanged.
 const cleanNull = fixture(); await cleanNull.repository.initialize({ kind: 'library', id: cleanNull.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 cleanNull.driver.storageKind = () => 'google-drive'; cleanNull.driver.providerOffline = () => true;
 cleanNull.driver.getProvider = () => ({
  async preload() { return { configured: true }; },
  async reconnectSaved() { return null; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 cleanNull.driver.getOffline = () => ({
  async unlock() { return { session: token, choices: [{ handle: choice, title: 'Synthetic' }] }; },
  async open() { return { lease, handle, requestId: reqId }; },
  async lock() {},
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOfflineFacade);
 const sNull = new BootstrapSession(cleanNull.driver);
 await sNull.start(); await sNull.getOfflineConnection()!.unlock('synthetic passphrase'); await sNull.getOfflineConnection()!.open(choice);
 await sNull.getProviderConnection()!.prepare();
 assert.equal(sNull.getRuntimeProviderOffline(), true);
 assert.equal(sNull.getSnapshot().locked, false);
 assert.equal(sNull.getOfflineConnection()!.getSnapshot().phase, 'unlocked');
 await sNull.close();

 // Fresh provider session where reconnectSaved returns a valid grant cleans offline unlock state upon activation.
 const cleanOk = fixture(); await cleanOk.repository.initialize({ kind: 'library', id: cleanOk.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
 let cleanOkOffline = true;
 cleanOk.driver.storageKind = () => 'google-drive';
 cleanOk.driver.providerOffline = proof => (proof as ActiveLibraryProof & { offlineFlag?: boolean }).offlineFlag ?? cleanOkOffline;
 cleanOk.driver.inspect = async () => ({ scope: cleanOk.scope, offlineFlag: cleanOkOffline } as unknown as ActiveLibraryProof);
 cleanOk.driver.openReplication = f.driver.openReplication;
 cleanOk.driver.getProvider = () => ({
  ...f.driver.getProvider!(),
  async openInstalled(_g: unknown, requestId: string) { cleanOkOffline = false; return { lease, handle, requestId }; },
 } as unknown as import('../src/features/bootstrap/bootstrapPorts.ts').ProviderOwnerFacade);
 cleanOk.driver.getOffline = f.driver.getOffline;
 nextGrant = grant;
 const sOk = new BootstrapSession(cleanOk.driver);
 await sOk.start(); await sOk.getOfflineConnection()!.unlock('synthetic passphrase'); await sOk.getOfflineConnection()!.open(choice);
 await sOk.getProviderConnection()!.prepare();
 assert.equal(sOk.getRuntimeProviderOffline(), false);
 assert.equal(sOk.getSnapshot().phase, 'ready');
 assert.equal(sOk.getSnapshot().locked, false);
 assert.equal(sOk.getOfflineConnection()!.getSnapshot().phase, 'locked');
 await sOk.close();
 await session.close();
});

test('desktop retiring an unadopted provider grant preserves an independent active Bootstrap runtime', async () => {
 const globals = globalThis as unknown as Record<string, unknown>, saved = { window: globals.window, addEventListener: globals.addEventListener, removeEventListener: globals.removeEventListener };
 globals.window = { __PAPEER_PORT: 4321, __PAPEER_TOKEN: 'provider-unit-token' }; globals.addEventListener = () => {}; globals.removeEventListener = () => {};
 let releasedProvider = 0;
 const fetcher: typeof fetch = async input => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/provider-owner/preload')) return new Response(JSON.stringify({ configured: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path.endsWith('/provider-owner/reconnect-saved')) return new Response(JSON.stringify({ leaseId: 'provider-only-lease', operationId: 'provider-only-op' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path.endsWith('/provider-owner/recoveries')) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path.endsWith('/provider-owner/list')) return new Response(JSON.stringify({ detail: 'provider-list-failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if (path.endsWith('/provider-owner/release')) { releasedProvider++; return new Response(JSON.stringify({ status: 'released' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
  throw new Error('unexpected route ' + path);
 };
 const desktop = createDesktopBootstrapHostDriver(fetcher), f = fixture();
 f.driver.subscribeInvalidation = desktop.subscribeInvalidation;
 f.driver.subscribeScopedInvalidation = desktop.subscribeScopedInvalidation;
 f.driver.getProvider = desktop.getProvider;
 try {
  await f.repository.initialize({ kind: 'library', id: f.scope.libraryId, version: id(8), items: [], folders: [], links: [], deletions: [] });
  const bootstrap = new BootstrapSession(f.driver);
  await bootstrap.start(); await bootstrap.openLibrary(handle);
  const runtime = bootstrap.getActiveRuntime(); assert.ok(runtime);
  await bootstrap.getProviderConnection()!.prepare();
  assert.equal(releasedProvider, 1);
  assert.equal(bootstrap.getActiveRuntime(), runtime);
  assert.equal(runtime.binding.sessions.getSnapshot().active, true);
  assert.equal(bootstrap.getProviderConnection()!.getSnapshot().phase, 'connect-ready');
  await bootstrap.close();
 } finally { await desktop.close(); for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete globals[name]; else globals[name] = value; } }
});
