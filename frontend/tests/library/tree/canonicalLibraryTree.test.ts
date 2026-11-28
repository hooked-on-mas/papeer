import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Folder, LibraryItem } from '../../../src/runtime/edits/contracts.ts';
import { canonicalLibraryRows, canonicalTreeKey, canonicalTreeFocus, paginateCanonicalLibraryRows } from '../../../src/features/library/tree/canonicalLibraryTree.ts';

const folder = (id: string, parentId: string | null, position = 0): Folder => ({ id, parentId, position, title: id });
const item = (id: string, folderId: string | null, ownerId: string | null = null, position = 0): LibraryItem =>
  ({ id, folderId, ownerId, position, kind: 'markdown', title: id, tags: [], read: false, metadata: {} });
test('children paging leaves the full projection intact and revealing a hidden descendant admits its ancestor prefixes', () => {
  const items = Array.from({ length: 9 }, (_, index) => item(`child-${index}`, 'root', null, index));
  items.push(item('grandchild', null, 'child-8'));
  const rows = canonicalLibraryRows({ items, folders: [folder('root', null)], expanded: new Set(['folder:root', 'item:child-8']) });
  const first = paginateCanonicalLibraryRows(rows, new Map(), null);
  assert.deepEqual(first.map(row => row.key), ['folder:root', ...items.slice(0, 6).map(value => `item:${value.id}`), 'more:folder:root']);
  assert.equal(first[first.length - 1].remaining, 3);
  const revealed = paginateCanonicalLibraryRows(rows, new Map(), 'item:grandchild');
  assert.equal(revealed.some(row => row.key === 'item:grandchild'), true);
  assert.equal(revealed.some(row => row.kind === 'more'), false);
  assert.equal(rows.length, 11);
  assert.equal(items.length, 10);
  assert.deepEqual(revealed.filter(row => row.parentKey === 'folder:root').map(row => [row.siblingIndex, row.siblingCount]),
    Array.from({ length: 9 }, (_, index) => [index + 1, 9]));
});
test('large root paging and End reveal retain stable IDs, and more action is never an owner item', () => {
  const rows = canonicalLibraryRows({ items: Array.from({ length: 2000 }, (_, index) => item(`i${index}`, null, null, index)), folders: [], expanded: new Set() });
  const first = paginateCanonicalLibraryRows(rows, new Map(), null);
  assert.equal(first.length, 101); assert.equal(first[100].kind, 'more'); assert.equal(first[100].id, '');
  assert.deepEqual(canonicalTreeKey(rows, rows[0].key, 'End'), { type: 'focus', key: 'item:i1999' });
  const end = paginateCanonicalLibraryRows(rows, new Map(), 'item:i1999');
  assert.deepEqual(end.map(row => row.key), rows.map(row => row.key));
  const next = paginateCanonicalLibraryRows(rows, new Map([[null, 200]]), null);
  assert.equal(next.length, 201); assert.equal(next[200].remaining, 1800);
});
test('4000 expanded folders retain preorder and deep focus falls back without recursion', () => {
  const folders = Array.from({ length: 4000 }, (_, index) => folder(`f${index}`, index ? `f${index - 1}` : null));
  const items = [item('leaf', 'f3999')], expanded = new Set(folders.map(value => `folder:${value.id}`));
  const rows = canonicalLibraryRows({ items, folders, expanded });
  assert.equal(rows.length, 4001);
  assert.deepEqual(rows.map(row => row.depth), Array.from({ length: 4001 }, (_, index) => index));
  assert.deepEqual(rows.map(row => row.key), [...folders.map(value => `folder:${value.id}`), 'item:leaf']);
  const collapsed = canonicalLibraryRows({ items, folders, expanded: new Set() });
  assert.equal(canonicalTreeFocus(collapsed, rows, 'item:leaf'), 'folder:f0');
});
test('canonical projection places owned notes once, sorts stable siblings and excludes deleted owner subtrees', () => {
  const folders = [folder('nested', 'root'), folder('root', null)];
  const items = [item('owned', null, 'owner'), item('owner', 'nested'), item('free', null)];
  const expanded = new Set(['folder:root', 'folder:nested', 'item:owner']);
  const rows = canonicalLibraryRows({ items, folders, expanded });
  assert.deepEqual(rows.map(row => [row.key, row.depth, row.parentKey]), [
    ['folder:root', 0, null], ['folder:nested', 1, 'folder:root'], ['item:owner', 2, 'folder:nested'],
    ['item:owned', 3, 'item:owner'], ['item:free', 0, null],
  ]);
  assert.deepEqual(canonicalLibraryRows({ items: [...items].reverse(), folders: [...folders].reverse(), expanded }), rows);
  assert.deepEqual(canonicalLibraryRows({ items, folders, expanded, deletedIds: new Set(['owner']) }).map(row => row.key),
    ['folder:root', 'folder:nested', 'item:free']);
  assert.deepEqual(canonicalLibraryRows({ items, folders, expanded: new Set() }).map(row => row.key), ['folder:root', 'item:free']);
});
test('tree keys and focus follow logical IDs through collapse, removal, and reordering', () => {
  const items = [item('a', 'root'), item('b', null, null, 1)], folders = [folder('root', null)];
  const open = canonicalLibraryRows({ items, folders, expanded: new Set(['folder:root']) });
  const closed = canonicalLibraryRows({ items, folders, expanded: new Set() });
  assert.deepEqual(canonicalTreeKey(closed, 'folder:root', 'ArrowRight'), { type: 'expand', key: 'folder:root' });
  assert.deepEqual(canonicalTreeKey(open, 'folder:root', 'ArrowRight'), { type: 'focus', key: 'item:a' });
  assert.deepEqual(canonicalTreeKey(open, 'item:a', 'ArrowLeft'), { type: 'focus', key: 'folder:root' });
  assert.deepEqual(canonicalTreeKey(open, 'folder:root', 'ArrowLeft'), { type: 'collapse', key: 'folder:root' });
  assert.deepEqual(canonicalTreeKey(open, 'item:a', 'End'), { type: 'focus', key: 'item:b' });
  assert.deepEqual(canonicalTreeKey(open, 'item:b', 'Home'), { type: 'focus', key: 'folder:root' });
  assert.equal(canonicalTreeFocus(closed, open, 'item:a'), 'folder:root');
  assert.equal(canonicalTreeFocus([open[2]], open, 'item:a'), 'item:b');
  assert.equal(canonicalTreeFocus([...open].reverse(), open, 'item:a'), 'item:a');
  assert.equal(canonicalTreeFocus([], open, 'item:a'), null);
});
test('bilateral links appear after owned children, never expand, and focus parent on ArrowLeft', () => {
  const pdf: LibraryItem = { ...item('pdf-1', null, null, 0), kind: 'pdf', resourceId: '00000000-0000-4000-8000-000000000001' };
  const owned: LibraryItem = { ...item('owned-1', null, 'pdf-1', 0), kind: 'markdown' };
  const note: LibraryItem = { ...item('note-1', null, null, 1), kind: 'notebook' };
  const links = [{ pdfId: 'pdf-1', noteId: 'note-1' }, { pdfId: 'pdf-1', noteId: 'note-1' }];
  const rows = canonicalLibraryRows({ items: [pdf, owned, note], folders: [], links, expanded: new Set(['item:pdf-1', 'item:note-1']) });
  assert.deepEqual(rows.map(row => [row.key, row.kind, row.depth, row.parentKey, row.expandable]), [
    ['item:pdf-1', 'item', 0, null, true],
    ['item:owned-1', 'item', 1, 'item:pdf-1', false],
    ['link:pdf-1:note-1', 'link', 1, 'item:pdf-1', false],
    ['item:note-1', 'item', 0, null, true],
    ['link:note-1:pdf-1', 'link', 1, 'item:note-1', false],
  ]);
  assert.equal(canonicalTreeKey(rows, 'link:pdf-1:note-1', 'ArrowRight'), null);
  assert.deepEqual(canonicalTreeKey(rows, 'link:pdf-1:note-1', 'ArrowLeft'), { type: 'focus', key: 'item:pdf-1' });
});
