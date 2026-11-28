import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyBatch, assertBatch, assertSnapshot } from '../src/runtime/edits/editModel.ts';
import { assertResourceBindings, batchResourceIds, isImageMediaType, publicationResourceIds, snapshotResourceIds } from '../src/runtime/edits/contentPublication.ts';
import { assertDatasetCheckpoint, checkpointHash, checkpointResourceIds } from '../src/runtime/edits/datasetManifest.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import type { MarkdownSnapshot, ResourceMetadata } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const images = fixture.markdownImages, metadata: ResourceMetadata = images.metadata;
const withImage = applyBatch(fixture.markdown, images.batch) as MarkdownSnapshot;
const scope = { accountId: 'image-resources', libraryId: fixture.libraryId, epoch: 'one' };

test('Markdown body and image manifest replace atomically and reject absent/duplicate bindings', () => {
  assert.deepEqual(withImage.imageResources, images.batch.imageResources);
  assert.equal(withImage.content, images.batch.content);
  assert.deepEqual((applyBatch(withImage, images.remove) as MarkdownSnapshot).imageResources, []);
  assert.throws(() => assertSnapshot({ ...withImage, imageResources: undefined }));
  assert.throws(() => assertBatch({ ...images.batch, imageResources: undefined }));
  assert.throws(() => assertSnapshot({ ...withImage, imageResources: [...withImage.imageResources, ...withImage.imageResources] }), /duplicate-markdown-image/);
  assert.throws(() => assertBatch({ ...images.batch, imageResources: [...withImage.imageResources, ...withImage.imageResources] }), /duplicate-markdown-image/);
});

test('shared image MIME corpus and bindings require exact resource identity/hash and valid image metadata', async () => {
  for (const entry of images.mediaTypes) assert.equal(isImageMediaType(entry.value), entry.valid, JSON.stringify(entry));
  await assertResourceBindings(withImage, async () => metadata);
  for (const invalid of [undefined, { ...metadata, id: crypto.randomUUID() }, { ...metadata, sha256: '0'.repeat(64) },
    { ...metadata, mediaType: 'text/html' }, { ...metadata, mediaType: 'image/*' }]) {
    await assert.rejects(assertResourceBindings(withImage, async () => invalid), /missing-or-stale-image-resource/);
  }
  const publication = structuredClone(fixture.publications[2].value);
  publication.content.imageResources = images.batch.imageResources;
  assert.deepEqual(publicationResourceIds(publication), [metadata.id]);
  assert.deepEqual(snapshotResourceIds(withImage), [metadata.id]); assert.deepEqual(batchResourceIds(images.batch), [metadata.id]);
});

test('durable repository refuses missing images and retains historical image bytes through removal and checkpoint restore', async () => {
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  for (const root of [fixture.document, fixture.markdown, fixture.library]) await repository.initialize(root);
  assert.equal((await repository.commit(images.batch)).status, 'aborted');
  const bytes = Uint8Array.from(Buffer.from(images.bytesBase64, 'base64'));
  await assert.rejects(repository.storeResource({ ...metadata, sha256: '0'.repeat(64), bytes }), /hash/);
  await repository.storeResource({ ...metadata, bytes });
  assert.equal((await repository.commit(images.batch)).status, 'durable');
  assert.equal((await repository.commit(images.remove)).status, 'durable');
  const checkpoint = await repository.checkpoint();
  assert.deepEqual(checkpointResourceIds(checkpoint), [metadata.id]);
  const manifest = { version: 1 as const, id: crypto.randomUUID(), scope, checkpointSha256: await checkpointHash(checkpoint), resources: [metadata] };
  await assertDatasetCheckpoint(manifest, checkpoint, scope);
  await assert.rejects(assertDatasetCheckpoint({ ...manifest, resources: [{ ...metadata, sha256: '0'.repeat(64) }] }, checkpoint, scope), /missing-or-stale-image-resource/);
  const target = new DurableEditRepository(scope, new EditMemoryDatabase());
  await target.storeResource({ ...metadata, bytes }); await target.installCheckpoint(checkpoint);
  assert.deepEqual((await target.readResource(metadata.id))?.bytes, bytes);
  assert.deepEqual((await target.read(fixture.markdown.id)).heads, [images.remove.id]);
});

test('ordinary replication uploads image bytes before the referring Markdown operation', async () => {
  const source = new DurableEditRepository(scope, new EditMemoryDatabase()), target = new DurableEditRepository(scope, new EditMemoryDatabase());
  for (const repository of [source, target]) await repository.initialize(fixture.markdown);
  const bytes = Uint8Array.from(Buffer.from(images.bytesBase64, 'base64'));
  await source.storeResource({ ...metadata, bytes }); await source.commit(images.batch);
  const events: string[] = [];
  const replication = new EditReplication(source, {
    pull: async () => ({ edits: [], imports: [] }), imported: async () => {},
    uploadResource: async resource => { events.push('resource'); await target.storeResource({ ...resource.metadata, bytes: resource.bytes }); },
    upload: async record => { events.push('edit'); await target.receiveRecords([record]); },
    downloadResource: async () => { throw new Error('unexpected download'); },
  }, crypto.randomUUID());
  await replication.flush();
  assert.equal(replication.getSnapshot().error, ''); assert.deepEqual(events, ['resource', 'edit']);
  assert.deepEqual((await target.read(fixture.markdown.id)).heads, [images.batch.id]);
  assert.deepEqual((await target.readResource(metadata.id))?.bytes, bytes);
});
