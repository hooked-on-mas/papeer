import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditBatch, HistoryRecord, LibrarySnapshot, LibraryEditBatch } from '../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../src/runtime/edits/editModel.ts';
import {
  addLibraryLinks, canDropLibraryLinks, createLibraryFolder, deleteLibraryItems, detachLibraryNotes,
  libraryAppendPosition, libraryOwnedAppendPosition, moveLibraryFolder, moveLibraryItems, removeLibraryFolder,
  removeLibraryLinks, renameLibraryFolder, renameLibraryItem, restoreDeletedLibraryItems, setLibraryItemsRead,
  updateLibraryBibliography, updateLibraryTags,
} from '../../src/features/library/canonicalLibraryOperations.ts';
import { assertLibraryEdit, assertLibraryMetadataEdit, inverseLibraryEdit, restoreLibraryHistory } from '../../src/features/library/libraryHistory.ts';
import { canonicalLibraryRows } from '../../src/features/library/tree/canonicalLibraryTree.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
for (const kind of ['markdown', 'notebook', 'attachment'] as const) {
  test(`proven ${kind} publication supports logical creation Undo/Redo`, () => {
    const h = setup();
    const item = { ...h.root.items[0], id: id(90), kind, title: 'created', ownerId: kind === 'attachment' ? id(3) : null,
      ...(kind === 'attachment' ? { resourceId: id(91) } : {}) };
    const batch: LibraryEditBatch = { kind: 'library', id: id(92), libraryId: h.root.id, targetId: h.root.id,
      parents: [h.root.version], changes: [{ type: 'put-item', item }] };
    const after = h.apply(h.root, batch);
    const origin = { batchId: batch.id, itemId: item.id, kind, contentVersion: kind === 'attachment' ? null : id(93) };
    const versions = { ...h.versions, publicationOrigin: (key: string) => key === batch.id ? origin : undefined,
      contentVersion: (target: string, head: string) => target === item.id && [id(93), id(94)].includes(head) };
    assert.throws(() => assertLibraryEdit(h.versions, batch.id));
    assert.deepEqual(restoreLibraryHistory(h.versions, batch.id, h.records), { undo: [], redo: [] });
    assert.doesNotThrow(() => assertLibraryEdit(versions, batch.id));
    for (const invalid of [{ ...origin, batchId: id(99) }, { ...origin, itemId: id(99) },
      { ...origin, kind: 'pdf' as const }, { ...origin, contentVersion: kind === 'attachment' ? id(93) : null }]) {
      assert.throws(() => assertLibraryEdit({ ...versions, publicationOrigin: () => invalid }, batch.id));
    }
    const observed = kind === 'attachment' ? [] : [{ targetId: item.id, heads: [id(94)] }];
    if (kind !== 'attachment') assert.throws(() => inverseLibraryEdit(versions, batch.id, after, id(95)));
    assert.throws(() => inverseLibraryEdit(versions, batch.id, after, id(95), { observed: [{ targetId: item.id, heads: [id(99)] }] }));
    const undo = inverseLibraryEdit(versions, batch.id, after, id(95), { observed });
    const undone = h.apply(after, undo, { kind: 'undo', operationId: batch.id });
    assert.deepEqual(undone.items, after.items);
    assert.deepEqual(undone.deletions, [{ id: id(95), itemIds: [item.id], observed, active: true }]);
    assert.deepEqual(restoreLibraryHistory(versions, undone.version, h.records).redo, [{ operationId: batch.id, executionId: id(95) }]);
    const redone = h.apply(undone, inverseLibraryEdit(versions, id(95), undone, id(96)), { kind: 'redo', operationId: batch.id });
    assert.deepEqual(redone.items, after.items);
    assert.deepEqual(redone.deletions, [{ id: id(95), itemIds: [item.id], observed, active: false }]);
    assert.deepEqual(restoreLibraryHistory(versions, redone.version, h.records).undo, [{ operationId: batch.id, executionId: id(96) }]);
    const changed = structuredClone(after); changed.items[1].title = 'newer'; changed.items[1].tags = ['peer'];
    const preserved = applyBatch(changed, inverseLibraryEdit(versions, batch.id, changed, id(97), { observed })) as LibrarySnapshot;
    assert.deepEqual(preserved.items, changed.items);
    const child = structuredClone(after); child.items.push({ ...h.root.items[0], id: id(98), ownerId: item.id });
    assert.throws(() => inverseLibraryEdit(versions, batch.id, child, id(97), { observed }));
    const linked = structuredClone(after); linked.links.push({ pdfId: id(99), noteId: item.id });
    assert.throws(() => inverseLibraryEdit(versions, batch.id, linked, id(97), { observed }));
  });
}
function setup() {
  const root: LibrarySnapshot = { kind: 'library', id: id(1), version: id(2), items: [{ id: id(3), title: ' before ', kind: 'markdown', ownerId: null,
    folderId: null, position: 0, tags: [], read: false, metadata: {} }], folders: [], links: [], deletions: [] };
  const snapshots = new Map([[root.version, root]]), batches = new Map<string, EditBatch>(), records: HistoryRecord[] = [];
  const versions = { batch: (key: string) => batches.get(key), snapshot: (key: string) => snapshots.get(key) };
  const apply = (parent: LibrarySnapshot, batch: LibraryEditBatch, action?: HistoryRecord['action'], record = true) => {
    const next = applyBatch(parent, batch) as LibrarySnapshot; batches.set(batch.id, batch); snapshots.set(batch.id, next);
    if (record) records.push({ operationId: batch.id, beforeVersion: parent.version, afterVersion: batch.id, undoRequested: false, ...(action ? { action } : {}) });
    return next;
  };
  const rename = (parent: LibrarySnapshot, n: number, title: string, record = true) => apply(parent, { kind: 'library', id: id(n), libraryId: root.id,
    targetId: root.id, parents: [parent.version], changes: renameLibraryItem(parent, id(3), title) }, undefined, record);
  return { root, snapshots, batches, records, versions, apply, rename };
}

