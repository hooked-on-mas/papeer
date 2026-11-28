import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopProviderOffline, NativeOfflineRejected } from '../../../src/adapters/desktop/provider/offline/providerOffline.ts';
import { createDesktopBootstrapHostDriver } from '../../../src/adapters/desktop/bootstrapHostDriver.ts';
import { ProviderOfflineSession } from '../../../src/features/bootstrap/provider/ProviderOfflineSession.ts';
import type { ActiveLibraryProof, OfflineLibraryHandle, OfflineUnlockSession, ProviderInstalledLibrary } from '../../../src/features/bootstrap/bootstrapPorts.ts';

test('a rejected Native unlock publishes the controller error without retiring another local owner, and retries failed lock on close', async () => {
 const target = globalThis as unknown as Record<string, unknown>, saved = { window:target.window, addEventListener:target.addEventListener, removeEventListener:target.removeEventListener };
 target.window = { __PAPEER_PORT:4321, __PAPEER_TOKEN:'offline-unit-token' }; target.addEventListener = () => {}; target.removeEventListener = () => {};
 let nextLease = 0, locks = 0, invalidations = 0;
 const fetcher: typeof fetch = async input => {
  const path = new URL(String(input)).pathname; let status = 200, body: unknown;
  if (path.endsWith('/local-context/read')) body = { status:'ready', leaseId:'lease-'+(++nextLease) };
  else if (path.endsWith('/discover')) body = { libraries:[], creations:[], canCreateLibrary:true };
  else if (path.endsWith('/offline/unlock')) { status = 403; body = { detail:'canonical-authority-denied' }; }
  else if (path.endsWith('/offline/lock')) { locks++; status = locks === 1 ? 503 : 200; body = status === 200 ? { status:'locked' } : {}; }
  else if (path.endsWith('/release')) body = { status:'released' }; else throw new Error('unexpected route '+path);
  return new Response(JSON.stringify(body), { status, headers:{ 'Content-Type':'application/json' } });
 };
 const driver = createDesktopBootstrapHostDriver(fetcher); let controller: ProviderOfflineSession | undefined;
 try {
  const context = await driver.readLocalContext(new AbortController().signal); assert.equal(context.status, 'ready'); if (context.status !== 'ready') throw new Error('context');
  controller = new ProviderOfflineSession({ getFacade: () => driver.getOffline!(), retained: () => null,
    subscribe: () => () => {}, available: () => true, openInstalled: async () => false, prepareLeave: async () => ({ status:'allowed' }) });
  driver.subscribeInvalidation(() => { invalidations++; controller!.hostLost(); });
  await controller.unlock('secret with sufficient length');
  assert.equal(controller.getSnapshot().error, true); assert.equal(controller.getSnapshot().phase, 'locked');
  assert.equal(invalidations, 0); assert.equal(locks, 1);
  assert.deepEqual(await driver.discover(context.lease, new AbortController().signal), { libraries:[], creations:[], canCreateLibrary:true });
  await driver.close(); assert.equal(locks, 2, 'failed cleanup lock was retained and retried');
 } finally {
  controller?.dispose(); await driver.close();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete target[name]; else target[name] = value; }
 }
});

