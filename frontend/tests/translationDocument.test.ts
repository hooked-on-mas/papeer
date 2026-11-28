import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentEditBatch, DocumentSnapshot, PageEditBatch } from '../src/runtime/edits/contracts.ts';
import { applyBatch, assertSnapshot } from '../src/runtime/edits/editModel.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { pageExpectation } from '../src/runtime/edits/documentPages.ts';
import { translatedBinding, originalForBinding } from '../src/features/reader/pageMapping.ts';
import { batchResourceIds, snapshotResourceIds } from '../src/runtime/edits/contentPublication.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const root: DocumentSnapshot = fixture.translation.root;
const [ink, update]: [PageEditBatch, DocumentEditBatch] = fixture.translation.batches;
const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'translation' };
const document = (value: ReturnType<typeof applyBatch>) => { assert.equal(value.kind, 'document'); return value as DocumentSnapshot; };

test('persisted mapping resolves physical pages independently of original ordinals and refuses stale/ambiguous targets', () => {
  const first = translatedBinding(root, root.pages[0].id), last = translatedBinding(root, root.pages[2].id);
  assert.equal(first.status, 'resolved'); assert.equal(last.status, 'resolved');
  if (first.status !== 'resolved' || last.status !== 'resolved') assert.fail();
  assert.equal(first.binding.pdfPage, 4); assert.equal(last.binding.pdfPage, 5);
  assert.equal(originalForBinding(root, last.binding), root.pages[2].id);
  assert.equal(originalForBinding(root, { ...last.binding, sourceRevision: 'a'.repeat(64) }), null);
  assert.deepEqual(translatedBinding(root, root.pages[1].id), { status: 'unresolved', reason: 'missing' });
  const stale = structuredClone(root); stale.pages[0].backgroundRevision = crypto.randomUUID();
  assert.deepEqual(translatedBinding(stale, root.pages[0].id), { status: 'unresolved', reason: 'source-changed' });
  const replaced = structuredClone(root); replaced.translation!.pages[0].backgroundRevision = crypto.randomUUID();
  assert.deepEqual(translatedBinding(replaced, root.pages[0].id), { status: 'unresolved', reason: 'target-changed' });
  const ambiguous = structuredClone(root); ambiguous.translation!.bindings[0].candidates.push(ambiguous.translation!.bindings[1].candidates[0]);
  assertSnapshot(ambiguous); assert.equal(translatedBinding(ambiguous, root.pages[0].id).status, 'unresolved');
  const shared = structuredClone(root); shared.translation!.bindings[1].candidates = shared.translation!.bindings[0].candidates;
  assert.deepEqual(translatedBinding(shared, root.pages[0].id), { status: 'unresolved', reason: 'ambiguous' });
  assert.equal(originalForBinding(shared, first.binding), null);
});

test('translated annotation and replacement share the document DAG; old annotation survives as a tombstone and late branch', () => {
  const annotated = document(applyBatch(root, ink));
  assert.deepEqual(annotated.pages, root.pages);
  assert.equal(annotated.translation!.pages[0].annotations.length, 1);
  const replaced = document(applyBatch(annotated, update));
  assert.equal(replaced.translation!.revision, update.id);
  assert.equal(replaced.deletedPages[0].annotations.length, 1);
  assert.equal(replaced.translation!.pages[0].annotations.length, 0);
  assert.equal(replaced.translation!.pages[1].id, root.translation!.pages[1].id);
  const result = translatedBinding(replaced, root.pages[0].id); assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') assert.notEqual(result.binding.pageId, root.translation!.pages[0].id);
  const late: PageEditBatch = { ...ink, id: crypto.randomUUID(), parents: [ink.id], expected: pageExpectation(annotated.translation!.pages[0]),
    changes: [{ type: 'delete', id: ink.changes[0].type === 'create' ? ink.changes[0].annotation.id : '' }] };
  const graph = new EditGraph({ version: 1, libraryId: scope.libraryId, root, batches: [update, late, ink] });
  assert.deepEqual(graph.getView().heads, [late.id, update.id].sort());
  assert.throws(() => applyBatch(replaced, { ...late, id: crypto.randomUUID(), parents: [update.id] }), /stale-page/);
  const remove: DocumentEditBatch = { kind: 'document', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: root.id,
    parents: [update.id], changes: [{ type: 'remove', expected: pageExpectation(replaced.translation!.pages[0]) }] };
  const removed = document(applyBatch(replaced, remove));
  assert.deepEqual(translatedBinding(removed, root.pages[0].id), { status: 'unresolved', reason: 'target-deleted' });
});

test('mapping replacement cannot rebind a live page or overwrite its existing annotation', () => {
  const annotated = document(applyBatch(root, ink)), altered = structuredClone(update);
  const change = altered.changes[0]; assert.equal(change.type, 'translation');
  if (change.type !== 'translation') assert.fail();
  change.translation!.pages[0] = structuredClone(root.translation!.pages[0]);
  assert.throws(() => applyBatch(annotated, altered), /translation-page-reused/);
  change.expectedRevision = crypto.randomUUID();
  assert.throws(() => applyBatch(annotated, altered), /stale-translation/);
  assert.deepEqual(snapshotResourceIds(root), [fixture.resource.metadata.id]);
  assert.deepEqual(batchResourceIds(update), [fixture.resource.metadata.id]);
});

test('both surface collections retain their own page limit and bootstrap with validated PDF dimensions', async () => {
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  const bytes = new Uint8Array(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
  await repository.storeResource({ ...fixture.resource.metadata, bytes });
  await repository.initialize(root);
  assert.equal((await repository.commit(ink)).status, 'durable');
  assert.equal((await repository.commit(update)).status, 'durable');
  const graph = new EditGraph((await repository.read(root.id)).checkpoint);
  assert.equal((graph.snapshot(update.id) as DocumentSnapshot).translation!.pages.length, 2);
  const full = structuredClone(root);
  full.pages = Array.from({ length: 500 }, () => ({ ...structuredClone(root.pages[0]), id: crypto.randomUUID() }));
  full.translation!.bindings = [];
  full.translation!.pages = Array.from({ length: 500 }, () => ({ ...structuredClone(root.translation!.pages[0]), id: crypto.randomUUID() }));
  assertSnapshot(full);
  full.translation!.pages.push({ ...full.translation!.pages[0], id: crypto.randomUUID() });
  assert.throws(() => assertSnapshot(full));
});
