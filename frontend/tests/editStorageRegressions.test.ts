import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DurableEditRepository, type EditTransaction } from '../src/runtime/edits/repository.ts';
import { DocumentEditSession } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { EditRecord } from '../src/runtime/edits/contracts.ts';
import { importPublishedDataset } from '../src/runtime/edits/datasetPublication.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = fixture.datasetManifest.scope;
const records: EditRecord[] = fixture.editRecords;
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
function setup() {
  const database = new EditMemoryDatabase(scope);
  return { database, repository: new DurableEditRepository(scope, database, { inspectPdf: async () => fixture.resource.metadata.pdfPages }) };
}

test('invalid action reference aborts atomically and the correct same-ID retry restores Undo', async () => {
  const { repository } = setup(); await repository.initialize(fixture.document);
  await repository.receiveRecords(records.slice(0, 2));
  const bad = structuredClone(records[2]); bad.history!.action!.operationId = crypto.randomUUID();
  await assert.rejects(repository.receiveRecords([bad]), /history-action-order/);
  assert.equal(await repository.receipt(bad.batch.id), undefined);
  assert.equal((await repository.commit(bad.batch, bad.history)).status, 'aborted');
  await repository.receiveRecords([records[2]]);
  const session = new DocumentEditSession(repository, fixture.document.id); await session.refresh();
  assert.equal(session.getSnapshot().canUndo, true);
});

test('bare normal batch and complete Undo remain pending until original history arrives', async () => {
  const { repository } = setup(); await repository.initialize(fixture.document);
  await repository.receive([records[0].batch]); await repository.receiveRecords([records[1]]);
  const session = new DocumentEditSession(repository, fixture.document.id); await session.refresh();
  assert.equal(session.getSnapshot().canUndo, false); assert.equal(session.getSnapshot().canRedo, false);
  await repository.receiveRecords([records[0]]); await session.refresh();
  assert.equal(session.getSnapshot().canRedo, true);
});

test('late parent quarantines only invalid action metadata and allows a corrected same-ID record', async () => {
  const { repository } = setup(); await repository.initialize(fixture.document);
  const bad = structuredClone(records[1]); bad.history!.action!.operationId = crypto.randomUUID();
  await repository.receiveRecords([bad]); await repository.receiveRecords([records[0]]);
  assert.deepEqual((await repository.read(fixture.document.id)).history, [records[0].history]);
  await repository.receiveRecords([records[1]]);
  const session = new DocumentEditSession(repository, fixture.document.id); await session.refresh();
  assert.equal(session.getSnapshot().canRedo, true);
});

for (const gap of ['quarantined', 'pending'] as const) {
  test(`new edits retain Undo and Redo after ${gap} earlier history`, async () => {
    const { repository } = setup(); await repository.initialize(fixture.document);
    if (gap === 'quarantined') {
      const bad = structuredClone(records[1]); bad.history!.action!.operationId = crypto.randomUUID();
      await repository.receiveRecords([bad]); await repository.receiveRecords([records[0]]);
    } else {
      await repository.receive([records[0].batch]); await repository.receiveRecords([records[1]]);
    }
    const batch = structuredClone(records[0].batch);
    assert.equal(batch.kind, 'page'); if (batch.kind !== 'page') return;
    batch.id = crypto.randomUUID(); batch.parents = [records[1].batch.id];
    batch.expected.annotationVersion = records[1].batch.id;
    const change = batch.changes[0]; assert.equal(change.type, 'create');
    if (change.type !== 'create') return;
    change.annotation.id = crypto.randomUUID();
    assert.equal((await repository.commit(batch, { operationId: batch.id, beforeVersion: batch.parents[0],
      afterVersion: batch.id, undoRequested: false })).status, 'durable');
    const session = new DocumentEditSession(repository, fixture.document.id); await session.refresh();
    assert.equal(session.getSnapshot().canUndo, true);
    assert.equal((await session.undo()).status, 'applied');
    assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
    assert.equal(session.getSnapshot().canUndo, false);
    assert.equal(session.getSnapshot().canRedo, true);
    assert.equal((await session.redo()).status, 'applied');
    assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1);
    // Later metadata supplementation rebuilds the full causal history without
    // losing the new edit's Undo/Redo operation IDs.
    await repository.receiveRecords([gap === 'pending' ? records[0] : records[1]]);
    await session.refresh();
    assert.equal(session.getSnapshot().canUndo, true);
    assert.equal((await session.undo()).status, 'applied');
    assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
  });
}

