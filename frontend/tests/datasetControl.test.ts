import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDriveEditTransfer, type DriveEditStorage } from '../src/adapters/drive/editTransfer.ts';
import { DatasetTransitionSession, activeDatasetScope } from '../src/runtime/edits/DatasetTransitionSession.ts';
import type { DatasetControlRecord, DatasetPublication, EditBatch } from '../src/runtime/edits/contracts.ts';
import { prepareDatasetPublication } from '../src/runtime/edits/datasetPublication.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import type { EditScope, StoredResource } from '../src/runtime/edits/ports.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { DocumentEditSessions } from '../src/features/reader/DocumentEditSessions.ts';
import { assertDatasetControlPlan, assertDatasetControlTransition } from '../src/runtime/edits/datasetControl.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope: EditScope = { ...fixture.datasetManifest.scope, epoch: 'active-a' };
const inspect = { inspectPdf: async () => fixture.resource.metadata.pdfPages };
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
test('the shared native control corpus validates the same phases, active pointer and epoch history in TypeScript', async () => {
  let previous: DatasetControlRecord | undefined;
  for (const record of fixture.datasetControls.initial as DatasetControlRecord[]) {
    await assertDatasetControlPlan(record, record.identity); assertDatasetControlTransition(previous, record); previous = record;
  }
  previous = fixture.datasetControls.initial[2];
  for (const record of fixture.datasetControls.rotation as DatasetControlRecord[]) {
    await assertDatasetControlPlan(record, record.identity); assertDatasetControlTransition(previous, record); previous = record;
  }
});
function wire() {
  const values = new Map<string, Map<string, unknown>>(), bodies = new Map<string, StoredResource>(); let loseReply = false;
  const storage: DriveEditStorage = {
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async ns => [...(values.get(ns)?.keys() ?? [])].reverse().map(id => ({ id: ns + id })),
    annotation: async id => structuredClone(values.get(id.slice(0, 64))!.get(id.slice(64))),
    saveSharedEdit: async (ns, _folder, id, value) => {
      if (!values.has(ns)) values.set(ns, new Map());
      const entries = values.get(ns)!;
      if (entries.has(id)) assert.deepEqual(entries.get(id), value, 'recovery must not change the captured plan/IDs');
      entries.set(id, structuredClone(value));
      if (loseReply && (value as { kind: string }).kind === 'dataset-manifest') throw new Error('manifest-response-lost');
    },
    saveSharedResource: async (ns, _folder, resource) => {
      bodies.set(ns + resource.metadata.id, structuredClone(resource));
      if (!values.has(ns)) values.set(ns, new Map());
      values.get(ns)!.set(resource.metadata.id, { kind: 'resource', metadata: resource.metadata, blobId: ns + resource.metadata.id });
    },
    sharedResource: async (ns, metadata) => bodies.get(ns + metadata.id)!.bytes,
  };
  return { transfer: (scope: EditScope) => createDriveEditTransfer(storage, scope, 'folder'), fail: (value: boolean) => { loseReply = value; } };
}
async function setup() {
  const database = new EditMemoryDatabase(scope), source = new DurableEditRepository(scope, database, inspect), remote = wire();
  await source.storeResource({ ...fixture.resource.metadata, bytes }); await source.installCheckpoint(fixture.checkpoint);
  const first = await prepareDatasetPublication(source, crypto.randomUUID());
  await new DatasetTransitionSession(source, remote.transfer(scope), crypto.randomUUID(), async () => true).start(first);
  const targetScope = { ...scope, epoch: 'active-b' }, targetDb = database.fork(targetScope);
  const target = new DurableEditRepository(targetScope, targetDb, inspect);
  return { database, source, target, targetDb, targetScope, remote };
}
async function copyTarget(source: DurableEditRepository, target: DurableEditRepository): Promise<DatasetPublication> {
  await target.storeResource({ ...fixture.resource.metadata, bytes }); await target.installCheckpoint(await source.checkpoint());
  return prepareDatasetPublication(target, crypto.randomUUID());
}

