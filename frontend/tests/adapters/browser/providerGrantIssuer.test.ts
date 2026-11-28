import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderGrantIssuer } from '../../../src/adapters/browser/ownership/providerGrantIssuer.ts';
import type { HostLease, ProviderGrant, RemoteLibraryHandle } from '../../../src/features/bootstrap/bootstrapPorts.ts';
import type { HostOperation, LocalHostAuthority } from '../../../src/adapters/browser/localHostAuthority.ts';

test('provider grant and descriptor handles reject forgeries, stale identity and other scopes', async () => {
  const lease = Object.freeze({}) as HostLease; let valid = true, generation = 1;
  const authority = {
    captureNamespaceOwner(value: HostLease, signal: AbortSignal) {
      if (value !== lease || !valid || signal.aborted) throw new Error('lease-invalid');
      return { signal } as HostOperation;
    },
    captureRecord() { if (!valid) throw new Error('lease-invalid'); return {} as ReturnType<LocalHostAuthority['captureRecord']>; },
  };
  const scope = { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() };
  const principal = 'a'.repeat(64); // A verified provider identity digest is independent of the local namespace UUID.
  let descriptorVersion = '1', writable = true;
  const issuer = new ProviderGrantIssuer(authority, {
    async current() { return { digest: principal, generation }; },
    async descriptor(_principal, selection) { return { id: selection, version: descriptorVersion, sha256: 'b'.repeat(64), scope, owner: true, writable: writable as true }; },
  });
  const signal = new AbortController().signal, grant = await issuer.connect(lease, signal);
  const handle = await issuer.select(grant, 'remote-descriptor', signal);
  assert.notEqual(principal, scope.accountId);
  assert.deepEqual((await issuer.resolve(grant, handle, scope, signal)).scope, scope);
  await assert.rejects(issuer.resolve({} as ProviderGrant, handle, scope, signal));
  await assert.rejects(issuer.resolve(grant, {} as RemoteLibraryHandle, scope, signal));
  await assert.rejects(issuer.resolve(grant, handle, { ...scope, libraryId: crypto.randomUUID() }, signal));
  descriptorVersion = '2'; await assert.rejects(issuer.resolve(grant, handle, scope, signal)); descriptorVersion = '1';
  await assert.rejects(issuer.resolve(grant, handle, scope, signal));
  const grant2 = await issuer.connect(lease, signal), handle2 = await issuer.select(grant2, 'remote-descriptor', signal);
  writable = false; await assert.rejects(issuer.resolve(grant2, handle2, scope, signal)); writable = true;
  await assert.rejects(issuer.resolve(grant2, handle2, scope, signal));
  const grant3 = await issuer.connect(lease, signal), handle3 = await issuer.select(grant3, 'remote-descriptor', signal);
  generation++; await assert.rejects(issuer.resolve(grant3, handle3, scope, signal));
  generation--; await assert.rejects(issuer.resolve(grant3, handle3, scope, signal));
  valid = false; await assert.rejects(issuer.resolve(grant3, handle3, scope, signal));
});