test('publication creation inverts its own link only and rejects unproven observed replay', () => {
  const h = setup(); h.root.items[0].kind = 'pdf';
  const item = { ...h.root.items[0], id: id(90), kind: 'markdown' as const };
  const link = { pdfId: id(3), noteId: item.id };
  const batch: LibraryEditBatch = { kind: 'library', id: id(91), libraryId: h.root.id, targetId: h.root.id,
    parents: [h.root.version], changes: [{ type: 'put-item', item }, { type: 'add-link', link }] };
  const after = h.apply(h.root, batch);
  const origin = { batchId: batch.id, itemId: item.id, kind: item.kind, contentVersion: id(92) };
  const versions = { ...h.versions, publicationOrigin: (key: string) => key === batch.id ? origin : undefined,
    contentVersion: (target: string, head: string) => target === item.id && head === id(93) };
  const observed = [{ targetId: item.id, heads: [id(93)] }];
  const undo = inverseLibraryEdit(versions, batch.id, after, id(94), { observed });
  const undone = h.apply(after, undo, { kind: 'undo', operationId: batch.id });
  assert.deepEqual(undone.links, []); assert.deepEqual(undone.items, after.items);
  const redone = h.apply(undone, inverseLibraryEdit(versions, undo.id, undone, id(95)), { kind: 'redo', operationId: batch.id });
  assert.deepEqual(redone.links, [link]);
  assert.equal(restoreLibraryHistory(versions, redone.version, h.records).undo.length, 1);
  assert.deepEqual(restoreLibraryHistory({ ...versions, contentVersion: () => false }, redone.version, h.records), { undo: [], redo: [] });
  assert.throws(() => inverseLibraryEdit({ ...versions, contentVersion: () => false }, batch.id, after, id(97), { observed }), /content-version-missing/);
  assert.equal(restoreLibraryHistory(versions, redone.version, h.records).undo.length, 1);
  const foreign = structuredClone(after); foreign.items.push({ ...h.root.items[0], id: id(96) });
  foreign.links.push({ pdfId: id(96), noteId: item.id });
  assert.throws(() => inverseLibraryEdit(versions, batch.id, foreign, id(97), { observed }));
});
test('rename checks live identity and expected title, trims input, and preserves detached metadata', () => {
  const { root } = setup(); root.items[0].metadata.author = 'A';
  const changes = renameLibraryItem(root, id(3), ' next ', ' before '); assert.equal(changes[0].type, 'put-item');
  if (changes[0].type === 'put-item') { assert.equal(changes[0].item.title, 'next'); changes[0].item.metadata.author = 'B'; }
  assert.equal(root.items[0].metadata.author, 'A');
  assert.throws(() => renameLibraryItem(root, id(3), 'next', 'stale'));
  assert.throws(() => renameLibraryItem(root, id(3), '  ')); assert.throws(() => renameLibraryItem(root, id(9), 'next'));
  const renamed = { ...root, items: [{ ...root.items[0], title: 'next' }] };
  assert.deepEqual(renameLibraryItem(renamed, id(3), ' next ', 'next'), []);
  assert.throws(() => renameLibraryItem(renamed, id(3), 'next', 'stale'));
  renamed.deletions = [{ id: id(8), itemIds: [id(3)], observed: [], active: true }];
  assert.throws(() => renameLibraryItem(renamed, id(3), 'next'));
});
test('finite inverse changes title only, preserves newer attributes and restores exact previous value', () => {
  const h = setup(), after = h.rename(h.root, 4, 'after');
  const current = structuredClone(after); current.items[0].tags = ['new']; current.items[0].read = true;
  const undo = inverseLibraryEdit(h.versions, id(4), current, id(5)); const restored = applyBatch(current, undo) as LibrarySnapshot;
  assert.equal(restored.items[0].title, ' before '); assert.deepEqual(restored.items[0].tags, ['new']); assert.equal(restored.items[0].read, true);
  current.items[0].title = 'peer'; assert.throws(() => inverseLibraryEdit(h.versions, id(4), current, id(6)));
  current.items[0].title = 'after'; current.deletions = [{ id: id(8), itemIds: [id(3)], observed: [], active: true }];
  assert.throws(() => inverseLibraryEdit(h.versions, id(4), current, id(6)));
});
test('Undo/Redo restores operation identity and bounded ancestry; missing metadata is a boundary', () => {
  const h = setup(), after = h.rename(h.root, 4, 'after');
  const undone = h.apply(after, inverseLibraryEdit(h.versions, id(4), after, id(5)), { kind: 'undo', operationId: id(4) });
  assert.deepEqual(restoreLibraryHistory(h.versions, undone.version, h.records), { undo: [], redo: [{ operationId: id(4), executionId: id(5) }] });
  const redone = h.apply(undone, inverseLibraryEdit(h.versions, id(5), undone, id(6)), { kind: 'redo', operationId: id(4) });
  assert.deepEqual(restoreLibraryHistory(h.versions, redone.version, h.records).undo, [{ operationId: id(4), executionId: id(6) }]);
  assert.deepEqual(restoreLibraryHistory(h.versions, redone.version, h.records.slice(1)), { undo: [], redo: [] });
  let current = h.rename(redone, 7, 'remote', false); current = h.rename(current, 8, 'local');
  assert.deepEqual(restoreLibraryHistory(h.versions, current.version, h.records).undo, [{ operationId: id(8), executionId: id(8) }]);
  for (let n = 20; n < 80; n++) current = h.rename(current, n, String(n));
  assert.equal(restoreLibraryHistory(h.versions, current.version, h.records).undo.length, 50);
});
test('unsupported changes cannot be inverted or bridge history', () => {
  const h = setup(), after = h.rename(h.root, 4, 'after');
  assert.doesNotThrow(() => assertLibraryMetadataEdit(h.versions, id(4)));
  const batch: LibraryEditBatch = { kind: 'library', id: id(5), libraryId: h.root.id, targetId: h.root.id, parents: [after.version], changes: [
    { type: 'put-item', item: { ...after.items[0], title: 'mixed', metadata: { changed: 'protected' } } }] };
  const mixed = h.apply(after, batch); assert.throws(() => inverseLibraryEdit(h.versions, batch.id, mixed, id(6)));
  assert.throws(() => assertLibraryMetadataEdit(h.versions, batch.id));
  assert.deepEqual(restoreLibraryHistory(h.versions, mixed.version, h.records), { undo: [], redo: [] });
});