test('failed unlock on another Native lease preserves installed offline scope, while its own lock retires it', async () => {
 const target = globalThis as unknown as Record<string, unknown>, saved = { window:target.window, addEventListener:target.addEventListener, removeEventListener:target.removeEventListener };
 target.window = { __PAPEER_PORT:4321, __PAPEER_TOKEN:'offline-unit-token' }; target.addEventListener = () => {}; target.removeEventListener = () => {};
 const scope = { accountId:'00000000-0000-4000-8000-000000000001', libraryId:'00000000-0000-4000-8000-000000000002', epoch:'00000000-0000-4000-8000-000000000003' };
 let nextLease = 0, invalidations = 0;
 const fetcher: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname, lease = new Headers(init?.headers).get('X-Papeer-Host-Lease'); let status = 200, body: unknown;
  if (path.endsWith('/local-context/read')) body = { status:'ready', leaseId:'lease-'+(++nextLease) };
  else if (path.endsWith('/offline/unlock')) { if (lease === 'lease-1') body = { unlockSession:'session', choices:[{ handle:'choice', title:'Native Library' }] }; else { status=403; body={ detail:'canonical-authority-denied' }; } }
  else if (path.endsWith('/offline/open')) body = { leaseId:'lease-1', handleId:'native-handle', requestId:'00000000-0000-4000-8000-000000000004', authorizationMode:'provider-offline' };
  else if (path.endsWith('/inspect') || path.endsWith('/revalidate')) body = { admissionId:'native-admission', scope, peerId:'00000000-0000-4000-8000-000000000005', fingerprint:'a'.repeat(64), authorizationMode:'provider-offline' };
  else if (path.endsWith('/offline/lock')) body = { status:'locked' }; else if (path.endsWith('/release')) body = { status:'released' }; else throw new Error('unexpected route '+path);
  return new Response(JSON.stringify(body), { status, headers:{ 'Content-Type':'application/json' } });
 };
 const driver = createDesktopBootstrapHostDriver(fetcher), signal = new AbortController().signal;
 try {
  driver.subscribeInvalidation(() => { invalidations++; }); const offline = driver.getOffline!();
  const session = await offline.unlock('secret with sufficient length', signal), installed = await offline.open(session.session, session.choices[0]!.handle, signal);
  const proof = await driver.inspect(installed.lease, installed.handle, signal); let scoped = 0;
  driver.subscribeScopedInvalidation!(affected => { if (affected.affectsProof(proof)) scoped++; });
  await assert.rejects(offline.unlock('secret with sufficient length', signal), NativeOfflineRejected);
  assert.equal(invalidations, 0); await driver.revalidate(proof, signal);
  await offline.lock(session.session); assert.equal(invalidations, 0); assert.equal(scoped, 1);
  await assert.rejects(driver.revalidate(proof, signal), /invalid-admission|host-unavailable/);
 } finally {
  await driver.close(); for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete target[name]; else target[name] = value; }
 }
});

test('Native offline facade rejects fabricated/cross-session handles and fences late unlock', async () => {
 const calls: string[] = [], retired: object[] = [], binding = {}, signal = new AbortController().signal;
 let release: ((value: unknown) => void) | undefined, delay = false;
 const facade = createDesktopProviderOffline({
  local: async () => binding, active: () => binding, retire: value => { retired.push(value); },
  installed: () => ({}) as ProviderInstalledLibrary,
  call: async (operation) => {
   calls.push(operation);
   if (operation === 'lock') return { status:'locked' };
   if (delay) return new Promise(resolve => { release = resolve; });
   return { unlockSession:'private-token', choices:[{ handle:'private-handle', title:'Private Library' }] };
  },
 });
 const first = await facade.unlock('secret with sufficient length', signal), second = await facade.unlock('secret with sufficient length', signal);
 await assert.rejects(facade.open({} as OfflineUnlockSession, first.choices[0]!.handle, signal));
 await assert.rejects(facade.open(first.session, {} as OfflineLibraryHandle, signal));
 await assert.rejects(facade.open(first.session, second.choices[0]!.handle, signal));
 assert.deepEqual(calls, ['unlock', 'unlock']);
 delay = true; const controller = new AbortController(), pending = facade.unlock('secret with sufficient length', controller.signal);
 while (!release) await new Promise(resolve => setTimeout(resolve, 0));
 controller.abort(); release({ unlockSession:'late-token', choices:[{ handle:'late-handle', title:'Late Library' }] });
 await assert.rejects(pending); assert.equal(calls[calls.length - 1], 'lock'); assert.equal(retired.length, 1);
 await facade.close();
});

