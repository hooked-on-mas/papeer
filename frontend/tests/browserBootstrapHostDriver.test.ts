import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ActiveLibraryProof, HostLease, LibraryHandle, ScopeResources } from '../src/features/bootstrap/bootstrapPorts.ts';
import { assembleBrowserBootstrapHostDriver, type BrowserScopeDraftPorts } from '../src/adapters/browser/bootstrapHostDriver.ts';
import { LocalHostAuthority, type HostOperation, type PersistentTuple } from '../src/adapters/browser/localHostAuthority.ts';
import { LOCAL_GRANT_STORE } from '../src/adapters/browser/canonicalIndexedDbSchema.ts';
import { readLegacyHoldReadonly } from '../src/adapters/browser/legacyHoldReadonly.ts';
import { initialRequest } from '../src/features/bootstrap/initialRequest.ts';
import { makeInitializationIntent } from '../src/runtime/edits/canonicalInitializationIntent.ts';
import { GateOperationStale } from '../src/runtime/lifecycle/RuntimeIoGate.ts';
import { ProviderGrantIssuer } from '../src/adapters/browser/ownership/providerGrantIssuer.ts';
import { canonicalJson } from '../src/runtime/edits/editModel.ts';
import { resourceHash } from '../src/runtime/edits/contentPublication.ts';
import type { CanonicalLibraryProfile, DatasetControlRecord, DatasetManifest } from '../src/runtime/edits/contracts.ts';
import type { EditScope } from '../src/runtime/edits/ports.ts';

