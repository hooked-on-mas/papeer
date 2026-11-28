// Place under frontend/tests/adapters/browser/ after applying the three candidates.
// The queue-only authority here is synthetic; actual IDB admission/CAS is covered by the existing browser fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexedDbPlan } from '../../../src/adapters/browser/indexedDbPlan.ts';
import type { HostOperation, LocalHostAuthority } from '../../../src/adapters/browser/localHostAuthority.ts';
import type { PlanDatabase } from '../../../src/runtime/edits/repositoryPlan.ts';
import { createPlanEvidence } from '../../../src/runtime/edits/repositoryExecution.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const scope={accountId:'account',libraryId:'library',epoch:'epoch'};
function fixture(){
 let valid=true;
 const authority={captureRecord:(operation:HostOperation)=>{if(!valid||operation.signal.aborted)throw new Error('host-operation-invalid');return {};}} as unknown as LocalHostAuthority;
 const make=(signal:AbortSignal,selected=scope)=>{const host={signal};return new IndexedDbPlan(authority,host,selected,createPlanEvidence('queue').bind(host));};
 return {make,invalidate:()=>{valid=false;}};
}

test('retry lease excludes successor CAS and abort cannot let a third bypass it',async()=>{
 const f=fixture(), first=f.make(new AbortController().signal), cancelled=new AbortController(), second=f.make(cancelled.signal), third=f.make(new AbortController().signal);
 const entered=deferred(),release=deferred();let ranThird=false, leaked!:PlanDatabase;
 const a=first.withRetryLease(async bound=>{leaked=bound;entered.resolve();await release.promise;});await entered.promise;
 const b=second.withRetryLease(async()=>assert.fail('cancelled waiter ran')).then(()=>false,()=>true);
 const c=third.withRetryLease(async()=>{ranThird=true;});cancelled.abort();assert.equal(await b,true);
 await Promise.resolve();assert.equal(ranThird,false);release.resolve();await Promise.all([a,c]);assert.equal(ranThird,true);
 await assert.rejects(async()=>leaked.capture('read',[]),/retry-lease-expired/);
});

test('failed lease releases, scopes are distinct, and queued start rechecks authority',async()=>{
 const f=fixture(), signal=new AbortController().signal, first=f.make(signal), second=f.make(signal), other=f.make(signal,{...scope,epoch:'other'});
 await assert.rejects(first.withRetryLease(async()=>{throw new Error('synthetic');}),/synthetic/);
 const entered=deferred(),release=deferred();const a=first.withRetryLease(async()=>{entered.resolve();await release.promise;});await entered.promise;
 assert.equal(await other.withRetryLease(async()=>true),true);
 let ran=false;const b=second.withRetryLease(async()=>{ran=true;}).then(()=>false,()=>true);
 const firstRejected=assert.rejects(a,/host-operation-invalid/);
 f.invalidate();release.resolve();await firstRejected;assert.equal(await b,true);assert.equal(ran,false);
});
