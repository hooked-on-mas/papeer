import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDriveEditTransfer, type DriveEditStorage } from '../src/adapters/drive/editTransfer.ts';
import { DocumentEditSession } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { EditRecord, InkObject } from '../src/runtime/edits/contracts.ts';
import { assertEditRecord } from '../src/runtime/edits/editRecord.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'edit-record' };
const records: EditRecord[] = fixture.editRecords;
const repository = (database = new EditMemoryDatabase()) => new DurableEditRepository(scope, database);
async function initialized() {
  const result = repository(); await result.initialize(fixture.document); return result;
}

test('ordinary Drive replication carries the latest remote page operation, Undo and Redo through session restart', async () => {
  const source = await initialized(), target = await initialized(), objects = new Map<string, unknown>();
  let loseReply = false;
  const storage: DriveEditStorage = {
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async () => [...objects.keys()].reverse().map(id => ({ id })),
    annotation: async id => structuredClone(objects.get(id)),
    saveSharedEdit: async (_namespace, _folder, id, value) => {
      if (objects.has(id)) assert.deepEqual(value, objects.get(id), 'same ID must resend its complete immutable record');
      objects.set(id, structuredClone(value));
      if (loseReply && (value as { kind: string }).kind === 'edit-record') throw new Error('upload-response-lost');
    },
    sharedResource: async () => assert.fail('paper pages have no resource'),
    saveSharedResource: async () => assert.fail('paper pages have no resource'),
  };
  const sender = new EditReplication(source, createDriveEditTransfer(storage, scope, 'folder'), crypto.randomUUID());
  const receiver = new EditReplication(target, createDriveEditTransfer(storage, scope, 'folder'), crypto.randomUUID());
  const first = new DocumentEditSession(source, fixture.document.id); await first.refresh();
  const pageId = fixture.document.pages[0].id, secondPageId = fixture.document.pages[1].id, owner = Symbol();
  const annotation: InkObject = fixture.batches[0].changes[0].annotation;
  first.claimPage(pageId, owner);
  await first.editPage(pageId, owner, [{ type: 'create', annotation }]);
  await sender.flush(); await receiver.flush();
  const second = new DocumentEditSession(target, fixture.document.id); await second.refresh();
  second.claimPage(secondPageId, owner);
  await second.editPage(secondPageId, owner, [{ type: 'create', annotation: { ...annotation, id: crypto.randomUUID() } }]);
  const pending = await target.pendingRecords(); assert.equal(pending.length, 1); assert.ok(pending[0].history);
  loseReply = true; await assert.rejects(receiver.flush(), /upload-response-lost/);
  assert.deepEqual(await target.pendingRecords(), pending, 'failed upload retains history and the original operation ID');
  loseReply = false; await sender.flush(); await receiver.flush();
  const restartedSource = new DocumentEditSession(source, fixture.document.id); await restartedSource.refresh();
  assert.equal(restartedSource.getSnapshot().canUndo, true);
  await restartedSource.undo();
  assert.deepEqual(restartedSource.getSnapshot().affectedPages, [secondPageId], 'Undo must target the latest remote page, not the older local edit');
  assert.deepEqual(restartedSource.getSnapshot().document!.pages.map(page => page.annotations.length), [1, 0]);
  assert.equal((await source.pendingRecords())[0].history?.action?.kind, 'undo');
  await sender.flush(); await receiver.flush();
  const restartedTarget = new DocumentEditSession(target, fixture.document.id); await restartedTarget.refresh();
  assert.equal(restartedTarget.getSnapshot().canRedo, true);
  await restartedTarget.redo(); await receiver.flush(); await sender.flush();
  const restored = new DocumentEditSession(source, fixture.document.id); await restored.refresh();
  assert.deepEqual(restored.getSnapshot().document!.pages.map(page => page.annotations.length), [1, 1]);
  assert.equal(restored.getSnapshot().canRedo, false); assert.equal(restored.getSnapshot().canUndo, true);
  assert.equal((await source.read(fixture.document.id)).history.length, 4);
  assert.ok([...objects.values()].every(value => (value as { kind: string }).kind !== 'repository-checkpoint'), 'regular replication must restore history without a checkpoint');
});