// ---- a minimal IndexedDB double: just enough for the host transaction helper and the owner snapshot reads ----
type Row = { key: string; scope: string; value: unknown };
type Range = { only?: string; lower?: string; upper?: string };
(globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = { only: (only: string): Range => ({ only }), bound: (lower: string, upper: string): Range => ({ lower, upper }) };
const inRange = (scope: string, range: unknown) => { const r = range as Range | string; if (typeof r === 'string') return scope === r; return r.only !== undefined ? scope === r.only : scope >= r.lower! && scope <= r.upper!; };
type FakeTx = { pending: number; aborted: boolean; done: boolean; oncomplete: (() => void) | null; onabort: (() => void) | null; error: unknown; abort(): void; settle(): void; fail(error: unknown): void; objectStore(name: string): unknown };
function fakeDatabase(stores: Record<string, Row[]>): IDBDatabase {
  const db = { onversionchange: null, close() {},
    transaction(requested: string | string[]) {
      const names = typeof requested === 'string' ? [requested] : requested;
      for (const name of names) if (!(name in stores)) throw new Error('NotFoundError ' + name);
      const tx: FakeTx = { pending: 0, aborted: false, done: false, oncomplete: null, onabort: null, error: null,
        abort() { if (tx.aborted || tx.done) return; tx.aborted = true; queueMicrotask(() => tx.onabort?.()); },
        settle() { queueMicrotask(() => { if (!tx.aborted && !tx.done && tx.pending === 0) { tx.done = true; tx.oncomplete?.(); } }); },
        fail(error) { tx.error = error; tx.abort(); },
        objectStore(name: string) {
          const request = (produce: () => unknown) => {
            const req: { result: unknown; onsuccess: (() => void) | null } = { result: undefined, onsuccess: null }; tx.pending++;
            queueMicrotask(() => { if (tx.aborted) return; req.result = produce(); try { req.onsuccess?.(); } catch (error) { tx.fail(error); } tx.pending--; tx.settle(); }); return req;
          };
          return { get: (key: string) => request(() => { const found = stores[name].find(row => row.key === key); return name === 'holds' ? found?.value : found; }), // holds uses out-of-line keys: raw values
            index: () => ({ getAll: (range: unknown) => request(() => stores[name].filter(row => inRange(row.scope, range))),
              openCursor: (range: unknown) => {
                const rows = stores[name].filter(row => inRange(row.scope, range)); let i = 0;
                const req: { result: unknown; onsuccess: (() => void) | null } = { result: null, onsuccess: null };
                const step = () => { tx.pending++; queueMicrotask(() => { if (tx.aborted) return; req.result = i < rows.length ? { value: rows[i++], continue: step } : null;
                  try { req.onsuccess?.(); } catch (error) { tx.fail(error); } tx.pending--; tx.settle(); }); };
                step(); return req;
              } }) };
        } };
      tx.settle(); return tx;
    } };
  return db as unknown as IDBDatabase;
}

// ---- a world with one persisted Library and a fake authority issuing real opaque leases/proofs ----
const uuid = () => crypto.randomUUID();
const GRANT = { version: 1 as const, kind: 'local-created' as const, contextId: uuid(), namespaceId: uuid(), revision: uuid() };
type Priv = { issue(grant: unknown): HostLease; proofs: WeakMap<object, unknown>; generation: number };
async function makeWorld() {
  const peer = { version: 1 as const, accountId: GRANT.namespaceId, peerId: uuid() };
  const request = await initialRequest('Stored library', peer), control = request.control as DatasetControlRecord, manifest = control.active as DatasetManifest;
  const profile: CanonicalLibraryProfile = { version: 1, revision: request.profile.revision, identity: request.profile.identity, title: 'Stored library', remote: null,
    origin: { kind: 'activated-installation', source: 'import', controlId: control.id, manifestId: manifest.id, installedScope: manifest.scope }, initialization: null };
  const pending = await makeInitializationIntent(await initialRequest('Pending library', peer), GRANT.namespaceId);
  const world = { peer, profile, control, manifest, scope: manifest.scope as EditScope, intents: [pending], grant: GRANT as unknown, peerChanged: false };
  const account = GRANT.namespaceId, identity = JSON.stringify([account, profile.identity.libraryId]), ns = JSON.stringify([account, profile.identity.libraryId, manifest.scope.epoch]);
  const tuple = (): PersistentTuple => ({ grant: GRANT, profile, control, peer: world.peerChanged ? { ...peer, peerId: uuid() } : peer, manifest, scope: manifest.scope });
  const stores = (): Record<string, Row[]> => {
    const empty = ['roots', 'edits', 'projections', 'pages', 'resources', 'resourceBytes', 'checkpoints', 'intents', 'datasetAccess', 'canonicalInitialArtifacts'];
    return { ...Object.fromEntries(empty.map(name => [name, [] as Row[]])),
      [LOCAL_GRANT_STORE]: [{ key: 'primary-local-context', scope: 'primary-local-context', value: world.grant }],
      canonicalProfiles: [{ key: identity, scope: account, value: profile }], datasetControls: [{ key: identity, scope: identity, value: control }],
      canonicalPeers: [{ key: account, scope: account, value: world.peerChanged ? { ...peer, peerId: tuple().peer && (tuple().peer as { peerId: string }).peerId } : peer }],
      datasets: [{ key: JSON.stringify([ns, manifest.id]), scope: ns, value: manifest }],
      canonicalInitialIntents: world.intents.map(intent => ({ key: JSON.stringify([account, intent.requestId]), scope: account, value: intent })) };
  };
  return { world, tuple, stores };
}
type World = Awaited<ReturnType<typeof makeWorld>>;
class FakeAuthority extends LocalHostAuthority {
  readonly ioLeases: HostLease[] = []; readonly captureLeases: HostLease[] = []; private readonly source: World;
  constructor(source: World) { super({} as IDBFactory, 'fake-canonical'); this.source = source; }
  private get priv() { return this as unknown as Priv; }
  override async discover(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); return { status: 'ready' as const, lease: this.priv.issue(GRANT) }; }
  override async inspect(lease: HostLease, libraryId: string, signal: AbortSignal): Promise<ActiveLibraryProof> {
    this.captureNamespaceOwner(lease, signal);
    if (libraryId !== this.source.world.profile.identity.libraryId) throw new Error('host-admission-invalid');
    const proof = Object.freeze({ scope: Object.freeze({ ...this.source.world.scope }) }) as unknown as ActiveLibraryProof;
    this.priv.proofs.set(proof, { lease, generation: this.priv.generation, tuple: structuredClone(this.source.tuple()) }); return proof;
  }
  override capture(lease: HostLease, proof: ActiveLibraryProof, signal: AbortSignal): HostOperation { const operation = super.capture(lease, proof, signal); this.captureLeases.push(lease); return operation; }
  override async openOperation(operation: HostOperation): Promise<IDBDatabase> { this.ioLeases.push(this.captureRecord(operation).lease); return fakeDatabase(this.source.stores()); }
}
const memoryPorts = (scope: EditScope): BrowserScopeDraftPorts => ({
  drafts: { scope, targets: () => ['draft-a'], read: () => undefined, write: () => {}, remove: () => {} } as unknown as BrowserScopeDraftPorts['drafts'],
  appends: { scope, read: () => undefined, write: () => {}, remove: () => {} } as unknown as BrowserScopeDraftPorts['appends'],
  reader: { scope, read: () => undefined, write: () => {} } as unknown as BrowserScopeDraftPorts['reader'] });