test('Desktop driver classifies offline only from Native admission and refuses replication', async () => {
 const target = globalThis as unknown as Record<string, unknown>, saved = { window:target.window, addEventListener:target.addEventListener, removeEventListener:target.removeEventListener };
 target.window = { __PAPEER_PORT:4321, __PAPEER_TOKEN:'offline-unit-token' };
 target.addEventListener = () => {}; target.removeEventListener = () => {};
 const scope = { accountId:'00000000-0000-4000-8000-000000000001', libraryId:'00000000-0000-4000-8000-000000000002', epoch:'00000000-0000-4000-8000-000000000003' };
 const requestId = '00000000-0000-4000-8000-000000000004', seen: string[] = [];
 let mode: unknown = 'provider-offline';
 const fetcher: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname; seen.push(path);
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer offline-unit-token');
  let value: unknown;
  if (path.endsWith('/local-context/read')) value = { status:'ready', leaseId:'native-lease' };
  else if (path.endsWith('/offline/unlock')) value = { unlockSession:'session', choices:[{ handle:'choice', title:'Native Library' }] };
  else if (path.endsWith('/offline/open')) value = { leaseId:'native-lease', handleId:'native-handle', requestId, authorizationMode:'provider-offline' };
  else if (path.endsWith('/inspect') || path.endsWith('/revalidate')) value = { admissionId:'native-admission', scope, peerId:'00000000-0000-4000-8000-000000000005', fingerprint:'a'.repeat(64), authorizationMode:mode };
  else if (path.endsWith('/offline/lock')) value = { status:'locked' };
  else if (path.endsWith('/release')) value = { status:'released' };
  else throw new Error('unexpected route ' + path);
  return new Response(JSON.stringify(value), { status:200, headers:{ 'Content-Type':'application/json' } });
 };
 const driver = createDesktopBootstrapHostDriver(fetcher);
 try {
  const offline = driver.getOffline!(), result = await offline.unlock('secret with sufficient length', new AbortController().signal);
  const installed = await offline.open(result.session, result.choices[0]!.handle, new AbortController().signal);
  assert.equal(installed.requestId, requestId);
  const proof = await driver.inspect(installed.lease, installed.handle, new AbortController().signal);
  assert.equal(driver.storageKind!(proof), 'google-drive'); assert.equal(driver.providerOffline!(proof), true);
  const before = seen.length;
  await assert.rejects(offline.revokeEnrollment(proof, 'secret with sufficient length', new AbortController().signal), /online-provider-admission-required/);
  assert.equal(seen.length, before);
  await assert.rejects(async () => driver.openReplication!(proof, new AbortController().signal), /offline-transfer-denied/);
  assert.equal(seen.some(path => path.includes('/replication/')), false);
  mode = 'provider-online'; await assert.rejects(driver.revalidate(proof, new AbortController().signal), /admission-changed/);
  mode = undefined; await assert.rejects(driver.inspect(installed.lease, installed.handle, new AbortController().signal), /invalid-offline-admission/);
  await offline.lock(result.session);
  await assert.rejects(driver.inspect(installed.lease, installed.handle, new AbortController().signal), /host-unavailable/);
 } finally {
  await driver.close();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete target[name]; else target[name] = value; }
 }
});

