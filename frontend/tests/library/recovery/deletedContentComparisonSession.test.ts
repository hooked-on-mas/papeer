import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeletedContentComparisonSession, comparisonPages, type DeletedContentComparisonState } from '../../../src/features/library/recovery/DeletedContentComparisonSession.ts';
import type { DocumentSnapshot, LibrarySnapshot, MarkdownEditBatch, MarkdownSnapshot, Page, ResolutionBatch } from '../../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { EditScope, RepositoryState } from '../../../src/runtime/edits/ports.ts';

function fixture() {
  const scope: EditScope = { accountId: 'comparison', libraryId: crypto.randomUUID(), epoch: 'one' };
  const root: MarkdownSnapshot = { kind: 'markdown', id: crypto.randomUUID(), version: crypto.randomUUID(),
    content: 'deleted body', appendIds: [], imageResources: [] };
  const ownerId = crypto.randomUUID(), deletionId = crypto.randomUUID();
  const catalog: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(),
    items: [
      { id: ownerId, kind: 'pdf', title: 'Owner', ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} },
      { id: root.id, kind: 'markdown', title: 'Child note', ownerId, folderId: null, position: 0, tags: [], read: false, metadata: {} },
    ], folders: [], links: [], deletions: [{ id: deletionId, itemIds: [ownerId, root.id],
      observed: [{ targetId: ownerId, heads: [crypto.randomUUID()] }, { targetId: root.id, heads: [root.version] }], active: true }] };
  const batch = (parent = root.version, content = 'late body'): MarkdownEditBatch => ({ kind: 'markdown',
    id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: root.id, parents: [parent], content, imageResources: [] });
  const projection = (batches: MarkdownEditBatch[] = [], base = root): RepositoryState => {
    const checkpoint = { version: 1 as const, libraryId: scope.libraryId, root: structuredClone(base), batches: structuredClone(batches) };
    return { ...new EditGraph(checkpoint).getView(), checkpoint, receipts: [], history: [] };
  };
  let value = projection(), active = true, reads = 0;
  let read = async (): Promise<RepositoryState> => structuredClone(value);
  const repository = { scope, read: async (targetId: string) => {
    assert.equal(targetId, root.id); reads++; return read();
  } };
  const session = new DeletedContentComparisonSession({ repository, isActive: () => active });
  const markdownState = () => {
    const value = session.getSnapshot();
    if (value.observed) assert.equal(value.observed.kind, 'markdown');
    if (value.current) assert.equal(value.current.kind, 'markdown');
    return value as DeletedContentComparisonState & { observed: MarkdownSnapshot | null; current: MarkdownSnapshot | null };
  };
  return { scope, root, ownerId, deletionId, catalog, batch, projection, repository, session, markdownState,
    reads: () => reads, active: (next: boolean) => { active = next; },
    value: (next: RepositoryState) => { value = next; }, reader: (next: typeof read) => { read = next; },
    open: () => session.open(catalog, deletionId, root.id) };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function documentFixture(kind: 'pdf' | 'notebook' = 'pdf') {
  const f = fixture(); f.catalog.items[1].kind = kind;
  const page = (paper = false): Page => ({ id: crypto.randomUUID(), backgroundRevision: crypto.randomUUID(),
    lifecycleVersion: crypto.randomUUID(), annotationVersion: crypto.randomUUID(), widthPt: 600, heightPt: 800,
    background: paper ? { kind: 'paper', spec: { template: 'grid5', color: 'cream' } }
      : { kind: 'pdf', resourceId: crypto.randomUUID(), sourceRevision: 'a'.repeat(64), pdfPage: 1 }, annotations: [] });
  const root: DocumentSnapshot = { kind: 'document', id: f.root.id, version: f.root.version,
    pages: [page(kind === 'notebook'), page(kind === 'notebook')], deletedPages: [page()],
    translation: { revision: crypto.randomUUID(), pages: [page(), page()], bindings: [] } };
  const view = (base = root, batches: ResolutionBatch[] = []): RepositoryState => {
    const checkpoint = { version: 1 as const, libraryId: f.scope.libraryId, root: structuredClone(base), batches: structuredClone(batches) };
    return { ...new EditGraph(checkpoint).getView(), checkpoint, receipts: [], history: [] };
  };
  f.value(view());
  return { ...f, root, page, view };
}