async function fixture(hold: { value: 'clear' | 'held' } = { value: 'clear' }) {
  const source = await makeWorld(), authority = new FakeAuthority(source);
  const driver = assembleBrowserBootstrapHostDriver(authority, { readHold: async () => hold.value, draftPorts: memoryPorts });
  const signal = new AbortController().signal;
  const lease = async () => { const context = await driver.readLocalContext(signal); assert.equal(context.status, 'ready'); return (context as { lease: HostLease }).lease; };
  const open = async (acquisition = new AbortController().signal) => {
    const first = await lease(), listing = await driver.discover(first, signal), handle = listing.libraries[0].handle;
    const proof = await driver.inspect(first, handle, signal); return { first, listing, handle, proof, resources: await driver.openScope(proof, acquisition) };
  };
  return { source, authority, driver, signal, lease, open, hold };
}
const teardown: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (teardown.length) await teardown.pop()!(); });

test('cancelling one captured provider operation preserves the selected grant and sibling operation', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close());
  const lease = await f.lease(), signal = f.signal, scope = f.source.world.scope;
  const bytes = new TextEncoder().encode(canonicalJson({ version: 1, scope, manifestId: uuid(), checkpointSha256: 'b'.repeat(64) }));
  const digest = await resourceHash(bytes); let valid = true;
  const issuer = new ProviderGrantIssuer(f.authority, {
    current: async () => ({ digest: 'a'.repeat(64), generation: 1 }),
    assertCurrent: () => { if (!valid) throw new Error('provider-principal-changed'); },
    subscribeInvalidation: () => () => {},
    descriptor: async () => ({ id: 'descriptor', version: '1', sha256: digest, scope, owner: true, writable: true }),
    descriptorBytes: async () => bytes,
  });
  const grant = await issuer.connect(lease, signal), selected = await issuer.select(grant, 'descriptor', signal);
  const cancel = new AbortController();
  const stopped = await issuer.captureProviderOperation(grant, selected, cancel.signal);
  const sibling = await issuer.captureProviderOperation(grant, selected, signal);
  cancel.abort();
  assert.throws(() => issuer.inspectProviderOperation(stopped));
  issuer.assertCurrentSelection(grant, selected);
  assert.equal(issuer.inspectProviderOperation(sibling).descriptor.id, 'descriptor');
  const retry = await issuer.captureProviderOperation(grant, selected, signal);
  assert.equal(issuer.inspectProviderOperation(retry).descriptor.id, 'descriptor');
  valid = false;
  assert.throws(() => issuer.inspectProviderOperation(retry), /provider-principal-changed/);
  valid = true;
  assert.throws(() => issuer.assertCurrentGrant(grant), /provider-grant-invalid/);
  assert.throws(() => issuer.inspectProviderOperation(sibling));
  issuer.releaseProviderOperation(stopped); issuer.releaseProviderOperation(sibling); issuer.releaseProviderOperation(retry);
});

