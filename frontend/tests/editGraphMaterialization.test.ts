import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { applyBatch } from '../src/runtime/edits/editModel.ts';
import type { DocumentSnapshot, PageEditBatch, Snapshot } from '../src/runtime/edits/contracts.ts';
import { editGraphHistoryFixture, graphFixtureId as id } from './support/editGraphHistoryFixture.ts';

test('cumulative page history retains bounded materializations and reconstructs every evicted version', () => {
  const fixture = editGraphHistoryFixture(320), graph = new EditGraph(fixture);
  // Retained page arrays, not the mandatory batch journal, must be independent of history length.
  const cache = (graph as unknown as { states: { cache: Map<string, Snapshot> } }).states.cache;
  assert.ok(cache.size <= 16);
  assert.ok([...cache.values()].reduce((sum, state) => sum + (state.kind === 'document' ? state.pages[0].annotations.length : 0), 0) <= 16 * 320);
  for (const index of [0, 79, 159, 319, 2, 318]) {
    const snapshot = graph.snapshot(fixture.batches[index].id) as DocumentSnapshot;
    assert.equal(snapshot.pages[0].annotations.length, index + 1);
    snapshot.pages[0].annotations.length = 0;
    assert.equal((graph.snapshot(fixture.batches[index].id) as DocumentSnapshot).pages[0].annotations.length, index + 1);
    assert.ok(cache.size <= 16);
  }
  const restart = new EditGraph(graph.checkpoint());
  assert.deepEqual(restart.getView(), graph.getView());
  assert.deepEqual(restart.snapshot(fixture.batches[319].id), graph.snapshot(fixture.batches[319].id));
});

test('late branches, waiting descendants and resolution retain their parents after cache eviction', () => {
  const fixture = editGraphHistoryFixture(80), graph = new EditGraph(fixture);
  const branch = structuredClone(fixture.batches[3]); branch.id = id(8000);
  const child = structuredClone(fixture.batches[4]); child.id = id(8001); child.parents = [branch.id]; child.expected.annotationVersion = branch.id;
  graph.receive([child]); assert.deepEqual(graph.getView().waiting, [child.id]);
  graph.receive([branch]);
  assert.deepEqual(graph.getView().heads, [fixture.batches[79].id, child.id].sort());
  assert.equal((graph.snapshot(child.id) as DocumentSnapshot).pages[0].annotations.length, 5);
  assert.ok(graph.descendsFrom(child.id, fixture.batches[2].id));
  graph.assertLocal({ ...child, id: id(8002), parents: [fixture.batches[2].id] });
  const chosen = graph.snapshot(child.id)!; chosen.version = id(8003);
  graph.receive([{ kind: 'resolution', id: chosen.version, libraryId: fixture.libraryId, targetId: chosen.id,
    parents: graph.getView().heads, snapshot: chosen }]);
  const restarted = new EditGraph(graph.checkpoint());
  assert.deepEqual(restarted.snapshot(chosen.version), graph.snapshot(chosen.version));
  assert.ok(restarted.descendsFrom(chosen.version, fixture.batches[79].id));
});

test('owned validated deltas still reject semantic geometry, limits and externally mutated inputs', () => {
  const fixture = editGraphHistoryFixture(1), graph = new EditGraph(fixture);
  const original = graph.snapshot(fixture.batches[0].id);
  fixture.root.pages.length = 0; fixture.batches[0].changes.length = 0;
  const exported = graph.checkpoint(); exported.batches.length = 0;
  assert.deepEqual(graph.snapshot(id(1000)), original);
  const fresh = editGraphHistoryFixture(2), invalid = fresh.batches[1];
  const create = invalid.changes[0]; assert.equal(create.type, 'create');
  if (create.type !== 'create' || create.annotation.kind !== 'ink') throw Error('fixture');
  create.annotation.geometry = { kind: 'line', start: { x: 1, y: 1 }, end: { x: 1, y: 1 } };
  graph.receive([invalid]); assert.equal(graph.getView().rejected[invalid.id], 'degenerate-line');
  assert.deepEqual(graph.snapshot(id(1000)), original);

  const crowded = editGraphHistoryFixture(1), page = crowded.root.pages[0];
  page.annotations = Array.from({ length: 3000 }, (_, index) => ({ kind: 'sticky', id: id(200000 + index), text: '',
    anchor: { x: 1, y: 1 }, color: null, metadata: { label: '', createdAt: null } }));
  const full = new EditGraph(crowded);
  assert.equal(full.getView().rejected[crowded.batches[0].id], 'annotation-limit');
  assert.throws(() => applyBatch(crowded.root, crowded.batches[0]));
});

test('incremental receive and reverse delivery give identical materialized histories', () => {
  const fixture = editGraphHistoryFixture(80), graph = new EditGraph({ ...fixture, batches: [] });
  for (const batch of fixture.batches) graph.receive([batch]);
  const reversed = new EditGraph({ ...fixture, batches: [...fixture.batches].reverse() });
  for (const batch of [fixture.batches[0], fixture.batches[39], fixture.batches[79]] as PageEditBatch[]) {
    assert.deepEqual(reversed.snapshot(batch.id), graph.snapshot(batch.id));
  }
  assert.deepEqual(reversed.getView(), graph.getView());
});

test('local page validation enforces the cumulative point limit without revisiting old geometry', () => {
  const fixture = editGraphHistoryFixture(1), create = fixture.batches[0].changes[0];
  if (create.type !== 'create' || create.annotation.kind !== 'ink') throw Error('fixture');
  const template = create.annotation;
  fixture.root.pages[0].annotations = Array.from({ length: 10 }, (_, index) => ({ ...template, id: id(300000 + index),
    geometry: { kind: 'path' as const, points: Array.from({ length: 20000 }, (_, point) => ({ x: point, y: index })) } }));
  const graph = new EditGraph(fixture);
  assert.equal(graph.getView().rejected[fixture.batches[0].id], 'page-point-limit');
  assert.deepEqual(graph.getView().heads, [fixture.root.version]);
});
