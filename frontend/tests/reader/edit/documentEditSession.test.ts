import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DocumentEditSession } from '../../../src/features/reader/edit/DocumentEditSession.ts';
import { DocumentEditSessions } from '../../../src/features/reader/DocumentEditSessions.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import type { CommitResult, EditIntentRepository } from '../../../src/runtime/edits/ports.ts';
import type { AnnotationChange, EditBatch, InkObject, PageEditBatch } from '../../../src/runtime/edits/contracts.ts';
import { pageExpectation } from '../../../src/runtime/edits/documentPages.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const annotation: InkObject = fixture.batches[0].changes[0].annotation;

test('document resolution uses the target journal, survives unknown restart, and keeps late heads', async () => {
  let lose = true; const attempts: string[] = [];
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'session' }, new EditMemoryDatabase());
  await repository.initialize(fixture.document);
  const first: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  const second: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  await repository.receive([first, second]);
  const commit = repository.commit.bind(repository);
  repository.commit = async (batch, history) => {
    if (batch.kind === 'resolution') { attempts.push(batch.id); const result = await commit(batch, history); if (lose) { lose = false; return { status: 'unknown', reason: 'lost reply' }; } return result; }
    return commit(batch, history);
  };
  const session = new DocumentEditSession(repository, fixture.document.id); assert.equal(await session.refresh(), true);
  assert.equal(session.checkout(first.id), true); const heads = [...session.getSnapshot().heads];
  assert.equal(session.conflictVersions().length, 2); assert.equal(await session.resolveConflict(first.id, heads), false);
  assert.equal(session.canNavigate(), false);
  const registry = new DocumentEditSessions(repository); await registry.initialize();
  assert.deepEqual(registry.getSnapshot().unhandledTargets, []);
  const recovered = registry.get(fixture.document.id); assert.equal(recovered.getSnapshot().ready, true);
  assert.equal(recovered.canNavigate(), false); await recovered.retry(); assert.equal(recovered.canNavigate(), true);
  assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]); assert.equal(recovered.getSnapshot().canUndo, false);
  const late: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  await repository.receive([late]); await recovered.refresh(); assert.equal(recovered.getSnapshot().heads.length, 2);
});

test('document resolution rejects a newly arrived head and keeps all branches', async () => {
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'session' }, new EditMemoryDatabase());
  await repository.initialize(fixture.document);
  const first: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  const second: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  const late: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  await repository.receive([first, second]); const commit = repository.commit.bind(repository); let inject = true;
  repository.commit = async (batch, history) => { if (batch.kind === 'resolution' && inject) { inject = false; await repository.receive([late]); } return commit(batch, history); };
  const session = new DocumentEditSession(repository, fixture.document.id); await session.refresh(); session.checkout(first.id);
  assert.equal(await session.resolveConflict(first.id, session.getSnapshot().heads), false);
  assert.equal(session.canNavigate(), false); assert.equal(session.canDiscardRejectedResolution(), true);
  assert.equal(await session.discardRejectedResolution(), true); assert.equal(session.getSnapshot().heads.length, 3);
  assert.deepEqual((await repository.read(fixture.document.id)).heads.sort(), [first.id, second.id, late.id].sort());
});

test('cold multihead document can compare and explicitly choose without adopting a winner', async () => {
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'session' }, new EditMemoryDatabase());
  await repository.initialize(fixture.document);
  const first: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  const second: PageEditBatch = { ...structuredClone(fixture.batches[0]), id: crypto.randomUUID() };
  await repository.receive([first, second]); const session = new DocumentEditSession(repository, fixture.document.id);
  assert.equal(await session.refresh(), true); assert.equal(session.getSnapshot().document, null);
  assert.equal(session.canNavigate(), true); assert.equal(session.conflictVersions().length, 2);
  assert.equal(session.checkout(first.id), true); assert.equal(session.getSnapshot().selectedVersion, first.id);
  assert.deepEqual((await repository.read(fixture.document.id)).heads.sort(), [first.id, second.id].sort());
});
async function setup(wrap: (repository: EditIntentRepository) => EditIntentRepository = value => value) {
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'session' }, new EditMemoryDatabase());
  await repository.initialize(fixture.document);
  const session = new DocumentEditSession(wrap(repository), fixture.document.id);
  assert.equal(await session.refresh(), true);
  const token = Symbol('surface'), pageId = fixture.document.pages[0].id;
  assert.equal(session.claimPage(pageId, token), true);
  return { repository, session, token, pageId };
}