test('an owner lease invalidated while descriptor verification awaits cannot issue a handle', async () => {
  const lease = Object.freeze({}) as HostLease; let active = true, release!: () => void;
  const authority = {
    captureNamespaceOwner(_lease: HostLease, signal: AbortSignal) { if (!active) throw new Error('lease-invalid'); return { signal } as HostOperation; },
    captureRecord() { if (!active) throw new Error('lease-invalid'); return {} as ReturnType<LocalHostAuthority['captureRecord']>; },
  };
  const issuer = new ProviderGrantIssuer(authority, {
    async current() { return { digest: 'a'.repeat(64), generation: 1 }; },
    async descriptor() { await new Promise<void>(resolve => { release = resolve; });
      return { id: 'descriptor', version: '1', sha256: 'b'.repeat(64), scope: { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() }, owner: true, writable: true }; },
  });
  const signal = new AbortController().signal, grant = await issuer.connect(lease, signal);
  const pending = issuer.select(grant, 'descriptor', signal);
  for (let attempt = 0; !release && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(release, 'descriptor verifier entered');
  active = false; release(); await assert.rejects(pending);
});

test('disconnect during a pending descriptor check permanently rejects that grant', async () => {
  const lease = Object.freeze({}) as HostLease; let release!: () => void;
  const authority = {
    captureNamespaceOwner(_lease: HostLease, signal: AbortSignal) { return { signal } as HostOperation; },
    captureRecord() { return {} as ReturnType<LocalHostAuthority['captureRecord']>; },
  };
  const issuer = new ProviderGrantIssuer(authority, {
    async current() { return { digest: 'a'.repeat(64), generation: 1 }; },
    async descriptor() { await new Promise<void>(resolve => { release = resolve; });
      return { id: 'descriptor', version: '1', sha256: 'b'.repeat(64), scope: { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() }, owner: true, writable: true }; },
  });
  const signal = new AbortController().signal, grant = await issuer.connect(lease, signal);
  const pending = issuer.select(grant, 'descriptor', signal);
  for (let attempt = 0; !release && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(release, 'descriptor verifier entered');
  issuer.disconnect(grant); release(); await assert.rejects(pending);
  await assert.rejects(issuer.select(grant, 'descriptor', signal));
});


function resumeIssuerFixture() {
  const oldLease = Object.freeze({}) as HostLease, newLease = Object.freeze({}) as HostLease;
  let activeLease = oldLease, generation = 1, digest = 'a'.repeat(64), held: Promise<void> | null = null;
  let owner = { version: 1 as const, kind: 'local-created' as const, contextId: crypto.randomUUID(), namespaceId: crypto.randomUUID(), revision: crypto.randomUUID() };
  const authority = {
    captureNamespaceOwner(lease: HostLease, signal: AbortSignal) { signal.throwIfAborted(); if (lease !== activeLease) throw new Error('lease-invalid'); return { lease, signal } as unknown as HostOperation; },
    captureRecord(operation: HostOperation) {
      const op = operation as unknown as { lease: HostLease; signal: AbortSignal }; op.signal.throwIfAborted();
      if (op.lease !== activeLease) throw new Error('lease-invalid');
      return { grant: owner } as ReturnType<LocalHostAuthority['captureRecord']>;
    },
  };
  const issuer = new ProviderGrantIssuer(authority, {
    assertCurrent(principal) { if (principal.digest !== digest || principal.generation !== generation) throw new Error('auth-changed'); },
    async current(signal) { if (held) await held; signal.throwIfAborted(); return { digest, generation }; },
    async descriptor() { throw new Error('not needed for owner readmission'); },
  });
  return { issuer, oldLease, newLease, freshLease() { activeLease = newLease; }, changeOwner() { owner = { ...owner, revision: crypto.randomUUID() }; },
    changeAccount() { digest = 'b'.repeat(64); }, changeGeneration() { generation++; }, hold(value: Promise<void>) { held = value; } };
}

test('pagehide retirement issues only a new grant under fresh same-owner lease; old and forged grants stay dead', async () => {
  const f = resumeIssuerFixture(), signal = new AbortController().signal;
  const old = await f.issuer.connect(f.oldLease, signal); f.issuer.parkForPageHide(old);
  assert.throws(() => f.issuer.assertCurrentGrant(old)); f.freshLease();
  const fresh = await f.issuer.resumeParked(old, f.newLease, signal);
  assert.notEqual(fresh, old); f.issuer.assertCurrentGrant(fresh);
  assert.throws(() => f.issuer.assertCurrentGrant(old));
  await assert.rejects(f.issuer.resumeParked(old, f.newLease, signal));
  await assert.rejects(f.issuer.resumeParked({} as ProviderGrant, f.newLease, signal));
});

test('retained readmission refuses changed owner, credential generation/account, explicit disconnect and cancellation', async () => {
  for (const refusal of ['owner', 'generation', 'account', 'disconnect', 'abort'] as const) {
    const f = resumeIssuerFixture(), controller = new AbortController();
    const grant = await f.issuer.connect(f.oldLease, controller.signal); f.issuer.parkForPageHide(grant); f.freshLease();
    if (refusal === 'owner') f.changeOwner(); if (refusal === 'generation') f.changeGeneration();
    if (refusal === 'account') f.changeAccount(); if (refusal === 'disconnect') f.issuer.disconnect(grant);
    if (refusal === 'abort') controller.abort();
    await assert.rejects(f.issuer.resumeParked(grant, f.newLease, controller.signal));
    assert.throws(() => f.issuer.assertCurrentGrant(grant));
  }
});

test('logout while fresh credential verification is pending cancels and cannot mint replacement authority', async () => {
  const f = resumeIssuerFixture(), signal = new AbortController().signal, grant = await f.issuer.connect(f.oldLease, signal);
  f.issuer.parkForPageHide(grant); f.freshLease(); let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.issuer.resumeParked(grant, f.newLease, signal); f.issuer.disconnect(grant); release();
  await assert.rejects(pending); assert.throws(() => f.issuer.assertCurrentGrant(grant));
});
