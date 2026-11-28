import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { assertResourceBindings, assertResourceMetadata, inspectedResource, publicationItem, resourceHash } from '../src/runtime/edits/contentPublication.ts';
import type { ContentPublication, DocumentSnapshot, ResourceMetadata } from '../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { createDesktopEditRepository } from '../src/adapters/desktop/editRepository.ts';
import { BatchCommitSession } from '../src/runtime/edits/batchCommitSession.ts';
import type { EditBatch } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'publication' };
const source = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
const input = { id: fixture.resource.metadata.id, sha256: fixture.resource.metadata.sha256, mediaType: 'application/pdf', bytes: source };
const inspection = { inspectPdf: async () => structuredClone(fixture.resource.metadata.pdfPages) };

test('shared publication corpus validates content kinds, complete initial content and restricted catalog changes', () => {
  for (const entry of fixture.publications) assert.equal(publicationItem(entry.value).kind, entry.name);
  for (const entry of fixture.invalidPublications) assert.throws(() => publicationItem(entry.value), /./, entry.name);
});

test('PDF background bindings require durable bytes metadata, hash, page and physical dimensions', async () => {
  const document = fixture.publications[0].value.content as DocumentSnapshot;
  const metadata = fixture.resource.metadata as ResourceMetadata;
  await assertResourceBindings(document, async () => metadata);
  await assert.rejects(assertResourceBindings(document, async () => undefined), /missing-or-stale-resource/);
  for (const changes of [{ sha256: 'a'.repeat(64) }, { pdfPages: [] }, { mediaType: 'image/png' }]) {
    await assert.rejects(assertResourceBindings(document, async () => ({ ...metadata, ...changes })), /missing-or-stale-resource/);
  }
  const wrong = structuredClone(document); wrong.pages[0].widthPt += 10;
  await assert.rejects(assertResourceBindings(wrong, async () => metadata), /resource-page-dimensions/);
  assert.throws(() => assertResourceMetadata({ ...metadata, mediaType: 'image/png' }), /resource-pdf-metadata/);
});

test('publication rollback and idempotent retry retain one full outbox envelope and its history', async () => {
  for (const entry of fixture.publications) {
    const database = new EditMemoryDatabase(), publication: ContentPublication = structuredClone(entry.value);
    const repository = new DurableEditRepository(scope, database, inspection);
    for (const field of ['document', 'markdown', 'library']) await repository.initialize(fixture[field]);
    await repository.storeResource(input);
    if (publication.content) assert.equal((await repository.commit(publication.libraryBatch)).status, 'aborted');
    const faulty = new DurableEditRepository(scope, { transaction: run => database.transaction(tx => run({ ...tx,
      putProjection: snapshot => { tx.putProjection(snapshot); if (snapshot.kind === 'library') throw new Error('disk full'); },
    })) }, inspection);
    const history = { operationId: publication.libraryBatch.id, beforeVersion: publication.libraryBatch.parents[0],
      afterVersion: publication.libraryBatch.id, undoRequested: false };
    // A raw storage exception is not a Core semantic rejection; the evaluator propagates it for the
    // adapter/facade to classify (transaction design: never auto-convert storage failure to aborted).
    await assert.rejects(faulty.publish(publication, history), /disk full/);
    if (publication.content) await assert.rejects(repository.read(publication.content.id), /missing-target/);
    assert.equal((await repository.pending()).length, 0);
    assert.deepEqual((await repository.read(fixture.libraryId)).heads, [fixture.library.version]);
    assert.equal((await repository.publish(publication, history)).status, 'durable');
    const restarted = new DurableEditRepository(scope, database, inspection);
    assert.deepEqual(await restarted.pendingPublications(), [publication]);
    assert.deepEqual((await restarted.read(fixture.libraryId)).history, [history]);
    assert.equal((await restarted.publish(publication, history)).status, 'durable');
    const changed = structuredClone(publication); changed.libraryBatch.changes[0] = { type: 'put-item', item: { ...publicationItem(changed), title: 'different payload' } };
    assert.equal((await restarted.publish(changed)).status, 'aborted');
    if (publication.content) assert.deepEqual((await restarted.read(publication.content.id)).checkpoint.root, publication.content);
    await restarted.acknowledgeUpload(publication.libraryBatch.id);
    assert.deepEqual(await restarted.pendingPublications(), []);
    assert.deepEqual((await restarted.read(fixture.libraryId)).publicationOrigins, [{ batchId: publication.libraryBatch.id,
      itemId: publicationItem(publication).id, kind: publicationItem(publication).kind, contentVersion: publication.content?.version ?? null }],
    'creation proof survives upload acknowledgment without returning full published bodies');
  }
});

test('a resource must be verified before publication and resource IDs are immutable', async () => {
  const database = new EditMemoryDatabase(), repository = new DurableEditRepository(scope, database, inspection);
  for (const field of ['document', 'markdown', 'library']) await repository.initialize(fixture[field]);
  assert.equal((await repository.publish(fixture.publications[0].value)).status, 'aborted');
  await assert.rejects(repository.storeResource({ ...input, sha256: 'a'.repeat(64) }), /resource-hash/);
  assert.equal(await repository.readResource(input.id), undefined);
  const metadata = await repository.storeResource(input); assert.deepEqual(metadata, fixture.resource.metadata);
  const bytes = new TextEncoder().encode('different bytes');
  await assert.rejects(repository.storeResource({ ...input, mediaType: 'text/plain', bytes, sha256: await resourceHash(bytes) }), /resource-id-reused/);
  assert.deepEqual((await repository.readResource(input.id))?.bytes, source);
  assert.equal((await repository.publish(fixture.publications[0].value)).status, 'durable');
  await repository.acknowledgeUpload(fixture.publications[0].value.libraryBatch.id);
  assert.deepEqual(await repository.pendingPublications(), []);
});

