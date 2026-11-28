import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentSnapshot, EditBatch, StickyNote, TextHighlight } from '../src/runtime/edits/contracts.ts';
import type { EditIntentRepository, EditScope } from '../src/runtime/edits/ports.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { pageExpectation } from '../src/runtime/edits/documentPages.ts';
import { DocumentEditSession, type AnnotationDraftPatch, type AnnotationDraftStart, type AnnotationHighlightSeed } from '../src/features/reader/edit/DocumentEditSession.ts';
import { DocumentEditSessions } from '../src/features/reader/DocumentEditSessions.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const sticky = (): StickyNote => ({ kind: 'sticky', id: crypto.randomUUID(), text: 'original', anchor: { x: 72, y: 144 },
  color: null, quote: 'unchanged exact quote', metadata: { label: 'classification', createdAt: '2020-01-02T03:04:05.123456Z' } });
async function setup(wrap: (repository: EditIntentRepository) => EditIntentRepository = value => value, document: DocumentSnapshot = fixture.document) {
  const repository = new DurableEditRepository({ accountId: 'annotation-form', libraryId: fixture.libraryId, epoch: 'one' }, new EditMemoryDatabase(),
    { inspectPdf: async () => structuredClone(fixture.resource.metadata.pdfPages) });
  if (document.pages.some(page => page.background.kind === 'pdf')) {
    await repository.storeResource({ id: fixture.resource.metadata.id, sha256: fixture.resource.metadata.sha256, mediaType: 'application/pdf',
      bytes: Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url))) });
  }
  await repository.initialize(document); let active = true;
  const session = new DocumentEditSession(wrap(repository), document.id, undefined, () => active);
  assert.equal(await session.refresh(), true);
  const pageId: string = document.pages[0].id, token = Symbol('annotation surface'); session.claimPage(pageId, token);
  return { session, repository, pageId, token, active: (next: boolean) => { active = next; },
    draft: () => session.getSnapshot().surfaces[pageId]?.annotationDraft,
    begin: () => session.beginAnnotationDraft(pageId, token, { kind: 'create-sticky', anchor: { x: 50, y: 70 } })! };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('sticky form creation fixes immutable identity/UTC and atomically transfers one draft into the sole pending writer', async () => {
  const f = await setup(), id = f.begin(), draft = f.draft()!;
  assert.ok(id); assert.match(draft.annotation.metadata.createdAt!, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(draft.annotation.color, null); assert.equal(draft.original, null);
  assert.throws(() => { draft.annotation.text = 'mutated'; }, TypeError);
  assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'note', label: 'topic', color: null }), true);
  const states: { phase: string; draft: boolean; input: boolean }[] = [];
  const unsubscribe = f.session.subscribe(() => { const state = f.session.getSnapshot();
    states.push({ phase: state.phase, draft: !!state.surfaces[f.pageId].annotationDraft, input: state.inputActive }); });
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'applied'); unsubscribe();
  assert.deepEqual(states[0], { phase: 'saving', draft: false, input: false });
  assert.equal(f.draft(), null); assert.equal(f.session.canNavigate(), true);
  const saved = f.session.getSnapshot().document!.pages[0].annotations.find(value => value.id === draft.annotation.id);
  assert.deepEqual(saved, { ...draft.annotation, text: 'note', metadata: { ...draft.annotation.metadata, label: 'topic' } });
  const read = await f.repository.read(fixture.document.id); assert.equal(read.checkpoint.batches.length, 1);
});

test('edit and delete use one document history, retaining all attributes, other annotations and exact Undo/Redo', async () => {
  const f = await setup(), original = sticky(), other = sticky();
  await f.session.editPage(f.pageId, f.token, [{ type: 'create', annotation: original }, { type: 'create', annotation: other }]);
  const before = structuredClone(f.session.getSnapshot().document!.pages[0].annotations);
  const id = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-sticky', annotation: original })!;
  assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'changed', label: 'new', anchor: { x: 100, y: 200 } }), true);
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'applied');
  const after = structuredClone(f.session.getSnapshot().document!.pages[0].annotations);
  const edited = after.find(value => value.id === original.id) as StickyNote;
  assert.equal(edited.color, null); assert.equal(edited.quote, original.quote); assert.equal(edited.metadata.createdAt, original.metadata.createdAt);
  assert.deepEqual(after.find(value => value.id === other.id), other);
  await f.session.undo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, before);
  await f.session.redo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, after);
  const deleteId = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-sticky', annotation: edited })!;
  f.session.updateAnnotationDraft(f.pageId, f.token, deleteId, { deleted: true });
  await f.session.commitAnnotationDraft(f.pageId, f.token, deleteId);
  assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [other]);
  await f.session.undo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, after);
  await f.session.redo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [other]);
});