test('PDF and paper document roots retain all original, translated and deleted page pools without inferred mappings', async () => {
  for (const kind of ['pdf', 'notebook'] as const) {
    const f = documentFixture(kind); assert.equal(await f.open(), true);
    const state = f.session.getSnapshot(); assert.equal(state.current?.kind, 'document');
    assert.deepEqual(state.page.current.key, { collection: 'original', pageId: f.root.pages[0].id });
    assert.equal(state.page.current.page?.background.kind, kind === 'pdf' ? 'pdf' : 'paper');
    assert.equal(comparisonPages(state.current).length, 5);
    const translated = { collection: 'translated' as const, pageId: f.root.translation!.pages[1].id };
    assert.equal(f.session.selectPage('current', translated), true);
    assert.equal(f.session.getSnapshot().page.current.page?.background.kind, 'pdf');
    assert.equal(f.session.getSnapshot().page.observed.key?.collection, 'original');
    const deleted = { collection: 'deleted' as const, pageId: f.root.deletedPages[0].id };
    assert.equal(f.session.selectPage('observed', deleted), true);
    assert.deepEqual(f.session.getSnapshot().page.observed.key, deleted);
    assert.equal(f.session.selectPage('current', { collection: 'original', pageId: deleted.pageId }), false);
    assert.equal(f.session.selectPage('current', { collection: 'translated', pageId: f.root.pages[0].id }), false);
    assert.ok(Object.isFrozen(f.session.getSnapshot().page.observed.page));
  }
});

test('page identity survives explicit versions, missing pages stay missing, and scroll is restored per side/version/pool/page', async () => {
  const f = documentFixture();
  const a: DocumentSnapshot = { ...structuredClone(f.root), version: crypto.randomUUID() };
  const b: DocumentSnapshot = { ...structuredClone(f.root), version: crypto.randomUUID(), pages: [f.page()], deletedPages: [] };
  // Both explicit versions resolve two immutable sibling document batches, preserving every ancestor.
  const branch = (snapshot: DocumentSnapshot) => ({ kind: 'resolution' as const, id: snapshot.version, libraryId: f.scope.libraryId,
    targetId: f.root.id, parents: [crypto.randomUUID(), crypto.randomUUID()], snapshot });
  const aBatch = branch(a), bBatch = branch(b);
  const sibling1 = { kind: 'document' as const, id: aBatch.parents[0], libraryId: f.scope.libraryId, targetId: f.root.id,
    parents: [f.root.version], changes: [{ type: 'move' as const, expected: { pageId: f.root.pages[0].id,
      backgroundRevision: f.root.pages[0].backgroundRevision, lifecycleVersion: f.root.pages[0].lifecycleVersion,
      annotationVersion: f.root.pages[0].annotationVersion }, index: 0 }] };
  const sibling2 = { ...structuredClone(sibling1), id: aBatch.parents[1] };
  bBatch.parents = [...aBatch.parents];
  const checkpoint = { version: 1 as const, libraryId: f.scope.libraryId, root: f.root, batches: [sibling1, sibling2, aBatch, bBatch] };
  f.value({ ...new EditGraph(checkpoint).getView(), checkpoint, receipts: [], history: [] });
  await f.open(); assert.equal(f.session.getSnapshot().current, null);
  assert.equal(f.session.select('current', a.version), true);
  const second = { collection: 'original' as const, pageId: a.pages[1].id };
  assert.equal(f.session.selectPage('current', second), true);
  f.session.rememberScroll('current', { top: 123, left: 9 });
  const translated = { collection: 'translated' as const, pageId: a.translation!.pages[0].id };
  f.session.selectPage('current', translated); f.session.rememberScroll('current', { top: 77, left: 2 });
  f.session.selectPage('current', second); assert.deepEqual(f.session.getSnapshot().scroll.current, { top: 123, left: 9 });
  assert.equal(f.session.select('current', b.version), true);
  let state = f.session.getSnapshot(); assert.deepEqual(state.page.current.key, second);
  assert.equal(state.page.current.page, null); assert.equal(state.page.current.missing, true);
  assert.deepEqual(state.scroll.current, { top: 0, left: 0 });
  assert.equal(f.session.select('current', a.version), true); state = f.session.getSnapshot();
  assert.equal(state.page.current.page?.id, second.pageId); assert.equal(state.page.current.missing, false);
  assert.deepEqual(state.scroll.current, { top: 123, left: 9 });
  assert.deepEqual(state.scroll.observed, { top: 0, left: 0 });
});

