import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDriveEditTransfer, type DriveEditStorage } from '../src/adapters/drive/editTransfer.ts';
import type { DatasetManifest, RepositoryCheckpoint } from '../src/runtime/edits/contracts.ts';
import { assertDatasetCheckpoint, checkpointHash } from '../src/runtime/edits/datasetManifest.ts';
import { importPublishedDataset, prepareDatasetPublication, publishDataset } from '../src/runtime/edits/datasetPublication.ts';
import type { StoredResource } from '../src/runtime/edits/ports.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const manifest: DatasetManifest = fixture.datasetManifest, scope = manifest.scope;
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
const inspect = { inspectPdf: async () => fixture.resource.metadata.pdfPages };
const repository = (database = new EditMemoryDatabase()) => new DurableEditRepository(scope, database, inspect);
async function populated() {
  const result = repository(); await result.storeResource({ ...fixture.resource.metadata, bytes });
  await result.installCheckpoint(fixture.checkpoint); return result;
}
function remote() {
  const objects = new Map<string, unknown>(), resources = new Map<string, StoredResource>(), events: string[] = [];
  const storage: DriveEditStorage = {
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async () => [...objects.keys()].reverse().map(id => ({ id })),
    annotation: async id => structuredClone(objects.get(id)),
    saveSharedEdit: async (_namespace, _folder, id, value) => {
      if (objects.has(id)) assert.deepEqual(objects.get(id), value, 'retry must retain the original IDs and payloads');
      objects.set(id, structuredClone(value)); events.push((value as { kind: string }).kind);
    },
    sharedResource: async (_namespace, metadata) => structuredClone(resources.get(metadata.id)!.bytes),
    saveSharedResource: async (_namespace, _folder, resource) => {
      resources.set(resource.metadata.id, structuredClone(resource));
      objects.set(resource.metadata.id, { kind: 'resource', metadata: resource.metadata, blobId: resource.metadata.id }); events.push('resource');
    },
  };
  return { storage, objects, resources, events, transfer: createDriveEditTransfer(storage, scope, 'folder') };
}

test('completed manifest is published last; import selects that immutable snapshot and retains parent waiting/history', async () => {
  const source = await populated(), target = repository(), wire = remote();
  const markdown = fixture.batches.find((batch: { kind: string }) => batch.kind === 'markdown');
  await source.commit(markdown);
  const publication = await prepareDatasetPublication(source, manifest.id);
  assert.equal((await source.commit({ kind: 'markdown', imageResources: [], libraryId: scope.libraryId, targetId: markdown.targetId,
    id: crypto.randomUUID(), parents: [markdown.id], content: 'after capture' })).status, 'durable');
  await publishDataset(publication, source, wire.transfer);
  assert.deepEqual(wire.events, ['resource', 'repository-checkpoint', 'dataset-manifest']);
  await new EditReplication(target, wire.transfer, crypto.randomUUID()).flush();
  await assert.rejects(target.read(scope.libraryId), /missing-target/, 'ordinary polling must not auto-select a published dataset');
  const peer = crypto.randomUUID();
  assert.deepEqual(await importPublishedDataset(target, wire.transfer, manifest.id, peer), publication.manifest);
  assert.deepEqual(await target.checkpoint(), publication.checkpoint);
  assert.equal((await target.read(fixture.markdown.id)).heads[0], markdown.id, 'later source edits must not leak into the frozen export');
  assert.equal((await target.read(fixture.document.id)).waiting.length, 1);
  assert.deepEqual(await target.installedDatasets(), [publication.manifest]);
  assert.equal((await source.pendingRecords()).length, 2, 'dataset publication cannot clear normal outbox obligations');
  for (const { batch } of publication.checkpoint.edits) assert.ok((await target.receipt(batch.id))?.importedBy.includes(peer));
  const sent = wire.events.length; await importPublishedDataset(target, wire.transfer, manifest.id, peer);
  assert.equal(wire.events.length, sent, 'repeat import does not duplicate receipts');
});