test('one session carries ink, page copy, and another page edit through one durable Undo/Redo history', async () => {
  const { repository, session, token, pageId } = await setup();
  assert.equal((await session.editPage(pageId, token, [{ type: 'create', annotation }])).status, 'applied');
  const copy = structuredClone(session.getSnapshot().document!.pages[0]); copy.id = crypto.randomUUID();
  copy.annotations = copy.annotations.map(value => ({ ...value, id: crypto.randomUUID() }));
  assert.equal((await session.editDocument([{ type: 'insert', index: 1, page: copy }])).status, 'applied');
  const second = Symbol('second'); session.claimPage(copy.id, second);
  const extra = { ...structuredClone(annotation), id: crypto.randomUUID() };
  await session.editPage(copy.id, second, [{ type: 'create', annotation: extra }]);
  assert.equal(session.getSnapshot().document!.pages[1].annotations.length, 2);
  await session.undo(); assert.equal(session.getSnapshot().document!.pages[1].annotations.length, 1);
  await session.undo(); assert.equal(session.getSnapshot().document!.pages.length, 2);
  await session.undo(); assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
  const remounted = new DocumentEditSession(repository, fixture.document.id); await remounted.refresh();
  assert.equal(remounted.getSnapshot().canRedo, true); assert.equal(remounted.getSnapshot().canUndo, false);
  await remounted.redo(); await remounted.redo(); await remounted.redo();
  assert.equal(remounted.getSnapshot().document!.pages[1].annotations.length, 2);
  assert.ok(remounted.getSnapshot().affectedPages.includes(copy.id));
});

test('response loss plus Undo preserves the original until same-ID acceptance and a durable inverse', async () => {
  let release!: (result: CommitResult) => void, first = true;
  const sent: EditBatch[] = [];
  const { repository, session, token, pageId } = await setup(value => ({ ...value, commit: async (batch, history) => {
    sent.push(structuredClone(batch));
    const result = await value.commit(batch, history);
    if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
    return result;
  } }));
  const saving = session.editPage(pageId, token, [{ type: 'create', annotation }]);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(session.canNavigate(), false); assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1);
  const undoing = session.undo(); release({ status: 'unknown', reason: 'response-lost' });
  await saving; await undoing;
  assert.equal(session.getSnapshot().phase, 'unknown');
  assert.equal(await session.refresh(), false);
  await session.retry();
  assert.deepEqual(sent[0], sent[1]); assert.equal(sent.length, 3);
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
  assert.equal(session.canNavigate(), true);
  const restart = new DocumentEditSession(repository, fixture.document.id); await restart.refresh();
  assert.equal(restart.getSnapshot().canRedo, true);
  await restart.redo(); assert.equal(restart.getSnapshot().document!.pages[0].annotations[0].id, annotation.id);
});

test('save failure keeps content and blocks transitions; exact retry repairs durability without a second operation', async () => {
  let fail = true;
  const { session, token, pageId } = await setup(value => ({ ...value,
    commit: (batch, history) => fail ? Promise.resolve({ status: 'aborted', reason: 'disk-full' }) : value.commit(batch, history),
  }));
  const result = await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  assert.equal(result.status, 'applied'); assert.equal(session.getSnapshot().phase, 'aborted');
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1);
  assert.equal(session.canNavigate(), false);
  assert.deepEqual(await session.editDocument([]), { status: 'refused', reason: 'pending-save' });
  fail = false; await session.retry(); assert.equal(session.getSnapshot().phase, 'idle');
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1); assert.equal(session.getSnapshot().canUndo, true);
});