test('ordinary document polls and head retirement keep the exact selected page snapshot and its scroll', async () => {
  const f = documentFixture('notebook'); await f.open();
  const key = { collection: 'deleted' as const, pageId: f.root.deletedPages[0].id };
  f.session.selectPage('current', key); f.session.rememberScroll('current', { top: 45, left: 1 });
  const before = f.session.getSnapshot();
  const later = structuredClone(f.root); later.version = crypto.randomUUID(); later.deletedPages = [];
  f.value(f.view(later)); await f.session.refresh();
  const after = f.session.getSnapshot(); assert.strictEqual(after.current, before.current);
  assert.strictEqual(after.page.current.page, before.page.current.page); assert.deepEqual(after.page.current.key, key);
  assert.equal(after.page.current.missing, false); assert.deepEqual(after.scroll.current, { top: 45, left: 1 });
  assert.equal(after.currentStale, true); assert.deepEqual(after.newHeads, [later.version]);
});

test('catalog/content kind disagreements cannot replace a displayed document, and attachment roots are never read', async () => {
  const f = documentFixture(); await f.open(); const before = f.session.getSnapshot();
  f.value(f.projection()); assert.equal(await f.session.refresh(), false);
  assert.strictEqual(f.session.getSnapshot().current, before.current); assert.match(f.session.getSnapshot().error, /comparison-content-scope/);
  const markdown = structuredClone(f.catalog); markdown.items[1].kind = 'markdown';
  f.session.setCatalog(markdown); assert.equal(f.session.getSnapshot().stale, true);
  const attachment = structuredClone(f.catalog); attachment.items[1].kind = 'attachment';
  const reads = f.reads(); assert.equal(await f.session.open(attachment, f.deletionId, f.root.id), false); assert.equal(f.reads(), reads);
});

test('a deleted child compares its observed ancestor with the current head and includes the entire deletion set', async () => {
  const f = fixture(), late = f.batch(); f.value(f.projection([late]));
  const before = structuredClone(f.catalog);
  assert.equal(await f.open(), true);
  const state = f.markdownState();
  assert.equal(state.observed?.version, f.root.version); assert.equal(state.current?.version, late.id);
  assert.equal(state.observed?.content, 'deleted body'); assert.equal(state.current?.content, 'late body');
  assert.deepEqual(state.targets, [{ id: f.ownerId, title: 'Owner' }, { id: f.root.id, title: 'Child note' }]);
  assert.deepEqual(f.catalog, before); assert.equal(state.stale, false); assert.equal(state.currentStale, false);
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.current)); assert.ok(Object.isFrozen(state.targets[0]));
});

test('multiple observed and current heads require independent explicit choices, including after branches retire', async () => {
  const f = fixture(), a = f.batch(undefined, 'a'), b = f.batch(undefined, 'b');
  f.catalog.deletions[0].observed[1].heads = [b.id, a.id]; f.value(f.projection([a, b]));
  await f.open(); assert.equal(f.markdownState().observed, null); assert.equal(f.markdownState().current, null);
  assert.equal(f.session.select('observed', f.root.version), false);
  assert.equal(f.session.select('observed', a.id), true); assert.equal(f.markdownState().current, null);
  // A later single-head read does not silently resolve the earlier explicit-choice requirement.
  const single = f.projection([a, b]); single.heads = [b.id]; f.value(single); await f.session.refresh();
  assert.equal(f.markdownState().current, null); assert.equal(f.session.select('current', b.id), true);
  assert.equal(f.markdownState().observed?.content, 'a'); assert.equal(f.markdownState().current?.content, 'b');
});