test('annotation form excludes Ink text and gestures, other pages, raw changes, background changes and history', async () => {
  const f = await setup(), otherPage: string = fixture.document.pages[1].id, other = Symbol(); f.session.claimPage(otherPage, other);
  f.session.setInput(f.pageId, f.token, 'drawing'); assert.equal(f.begin(), null); f.session.setInput(f.pageId, f.token, 'idle');
  const textId = crypto.randomUUID(); f.session.beginText(f.pageId, f.token, { id: textId, at: { x: 1, y: 2 }, text: 'ink text' });
  assert.equal(f.begin(), null); f.session.cancelText(f.pageId, f.token);
  const id = f.begin(); assert.ok(id); assert.equal(f.session.getSnapshot().inputActive, true);
  assert.equal(f.session.canEditPage(f.pageId, f.token), false); assert.equal(f.session.canEditPage(otherPage, other), false);
  for (const phase of ['idle', 'drawing', 'text', 'annotation'] as const) assert.equal(f.session.setInput(f.pageId, f.token, phase), false);
  assert.equal(f.session.setInput(otherPage, other, 'drawing'), false);
  assert.equal(f.session.beginText(f.pageId, f.token, { id: textId, at: { x: 1, y: 2 }, text: 'no' }), false);
  assert.equal((await f.session.commitPageInput(f.pageId, f.token, [{ type: 'create', annotation: sticky() }])).status, 'refused');
  assert.equal((await f.session.editPage(f.pageId, f.token, [])).status, 'refused');
  assert.equal((await f.session.editDocument([])).status, 'refused');
  assert.equal((await f.session.undo()).status, 'refused'); assert.equal((await f.session.redo()).status, 'refused');
  assert.equal(await f.session.refresh(), false); assert.equal(f.session.checkout(fixture.document.version), false);
  assert.equal(f.session.canRepositionAnnotationDraft(f.pageId, f.token, id), true);
});

test('release retains form/guard; reclaim rotates only draft ID and rejects old callbacks even with reused owner tokens', async () => {
  for (const reuseToken of [false, true]) {
    const f = await setup(), id = f.begin(); f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'retained' });
    const draft = f.draft()!; f.session.releasePage(f.pageId, f.token);
    assert.strictEqual(f.draft(), draft); assert.equal(f.session.canNavigate(), false); assert.equal(f.session.getSnapshot().inputActive, true);
    assert.equal(f.session.cancelAnnotationDraft(f.pageId, f.token, id), false);
    assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'refused');
    const replacement = reuseToken ? f.token : Symbol('replacement'); assert.equal(f.session.claimPage(f.pageId, replacement), true);
    const resumed = f.draft()!; assert.notEqual(resumed.draftId, id); assert.strictEqual(resumed.annotation, draft.annotation);
    assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'stale callback' }), false);
    assert.equal(f.session.cancelAnnotationDraft(f.pageId, replacement, id), false);
    assert.equal((await f.session.commitAnnotationDraft(f.pageId, replacement, id)).status, 'refused');
    assert.equal(f.session.canRepositionAnnotationDraft(f.pageId, replacement, resumed.draftId), true);
    assert.equal(f.session.cancelAnnotationDraft(f.pageId, replacement, resumed.draftId), true); assert.equal(f.session.canNavigate(), true);
  }
});