test('online provider proof captures its own fresh issued lease, not the older cache lease', async () => {
  const f = await fixture(), other = await fixture(); teardown.push(() => f.driver.close(), () => other.driver.close());
  const oldLease = await f.lease(), freshLease = await f.lease(); assert.notEqual(oldLease, freshLease);
  const scope = f.source.world.scope, signal = f.signal;
  const issuer = new ProviderGrantIssuer(f.authority, { current: async () => ({ digest: 'a'.repeat(64), generation: 1 }),
    assertCurrent: () => {}, descriptor: async () => ({ id: 'synthetic-descriptor', version: '1', sha256: 'b'.repeat(64), scope, owner: true, writable: true }) });
  const grant = await issuer.connect(freshLease, signal), selected = await issuer.select(grant, 'synthetic-descriptor', signal);
  const proof = Object.freeze({ scope }) as unknown as ActiveLibraryProof, priv = f.authority as unknown as Priv;
  // The proof record is synthetic, but the authority WeakMaps and issuer selection fence are real.
  priv.proofs.set(proof, { lease: freshLease, generation: priv.generation,
    tuple: { ...f.source.tuple(), provider: { ownerNamespace: GRANT.namespaceId, requestId: uuid(), binding: {} } },
    providerFence: () => issuer.assertCurrentSelection(grant, selected) });
  assert.throws(() => f.authority.capture(oldLease, proof, signal), /host-proof-invalid/);
  const captured = f.authority.captureRecord(f.authority.captureOnlineProviderProof(proof, signal));
  assert.equal(captured.lease, freshLease); assert.equal(captured.family, 'library');
  assert.throws(() => f.authority.captureOnlineProviderProof({ scope } as ActiveLibraryProof, signal), /provider-admission-required/);
  assert.throws(() => other.authority.captureOnlineProviderProof(proof, signal), /provider-admission-required/);
  const local = await f.authority.inspect(freshLease, scope.libraryId, signal);
  assert.throws(() => f.authority.captureOnlineProviderProof(local, signal), /provider-admission-required/);
  const offline = Object.freeze({ scope }) as unknown as ActiveLibraryProof;
  priv.proofs.set(offline, { lease: freshLease, generation: priv.generation, tuple: captured.tuple, offline: {}, providerFence: () => {} });
  assert.throws(() => f.authority.captureOnlineProviderProof(offline, signal), /provider-admission-required/);
  const aborted = new AbortController(); aborted.abort(); assert.throws(() => f.authority.captureOnlineProviderProof(proof, aborted.signal));
  issuer.disconnect(grant); assert.throws(() => f.authority.captureOnlineProviderProof(proof, signal), /provider-grant-invalid/);
  f.authority.invalidate(); assert.throws(() => f.authority.captureOnlineProviderProof(proof, signal));
});

test('discovery lists stored libraries and unacknowledged creations from one readonly snapshot, with opaque handles', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const lease = await f.lease();
  const listing = await f.driver.discover(lease, f.signal);
  assert.deepEqual(listing.libraries.map(item => [item.title, item.status]), [['Stored library', 'available']]);
  assert.deepEqual(listing.creations.map(item => [item.title, item.outcome.status]), [['Pending library', 'pending']]);
  assert.equal(listing.canCreateLibrary, true);
  assert.deepEqual(Object.keys(listing.libraries[0].handle), [], 'handle exposes no identifier');
  assert.equal(f.authority.ioLeases.length > 0, true);
});