test('body, append identities, and image manifests remain fixed when new heads arrive and retire a chosen head', async () => {
  const f = fixture(); f.root.appendIds.push(crypto.randomUUID());
  const resourceId = crypto.randomUUID(), hash = 'a'.repeat(64);
  f.root.content = `![image](resource:${resourceId})`; f.root.imageResources = [{ resourceId, sha256: hash }];
  f.value(f.projection()); await f.open();
  const before = f.markdownState(), late = f.batch(undefined, 'new without image');
  f.session.rememberScroll('current', { top: 29, left: 3 });
  f.value(f.projection([late])); await f.session.refresh();
  const after = f.markdownState();
  assert.strictEqual(after.observed, before.observed); assert.strictEqual(after.current, before.current);
  assert.deepEqual(after.current?.imageResources, [{ resourceId, sha256: hash }]);
  assert.deepEqual(after.current?.appendIds, f.root.appendIds); assert.equal(after.currentStale, true);
  assert.deepEqual(after.newHeads, [late.id]); assert.deepEqual(after.scroll.current, { top: 29, left: 3 });
  assert.equal(f.session.select('current', late.id), true); assert.equal(f.markdownState().currentStale, false);
  assert.deepEqual(f.markdownState().current?.imageResources, []); assert.deepEqual(f.markdownState().newHeads, []);
  assert.deepEqual(f.markdownState().scroll.current, { top: 0, left: 0 });
});

test('waiting parents preserve the acquired side and materialize the original missing observation when it arrives', async () => {
  const f = fixture(), parent = f.batch(undefined, 'observed'), child = f.batch(parent.id, 'waiting child');
  f.catalog.deletions[0].observed[1].heads = [parent.id]; f.value(f.projection([child]));
  await f.open(); const before = f.markdownState();
  assert.equal(before.observed, null); assert.equal(before.current?.version, f.root.version);
  assert.deepEqual(before.waiting, [child.id]); assert.deepEqual(before.missingVersions, [parent.id]);
  assert.equal(before.observedStale, true); assert.equal(f.session.select('observed', parent.id), false);
  f.value(f.projection([child, parent])); await f.session.refresh();
  assert.equal(f.markdownState().observed?.content, 'observed');
  assert.strictEqual(f.markdownState().current, before.current);
  assert.equal(f.markdownState().currentStale, true); assert.deepEqual(f.markdownState().waiting, []);
});

test('a missing initial current version never falls back to another head or an empty body', async () => {
  const f = fixture(), original = f.batch(), replacement = f.batch(undefined, 'replacement');
  const absent = f.projection(); absent.heads = [original.id]; f.value(absent); await f.open();
  assert.equal(f.markdownState().current, null); assert.equal(f.markdownState().currentStale, true);
  f.value(f.projection([replacement])); await f.session.refresh();
  assert.equal(f.markdownState().current, null);
  assert.ok(f.markdownState().missingVersions.includes(original.id));
  assert.equal(f.session.select('current', replacement.id), true);
  assert.equal(f.markdownState().current?.content, 'replacement');
});

test('a read error and a temporarily incomplete graph retain both complete displayed snapshots', async () => {
  const f = fixture(), late = f.batch(); f.value(f.projection([late])); await f.open();
  const before = f.markdownState(); f.reader(async () => { throw new Error('offline'); });
  assert.equal(await f.session.refresh(), false);
  assert.strictEqual(f.markdownState().observed, before.observed); assert.strictEqual(f.markdownState().current, before.current);
  assert.match(f.markdownState().error, /offline/); assert.equal(f.markdownState().currentStale, true);
  assert.equal(f.session.select('current', late.id), false);
  const incomplete = f.projection(); incomplete.heads = [late.id]; f.reader(async () => incomplete);
  assert.equal(await f.session.refresh(), true); assert.equal(f.markdownState().error, '');
  assert.strictEqual(f.markdownState().current, before.current);
  assert.deepEqual(f.markdownState().missingVersions, [late.id]);
  f.reader(async () => f.projection([late])); await f.session.refresh(); assert.equal(f.markdownState().currentStale, false);
});