test('resolution stops ancestry and action metadata cannot disguise an unrelated rename as Undo', () => {
  const h = setup(), after = h.rename(h.root, 4, 'after');
  const wrong: LibraryEditBatch = { kind: 'library', id: id(5), libraryId: h.root.id, targetId: h.root.id,
    parents: [after.version], changes: renameLibraryItem(after, id(3), 'unrelated') };
  h.apply(after, wrong, { kind: 'undo', operationId: id(4) });
  assert.throws(() => restoreLibraryHistory(h.versions, id(5), h.records), /action-mismatch/);
  const merged = { ...after, version: id(6) };
  h.snapshots.set(id(6), merged);
  h.batches.set(id(6), { kind: 'resolution', id: id(6), libraryId: h.root.id, targetId: h.root.id,
    parents: [after.version, id(5)], snapshot: merged });
  const next = h.rename(merged, 7, 'post-merge');
  assert.deepEqual(restoreLibraryHistory(h.versions, next.version, h.records), {
    undo: [{ operationId: id(7), executionId: id(7) }], redo: [],
  });
});

test('bulk tags normalize only new input, remove exact old strings, dedupe IDs and validate every target', () => {
  const { root } = setup();
  root.items[0].tags = [' old ', 'first']; root.items.push({ ...structuredClone(root.items[0]), id: id(9), tags: [] });
  const added = updateLibraryTags(root, [id(3), id(3), id(9)], { mode: 'add', tags: ['\u001cnew\u0085', 'new', ' first '] });
  assert.equal(added.length, 2);
  if (added[0].type === 'put-item') assert.deepEqual(added[0].item.tags, [' old ', 'first', 'new']);
  const removed = updateLibraryTags(root, [id(3)], { mode: 'remove', tags: ['old'] }); assert.deepEqual(removed, []);
  const exact = updateLibraryTags(root, [id(3)], { mode: 'remove', tags: [' old '] });
  if (exact[0].type === 'put-item') assert.deepEqual(exact[0].item.tags, ['first']);
  assert.throws(() => updateLibraryTags(root, [id(3), id(99)], { mode: 'add', tags: ['new'] }));
  assert.throws(() => setLibraryItemsRead(root, [id(3), id(99)], true));
  assert.deepEqual(root.items[0].tags, [' old ', 'first']);
  assert.throws(() => updateLibraryTags(root, [id(3)], { mode: 'add', tags: ['\u0085'] }));
  assert.throws(() => updateLibraryTags(root, [id(3)], { mode: 'add', tags: ['x'.repeat(201)] }));
  assert.equal(updateLibraryTags(root, [id(3)], { mode: 'add', tags: ['😀'.repeat(200)] }).length, 1);
  assert.throws(() => updateLibraryTags(root, [id(3)], { mode: 'replace', tags: [], expectedTags: { [id(3)]: ['first', ' old '] } }));
  const replaced = updateLibraryTags(root, [id(3)], { mode: 'replace', tags: [' fresh ', 'fresh'], expectedTags: { [id(3)]: [' old ', 'first'] } });
  if (replaced[0].type === 'put-item') assert.deepEqual(replaced[0].item.tags, ['fresh']);
  assert.deepEqual(setLibraryItemsRead(root, [id(3), id(9)], false), []);
  root.deletions.push({ id: id(10), itemIds: [id(9)], observed: [], active: true });
  assert.throws(() => setLibraryItemsRead(root, [id(3), id(9)], true));
});

