import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopBootstrapHostDriver } from '../../../src/adapters/desktop/bootstrapHostDriver.ts';
import { BootstrapSession } from '../../../src/features/bootstrap/BootstrapSession.ts';
import { RuntimeIoGate } from '../../../src/runtime/lifecycle/RuntimeIoGate.ts';
import type { ProviderOwnerFacade } from '../../../src/features/bootstrap/bootstrapPorts.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
for (const failures of [1, 2]) for (const viaSession of [false, true]) test(`Native offline retirement survives ${failures} failed cleanup attempts with the same lease (${viaSession ? 'BootstrapSession' : 'driver'})`, async () => {
  const target = globalThis as unknown as Record<string, unknown>, saved = { window:target.window, addEventListener:target.addEventListener, removeEventListener:target.removeEventListener };
  const listeners = new Set<() => void>(), entered = deferred(), finish = deferred();
  target.window = { __PAPEER_PORT:4321, __PAPEER_TOKEN:'close-retry-unit-bearer' };
  target.addEventListener = (_name:string, listener:() => void) => listeners.add(listener);
  target.removeEventListener = (_name:string, listener:() => void) => listeners.delete(listener);
  const calls: { path:string; lease:string|null }[] = []; let locks = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'),'Bearer close-retry-unit-bearer'); calls.push({ path, lease:headers.get('X-Papeer-Host-Lease') });
    let value:unknown;
    if (path.endsWith('/local-context/read')) value = { status:'ready', leaseId:'original-private-lease' };
    else if (path.endsWith('/offline/unlock')) value = { unlockSession:'private-session', choices:[{ handle:'private-choice', title:'Library' }] };
    else if (path.endsWith('/offline/lock')) {
      locks++; if (locks <= failures) return new Response('{}',{status:503});
      entered.resolve(); await finish.promise; value = { status:'locked' };
    } else if (path.endsWith('/release')) value = { status:'released' };
    else throw new Error('unexpected route '+path);
    return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const driver = createDesktopBootstrapHostDriver(fetcher), session = viaSession ? new BootstrapSession(driver) : null;
  const close = () => session ? session.close() : driver.close();
  try {
    const offline = driver.getOffline!(); await offline.unlock('synthetic sufficiently long secret',new AbortController().signal);
    const first = close(), concurrent = close(); assert.equal(first,concurrent);
    await assert.rejects(first,/offline-close-incomplete/);
    for (let attempt=1;attempt<failures;attempt++) {
      const failedAgain=close();assert.equal(close(),failedAgain);await assert.rejects(failedAgain,/offline-close-incomplete/);
    }
    assert.equal(locks,failures); assert.equal(calls.some(value => value.path.endsWith('/release')),false);
    if (session) assert.notEqual(session.getSnapshot().phase,'closed');
    const before = calls.length;
    await assert.rejects(driver.readLocalContext(new AbortController().signal),/host-unavailable/);
    await assert.rejects(offline.unlock('synthetic sufficiently long secret',new AbortController().signal),/host-unavailable/);
    assert.equal(calls.length,before,'failed cleanup never reopens ordinary operations');
    const retry = close(); void retry.catch(() => undefined); assert.notEqual(retry,first); assert.equal(close(),retry);
    await Promise.race([entered.promise,retry.then(() => { throw new Error('cleanup unexpectedly completed before lock'); })]);
    assert.equal(locks,failures+1); assert.equal(calls.filter(value => value.path.endsWith('/local-context/read')).length,1);
    assert.deepEqual(calls.filter(value => value.path.endsWith('/offline/lock')).map(value => value.lease),Array(failures+1).fill('original-private-lease'));
    finish.resolve(); const result = await retry; if (session) assert.equal((result as {status:string}).status,'allowed');
    assert.equal(listeners.size,0); assert.deepEqual(calls.filter(value => value.path.endsWith('/release')).map(value => value.lease),['original-private-lease']);
    const after = calls.length; await close(); assert.equal(calls.length,after,'successful close stays idempotent');
  } finally {
    finish.resolve(); await driver.close().catch(() => undefined);
    for (const [name,value] of Object.entries(saved)) { if (value === undefined) delete target[name]; else target[name] = value; }
  }
});