test('inactive/wrong owner/old draft callbacks cannot begin, mutate, cancel or commit a retained form', async () => {
  const f = await setup(), id = f.begin(), draft = f.draft()!, other = Symbol();
  for (const token of [other, f.token]) {
    if (token === f.token) f.active(false);
    assert.equal(f.session.updateAnnotationDraft(f.pageId, token, id, { text: 'no' }), false);
    assert.equal(f.session.cancelAnnotationDraft(f.pageId, token, id), false);
    assert.equal((await f.session.commitAnnotationDraft(f.pageId, token, id)).status, 'refused'); assert.strictEqual(f.draft(), draft);
    assert.equal(f.session.beginAnnotationDraft(f.pageId, token, { kind: 'create-sticky', anchor: { x: 1, y: 2 } }), null);
  }
  f.active(true); f.session.cancelAnnotationDraft(f.pageId, f.token, id); const newer = f.begin();
  assert.notEqual(newer, id); assert.equal(f.session.cancelAnnotationDraft(f.pageId, f.token, id), false);
});

test('lost durable reply transfers away the form and retries exactly one fixed sticky operation', async () => {
  const sent: EditBatch[] = []; let lose = true;
  const f = await setup(value => ({ ...value, commit: async (batch, history) => {
    sent.push(structuredClone(batch)); const result = await value.commit(batch, history);
    if (lose) { lose = false; return { status: 'unknown', reason: 'reply-lost' }; } return result;
  } }));
  const id = f.begin(); f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'fixed pending' });
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'applied');
  assert.equal(f.draft(), null); assert.equal(f.session.getSnapshot().phase, 'unknown'); assert.equal(f.session.canNavigate(), false);
  assert.equal(f.session.cancelAnnotationDraft(f.pageId, f.token, id), false); assert.equal(f.begin(), null);
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'refused');
  await f.session.retry(); assert.deepEqual(sent[1], sent[0]); assert.equal(sent.length, 2);
  assert.equal((await f.repository.read(fixture.document.id)).checkpoint.batches.length, 1); assert.equal(f.session.canNavigate(), true);
});

test('new remote content or background changes refuse commit without clearing the original draft', async () => {
  for (const background of [false, true]) {
    const f = await setup(), id = f.begin(), draft = f.draft()!, page = f.session.getSnapshot().document!.pages[0];
    const remote = background ? { kind: 'document' as const, id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: fixture.document.id,
      parents: [fixture.document.version], changes: [{ type: 'replace' as const, expected: pageExpectation(page),
        page: { ...structuredClone(page), background: { kind: 'paper' as const, spec: { template: 'grid5' as const, color: 'white' as const } } } }] }
      : { kind: 'page' as const, id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: fixture.document.id,
        parents: [fixture.document.version], expected: pageExpectation(page), changes: [{ type: 'create' as const, annotation: sticky() }] };
    await f.repository.receive([remote]);
    if (background) {
      const read = await f.repository.read(fixture.document.id), changed = new EditGraph(read.checkpoint).snapshot(remote.id);
      assert.ok(changed?.kind === 'document');
      assert.deepEqual(changed.pages[0].background, { kind: 'paper', spec: { template: 'grid5', color: 'white' } });
      assert.notDeepEqual(changed.pages[0].background, page.background);
      assert.equal(changed.pages[0].backgroundRevision, remote.id); assert.notEqual(changed.pages[0].backgroundRevision, page.backgroundRevision);
    }
    assert.deepEqual(await f.session.commitAnnotationDraft(f.pageId, f.token, id), { status: 'refused', reason: 'annotation-draft-heads-changed' });
    assert.strictEqual(f.draft(), draft); assert.equal(f.session.canNavigate(), false);
    assert.equal((await f.repository.read(fixture.document.id)).checkpoint.batches.length, 1);
  }
});

test('preflight rejection, changing input, owner reclaim and cancellation while reading never publish a stale draft', async () => {
  for (const change of ['fault', 'update', 'reclaim', 'cancel', 'inactive'] as const) {
    let delay = false; const boundary = gate();
    const f = await setup(value => ({ ...value, read: async target => {
      const read = await value.read(target); if (delay) { await boundary.promise; if (change === 'fault') throw new Error('read-offline'); } return read;
    } }));
    const id = f.begin(); delay = true; const commit = f.session.commitAnnotationDraft(f.pageId, f.token, id);
    if (change === 'update') f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'later input' });
    if (change === 'reclaim') { f.session.releasePage(f.pageId, f.token); f.session.claimPage(f.pageId, f.token); }
    if (change === 'cancel') f.session.cancelAnnotationDraft(f.pageId, f.token, id);
    if (change === 'inactive') f.active(false);
    boundary.resolve(); assert.equal((await commit).status, 'refused');
    assert.equal((await f.repository.read(fixture.document.id)).checkpoint.batches.length, 0);
    if (change === 'cancel') assert.equal(f.draft(), null); else assert.ok(f.draft());
  }
});