test('ordinary polling shares a slow read without starving or discarding its result', async () => {
  const f = fixture(); await f.open(); const boundary = gate(), late = f.batch(); let entered = false;
  f.reader(async () => { entered = true; await boundary.promise; return f.projection([late]); });
  const first = f.session.refresh(); await Promise.resolve(); assert.equal(entered, true);
  for (let index = 0; index < 20; index++) assert.strictEqual(f.session.refresh(), first);
  // Repeating the selected catalog is also an ordinary poll, not a cancellation.
  f.session.setCatalog(structuredClone(f.catalog)); assert.strictEqual(f.session.refresh(), first);
  assert.equal(f.reads(), 2); boundary.resolve(); assert.equal(await first, true);
  assert.deepEqual(f.markdownState().newHeads, [late.id]); assert.equal(f.markdownState().loading, false);
});

test('catalog version changes invalidate a delayed read even when its deletion record is unchanged', async () => {
  const f = fixture(); await f.open(); const boundary = gate(), late = f.batch();
  f.reader(async () => { await boundary.promise; return f.projection([late]); });
  const pending = f.session.refresh(); await Promise.resolve();
  const newer = structuredClone(f.catalog); newer.version = crypto.randomUUID(); newer.items[1].title = 'Renamed child';
  f.session.setCatalog(newer); boundary.resolve(); assert.equal(await pending, false);
  assert.equal(f.markdownState().selection?.catalogVersion, newer.version);
  assert.equal(f.markdownState().targets[1].title, 'Renamed child'); assert.deepEqual(f.markdownState().newHeads, []);
  assert.equal(f.markdownState().stale, false); f.reader(async () => f.projection([late]));
  assert.equal(await f.session.refresh(), true); assert.deepEqual(f.markdownState().newHeads, [late.id]);
});

test('restoration, a changed deletion record, absent catalog, or a changed target kind stop actions and keep the old display', async () => {
  for (const change of ['restored', 'observed', 'targets', 'kind', 'absent', 'scope'] as const) {
    const f = fixture(); await f.open(); const before = f.markdownState(), next = structuredClone(f.catalog);
    next.version = crypto.randomUUID();
    if (change === 'restored') next.deletions[0].active = false;
    if (change === 'observed') next.deletions[0].observed[1].heads = [crypto.randomUUID()];
    if (change === 'targets') next.deletions[0].itemIds = [f.root.id];
    if (change === 'kind') next.items[1].kind = 'notebook';
    if (change === 'scope') next.id = crypto.randomUUID();
    f.session.setCatalog(change === 'absent' ? null : next);
    assert.equal(f.markdownState().stale, true, change);
    assert.strictEqual(f.markdownState().observed, before.observed); assert.strictEqual(f.markdownState().current, before.current);
    const reads = f.reads(); assert.equal(await f.session.refresh(), false); assert.equal(f.reads(), reads);
    assert.equal(f.session.select('current', f.root.version), false);
    f.session.setCatalog(f.catalog); assert.equal(f.markdownState().stale, false); assert.equal(await f.session.refresh(), true);
  }
});

test('close, cancel, inactivity, availability, and scope changes reject old reads without restoring closed state', async () => {
  for (const reason of ['close', 'cancel', 'inactive', 'unavailable', 'scope'] as const) {
    const f = fixture(); await f.open(); const before = f.markdownState(), boundary = gate(), late = f.batch();
    f.reader(async () => { await boundary.promise; return f.projection([late]); });
    const pending = f.session.refresh(); await Promise.resolve();
    if (reason === 'close') f.session.close();
    if (reason === 'cancel') f.session.cancel();
    if (reason === 'inactive') f.active(false);
    if (reason === 'unavailable') f.session.setAvailable(false);
    if (reason === 'scope') f.scope.epoch = 'another-epoch';
    boundary.resolve(); assert.equal(await pending, false, reason); assert.equal(f.markdownState().loading, false);
    assert.deepEqual(f.markdownState().newHeads, []);
    if (reason === 'close') assert.equal(f.markdownState().selection, null);
    else assert.strictEqual(f.markdownState().current, before.current);
  }
});

