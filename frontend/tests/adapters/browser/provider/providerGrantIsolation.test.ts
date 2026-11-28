import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as settleProviderTimers } from 'node:timers/promises';
import { ProviderGrantIssuer } from '../../../../src/adapters/browser/ownership/providerGrantIssuer.ts';
import type { HostLease } from '../../../../src/features/bootstrap/bootstrapPorts.ts';
import type { ActiveLibraryProof } from '../../../../src/features/bootstrap/bootstrapPorts.ts';
import type { HostOperation, LocalHostAuthority } from '../../../../src/adapters/browser/localHostAuthority.ts';
import { createProviderReplication } from '../../../../src/adapters/browser/provider/providerReplication.ts';

test('file denial permanently revokes its selected handle while another selected Library retains the same live principal grant', async () => {
  const lease = Object.freeze({}) as HostLease, namespace = crypto.randomUUID();
  const authority = {
    captureNamespaceOwner(value: HostLease, signal: AbortSignal) {
      if (value !== lease || signal.aborted) throw new Error('owner-invalid'); return { signal } as HostOperation;
    },
    captureRecord() { return { grant: { namespaceId: namespace } } as ReturnType<LocalHostAuthority['captureRecord']>; },
  };
  const scope = { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() };
  let denied = false, generation = 1;
  const principal = { digest: 'a'.repeat(64), generation };
  const issuer = new ProviderGrantIssuer(authority, {
    current: async () => ({ ...principal, generation }),
    assertCurrent: expected => { if (expected.generation !== generation) throw new Error('provider-auth-changed'); },
    descriptor: async (_principal, selection) => {
      if (denied && selection === 'denied') throw new Error('drive-owner-write-required');
      return { id: selection, version: '1', sha256: 'b'.repeat(64), scope, owner: true, writable: true };
    },
  });
  const signal = new AbortController().signal, grant = await issuer.connect(lease, signal);
  const good = await issuer.select(grant, 'good', signal), bad = await issuer.select(grant, 'denied', signal);
  assert.equal(issuer.currentOwner(grant, signal).ownerNamespace, namespace);
  denied = true; await assert.rejects(issuer.resolve(grant, bad, scope, signal));
  issuer.assertCurrentGrant(grant); issuer.assertCurrentSelection(grant, good);
  assert.equal((await issuer.resolve(grant, good, scope, signal)).id, 'good');
  denied = false; await assert.rejects(issuer.resolve(grant, bad, scope, signal));
  assert.throws(() => issuer.assertCurrentSelection(grant, bad));
  generation++; assert.throws(() => issuer.assertCurrentSelection(grant, good));
  generation--; assert.throws(() => issuer.assertCurrentGrant(grant));
});

test('owned cancellation of an awaited identity refresh keeps the same live selected grant usable', async () => {
  const lease = {} as HostLease, scope = {accountId:crypto.randomUUID(),libraryId:crypto.randomUUID(),epoch:crypto.randomUUID()};
  let slow = false, entered!: () => void;
  const reached = new Promise<void>(resolve=>{entered=resolve;});
  const authority = {
    captureNamespaceOwner(_lease: HostLease, signal: AbortSignal) { if(signal.aborted)throw new DOMException('Cancelled','AbortError');return {signal} as HostOperation; },
    captureRecord() { return {} as ReturnType<LocalHostAuthority['captureRecord']>; },
  };
  const issuer = new ProviderGrantIssuer(authority, {
    current: async signal => { if(slow)await new Promise<never>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});entered();});return {digest:'a'.repeat(64),generation:1}; },
    assertCurrent: () => {}, descriptor: async () => ({id:'descriptor',version:'1',sha256:'b'.repeat(64),scope,owner:true,writable:true}),
  });
  const signal = new AbortController().signal, grant = await issuer.connect(lease,signal), selected = await issuer.select(grant,'descriptor',signal);
  slow = true; const cancellation = new AbortController(), refreshing = issuer.resolve(grant,selected,scope,cancellation.signal);
  await reached; cancellation.abort(); await assert.rejects(refreshing); slow = false;
  issuer.assertCurrentSelection(grant,selected);
  assert.equal((await issuer.resolve(grant,selected,scope,signal)).id,'descriptor');
});

test('a newer stop supersedes an older resume waiting for an existing sync flight', {timeout: 5000}, async () => {
  let group = new AbortController(), acquisitions = 0, renewals = 0, reached!: () => void;
  const entered = new Promise<void>(resolve=>{reached=resolve;});
  const scope = {accountId:crypto.randomUUID(),libraryId:crypto.randomUUID(),epoch:crypto.randomUUID()};
  const authority = {
    admittedPeerId: () => crypto.randomUUID(),
    beginProviderSync: async (_proof: ActiveLibraryProof, signal: AbortSignal) => {
      acquisitions++; if(acquisitions>1)throw new Error('old-resume-restarted-after-stop');
      return new Promise<{assertCurrent():void;release():void}>((_resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});reached();
      });
    },
  } as unknown as LocalHostAuthority;
  const unexpected = async (): Promise<never> => { throw new Error('network-or-import-after-stop'); };
  const replication = createProviderReplication(authority,{} as HostLease,{scope} as ActiveLibraryProof,
    {pull:unexpected,upload:unexpected,uploadResource:unexpected,downloadResource:unexpected,imported:unexpected},
    {signal:()=>group.signal,cancel:()=>group.abort(),renew:()=>{renewals++;if(group.signal.aborted)group=new AbortController();}});
  const original = replication.resume(); await entered;
  const olderResume = replication.resume(), stopped = replication.suspendAndWait();
  const results = await Promise.allSettled([original,olderResume,stopped]);
  assert.equal(results[0].status,'rejected'); assert.equal(results[1].status,'fulfilled'); assert.equal(results[2].status,'fulfilled');
  assert.equal(acquisitions,1); assert.equal(renewals,1); assert.equal(group.signal.aborted,true);
  assert.equal(replication.getSnapshot().suspended,true);
});


function providerTimerGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// A scheduling seam, not a successful authority fixture: every acquired pass is
// denied at the actual private repository capture before IndexedDB or transfer.
function providerTimerFixture(beforeAcquire: (call: number, signal: AbortSignal) => Promise<void> = async () => {}) {
  let group = new AbortController(), acquisitions = 0, captures = 0, renewals = 0, releases = 0;
  const denied = new Error('synthetic-provider-capture-denied');
  const scope = { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() };
  const authority = {
    admittedPeerId: () => crypto.randomUUID(),
    beginProviderSync: async (_proof: ActiveLibraryProof, signal: AbortSignal) => {
      acquisitions++; await beforeAcquire(acquisitions, signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return { assertCurrent() {}, release() { releases++; } };
    },
    captureProviderReplication: () => { captures++; throw denied; },
    refreshProvider: async () => { assert.fail('no successful repository capture or provider transfer'); },
  } as unknown as LocalHostAuthority;
  const unexpected = async (): Promise<never> => { assert.fail('no transfer after denied repository capture'); };
  const replication = createProviderReplication(authority, {} as HostLease, { scope } as ActiveLibraryProof,
    { pull: unexpected, upload: unexpected, uploadResource: unexpected, downloadResource: unexpected, imported: unexpected },
    { signal: () => group.signal, cancel: () => group.abort(), renew: () => { renewals++; if (group.signal.aborted) group = new AbortController(); } });
  return { replication, denied, counts: () => ({ acquisitions, captures, renewals, releases }) };
}

test('provider automatic polling waits five seconds from long pass completion and retries errors', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const held = providerTimerGate(), fixture = providerTimerFixture(async call => { if (call === 1) await held.promise; });
  const first = fixture.replication.resume(), rejected = assert.rejects(first, error => error === fixture.denied);
  t.after(async () => { fixture.replication.suspend(); held.resolve(); await rejected; await fixture.replication.suspendAndWait(); });
  await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 1);
  const joined = fixture.replication.flush(); assert.equal(joined, fixture.replication.flush());
  const joinedRejection = assert.rejects(joined, error => error === fixture.denied);
  t.mock.timers.tick(12000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 1);
  held.resolve(); await Promise.all([rejected, joinedRejection]); await settleProviderTimers();
  assert.deepEqual(fixture.counts(), { acquisitions: 1, captures: 1, renewals: 1, releases: 1 });
  assert.equal(fixture.replication.getSnapshot().suspended, false);
  assert.equal(fixture.replication.getSnapshot().error, String(fixture.denied));
  t.mock.timers.tick(3000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 1, 'no phase-anchored tick at 15 seconds');
  t.mock.timers.tick(1999); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 1);
  t.mock.timers.tick(1); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 2);
  t.mock.timers.tick(4999); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 2);
  t.mock.timers.tick(1); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 3, 'an automatic error retries after its completion delay');
});

test('an immediate joined manual provider pass replaces the pending automatic deadline', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const fixture = providerTimerFixture(); t.after(() => fixture.replication.suspendAndWait());
  await assert.rejects(fixture.replication.resume(), error => error === fixture.denied);
  t.mock.timers.tick(2000); await settleProviderTimers();
  const manual = fixture.replication.flush(); assert.equal(manual, fixture.replication.flush());
  await assert.rejects(manual, error => error === fixture.denied);
  assert.equal(fixture.counts().acquisitions, 2, 'manual flush starts immediately');
  t.mock.timers.tick(3000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 2, 'old 5-second timer is cancelled');
  t.mock.timers.tick(1999); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 2);
  t.mock.timers.tick(1); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 3, 'manual completion establishes the new deadline');
});

test('provider initial admission failure stays suspended and stopped late completion cannot rearm an older resume', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const initialDenied = new Error('synthetic-provider-admission-denied'), held = providerTimerGate();
  const fixture = providerTimerFixture(async call => { if (call === 1) throw initialDenied; if (call === 2) await held.promise; });
  const observed: Promise<unknown>[] = [];
  t.after(async () => { fixture.replication.suspend(); held.resolve(); await Promise.allSettled(observed); await fixture.replication.suspendAndWait(); });
  await assert.rejects(fixture.replication.resume(), error => error === initialDenied);
  assert.equal(fixture.replication.getSnapshot().suspended, true);
  t.mock.timers.tick(20000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 1, 'no automatic admission while suspended');
  const first = fixture.replication.resume(), firstRejected = assert.rejects(first, { name: 'AbortError' }); observed.push(firstRejected);
  await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 2);
  const olderResume = fixture.replication.resume(); observed.push(olderResume);
  fixture.replication.suspend(); held.resolve(); await Promise.all([firstRejected, olderResume]);
  assert.equal(fixture.counts().renewals, 2, 'waiting resume does not renew after newer stop');
  assert.equal(fixture.replication.getSnapshot().suspended, true);
  t.mock.timers.tick(20000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 2, 'late completion cannot resurrect polling');
  await assert.rejects(fixture.replication.resume(), error => error === fixture.denied);
  assert.equal(fixture.counts().renewals, 3); assert.equal(fixture.counts().acquisitions, 3);
  t.mock.timers.tick(5000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 4, 'fresh explicit resume owns automatic polling');
  fixture.replication.suspend(); t.mock.timers.tick(20000); await settleProviderTimers(); assert.equal(fixture.counts().acquisitions, 4);
});