test('fresh-read admission checks the latest external editability before transferring a form into pending', async () => {
  for (const admitted of [false, true]) {
    let delay = false, allowed = true, calls = 0; const boundary = gate();
    const f = await setup(value => ({ ...value, read: async target => {
      const read = await value.read(target); if (delay) await boundary.promise; return read;
    } }));
    const id = f.begin(); f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'keep when externally deleted' });
    const draft = f.draft(); delay = true;
    const committing = f.session.commitAnnotationDraft(f.pageId, f.token, id, () => { calls++; return allowed; });
    assert.equal(calls, 0); allowed = admitted; boundary.resolve(); const result = await committing;
    assert.equal(calls, 1); assert.equal(result.status, admitted ? 'applied' : 'refused');
    const read = await f.repository.read(fixture.document.id);
    assert.equal(read.checkpoint.batches.length, admitted ? 1 : 0); assert.equal(read.history.length, admitted ? 1 : 0);
    if (!admitted) {
      assert.strictEqual(f.draft(), draft); assert.equal(f.session.getSnapshot().inputActive, true);
      assert.equal(f.session.canNavigate(), false); assert.equal(f.session.getSnapshot().phase, 'idle');
    } else assert.equal(f.draft(), null);
  }
});

test('throwing admission and admission side effects cannot install pending or overwrite a newer owner/form/scope', async () => {
  for (const action of ['throw', 'update', 'reclaim', 'inactive', 'scope'] as const) {
    let scope!: EditScope;
    const f = await setup(value => { scope = { ...value.scope }; return { ...value, scope }; });
    const id = f.begin(), draft = f.draft();
    const result = await f.session.commitAnnotationDraft(f.pageId, f.token, id, () => {
      if (action === 'throw') throw new Error('admission-cancelled');
      if (action === 'update') f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'newer form value' });
      if (action === 'reclaim') { f.session.releasePage(f.pageId, f.token); f.session.claimPage(f.pageId, f.token); }
      if (action === 'inactive') f.active(false);
      if (action === 'scope') scope.epoch = 'other';
      return true;
    });
    assert.equal(result.status, 'refused', action); assert.ok(f.draft());
    if (action === 'throw' || action === 'inactive' || action === 'scope') assert.strictEqual(f.draft(), draft);
    if (action === 'update') assert.equal(f.draft()!.annotation.text, 'newer form value');
    if (action === 'reclaim') assert.notEqual(f.draft()!.draftId, id);
    const read = await f.repository.read(fixture.document.id);
    assert.equal(read.checkpoint.batches.length, 0); assert.equal(read.history.length, 0);
    assert.equal(f.session.getSnapshot().phase, 'idle'); assert.equal(f.session.canNavigate(), false);
  }
});

test('unchanged edits also retain the form when their final admission is refused', async () => {
  const f = await setup(), original = sticky(); await f.session.editPage(f.pageId, f.token, [{ type: 'create', annotation: original }]);
  const before = await f.repository.read(fixture.document.id);
  const id = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-sticky', annotation: original })!, draft = f.draft();
  assert.deepEqual(await f.session.commitAnnotationDraft(f.pageId, f.token, id, () => false), { status: 'refused', reason: 'annotation-draft-admission' });
  assert.strictEqual(f.draft(), draft); assert.deepEqual(await f.repository.read(fixture.document.id), before);
});

test('forged edit candidates or update claims do not change the retained internal payload', async () => {
  const f = await setup(), original = sticky(); await f.session.editPage(f.pageId, f.token, [{ type: 'create', annotation: original }]);
  assert.equal(f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-sticky', annotation: { ...original, text: 'forged' } }), null);
  const id = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-sticky', annotation: original })!, draft = f.draft();
  for (const patch of [{ id: crypto.randomUUID() }, { quote: 'rewritten' }, { expected: {} }, { metadata: { label: 'unlimited' } }, { createdAt: null }]) {
    assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, patch as AnnotationDraftPatch), false); assert.strictEqual(f.draft(), draft);
  }
});