test('owner tokens and input phases prevent stale edits, double ownership and navigation during drawing or text', async () => {
  const { session, token, pageId } = await setup(), other = Symbol('stale');
  assert.throws(() => session.getSnapshot().document!.pages.splice(0, 1), TypeError);
  assert.equal(session.claimPage(pageId, other), false);
  assert.deepEqual(await session.editPage(pageId, other, []), { status: 'refused', reason: 'editor-owner' });
  session.setInput(pageId, token, 'drawing'); session.releasePage(pageId, other);
  assert.equal(session.claimPage(pageId, token), true);
  assert.equal(session.canNavigate(), false);
  assert.deepEqual(await session.editDocument([]), { status: 'refused', reason: 'input-active' });
  session.setInput(pageId, token, 'text'); assert.equal(session.canNavigate(), false);
  session.releasePage(pageId, token); assert.equal(session.canNavigate(), true);
  assert.equal(session.setInput(pageId, token, 'idle'), false);
  assert.deepEqual(await session.editDocument([{ type: 'move', expected: pageExpectation(session.getSnapshot().document!.pages[0]), index: 0 }]), { status: 'unchanged' });
});

test('an external branch never replaces a pending preview or becomes an automatic adoption', async () => {
  const { repository, session, token, pageId } = await setup();
  const remote: PageEditBatch = { ...fixture.batches[0], id: crypto.randomUUID(), expected: { ...fixture.batches[0].expected, pageId: fixture.document.pages[1].id } };
  await repository.receive([remote]);
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  assert.equal(session.getSnapshot().heads.length, 2);
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1);
  assert.equal(session.setInput(pageId, token, 'drawing'), false, 'unresolved branches cannot accept an uncommittable gesture');
  assert.deepEqual(await session.editPage(pageId, token, []), { status: 'refused', reason: 'checkout-required' });
  assert.equal(session.checkout(session.getSnapshot().document!.version), true);
  await session.refresh(session.getSnapshot().document!.version);
  assert.equal((await session.editPage(pageId, token, [{ type: 'delete', id: annotation.id }])).status, 'applied');
  assert.equal(session.getSnapshot().heads.length, 2);
});

for (const phase of ['drawing', 'text'] as const) {
  test(`remote refresh cannot replace the ${phase} input base, including a read already in flight`, async () => {
    let holdRead = false, release!: () => void, entered!: () => void;
    const readStarted = new Promise<void>(resolve => { entered = resolve; });
    const readGate = new Promise<void>(resolve => { release = resolve; });
    const { repository, session, token, pageId } = await setup(value => ({ ...value, read: async id => {
      const result = await value.read(id);
      if (holdRead) { entered(); await readGate; }
      return result;
    } }));
    const initial = session.getSnapshot().document!.version;
    const remote: PageEditBatch = { ...fixture.batches[0], id: crypto.randomUUID() };
    await repository.receive([remote]);
    assert.equal(session.setInput(pageId, token, phase), true);
    assert.equal(await session.refresh(), false);
    assert.equal(session.getSnapshot().document!.version, initial);
    session.setInput(pageId, token, 'idle');
    holdRead = true;
    const refreshing = session.refresh(); await readStarted;
    session.setInput(pageId, token, phase);
    session.setInput(pageId, token, 'idle');
    release();
    assert.equal(await refreshing, false, 'a completed input still invalidates an older read');
    assert.equal(session.getSnapshot().document!.version, initial);
    holdRead = false;
    assert.equal(await session.refresh(), true);
    assert.equal(session.getSnapshot().document!.version, remote.id);
  });
}

