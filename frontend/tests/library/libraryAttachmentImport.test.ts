import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibrarySession } from '../../src/features/library/LibrarySession.ts';
import { DurableEditRepository } from '../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../support/editMemoryDatabase.ts';
import type { LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';

async function setup() {
  const scope = { accountId: 'attachment', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [], folders: [], links: [], deletions: [] };
  await repository.initialize(root);
  const session = new LibrarySession({ repository, isActive: () => true });
  await session.refresh(); await session.create({ kind: 'markdown', title: 'owner' });
  return { repository, session, ownerId: session.getSnapshot().createdId! };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('attachment resource failure retains fixed bytes and IDs for retry, publishing no content root', async () => {
  const { repository, session, ownerId } = await setup();
  const store = repository.storeResource.bind(repository), attempts: Parameters<typeof store>[0][] = [];
  repository.storeResource = async input => { attempts.push(structuredClone(input)); if (attempts.length === 1) throw new Error('offline'); return store(input); };
  const bytes = new Uint8Array([1, 2, 3]);
  const pending = session.importAttachment({ ownerId, name: 'one.bin', mediaType: 'application/octet-stream', bytes }); bytes[0] = 9;
  assert.equal(session.canLeave(), false); assert.equal(await pending, false);
  assert.equal(session.getSnapshot().attachment?.phase, 'failed'); assert.equal(await session.retryAttachment(), true);
  assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(attempts[1].bytes, new Uint8Array([1, 2, 3]));
  const item = session.getSnapshot().items.find(item => item.kind === 'attachment')!;
  assert.equal(item.ownerId, ownerId); assert.equal(item.title, 'one.bin'); assert.equal(session.canLeave(), true);
  assert.equal((await repository.checkpoint()).roots.some(root => root.id === item.id), false);
  assert.equal(session.getSnapshot().attachment, null);
});

test('file reading is guarded immediately and cancel rejects its late completion', async () => {
  const { repository, session, ownerId } = await setup(), wait = gate(); let stores = 0;
  const store = repository.storeResource.bind(repository); repository.storeResource = async input => { stores++; return store(input); };
  const pending = session.importAttachment({ ownerId, name: 'late.bin', mediaType: 'application/octet-stream', read: async () => { await wait.promise; return new Uint8Array([1]); } });
  assert.equal(session.getSnapshot().attachment?.phase, 'reading'); assert.equal(session.canLeave(), false);
  assert.equal(await session.cancelAttachment(), true); wait.resolve(); assert.equal(await pending, false);
  assert.equal(stores, 0); assert.equal(session.canLeave(), true); assert.equal(session.getSnapshot().items.length, 1);
});

test('cancel during resource durability prevents late publication and owner deletion is rechecked', async () => {
  const { repository, session, ownerId } = await setup(), wait = gate(), entered = gate();
  const store = repository.storeResource.bind(repository);
  repository.storeResource = async input => { entered.resolve(); await wait.promise; return store(input); };
  const pending = session.importAttachment({ ownerId, name: 'late.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([1]) });
  await entered.promise; assert.equal(await session.cancelAttachment(), true); wait.resolve(); assert.equal(await pending, false);
  assert.equal(session.getSnapshot().items.length, 1);
  repository.storeResource = store;
  assert.equal(await session.deleteItems([ownerId]), true);
  assert.equal(await session.importAttachment({ ownerId, name: 'bad.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([1]) }), false);
  assert.equal(session.canLeave(), false); assert.equal(await session.cancelAttachment(), true);
});

test('unknown publication recovers the same request and cancel applies its inverse', async () => {
  const { repository, session, ownerId } = await setup(), publish = repository.publish.bind(repository);
  const ids: string[] = []; let uncertain = true;
  repository.publish = async (publication, history) => {
    ids.push(publication.libraryBatch.id); const result = await publish(publication, history);
    if (uncertain) { uncertain = false; return { status: 'unknown', reason: 'lost response' }; } return result;
  };
  assert.equal(await session.importAttachment({ ownerId, name: 'unknown.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([1]) }), false);
  const recovered = new LibrarySession({ repository, isActive: () => true }); assert.equal(await recovered.refresh(), true);
  assert.equal(recovered.getSnapshot().attachment?.phase, 'publication'); assert.equal(await recovered.cancelAttachment(), true);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(recovered.getSnapshot().items.length, 1);
  assert.equal(recovered.getSnapshot().deletedItems.length, 1); assert.equal(recovered.canLeave(), true);
});

test('scope suspension after resource write retains import for retry without publishing', async () => {
  const { repository, ownerId } = await setup(), wait = gate(), entered = gate(); let active = true;
  const session = new LibrarySession({ repository, isActive: () => active }); await session.refresh();
  const store = repository.storeResource.bind(repository);
  repository.storeResource = async input => { entered.resolve(); await wait.promise; return store(input); };
  const pending = session.importAttachment({ ownerId, name: 'scope.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([4]) });
  await entered.promise; active = false; wait.resolve(); assert.equal(await pending, false);
  assert.equal(session.canLeave(), false); assert.equal(session.getSnapshot().items.length, 1);
  active = true; assert.equal(await session.retryAttachment(), true); assert.equal(session.getSnapshot().items.length, 2);
});

test('resource readback rejects altered bytes before catalog publication', async () => {
  const { repository, session, ownerId } = await setup(), read = repository.readResource.bind(repository);
  repository.readResource = async id => { const stored = await read(id); return stored ? { ...stored, bytes: new Uint8Array([9]) } : undefined; };
  assert.equal(await session.importAttachment({ ownerId, name: 'bad.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([4]) }), false);
  assert.match(session.getSnapshot().error, /attachment-resource/); assert.equal(session.getSnapshot().items.length, 1);
  assert.equal(session.canLeave(), false); await session.cancelAttachment();
});

test('durable attachment creation Undo and Redo survive reload without removing resource bytes', async () => {
  const { repository, session, ownerId } = await setup();
  assert.equal(await session.importAttachment({ ownerId, name: 'history.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([4]) }), true);
  const item = session.getSnapshot().items.find(item => item.kind === 'attachment')!;
  const reopened = new LibrarySession({ repository, isActive: () => true }); await reopened.refresh();
  assert.equal(reopened.getSnapshot().canUndo, true); assert.equal(await reopened.undo(), true, reopened.getSnapshot().error);
  assert.equal(reopened.getSnapshot().items.some(value => value.id === item.id), false);
  assert.ok(await repository.readResource(item.resourceId!));
  assert.equal(await reopened.redo(), true, reopened.getSnapshot().error); assert.equal(reopened.getSnapshot().items.some(value => value.id === item.id), true);
});

test('first note creation Undo observes guard-flushed heads; subsequent replay keeps that observation', async () => {
  const { repository, ownerId } = await setup(); let guards = 0;
  const session = new LibrarySession({ repository, isActive: () => true, prepareDeleteTargets: async ids => {
    guards++; assert.deepEqual(ids, [ownerId]);
    const content = await repository.read(ownerId);
    await repository.commit({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId, targetId: ownerId,
      parents: content.heads, content: `guard ${guards}`, imageResources: [] }); return true;
  } });
  await session.refresh(); assert.equal(await session.undo(), true, session.getSnapshot().error);
  const observed = structuredClone(session.getSnapshot().deletions[0].observed);
  assert.deepEqual(observed[0].heads, (await repository.read(ownerId)).heads);
  assert.equal(await session.redo(), true, session.getSnapshot().error);
  assert.equal(await session.undo(), true, session.getSnapshot().error);
  assert.deepEqual(session.getSnapshot().deletions[0].observed, observed);
  assert.notDeepEqual(observed[0].heads, (await repository.read(ownerId)).heads);
  const reopened = new LibrarySession({ repository, isActive: () => true }); await reopened.refresh();
  assert.equal(await reopened.redo(), true, reopened.getSnapshot().error);
});

test('paper creation Undo refuses a busy writer, then an unknown Undo recovers without changing observation', async () => {
  const { repository, session } = await setup();
  await session.create({ kind: 'notebook', title: 'paper' }); const itemId = session.getSnapshot().createdId!;
  let allow = false;
  const editor = new LibrarySession({ repository, isActive: () => true, prepareDeleteTargets: async () => allow }); await editor.refresh();
  assert.equal(await editor.undo(), false); assert.equal(editor.getSnapshot().items.some(item => item.id === itemId), true);
  allow = true; const commit = repository.commit.bind(repository); let unknown = true;
  repository.commit = async (batch, history) => { const result = await commit(batch, history); if (unknown) { unknown = false; return { status: 'unknown', reason: 'lost undo' }; } return result; };
  assert.equal(await editor.undo(), false);
  const pending = await repository.readIntent(repository.scope.libraryId); assert.ok(pending);
  const recovered = new LibrarySession({ repository, isActive: () => true }); assert.equal(await recovered.refresh(), true, recovered.getSnapshot().error);
  assert.equal(await recovered.retry(), true, recovered.getSnapshot().error);
  assert.equal(recovered.getSnapshot().items.some(item => item.id === itemId), false);
  assert.equal(await recovered.redo(), true, recovered.getSnapshot().error);
});

test('catalog creation Undo may arrive before its observed body head without blocking the library', async () => {
  const { repository, session, ownerId } = await setup(), old = await repository.read(ownerId);
  await repository.commit({ kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId, targetId: ownerId,
    parents: old.heads, content: 'not yet replicated', imageResources: [] });
  assert.equal(await session.undo(), true, session.getSnapshot().error);
  const read = repository.read.bind(repository); repository.read = async id => id === ownerId ? old : read(id);
  const receiving = new LibrarySession({ repository, isActive: () => true });
  assert.equal(await receiving.refresh(), true, receiving.getSnapshot().error); assert.equal(receiving.getSnapshot().ready, true);
  assert.equal(receiving.getSnapshot().deletedItems.length, 1); assert.equal(receiving.getSnapshot().canRedo, false);
  assert.equal(receiving.getSnapshot().canUndo, false);
  assert.equal(receiving.getSnapshot().deletedContent.find(value => value.itemId === ownerId)?.state, 'waiting');
  repository.read = read; assert.equal(await receiving.refresh(), true);
  assert.equal(receiving.getSnapshot().deletedContent.find(value => value.itemId === ownerId)?.state, 'observed');
  assert.equal(receiving.getSnapshot().canRedo, true); assert.equal(await receiving.redo(), true);
});
