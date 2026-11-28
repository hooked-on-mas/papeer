import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownEditSession } from '../../../src/features/notes/markdown/MarkdownEditSession.ts';
import type { MarkdownDraft, MarkdownDraftPort } from '../../../src/features/notes/markdown/MarkdownDraftPort.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import type { CommitResult, EditIntentRepository } from '../../../src/runtime/edits/ports.ts';
import type { EditBatch, MarkdownSnapshot } from '../../../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';

async function setup(wrap: (repository: EditIntentRepository) => EditIntentRepository = value => value) {
  const scope = { accountId: 'markdown-session', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: MarkdownSnapshot = { kind: 'markdown', id: crypto.randomUUID(), version: crypto.randomUUID(), content: 'base', appendIds: [], imageResources: [] };
  await repository.initialize(root);
  let raw: unknown, fail = false;
  const drafts: MarkdownDraftPort = { scope, targets: () => raw === undefined ? [] : [root.id], read: () => structuredClone(raw),
    write: (_, value) => { if (fail) throw new Error('scratch-quota'); raw = structuredClone(value); },
    remove: () => { if (fail) throw new Error('scratch-quota'); raw = undefined; } };
  const port = wrap(repository), session = new MarkdownEditSession(port, root.id, drafts);
  assert.equal(await session.refresh(), true);
  return { repository, root, drafts, session, port, raw: () => raw, setRaw: (value: unknown) => { raw = value; }, fail: (value: boolean) => { fail = value; } };
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(condition(), 'operation reached controlled boundary');
};

test('clean flush leaves navigation available and does not invalidate an in-flight read', async () => {
  let hold = false, release!: () => void, entered!: () => void, writes = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { session, root, repository } = await setup(base => ({ ...base,
    read: async id => { if (hold) { entered(); await gate; } return base.read(id); },
    commit: async (...args) => { writes++; return base.commit(...args); },
  }));
  assert.equal(session.canLeave(), true); const before = session.getSnapshot(); hold = true;
  const reading = session.refresh(); await reached;
  const flushing = session.flush(); assert.equal(session.canLeave(), true); assert.equal(session.getSnapshot(), before);
  await flushing; release(); assert.equal(await reading, true);
  assert.equal(session.canLeave(), true); assert.equal(writes, 0); assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0);
});

test('clean flush does not retire a read that began before blur', async () => {
  let hold = false, release!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { session } = await setup(base => ({ ...base, read: async id => { if (hold) { entered(); await gate; } return base.read(id); } }));
  hold = true; const reading = session.refresh(); await reached; await session.flush(); release();
  assert.equal(await reading, true); assert.equal(session.canLeave(), true);
});

test('dirty flush is joined and continues to guard navigation through the commit', async () => {
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { session, repository, root } = await setup(base => ({ ...base, commit: async (...args) => { entered(); await gate; return base.commit(...args); } }));
  assert.equal(session.editText('pending real edit'), true);
  const first = session.flush(), second = session.flush(); assert.equal(first, second); assert.equal(session.canLeave(), false);
  await reached; assert.equal(session.canLeave(), false); release(); await first;
  assert.equal(session.canLeave(), true); assert.equal((await repository.read(root.id)).checkpoint.batches.length, 1);
});

test('clean content with a failed scratch removal still retries the scratch cleanup', async () => {
  let failRemoval = () => {};
  const { session, fail, raw, root, repository } = await setup(base => ({ ...base, commit: async (...args) => {
    const result = await base.commit(...args); failRemoval(); return result;
  } }));
  failRemoval = () => fail(true); session.editText('changed'); assert.notEqual(raw(), undefined);
  await session.flush(); assert.equal(session.getSnapshot().dirty, false); assert.equal(session.canLeave(), false);
  fail(false); await session.retry(); assert.equal(raw(), undefined); assert.equal(session.canLeave(), true);
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 1);
});

test('resolution uses the target journal and keeps a late head as a conflict', async () => {
  const { repository, root, session } = await setup();
  const branch = (content: string): EditBatch => ({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content, imageResources: [] });
  const first = branch('first'), second = branch('second');
  await repository.receive([first, second]); assert.equal(await session.refresh(first.id), true);
  const heads = [...session.getSnapshot().heads]; assert.equal(heads.length, 2);
  assert.deepEqual(session.conflictVersions().map(value => value.content).sort(), ['first', 'second']);
  assert.equal(await session.resolveConflict(first.id, heads), true);
  const resolved = await repository.read(root.id); assert.equal(resolved.heads.length, 1);
  assert.equal(session.getSnapshot().content, 'first'); assert.equal(session.getSnapshot().canUndo, false);
  const late = branch('late'); await repository.receive([late]); await session.refresh();
  assert.equal(session.getSnapshot().heads.length, 2);
  assert.equal(await session.resolveConflict(first.id, heads), false);
});