test('bulk metadata is one history operation, restores ordered tags exactly and preserves unrelated current fields', () => {
  const h = setup(); h.root.items[0].tags = ['z', ' old ', 'a'];
  h.root.items.push({ ...structuredClone(h.root.items[0]), id: id(9), tags: [] });
  const changes = updateLibraryTags(h.root, [id(3), id(9)], { mode: 'replace', tags: ['new'], expectedTags: { [id(3)]: ['z', ' old ', 'a'], [id(9)]: [] } });
  const batch: LibraryEditBatch = { kind: 'library', id: id(4), libraryId: h.root.id, targetId: h.root.id, parents: [h.root.version], changes };
  const after = h.apply(h.root, batch);
  assert.doesNotThrow(() => assertLibraryMetadataEdit(h.versions, batch.id));
  const current = structuredClone(after); current.items[0].title = 'peer title'; current.items[0].read = true; current.items[1].metadata.note = 'keep';
  const undo = inverseLibraryEdit(h.versions, batch.id, current, id(5));
  const restored = applyBatch(current, undo) as LibrarySnapshot;
  assert.deepEqual(restored.items[0].tags, ['z', ' old ', 'a']); assert.deepEqual(restored.items[1].tags, []);
  assert.equal(restored.items[0].title, 'peer title'); assert.equal(restored.items[0].read, true); assert.equal(restored.items[1].metadata.note, 'keep');
  assert.equal(restoreLibraryHistory(h.versions, after.version, h.records).undo.length, 1);
  current.items[1].tags.push('conflict'); assert.throws(() => inverseLibraryEdit(h.versions, batch.id, current, id(6)));
  const readBatch: LibraryEditBatch = { ...batch, id: id(7), parents: [after.version], changes: setLibraryItemsRead(after, [id(3), id(9)], true) };
  const read = h.apply(after, readBatch);
  const readUndo = inverseLibraryEdit(h.versions, id(7), read, id(8));
  assert.ok((applyBatch(read, readUndo) as LibrarySnapshot).items.every(item => !item.read));
});

test('a mixed bulk request cannot hide protected metadata changes in another item', () => {
  for (const patch of [{ position: 3 }, { metadata: { unexpected: 'value' } }, { resourceId: id(90) }, { ownerId: id(3) }]) {
    const h = setup(); h.root.items.push({ ...structuredClone(h.root.items[0]), id: id(9) });
    const after = { ...structuredClone(h.root), version: id(4) };
    after.items[0].read = true; after.items[1] = { ...after.items[1], tags: ['new'], ...patch };
    const batch: LibraryEditBatch = { kind: 'library', id: after.version, libraryId: h.root.id, targetId: h.root.id,
      parents: [h.root.version], changes: after.items.map(item => ({ type: 'put-item', item })) };
    h.batches.set(batch.id, batch); h.snapshots.set(batch.id, after);
    assert.throws(() => assertLibraryMetadataEdit(h.versions, batch.id));
    assert.throws(() => inverseLibraryEdit(h.versions, batch.id, after, id(5)));
  }
});

test('unchanged raw tag replacement preserves whitespace only after every expected value matches', () => {
  const { root } = setup();
  const raw = [' old ', 'line\nbreak', '\u0085']; root.items[0].tags = [...raw];
  root.items.push({ ...structuredClone(root.items[0]), id: id(9) });
  const expectedTags = { [id(3)]: [...raw], [id(9)]: [...raw] };
  const before = structuredClone(root);
  assert.deepEqual(updateLibraryTags(root, [id(3), id(9)], { mode: 'replace', tags: raw, expectedTags }), []);
  assert.deepEqual(root, before);
  root.items[1].tags = ['remote'];
  assert.throws(() => updateLibraryTags(root, [id(3), id(9)], { mode: 'replace', tags: raw, expectedTags }), /library-tags-changed/);
  assert.throws(() => updateLibraryTags(root, [id(3)], { mode: 'replace', tags: raw, expectedTags: {} }), /library-tags-changed/);
});

test('folder builders validate cycles, ownership, missing targets and finite sibling positions', () => {
  const { root } = setup();
  root.folders = [{ id: id(10), title: 'parent', parentId: null, position: 4 }, { id: id(11), title: 'child', parentId: id(10), position: 0 }];
  const creation = createLibraryFolder(root, id(12), ' new ', null);
  if (creation[0].type === 'put-folder') assert.deepEqual(creation[0].folder, { id: id(12), title: 'new', parentId: null, position: 5 });
  assert.throws(() => createLibraryFolder(root, id(12), 'new', id(99)));
  assert.throws(() => createLibraryFolder(root, id(10), 'duplicate', null));
  assert.throws(() => moveLibraryFolder(root, id(10), id(11))); assert.throws(() => moveLibraryFolder(root, id(10), id(10)));
  assert.deepEqual(moveLibraryFolder(root, id(11), id(10)), []);
  assert.deepEqual(renameLibraryFolder(root, id(10), 'parent', 'parent'), []);
  assert.throws(() => renameLibraryFolder(root, id(10), 'new', 'stale'));
  assert.equal(moveLibraryItems(root, [id(3), id(3)], id(10)).length, 1);
  root.items[0].ownerId = id(90); assert.throws(() => moveLibraryItems(root, [id(3)], id(10)));
  root.folders[0].position = Number.MAX_VALUE;
  assert.throws(() => createLibraryFolder(root, id(12), 'new', null));
});

