import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditBatch, LibraryEditBatch, LibrarySnapshot, ResolutionBatch } from '../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../src/runtime/edits/editGraph.ts';
import { applyBatch, assertSnapshot, EditRejected } from '../../src/runtime/edits/editModel.ts';
import { moveLibraryFolder } from '../../src/features/library/canonicalLibraryOperations.ts';

// B13-e (plan regression R26, second half): two hosts concurrently move folder A into B and folder B into A.
// The graph never merges competing heads (no receiving-order winner), so neither head can contain a cycle and the pair stays a conflict.
// The only multi-parent batch is a resolution; one that carries a folder cycle is refused by the model (`assertLibrary`, folder-cycle).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIB = id(1), ROOT_VERSION = id(2), A = id(10), B = id(11), A1 = id(12), C = id(13), NOTE_A = id(20), NOTE_B = id(21);
const X = id(101), Y = id(102);

const item = (itemId: string, title: string, folderId: string | null): LibrarySnapshot['items'][number] =>
  ({ id: itemId, kind: 'markdown', title, ownerId: null, folderId, position: 0, tags: [], read: false, metadata: {} });
const base = (): LibrarySnapshot => ({ kind: 'library', id: LIB, version: ROOT_VERSION,
  folders: [{ id: A, title: 'A', parentId: null, position: 0 }, { id: B, title: 'B', parentId: null, position: 1 },
    { id: A1, title: 'A child', parentId: A, position: 0 }, { id: C, title: 'C', parentId: null, position: 2 }],
  items: [item(NOTE_A, 'note in A', A), item(NOTE_B, 'note in B', B)], links: [], deletions: [] });
const batch = (batchId: string, parents: string[], changes: LibraryEditBatch['changes']): LibraryEditBatch =>
  ({ kind: 'library', id: batchId, libraryId: LIB, targetId: LIB, parents, changes });
/** The real product operation (the same function the folder-move UI uses), applied to the base catalog. */
const move = (batchId: string, snapshot: LibrarySnapshot, folderId: string, parentId: string | null) =>
  batch(batchId, [snapshot.version], moveLibraryFolder(snapshot, folderId, parentId));
const graph = () => new EditGraph({ version: 1, libraryId: LIB, root: base(), batches: [] });
const library = (value: ReturnType<EditGraph['snapshot']>): LibrarySnapshot => { assert.ok(value?.kind === 'library'); return value; };
/** Independent walker (not the model's): a catalog is acyclic when every folder reaches the top within folders.length steps. */
const acyclic = (value: LibrarySnapshot) => value.folders.every(folder => {
  let at: string | null = folder.parentId, steps = 0;
  while (at !== null) { if (++steps > value.folders.length) return false; at = value.folders.find(other => other.id === at)?.parentId ?? null; }
  return true;
});
const parents = (value: LibrarySnapshot) => Object.fromEntries(value.folders.map(folder => [folder.id, folder.parentId]).sort());
const placements = (value: LibrarySnapshot) => Object.fromEntries(value.items.map(entry => [entry.id, entry.folderId]).sort());

const x = move(X, base(), A, B), y = move(Y, base(), B, A);

test('each single-host move of A into B and of B into A is a valid, acyclic catalog on its own', () => {
  assert.equal(x.changes.length, 1); assert.equal(y.changes.length, 1);
  const left = library(graph().snapshot(ROOT_VERSION)); // the base itself
  assert.ok(acyclic(left));
  const g = graph(); g.receive([x, y]);
  const atX = library(g.snapshot(X)), atY = library(g.snapshot(Y));
  assert.deepEqual(parents(atX), { [A]: B, [B]: null, [A1]: A, [C]: null });
  assert.deepEqual(parents(atY), { [A]: null, [B]: A, [A1]: A, [C]: null });
  assert.ok(acyclic(atX) && acyclic(atY));
  assert.deepEqual(placements(atX), { [NOTE_A]: A, [NOTE_B]: B }); assert.deepEqual(placements(atY), { [NOTE_A]: A, [NOTE_B]: B });
});

test('concurrent A-into-B and B-into-A stay two heads in every delivery order; nothing is merged, rejected or waiting', () => {
  for (const order of [[[x], [y]], [[y], [x]], [[x, y]], [[y, x]], [[x], [y], [x, y], [y]]]) {
    const g = graph();
    for (const arrival of order) g.receive(arrival);
    assert.deepEqual(g.getView(), { heads: [X, Y], waiting: [], rejected: {} }, JSON.stringify(order.map(list => list.map(value => value.id))));
    assert.ok(acyclic(library(g.snapshot(X))) && acyclic(library(g.snapshot(Y))));
    // no third version exists: the checkpoint holds exactly the two competing batches
    assert.deepEqual(g.checkpoint().batches.map(value => value.id).sort(), [X, Y]);
    const again = new EditGraph(g.checkpoint());
    assert.deepEqual(again.getView(), g.getView());
    assert.deepEqual(parents(library(again.snapshot(X))), { [A]: B, [B]: null, [A1]: A, [C]: null });
  }
});