test('durable publication recovery activates one dataset, preserves pending receipts and quarantines a rolled-back epoch', async () => {
  const { database, source, target, targetDb, targetScope, remote } = await setup();
  const markdown: EditBatch = fixture.batches.find((batch: EditBatch) => batch.kind === 'markdown');
  assert.equal((await source.commit(markdown)).status, 'durable'); const originalPeer = crypto.randomUUID(); await source.acknowledgeImport(markdown.id, originalPeer);
  const publication = await copyTarget(source, target), transition = new DatasetTransitionSession(target, remote.transfer(targetScope), crypto.randomUUID(), async () => true);
  remote.fail(true); await assert.rejects(transition.start(publication), /manifest-response-lost/);
  const prepared = (await source.datasetControl())!;
  assert.equal(prepared.transition.phase, 'prepared'); assert.equal(prepared.active!.scope.epoch, scope.epoch);
  assert.deepEqual(prepared.transition.publication, publication);
  assert.equal((await source.commit(markdown)).status, 'aborted');
  await assert.rejects(source.replaceIntent(fixture.document.id, fixture.intents[0], null), /dataset-frozen/);
  await assert.rejects(activeDatasetScope(source), /dataset-frozen/);
  const other = new DurableEditRepository({ ...scope, epoch: 'other-stage' }, database.fork({ ...scope, epoch: 'other-stage' }), inspect);
  await assert.rejects(other.initialize(fixture.document), /dataset-frozen/);
  remote.fail(false);
  const restarted = new DurableEditRepository(targetScope, targetDb, inspect);
  const recovery = new DatasetTransitionSession(restarted, remote.transfer(targetScope), crypto.randomUUID(), async () => true);
  await recovery.resume(); assert.deepEqual(await activeDatasetScope(source), targetScope);
  assert.equal((await source.commit(markdown)).status, 'aborted');
  await assert.rejects(source.receiveRecords([]), /dataset-inactive/);
  await assert.rejects(source.acknowledgeUpload(markdown.id), /dataset-inactive/);
  assert.equal((await target.receipt(markdown.id))!.upload, 'pending');
  assert.ok((await target.receipt(markdown.id))!.importedBy.includes(originalPeer));
  const extra: EditBatch = { kind: 'markdown', imageResources: [], id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: fixture.markdown.id, parents: [markdown.id], content: 'new epoch editing' };
  assert.equal((await target.commit(extra)).status, 'durable');
  await recovery.rollback(); assert.deepEqual(await activeDatasetScope(target), scope);
  assert.equal((await source.read(fixture.markdown.id)).heads[0], markdown.id);
  assert.equal((await target.read(fixture.markdown.id)).heads[0], extra.id);
  assert.equal((await target.pendingRecords()).length, 2, 'rollback preserves new-epoch content and outbox separately');
  assert.equal((await source.pendingRecords()).length, 1, 'new-epoch edits must not leak into the restored source');
  assert.equal((await target.commit(extra)).status, 'aborted');
  let requests = 0;
  await assert.rejects(new EditReplication(target, { ...remote.transfer(targetScope), pull: async () => { requests++; throw new Error('unexpected network'); } }, crypto.randomUUID()).flush(), /dataset-inactive/);
  assert.equal(requests, 0, 'inactive epochs cannot send or import packets');
  await assert.rejects(recovery.start(publication), /dataset-epoch-reused/);
});