test('folder removal promotes only direct references including deleted items, and Undo/Redo preserves content', () => {
  const h = setup();
  h.root.folders = [{ id: id(10), title: 'parent', parentId: null, position: 0 },
    { id: id(11), title: 'remove', parentId: id(10), position: 2 }, { id: id(12), title: 'child', parentId: id(11), position: 3 },
    { id: id(13), title: 'grandchild', parentId: id(12), position: 4 }];
  h.root.items[0].folderId = id(11);
  h.root.items.push({ ...structuredClone(h.root.items[0]), id: id(9), folderId: id(12) });
  h.root.deletions = [{ id: id(90), itemIds: [id(3)], active: true, observed: [{ targetId: id(3), heads: [id(91)] }] }];
  const batch: LibraryEditBatch = { kind: 'library', id: id(20), libraryId: h.root.id, targetId: h.root.id, parents: [h.root.version], changes: removeLibraryFolder(h.root, id(11)) };
  const after = h.apply(h.root, batch); assert.doesNotThrow(() => assertLibraryEdit(h.versions, batch.id));
  assert.equal(after.items[0].folderId, id(10)); assert.equal(after.items[1].folderId, id(12));
  assert.equal(after.folders.find(value => value.id === id(12))!.parentId, id(10));
  assert.deepEqual(after.folders.find(value => value.id === id(13)), h.root.folders[3]);
  const current = structuredClone(after); current.items[0].tags = ['later'];
  const preserving = applyBatch(current, inverseLibraryEdit(h.versions, batch.id, current, id(25))) as LibrarySnapshot;
  assert.deepEqual(preserving.items[0].tags, ['later']);
  const undo = inverseLibraryEdit(h.versions, batch.id, after, id(21));
  const restored = h.apply(after, undo, { kind: 'undo', operationId: batch.id });
  assert.equal(restored.items[0].folderId, id(11));
  assert.deepEqual(restored.folders.find(value => value.id === id(11)), h.root.folders[1]);
  assert.throws(() => assertLibraryEdit(h.versions, undo.id));
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, undo.id, true));
  const redo = inverseLibraryEdit(h.versions, undo.id, restored, id(22));
  assert.equal((applyBatch(restored, redo) as LibrarySnapshot).items[0].folderId, id(10));
  current.items[0].folderId = null; assert.throws(() => inverseLibraryEdit(h.versions, batch.id, current, id(23)));
});

test('folder creation Undo rejects new references; move and rename inverses preserve unrelated attributes', () => {
  const h = setup();
  const batch: LibraryEditBatch = { kind: 'library', id: id(20), libraryId: h.root.id, targetId: h.root.id, parents: [h.root.version], changes: createLibraryFolder(h.root, id(10), 'folder', null) };
  const after = h.apply(h.root, batch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, batch.id));
  assert.equal((applyBatch(after, inverseLibraryEdit(h.versions, batch.id, after, id(21))) as LibrarySnapshot).folders.length, 0);
  const referenced = structuredClone(after); referenced.items[0].folderId = id(10);
  assert.throws(() => inverseLibraryEdit(h.versions, batch.id, referenced, id(21)));
  const movedBatch: LibraryEditBatch = { ...batch, id: id(22), parents: [after.version], changes: moveLibraryItems(after, [id(3)], id(10)) };
  const moved = h.apply(after, movedBatch), current = structuredClone(moved); current.items[0].title = 'new title';
  const undo = inverseLibraryEdit(h.versions, movedBatch.id, current, id(23));
  const restored = applyBatch(current, undo) as LibrarySnapshot;
  assert.equal(restored.items[0].folderId, null); assert.equal(restored.items[0].title, 'new title');
});

test('promote deletion preserves mixed visible ordering after item move-back, across Undo and Redo', () => {
  const h = setup();
  h.root.folders = [{ id: id(10), title: 'remove', parentId: null, position: 0 },
    { id: id(11), title: 'first child', parentId: id(10), position: 0 },
    { id: id(12), title: 'middle child', parentId: id(10), position: 2 },
    { id: id(13), title: 'parent sibling', parentId: null, position: 20 }];
  h.root.items[0].folderId = id(10); h.root.items[0].position = 0;
  h.root.items.push({ ...structuredClone(h.root.items[0]), id: id(9), position: 1 });
  const command = (parent: LibrarySnapshot, n: number, changes: LibraryEditBatch['changes']) => ({ kind: 'library' as const,
    id: id(n), libraryId: h.root.id, targetId: h.root.id, parents: [parent.version], changes });
  const away = h.apply(h.root, command(h.root, 20, moveLibraryItems(h.root, [id(3)], null)));
  const returned = h.apply(away, command(away, 21, moveLibraryItems(away, [id(3)], id(10))));
  // Storage keeps A before B, but visible ordering after the move-back is folder11, B, folder12, A.
  assert.equal(returned.items[0].id, id(3));
  const rows = (snapshot: LibrarySnapshot) => canonicalLibraryRows({ items: snapshot.items, folders: snapshot.folders,
    expanded: new Set([`folder:${id(10)}`]) });
  const expected = rows(returned).filter(row => row.parentKey === `folder:${id(10)}`).map(row => row.key);
  const deletion = command(returned, 22, removeLibraryFolder(returned, id(10)));
  const after = h.apply(returned, deletion);
  assert.deepEqual(rows(after).filter(row => row.id !== id(13)).map(row => row.key), expected);
  assert.ok([...after.items, ...after.folders.filter(value => value.id !== id(13))].every(value => value.position > 20));
  const undo = inverseLibraryEdit(h.versions, deletion.id, after, id(23));
  const restored = h.apply(after, undo, { kind: 'undo', operationId: deletion.id });
  assert.deepEqual(rows(restored), rows(returned));
  const redo = inverseLibraryEdit(h.versions, undo.id, restored, id(24));
  const repeated = h.apply(restored, redo, { kind: 'redo', operationId: deletion.id });
  assert.deepEqual(rows(repeated), rows(after));
  assert.equal(restoreLibraryHistory(h.versions, repeated.version, h.records).undo.slice(-1)[0].operationId, deletion.id);
});