test('only objects this driver issued are accepted: forged lease, handle and proof are refused', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const lease = await f.lease();
  const handle = (await f.driver.discover(lease, f.signal)).libraries[0].handle;
  await assert.rejects(f.driver.discover({} as HostLease, f.signal));
  assert.throws(() => f.driver.initialization({} as HostLease));
  await assert.rejects(f.driver.inspect(lease, {} as LibraryHandle, f.signal), /invalid-handle/);
  const proof = await f.driver.inspect(lease, handle, f.signal);
  const forged = { scope: proof.scope } as unknown as ActiveLibraryProof;
  await assert.rejects(f.driver.openScope(forged, f.signal), /invalid-admission/);
  await assert.rejects(f.driver.revalidate(forged, f.signal), /invalid-admission/);
  assert.equal(f.driver.sameAdmission(forged, proof), false);
  assert.equal(f.driver.sameAdmission(proof, proof), true);
});

test('openScope yields stable gated resources whose peer comes from the admitted proof', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close());
  const { resources, proof } = await f.open();
  assert.equal(resources.peerId, f.source.world.peer.peerId); assert.deepEqual(resources.repository.scope, proof.scope);
  assert.equal(resources.markdownImages, resources.repository); assert.deepEqual(resources.markdownDrafts.targets(), ['draft-a']);
  await resources.close();
});

test('acquisition signal cancellation after openScope does not revoke the admitted gate', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const acquisition = new AbortController();
  const { resources } = await f.open(acquisition.signal); acquisition.abort();
  assert.deepEqual(resources.markdownDrafts.targets(), ['draft-a']); await resources.close();
});

test('an aborted acquisition publishes no resources', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const first = await f.lease();
  const handle = (await f.driver.discover(first, f.signal)).libraries[0].handle, proof = await f.driver.inspect(first, handle, f.signal);
  const acquisition = new AbortController(); const pending = f.driver.openScope(proof, acquisition.signal); acquisition.abort();
  await assert.rejects(pending); // refused before any gate exists: nothing is published and nothing leaks
});

test('host loss revokes the gate synchronously; same-proof reauthorization restores the same resources under the new lease', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close());
  const { resources, proof, first } = await f.open(); const repository = resources.repository, drafts = resources.markdownDrafts;
  let lost = 0; const unsubscribe = f.driver.subscribeInvalidation(() => { lost++; });
  f.authority.invalidate(); assert.equal(lost, 1); unsubscribe();
  assert.ok(resources.workspacePreferences);
  assert.throws(() => resources.workspacePreferences!.read(), (error: unknown) => error instanceof GateOperationStale);
  assert.ok(resources.selectionPreferences);
  assert.throws(() => resources.selectionPreferences!.read(), (error: unknown) => error instanceof GateOperationStale);
  assert.throws(() => resources.selectionPreferences!.write({ version: 1, documentId: null, folderId: null }), (error: unknown) => error instanceof GateOperationStale);
  assert.ok(resources.queryPreferences);
  assert.throws(() => resources.queryPreferences!.read(), (error: unknown) => error instanceof GateOperationStale);
  assert.throws(() => resources.queryPreferences!.write({ text: 'private', scope: 'all', tag: '', read: 'all', sort: 'title', descending: false }), (error: unknown) => error instanceof GateOperationStale);
  assert.throws(() => resources.workspacePreferences!.write({ version: 1, theme: 'dark', uiScale: 1, catalogOpen: false, editorWidth: 40, catalogHeight: 45, sidebarWidth: 280 }), (error: unknown) => error instanceof GateOperationStale);
  assert.throws(() => resources.markdownDrafts.targets(), (error: unknown) => error instanceof GateOperationStale);
  await assert.rejects(resources.repository.pending(), (error: unknown) => error instanceof GateOperationStale);
  await assert.rejects(f.driver.revalidate(proof, f.signal), /host-/, 'old lease cannot revalidate');
  const second = await f.lease(); assert.notEqual(second, first);
  const next = await f.driver.inspect(second, (await f.driver.discover(second, f.signal)).libraries[0].handle, f.signal);
  assert.equal(f.driver.sameAdmission(proof, next), true);
  const acquisition = new AbortController(); await resources.reauthorize(next, acquisition.signal); acquisition.abort();
  assert.equal(resources.repository, repository); assert.equal(resources.markdownDrafts, drafts);
  assert.deepEqual(resources.markdownDrafts.targets(), ['draft-a']);
  const before = f.authority.ioLeases.length; await resources.repository.pending().catch(() => undefined);
  assert.ok(f.authority.ioLeases.length > before, 'repository I/O reached the host again');
  assert.ok(f.authority.ioLeases.slice(before).every(item => item === second), 'new operations use only the new lease');
  await resources.close();
});