for (const boundary of ['provider-cancel','gate'] as const) test(`outer close propagates ${boundary} failure and retries without reopening retired authority`,async()=>{
  const target=globalThis as unknown as Record<string,unknown>,saved={window:target.window,addEventListener:target.addEventListener,removeEventListener:target.removeEventListener,localStorage:target.localStorage};
  target.window={__PAPEER_PORT:4321,__PAPEER_TOKEN:'boundary-unit-bearer'};target.addEventListener=()=>{};target.removeEventListener=()=>{};
  target.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{},key:()=>null,length:0};
  const scope={accountId:crypto.randomUUID(),libraryId:crypto.randomUUID(),epoch:crypto.randomUUID()},requestId=crypto.randomUUID();
  const admission={authorizationMode:'provider-offline',admissionId:'private-admission',scope,peerId:crypto.randomUUID(),fingerprint:'a'.repeat(64)};
  const calls:{path:string;lease:string|null}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname,headers=new Headers(init?.headers);assert.equal(headers.get('Authorization'),'Bearer boundary-unit-bearer');
    calls.push({path,lease:headers.get('X-Papeer-Host-Lease')});let value:unknown;
    if(path.endsWith('/local-context/read'))value={status:'ready',leaseId:'boundary-private-lease'};
    else if(path.endsWith('/offline/unlock'))value={unlockSession:'private-session',choices:[{handle:'private-choice',title:'Library'}]};
    else if(path.endsWith('/offline/open'))value={authorizationMode:'provider-offline',leaseId:'boundary-private-lease',handleId:'private-handle',requestId};
    else if(path.endsWith('/inspect')||path.endsWith('/revalidate'))value=admission;
    else if(path.endsWith('/offline/lock'))value={status:'locked'};
    else if(path.endsWith('/release'))value={status:'released'};
    else throw Error('unexpected route '+path);
    return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const driver=createDesktopBootstrapHostDriver(fetcher),provider=driver.getProvider!() as ProviderOwnerFacade&{cancelPending():Promise<void>};
  const cancel=provider.cancelPending,gateClose=RuntimeIoGate.prototype.close;let failed=true;
  try{
    const offline=driver.getOffline!(),unlocked=await offline.unlock('synthetic sufficiently long secret',new AbortController().signal);
    if(boundary==='gate'){
      const installed=await offline.open(unlocked.session,unlocked.choices[0]!.handle,new AbortController().signal);
      const proof=await driver.inspect(installed.lease,installed.handle,new AbortController().signal);await driver.openScope(proof,new AbortController().signal);
      RuntimeIoGate.prototype.close=function(){return failed?Promise.reject(Error('synthetic-gate-incomplete')):gateClose.call(this);};
    }else provider.cancelPending=async()=>{if(failed)throw Error('synthetic-provider-cancel-incomplete');await cancel();};
    const expected=boundary==='gate'?/synthetic-gate-incomplete/:/synthetic-provider-cancel-incomplete/;
    await assert.rejects(driver.close(),expected);await assert.rejects(driver.close(),expected);
    assert.equal(calls.some(value=>value.path.endsWith('/release')),false);
    await assert.rejects(offline.unlock('synthetic sufficiently long secret',new AbortController().signal),/host-unavailable/);
    failed=false;await driver.close();
    assert.equal(calls.filter(value=>value.path.endsWith('/offline/unlock')).length,1);
    assert.equal(calls.filter(value=>value.path.endsWith('/offline/lock')).length,1,'completed retirement is not repeated');
    const releases=calls.filter(value=>value.path.endsWith('/release'));assert.ok(releases.length>0);assert.equal(releases.every(value=>value.lease==='boundary-private-lease'),true);
  }finally{
    failed=false;provider.cancelPending=cancel;RuntimeIoGate.prototype.close=gateClose;await driver.close().catch(()=>undefined);
    for(const[name,value]of Object.entries(saved)){if(value===undefined)delete target[name];else target[name]=value;}
  }
});