test('shared normal/Undo/Redo records retain parent waiting and restore the document stack after reverse arrival', async () => {
  const target = await initialized();
  await target.receiveRecords([records[2], records[1]]);
  assert.equal((await target.read(fixture.document.id)).waiting.length, 2);
  assert.equal((await target.read(fixture.document.id)).history.length, 2);
  await target.receiveRecords([records[0], records[2]]);
  const read = await target.read(fixture.document.id);
  assert.deepEqual(read.heads, [records[2].batch.id]); assert.deepEqual(read.waiting, []);
  const session = new DocumentEditSession(target, fixture.document.id); await session.refresh();
  assert.equal(session.getSnapshot().canUndo, true); assert.equal(session.getSnapshot().canRedo, false);
  await session.undo(); assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
});

test('incoming history enrichment preserves local receipts; conflicting metadata aborts the entire arrival', async () => {
  const target = await initialized(), record = structuredClone(records[0]);
  await target.commit(record.batch); await target.acknowledgeImport(record.batch.id, 'peer');
  const receipt = await target.receipt(record.batch.id);
  await target.receiveRecords([record]);
  assert.deepEqual(await target.receipt(record.batch.id), receipt);
  assert.deepEqual(await target.pendingRecords(), [record]);
  const conflicting = structuredClone(record); conflicting.history!.undoRequested = true;
  await assert.rejects(target.receiveRecords([records[1], conflicting]), /history-id-reused/);
  assert.equal(await target.receipt(records[1].batch.id), undefined);
  assert.deepEqual((await target.read(fixture.document.id)).history, [record.history]);
  await target.receiveRecords([{ batch: record.batch }]);
  assert.deepEqual(await target.pendingRecords(), [record], 'a body-only replay cannot remove metadata');
});

test('local retry cannot change or add immutable history; omitted metadata remains an idempotent retry', async () => {
  const target = await initialized(), { batch, history } = records[0];
  assert.equal((await target.commit(batch, history)).status, 'durable');
  const mismatch = await target.commit(batch, { ...history!, undoRequested: true });
  assert.equal(mismatch.status, 'aborted'); if (mismatch.status === 'aborted') assert.match(mismatch.reason, /history-id-reused/);
  assert.equal((await target.commit(batch)).status, 'durable');
  const bare = await initialized(); await bare.commit(batch);
  assert.equal((await bare.commit(batch, history)).status, 'aborted', 'local publication payload is fixed on first commit');
});

test('creation records retain initial content and creation history together; retry cannot rewrite history', async () => {
  const source = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  const target = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  const publication = fixture.publications[0].value, batch = publication.libraryBatch;
  const history = { operationId: batch.id, beforeVersion: batch.parents[0], afterVersion: batch.id, undoRequested: false };
  for (const repo of [source, target]) {
    for (const key of ['document', 'markdown', 'library']) await repo.initialize(fixture[key]);
    await repo.storeResource({ ...fixture.resource.metadata, bytes: Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url))) });
  }
  assert.equal((await source.publish(publication, history)).status, 'durable');
  const pending = await source.pendingRecords(); assert.deepEqual(pending, [{ batch, publication, history }]);
  await target.receiveRecords(pending);
  assert.deepEqual((await target.read(scope.libraryId)).history, [history]);
  assert.deepEqual((await target.read(publication.content.id)).checkpoint.root, publication.content);
  assert.deepEqual(await target.pendingRecords(), []);
  assert.equal((await source.publish(publication, { ...history, undoRequested: true })).status, 'aborted');
  assert.deepEqual(await source.pendingRecords(), pending);
});

test('record validation rejects mismatched history and former wire envelopes before native import', async () => {
  for (const damage of ['operationId', 'beforeVersion', 'afterVersion'] as const) {
    const bad = structuredClone(records[0]); bad.history![damage] = crypto.randomUUID();
    assert.throws(() => assertEditRecord(bad), /history-mismatch/);
  }
  const self = structuredClone(records[1]); self.history!.action!.operationId = self.batch.id;
  assert.throws(() => assertEditRecord(self), /history-mismatch/);
  for (const value of [records[0].batch, { kind: 'content-publication', publication: fixture.publications[0].value },
    { kind: 'edit-record', record: records[0], extra: true }, { kind: 'edit-record', record: self }]) {
    const transfer = createDriveEditTransfer({ async bindAccount() { return this; }, assertCurrent() {}, sharedEditFiles: async () => [{ id: 'bad' }], annotation: async () => value,
      saveSharedEdit: async () => assert.fail('read only'), sharedResource: async () => assert.fail('read only'),
      saveSharedResource: async () => assert.fail('read only') }, scope, 'folder');
    await assert.rejects(transfer.pull(), /invalid-edit-envelope|history-mismatch/);
  }
});