test('unknown resolution recovers the exact operation after restart', async () => {
  let lose = true; const ids: string[] = [];
  const { repository, root, session, drafts, port } = await setup(base => ({ ...base,
    commit: async (batch, history) => {
      if (batch.kind === 'resolution') { ids.push(batch.id); const result = await base.commit(batch, history); if (lose) { lose = false; return { status: 'unknown', reason: 'lost reply' }; } return result; }
      return base.commit(batch, history);
    },
  }));
  const branch = (content: string): EditBatch => ({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content, imageResources: [] });
  const first = branch('first'), second = branch('second'); await repository.receive([first, second]); await session.refresh(first.id);
  assert.equal(await session.resolveConflict(first.id, session.getSnapshot().heads), false); assert.equal(session.canLeave(), false);
  const recovered = new MarkdownEditSession(port, root.id, drafts); assert.equal(await recovered.refresh(), true); assert.equal(recovered.canLeave(), false);
  await recovered.retry(); assert.equal(recovered.canLeave(), true); assert.equal(recovered.getSnapshot().content, 'first');
  assert.equal((await repository.read(root.id)).heads.length, 1); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test('a new head before atomic resolution is rejected and can be compared again', async () => {
  let inject: (() => Promise<void>) | undefined;
  const { repository, root, session } = await setup(base => ({ ...base, commit: async (batch, history) => {
    if (batch.kind === 'resolution' && inject) { const run = inject; inject = undefined; await run(); }
    return base.commit(batch, history);
  } }));
  const branch = (content: string): EditBatch => ({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content, imageResources: [] });
  const first = branch('first'), second = branch('second'), late = branch('late');
  await repository.receive([first, second]); await session.refresh(first.id); const heads = [...session.getSnapshot().heads];
  inject = async () => { await repository.receive([late]); };
  assert.equal(await session.resolveConflict(first.id, heads), false); assert.equal(session.canLeave(), false);
  assert.equal(await session.discardRejectedResolution(), true); assert.equal(session.getSnapshot().heads.length, 3);
  assert.deepEqual((await repository.read(root.id)).heads.sort(), [first.id, second.id, late.id].sort());
});

test('pending resolution excludes edits and a second resolution', async () => {
  let release: (() => void) | undefined;
  const { repository, root, session } = await setup(base => ({ ...base, commit: async (batch, history) => {
    if (batch.kind === 'resolution') await new Promise<void>(resolve => { release = resolve; });
    return base.commit(batch, history);
  } }));
  const branch = (content: string): EditBatch => ({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content, imageResources: [] });
  const first = branch('first'), second = branch('second'); await repository.receive([first, second]); await session.refresh(first.id);
  const heads = [...session.getSnapshot().heads], pending = session.resolveConflict(first.id, heads);
  await until(() => !!release);
  assert.equal(session.canLeave(), false); assert.equal(session.editText('interleaved'), false);
  assert.equal(session.appendText(crypto.randomUUID(), 'interleaved'), false);
  assert.equal(await session.resolveConflict(second.id, heads), false);
  release!(); assert.equal(await pending, true); assert.equal(session.getSnapshot().content, 'first');
});

test('canonical Markdown saves, reloads, restores durable Undo/Redo and editor ownership', async () => {
  const { session, repository, root, drafts } = await setup();
  const owner = Symbol(), other = Symbol();
  assert.equal(session.acquireEditor(owner), true); assert.equal(session.acquireEditor(other), false);
  assert.equal(session.editText('wrong', other), false);
  session.editText('first', owner); assert.equal(session.canLeave(), false); await session.flush();
  session.editText('second', owner); await session.flush();
  assert.equal(session.canLeave(), true);
  const reload = new MarkdownEditSession(repository, root.id, drafts); await reload.refresh();
  assert.equal(reload.getSnapshot().content, 'second'); assert.equal(await reload.undo(), true);
  assert.equal(reload.getSnapshot().content, 'first'); assert.equal(await reload.undo(), true);
  assert.equal(reload.getSnapshot().content, 'base');
  const again = new MarkdownEditSession(repository, root.id, drafts); await again.refresh();
  assert.equal(await again.redo(), true); assert.equal(await again.redo(), true);
  assert.equal(again.getSnapshot().content, 'second');
});

test('lost reply keeps the exact operation ID across retry and restart', async () => {
  const sent: EditBatch[] = []; let lose = true;
  const { session, repository, port, root, drafts } = await setup(value => ({ ...value, commit: async (batch, history) => {
    sent.push(structuredClone(batch)); const result = await value.commit(batch, history);
    if (lose) { lose = false; return { status: 'unknown', reason: 'lost-reply' }; } return result;
  } }));
  session.editText('saved remotely'); await session.flush(); assert.equal(session.canLeave(), false);
  const reload = new MarkdownEditSession(port, root.id, drafts); await reload.refresh(); await reload.retry();
  assert.equal(reload.canLeave(), true); assert.deepEqual(sent[1], sent[0]);
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 1);
});

test('a durable commit with response still pending recovers the same flight before becoming clean', async () => {
  const sent: EditBatch[] = []; let release!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const { session, repository, root, drafts, port, raw } = await setup(base => ({ ...base, commit: async (batch, history) => {
    sent.push(structuredClone(batch)); const result = await base.commit(batch, history);
    if (sent.length === 1) { entered(); await gate; } return result;
  } }));
  assert.equal(session.editText('durable before reply'), true); const original = session.flush();
  try {
    await reached; const saved = await repository.read(root.id); assert.equal(saved.checkpoint.batches.length, 1);
    const id = saved.checkpoint.batches[0].id; assert.equal(sent[0].id, id);
    assert.equal((await repository.receipt(id))?.durable, true); assert.equal((raw() as MarkdownDraft).flight?.batch.id, id);
    const restored = new MarkdownEditSession(port, root.id, drafts); assert.equal(await restored.refresh(), true);
    assert.equal(restored.getSnapshot().content, 'durable before reply'); assert.equal(restored.canLeave(), false);
    await restored.flush(); assert.equal(restored.canLeave(), true); assert.equal(restored.getSnapshot().dirty, false);
    assert.equal((await repository.read(root.id)).checkpoint.batches.length, 1);
    assert.ok(sent.every(batch => batch.id === id)); assert.equal(await repository.readIntent(root.id), undefined); assert.equal(raw(), undefined);
  } finally { release(); await original; }
});

test('input after dispatch survives restart even when acceptance cleared the journal before scratch rebasing', async () => {
  let release: ((value: CommitResult) => void) | undefined, result: CommitResult | undefined;
  const { session, repository, root, drafts, fail, raw } = await setup(value => ({ ...value, commit: async (batch, history) => {
    result = await value.commit(batch, history); return new Promise(resolve => { release = resolve; });
  } }));
  session.editText('sent'); const saving = session.flush(); await until(() => !!release);
  session.editText('sent plus later input');
  assert.equal((raw() as MarkdownDraft).flight!.batch.content, 'sent');
  fail(true); release!(result!); await saving;
  assert.equal(await repository.readIntent(root.id), undefined); assert.equal(session.canLeave(), false);
  fail(false);
  const reload = new MarkdownEditSession(repository, root.id, drafts); await reload.refresh();
  assert.equal(reload.getSnapshot().content, 'sent plus later input'); await reload.retry();
  assert.equal(reload.canLeave(), true);
  const read = await repository.read(root.id);
  assert.equal(read.checkpoint.batches.length, 2);
  const again = new MarkdownEditSession(repository, root.id, drafts); await again.refresh();
  assert.equal(again.getSnapshot().content, 'sent plus later input');
});

test('scratch quota failure retains input, refuses leave and retries without duplicate batches', async () => {
  const { session, fail, repository, root } = await setup();
  fail(true); session.editText('unsaved'); await session.flush();
  assert.equal(session.getSnapshot().content, 'unsaved'); assert.match(session.getSnapshot().error, /scratch-quota/);
  assert.equal(session.canLeave(), false); assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0);
  fail(false); await session.retry(); assert.equal(session.canLeave(), true);
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 1);
});

