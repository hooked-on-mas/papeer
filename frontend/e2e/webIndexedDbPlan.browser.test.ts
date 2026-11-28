import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import path from 'node:path';
const frontend=path.resolve(import.meta.dirname,'..');
for(const engine of ['chromium','webkit'] as const)test(`IDB plan CAS real local grant (${engine})`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage(), errors:string[]=[];
 page.on('pageerror',error=>errors.push(String(error)));await page.addInitScript(()=>{window.addEventListener('unhandledrejection',event=>{throw new Error(String(event.reason));});});
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);const result=await page.evaluate(()=>(window as unknown as {indexedDbPlanCases():Promise<unknown>}).indexedDbPlanCases());
 assert.deepEqual(result,{operationPermissions:true,readonlyNoDDL:true,ownerReplay:true,crossOwner:true,forgedOwner:true,factoryGate:true,physicalIdentity:true,changed:'changed',committed:'committed',content:'one',reused:true,forbidden:true,unrelatedBlobReads:0,phantom:'changed',bytesChanged:'changed',privateBytes:'committed',oldResultHidden:true,durableAfterLoss:true,physical:true,normalFacade:true,bytesCollision:true,quotaNoWrite:true,retryStable:true,revokeNoWrite:true,casNoWrite:true,completed:true});assert.deepEqual(errors,[]);
});

for (const engine of ['chromium', 'webkit'] as const) test(`readonly host uses one stable persisted verification (${engine})`, { timeout: 90000 }, async t => {
 const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } }); await server.listen(); t.after(() => server.close());
 const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true }); t.after(() => browser.close());
 const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
 await page.addInitScript(() => { window.addEventListener('unhandledrejection', event => { throw new Error(String(event.reason)); }); });
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 type Result = { libraryId: string; readonlyRoot: string; readonlyCounts: Record<string, number>; concurrent: { unchanged: boolean; writerBlocked: boolean; nextRejected: boolean; restoredUsable: boolean }[];
  finishInvalidationExercised: boolean; finishInvalidationRejected: boolean; restoredAfterInvalidation: boolean; completionFenceWasExercised: boolean; completionInvalidationRejected: boolean; restoredAfterCompletion: boolean;
  readwrite: { mutationEnqueued: boolean; rejected: boolean; rowPreserved: boolean; markerAbsent: boolean; restoredUsable: boolean }[] };
 const result = await page.evaluate(() => (window as unknown as { indexedDbReadonlyHostVerification(): Promise<Result> }).indexedDbReadonlyHostVerification());
 assert.equal(result.readonlyRoot, result.libraryId);
 assert.deepEqual(result.readonlyCounts, { canonicalLocalGrant: 1, canonicalProfiles: 1, datasetControls: 1, canonicalPeers: 1, datasets: 1 }, 'one persisted verification per protected row in the same readonly snapshot');
 assert.equal(result.concurrent.length, 2);
 for (const value of result.concurrent) assert.deepEqual({ unchanged: value.unchanged, writerBlocked: value.writerBlocked, nextRejected: value.nextRejected, restoredUsable: value.restoredUsable }, { unchanged: true, writerBlocked: true, nextRejected: true, restoredUsable: true });
 assert.equal(result.finishInvalidationExercised, true); assert.equal(result.finishInvalidationRejected, true); assert.equal(result.restoredAfterInvalidation, true);
 assert.equal(result.completionFenceWasExercised, true); assert.equal(result.completionInvalidationRejected, true); assert.equal(result.restoredAfterCompletion, true);
 assert.equal(result.readwrite.length, 5);
 for (const value of result.readwrite) assert.deepEqual({ mutationEnqueued: value.mutationEnqueued, rejected: value.rejected, rowPreserved: value.rowPreserved, markerAbsent: value.markerAbsent, restoredUsable: value.restoredUsable }, { mutationEnqueued: true, rejected: true, rowPreserved: true, markerAbsent: true, restoredUsable: true });
 assert.deepEqual(errors, []);
});


for (const engine of ['chromium', 'webkit'] as const) test(`root full scan reuses only same-transaction verified point rows (${engine})`, { timeout: 90000 }, async t => {
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.addEventListener('unhandledrejection',event=>{throw new Error(String(event.reason));});});
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 type Result={factoryBefore:boolean;factoryAfter:boolean;orders:{presentGets:number;missingGets:number;fullScans:number;presentSame:boolean;missingEmpty:boolean}[];
  witness:{status:string;sameLogical:boolean;markerAbsent:boolean};badGets:number;badRejected:boolean;recovered:boolean;crossScope:{field:string;denied:boolean}[]};
 const result=await page.evaluate(()=>(window as unknown as {indexedDbRootReadReuseVerification():Promise<Result>}).indexedDbRootReadReuseVerification());
 assert.equal(result.factoryBefore,true);assert.equal(result.factoryAfter,true);
 assert.equal(result.orders.length,2);
 for(const value of result.orders){assert.equal(value.presentGets,0,'a full scan already verified the present physical primary key');assert.equal(value.missingGets,1,'an index miss must still issue the exact physical point get');
  assert.equal(value.fullScans,1);assert.equal(value.presentSame,true);assert.equal(value.missingEmpty,true);}
 assert.deepEqual(result.witness,{status:'changed',sameLogical:true,markerAbsent:true});
 assert.equal(result.badGets,1);assert.equal(result.badRejected,true);assert.equal(result.recovered,true);
 assert.deepEqual(result.crossScope,[{field:'accountId',denied:true},{field:'libraryId',denied:true},{field:'epoch',denied:true}]);
 assert.deepEqual(errors,[]);
});