test('a resolution that merges both moves is a folder cycle: the model refuses it and the pair stays a conflict', () => {
  const merged: LibrarySnapshot = { ...base(), version: id(900), folders: base().folders.map(folder =>
    folder.id === A ? { ...folder, parentId: B } : folder.id === B ? { ...folder, parentId: A } : folder) };
  assert.equal(acyclic(merged), false, 'the independent walker agrees that the union is cyclic');
  assert.throws(() => assertSnapshot(merged), error => error instanceof EditRejected && error.message === 'folder-cycle');
  const resolution: ResolutionBatch = { kind: 'resolution', id: id(900), libraryId: LIB, targetId: LIB, parents: [X, Y], snapshot: merged };
  assert.throws(() => applyBatch(library(graph().snapshot(ROOT_VERSION)), resolution), /wrong-parent/); // base is not a parent of the resolution
  const atX = (() => { const g = graph(); g.receive([x, y]); return library(g.snapshot(X)); })();
  assert.throws(() => applyBatch(atX, resolution), error => error instanceof EditRejected && error.message === 'folder-cycle');
  for (const order of [[x, y, resolution], [resolution, y, x]] as EditBatch[][]) {
    const g = graph();
    g.receive(order); // receiving never throws for an unacceptable resolution: it is recorded as rejected and the heads are untouched
    assert.deepEqual(g.getView(), { heads: [X, Y], waiting: [], rejected: { [id(900)]: 'folder-cycle' } });
  }
  // a batch that descends from the refused resolution is refused with it; the conflict is still intact
  const child = batch(id(901), [id(900)], [{ type: 'put-folder', folder: { id: C, title: 'C renamed', parentId: null, position: 2 } }]);
  const g = graph(); g.receive([x, y, resolution, child]);
  assert.deepEqual(g.getView(), { heads: [X, Y], waiting: [], rejected: { [id(900)]: 'folder-cycle', [id(901)]: 'rejected-parent' } });
});

test('a host that already holds one move cannot make the other: the product operation and the model both refuse the cycle', () => {
  const g = graph(); g.receive([x]);
  const atX = library(g.snapshot(X));
  assert.throws(() => moveLibraryFolder(atX, B, A), error => error instanceof EditRejected && error.message === 'library-folder-cycle');
  // the same move forced in by hand (not through the product operation): a successor of X that puts B under A
  const forced = batch(id(103), [X], [{ type: 'put-folder', folder: { id: B, title: 'B', parentId: A, position: 5 } }]);
  assert.throws(() => applyBatch(atX, forced), error => error instanceof EditRejected && error.message === 'folder-cycle');
  g.receive([forced, y]);
  assert.deepEqual(g.getView(), { heads: [X, Y], waiting: [], rejected: { [id(103)]: 'folder-cycle' } });
});

test('adopting either competing head resolves the conflict without a cycle and without losing an item or folder', () => {
  const adopt = (chosen: string, resolutionId: string) => {
    const g = graph(); g.receive([x, y]);
    const selected = library(g.snapshot(chosen));
    const resolution: ResolutionBatch = { kind: 'resolution', id: resolutionId, libraryId: LIB, targetId: LIB, parents: [X, Y], snapshot: { ...selected, version: resolutionId } };
    g.assertLocal(resolution); g.receive([resolution]);
    return { g, resolved: library(g.snapshot(resolutionId)), selected };
  };
  const fromX = adopt(X, id(910)), fromY = adopt(Y, id(911));
  for (const { g, resolved, selected } of [fromX, fromY]) {
    assert.deepEqual(g.getView().heads, [resolved.version]); assert.deepEqual(g.getView().rejected, {});
    assert.deepEqual({ ...resolved, version: '' }, { ...selected, version: '' });
    assert.ok(acyclic(resolved));
    assert.deepEqual(resolved.folders.map(folder => folder.id).sort(), [A, B, A1, C].sort());
    assert.deepEqual(resolved.items.map(entry => entry.id).sort(), [NOTE_A, NOTE_B].sort());
    assert.deepEqual(placements(resolved), { [NOTE_A]: A, [NOTE_B]: B });
    assert.deepEqual(g.checkpoint().batches.map(value => value.id).sort(), [X, Y, resolved.version].sort(), 'both competing branches stay in the graph');
  }
  assert.deepEqual(parents(fromX.resolved), { [A]: B, [B]: null, [A1]: A, [C]: null });
  assert.deepEqual(parents(fromY.resolved), { [A]: null, [B]: A, [A1]: A, [C]: null });
  // after adopting one head the cycle is still impossible for the next local move
  assert.throws(() => moveLibraryFolder(fromX.resolved, B, A), /library-folder-cycle/);
  assert.throws(() => moveLibraryFolder(fromY.resolved, A, B), /library-folder-cycle/);
});