test('all creation and movement append after mixed siblings without ranks from other locations', () => {
  const { root } = setup();
  root.folders = [{ id: id(10), title: 'destination', parentId: null, position: 0 },
    { id: id(11), title: 'sibling', parentId: id(10), position: 8 },
    { id: id(12), title: 'moving', parentId: null, position: 1000 }];
  root.items[0].folderId = id(10); root.items[0].position = 12;
  root.items.push({ ...structuredClone(root.items[0]), id: id(9), folderId: null, position: 99999 });
  assert.equal(libraryAppendPosition(root, id(10)), 13);
  assert.throws(() => libraryAppendPosition(root, id(99)));
  const created = createLibraryFolder(root, id(13), 'new', id(10));
  if (created[0].type === 'put-folder') assert.equal(created[0].folder.position, 13);
  const moved = moveLibraryFolder(root, id(12), id(10));
  if (moved[0].type === 'put-folder') assert.equal(moved[0].folder.position, 13);
  const items = moveLibraryItems(root, [id(9)], id(10));
  if (items[0].type === 'put-item') assert.equal(items[0].item.position, 13);
  root.items[0].position = 1;
  assert.equal(libraryAppendPosition(root, id(10)), 9);
  const afterFolder = moveLibraryItems(root, [id(9)], id(10));
  if (afterFolder[0].type === 'put-item') assert.equal(afterFolder[0].item.position, 9);
  root.folders[1].position = Number.MAX_VALUE;
  assert.throws(() => moveLibraryItems(root, [id(9)], id(10)));
  assert.deepEqual(moveLibraryItems(root, [id(3)], id(10)), []);
});

test('links validate independent PDF/note pairs, dedupe, and Undo/Redo single and bulk additions and removals', () => {
  const h = setup();
  const pdf1 = { ...structuredClone(h.root.items[0]), id: id(30), kind: 'pdf' as const, title: 'PDF 1', resourceId: id(90), position: 1 };
  const pdf2 = { ...structuredClone(pdf1), id: id(31), title: 'PDF 2', position: 2 };
  const owned = { ...structuredClone(h.root.items[0]), id: id(32), title: 'Owned', ownerId: id(30), folderId: null, position: 0 };
  h.root.items.push(pdf1, pdf2, owned);
  assert.equal(libraryOwnedAppendPosition(h.root, id(30)), 1);
  assert.throws(() => libraryOwnedAppendPosition(h.root, id(32)));
  assert.deepEqual(canDropLibraryLinks([id(30), id(31)], id(3), h.root), [
    { pdfId: id(30), noteId: id(3) }, { pdfId: id(31), noteId: id(3) },
  ]);
  assert.equal(canDropLibraryLinks([id(30), id(3)], id(3), h.root), null);
  assert.equal(canDropLibraryLinks([id(30)], id(32), h.root), null);
  assert.throws(() => addLibraryLinks(h.root, [{ pdfId: id(30), noteId: id(32) }]), /library-link-owned/);
  assert.throws(() => addLibraryLinks(h.root, [{ pdfId: id(30), noteId: id(31) }]), /library-link-kind/);
  assert.throws(() => addLibraryLinks(h.root, [{ pdfId: id(30), noteId: id(30) }]), /library-link-self/);
  const addChanges = addLibraryLinks(h.root, [
    { pdfId: id(30), noteId: id(3) }, { pdfId: id(30), noteId: id(3) }, { pdfId: id(31), noteId: id(3) },
  ]);
  assert.equal(addChanges.length, 2);
  const addBatch: LibraryEditBatch = { kind: 'library', id: id(40), libraryId: h.root.id, targetId: h.root.id, parents: [h.root.version], changes: addChanges };
  const linked = h.apply(h.root, addBatch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, addBatch.id));
  assert.deepEqual(addLibraryLinks(linked, [{ pdfId: id(30), noteId: id(3) }]), []);
  const undoAdd = inverseLibraryEdit(h.versions, addBatch.id, linked, id(41));
  const unlinked = h.apply(linked, undoAdd, { kind: 'undo', operationId: addBatch.id });
  assert.equal(unlinked.links.length, 0);
  const redoAdd = inverseLibraryEdit(h.versions, undoAdd.id, unlinked, id(42));
  const relinked = h.apply(unlinked, redoAdd, { kind: 'redo', operationId: addBatch.id });
  assert.equal(relinked.links.length, 2);
  const removeBatch: LibraryEditBatch = { kind: 'library', id: id(43), libraryId: h.root.id, targetId: h.root.id,
    parents: [relinked.version], changes: removeLibraryLinks(relinked, [{ pdfId: id(30), noteId: id(3) }]) };
  const afterRemove = h.apply(relinked, removeBatch);
  assert.equal(afterRemove.links.length, 1);
  const undoRemove = inverseLibraryEdit(h.versions, removeBatch.id, afterRemove, id(44));
  assert.equal((applyBatch(afterRemove, undoRemove) as LibrarySnapshot).links.length, 2);
});