// Append to frontend/e2e/webIndexedDbPlan.browser.test.ts after merging the differential fixture.
// Run identical assertions on the unchanged preimage and on the candidate.
for(const engine of ['chromium','webkit'] as const)test(`three real conflicting writes ${engine}`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 const result=await page.evaluate(()=>(window as unknown as {indexedDbOptimisticDifferentialCases():Promise<{status:string;reason:string;conflicts:number;entered:number;durable:boolean;competitorsDurable:boolean}>}).indexedDbOptimisticDifferentialCases());
 t.diagnostic(JSON.stringify({status:result.status,conflicts:result.conflicts,entered:result.entered,durable:result.durable,competitorsDurable:result.competitorsDurable,snapshotChanged:result.reason.includes('repository-snapshot-changed')}));
 assert.equal(result.status,'durable');assert.equal(result.conflicts,1);assert.equal(result.entered,2);assert.equal(result.durable,true);
 assert.equal(result.competitorsDurable,true);assert.deepEqual(errors,[]);
});

﻿// The same desired assertion applies to the preimage and candidate; no new-API probe.
for(const engine of ['chromium','webkit'] as const)test(`planned commit opens one scoped connection ${engine}`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 const result=await page.evaluate(()=>(window as unknown as {indexedDbOperationDatabaseOpenCountCases():Promise<unknown>}).indexedDbOperationDatabaseOpenCountCases());
 t.diagnostic(JSON.stringify(result));assert.deepEqual(result,{status:'durable',writeOpens:1,durable:true});assert.deepEqual(errors,[]);
});

﻿// Append to frontend/e2e/webIndexedDbPlan.browser.test.ts after applying the four source candidates and fixture append.
for(const engine of ['chromium','webkit'] as const)test(`operation-scoped real IndexedDB connection ${engine}`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 const result=await page.evaluate(()=>(window as unknown as {indexedDbOperationDatabaseScopeCases():Promise<unknown>}).indexedDbOperationDatabaseScopeCases());
 t.diagnostic(JSON.stringify(result));
 assert.deepEqual(result,{plannedOperation:true,writeOpens:1,readOpens:1,cancelledAfterFirst:true,freshAfterCancel:true,persistedRechecked:true,oldRejected:true,afterUpgrade:true});
 assert.deepEqual(errors,[]);
});

// After-only lifecycle/race cases. The ordinary open-count case is a separate differential fragment.
for(const engine of ['chromium','webkit'] as const)test(`scoped connection revocation and races ${engine}`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 const expected=[{mode:'abort',rejected:true,closed:true,nativeTransactions:0},{mode:'invalidate',rejected:true,closed:true,nativeTransactions:0},{mode:'close',rejected:true,closed:true,nativeTransactions:0}];
 const result=await page.evaluate(()=>(window as unknown as {indexedDbOperationDatabaseRaceCases():Promise<unknown>}).indexedDbOperationDatabaseRaceCases());
 t.diagnostic(JSON.stringify(result));assert.deepEqual(result,{openLateCases:expected,spentOpenRejected:true,spentReentryRejected:true,lateOldVersionChangeSafe:true,abnormalSameOperationRejected:true,distinctConnection:true,finalOwnerFence:true,unawaitedWriteAborted:true,siblingUnaffected:true});assert.deepEqual(errors,[]);
});

// Append to frontend/e2e/webIndexedDbPlan.browser.test.ts; after applying source and fixture append.
for(const engine of ['chromium','webkit'] as const)test(`independent operation scope versionchange and delivery ${engine}`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 const result=await page.evaluate(async()=>{const fixture=window as unknown as {independentScopeVersionChangeCase():Promise<unknown>;independentScopedDeliveryCase():Promise<unknown>};return {versionchange:await fixture.independentScopeVersionChangeCase(),delivery:await fixture.independentScopedDeliveryCase()};});
 t.diagnostic(JSON.stringify(result));
 assert.deepEqual(result,{versionchange:{uaVersionChange:true,oldReadRejected:true,oldScopeRejected:true,freshValidated:true},delivery:{invalidated:true,unknown:true,durableWitness:true}});
 assert.deepEqual(errors,[]);
});

﻿// CP-only append to frontend/e2e/webIndexedDbPlan.browser.test.ts; preserve all existing cases.
for(const engine of ['chromium','webkit'] as const)test(`awaited scoped queued abort emits native evidence ${engine}`,{timeout:90000},async t=>{
 const server=await createServer({root:frontend,configFile:path.join(frontend,'vite.config.ts'),logLevel:'error',server:{port:0}});await server.listen();t.after(()=>server.close());
 const browser=engine==='chromium'?await chromium.launch({channel:'msedge',headless:true}):await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/indexedDbPlan.html`);
 const result=await page.evaluate(()=>(window as unknown as {awaitedScopedQueuedAbortRegression():Promise<unknown>}).awaitedScopedQueuedAbortRegression());
 t.diagnostic(JSON.stringify(result));
 assert.deepEqual(result,{nativeCreated:true,signalIssued:true,nativeAborted:true,nativeCompleted:false,evidenceSent:true,evidenceAborted:true,evidenceCompleted:false,enqueued:false,rejected:true});
 assert.deepEqual(errors,[]);
});