test('reauthorization refuses a changed admission and keeps the gate closed', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close());
  const { resources } = await f.open(); f.authority.invalidate();
  f.source.world.peerChanged = true; const second = await f.lease();
  const next = await f.driver.inspect(second, (await f.driver.discover(second, f.signal)).libraries[0].handle, f.signal);
  await assert.rejects(resources.reauthorize(next, f.signal), /host-admission-changed/);
  assert.throws(() => resources.markdownDrafts.targets(), (error: unknown) => error instanceof GateOperationStale);
});

test('a lease or proof from another admission cannot be attached by reauthorize', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const { resources } = await f.open(); f.authority.invalidate();
  await assert.rejects(resources.reauthorize({ scope: resources.repository.scope } as unknown as ActiveLibraryProof, f.signal), /invalid-admission/);
  assert.throws(() => resources.markdownDrafts.targets(), (error: unknown) => error instanceof GateOperationStale);
});

test('revalidation rereads the migration hold and the stored admission tuple in one transaction', async () => {
  const hold = { value: 'clear' as 'clear' | 'held' }, f = await fixture(hold); teardown.push(() => f.driver.close());
  const { proof, resources } = await f.open(); await f.driver.revalidate(proof, f.signal);
  hold.value = 'held'; await assert.rejects(f.driver.revalidate(proof, f.signal), /hold-active/);
  hold.value = 'clear'; await f.driver.revalidate(proof, f.signal);
  f.source.world.peerChanged = true; await assert.rejects(f.driver.revalidate(proof, f.signal), /host-admission-changed|host-operation-invalid/);
  await resources.close();
});

test('a held migration blocks opening a scope', async () => {
  const hold = { value: 'clear' as 'clear' | 'held' }, f = await fixture(hold); teardown.push(() => f.driver.close()); const lease = await f.lease();
  const proof = await f.driver.inspect(lease, (await f.driver.discover(lease, f.signal)).libraries[0].handle, f.signal);
  hold.value = 'held'; await assert.rejects(f.driver.openScope(proof, f.signal), /hold-active/);
});

test('pagehide invalidates every lease and gate synchronously', async () => {
  const listeners = new Map<string, () => void>(), host = globalThis as unknown as { addEventListener?: unknown; removeEventListener?: unknown };
  const saved = [host.addEventListener, host.removeEventListener];
  host.addEventListener = (type: string, listener: () => void) => { listeners.set(type, listener); }; host.removeEventListener = (type: string) => { listeners.delete(type); };
  try {
    const f = await fixture(); const { resources } = await f.open(); let lost = 0; f.driver.subscribeInvalidation(() => { lost++; });
    listeners.get('pagehide')!(); assert.equal(lost, 1);
    assert.throws(() => resources.markdownDrafts.targets(), (error: unknown) => error instanceof GateOperationStale);
    await f.driver.close(); assert.equal(listeners.has('pagehide'), false);
  } finally { host.addEventListener = saved[0]; host.removeEventListener = saved[1]; }
});