test('a newly opened target generation wins over the old delayed read', async () => {
  const f = fixture(); await f.open(); const boundary = gate(), late = f.batch();
  f.reader(async () => { await boundary.promise; return f.projection([late]); });
  const old = f.session.refresh(); await Promise.resolve();
  f.reader(async () => f.projection()); assert.equal(await f.open(), true);
  const current = f.markdownState(); boundary.resolve(); assert.equal(await old, false);
  assert.strictEqual(f.markdownState(), current); assert.equal(current.current?.version, f.root.version);
});

test('restoration during a read invalidates it and availability cannot resurrect an older generation', async () => {
  for (const reason of ['restored', 'availability'] as const) {
    const f = fixture(); await f.open(); const boundary = gate(), late = f.batch();
    f.reader(async () => { await boundary.promise; return f.projection([late]); });
    const pending = f.session.refresh(); await Promise.resolve();
    if (reason === 'restored') {
      const restored = structuredClone(f.catalog); restored.version = crypto.randomUUID(); restored.deletions[0].active = false;
      f.session.setCatalog(restored);
    } else { f.session.setAvailable(false); f.session.setAvailable(true); }
    boundary.resolve(); assert.equal(await pending, false);
    assert.equal(f.markdownState().current?.version, f.root.version); assert.deepEqual(f.markdownState().newHeads, []);
    if (reason === 'restored') assert.equal(f.markdownState().stale, true);
    else { f.reader(async () => f.projection([late])); assert.equal(await f.session.refresh(), true); }
  }
});

test('foreign content checkpoints and non-Markdown roots cannot replace the displayed pair', async () => {
  for (const invalid of ['library', 'target', 'kind'] as const) {
    const f = fixture(); await f.open(); const before = f.markdownState(), next = f.projection();
    if (invalid === 'library') next.checkpoint.libraryId = crypto.randomUUID();
    if (invalid === 'target') next.checkpoint.root.id = crypto.randomUUID();
    if (invalid === 'kind') next.checkpoint.root = { kind: 'document', id: f.root.id, version: f.root.version, pages: [], deletedPages: [] };
    f.value(next); assert.equal(await f.session.refresh(), false);
    assert.match(f.markdownState().error, /comparison-content-scope/);
    assert.strictEqual(f.markdownState().current, before.current); assert.strictEqual(f.markdownState().observed, before.observed);
  }
});

test('invalid catalog opens perform no content read and preserve the previous comparison as stale', async () => {
  const f = fixture(); await f.open(); const before = f.markdownState(), reads = f.reads();
  f.catalog.items[0].kind = 'attachment';
  assert.equal(await f.session.open(f.catalog, f.deletionId, f.ownerId), false);
  assert.equal(f.reads(), reads); assert.equal(f.markdownState().stale, true);
  assert.strictEqual(f.markdownState().current, before.current);
  const restored = structuredClone(f.catalog); restored.deletions[0].active = false;
  assert.equal(await f.session.open(restored, f.deletionId, f.root.id), false); assert.equal(f.reads(), reads);
});

test('scroll positions are independent, immutable, validated, and retained by refresh and same-version selection', async () => {
  const f = fixture(); let changes = 0; const unsubscribe = f.session.subscribe(() => { changes++; });
  await f.open(); assert.ok(changes > 0);
  const scroll = { top: 40, left: 4 }; assert.equal(f.session.rememberScroll('observed', scroll), true); scroll.top = 900;
  assert.equal(f.session.rememberScroll('current', { top: 70, left: 0 }), true);
  assert.equal(f.session.rememberScroll('current', { top: NaN, left: 0 }), false);
  assert.equal(f.session.rememberScroll('current', { top: 0, left: -1 }), false);
  await f.session.refresh(); assert.equal(f.session.select('observed', f.root.version), true);
  assert.deepEqual(f.markdownState().scroll, { observed: { top: 40, left: 4 }, current: { top: 70, left: 0 } });
  unsubscribe(); const previous = changes; f.session.close(); assert.equal(changes, previous);
  assert.equal(f.session.rememberScroll('current', { top: 0, left: 0 }), false);
});
