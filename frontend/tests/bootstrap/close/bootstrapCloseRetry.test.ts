import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BootstrapSession } from '../../../src/features/bootstrap/BootstrapSession.ts';
import type { BootstrapHostDriver, HostLease, LibraryHandle, ActiveLibraryProof, ScopeResources } from '../../../src/features/bootstrap/bootstrapPorts.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
test('retry after driver retirement failure never reopens or closes the already-transferred runtime twice',async()=>{
  const scope={accountId:crypto.randomUUID(),libraryId:crypto.randomUUID(),epoch:'close-retry'};
  const repository=new DurableEditRepository(scope,new EditMemoryDatabase());
  await repository.initialize({kind:'library',id:scope.libraryId,version:crypto.randomUUID(),items:[],folders:[],links:[],deletions:[]});
  const lease={} as HostLease,handle={} as LibraryHandle,proof={scope} as ActiveLibraryProof;
  const entered=deferred(),finish=deferred();let opened=0,resourcesClosed=0,driverClosed=0;
  const resources={repository,peerId:crypto.randomUUID(),readerState:{scope,read:()=>undefined,write:()=>{}},
    markdownDrafts:{scope,targets:()=>[],read:()=>undefined,write:()=>{},remove:()=>{}},markdownImages:{scope},appendDrafts:{scope,read:()=>undefined},
    reauthorize:async()=>{},close:async()=>{resourcesClosed++;}} as unknown as ScopeResources;
  const driver:BootstrapHostDriver={readHold:async()=> 'clear',readLocalContext:async()=>({status:'ready',lease}),provisionLocalContext:async()=>lease,
    discover:async()=>({libraries:[{handle,title:'One',status:'available'}],creations:[],canCreateLibrary:true}),
    inspect:async()=>proof,openScope:async()=>{opened++;return resources;},revalidate:async()=>{},sameAdmission:(a,b)=>a===b,
    initialization:()=>{throw Error('creation-not-used');},subscribeInvalidation:()=>()=>{},
    close:async()=>{driverClosed++;if(driverClosed===1)throw Error('offline-close-incomplete');entered.resolve();await finish.promise;}};
  const session=new BootstrapSession(driver);
  try{
    await session.start();await session.openLibrary(handle);assert.ok(session.getActiveRuntime());
    await assert.rejects(session.close(),/offline-close-incomplete/);
    assert.equal(session.getActiveRuntime(),null);assert.equal(resourcesClosed,1);assert.notEqual(session.getSnapshot().phase,'closed');
    await session.start();await session.openLibrary(handle);assert.equal(opened,1,'failed close remains fenced');
    const retry=session.close();void retry.catch(()=>undefined);assert.equal(session.close(),retry);
    await Promise.race([entered.promise,retry.then(()=>{throw Error('driver cleanup not retried');})]);
    assert.equal(driverClosed,2);assert.equal(resourcesClosed,1);finish.resolve();assert.equal((await retry).status,'allowed');
    assert.equal(session.getSnapshot().phase,'closed');await session.close();assert.equal(driverClosed,2);assert.equal(resourcesClosed,1);
  }finally{finish.resolve();await session.close().catch(()=>undefined);}
});