for (const boundary of ['install', 'repeat-install', 'publish', 'activate'] as const) {
  test(`same-length resource corruption aborts ${boundary} without changing the control pointer`, async () => {
    const { database, repository } = setup();
    await repository.storeResource({ ...fixture.resource.metadata, bytes });
    const initial = fixture.datasetControls.initial;
    await repository.replaceDatasetControl(initial[0], null);
    if (boundary !== 'install') await repository.installDataset(fixture.datasetManifest, fixture.checkpoint);
    if (boundary === 'activate') await repository.replaceDatasetControl(initial[1], initial[0].id);
    const before = await repository.datasetControl();
    await database.transaction(async tx => { tx.putResource({ metadata: fixture.resource.metadata, bytes: new Uint8Array(bytes.length).fill(120) }); });
    await assert.rejects(boundary === 'install' || boundary === 'repeat-install'
      ? repository.installDataset(fixture.datasetManifest, fixture.checkpoint)
      : repository.replaceDatasetControl(initial[boundary === 'publish' ? 1 : 2], before!.id), /resource-hash/);
    assert.deepEqual(await repository.datasetControl(), before);
    if (boundary === 'install') assert.deepEqual(await repository.installedDatasets(), []);
  });
}

test('import verifies existing matching metadata bytes before marking a dataset complete', async () => {
  const { database, repository } = setup(); await repository.storeResource({ ...fixture.resource.metadata, bytes });
  await database.transaction(async tx => { tx.putResource({ metadata: fixture.resource.metadata, bytes: new Uint8Array(bytes.length).fill(120) }); });
  await assert.rejects(importPublishedDataset(repository, {
    pull: async () => ({ edits: [], imports: [], resources: [], manifests: [fixture.datasetManifest], checkpoints: [fixture.checkpoint] }),
    downloadResource: async () => assert.fail('existing corrupt bytes must be detected'),
    imported: async () => assert.fail('no acknowledgement before complete verification'),
  }, fixture.datasetManifest.id, crypto.randomUUID()), /resource-hash/);
  assert.deepEqual(await repository.installedDatasets(), []);
});


test('empty receive preserves validation and writes only repaired deferred history', async () => {
  const { database, repository } = setup(); await repository.initialize(fixture.document);
  await repository.receiveRecords(records.slice(0, 2));
  const originalTransaction = database.transaction.bind(database); let writes: string[] = [];
  database.transaction = <T>(run: (tx: EditTransaction) => Promise<T>): Promise<T> => originalTransaction(tx => run({
    ...tx, putEdit: edit => { writes.push(edit.batch.id); tx.putEdit(edit); },
  }));
  await repository.receiveRecords([]); assert.deepEqual(writes, []);
  const before = await repository.read(fixture.document.id); assert.equal(before.history.length, 2);
  await originalTransaction(async tx => {
    const edit = (await tx.edits()).find(value => value.batch.id === records[1].batch.id)!;
    const bad = structuredClone(edit); bad.history!.action!.operationId = crypto.randomUUID(); tx.putEdit(bad);
  });
  writes = []; await repository.receiveRecords([]);
  assert.deepEqual(writes, [records[1].batch.id]);
  const after = await repository.read(fixture.document.id);
  assert.deepEqual(after.history, [records[0].history]);
  assert.equal(after.receipts.length, before.receipts.length);
  assert.deepEqual(after.heads, before.heads);
});