for (const failPoll of [false, true]) {
  test(`pending Undo keeps its inverse selection through a superseding poll${failPoll ? ' and a read failure' : ''}`, async () => {
    let releaseCommit!: () => void, commitEntered!: () => void, readEntered!: () => void;
    const commitStarted = new Promise<void>(resolve => { commitEntered = resolve; });
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
    const reads: { resolve(): void; reject(error: Error): void }[] = [];
    let firstCommit = true, holdRead = false, inverseId = '';
    const { repository, session, token, pageId } = await setup(value => ({ ...value,
      commit: async (batch, history) => {
        const result = await value.commit(batch, history);
        if (history?.action?.kind === 'undo') inverseId = batch.id;
        if (firstCommit) { firstCommit = false; commitEntered(); await commitGate; }
        return result;
      },
      read: async id => {
        const result = await value.read(id);
        if (holdRead) {
          await new Promise<void>((resolve, reject) => { reads.push({ resolve, reject }); readEntered(); });
        }
        return result;
      },
    }));
    const saving = session.editPage(pageId, token, [{ type: 'create', annotation }]);
    await commitStarted;
    await repository.receive([{ ...fixture.batches[0], id: crypto.randomUUID(),
      changes: [{ type: 'create', annotation: { ...annotation, id: crypto.randomUUID() } }] }]);
    const undoing = session.undo();
    holdRead = true; releaseCommit(); await readStarted;
    assert.equal(session.getSnapshot().ready, false);
    assert.equal(session.canNavigate(), true);
    const pollStarted = new Promise<void>(resolve => { readEntered = resolve; });
    const poll = session.refresh(); await pollStarted;
    reads[0].resolve(); await saving; await undoing;
    if (failPoll) reads[1].reject(new Error('temporary read failure'));
    else reads[1].resolve();
    assert.equal(await poll, !failPoll);
    holdRead = false;
    assert.equal(await session.refresh(), true);
    assert.equal(session.getSnapshot().heads.length, 2);
    assert.ok(session.getSnapshot().heads.includes(inverseId));
    assert.equal(session.getSnapshot().selectedVersion, inverseId);
    assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
    assert.equal(session.getSnapshot().canRedo, true);
  });
}

test('explicit checkout cancels an in-flight preferred selection and its retry intent', async () => {
  let holdRead = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { repository, session, token, pageId } = await setup(value => ({ ...value, read: async id => {
    const result = await value.read(id);
    if (holdRead) { entered(); await gate; }
    return result;
  } }));
  const root = session.getSnapshot().selectedVersion!;
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  const local = session.getSnapshot().selectedVersion!;
  await repository.receive([{ ...fixture.batches[0], id: crypto.randomUUID() }]);
  holdRead = true;
  const refreshing = session.refresh(local); await started;
  assert.equal(session.checkout(root), true);
  release(); assert.equal(await refreshing, false);
  assert.equal(session.getSnapshot().selectedVersion, root);
  holdRead = false;
  assert.equal(await session.refresh(), true);
  assert.equal(session.getSnapshot().selectedVersion, root, 'default polling must not resurrect the cancelled preferred selection');
});

function textAnnotation(id: string, text = 'draft text'): InkObject {
  return { ...structuredClone(annotation), id,
    geometry: { kind: 'text', text, widthPt: 120, heightPt: 24, fontSizePt: 12, fontFamily: 'sans-serif' } };
}

for (const rejectRead of [false, true]) test(`guarded refresh cancellation preserves selected branch and history${rejectRead ? ' on read failure' : ''}`, async () => {
  let hold = false, cancel = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { repository, session, token, pageId } = await setup(value => ({ ...value, read: async id => {
    const result = await value.read(id);
    if (hold) { entered(); await gate; if (rejectRead) throw new Error('late failure'); }
    return result;
  } }));
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  const selected = session.getSnapshot().selectedVersion!, remote = { ...fixture.batches[0], id: crypto.randomUUID() };
  await repository.receive([remote]); await session.refresh();
  const before = session.getSnapshot(); hold = true;
  const refreshing = session.refresh(remote.id, () => !cancel); await started;
  cancel = true; release(); assert.equal(await refreshing, false);
  assert.equal(session.getSnapshot(), before, 'no state, error or history notification for the canceled read');
  hold = false; assert.equal(await session.refresh(), true);
  assert.equal(session.getSnapshot().selectedVersion, selected, 'canceled preference cannot survive into default poll');
  assert.equal(session.getSnapshot().canUndo, true);
});