test('resource/checkpoint failure never publishes completion; lost manifest response resends the same plan', async () => {
  const source = await populated(), publication = await prepareDatasetPublication(source, manifest.id), wire = remote();
  await assert.rejects(publishDataset(publication, source, { ...wire.transfer, uploadResource: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(wire.events, []);
  await assert.rejects(publishDataset(publication, source, { ...wire.transfer, uploadCheckpoint: async () => { throw new Error('checkpoint-failed'); } }), /checkpoint-failed/);
  assert.deepEqual(wire.events, ['resource']);
  const target = repository();
  await assert.rejects(importPublishedDataset(target, wire.transfer, manifest.id, crypto.randomUUID()), /dataset-manifest-missing/);
  await assert.rejects(publishDataset(publication, source, { ...wire.transfer, uploadDatasetManifest: async value => {
    await wire.transfer.uploadDatasetManifest(value); throw new Error('manifest-response-lost');
  } }), /manifest-response-lost/);
  const count = wire.objects.size;
  await publishDataset(publication, source, wire.transfer);
  assert.equal(wire.objects.size, count);
  await importPublishedDataset(target, wire.transfer, manifest.id, crypto.randomUUID());
  assert.equal((await target.installedDatasets()).length, 1);
});

test('manifest/checkpoint mismatch, corrupt background and abort expose neither catalog nor completion marker', async () => {
  const source = await populated(), wire = remote(), target = repository(), publication = await prepareDatasetPublication(source, manifest.id);
  await wire.transfer.uploadDatasetManifest(publication.manifest);
  await assert.rejects(importPublishedDataset(target, wire.transfer, manifest.id, crypto.randomUUID()), /dataset-checkpoint-missing/);
  await publishDataset(publication, source, wire.transfer);
  wire.resources.get(manifest.resources[0].id)!.bytes[0] ^= 1;
  await assert.rejects(importPublishedDataset(target, wire.transfer, manifest.id, crypto.randomUUID()), /resource-hash/);
  await assert.rejects(target.read(scope.libraryId), /missing-target/); assert.deepEqual(await target.installedDatasets(), []);
  wire.resources.set(manifest.resources[0].id, { metadata: manifest.resources[0], bytes });
  const abort = new AbortController();
  await assert.rejects(importPublishedDataset(target, { ...wire.transfer, downloadResource: async metadata => {
    const resource = await wire.transfer.downloadResource(metadata); abort.abort(); return resource;
  } }, manifest.id, crypto.randomUUID(), abort.signal), /Abort/);
  assert.deepEqual(await target.installedDatasets(), []);
});

test('completion marker, roots, projections, edits and receipts share one native transaction; retry preserves pending journals', async () => {
  const database = new EditMemoryDatabase(), target = repository(database);
  await target.initialize(fixture.document);
  await target.commit(fixture.editRecords[0].batch, fixture.editRecords[0].history);
  await target.replaceIntent(fixture.document.id, fixture.intents[0], null);
  const pending = await target.pendingRecords(), receipt = await target.receipt(pending[0].batch.id);
  await target.storeResource({ ...fixture.resource.metadata, bytes });
  const failing = new DurableEditRepository(scope, { transaction: run => database.transaction(tx => run({ ...tx,
    putDataset: value => { tx.putDataset(value); throw new Error('quota-after-marker'); },
  })) }, inspect);
  await assert.rejects(failing.installDataset(manifest, fixture.checkpoint), /quota-after-marker/);
  await assert.rejects(target.read(scope.libraryId), /missing-target/);
  assert.deepEqual(await target.installedDatasets(), []);
  assert.equal(await target.receipt(fixture.checkpoint.edits.find((record: { publication?: unknown }) => record.publication).batch.id), undefined);
  await target.installDataset(manifest, fixture.checkpoint);
  assert.deepEqual(await target.installedDatasets(), [manifest]); assert.deepEqual(await target.pendingRecords(), pending);
  assert.deepEqual(await target.receipt(pending[0].batch.id), receipt);
  assert.deepEqual(await target.readIntent(fixture.document.id), fixture.intents[0]);
  await failing.installDataset(manifest, fixture.checkpoint); // A durable completion must not be rebuilt.
  const reused = { ...manifest, checkpointSha256: await checkpointHash(await target.checkpoint()) };
  await assert.rejects(target.installDataset(reused, await target.checkpoint()), /dataset-id-reused/);
});

for (const damage of ['scope', 'missing-resource', 'extra-resource', 'duplicate-resource', 'hash', 'missing-content', 'invalid-batch']) {
test(`a completed manifest rejects ${damage} even when the receiver already has that content`, async () => {
  const target = await populated(), value = structuredClone(manifest), checkpoint: RepositoryCheckpoint = structuredClone(fixture.checkpoint);
  if (damage === 'scope') value.scope.epoch = 'other';
  if (damage === 'missing-resource') value.resources = [];
  if (damage === 'extra-resource') value.resources.push({ ...value.resources[0], id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
  if (damage === 'duplicate-resource') value.resources.push(value.resources[0]);
  if (damage === 'hash') value.checkpointSha256 = '0'.repeat(64);
  if (damage === 'missing-content') checkpoint.roots = checkpoint.roots.filter(root => root.id !== fixture.markdown.id);
  if (damage === 'invalid-batch') {
    const page = checkpoint.edits.find(record => record.batch.kind === 'page')!.batch;
    if (page.kind === 'page') page.expected.backgroundRevision = crypto.randomUUID();
  }
  if (['missing-content', 'invalid-batch'].includes(damage)) value.checkpointSha256 = await checkpointHash(checkpoint);
  await assert.rejects(target.installDataset(value, checkpoint));
  assert.deepEqual(await target.installedDatasets(), []);
});
}

test('conflicting duplicate manifest IDs do not choose a winner by list order; envelope scope remains exact', async () => {
  const source = await populated(), wire = remote(), target = repository();
  const publication = await prepareDatasetPublication(source, manifest.id);
  await publishDataset(publication, source, wire.transfer);
  wire.objects.set('duplicate', { kind: 'dataset-manifest', manifest: { ...publication.manifest, checkpointSha256: '0'.repeat(64) } });
  await assert.rejects(importPublishedDataset(target, wire.transfer, manifest.id, crypto.randomUUID()), /dataset-id-reused/);
  wire.objects.set('duplicate', { kind: 'dataset-manifest', manifest: { ...publication.manifest, scope: { ...scope, accountId: 'other' } } });
  await assert.rejects(wire.transfer.pull({ dataset: true }), /dataset-scope|immutable-drive-file-changed/);
  assert.deepEqual(await target.installedDatasets(), []);
});

test('publication validates bodies and captures invocation before asynchronous I/O; cancellation stops the final manifest', async () => {
  const source = await populated(), plan = await prepareDatasetPublication(source, manifest.id), wire = remote();
  const corrupt = { scope, readResource: async (id: string) => {
    const resource = structuredClone((await source.readResource(id))!); resource.bytes[0] ^= 1; return resource;
  } };
  await assert.rejects(publishDataset(plan, corrupt, wire.transfer), /resource-hash/); assert.deepEqual(wire.events, []);
  const abort = new AbortController();
  await assert.rejects(publishDataset(plan, source, { ...wire.transfer, uploadCheckpoint: async (checkpoint, id) => {
    await wire.transfer.uploadCheckpoint(checkpoint, id); abort.abort();
  } }, abort.signal), /Abort/);
  assert.equal(wire.objects.has(manifest.id), false);
  const captured = structuredClone(plan), nextWire = remote();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const saving = publishDataset(captured, source, { ...nextWire.transfer, uploadResource: async resource => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); await nextWire.transfer.uploadResource(resource);
  } });
  await started;
  captured.manifest.resources[0].sha256 = '0'.repeat(64); captured.manifest.id = crypto.randomUUID(); captured.checkpoint.edits = [];
  release(); await saving;
  assert.deepEqual(nextWire.objects.get(plan.checkpointObjectId), { kind: 'repository-checkpoint', checkpoint: plan.checkpoint });
  assert.deepEqual(nextWire.objects.get(plan.manifest.id), { kind: 'dataset-manifest', manifest: plan.manifest });
  await assertDatasetCheckpoint(manifest, fixture.checkpoint, scope);
});

test('publication capture keeps immutable references without loading all PDF bodies into the plan', async () => {
  const stored = await populated(); let reads = 0;
  const source = { ...stored, readResource: async (id: string) => { reads++; return stored.readResource(id); } };
  const plan = await prepareDatasetPublication(source, manifest.id), wire = remote();
  assert.equal(reads, 0, 'capturing a large dataset must not load every background body');
  await publishDataset(plan, source, wire.transfer);
  assert.equal(reads, 1);
  assert.deepEqual(wire.events, ['resource', 'repository-checkpoint', 'dataset-manifest']);
});