test('note detachment places notes at the owner folder tail, and owner deletion supports detach vs delete with Undo/Redo', () => {
  const h = setup();
  h.root.folders = [{ id: id(10), title: 'Research', parentId: null, position: 5 }];
  const owner = { ...structuredClone(h.root.items[0]), id: id(30), kind: 'pdf' as const, title: 'Owner PDF', folderId: id(10), position: 9, resourceId: id(90) };
  const ownedNote = { ...structuredClone(h.root.items[0]), id: id(31), kind: 'markdown' as const, title: 'Child Note', ownerId: id(30), folderId: null, position: 0 };
  const attachment = { ...structuredClone(h.root.items[0]), id: id(32), kind: 'attachment' as const, title: 'Supplement', ownerId: id(30), folderId: null, position: 1, resourceId: id(91) };
  h.root.items.push(owner, ownedNote, attachment);
  h.root.links = [{ pdfId: id(30), noteId: id(3) }];
  assert.throws(() => detachLibraryNotes(h.root, [id(32)]), /library-detach-invalid/);
  assert.throws(() => detachLibraryNotes(h.root, [id(3)]), /library-detach-invalid/);

  // 1. Standalone note detachment and Undo/Redo
  const detachBatch: LibraryEditBatch = { kind: 'library', id: id(50), libraryId: h.root.id, targetId: h.root.id,
    parents: [h.root.version], changes: detachLibraryNotes(h.root, [id(31)]) };
  const detached = h.apply(h.root, detachBatch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, detachBatch.id));
  const detachedItem = detached.items.find(item => item.id === id(31))!;
  assert.equal(detachedItem.ownerId, null);
  assert.equal(detachedItem.folderId, id(10));
  assert.equal(detachedItem.position, 10);
  const undoDetach = inverseLibraryEdit(h.versions, detachBatch.id, detached, id(51));
  const reattached = h.apply(detached, undoDetach, { kind: 'undo', operationId: detachBatch.id });
  assert.equal(reattached.items.find(item => item.id === id(31))!.ownerId, id(30));

  // 2. Owner deletion with default childNotes: 'detach' (keeps child note, deletes attachment, removes link)
  const deleteKeepBatch: LibraryEditBatch = {
    kind: 'library', id: id(52), libraryId: h.root.id, targetId: h.root.id, parents: [reattached.version],
    changes: deleteLibraryItems(reattached, {
      id: id(60), itemIds: [id(30)], childNotes: 'detach',
      observed: { [id(30)]: [id(80)] },
    }),
  };
  const afterDeleteKeep = h.apply(reattached, deleteKeepBatch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, deleteKeepBatch.id));
  assert.deepEqual(afterDeleteKeep.deletions[0].itemIds, [id(30), id(32)]);
  assert.equal(afterDeleteKeep.links.length, 0);
  assert.equal(afterDeleteKeep.items.find(item => item.id === id(31))!.ownerId, null);
  assert.equal(afterDeleteKeep.items.find(item => item.id === id(31))!.folderId, id(10));
  const undoDeleteKeep = inverseLibraryEdit(h.versions, deleteKeepBatch.id, afterDeleteKeep, id(53));
  const restoredKeep = h.apply(afterDeleteKeep, undoDeleteKeep, { kind: 'undo', operationId: deleteKeepBatch.id });
  assert.equal(restoredKeep.deletions[0].active, false);
  assert.equal(restoredKeep.links.length, 1);
  assert.equal(restoredKeep.items.find(item => item.id === id(31))!.ownerId, id(30));
  const redoDeleteKeep = inverseLibraryEdit(h.versions, undoDeleteKeep.id, restoredKeep, id(54));
  const redoneKeep = h.apply(restoredKeep, redoDeleteKeep, { kind: 'redo', operationId: deleteKeepBatch.id });
  assert.equal(redoneKeep.deletions[0].active, true);
  assert.equal(redoneKeep.items.find(item => item.id === id(31))!.ownerId, null);

  // 3. Owner deletion with explicit childNotes: 'delete' (deletes owner, child note, and attachment together)
  const deleteAllBatch: LibraryEditBatch = {
    kind: 'library', id: id(55), libraryId: h.root.id, targetId: h.root.id, parents: [restoredKeep.version],
    changes: deleteLibraryItems(restoredKeep, {
      id: id(61), itemIds: [id(30)], childNotes: 'delete',
      observed: { [id(30)]: [id(80)], [id(31)]: [id(81)] },
    }),
  };
  const afterDeleteAll = h.apply(restoredKeep, deleteAllBatch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, deleteAllBatch.id));
  assert.deepEqual(afterDeleteAll.deletions.find(d => d.id === id(61))!.itemIds, [id(30), id(31), id(32)]);
  const undoDeleteAll = inverseLibraryEdit(h.versions, deleteAllBatch.id, afterDeleteAll, id(56));
  const restoredAll = h.apply(afterDeleteAll, undoDeleteAll, { kind: 'undo', operationId: deleteAllBatch.id });
  assert.equal(restoredAll.deletions.find(d => d.id === id(61))!.active, false);
  assert.equal(restoredAll.items.find(item => item.id === id(31))!.ownerId, id(30));

  // 4. Explicit restoreDeletedLibraryItems and its Undo/Redo
  const deleteNoteOnlyBatch: LibraryEditBatch = {
    kind: 'library', id: id(57), libraryId: h.root.id, targetId: h.root.id, parents: [restoredAll.version],
    changes: deleteLibraryItems(restoredAll, {
      id: id(62), itemIds: [id(31)], childNotes: 'detach',
      observed: { [id(31)]: [id(81)] },
    }),
  };
  const afterDeleteNote = h.apply(restoredAll, deleteNoteOnlyBatch);
  const restoreNoteBatch: LibraryEditBatch = {
    kind: 'library', id: id(58), libraryId: h.root.id, targetId: h.root.id, parents: [afterDeleteNote.version],
    changes: restoreDeletedLibraryItems(afterDeleteNote, id(62)),
  };
  const afterRestoreNote = h.apply(afterDeleteNote, restoreNoteBatch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, restoreNoteBatch.id));
  assert.equal(afterRestoreNote.deletions.find(d => d.id === id(62))!.active, false);
  const undoRestoreNote = inverseLibraryEdit(h.versions, restoreNoteBatch.id, afterRestoreNote, id(59));
  const reDeletedNote = h.apply(afterRestoreNote, undoRestoreNote, { kind: 'undo', operationId: restoreNoteBatch.id });
  assert.equal(reDeletedNote.deletions.find(d => d.id === id(62))!.active, true);
});

