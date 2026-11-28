import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditBatch, LibraryEditBatch, LibraryItem, LibrarySnapshot } from '../../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { canonicalLibraryRows } from '../../../src/features/library/tree/canonicalLibraryTree.ts';
import { reorderLibraryEntry } from '../../../src/features/library/tree/canonicalLibraryReorder.ts';
import { assertLibraryEdit, inverseLibraryEdit } from '../../../src/features/library/libraryHistory.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, folderId: string | null, position: number, ownerId: string | null = null): LibraryItem =>
  ({ id: id(n), kind: 'markdown', title: `note-${n}`, folderId, ownerId, position, tags: ['keep'], read: true, metadata: { custom: 'keep' } });
function setup() {
  const root: LibrarySnapshot = { kind: 'library', id: id(1), version: id(2), items: [item(3, null, 0), item(4, id(10), 0), item(5, null, 2), item(6, null, 0, id(3))],
    folders: [{ id: id(10), title: 'parent', parentId: null, position: 1 }, { id: id(11), title: 'child', parentId: id(10), position: 1 }], links: [], deletions: [] };
  const batches = new Map<string, EditBatch>(), snapshots = new Map([[root.version, root]]);
  const versions = { batch: (key: string) => batches.get(key), snapshot: (key: string) => snapshots.get(key) };
  const apply = (before: LibrarySnapshot, batch: LibraryEditBatch) => {
    const after = applyBatch(before, batch) as LibrarySnapshot; batches.set(batch.id, batch); snapshots.set(after.version, after); return after;
  };
  return { root, versions, apply };
}
test('mixed folder/item reordering and hierarchical move have exact reversible placement, retaining owned children and metadata', () => {
  const h = setup(), original = structuredClone(h.root);
  const batch: LibraryEditBatch = { kind: 'library', id: id(20), libraryId: id(1), targetId: id(1), parents: [id(2)],
    changes: reorderLibraryEntry(h.root, { kind: 'item', id: id(5) }, { kind: 'folder', id: id(11) }, 'before') };
  const after = h.apply(h.root, batch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, batch.id));
  const rows = canonicalLibraryRows({ items: after.items, folders: after.folders, expanded: new Set([`folder:${id(10)}`]) });
  assert.deepEqual(rows.filter(row => row.parentKey === `folder:${id(10)}`).map(row => row.id), [id(4), id(5), id(11)]);
  assert.deepEqual(after.items.find(value => value.id === id(5))!.metadata, { custom: 'keep' });
  assert.deepEqual(after.items.find(value => value.id === id(6)), original.items.find(value => value.id === id(6)));
  const undo = inverseLibraryEdit(h.versions, batch.id, after, id(21)), undone = h.apply(after, undo);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, undo.id, true));
  assert.deepEqual({ ...undone, version: original.version }, original);
  const redone = h.apply(undone, inverseLibraryEdit(h.versions, undo.id, undone, id(22)));
  assert.deepEqual({ ...redone, version: after.version }, after);
  assert.deepEqual(h.root, original);
});
test('same-parent mixed reordering is a supported history edit; Undo preserves unrelated title changes and rejects diverged placement', () => {
  const h = setup();
  const batch: LibraryEditBatch = { kind: 'library', id: id(20), libraryId: id(1), targetId: id(1), parents: [id(2)],
    changes: reorderLibraryEntry(h.root, { kind: 'folder', id: id(10) }, { kind: 'item', id: id(3) }, 'before') };
  const after = h.apply(h.root, batch); assert.doesNotThrow(() => assertLibraryEdit(h.versions, batch.id));
  const current = structuredClone(after); current.items[0].title = 'renamed independently';
  const undone = applyBatch(current, inverseLibraryEdit(h.versions, batch.id, current, id(21))) as LibrarySnapshot;
  assert.equal(undone.items[0].title, 'renamed independently');
  assert.equal(undone.folders[0].position, h.root.folders[0].position);
  current.folders[0].position = 99;
  assert.throws(() => inverseLibraryEdit(h.versions, batch.id, current, id(22)), /library-history-diverged/);
});
test('reorder admission rejects cycles, owned/deleted/template entries and invalid targets without mutating catalog', () => {
  const h = setup(), before = structuredClone(h.root);
  assert.throws(() => reorderLibraryEntry(h.root, { kind: 'folder', id: id(10) }, { kind: 'folder', id: id(11) }, 'inside'), /library-folder-cycle/);
  assert.throws(() => reorderLibraryEntry(h.root, { kind: 'item', id: id(6) }, null, 'inside'), /library-owned-item-move/);
  assert.throws(() => reorderLibraryEntry(h.root, { kind: 'item', id: id(3) }, { kind: 'item', id: id(5) }, 'inside'), /library-tree-placement/);
  assert.deepEqual(h.root, before);
  h.root.deletions = [{ id: id(30), itemIds: [id(3)], observed: [], active: true }];
  assert.throws(() => reorderLibraryEntry(h.root, { kind: 'item', id: id(3) }, null, 'inside'), /library-item-unavailable/);
  h.root.deletions = [];
  h.root.items[0].metadata = { 'papeer.note-template': 'v1' };
  assert.throws(() => reorderLibraryEntry(h.root, { kind: 'item', id: id(3) }, null, 'inside'), /library-item-unavailable/);
});
test('history refuses reorder-shaped title/metadata mutation and independent sibling groups', () => {
  for (const mode of ['metadata', 'groups'] as const) {
    const h = setup();
    const batch: LibraryEditBatch = { kind: 'library', id: id(20), libraryId: id(1), targetId: id(1), parents: [id(2)], changes: mode === 'metadata'
      ? [{ type: 'put-item', item: { ...h.root.items[0], position: 7, metadata: { injected: 'yes' } } }]
      : [{ type: 'put-item', item: { ...h.root.items[0], position: 7 } }, { type: 'put-item', item: { ...h.root.items[1], position: 8 } }] };
    h.apply(h.root, batch); assert.throws(() => assertLibraryEdit(h.versions, batch.id));
  }
});