test('unchanged edits and cancelled creations allocate no durable history operation', async () => {
  const f = await setup(), original = sticky(); await f.session.editPage(f.pageId, f.token, [{ type: 'create', annotation: original }]);
  const before = await f.repository.read(fixture.document.id);
  const id = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-sticky', annotation: original })!;
  assert.deepEqual(await f.session.commitAnnotationDraft(f.pageId, f.token, id), { status: 'unchanged' });
  const created = f.begin(); f.session.updateAnnotationDraft(f.pageId, f.token, created, { deleted: true });
  assert.deepEqual(await f.session.commitAnnotationDraft(f.pageId, f.token, created), { status: 'unchanged' });
  assert.deepEqual(await f.repository.read(fixture.document.id), before); assert.equal(f.session.canNavigate(), true);
});

test('registry exit and suspend guards include an ownerless uncommitted annotation form', async () => {
  const f = await setup(), registry = new DocumentEditSessions(f.repository); await registry.initialize();
  const session = registry.get(fixture.document.id); await session.refresh(); const token = Symbol(); session.claimPage(f.pageId, token);
  const id = session.beginAnnotationDraft(f.pageId, token, { kind: 'create-sticky', anchor: { x: 20, y: 30 } })!;
  session.releasePage(f.pageId, token); assert.equal(registry.needsExitConfirmation(), true);
  assert.equal((await registry.prepareLeave()).status, 'refused'); assert.equal((await registry.suspend()).status, 'refused');
  session.claimPage(f.pageId, token); const resumed = session.getSnapshot().surfaces[f.pageId].annotationDraft!;
  assert.notEqual(resumed.draftId, id); session.cancelAnnotationDraft(f.pageId, token, resumed.draftId);
  assert.equal((await registry.prepareLeave()).status, 'allowed');
});

async function setupPdf(wrap: (repository: EditIntentRepository) => EditIntentRepository = value => value) {
  const document = structuredClone(fixture.document) as DocumentSnapshot;
  const physical = fixture.resource.metadata.pdfPages[0];
  document.pages[0].widthPt = physical.widthPt; document.pages[0].heightPt = physical.heightPt;
  document.pages[0].background = { kind: 'pdf', resourceId: fixture.resource.metadata.id, sourceRevision: fixture.resource.metadata.sha256, pdfPage: 1 };
  return setup(wrap, document);
}
function seedFor(f: Awaited<ReturnType<typeof setup>>): AnnotationHighlightSeed {
  return { backgroundRevision: f.session.getSnapshot().document!.pages[0].backgroundRevision,
    quote: 'fixed selected text', range: { kind: 'unindexed' }, anchor: { x: 50, y: 70 },
    quads: [[{ x: 50, y: 70 }, { x: 150, y: 70 }, { x: 150, y: 84 }, { x: 50, y: 84 }]] };
}
const beginHighlight = (f: Awaited<ReturnType<typeof setup>>, seed = seedFor(f)) =>
  f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'create-highlight', seed });

test('highlight creation retains canonical geometry independently of seed changes and transfers once to document history', async () => {
  const f = await setupPdf(), seed = seedFor(f), before = structuredClone(seed), id = beginHighlight(f, seed)!;
  const draft = f.draft()!; assert.ok(id); assert.ok(draft.annotation.kind === 'highlight');
  assert.match(draft.annotation.metadata.createdAt!, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(draft.annotation.color, '#facc15'); assert.notEqual(draft.annotation.id, id);
  assert.throws(() => { draft.annotation.anchor.x = 0; }, TypeError);
  seed.quote = 'later DOM selection'; seed.backgroundRevision = crypto.randomUUID(); seed.quads = [];
  // Deliberately bypass the creation type after admission; the retained draft must stay independent.
  Object.assign(seed, { range: { kind: 'indexed', start: 1, end: 10 } });
  assert.deepEqual(draft.annotation, { kind: 'highlight', id: draft.annotation.id, text: '', color: '#facc15',
    ...before, metadata: draft.annotation.metadata });
  assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'comment', label: 'topic', anchor: { x: 200, y: 300 } }), true);
  assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, { color: null }), false);
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id, () => true)).status, 'applied');
  const saved = f.session.getSnapshot().document!.pages[0].annotations[0];
  assert.deepEqual(saved, { ...draft.annotation, text: 'comment', anchor: { x: 200, y: 300 }, metadata: { ...draft.annotation.metadata, label: 'topic' } });
  assert.equal(f.draft(), null); const read = await f.repository.read(fixture.document.id);
  assert.equal(read.checkpoint.batches.length, 1); assert.equal(read.history.length, 1); assert.equal(await f.repository.readIntent(fixture.document.id), undefined);
  await f.session.undo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, []);
  await f.session.redo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [saved]);
});