test('lost reply plus later typing and append recover in order from both scratch and journal', async () => {
  let lose = true;
  const { session, repository, root, drafts, port } = await setup(value => ({ ...value, commit: async (batch, history) => {
    const result = await value.commit(batch, history);
    if (lose) { lose = false; return { status: 'unknown', reason: 'lost' }; } return result;
  } }));
  const appendId = crypto.randomUUID();
  session.editText('first'); await session.flush();
  session.editText('first plus later'); session.appendText(appendId, '\nquote');
  assert.match(session.getSnapshot().error, /lost/);
  const restart = new MarkdownEditSession(port, root.id, drafts); await restart.refresh(); await restart.retry();
  assert.equal(restart.getSnapshot().content, 'first plus later\nquote');
  assert.deepEqual(restart.getSnapshot().accepted!.appendIds, [appendId]);
  const read = await repository.read(root.id);
  assert.equal(read.heads.length, 1); assert.equal(read.checkpoint.batches.length, 2);
  assert.equal(restart.canLeave(), true); assert.equal(restart.appendText(appendId, 'duplicate'), false);
});

test('remote during dirty editing preserves edit-start parent and saves a branch', async () => {
  const { session, repository, root } = await setup(); session.editText('local');
  const remote = { kind: 'markdown' as const, id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content: 'remote', imageResources: [] };
  await repository.receive([remote]); await session.refresh();
  assert.equal(session.getSnapshot().content, 'local'); assert.equal(session.getSnapshot().pendingRemote?.content, 'remote');
  await session.flush(); const read = await repository.read(root.id);
  assert.equal(read.heads.length, 2);
  assert.equal(read.checkpoint.batches.find(batch => batch.id !== remote.id)!.parents[0], root.version);
});