test('Native online permission revocation separates definite pre-effect rejection from ambiguous delivery', async () => {
 const binding = {}, seen: string[] = [];
 let mode = 'revoked', controller = new AbortController();
 const facade = createDesktopProviderOffline({
  local: async () => binding, active: () => binding, installed: () => ({}) as ProviderInstalledLibrary,
  retire: () => { throw new Error('Online editor must not be retired'); },
  call: async (operation, body) => {
   seen.push(operation); assert.deepEqual(body, { secret:'secret with sufficient length' });
   if (mode === 'rejected') throw new NativeOfflineRejected('offline-request-rejected');
   if (mode === 'lost') throw new Error('synthetic transport loss');
   if (mode === 'malformed') return {};
   if (mode === 'aborted-after-send') { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
   return { status:mode };
  },
 });
 const proof = {} as ActiveLibraryProof;
 assert.deepEqual(await facade.revokeEnrollment(proof, 'secret with sufficient length', controller.signal), { status:'revoked' });
 mode = 'rejected'; await assert.rejects(facade.revokeEnrollment(proof, 'secret with sufficient length', controller.signal), NativeOfflineRejected);
 for (mode of ['lost', 'malformed', 'unknown', 'aborted-after-send']) {
  controller = new AbortController();
  assert.deepEqual(await facade.revokeEnrollment(proof, 'secret with sufficient length', controller.signal), { status:'unknown' });
 }
 const before = seen.length; controller = new AbortController(); controller.abort();
 await assert.rejects(facade.revokeEnrollment(proof, 'secret with sufficient length', controller.signal), /Cancelled/);
 assert.equal(seen.length, before);
 await facade.close();
});

test('Malformed successful Native unlock retires its host acquisition and retries failed cleanup on close', async () => {
 const binding = {}, events: string[] = [];
 let attempts = 0;
 const facade = createDesktopProviderOffline({
  local: async () => binding, active: () => binding, installed: () => ({}) as ProviderInstalledLibrary,
  retire: () => { events.push('retire'); },
  call: async operation => {
   events.push(operation);
   if (operation === 'unlock') return { unlockSession:'issued-before-decode', choices:[{ handle:'issued-choice', title:17 }] };
   if (operation !== 'lock') throw new Error('unexpected request');
   attempts++;
   if (attempts === 1) throw new Error('synthetic cleanup transport failure');
   return { status:'locked' };
  },
 });
 await assert.rejects(facade.unlock('secret with sufficient length', new AbortController().signal), /offline-response-invalid/);
 assert.deepEqual(events, ['unlock', 'retire', 'lock']);
 await facade.close(); assert.equal(attempts, 2);
 await facade.close(); assert.equal(attempts, 2);
});

for (const retiredDuringHandoff of ['old', 'candidate'] as const) test(`Native scoped retirement isolates two installed gates and fences ${retiredDuringHandoff} during handoff`, async () => {
 const target = globalThis as unknown as Record<string, unknown>;
 const saved = { window:target.window, addEventListener:target.addEventListener, removeEventListener:target.removeEventListener, localStorage:target.localStorage };
 target.window = { __PAPEER_PORT:4321, __PAPEER_TOKEN:'offline-unit-token' }; target.addEventListener = () => {}; target.removeEventListener = () => {};
 target.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
 const scope = { accountId:'00000000-0000-4000-8000-000000000001', libraryId:'00000000-0000-4000-8000-000000000002', epoch:'00000000-0000-4000-8000-000000000003' };
 let nextLease = 0, globalEvents = 0, affectedA = 0, affectedB = 0, block = false;
 let enter!: () => void, release!: () => void;
 const entered = new Promise<void>(resolve => { enter=resolve; }), held = new Promise<void>(resolve => { release=resolve; });
 const fetcher: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname, lease = new Headers(init?.headers).get('X-Papeer-Host-Lease'); let body: unknown;
  if (path.endsWith('/local-context/read')) body = { status:'ready', leaseId:'lease-'+(++nextLease) };
  else if (path.endsWith('/offline/unlock')) body = { unlockSession:'session-'+lease, choices:[{ handle:'choice-'+lease, title:'Native Library' }] };
  else if (path.endsWith('/offline/open')) body = { leaseId:lease, handleId:'handle-'+lease, requestId:'00000000-0000-4000-8000-000000000004', authorizationMode:'provider-offline' };
  else if (path.endsWith('/inspect') || path.endsWith('/revalidate')) {
   if (block && path.endsWith('/revalidate') && lease === 'lease-3') { enter(); await held; }
   body = { admissionId:'admission-'+lease, scope, peerId:'00000000-0000-4000-8000-000000000005', fingerprint:'a'.repeat(64), authorizationMode:'provider-offline' };
  } else if (path.endsWith('/offline/lock')) body = { status:'locked' }; else if (path.endsWith('/release')) body = { status:'released' }; else throw new Error('unexpected route '+path);
  return new Response(JSON.stringify(body), { status:200, headers:{ 'Content-Type':'application/json' } });
 };
 const driver=createDesktopBootstrapHostDriver(fetcher),signal=new AbortController().signal; let resourcesA: Awaited<ReturnType<typeof driver.openScope>> | undefined, resourcesB: Awaited<ReturnType<typeof driver.openScope>> | undefined;
 try {
  const offline=driver.getOffline!();
  const a=await offline.unlock('secret with sufficient length',signal), b=await offline.unlock('secret with sufficient length',signal);
  const ia=await offline.open(a.session,a.choices[0]!.handle,signal), ib=await offline.open(b.session,b.choices[0]!.handle,signal);
  const pa=await driver.inspect(ia.lease,ia.handle,signal), pb=await driver.inspect(ib.lease,ib.handle,signal);
  resourcesA=await driver.openScope(pa,signal); resourcesB=await driver.openScope(pb,signal);
  driver.subscribeInvalidation(()=>{globalEvents++;}); driver.subscribeScopedInvalidation!(affected=>{if(affected.affectsProof(pa))affectedA++;if(affected.affectsProof(pb))affectedB++;});
  await offline.lock(b.session); assert.equal(globalEvents,0); assert.equal(affectedA,0); assert.equal(affectedB,1);
  assert.equal(resourcesA.readerState.read('reader'),null); assert.throws(()=>resourcesB!.readerState.read('reader'));
  const c=await offline.unlock('secret with sufficient length',signal), ic=await offline.open(c.session,c.choices[0]!.handle,signal), pc=await driver.inspect(ic.lease,ic.handle,signal);
  block=true; const handoff=resourcesA.reauthorize(pc,signal); const rejected=assert.rejects(handoff); await entered;
  await offline.lock(retiredDuringHandoff==='old'?a.session:c.session); release(); await rejected;
  assert.throws(()=>resourcesA!.readerState.read('reader')); assert.equal(globalEvents,0);
 } finally {
  release(); await resourcesA?.close(); await resourcesB?.close(); await driver.close();
  for(const [name,value] of Object.entries(saved)){if(value===undefined)delete target[name];else target[name]=value;}
 }
});