test('paper highlight editing and deletion retain indexed geometry and use exact shared Undo/Redo', async () => {
  const f = await setup(), seed = seedFor(f), other = sticky();
  const original: TextHighlight = { kind: 'highlight', id: crypto.randomUUID(), text: 'existing comment', ...seed,
    range: { kind: 'indexed', start: 100, end: 119 }, quads: seed.quads.map(quad => quad.map(point => ({ ...point }))),
    color: '#60a5fa', metadata: { label: 'existing', createdAt: null } };
  await f.session.editPage(f.pageId, f.token, [{ type: 'create', annotation: original }, { type: 'create', annotation: other }]);
  const id = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-highlight', annotation: original })!;
  assert.ok(id); const retained = f.draft();
  for (const patch of [{ quote: 'forged' }, { range: { kind: 'unindexed' } }, { quads: [] }, { backgroundRevision: crypto.randomUUID() }, { color: null }]) {
    assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, patch as AnnotationDraftPatch), false); assert.strictEqual(f.draft(), retained);
  }
  f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'changed', label: 'new', color: '#f87171', anchor: { x: 250, y: 350 } });
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'applied');
  const changed = { ...original, text: 'changed', color: '#f87171', anchor: { x: 250, y: 350 }, metadata: { ...original.metadata, label: 'new' } };
  assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [changed, other]);
  await f.session.undo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [original, other]);
  await f.session.redo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [changed, other]);
  const deleteId = f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-highlight', annotation: changed })!;
  f.session.updateAnnotationDraft(f.pageId, f.token, deleteId, { deleted: true });
  await f.session.commitAnnotationDraft(f.pageId, f.token, deleteId); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [other]);
  await f.session.undo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [changed, other]);
  await f.session.redo(); assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [other]);
});

test('invalid highlights, unsupported creation, wrong kind, readonly and owner rejection allocate no draft, history or journal', async () => {
  for (const pdf of [false, true]) {
    let journalWrites = 0;
    const wrap = (value: EditIntentRepository): EditIntentRepository => ({ ...value, replaceIntent: async (...args) => { journalWrites++; return value.replaceIntent(...args); } });
    const f = await (pdf ? setupPdf(wrap) : setup(wrap)), seed = seedFor(f);
    if (!pdf) assert.equal(beginHighlight(f), null);
    for (const badSeed of [{ ...seed, quads: [] }, { ...seed, quads: [[{ x: NaN, y: 2 }]] },
      { ...seed, backgroundRevision: crypto.randomUUID() }, { ...seed, range: { kind: 'indexed', start: 10, end: 2 } },
      { ...seed, renderToken: {} }, { ...seed, admissionEvidence: {} }, { ...seed, id: crypto.randomUUID() }])
      assert.equal(f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'create-highlight', seed: badSeed } as AnnotationDraftStart), null);
    assert.equal(f.session.beginAnnotationDraft(f.pageId, f.token, { kind: 'edit-highlight', annotation: sticky() } as unknown as AnnotationDraftStart), null);
    assert.equal(f.session.beginAnnotationDraft(f.pageId, Symbol(), { kind: 'create-highlight', seed }), null);
    f.active(false); assert.equal(beginHighlight(f), null); f.active(true);
    assert.equal(f.draft(), undefined); assert.equal(f.session.getSnapshot().inputActive, false); assert.equal(f.session.canNavigate(), true);
    const read = await f.repository.read(fixture.document.id);
    assert.equal(read.checkpoint.batches.length, 0); assert.equal(read.history.length, 0); assert.equal(journalWrites, 0);
    assert.equal(await f.repository.readIntent(fixture.document.id), undefined);
  }
});