test('guarded refresh refuses a former head before adopting its document or history', async () => {
  const { session, token, pageId } = await setup();
  const ancestor = session.getSnapshot().selectedVersion!;
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  const before = session.getSnapshot();
  assert.equal(await session.refresh(ancestor, (document, heads) => {
    assert.equal(document?.version, ancestor); assert.equal(Object.isFrozen(document), true);
    return heads.includes(ancestor);
  }), false);
  assert.equal(session.getSnapshot(), before);
  assert.equal(await session.refresh(), true); assert.equal(session.getSnapshot().selectedVersion, before.selectedVersion);
  assert.equal(session.getSnapshot().canUndo, true);
});

test('guarded refresh leaves a newly discovered recovery intent raw and does not install its pending preview', async () => {
  const { repository, session, pageId } = await setup();
  const before = session.getSnapshot();
  const writer = new DocumentEditSession({ ...repository, commit: async () => ({ status: 'aborted', reason: 'offline' }) }, fixture.document.id);
  await writer.refresh(); const owner = Symbol('writer'); writer.claimPage(pageId, owner);
  await writer.editPage(pageId, owner, [{ type: 'create', annotation }]);
  const raw = await repository.readIntent(fixture.document.id); assert.ok(raw);
  let called = false;
  assert.equal(await session.refresh(before.selectedVersion!, () => { called = true; return true; }), false);
  assert.equal(called, false); assert.equal(session.getSnapshot(), before);
  assert.deepEqual(await repository.readIntent(fixture.document.id), raw);
  assert.equal(await session.refresh(), true); assert.equal(session.getSnapshot().phase, raw.intent.dispatched ? 'unknown' : 'aborted');
});

test('guarded refresh adopts an admitted current branch and rechecks generation after the callback', async () => {
  const { repository, session, token, pageId } = await setup();
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  const local = session.getSnapshot().selectedVersion!, remote = { ...fixture.batches[0], id: crypto.randomUUID() };
  await repository.receive([remote]); await session.refresh();
  assert.equal(await session.refresh(remote.id, (document, heads) => document?.version === remote.id && heads.includes(remote.id)), true);
  assert.equal(session.getSnapshot().selectedVersion, remote.id);
  assert.equal(await session.refresh(remote.id, () => { session.checkout(local); return true; }), false);
  assert.equal(session.getSnapshot().selectedVersion, local);
});

test('selection and text draft survive surface release, keep navigation guarded, and resume under a new owner', async () => {
  const { session, token, pageId } = await setup();
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  assert.equal(session.setSelection(pageId, token, [annotation.id]), true);
  const id = crypto.randomUUID(), baseVersion = session.getSnapshot().selectedVersion;
  assert.equal(session.beginText(pageId, token, { id, at: { x: 72, y: 144 }, text: 'first' }), true);
  assert.equal(session.updateText(pageId, token, 'retained draft'), true);
  assert.equal(session.setInput(pageId, token, 'idle'), false);
  assert.equal(session.setInput(pageId, token, 'drawing'), false);
  session.releasePage(pageId, token);
  assert.equal(session.getSnapshot().inputActive, true);
  assert.equal(session.canNavigate(), false);
  assert.equal(await session.refresh(), false);
  const replacement = Symbol('remounted');
  assert.equal(session.claimPage(pageId, replacement), true);
  assert.equal(session.claimPage(pageId, token), false);
  assert.equal(session.updateText(pageId, token, 'stale owner'), false);
  assert.equal(session.cancelText(pageId, token), false);
  assert.equal(session.setSelection(pageId, token, []), false);
  assert.deepEqual(session.getSnapshot().surfaces[pageId], {
    selectedIds: [annotation.id], textDraft: { id, at: { x: 72, y: 144 }, text: 'retained draft', baseVersion }, annotationDraft: null,
  });
  assert.throws(() => session.getSnapshot().surfaces[pageId].selectedIds.push('mutate'), TypeError);
  assert.equal(session.cancelText(pageId, replacement), true);
  assert.equal(session.canNavigate(), true);
  assert.equal(session.getSnapshot().selectedVersion, baseVersion, 'cancel creates no history command');
  assert.deepEqual(session.getSnapshot().surfaces[pageId].selectedIds, [annotation.id]);
});

