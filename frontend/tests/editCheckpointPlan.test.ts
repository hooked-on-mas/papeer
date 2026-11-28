import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPlanTestRepository } from './support/editPlanTestRepository.ts';
import { EditPlanMemoryDatabase } from './support/editPlanMemoryDatabase.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { createDriveEditTransfer, type DriveEditStorage } from '../src/adapters/drive/editTransfer.ts';
import { publishRepositoryCheckpoint } from '../src/runtime/edits/checkpointPublication.ts';
import type { StoredResource } from '../src/runtime/edits/ports.ts';
import type { EditBatch, RepositoryCheckpoint } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'checkpoint' };
const repository = () => createPlanTestRepository(scope, new EditPlanMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
async function sourceRepository() {
  const source = repository();
  for (const key of ['document', 'markdown', 'library']) await source.initialize(fixture[key]);
  await source.storeResource({ ...fixture.resource.metadata, bytes });
  const publication = fixture.publications[0].value, batch = publication.libraryBatch;
  const history = { operationId: batch.id, beforeVersion: batch.parents[0], afterVersion: batch.id, undoRequested: false };
  assert.equal((await source.publish(publication, history)).status, 'durable');
  await source.receive([fixture.batches[0]]);
  return source;
}

test('checkpoint bootstraps whole roots, complete publication, history and DAG while preserving pending receipts', async () => {
  const source = await sourceRepository(), checkpoint = await source.checkpoint(), target = repository();
  await assert.rejects(target.installCheckpoint(checkpoint), /missing-or-stale-resource|missing-resource|publication-pdf-required/);
  await assert.rejects(target.read(scope.libraryId), /missing-target/);
  await target.storeResource({ ...fixture.resource.metadata, bytes });
  await target.installCheckpoint(checkpoint);
  assert.deepEqual(await target.checkpoint(), checkpoint);
  assert.deepEqual(await target.pending(), []);
  const pending = await source.pending();
  await source.installCheckpoint(checkpoint);
  assert.deepEqual(await source.pending(), pending);
  const pubId = fixture.publications[0].value.libraryBatch.id;
  assert.equal((await source.receipt(pubId))?.upload, 'pending');
  assert.equal((await target.receipt(pubId))?.upload, 'accepted');
  const markdown: EditBatch = { kind: 'markdown', imageResources: [], id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: fixture.markdown.id,
    parents: [fixture.markdown.version], content: 'locally pending after bootstrap' };
  assert.equal((await target.commit(markdown)).status, 'durable');
  await target.installCheckpoint(checkpoint);
  assert.equal((await target.receipt(markdown.id))?.upload, 'pending');
  assert.deepEqual((await target.read(markdown.targetId)).heads, [markdown.id]);
});

test('invalid root, duplicate ID, changed immutable edit and mismatched history roll the full bootstrap back', async () => {
  const source = await sourceRepository(), original = await source.checkpoint();
  const badCheckpoints: RepositoryCheckpoint[] = [];
  const duplicateRoot = structuredClone(original); duplicateRoot.roots.push(duplicateRoot.roots[0]); badCheckpoints.push(duplicateRoot);
  const duplicateEdit = structuredClone(original); duplicateEdit.edits.push(duplicateEdit.edits[0]); badCheckpoints.push(duplicateEdit);
  const wrongHistory = structuredClone(original); const historical = wrongHistory.edits.find(edit => edit.history)!;
  historical.history!.afterVersion = crypto.randomUUID(); badCheckpoints.push(wrongHistory);
  const wrongPublication = structuredClone(original); wrongPublication.edits.find(edit => edit.publication)!.publication!.libraryBatch.id = crypto.randomUUID(); badCheckpoints.push(wrongPublication);
  for (const checkpoint of badCheckpoints) {
    const target = repository(); await target.storeResource({ ...fixture.resource.metadata, bytes });
    await assert.rejects(target.installCheckpoint(checkpoint));
    await assert.rejects(target.read(scope.libraryId), /missing-target/);
    assert.deepEqual(await target.pending(), []);
  }
  const changed = structuredClone(original); const root = changed.roots.find(root => root.kind === 'markdown')!;
  if (root.kind === 'markdown') root.content = 'replaced genesis';
  await assert.rejects(source.installCheckpoint(changed), /root-already-initialized/);
  assert.deepEqual(await source.checkpoint(), original);
});

test('checkpoint publisher sends dependencies first; ordinary replication cannot expose an unfinished dataset', async () => {
  const source = await sourceRepository(), target = repository(), objects: unknown[] = [], bodies = new Map<string, StoredResource>();
  const events: string[] = [];
  const storage: DriveEditStorage = {
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async () => objects.map((_, index) => ({ id: String(index) })),
    annotation: async id => objects[Number(id)],
    saveSharedEdit: async (_namespace, _folder, _id, value) => { objects.push(structuredClone(value)); events.push((value as { kind: string }).kind); },
    sharedResource: async (_namespace, metadata) => bodies.get(metadata.id)!.bytes,
    saveSharedResource: async (_namespace, _folder, resource) => {
      bodies.set(resource.metadata.id, structuredClone(resource)); objects.push({ kind: 'resource', metadata: resource.metadata, blobId: resource.metadata.id }); events.push('resource');
    },
  };
  const transfer = createDriveEditTransfer(storage, scope, 'folder');
  await publishRepositoryCheckpoint(source, transfer, crypto.randomUUID());
  assert.deepEqual(events, ['resource', 'repository-checkpoint']);
  await new EditReplication(target, transfer, crypto.randomUUID()).flush();
  await assert.rejects(target.read(scope.libraryId), /missing-target/);
  assert.deepEqual(await target.installedDatasets(), []);
  const read = await transfer.pull({ dataset: true }); assert.equal(read.checkpoints!.length, 1);
  assert.ok((await source.pending()).length > 0, 'a checkpoint does not clear batch upload obligations');
  const fail = { uploadResource: async () => { throw new Error('network-down'); }, uploadCheckpoint: async () => assert.fail('cannot expose checkpoint before resources') };
  await assert.rejects(publishRepositoryCheckpoint(source, fail, crypto.randomUUID()), /network-down/);
});

test('the canonical checkpoint corpus retains parent waiting and identical archive content across runtimes', async () => {
  const target = repository();
  await target.storeResource({ ...fixture.resource.metadata, bytes });
  await target.installCheckpoint(fixture.checkpoint);
  assert.deepEqual(await target.checkpoint(), fixture.checkpoint);
  assert.equal((await target.read(fixture.document.id)).waiting.length, 1);
});