test('bibliography metadata edits validate PDF capability, normalize identifiers, check conflicts, and invert only edited keys', () => {
  const h = setup();
  h.root.items.push({
    id: id(40), title: 'Paper PDF', kind: 'pdf', ownerId: null, folderId: null, position: 1,
    tags: [], read: false, resourceId: id(90), metadata: { custom: 'keep', author: 'Old Author' },
  });
  // Non-PDF items reject bibliography edits
  assert.throws(() => updateLibraryBibliography(h.root, id(3), { author: 'Ada' }), /library-bibliography-unsupported/);
  // Invalid year, DOI, arXiv ID rejected
  assert.throws(() => updateLibraryBibliography(h.root, id(40), { year: '24' }), /library-bibliography-year/);
  assert.throws(() => updateLibraryBibliography(h.root, id(40), { doi: 'invalid-doi' }), /library-bibliography-doi/);
  assert.throws(() => updateLibraryBibliography(h.root, id(40), { doi: '10.1000/abc def' }), /library-bibliography-doi/);
  assert.throws(() => updateLibraryBibliography(h.root, id(40), { arxiv_id: 'not-an-arxiv' }), /library-bibliography-arxiv/);
  // Conflict check on expectedMetadata
  assert.throws(() => updateLibraryBibliography(h.root, id(40), { author: 'Ada' }, { author: 'Stale' }), /library-metadata-changed/);

  const changes = updateLibraryBibliography(h.root, id(40), {
    author: '  Lovelace, Ada  ',
    year: ' 2024 ',
    venue: '  IEEE   Transactions\ton  Control  ',
    doi: 'https://doi.org/10.1000/xyz123.',
    arxiv_id: 'arXiv:2101.00001v2',
  }, { author: 'Old Author', year: '' });
  assert.equal(changes.length, 1);
  const batch: LibraryEditBatch = {
    kind: 'library', id: id(41), libraryId: h.root.id, targetId: h.root.id, parents: [h.root.version], changes,
  };
  const after = h.apply(h.root, batch);
  assert.doesNotThrow(() => assertLibraryEdit(h.versions, batch.id));
  const updatedPdf = after.items.find(item => item.id === id(40))!;
  assert.deepEqual(updatedPdf.metadata, {
    custom: 'keep',
    author: 'Lovelace, Ada',
    year: '2024',
    venue: 'IEEE Transactions on Control',
    doi: '10.1000/xyz123',
    arxiv_id: '2101.00001',
  });

  // Unrelated title or custom metadata changes do not block bibliography Undo
  const current = structuredClone(after);
  const currentPdf = current.items.find(item => item.id === id(40))!;
  currentPdf.title = 'Renamed PDF';
  currentPdf.metadata.custom = 'updated-custom';
  const undo = inverseLibraryEdit(h.versions, batch.id, current, id(42));
  const restored = applyBatch(current, undo) as LibrarySnapshot;
  const restoredPdf = restored.items.find(item => item.id === id(40))!;
  assert.equal(restoredPdf.title, 'Renamed PDF');
  assert.deepEqual(restoredPdf.metadata, { custom: 'updated-custom', author: 'Old Author' });

  // Diverged bibliography field blocks Undo
  currentPdf.metadata.year = '2025';
  assert.throws(() => inverseLibraryEdit(h.versions, batch.id, current, id(43)), /library-history-diverged/);
});