test('valid indexed highlight creation is refused without draft, pending, durable history or journal side effects', async () => {
  let journalWrites = 0;
  const f = await setupPdf(value => ({ ...value, replaceIntent: async (...args) => { journalWrites++; return value.replaceIntent(...args); } }));
  const state = f.session.getSnapshot(), before = await f.repository.read(fixture.document.id);
  const input = { kind: 'create-highlight', seed: { ...seedFor(f), range: { kind: 'indexed', start: 3, end: 22 } } };
  assert.equal(f.session.beginAnnotationDraft(f.pageId, f.token, input as unknown as AnnotationDraftStart), null);
  assert.strictEqual(f.session.getSnapshot(), state); assert.equal(f.draft(), undefined);
  assert.equal(f.session.canNavigate(), true); assert.equal(f.session.getSnapshot().phase, 'idle');
  assert.equal(journalWrites, 0); assert.equal(await f.repository.readIntent(fixture.document.id), undefined);
  assert.deepEqual(await f.repository.read(fixture.document.id), before);
});

test('highlight reclaim rejects stale callbacks and refused final admission retains geometry without writer or journal growth', async () => {
  let journalWrites = 0;
  const f = await setupPdf(value => ({ ...value, replaceIntent: async (...args) => { journalWrites++; return value.replaceIntent(...args); } }));
  const id = beginHighlight(f)!, draft = f.draft()!; f.session.releasePage(f.pageId, f.token);
  assert.equal(f.session.canNavigate(), false); assert.strictEqual(f.draft(), draft);
  assert.equal(f.session.claimPage(f.pageId, f.token), true); const resumed = f.draft()!;
  assert.notEqual(resumed.draftId, id); assert.strictEqual(resumed.annotation, draft.annotation);
  assert.equal(f.session.updateAnnotationDraft(f.pageId, f.token, id, { text: 'old' }), false);
  assert.equal(f.session.cancelAnnotationDraft(f.pageId, f.token, id), false);
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id)).status, 'refused');
  assert.deepEqual(await f.session.commitAnnotationDraft(f.pageId, f.token, resumed.draftId, () => false), { status: 'refused', reason: 'annotation-draft-admission' });
  assert.strictEqual(f.draft(), resumed); assert.equal(journalWrites, 0);
  const read = await f.repository.read(fixture.document.id); assert.equal(read.checkpoint.batches.length, 0); assert.equal(read.history.length, 0);
  assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, resumed.draftId, () => true)).status, 'applied');
  assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [resumed.annotation]);
});

test('highlight lost-reply retry keeps one fixed pending payload, identity, timestamp and canonical geometry', async () => {
  const sent: EditBatch[] = []; let lose = true;
  const f = await setupPdf(value => ({ ...value, commit: async (batch, history) => {
    sent.push(structuredClone(batch)); const result = await value.commit(batch, history);
    if (lose) { lose = false; return { status: 'unknown', reason: 'reply-lost' }; } return result;
  } }));
  const id = beginHighlight(f)!, draft = f.draft()!;
  await f.session.commitAnnotationDraft(f.pageId, f.token, id); assert.equal(f.draft(), null);
  assert.equal(f.session.getSnapshot().phase, 'unknown'); assert.equal(f.session.cancelAnnotationDraft(f.pageId, f.token, id), false);
  const intent = await f.repository.readIntent(fixture.document.id); assert.ok(intent);
  assert.equal(beginHighlight(f), null); await f.session.retry(); assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [draft.annotation]);
  const read = await f.repository.read(fixture.document.id); assert.equal(read.checkpoint.batches.length, 1); assert.equal(read.history.length, 1);
  assert.equal(await f.repository.readIntent(fixture.document.id), undefined);
});

