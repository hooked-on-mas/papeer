import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalLibraryCorpus } from '../../../src/features/library/query/canonicalLibraryCorpus.ts';
import { LibraryQuerySession } from '../../../src/features/library/query/LibraryQuerySession.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { resourceHash } from '../../../src/runtime/edits/contentPublication.ts';
import type { LibraryItem, MarkdownSnapshot, DocumentSnapshot } from '../../../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';

const id = () => crypto.randomUUID();
const item = (kind: LibraryItem['kind'], itemId = id()): LibraryItem => ({ id: itemId, kind, title: 'title',
  ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} });
async function setup() {
  const scope = { accountId: 'corpus', libraryId: id(), epoch: 'one' };
  return new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => [{ widthPt: 600, heightPt: 800 }, { widthPt: 600, heightPt: 800 }] });
}

test('saved Markdown corpus includes competing heads but no editor, draft, history or repository writes', async () => {
  const repository = await setup(), note = item('markdown');
  const root: MarkdownSnapshot = { kind: 'markdown', id: note.id, version: id(), content: 'root no longer a head', appendIds: [], imageResources: [] };
  await repository.initialize(root);
  for (const content of ['first branch', 'second branch']) assert.equal((await repository.commit({ kind: 'markdown', id: id(), libraryId: repository.scope.libraryId,
    targetId: note.id, parents: [root.version], content, imageResources: [] })).status, 'durable');
  const before = await repository.checkpoint(), pending = await repository.pendingRecords();
  const corpus = await createCanonicalLibraryCorpus(repository).read([note, item('markdown'), item('attachment')], new AbortController().signal);
  assert.equal(corpus[0].status, 'complete'); assert.match(corpus[0].text, /first branch/); assert.match(corpus[0].text, /second branch/);
  assert.doesNotMatch(corpus[0].text, /root no longer/); assert.equal(corpus[1].status, 'missing'); assert.equal(corpus[2].status, 'unsupported');
  assert.deepEqual(await repository.checkpoint(), before); assert.deepEqual(await repository.pendingRecords(), pending); assert.deepEqual(await repository.pendingIntents(), []);
});

test('PDF corpus validates bytes, uses physical page mapping once per source and excludes deleted pages', async () => {
  const repository = await setup(), pdfItem = item('pdf'), bytes = new Uint8Array([1, 2, 3]);
  const resource = await repository.storeResource({ id: id(), sha256: await resourceHash(bytes), mediaType: 'application/pdf', bytes });
  const page = (physical: number) => ({ id: id(), backgroundRevision: id(), lifecycleVersion: id(), annotationVersion: id(), widthPt: 600, heightPt: 800,
    background: { kind: 'pdf' as const, resourceId: resource.id, sourceRevision: resource.sha256, pdfPage: physical }, annotations: [] });
  const root: DocumentSnapshot = { kind: 'document', id: pdfItem.id, version: id(), pages: [page(2), page(2)], deletedPages: [page(1)] };
  await repository.initialize(root); let calls = 0;
  const corpus = createCanonicalLibraryCorpus(repository, async (stored, pages) => {
    calls++; assert.deepEqual(stored.bytes, bytes); assert.deepEqual(pages, [1, 2]); return new Map([[1, 'deleted original'], [2, 'physical second']]);
  });
  const result = await corpus.read([pdfItem], new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result[0].status, 'complete'); assert.match(result[0].text, /physical second/); assert.doesNotMatch(result[0].text, /deleted original/);
  repository.readResource = async () => ({ metadata: resource, bytes: new Uint8Array([3, 2, 1]) });
  const corrupt = await corpus.read([pdfItem], new AbortController().signal);
  assert.equal(calls, 1); assert.equal(corrupt[0].status, 'partial'); assert.equal(corrupt[0].text.trim(), '');
});

test('resource arrival changes the cheap revision and rechecks the same catalog without creating editing authorities', async () => {
  const repository = await setup(), pdfItem = item('pdf'), bytes = new Uint8Array([5, 6, 7]);
  const resource = await repository.storeResource({ id: id(), sha256: await resourceHash(bytes), mediaType: 'application/pdf', bytes });
  const root: DocumentSnapshot = { kind: 'document', id: pdfItem.id, version: id(), deletedPages: [], pages: [{
    id: id(), backgroundRevision: id(), lifecycleVersion: id(), annotationVersion: id(), widthPt: 600, heightPt: 800,
    background: { kind: 'pdf', resourceId: resource.id, sourceRevision: resource.sha256, pdfPage: 1 }, annotations: [],
  }] };
  await repository.initialize(root);
  const readResource = repository.readResource.bind(repository), metadata = repository.resourceMetadata.bind(repository);
  let arrived = false, extractions = 0;
  repository.readResource = resourceId => arrived ? readResource(resourceId) : Promise.resolve(undefined);
  repository.resourceMetadata = resourceId => arrived ? metadata(resourceId) : Promise.resolve(undefined);
  const before = await repository.checkpoint();
  const corpus = createCanonicalLibraryCorpus(repository, async () => { extractions++; return new Map([[1, 'newly available text']]); });
  const query = new LibraryQuerySession(corpus); await query.setCatalog([pdfItem]);
  await query.setQuery({ scope: 'content', text: 'newly available' });
  assert.deepEqual(query.getSnapshot().partialIds, [pdfItem.id]); assert.equal(extractions, 0);
  arrived = true; await query.setCatalog([pdfItem]);
  assert.deepEqual(query.getSnapshot().ids, [pdfItem.id]); assert.deepEqual(query.getSnapshot().partialIds, []); assert.equal(extractions, 1);
  await query.setCatalog([pdfItem]); assert.equal(extractions, 1);
  assert.deepEqual(await repository.checkpoint(), before); assert.deepEqual(await repository.pendingIntents(), []);
});