test('close is idempotent, closes owned resources and refuses new work', async () => {
  const f = await fixture(); const { resources } = await f.open();
  await Promise.all([f.driver.close(), f.driver.close()]); await resources.close();
  assert.throws(() => resources.markdownDrafts.targets(), (error: unknown) => error instanceof GateOperationStale);
  await assert.rejects(f.driver.readLocalContext(f.signal), /host-closed/);
  await assert.rejects(f.driver.provisionLocalContext(f.signal), /host-closed/);
});

test('resource close is idempotent and terminal for reauthorization', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const { resources, proof } = await f.open();
  await Promise.all([resources.close(), resources.close()]);
  await assert.rejects(resources.reauthorize(proof, f.signal), /host-closed/);
});

// ---- readonly migration hold ----
function holdFactory(state: { exists: boolean; version?: number; stores?: string[]; hold?: unknown; opened: number; created: number }): IDBFactory {
  return { open() {
    state.opened++;
    const request: { result?: unknown; error?: unknown; transaction?: { abort(): void }; onupgradeneeded: (() => void) | null; onerror: (() => void) | null; onsuccess: (() => void) | null; onblocked: (() => void) | null } =
      { onupgradeneeded: null, onerror: null, onsuccess: null, onblocked: null };
    queueMicrotask(() => {
      if (!state.exists) { request.transaction = { abort() {} }; request.error = new DOMException('Aborted', 'AbortError'); request.onupgradeneeded?.(); request.onerror?.(); return; }
      const rows: Row[] = state.hold === undefined ? [] : [{ key: 'origin', scope: 'origin', value: state.hold }];
      const database = fakeDatabase({ holds: rows }) as unknown as Record<string, unknown>;
      request.result = Object.assign(database, { version: state.version ?? 3, objectStoreNames: { contains: (name: string) => (state.stores ?? ['holds']).includes(name) } });
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  } } as unknown as IDBFactory;
}
test('hold reader never creates the database: absent is clear, existing hold is held, unverifiable fails closed', async () => {
  const signal = new AbortController().signal;
  const absent = { exists: false, opened: 0, created: 0 };
  assert.equal(await readLegacyHoldReadonly(signal, holdFactory(absent), 'x'), 'clear'); assert.equal(absent.created, 0);
  assert.equal(await readLegacyHoldReadonly(signal, holdFactory({ exists: true, opened: 0, created: 0 }), 'x'), 'clear');
  assert.equal(await readLegacyHoldReadonly(signal, holdFactory({ exists: true, hold: { version: 1, runId: uuid() }, opened: 0, created: 0 }), 'x'), 'held');
  await assert.rejects(readLegacyHoldReadonly(signal, holdFactory({ exists: true, hold: { version: 2 }, opened: 0, created: 0 }), 'x'));
  await assert.rejects(readLegacyHoldReadonly(signal, holdFactory({ exists: true, version: 2, opened: 0, created: 0 }), 'x'), /legacy-hold-unverifiable/);
  await assert.rejects(readLegacyHoldReadonly(signal, holdFactory({ exists: true, stores: ['plans'], opened: 0, created: 0 }), 'x'), /legacy-hold-unverifiable/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readLegacyHoldReadonly(aborted.signal, holdFactory({ exists: true, opened: 0, created: 0 }), 'x'));
});

test('type surface: resources expose exactly the ScopeResources contract', async () => {
  const f = await fixture(); teardown.push(() => f.driver.close()); const { resources } = await f.open();
  const keys: (keyof ScopeResources)[] = ['repository', 'markdownDrafts', 'markdownImages', 'appendDrafts', 'readerState', 'inkPreferences', 'outputFile', 'workspacePreferences', 'selectionPreferences', 'queryPreferences', 'peerId', 'reauthorize', 'close'];
  assert.deepEqual(Object.keys(resources).sort(), [...keys].sort()); await resources.close();
});