test('clean remote adoption invalidates the CodeMirror baseline generation', async () => {
  const { session, repository, root } = await setup(); const generation = session.getSnapshot().textGeneration;
  await repository.receive([{ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content: 'remote', imageResources: [] }]);
  await session.refresh(); assert.equal(session.getSnapshot().content, 'remote');
  assert.equal(session.getSnapshot().textGeneration, generation + 1);
});

test('a delayed pre-save read cannot roll back durable text or its Undo history', async () => {
  for (const alreadyDirty of [false, true]) {
    let delay = false, release: (() => void) | undefined;
    const { session, repository, root } = await setup(value => ({ ...value, read: async id => {
      const read = await value.read(id);
      if (delay) await new Promise<void>(resolve => { release = resolve; });
      return read;
    } }));
    if (alreadyDirty) session.editText('durable new text');
    delay = true; const refreshing = session.refresh(); await until(() => !!release);
    if (!alreadyDirty) session.editText('durable new text');
    await session.flush();
    const acceptedVersion = session.getSnapshot().accepted!.version;
    assert.notEqual(acceptedVersion, root.version);
    release!(); assert.equal(await refreshing, false);
    assert.equal(session.getSnapshot().content, 'durable new text');
    assert.equal(session.getSnapshot().accepted!.version, acceptedVersion);
    assert.equal(session.getSnapshot().dirty, false); assert.equal(session.getSnapshot().canUndo, true);
    assert.deepEqual((await repository.read(root.id)).heads, [acceptedVersion]);
    assert.equal(await session.undo(), true); assert.equal(session.getSnapshot().content, 'base');
  }
});

test('multiple queued append IDs are confirmed exactly once and survive Undo plus reload', async () => {
  const { session, repository, root, drafts } = await setup();
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  assert.equal(session.appendText(first, '\none'), true); assert.equal(session.appendText(first, '\none'), false);
  assert.equal(session.appendText(second, '\ntwo'), true); await session.flush();
  const reload = new MarkdownEditSession(repository, root.id, drafts); await reload.refresh();
  assert.equal(reload.getSnapshot().content, 'base\none\ntwo');
  assert.deepEqual(reload.getSnapshot().accepted!.appendIds, [first, second]);
  assert.equal(reload.appendText(first, 'duplicate'), false);
  await reload.undo(); assert.equal(reload.getSnapshot().content, 'base\none');
  assert.equal(reload.appendText(second, 'duplicate'), false);
});

test('malformed scratch remains untouched, blocks editing and is never automatically removed', async () => {
  const { repository, root, drafts, setRaw, raw } = await setup();
  const malformed = { version: 1, content: 'recover manually' }; setRaw(malformed);
  const reload = new MarkdownEditSession(repository, root.id, drafts);
  assert.equal(await reload.refresh(), false); assert.equal(reload.getSnapshot().editingBlocked, true);
  assert.equal(reload.editText('overwrite'), false); await reload.flush(); assert.equal(reload.canLeave(), false);
  assert.deepEqual(raw(), malformed);
  assert.throws(() => new MarkdownEditSession(repository, root.id, { ...drafts, scope: { ...drafts.scope, epoch: 'other' } }), /scope/);
});

test('first opening exposes multiple heads without adopting a winner and allows an explicit choice', async () => {
  const { repository, root, drafts } = await setup();
  const first = { kind: 'markdown' as const, id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: root.id, parents: [root.version], content: 'first branch', imageResources: [] };
  const second = { ...first, id: crypto.randomUUID(), content: 'second branch' };
  await repository.receive([first, second]);
  const session = new MarkdownEditSession(repository, root.id, drafts);
  assert.equal(await session.refresh(), false);
  assert.deepEqual([...session.getSnapshot().heads].sort(), [first.id, second.id].sort());
  assert.equal(session.getSnapshot().ready, false); assert.equal(session.getSnapshot().accepted, null);
  assert.equal(session.editText('must not choose by typing'), false);
  assert.equal(await session.refresh(second.id), true);
  assert.equal(session.getSnapshot().content, 'second branch'); assert.equal(session.getSnapshot().editingBlocked, false);
  assert.equal(session.getSnapshot().error, ''); assert.equal(session.canLeave(), true);
});
