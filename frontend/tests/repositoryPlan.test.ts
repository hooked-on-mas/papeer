import type { PlanDatabase } from '../src/runtime/edits/repositoryPlan.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EditPlanView, type ScopeRead } from '../src/runtime/edits/repositoryPlan.ts';
import { executeRepositoryPlan, RepositorySnapshotChanged } from '../src/runtime/edits/repositoryExecution.ts';
import { EditPlanMemoryDatabase } from './support/editPlanMemoryDatabase.ts';
import { seedRepositoryReads } from '../src/runtime/edits/repositoryDependencies.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = { accountId: 'plan-test', libraryId: fixture.libraryId, epoch: 'one' };
const roots: ScopeRead = { kind: 'roots', scope };

test('query insertion changes CAS and cannot apply a stale plan', async () => {
  const db = new EditPlanMemoryDatabase(), snapshot = await db.capture('initialize', [roots]);
  const view = new EditPlanView(scope, snapshot); view.putRoot(fixture.document);
  db.mutate({ kind: 'put-root', scope, root: fixture.document });
  assert.deepEqual(await db.compareAndApply('initialize', { snapshot, mutations: view.mutations, result: undefined }), { status: 'changed' });
});

test('overlay exposes a new root without leaking caller aliases', async () => {
  const db = new EditPlanMemoryDatabase(), snapshot = await db.capture('initialize', [roots]);
  const view = new EditPlanView(scope, snapshot), root = structuredClone(fixture.document);
  view.putRoot(root); root.id = 'changed';
  const read = await view.root(fixture.document.id); assert.equal(read?.id, fixture.document.id);
  read!.id = 'also-changed'; assert.equal((await view.root(fixture.document.id))?.id, fixture.document.id);
});

test('retry discards overlay and preserves the captured request', async () => {
  const db = new EditPlanMemoryDatabase(); let attempts = 0; const request = structuredClone(fixture.document);
  const result = await executeRepositoryPlan({ operation: 'initialize', scope, database: db, reads: [roots], write: true,
    plan: async view => { attempts++; if (attempts === 1) db.mutate({ kind: 'put-root', scope, root: request }); view.putRoot(request); return request.id; } });
  assert.equal(attempts, 2); assert.equal(result, fixture.document.id);
});

test('a captured point absence detects a concurrent insert', async () => {
  const db = new EditPlanMemoryDatabase(), selector: ScopeRead = { kind: 'roots', scope, targetId: fixture.document.id };
  const snapshot = await db.capture('initialize', [selector]);
  db.mutate({ kind: 'put-root', scope, root: fixture.document });
  assert.equal((await db.compareAndApply('initialize', { snapshot, mutations: [], result: undefined })).status, 'changed');
});

test('forged blind mutation cannot use an empty snapshot token', async () => {
  const db = new EditPlanMemoryDatabase(), snapshot = await db.capture('initialize', []);
  await assert.rejects(db.compareAndApply('initialize', { snapshot, result: undefined,
    mutations: [{ kind: 'put-root', scope, root: fixture.document }] }), /mutation-prestate-not-captured/);
});

test('comparison bytes are private copies, independent of returned snapshot aliases', async () => {
  const db = new EditPlanMemoryDatabase(), meta = fixture.resource.metadata, bytes = Uint8Array.of(1, 2, 3);
  db.mutate({ kind: 'put-resource', scope, resource: { metadata: meta, bytes } });
  const read: ScopeRead = { kind: 'resource-bytes', scope, sha256: meta.sha256 };
  const snapshot = await db.capture('store-resource', [read]);
  (snapshot.values[0].value as Uint8Array)[0] = 9;
  assert.equal((await db.compareAndApply('store-resource', { snapshot, mutations: [], result: undefined })).status, 'committed');
});

test('dependency batch recaptures one union and never appends old answers', async () => {
  const db = new EditPlanMemoryDatabase(), selectors: ScopeRead[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'resource', scope, resourceId: `resource-${i}` }));
  let captures = 0;
  const tracked = { capture: async (...args: Parameters<typeof db.capture>) => { captures++; return db.capture(...args); }, compareAndApply: db.compareAndApply.bind(db) };
  const count = await executeRepositoryPlan({ operation: 'initialize', scope, database: tracked, reads: [roots], write: false,
    dependencies: async () => selectors, plan: async view => { for (let i = 0; i < 12; i++) assert.equal(await view.resource(`resource-${i}`), undefined); return 12; } });
  assert.equal(count, 12); assert.equal(captures, 2);
});

test('repeated CAS misses stop after three attempts without publishing mutations', async () => {
  const db = new EditPlanMemoryDatabase(); let attempts = 0;
  const tracked = { capture: db.capture.bind(db), compareAndApply: async () => { attempts++; return { status: 'changed' as const }; } };
  await assert.rejects(executeRepositoryPlan({ operation: 'initialize', scope, database: tracked, reads: [roots], write: true,
    plan: async view => { view.putRoot(fixture.document); return undefined; } }), /repository-snapshot-changed/);
  assert.equal(attempts, 3);
  assert.deepEqual((await db.capture('read', [roots])).values[0].value, []);
});