test('native guard refuses pending intent or source edits omitted from the captured target before freezing it', async () => {
  const { source, target, targetScope, remote } = await setup();
  const publication = await copyTarget(source, target);
  await source.replaceIntent(fixture.document.id, fixture.intents[0], null);
  const controller = new DatasetTransitionSession(target, remote.transfer(targetScope), crypto.randomUUID(), async () => true);
  await assert.rejects(controller.start(publication), /dataset-pending-intents/);
  assert.deepEqual(await activeDatasetScope(source), scope);
  await source.replaceIntent(fixture.document.id, null, fixture.intents[0].id);
  const markdown: EditBatch = fixture.batches.find((batch: EditBatch) => batch.kind === 'markdown'); await source.commit(markdown);
  await assert.rejects(controller.start(publication), /dataset-content-changed/);
  assert.deepEqual(await activeDatasetScope(source), scope);
});

test('stale tab/CAS, immutable plan, invalid phase, epoch reuse and identity changes cannot replace the native control', async () => {
  const { source, target, targetScope, remote } = await setup();
  const publication = await copyTarget(source, target); remote.fail(true);
  await assert.rejects(new DatasetTransitionSession(target, remote.transfer(targetScope), crypto.randomUUID(), async () => true).start(publication));
  const before = (await target.datasetControl())!;
  const changed: DatasetControlRecord = { ...structuredClone(before), id: crypto.randomUUID(), transition: { ...before.transition, phase: 'published' } };
  assert.equal((await target.replaceDatasetControl(changed, crypto.randomUUID())).status, 'conflict');
  const rewrite = structuredClone(changed); rewrite.transition.publication.checkpointObjectId = crypto.randomUUID();
  await assert.rejects(target.replaceDatasetControl(rewrite, before.id), /dataset-plan-changed/);
  const skipped = { ...structuredClone(before), id: crypto.randomUUID(), active: before.transition.publication.manifest,
    transition: { ...before.transition, phase: 'activated' as const } };
  await assert.rejects(target.replaceDatasetControl(skipped, before.id), /dataset-phase/);
  const foreign = structuredClone(changed); foreign.identity.accountId = 'other';
  await assert.rejects(target.replaceDatasetControl(foreign, before.id), /dataset-scope/);
  assert.deepEqual(await target.datasetControl(), before);
  assert.equal((await target.replaceDatasetControl(before, null)).status, 'written', 'response loss retry remains idempotent');
});

test('scope guard and not-yet-active pointer prevent UI transition without deleting its captured plan', async () => {
  const database = new EditMemoryDatabase(scope), target = new DurableEditRepository(scope, database, inspect), remote = wire();
  await target.storeResource({ ...fixture.resource.metadata, bytes }); await target.installCheckpoint(fixture.checkpoint);
  const publication = await prepareDatasetPublication(target, crypto.randomUUID());
  const controller = new DatasetTransitionSession(target, remote.transfer(scope), crypto.randomUUID(), async () => false);
  await assert.rejects(controller.start(publication), /dataset-transition-guard/);
  assert.equal(await target.datasetControl(), undefined);
  await assert.rejects(activeDatasetScope(target), /dataset-not-active/);
  assert.deepEqual(await target.checkpoint(), publication.checkpoint);
});

test('an empty second host joins an explicit published dataset without uploading PDF/checkpoint/manifest again', async () => {
  const { source, remote } = await setup();
  const receiver = new DurableEditRepository(scope, new EditMemoryDatabase(scope), inspect), transfer = remote.transfer(scope);
  const session = new DatasetTransitionSession(receiver, { ...transfer,
    uploadResource: async () => assert.fail('joining cannot upload backgrounds'),
    uploadCheckpoint: async () => assert.fail('joining cannot upload checkpoints'),
    uploadDatasetManifest: async () => assert.fail('joining cannot republish a manifest'),
  }, crypto.randomUUID(), async () => true);
  await session.join((await source.datasetControl())!.active!.id);
  assert.deepEqual(await activeDatasetScope(receiver), scope);
  assert.deepEqual(await receiver.checkpoint(), await source.checkpoint());
  assert.equal((await receiver.datasetControl())!.transition.mode, 'import');
});