test('text starts only for a new ID or existing text and excludes other page input even without an owner', async () => {
  const { session, token, pageId } = await setup();
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  assert.equal(session.beginText(pageId, token, { id: annotation.id, at: { x: 0, y: 0 }, text: '' }), false);
  assert.equal(session.beginText('missing', token, { id: crypto.randomUUID(), at: { x: 0, y: 0 }, text: '' }), false);
  const text = textAnnotation(crypto.randomUUID());
  await session.editPage(pageId, token, [{ type: 'create', annotation: text }]);
  assert.equal(session.beginText(pageId, token, { id: text.id, at: { x: 2, y: 3 }, text: 'edit existing' }), true);
  const otherPage = session.getSnapshot().document!.pages[1].id, other = Symbol('other page');
  session.claimPage(otherPage, other);
  session.releasePage(pageId, token);
  assert.equal(session.canEditPage(otherPage, other), false);
  assert.equal(session.setInput(otherPage, other, 'drawing'), false);
  assert.equal(session.beginText(otherPage, other, { id: crypto.randomUUID(), at: { x: 0, y: 0 }, text: '' }), false);
  assert.deepEqual(await session.editDocument([]), { status: 'refused', reason: 'input-active' });
  assert.deepEqual(await session.commitPageInput(otherPage, other, []), { status: 'refused', reason: 'input-active' });
});

test('text commit validation and stale version refusals preserve draft and owner input', async () => {
  const { session, token, pageId } = await setup();
  const id = crypto.randomUUID();
  session.beginText(pageId, token, { id, at: { x: 12, y: 24 }, text: 'keep this' });
  const draft = session.getSnapshot().surfaces[pageId].textDraft;
  const changes = [{ type: 'create' as const, annotation: textAnnotation(id, 'keep this') }];
  assert.deepEqual(await session.commitPageInput(pageId, token, changes, crypto.randomUUID()), { status: 'refused', reason: 'stale-version' });
  assert.deepEqual(await session.commitPageInput(pageId, Symbol('wrong'), changes), { status: 'refused', reason: 'editor-owner' });
  assert.equal((await session.commitPageInput(pageId, token, [{ type: 'create', annotation: { ...textAnnotation(id, 'keep this'), style: { ...annotation.style, widthPt: -1 } } }])).status, 'refused');
  assert.equal(session.getSnapshot().surfaces[pageId].textDraft, draft);
  assert.equal(session.getSnapshot().inputActive, true);
  assert.equal(session.canNavigate(), false);
  assert.equal((await session.commitPageInput(pageId, token, changes, draft!.baseVersion)).status, 'applied');
  assert.equal(session.getSnapshot().surfaces[pageId].textDraft, null);
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1);
});

test('accepted text commit atomically replaces draft with pending canonical content and retries the exact command', async () => {
  let fail = true;
  const sent: EditBatch[] = [];
  const { session, token, pageId } = await setup(value => ({ ...value, commit: async (batch, history) => {
    sent.push(structuredClone(batch));
    return fail ? { status: 'aborted', reason: 'disk-full' } : value.commit(batch, history);
  } }));
  const id = crypto.randomUUID();
  session.beginText(pageId, token, { id, at: { x: 12, y: 24 }, text: 'durable retry' });
  const observations: { phase: string; input: boolean; draft: boolean; navigate: boolean; annotations: number }[] = [];
  const unsubscribe = session.subscribe(() => {
    const state = session.getSnapshot();
    observations.push({ phase: state.phase, input: state.inputActive, draft: !!state.surfaces[pageId].textDraft,
      navigate: session.canNavigate(), annotations: state.document!.pages[0].annotations.length });
  });
  assert.equal((await session.commitPageInput(pageId, token, [{ type: 'create', annotation: textAnnotation(id, 'durable retry') }])).status, 'applied');
  unsubscribe();
  assert.ok(observations.length > 0);
  assert.ok(observations.every(value => !value.navigate && !value.input && !value.draft && value.annotations === 1));
  assert.equal(session.getSnapshot().phase, 'aborted');
  session.releasePage(pageId, token);
  assert.equal(session.canNavigate(), false);
  fail = false; await session.retry();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(session.getSnapshot().phase, 'idle');
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 1);
  await session.undo();
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 0);
});

