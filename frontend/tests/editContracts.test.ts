import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { applyBatch, assertSnapshot, canonicalJson, conflictTitle } from '../src/runtime/edits/editModel.ts';
import type { EditBatch, Snapshot, LibrarySnapshot } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')) as {
  libraryId: string; document: Snapshot; markdown: Snapshot; library: Snapshot; batches: EditBatch[];
  invalid: { name: string; root: Snapshot; batch: EditBatch }[];
  ownership: { root: LibrarySnapshot; move: EditBatch; detach: EditBatch };
};
const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const batch = (value: number) => fixture.batches.find(batch => batch.id === id(value))!;
const graph = (root = fixture.document) => new EditGraph({ version: 1, libraryId: fixture.libraryId, root, batches: [] });

test('wire fixture: both branches and children survive every delivery order and duplicate', () => {
  for (const order of [[201, 202, 203, 204], [204, 202, 203, 201], [203, 201, 204, 202], [202, 204, 201, 203]]) {
    const value = graph();
    for (const number of order) { value.receive([batch(number)]); value.receive([batch(number)]); }
    assert.deepEqual(value.getView(), { heads: [id(202), id(204)], waiting: [], rejected: {} });
    const left = value.snapshot(id(202)), right = value.snapshot(id(204));
    assert.equal(left?.kind === 'document' && left.pages[0].annotations.length, 1);
    assert.equal(right?.kind === 'document' && right.pages[0].id, id(4));
    assert.equal(right?.kind === 'document' && right.deletedPages[0].id, id(3));
    assert.deepEqual(new EditGraph(value.checkpoint()).getView(), value.getView());
  }
});
test('a missing parent waits without taking a head; a different page edit conflicts at document level', () => {
  const value = graph(); value.receive([batch(202)]);
  assert.deepEqual(value.getView().heads, [id(100)]); assert.deepEqual(value.getView().waiting, [id(202)]);
  value.receive([batch(201), batch(205)]);
  assert.deepEqual(value.getView().heads, [id(202), id(205)]);
});
test('conditional resolution, late branch and simultaneous resolutions keep all unobserved heads', () => {
  const value = graph(); value.receive([batch(201), batch(202), batch(203), batch(204)]);
  value.assertLocal(batch(206)); value.receive([batch(206), batch(207), batch(205)]);
  assert.deepEqual(value.getView().heads, [id(205), id(206), id(207)]);
  assert.throws(() => value.assertLocal(batch(206)), /heads-changed/);
  const late = graph(); late.receive([batch(206), batch(205), batch(204), batch(202), batch(201), batch(203)]);
  assert.deepEqual(late.getView().heads, [id(205), id(206)]);
});
test('same ID/different payload rejects the entire arrival; cycles reject without changing the graph', () => {
  const value = graph(); value.receive([batch(201)]);
  const before = canonicalJson(value.checkpoint());
  assert.throws(() => value.receive([batch(203), { ...batch(201), parents: [id(999)] }]), /batch-id-reused/);
  assert.equal(canonicalJson(value.checkpoint()), before);
  const a = { ...batch(201), parents: [id(202)] }, b = { ...batch(202), parents: [id(201)] };
  assert.throws(() => graph().receive([a, b]), /parent-cycle/);
});
test('shared invalid corpus rejects structure and business rule errors without a partial edit', () => {
  for (const value of fixture.invalid) {
    const before = canonicalJson(value.root);
    assert.throws(() => applyBatch(value.root, value.batch), /./, value.name);
    assert.equal(canonicalJson(value.root), before, value.name);
  }
});

test('owned content has one derived location and independent notes explicitly inherit the current owner folder', () => {
  const { root, move, detach } = fixture.ownership;
  assertSnapshot(root);
  const moved = applyBatch(root, move) as LibrarySnapshot;
  assert.equal(moved.items[0].folderId, id(8101));
  assert.ok(moved.items.slice(1).every(item => item.ownerId === root.items[0].id && item.folderId === null));
  const independent = applyBatch(moved, detach) as LibrarySnapshot;
  assert.equal(independent.items[1].ownerId, null);
  assert.equal(independent.items[1].folderId, id(8101));
  assert.equal(independent.items[2].ownerId, root.items[0].id);
  for (const value of fixture.invalid.filter(value => ['owned-markdown-folder', 'owned-attachment-folder', 'deleted-owned-folder'].includes(value.name))) {
    assert.throws(() => applyBatch(value.root, value.batch), /owned-item-folder/, value.name);
  }
});
test('all four persistence families validate Unicode code points and preserve catalog deletion history', () => {
  for (const root of [fixture.document, fixture.markdown, fixture.library]) assertSnapshot(root);
  const md = graph(fixture.markdown); md.receive([batch(501), batch(502)]);
  assert.deepEqual(md.getView().heads, [id(501), id(502)]);
  const library = graph(fixture.library); library.receive([batch(302), batch(301)]);
  assert.deepEqual(library.getView().heads, [id(302)]);
  assert.equal(library.snapshot(id(302))?.kind === 'library' && (library.snapshot(id(302)) as typeof fixture.library & { items: unknown[] }).items.length, 2);
  assert.equal(Array.from(conflictTitle('𠮷'.repeat(200))).length, 200);
});

export { fixture, id, batch };

test('long reverse-ordered history reconstructs without recursive stack growth', () => {
  const edits: EditBatch[] = [];
  let parent = fixture.markdown.version;
  for (let number = 10000; number < 12000; number++) {
    edits.push({ kind: 'markdown', imageResources: [], id: id(number), targetId: fixture.markdown.id, libraryId: fixture.libraryId, parents: [parent], content: String(number) });
    parent = id(number);
  }
  const value = graph(fixture.markdown); value.receive(edits.reverse());
  assert.deepEqual(value.getView().heads, [id(11999)]);
  assert.deepEqual(value.getView().waiting, []);
});

test('public graph snapshots cannot mutate the retained immutable parent', () => {
  const value = graph();
  const exposed = value.root;
  if (exposed.kind === 'document') exposed.pages.splice(0, 1);
  value.receive([batch(201)]);
  const applied = value.snapshot(id(201));
  assert.equal(applied?.kind === 'document' && applied.pages.length, 2);
});

test('non-finite JSON numbers and non-scalar Unicode metadata keys cannot enter either storage adapter', () => {
  const value = structuredClone(fixture.library);
  assert.ok(value.kind === 'library');
  value.items[0].metadata['\ud800'] = 'invalid key';
  assert.throws(() => assertSnapshot(value));
  const document = structuredClone(fixture.document);
  assert.ok(document.kind === 'document'); document.pages[0].widthPt = Infinity;
  assert.throws(() => assertSnapshot(document));
});