test('a mismatched control/access capture is rejected as recovery, not treated as staging', async () => {
  const selector: ScopeRead = { kind: 'control', identity: { accountId: scope.accountId, libraryId: scope.libraryId } };
  const view = new EditPlanView(scope, { comparison: {}, values: [{ read: selector, value: { access: { activeEpoch: scope.epoch, stagingEpoch: null, frozen: false, epochs: [scope.epoch] } } }] });
  await assert.rejects(view.access(), /dataset-control-access-mismatch/);
});


test('receipt selects one edit by batch ID without granting a write witness', async () => {
  const db = new EditPlanMemoryDatabase(), batch = structuredClone(fixture.batches[0]);
  const edit = { batch, receipt: { id: batch.id, targetId: batch.targetId, durable: true as const, upload: 'pending' as const, importedBy: [] as string[] } };
  db.mutate({ kind: 'put-edit', scope, edit });
  const reads = seedRepositoryReads(scope, 'receipt', [batch.id]);
  assert.deepEqual(reads.map(read => read.kind), ['control', 'edit-by-id']);
  const selector: ScopeRead = { kind: 'edit-by-id', scope, batchId: batch.id };
  const snapshot = await db.capture('receipt', [selector]);
  assert.deepEqual(await new EditPlanView(scope, snapshot).editById(batch.id), edit);
  const absent: ScopeRead = { kind: 'edit-by-id', scope, batchId: 'absent' };
  assert.equal((await db.capture('receipt', [absent])).values[0].value, undefined);
  const otherScope = { ...scope, epoch: 'other' };
  assert.equal((await db.capture('receipt', [{ ...selector, scope: otherScope }])).values[0].value, undefined);
  await assert.rejects(db.capture('commit', [selector]), /host-operation-forbidden/);
  await assert.rejects(db.compareAndApply('receipt', { snapshot, mutations: [{ kind: 'put-edit', scope, edit }], result: undefined }), /mutation-prestate-not-captured/);
});

{
const scope={accountId:'account',libraryId:'library',epoch:'epoch'};
const empty=()=>({values:[],comparison:{}});
const run=(database:PlanDatabase,write=true)=>executeRepositoryPlan({operation:write?'commit':'read',scope,database,reads:[],write,plan:async()=>42});

test('optimistic success and reads never enter fallback',async()=>{
 let leases=0, compares=0;
 const db:PlanDatabase={capture:async()=>empty(),compareAndApply:async()=>{compares++;return {status:'committed'};},withRetryLease:async action=>{leases++;return action(db);}};
 assert.equal(await run(db),42);assert.equal(await run(db,false),42);assert.equal(compares,1);assert.equal(leases,0);
});

test('one changed CAS enters one lease around remaining attempts',async()=>{
 let captures=0, compares=0, leases=0, leased=false;
 const db:PlanDatabase={capture:async()=>{captures++;if(captures>1)assert.equal(leased,true);return empty();},
  compareAndApply:async()=>{compares++;if(compares>1)assert.equal(leased,true);return {status:compares<3?'changed':'committed'};},
  withRetryLease:async action=>{leases++;leased=true;try{return await action(db);}finally{leased=false;}}};
 assert.equal(await run(db),42);assert.equal(captures,3);assert.equal(compares,3);assert.equal(leases,1);
});

test('cross-authority interference still exhausts original three attempts',async()=>{
 let compares=0,leases=0;
 const db:PlanDatabase={capture:async()=>empty(),compareAndApply:async()=>{compares++;return {status:'changed'};},withRetryLease:async action=>{leases++;return action(db);}};
 await assert.rejects(run(db),RepositorySnapshotChanged);assert.equal(compares,3);assert.equal(leases,1);
});

// These cases preserve the executor's original three attempts and three closure passes per attempt.
test('ever-growing selector closure uses all nine captures without CAS or lease',async()=>{
 let captures=0,compares=0,leases=0;
 const db:PlanDatabase={capture:async()=>{captures++;return empty();},compareAndApply:async()=>{compares++;return {status:'committed'};},withRetryLease:async action=>{leases++;return action(db);}};
 await assert.rejects(executeRepositoryPlan({operation:'commit',scope,database:db,reads:[],write:true,
  dependencies:async()=>[{kind:'roots',scope,targetId:`selector-${captures}`}],plan:async()=>42}),RepositorySnapshotChanged);
 assert.equal(captures,9);assert.equal(compares,0);assert.equal(leases,0);
});

test('closure-only first attempt retains both later CAS attempts and leases only after changed',async()=>{
 let captures=0,compares=0,leases=0,leased=false;
 const db:PlanDatabase={capture:async()=>{captures++;if(captures===5)assert.equal(leased,true);return empty();},
  compareAndApply:async()=>{compares++;return {status:compares===1?'changed':'committed'};},
  withRetryLease:async action=>{leases++;leased=true;try{return await action(db);}finally{leased=false;}}};
 const value=await executeRepositoryPlan({operation:'commit',scope,database:db,reads:[],write:true,
  dependencies:async()=>captures<=3?[{kind:'roots',scope,targetId:`selector-${captures}`}]:[],plan:async()=>42});
 assert.equal(value,42);assert.equal(captures,5);assert.equal(compares,2);assert.equal(leases,1);
});

}