test('text draft invalidates an earlier remote read and remains guarded across release and cancel', async () => {
  let holdRead = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { repository, session, token, pageId } = await setup(value => ({ ...value, read: async id => {
    const result = await value.read(id);
    if (holdRead) { entered(); await gate; }
    return result;
  } }));
  const initial = session.getSnapshot().selectedVersion!;
  const remote: PageEditBatch = { ...fixture.batches[0], id: crypto.randomUUID() };
  await repository.receive([remote]);
  holdRead = true; const refreshing = session.refresh(); await started;
  session.beginText(pageId, token, { id: crypto.randomUUID(), at: { x: 20, y: 30 }, text: 'unsubmitted' });
  session.releasePage(pageId, token);
  release(); assert.equal(await refreshing, false);
  assert.equal(session.getSnapshot().selectedVersion, initial);
  assert.equal(await session.refresh(), false);
  const remounted = Symbol('replacement'); session.claimPage(pageId, remounted);
  assert.equal(session.cancelText(pageId, remounted), true);
  holdRead = false; assert.equal(await session.refresh(), true);
  assert.equal(session.getSnapshot().selectedVersion, remote.id);
});

test('an open new text draft rejects unrelated, mixed, mismatched and empty commits without changing any state or history', async () => {
  const { repository, session, token, pageId } = await setup();
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  const id = crypto.randomUUID(), text = 'must retain this draft';
  session.beginText(pageId, token, { id, at: { x: 12, y: 24 }, text });
  const matching: AnnotationChange = { type: 'create', annotation: textAnnotation(id, text) };
  const rejected: AnnotationChange[][] = [
    [{ type: 'delete', id: annotation.id }],
    [{ type: 'create', annotation: textAnnotation(crypto.randomUUID(), text) }],
    [matching, { type: 'delete', id: annotation.id }],
    [],
    [{ type: 'create', annotation: textAnnotation(id, 'different text') }],
    [{ type: 'create', annotation: { ...annotation, id } }],
    [{ type: 'update', annotation: textAnnotation(id, text) }],
  ];
  const state = session.getSnapshot(), durable = await repository.read(fixture.document.id);
  let notifications = 0;
  const unsubscribe = session.subscribe(() => { notifications++; });
  for (const changes of rejected) {
    assert.deepEqual(await session.commitPageInput(pageId, token, changes), { status: 'refused', reason: 'text-draft-operation-required' });
    assert.equal(session.getSnapshot(), state);
    assert.equal(session.canNavigate(), false);
  }
  unsubscribe();
  assert.equal(notifications, 0);
  assert.deepEqual(await repository.read(fixture.document.id), durable);
  assert.equal((await session.commitPageInput(pageId, token, [matching])).status, 'applied');
  assert.equal(session.getSnapshot().surfaces[pageId].textDraft, null);
  assert.equal(session.getSnapshot().document!.pages[0].annotations.length, 2);
});