test('remote PDF content/background changes refuse highlight commit and retain the original admitted canonical draft', async () => {
  for (const background of [false, true]) {
    const f = await setupPdf(), id = beginHighlight(f)!, draft = f.draft()!, document = f.session.getSnapshot().document!, page = document.pages[0];
    assert.ok(page.background.kind === 'pdf');
    const remote: EditBatch = background ? { kind: 'document', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: document.id,
      parents: [document.version], changes: [{ type: 'replace', expected: pageExpectation(page),
        page: { ...page, ...fixture.resource.metadata.pdfPages[1], background: { ...page.background, pdfPage: 2 } } }] }
      : { kind: 'page', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: document.id, parents: [document.version],
        expected: pageExpectation(page), changes: [{ type: 'create', annotation: sticky() }] };
    await f.repository.receive([remote]); const before = await f.repository.read(document.id);
    if (background) {
      const changed = new EditGraph(before.checkpoint).snapshot(remote.id); assert.ok(changed?.kind === 'document');
      assert.deepEqual(changed.pages[0].background, { ...page.background, pdfPage: 2 });
      assert.equal(changed.pages[0].widthPt, fixture.resource.metadata.pdfPages[1].widthPt);
      assert.equal(changed.pages[0].heightPt, fixture.resource.metadata.pdfPages[1].heightPt);
      assert.notDeepEqual(changed.pages[0].background, page.background);
      assert.equal(changed.pages[0].backgroundRevision, remote.id); assert.notEqual(changed.pages[0].backgroundRevision, page.backgroundRevision);
    }
    assert.equal((await f.session.commitAnnotationDraft(f.pageId, f.token, id, () => true)).status, 'refused');
    assert.strictEqual(f.draft(), draft); assert.equal(f.session.canNavigate(), false);
    assert.deepEqual(await f.repository.read(document.id), before); assert.equal(await f.repository.readIntent(document.id), undefined);
  }
});


test('highlight journal failure retains pending highlight and existing ink until same-ID retry', async () => {
  let fail = false, injected = 0;
  const sent: EditBatch[] = [];
  const f = await setupPdf(value => ({ ...value, replaceIntent: async (...args) => {
    if (fail) { injected++; throw new Error('injected-journal-failure'); }
    return value.replaceIntent(...args);
  }, commit: async (batch, history) => { sent.push(structuredClone(batch)); return value.commit(batch, history); } }));
  const ink = { kind: 'ink' as const, id: crypto.randomUUID(),
    geometry: { kind: 'arrow' as const, start: { x: 0, y: 0 }, end: { x: 85, y: 25 }, head: 'both' as const, headLengthPt: 12, preferredHeadLengthPt: 17 },
    transform: { x: 35, y: 80, rotationRad: .17, scaleX: 1.3, scaleY: .7 },
    style: { color: '#345678', widthPt: 3.25, opacity: .61, highlighter: false } };
  assert.equal((await f.session.commitPageInput(f.pageId, f.token, [{ type: 'create', annotation: ink }])).status, 'applied');
  const before = await f.repository.read(fixture.document.id), beforeDocument = structuredClone(f.session.getSnapshot().document);
  assert.equal(before.history.length, 1); assert.deepEqual(beforeDocument!.pages[0].annotations, [ink]);
  sent.length = 0;
  const id = beginHighlight(f); assert.ok(id); const pendingHighlight = structuredClone(f.draft()!.annotation); fail = true;
  const result = await f.session.commitAnnotationDraft(f.pageId, f.token, id);
  assert.equal(result.status, 'applied'); if (result.status !== 'applied') throw new Error('highlight-not-admitted');
  const after = await f.repository.read(fixture.document.id), state = f.session.getSnapshot();
  assert.equal(injected, 1); assert.equal(sent.length, 0);
  assert.deepEqual(after.checkpoint, before.checkpoint); assert.deepEqual(after.history, before.history);
  assert.equal(state.phase, 'aborted'); assert.match(state.error, /injected-journal-failure/); assert.equal(f.session.canNavigate(), false);
  assert.equal(f.draft(), null); assert.equal(state.document!.version, result.operationId);
  assert.deepEqual(state.document!.pages[0].annotations, [ink, pendingHighlight]);
  assert.equal(await f.repository.readIntent(fixture.document.id), undefined);
  fail = false; await f.session.retry();
  assert.equal(sent.length, 1); assert.equal(sent[0].id, result.operationId);
  const saved = await f.repository.read(fixture.document.id);
  assert.equal(saved.history.length, before.history.length + 1);
  assert.deepEqual(f.session.getSnapshot().document!.pages[0].annotations, [ink, pendingHighlight]);
  assert.equal(f.session.getSnapshot().phase, 'idle'); assert.equal(f.session.canNavigate(), true);
});