for (const phase of ['prepared', 'published', 'activated'] as const) {
test(`a ${phase} control response lost after native acceptance recovers the exact durable plan`, async () => {
  const { source, target, targetScope, remote } = await setup(), plan = await copyTarget(source, target); let lose = true;
  const uncertain = { ...target, replaceDatasetControl: async (record: DatasetControlRecord, expected: string | null) => {
    const result = await target.replaceDatasetControl(record, expected);
    if (record.transition.phase === phase && lose) { lose = false; throw new Error('control-response-lost'); }
    return result;
  } };
  await assert.rejects(new DatasetTransitionSession(uncertain, remote.transfer(targetScope), crypto.randomUUID(), async () => true).start(plan), /control-response-lost/);
  const durable = (await target.datasetControl())!;
  assert.equal(durable.transition.phase, phase); assert.deepEqual(durable.transition.publication, plan);
  const recovery = new DatasetTransitionSession(target, remote.transfer(targetScope), crypto.randomUUID(), async () => true);
  await recovery.resume(); assert.deepEqual(await activeDatasetScope(source), targetScope);
  assert.deepEqual((await target.datasetControl())!.transition.publication, plan);
});
}

test('the shared document registry refuses drawing before cutover, then suspends old callbacks and drains replication', async () => {
  const { source, target, targetScope, remote } = await setup();
  const sessions = new DocumentEditSessions(source); await sessions.initialize();
  const document = sessions.get(fixture.document.id); await document.refresh();
  const owner = Symbol(), pageId = fixture.document.pages[0].id;
  document.claimPage(pageId, owner); document.setInput(pageId, owner, 'drawing');
  const sender = new EditReplication(source, remote.transfer(scope), crypto.randomUUID());
  const transition = new DatasetTransitionSession(target, remote.transfer(targetScope), crypto.randomUUID(), async () => {
    if ((await sessions.suspend()).status !== 'allowed') return false;
    await sender.suspendAndWait(); return true;
  });
  const plan = await copyTarget(source, target);
  await assert.rejects(transition.start(plan), /dataset-transition-guard/);
  assert.deepEqual(await activeDatasetScope(source), scope);
  document.setInput(pageId, owner, 'idle'); await transition.start(plan);
  assert.equal(sessions.getSnapshot().active, false); assert.equal(sender.getSnapshot().suspended, true);
  assert.deepEqual(await document.editPage(pageId, owner, []), { status: 'refused', reason: 'session-inactive' });
});

test('a competing cutover while the old scope guard awaits cannot freeze an unguarded new active scope', async () => {
  const { database, source, target, targetScope, remote } = await setup();
  const nextScope = { ...scope, epoch: 'active-c' }, next = new DurableEditRepository(nextScope, database.fork(nextScope), inspect);
  const firstPlan = await copyTarget(source, target), secondPlan = await copyTarget(source, next);
  const first = new DatasetTransitionSession(target, remote.transfer(targetScope), crypto.randomUUID(), async () => true);
  const second = new DatasetTransitionSession(next, remote.transfer(nextScope), crypto.randomUUID(), async record => {
    assert.equal(record!.active!.scope.epoch, scope.epoch); await first.start(firstPlan); return true;
  });
  await assert.rejects(second.start(secondPlan), /dataset-control-conflict/);
  assert.deepEqual(await activeDatasetScope(source), targetScope);
  assert.deepEqual(second.getSnapshot().record!.active!.scope, targetScope);
});

test('confirming an already durable terminal transition never interrupts new editing through the scope guard', async () => {
  const { source, remote } = await setup(); let guards = 0;
  const session = new DatasetTransitionSession(source, remote.transfer(scope), crypto.randomUUID(), async () => { guards++; return false; });
  assert.equal((await session.resume()).transition.phase, 'activated'); assert.equal(guards, 0);
  await assert.rejects(session.rollback(), /dataset-transition-guard/); assert.equal(guards, 1);
  assert.deepEqual(await activeDatasetScope(source), scope);
});