test('an edited existing text draft requires its matching update; only unchanged existing text accepts an empty commit', async () => {
  const { repository, session, token, pageId } = await setup();
  const id = crypto.randomUUID(), original = textAnnotation(id, 'original text');
  await session.editPage(pageId, token, [{ type: 'create', annotation: original }]);
  session.beginText(pageId, token, { id, at: { x: 12, y: 24 }, text: 'modified text' });
  const state = session.getSnapshot(), durable = await repository.read(fixture.document.id);
  for (const changes of [[], [{ type: 'create', annotation: textAnnotation(id, 'modified text') }]] as AnnotationChange[][]) {
    assert.deepEqual(await session.commitPageInput(pageId, token, changes), { status: 'refused', reason: 'text-draft-operation-required' });
    assert.equal(session.getSnapshot(), state);
  }
  assert.deepEqual(await repository.read(fixture.document.id), durable);
  assert.equal((await session.commitPageInput(pageId, token, [{ type: 'update', annotation: textAnnotation(id, 'modified text') }])).status, 'applied');
  assert.equal(session.getSnapshot().surfaces[pageId].textDraft, null);
  session.beginText(pageId, token, { id, at: { x: 12, y: 24 }, text: 'modified text' });
  const version = session.getSnapshot().selectedVersion, afterUpdate = await repository.read(fixture.document.id);
  assert.deepEqual(await session.commitPageInput(pageId, token, []), { status: 'unchanged' });
  assert.equal(session.getSnapshot().selectedVersion, version);
  assert.equal(session.getSnapshot().surfaces[pageId].textDraft, null);
  assert.equal(session.canNavigate(), true);
  assert.deepEqual(await repository.read(fixture.document.id), afterUpdate, 'unchanged save creates no history entry');
});

test('document builders are not invoked while input, detached text drafts, or pending saves hold the session', async () => {
  const { session, token, pageId } = await setup(value => ({ ...value, commit: async () => ({ status: 'aborted', reason: 'disk-full' }) }));
  let calls = 0;
  const build = () => { calls++; return []; };
  session.setInput(pageId, token, 'drawing');
  assert.deepEqual(await session.buildDocumentEdit(build), { status: 'refused', reason: 'input-active' });
  session.setInput(pageId, token, 'idle');
  session.beginText(pageId, token, { id: crypto.randomUUID(), at: { x: 10, y: 20 }, text: 'held' });
  session.releasePage(pageId, token);
  assert.deepEqual(await session.buildDocumentEdit(build), { status: 'refused', reason: 'input-active' });
  session.claimPage(pageId, token); session.cancelText(pageId, token);
  await session.editPage(pageId, token, [{ type: 'create', annotation }]);
  assert.deepEqual(await session.buildDocumentEdit(build), { status: 'refused', reason: 'pending-save' });
  assert.equal(calls, 0);
});

test('document builder exceptions and attempts to mutate its immutable base preserve state and history', async () => {
  const { repository, session } = await setup();
  const state = session.getSnapshot(), durable = await repository.read(fixture.document.id);
  const failed = await session.buildDocumentEdit(() => { throw new Error('invalid paper size'); });
  assert.equal(failed.status, 'refused');
  assert.equal(session.getSnapshot(), state);
  const mutated = await session.buildDocumentEdit(document => {
    document.pages[0].widthPt = 0; return [];
  });
  assert.equal(mutated.status, 'refused');
  assert.equal(session.getSnapshot(), state);
  assert.deepEqual(await repository.read(fixture.document.id), durable);
});

test('document builder receives the committed ID and base synchronously and exact retry never invokes it again', async () => {
  let fail = true;
  const sent: EditBatch[] = [];
  const { session, repository, pageId } = await setup(value => ({ ...value, commit: async (batch, history) => {
    sent.push(structuredClone(batch));
    return fail ? { status: 'aborted', reason: 'disk-full' } : value.commit(batch, history);
  } }));
  const parent = session.getSnapshot().document!.version;
  let builtId = '', calls = 0;
  const saving = session.buildDocumentEdit((document, batchId) => {
    calls++; builtId = batchId;
    assert.equal(document.version, parent);
    assert.ok(Object.isFrozen(document.pages[0]));
    return [{ type: 'move', expected: pageExpectation(document.pages[0]), index: 1 }];
  });
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().phase, 'saving');
  assert.equal(session.canNavigate(), false);
  assert.equal((await saving).status, 'applied');
  assert.equal(sent[0].id, builtId);
  assert.deepEqual(sent[0].parents, [parent]);
  fail = false; await session.retry();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().document!.pages[1].id, pageId);
  const reopened = new DocumentEditSession(repository, fixture.document.id); await reopened.refresh();
  await reopened.undo();
  assert.equal(reopened.getSnapshot().document!.pages[0].id, pageId);
});
