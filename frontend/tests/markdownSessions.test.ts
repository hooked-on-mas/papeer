import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentEditSessions } from '../src/features/reader/DocumentEditSessions.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import type { MarkdownDraftPort } from '../src/features/notes/markdown/MarkdownDraftPort.ts';
import type { EditBatch, MarkdownSnapshot } from '../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

async function setup() {
  const scope = { accountId: 'markdown-registry', libraryId: crypto.randomUUID(), epoch: 'scope-one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: MarkdownSnapshot = { kind: 'markdown', id: crypto.randomUUID(), version: crypto.randomUUID(), content: 'original', appendIds: [], imageResources: [] };
  await repository.initialize(root);
  const raw = new Map<string, unknown>();
  const drafts: MarkdownDraftPort = { scope, targets: () => [...raw.keys()], read: id => structuredClone(raw.get(id)),
    write: (id, draft) => { raw.set(id, structuredClone(draft)); }, remove: id => { raw.delete(id); } };
  return { scope, repository, root, drafts, raw };
}

test('registry restart recovers an unknown Markdown resolution with the same target authority', async () => {
  const { repository, root, drafts } = await setup();
  const branch = (content: string): EditBatch => ({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content, imageResources: [] });
  const first = branch('first'), second = branch('second'); await repository.receive([first, second]);
  const commit = repository.commit.bind(repository), ids: string[] = []; let lose = true;
  repository.commit = async (batch, history) => {
    if (batch.kind === 'resolution') { ids.push(batch.id); const result = await commit(batch, history); if (lose) { lose = false; return { status: 'unknown', reason: 'lost reply' }; } return result; }
    return commit(batch, history);
  };
  const firstRegistry = new DocumentEditSessions(repository, drafts); await firstRegistry.initialize();
  const writer = firstRegistry.getMarkdown(root.id); assert.equal(await writer.refresh(first.id), true);
  assert.equal(await writer.resolveConflict(first.id, writer.getSnapshot().heads), false);
  const restarted = new DocumentEditSessions(repository, drafts); await restarted.initialize();
  assert.equal(restarted.getSnapshot().ready, true); assert.deepEqual(restarted.getSnapshot().unhandledTargets, []);
  const recovered = restarted.getMarkdown(root.id); assert.equal(recovered.canLeave(), false);
  assert.equal((await restarted.prepareLeave()).status, 'refused'); await recovered.retry();
  assert.equal(recovered.canLeave(), true); assert.equal((await restarted.prepareLeave()).status, 'allowed');
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal((await repository.read(root.id)).heads.length, 1);
});

test('scope startup recovers an unopened Markdown draft and one authority gates leave and suspend', async () => {
  const { repository, root, drafts } = await setup();
  const first = new DocumentEditSessions(repository, drafts); await first.initialize();
  const writer = first.getMarkdown(root.id); await writer.refresh(); writer.editText('unopened after restart');
  const restarted = new DocumentEditSessions(repository, drafts); await restarted.initialize();
  assert.equal(restarted.getSnapshot().ready, true);
  const recovered = restarted.getMarkdown(root.id);
  assert.equal(recovered, restarted.getMarkdown(root.id));
  assert.equal(recovered.getSnapshot().content, 'unopened after restart');
  assert.equal(restarted.needsExitConfirmation(), true);
  assert.deepEqual((await restarted.prepareLeave()).status, 'refused');
  assert.equal((await restarted.suspend()).status, 'refused');
  await recovered.flush(); assert.equal((await restarted.prepareLeave()).status, 'allowed');
  assert.equal(restarted.needsExitConfirmation(), false);
  assert.equal((await restarted.suspend()).status, 'allowed');
  assert.equal(recovered.editText('must not write to a suspended scope'), false);
  await restarted.resume(); assert.equal(recovered.editText('resumed scope'), true);
});

test('malformed unopened scratch is retained and surfaced as unhandled before leaving', async () => {
  const { repository, root, drafts, raw } = await setup();
  raw.set(root.id, { version: 1, content: 'unknown editing base' });
  const sessions = new DocumentEditSessions(repository, drafts); await sessions.initialize();
  assert.deepEqual(sessions.getSnapshot().unhandledTargets, [root.id]);
  assert.equal(sessions.getMarkdown(root.id).getSnapshot().editingBlocked, true);
  assert.equal((await sessions.prepareLeave()).status, 'refused');
  assert.deepEqual(raw.get(root.id), { version: 1, content: 'unknown editing base' });
});

test('draft enumeration failure and foreign scope never authorize editing', async () => {
  const { repository, drafts } = await setup();
  assert.throws(() => new DocumentEditSessions(repository, { ...drafts, scope: { ...drafts.scope, epoch: 'foreign' } }), /markdown-draft-scope/);
  const unavailable = new DocumentEditSessions(repository, { ...drafts, targets: () => { throw new Error('scratch-unavailable'); } });
  await unavailable.initialize();
  assert.equal(unavailable.getSnapshot().ready, false); assert.match(unavailable.getSnapshot().error, /scratch-unavailable/);
  assert.equal((await unavailable.prepareLeave()).status, 'refused');
  assert.throws(() => new DocumentEditSessions(repository).getMarkdown(crypto.randomUUID()), /markdown-drafts-unavailable/);
});

test('a source append request survives view borrowing and protects exit before destination handoff', async () => {
  const { repository, drafts } = await setup();
  const sessions = new DocumentEditSessions(repository, drafts); await sessions.initialize();
  const sourceId = crypto.randomUUID(), append = sessions.getAppend(sourceId);
  // This setup has no catalog: a read failure must retain the selected text before any note writer exists.
  assert.equal(await append.begin({ kind: 'quote', text: 'selected source text', target: {
    libraryId: repository.scope.libraryId, documentId: sourceId, pageId: crypto.randomUUID(),
    backgroundRevision: crypto.randomUUID(), surface: 'original',
  } }), false);
  assert.equal(sessions.getAppend(sourceId), append);
  assert.equal(append.getSnapshot().request!.input.kind, 'quote');
  assert.equal(sessions.needsExitConfirmation(), true);
  assert.deepEqual((await sessions.prepareLeave()).status, 'refused');
  assert.equal(append.cancel(), true); assert.equal(append.dismiss(), true);
  assert.equal(sessions.needsExitConfirmation(), false);
  assert.equal((await sessions.suspend()).status, 'allowed');
  assert.equal(await append.begin({ kind: 'quote', text: 'inactive', target: {
    libraryId: repository.scope.libraryId, documentId: sourceId, pageId: crypto.randomUUID(),
    backgroundRevision: crypto.randomUUID(), surface: 'original',
  } }), false);
});