test('desktop publication response loss is unknown; resource replies cannot silently change identity or bytes', async () => {
  const repository = createDesktopEditRepository(scope, async () => { throw new Error('response lost'); });
  assert.equal((await repository.publish(fixture.publications[2].value)).status, 'unknown');
  const wrong = createDesktopEditRepository(scope, async <T>() => ({ metadata: { ...fixture.resource.metadata, id: crypto.randomUUID() }, dataBase64: btoa(String.fromCharCode(...source)) }) as T);
  await assert.rejects(wrong.readResource(input.id), /invalid-resource-response/);
});

test('cross-parser sub-millipoint differences retain the verified publisher metadata', () => {
  const parsed: ResourceMetadata = structuredClone(fixture.resource.metadata), canonical = structuredClone(parsed);
  canonical.pdfPages![0].widthPt += .0001;
  assert.deepEqual(inspectedResource(parsed, canonical), canonical);
  canonical.pdfPages![0].widthPt += 1;
  assert.throws(() => inspectedResource(parsed, canonical), /resource-inspection-mismatch/);
});

test('incoming publication and a first document edit commit together, or neither becomes visible', async () => {
  const database = new EditMemoryDatabase(), repository = new DurableEditRepository(scope, database, inspection);
  for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
  const publication: ContentPublication = fixture.publications[2].value;
  const change = { kind: 'markdown' as const, imageResources: [], id: crypto.randomUUID(), libraryId: scope.libraryId,
    targetId: publication.content!.id, parents: [publication.content!.version], content: 'next edit' };
  const faulty = new DurableEditRepository(scope, { transaction: run => database.transaction(tx => run({ ...tx,
    putProjection: snapshot => { tx.putProjection(snapshot); if (snapshot.version === change.id) throw new Error('quota'); },
  })) }, inspection);
  await assert.rejects(faulty.receivePublications([publication], [change]), /quota/);
  await assert.rejects(repository.read(publication.content!.id), /missing-target/);
  assert.equal(await repository.receipt(publication.libraryBatch.id), undefined);
  await repository.receivePublications([publication], [change]);
  assert.deepEqual((await repository.read(publication.content!.id)).heads, [change.id]);
  assert.deepEqual(await repository.pendingPublications(), []);
  const wrong = structuredClone(publication); (wrong.content as { content: string }).content = 'different initial content';
  await assert.rejects(repository.receivePublications([wrong]), /publication-id-reused/);
});

test('Undo after a creation response loss resends the full publication before its inverse catalog change', async () => {
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
  const publication: ContentPublication = structuredClone(fixture.publications[2].value);
  const inverse: EditBatch = { kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [publication.libraryBatch.id], changes: [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), active: true,
      itemIds: [publication.content!.id], observed: [{ targetId: publication.content!.id, heads: [publication.content!.version] }] } }] };
  const requests: ContentPublication[] = []; let loseReply = true;
  const session = new BatchCommitSession({
    publish: async value => {
      requests.push(structuredClone(value)); const result = await repository.publish(value);
      if (loseReply) { loseReply = false; return { status: 'unknown', reason: 'response lost' }; }
      return result;
    },
    commit: async batch => { assert.equal(batch.id, inverse.id); return repository.commit(batch); },
  }, { publication }, () => ({ batch: inverse }));
  await session.flush(); assert.equal(session.getSnapshot().phase, 'unknown'); assert.equal(session.canLeave(), false);
  session.requestUndo(); await session.flush();
  assert.deepEqual(requests, [publication, publication]);
  assert.equal(session.getSnapshot().phase, 'undone');
  assert.deepEqual((await repository.read(scope.libraryId)).heads, [inverse.id]);
  assert.deepEqual((await repository.read(publication.content!.id)).checkpoint.root, publication.content);
});

test('edits listed before creation survive restart privately and resolve after the initial content arrives', async () => {
  const database = new EditMemoryDatabase(), repository = new DurableEditRepository(scope, database);
  for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
  const publication: ContentPublication = fixture.publications[2].value;
  const edit: EditBatch = { kind: 'markdown', imageResources: [], id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: publication.content!.id,
    parents: [publication.content!.version], content: 'child arrived first' };
  await repository.receive([edit]);
  await assert.rejects(repository.read(publication.content!.id), /missing-target/);
  assert.deepEqual((await repository.read(scope.libraryId)).heads, [fixture.library.version]);
  const restarted = new DurableEditRepository(scope, database);
  assert.equal((await restarted.receipt(edit.id))?.durable, true);
  await restarted.receivePublications([publication]);
  assert.deepEqual((await restarted.read(publication.content!.id)).heads, [edit.id]);
  assert.deepEqual((await restarted.read(scope.libraryId)).heads, [publication.libraryBatch.id]);
});
