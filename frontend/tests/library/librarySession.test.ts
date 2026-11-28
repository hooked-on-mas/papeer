import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibrarySession } from '../../src/features/library/LibrarySession.ts';
import { DurableEditRepository } from '../../src/runtime/edits/repository.ts';
import { resourceHash } from '../../src/runtime/edits/contentPublication.ts';
import { EditMemoryDatabase } from '../support/editMemoryDatabase.ts';
import type { ContentPublication, LibrarySnapshot, LibraryChange } from '../../src/runtime/edits/contracts.ts';

async function setup() {
  const scope = { accountId: 'library-session', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => [{ widthPt: 600, heightPt: 800 }] });
  const library: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [], folders: [], links: [], deletions: [] };
  await repository.initialize(library); let active = true;
  const create = () => new LibrarySession({ repository, isActive: () => active });
  const session = create(); assert.equal(await session.refresh(), true);
  return { scope, repository, library, session, create, active: (value: boolean) => { active = value; } };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('scoped template publication remains outside ordinary catalog and survives logical delete', async () => {
  const { session, repository, create } = await setup();
  const identity = { itemId: crypto.randomUUID(), contentVersion: crypto.randomUUID(), batchId: crypto.randomUUID() };
  assert.equal(await session.createTemplate('Research', '# Evidence', identity), true);
  assert.deepEqual(session.getSnapshot().items, []);
  assert.equal(session.getSnapshot().createdId, null, 'template publication does not expose the ordinary open-created control');
  assert.equal(session.getSnapshot().templates[0].id, identity.itemId);
  const body = (await repository.read(identity.itemId)).checkpoint.root;
  assert.equal(body.kind === 'markdown' && body.content, '# Evidence');
  assert.equal(await session.createTemplate('Research', 'different', identity), false);
  const reopened = create(); assert.equal(await reopened.refresh(), true);
  assert.equal(reopened.getSnapshot().templates[0].id, identity.itemId);
  assert.equal(await reopened.deleteItems([identity.itemId]), true);
  assert.equal(reopened.getSnapshot().templates.length, 0);
  assert.deepEqual((await repository.read(identity.itemId)).checkpoint.root, body);
});

test('note publication uses the captured folder and mixed sibling tail, rejecting missing folders before ID allocation', async () => {
  const { session, repository, scope, create } = await setup();
  await session.createFolder('destination', null); const destination = session.getSnapshot().createdFolderId!;
  await session.createFolder('other', null); const other = session.getSnapshot().createdFolderId!;
  const nested = crypto.randomUUID(), distant = crypto.randomUUID();
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [session.getSnapshot().selectedVersion!], changes: [
      { type: 'put-folder', folder: { id: nested, title: 'existing sibling', parentId: destination, position: 7 } },
      { type: 'put-folder', folder: { id: distant, title: 'distant', parentId: other, position: 900 } },
    ] })).status, 'durable');
  await session.refresh();
  const input = { kind: 'markdown' as const, title: 'captured', folderId: destination };
  const saving = session.create(input); input.folderId = other; input.title = 'changed';
  assert.equal(await saving, true); const itemId = session.getSnapshot().createdId!;
  const item = session.getSnapshot().items.find(item => item.id === itemId)!;
  assert.equal(item.folderId, destination); assert.equal(item.position, 8); assert.equal(item.title, 'captured');
  assert.equal((await repository.read(itemId)).checkpoint.root.kind, 'markdown');
  const restored = create(); await restored.refresh(); assert.deepEqual(restored.getSnapshot().items.find(value => value.id === itemId), item);
  assert.equal(await restored.create({ kind: 'notebook', title: 'paper', folderId: destination }), true);
  assert.equal(restored.getSnapshot().items.find(value => value.id === restored.getSnapshot().createdId)!.position, 9);
  let generated = 0;
  const invalid = new LibrarySession({ repository, isActive: () => true, makeId: () => { generated++; return crypto.randomUUID(); } });
  await invalid.refresh(); const before = await repository.read(scope.libraryId), records = await repository.pendingRecords();
  assert.equal(await invalid.create({ kind: 'markdown', title: 'missing', folderId: crypto.randomUUID() }), false);
  assert.equal(generated, 0); assert.deepEqual(await repository.read(scope.libraryId), before);
  assert.deepEqual(await repository.pendingRecords(), records); assert.equal((await repository.pendingIntents()).length, 0);
});

test('folder create, move, rename, promote-delete and Undo survive reload without touching content', async () => {
  const { session, repository, create } = await setup();
  await session.create({ kind: 'markdown', title: 'content' }); const itemId = session.getSnapshot().createdId!;
  const content = await repository.read(itemId);
  assert.equal(await session.createFolder('parent', null), true); const parent = session.getSnapshot().createdFolderId!;
  assert.ok(parent); assert.equal(session.getSnapshot().createdId, null);
  assert.equal(await session.createFolder('child', parent), true); const child = session.getSnapshot().createdFolderId!;
  const ids = [itemId], moving = session.moveItems(ids, parent); ids[0] = crypto.randomUUID();
  assert.equal(await moving, true); assert.equal(session.getSnapshot().items[0].folderId, parent);
  assert.equal(await session.renameFolder(parent, 'renamed', 'parent'), true);
  assert.equal(await session.moveFolder(child, null), true); assert.equal(await session.undo(), true);
  assert.equal(await session.removeFolder(parent), true);
  assert.equal(session.getSnapshot().items[0].folderId, null);
  assert.equal(session.getSnapshot().folders.find(folder => folder.id === child)!.parentId, null);
  const restored = create(); assert.equal(await restored.refresh(), true); assert.equal(await restored.undo(), true);
  assert.equal(restored.getSnapshot().folders.find(folder => folder.id === parent)!.title, 'renamed');
  assert.equal(restored.getSnapshot().folders.find(folder => folder.id === child)!.parentId, parent);
  assert.equal(restored.getSnapshot().items[0].folderId, parent);
  assert.equal(await restored.redo(), true, restored.getSnapshot().error); assert.equal(restored.getSnapshot().folders.some(folder => folder.id === parent), false);
  assert.deepEqual(await repository.read(itemId), content);
});

test('folder recovery retains create ID and no-op moves and renames allocate no history', async () => {
  const { session, repository, create, scope } = await setup();
  const commit = repository.commit.bind(repository); let lose = true;
  const sent: Parameters<typeof repository.commit>[0][] = [];
  repository.commit = async (...args) => { sent.push(structuredClone(args[0])); const result = await commit(...args); if (lose) { lose = false; throw new Error('lost'); } return result; };
  assert.equal(await session.createFolder('retained', null), false);
  assert.equal(session.getSnapshot().createdFolderId, null);
  const restored = create(); assert.equal(await restored.refresh(), true); assert.equal(await restored.retry(), true);
  assert.deepEqual(sent[1], sent[0]); const id = restored.getSnapshot().createdFolderId!; assert.ok(id);
  let generated = 0;
  const noops = new LibrarySession({ repository, isActive: () => true, makeId: () => { generated++; return crypto.randomUUID(); } });
  await noops.refresh(); const before = await repository.read(scope.libraryId);
  assert.equal(await noops.renameFolder(id, 'retained', 'retained'), true);
  assert.equal(await noops.moveFolder(id, null), true); assert.equal(await noops.moveItems([], id), true);
  assert.equal(generated, 0); assert.deepEqual(await repository.read(scope.libraryId), before);
  assert.equal(await noops.renameFolder(id, 'different', 'stale'), false);
  assert.equal(await noops.moveFolder(id, id), false);
  assert.deepEqual(await repository.read(scope.libraryId), before);
});

test('bulk folder moves refuse owned or missing targets atomically and owner movement leaves child location inherited', async () => {
  const { session, repository, scope } = await setup();
  await session.create({ kind: 'markdown', title: 'owner' }); const owner = session.getSnapshot().createdId!;
  await session.create({ kind: 'markdown', title: 'child' }); const child = session.getSnapshot().items.find(item => item.id !== owner)!;
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [session.getSnapshot().selectedVersion!], changes: [{ type: 'put-item', item: { ...child, ownerId: owner } }] })).status, 'durable');
  await session.refresh(); await session.createFolder('destination', null); const destination = session.getSnapshot().createdFolderId!;
  const before = await repository.read(scope.libraryId);
  assert.equal(await session.moveItems([owner, child.id], destination), false);
  assert.equal(await session.moveItems([owner, crypto.randomUUID()], destination), false);
  assert.deepEqual(await repository.read(scope.libraryId), before);
  assert.equal(await session.moveItems([owner], destination), true);
  assert.equal(session.getSnapshot().items.find(item => item.id === owner)!.folderId, destination);
  assert.equal(session.getSnapshot().items.find(item => item.id === child.id)!.folderId, null);
  assert.equal(await session.undo(), true);
});

test('bulk tags and read are one history operation, preserve order, and no-ops create no IDs', async () => {
  const { session, repository, scope, create } = await setup();
  await session.create({ kind: 'markdown', title: 'one' }); await session.create({ kind: 'notebook', title: 'two' });
  const ids = session.getSnapshot().items.map(item => item.id);
  assert.equal(await session.updateTags(ids, { mode: 'add', tags: [' z ', 'a', 'z'] }), true);
  assert.deepEqual(session.getSnapshot().items.map(item => item.tags), [['z', 'a'], ['z', 'a']]);
  assert.equal(session.getSnapshot().createdId, null);
  const before = await repository.read(scope.libraryId); let generated = 0;
  const noop = new LibrarySession({ repository, isActive: () => true, makeId: () => { generated++; return crypto.randomUUID(); } });
  await noop.refresh();
  assert.equal(await noop.updateTags([...ids, ids[0]], { mode: 'add', tags: ['a'] }), true);
  assert.equal(await noop.setRead(ids, false), true); assert.equal(generated, 0);
  assert.deepEqual(await repository.read(scope.libraryId), before);
  assert.equal(await session.setRead(ids, true), true);
  const restored = create(); await restored.refresh(); assert.equal(await restored.undo(), true);
  assert.deepEqual(restored.getSnapshot().items.map(item => [item.read, item.tags]), [[false, ['z', 'a']], [false, ['z', 'a']]]);
  assert.equal(await restored.undo(), true); assert.deepEqual(restored.getSnapshot().items.map(item => item.tags), [[], []]);
  assert.equal(await restored.redo(), true); assert.equal(await restored.redo(), true);
  assert.deepEqual(restored.getSnapshot().items.map(item => [item.read, item.tags]), [[true, ['z', 'a']], [true, ['z', 'a']]]);
});

test('bulk lost reply recovery retries identical payload and never auto-opens a prior creation', async () => {
  const { session, repository, create, scope } = await setup();
  await session.create({ kind: 'markdown', title: 'one' }); await session.create({ kind: 'markdown', title: 'two' });
  const ids = session.getSnapshot().items.map(item => item.id), commit = repository.commit.bind(repository);
  const sent: Parameters<typeof repository.commit>[0][] = []; let lose = true;
  repository.commit = async (...args) => { sent.push(structuredClone(args[0])); const result = await commit(...args); if (lose) { lose = false; throw new Error('lost'); } return result; };
  assert.equal(await session.updateTags(ids, { mode: 'add', tags: ['saved'] }), false);
  assert.equal(session.getSnapshot().pendingKind, 'edit'); assert.equal(session.getSnapshot().createdId, null);
  const raw = structuredClone(await repository.readIntent(scope.libraryId)); assert.ok(raw);
  const restored = create(); assert.equal(await restored.refresh(), true); assert.equal(restored.canLeave(), false);
  assert.deepEqual(await repository.readIntent(scope.libraryId), raw);
  assert.equal(await restored.retry(), true); assert.deepEqual(sent[1], sent[0]); assert.equal(restored.getSnapshot().createdId, null);
  assert.equal(await restored.undo(), true); assert.deepEqual(restored.getSnapshot().items.map(item => item.tags), [[], []]);
});

test('inputs are captured before asynchronous reads and bulk validation cannot partially edit', async () => {
  const { session, repository, scope } = await setup();
  await session.create({ kind: 'markdown', title: 'one' }); await session.create({ kind: 'markdown', title: 'two' });
  const [first, second] = session.getSnapshot().items.map(item => item.id);
  const ids = [first], input = { mode: 'replace' as const, tags: ['original'], expectedTags: { [first]: [] as string[] } };
  const work = session.updateTags(ids, input);
  ids[0] = second; input.tags[0] = 'mutated'; input.expectedTags[first].push('mutated');
  assert.equal(await work, true);
  assert.deepEqual(session.getSnapshot().items.map(item => item.tags), [['original'], []]);
  const readIds = [first], read = session.setRead(readIds, true); readIds[0] = second;
  assert.equal(await read, true); assert.deepEqual(session.getSnapshot().items.map(item => item.read), [true, false]);
  const before = await repository.read(scope.libraryId);
  assert.equal(await session.updateTags([first, crypto.randomUUID()], { mode: 'add', tags: ['never'] }), false);
  assert.equal(await session.setRead([first, crypto.randomUUID()], false), false);
  assert.equal(await session.updateTags([first, second], { mode: 'replace', tags: ['never'], expectedTags: { [first]: ['original'], [second]: ['stale'] } }), false);
  assert.deepEqual(await repository.read(scope.libraryId), before); assert.equal((await repository.pendingIntents()).length, 0);
});

test('remove and replace preserve exact tag history and an aborted read edit survives recovery', async () => {
  const { session, repository, create } = await setup();
  await session.create({ kind: 'markdown', title: 'one' }); const id = session.getSnapshot().createdId!;
  assert.equal(await session.updateTags([id], { mode: 'add', tags: ['z', 'a', 'middle'] }), true);
  assert.equal(await session.updateTags([id], { mode: 'remove', tags: ['a'] }), true);
  assert.deepEqual(session.getSnapshot().items[0].tags, ['z', 'middle']);
  assert.equal(await session.updateTags([id], { mode: 'replace', tags: [' middle ', 'z'], expectedTags: { [id]: ['z', 'middle'] } }), true);
  assert.deepEqual(session.getSnapshot().items[0].tags, ['middle', 'z']);
  assert.equal(await session.undo(), true); assert.deepEqual(session.getSnapshot().items[0].tags, ['z', 'middle']);
  assert.equal(await session.undo(), true); assert.deepEqual(session.getSnapshot().items[0].tags, ['z', 'a', 'middle']);
  const commit = repository.commit.bind(repository); let abort = true;
  const sent: Parameters<typeof repository.commit>[0][] = [];
  repository.commit = async (...args) => { sent.push(structuredClone(args[0])); return abort ? { status: 'aborted', reason: 'quota' } : commit(...args); };
  assert.equal(await session.setRead([id], true), false); assert.equal(session.canLeave(), false);
  assert.equal(session.getSnapshot().items[0].read, false);
  const restored = create(); assert.equal(await restored.refresh(), true); assert.equal(restored.getSnapshot().pendingKind, 'edit');
  abort = false; assert.equal(await restored.retry(), true); assert.deepEqual(sent[1], sent[0]);
  assert.equal(restored.getSnapshot().items[0].read, true); assert.equal(restored.getSnapshot().canRedo, false);
  assert.deepEqual(restored.getSnapshot().items[0].tags, ['z', 'a', 'middle']);
  assert.equal(await restored.undo(), true); assert.equal(restored.getSnapshot().items[0].read, false);
});

test('Markdown and paper initial content publish atomically with catalog items and survive reload', async () => {
  const { session, repository, create } = await setup();
  for (const kind of ['markdown', 'notebook'] as const) {
    assert.equal(await session.create({ kind, title: `  ${kind}  ` }), true); assert.equal(session.canLeave(), true);
    const id = session.getSnapshot().createdId!;
    assert.equal(session.getSnapshot().items.find(item => item.id === id)!.title, kind);
    const root = (await repository.read(id)).checkpoint.root;
    if (root.kind === 'markdown') { assert.equal(root.content, ''); assert.deepEqual(root.imageResources, []); }
    else { assert.equal(root.kind, 'document'); if (root.kind === 'document') { assert.equal(root.pages.length, 1); assert.equal(root.pages[0].background.kind, 'paper'); } }
    assert.equal((await repository.pendingIntents()).length, 0);
  }
  const reload = create(); assert.equal(await reload.refresh(), true); assert.equal(reload.getSnapshot().items.length, 2);
  const records = await repository.pendingRecords(); assert.equal(records.length, 2); assert.ok(records.every(record => record.publication?.content));
});

test('lost reply and restart recover the exact publication without generating a second item', async () => {
  const { session, repository, create } = await setup(); const publish = repository.publish.bind(repository);
  let lose = true; const sent: ContentPublication[] = [];
  repository.publish = async (publication, history) => { sent.push(structuredClone(publication)); const result = await publish(publication, history); if (lose) { lose = false; throw new Error('reply-lost'); } return result; };
  assert.equal(await session.create({ kind: 'markdown', title: 'retained' }), false); assert.equal(session.canLeave(), false);
  const original = structuredClone((await repository.pendingIntents())[0]);
  await session.refresh(); assert.deepEqual((await repository.pendingIntents())[0], original);
  const recovered = create(); assert.equal(await recovered.refresh(), true); assert.equal(recovered.canLeave(), false);
  assert.equal(await recovered.retry(), true); assert.deepEqual(sent[1], sent[0]); assert.equal(recovered.getSnapshot().items.length, 1);
  assert.equal((await repository.pendingIntents()).length, 0);
});

test('proven publication abort keeps retry identity and never exposes an item or body', async () => {
  const { session, repository } = await setup(); const publish = repository.publish.bind(repository); let fail = true;
  const sent: ContentPublication[] = [];
  repository.publish = async (publication, history) => { sent.push(structuredClone(publication)); return fail ? { status: 'aborted', reason: 'quota' } : publish(publication, history); };
  assert.equal(await session.create({ kind: 'notebook', title: 'paper' }), false);
  assert.deepEqual(session.getSnapshot().items, []); assert.equal(session.getSnapshot().createdId, null);
  await assert.rejects(repository.read(sent[0].content!.id));
  fail = false; assert.equal(await session.retry(), true); assert.deepEqual(sent[1], sent[0]);
});

test('multiple catalog heads freeze creation and require explicit selection for the read model', async () => {
  const { session, repository, library, scope } = await setup();
  const heads: string[] = [];
  for (const title of ['a', 'b']) { const id = crypto.randomUUID(); heads.push(id); await repository.commit({ kind: 'library', id, libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [library.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position: 0 } }] }); }
  await session.refresh(); assert.equal(session.getSnapshot().selectedVersion, null); assert.match(session.getSnapshot().error, /selection/);
  assert.equal(await session.create({ kind: 'markdown', title: 'no guessing' }), false);
  assert.equal(await session.refresh(heads[0]), true); assert.equal(session.getSnapshot().selectedVersion, heads[0]);
  assert.equal(await session.refresh(), true); assert.equal(session.getSnapshot().selectedVersion, heads[0]);
  assert.equal(await session.create({ kind: 'markdown', title: 'still frozen' }), false); assert.equal((await repository.pendingIntents()).length, 0);
  assert.equal(await session.refresh(library.version), false);
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [heads[0]], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'advanced', parentId: null, position: 0 } }] })).status, 'durable');
  assert.equal(await session.refresh(), true); assert.equal(session.getSnapshot().selectedVersion, null);
});

test('inactive completion keeps durable publication and recovery state without publishing success to the UI', async () => {
  const { session, repository, active } = await setup(); const publish = repository.publish.bind(repository), entered = gate(), release = gate();
  repository.publish = async (publication, history) => { const result = await publish(publication, history); entered.resolve(); await release.promise; return result; };
  const work = session.create({ kind: 'markdown', title: 'saved' }); await entered.promise; const before = session.getSnapshot();
  active(false); release.resolve(); assert.equal(await work, false); assert.equal(session.getSnapshot(), before);
  assert.equal((await repository.pendingPublications()).length, 1); assert.equal(session.canLeave(), false);
  active(true); assert.equal(await session.retry(), true); assert.equal(session.getSnapshot().items.length, 1); assert.equal(session.canLeave(), true);
});

test('catalog deletion hides items and unsupported recovery is preserved', async () => {
  const { session, repository, scope } = await setup(); await session.create({ kind: 'markdown', title: 'hidden' });
  const id = session.getSnapshot().createdId!, parent = session.getSnapshot().selectedVersion!;
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId, parents: [parent],
    changes: [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), itemIds: [id], observed: [{ targetId: id, heads: (await repository.read(id)).heads }], active: true } }] })).status, 'durable');
  await session.refresh(); assert.deepEqual(session.getSnapshot().items, []); assert.equal(session.getSnapshot().createdId, null);
  const record = { id: crypto.randomUUID(), intent: { request: { batch: { kind: 'library' as const, id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [(await repository.read(scope.libraryId)).heads[0]], changes: [{ type: 'put-folder' as const, folder: { id: crypto.randomUUID(), title: 'held', parentId: null, position: 0 } }] } }, dispatched: false, undoRequested: false } };
  await repository.replaceIntent(scope.libraryId, record, null);
  assert.equal(await session.refresh(), false); assert.equal(session.canLeave(), false); assert.deepEqual(await repository.readIntent(scope.libraryId), record);
});

test('a concurrent catalog branch cannot rebase a retry or expose an unselected created item', async () => {
  const { session, repository, library, scope } = await setup(); const publish = repository.publish.bind(repository);
  const sent: ContentPublication[] = []; let lose = true;
  repository.publish = async (publication, history) => { sent.push(structuredClone(publication)); const result = await publish(publication, history);
    if (lose) { lose = false; throw new Error('lost'); } return result; };
  await session.create({ kind: 'markdown', title: 'branch' });
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [library.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'peer', parentId: null, position: 0 } }] })).status, 'durable');
  await session.refresh(); assert.equal(session.getSnapshot().heads.length, 2);
  assert.equal(await session.retry(), true); assert.deepEqual(sent[1], sent[0]);
  assert.equal(session.getSnapshot().createdId, null); assert.deepEqual(session.getSnapshot().items, []);
  assert.equal(await session.refresh(sent[0].libraryBatch.id), true);
  assert.equal(session.getSnapshot().createdId, sent[0].content!.id); assert.equal(session.getSnapshot().items.length, 1);
});

test('direct retry clears a transient catalog failure after the journal was already recovered', async () => {
  const { session, repository, create, scope } = await setup(); const publish = repository.publish.bind(repository);
  repository.publish = async (publication, history) => { await publish(publication, history); throw new Error('lost'); };
  await session.create({ kind: 'markdown', title: 'recover' }); repository.publish = publish;
  const read = repository.read.bind(repository); let fail = true;
  repository.read = async id => { if (fail && id === scope.libraryId) { fail = false; throw new Error('transient-catalog'); } return read(id); };
  const recovered = create(); assert.equal(await recovered.refresh(), false); assert.equal(recovered.canLeave(), false);
  assert.equal(await recovered.retry(), true); assert.equal(recovered.canLeave(), true);
  assert.equal(recovered.getSnapshot().pendingId, null); assert.equal((await repository.pendingIntents()).length, 0);
  assert.equal(await recovered.create({ kind: 'notebook', title: 'next' }), true);
});

test('rename preserves metadata, ignores no-op, and restores durable Undo/Redo across reload', async () => {
  const { session, repository, create, scope } = await setup(); await session.create({ kind: 'markdown', title: 'original' });
  const id = session.getSnapshot().createdId!, item = session.getSnapshot().items[0];
  assert.equal(await session.rename(id, 'renamed'), true); assert.equal(session.getSnapshot().createdId, null);
  assert.deepEqual(session.getSnapshot().items[0], { ...item, title: 'renamed' }); assert.equal(session.getSnapshot().canUndo, true);
  const count = (await repository.read(scope.libraryId)).checkpoint.batches.length;
  assert.equal(await session.rename(id, 'renamed'), true); assert.equal((await repository.read(scope.libraryId)).checkpoint.batches.length, count);
  const restored = create(); await restored.refresh(); assert.equal(restored.getSnapshot().canUndo, true);
  assert.equal(await restored.undo(), true); assert.equal(restored.getSnapshot().items[0].title, 'original');
  const again = create(); await again.refresh(); assert.equal(again.getSnapshot().canRedo, true);
  assert.equal(await again.redo(), true); assert.equal(again.getSnapshot().items[0].title, 'renamed');
  assert.equal(again.getSnapshot().pendingKind, null); assert.equal(again.getSnapshot().createdId, null);
});

test('unknown rename and Undo retain exact batch/history across recovery and never auto-open old creation', async () => {
  const { session, repository, create } = await setup(); await session.create({ kind: 'notebook', title: 'original' });
  const id = session.getSnapshot().createdId!, commit = repository.commit.bind(repository);
  let lose = true; const requests: unknown[] = [];
  repository.commit = async (batch, history) => { requests.push(structuredClone({ batch, history })); const result = await commit(batch, history);
    if (lose) { lose = false; throw new Error('lost'); } return result; };
  assert.equal(await session.rename(id, 'renamed'), false); assert.equal(session.getSnapshot().pendingKind, 'edit');
  assert.equal(session.getSnapshot().createdId, null); assert.equal(session.getSnapshot().canUndo, false);
  const recovered = create(); assert.equal(await recovered.refresh(), true); assert.equal(recovered.getSnapshot().pendingKind, 'edit');
  assert.equal(await recovered.retry(), true); assert.deepEqual(requests[1], requests[0]); assert.equal(recovered.getSnapshot().createdId, null);
  lose = true; assert.equal(await recovered.undo(), false); assert.equal(recovered.getSnapshot().pendingKind, 'undo');
  const restored = create(); await restored.refresh(); assert.equal(restored.getSnapshot().pendingKind, 'undo');
  assert.equal(await restored.retry(), true); assert.deepEqual(requests[3], requests[2]);
  assert.equal(restored.getSnapshot().items[0].title, 'original'); assert.equal(restored.getSnapshot().canRedo, true);
});

test('remote catalog gaps reset local history and concurrent heads prohibit rename and Undo', async () => {
  const { session, repository, scope } = await setup(); await session.create({ kind: 'markdown', title: 'original' });
  const id = session.getSnapshot().createdId!; await session.rename(id, 'local');
  const parent = session.getSnapshot().selectedVersion!, first = crypto.randomUUID();
  assert.equal((await repository.commit({ kind: 'library', id: first, libraryId: scope.libraryId, targetId: scope.libraryId, parents: [parent],
    changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'remote', parentId: null, position: 0 } }] })).status, 'durable');
  await session.refresh(); assert.equal(session.getSnapshot().canUndo, false); assert.equal(await session.undo(), false);
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId, parents: [parent],
    changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'branch', parentId: null, position: 0 } }] })).status, 'durable');
  await session.refresh(first); assert.equal(session.getSnapshot().heads.length, 2);
  assert.equal(await session.rename(id, 'refused'), false); assert.equal(await session.undo(), false);
  assert.equal((await repository.pendingIntents()).length, 0);
});

test('rename protects the edit-start title while preserving independently changed item attributes', async () => {
  const { session, repository, scope } = await setup(); await session.create({ kind: 'markdown', title: 'original' });
  const id = session.getSnapshot().createdId!, item = session.getSnapshot().items[0];
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [session.getSnapshot().selectedVersion!], changes: [{ type: 'put-item', item: { ...item, tags: ['peer'], read: true, metadata: { source: 'peer' } } }] })).status, 'durable');
  assert.equal(await session.rename(id, 'mine', 'original'), true);
  assert.deepEqual(session.getSnapshot().items[0], { ...item, title: 'mine', tags: ['peer'], read: true, metadata: { source: 'peer' } });
  const latest = session.getSnapshot().items[0];
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [session.getSnapshot().selectedVersion!], changes: [{ type: 'put-item', item: { ...latest, title: 'peer title' } }] })).status, 'durable');
  const count = (await repository.read(scope.libraryId)).checkpoint.batches.length;
  assert.equal(await session.rename(id, 'peer title', 'mine'), false); assert.match(session.getSnapshot().error, /changed/);
  assert.equal((await repository.read(scope.libraryId)).checkpoint.batches.length, count); assert.equal((await repository.pendingIntents()).length, 0);
});

test('recovery refuses an Undo payload that is not the recorded operation inverse before dispatch', async () => {
  const { session, repository, create, scope } = await setup(); await session.create({ kind: 'markdown', title: 'before' });
  await session.rename(session.getSnapshot().createdId!, 'after');
  repository.commit = async () => ({ status: 'aborted', reason: 'quota' });
  assert.equal(await session.undo(), false); const raw = structuredClone(await repository.readIntent(scope.libraryId)); assert.ok(raw);
  const corrupt = structuredClone(raw), request = corrupt.intent.request;
  assert.ok('batch' in request && request.batch.kind === 'library');
  if (!('batch' in request) || request.batch.kind !== 'library' || request.batch.changes[0].type !== 'put-item') return;
  request.batch.changes[0].item.title = 'not the inverse';
  const readIntent = repository.readIntent.bind(repository); repository.readIntent = async () => corrupt;
  const recovered = create(); assert.equal(await recovered.refresh(), false); assert.equal(recovered.canLeave(), false);
  assert.equal(await recovered.retry(), false); assert.deepEqual(await readIntent(scope.libraryId), raw);
});

test('unsupported current journal mutations are preserved and never dispatched despite matching history', async () => {
  for (const kind of ['folder', 'deletion', 'creation', 'metadata', 'tags-position'] as const) {
    const { repository, session, create, scope } = await setup(); await session.create({ kind: 'markdown', title: 'existing' });
    const item = session.getSnapshot().items[0], parent = session.getSnapshot().selectedVersion!, id = crypto.randomUUID();
    const changes: LibraryChange[] = kind === 'folder' ? [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'new', parentId: null, position: 0 } },
      { type: 'put-item', item: { ...item, metadata: { unapproved: 'value' } } }]
      : kind === 'deletion' ? [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), itemIds: [item.id],
        observed: [{ targetId: item.id, heads: (await repository.read(item.id)).heads }], active: false } }]
        : [{ type: 'put-item', item: kind === 'creation' ? { ...item, id: crypto.randomUUID() }
          : kind === 'tags-position' ? { ...item, tags: ['allowed'], position: item.position + 1 }
            : { ...item, metadata: { unapproved: 'value' } } }];
    const record = { id: crypto.randomUUID(), intent: { request: { batch: { kind: 'library' as const, id,
      libraryId: scope.libraryId, targetId: scope.libraryId, parents: [parent], changes },
    history: { operationId: id, beforeVersion: parent, afterVersion: id, undoRequested: false } }, dispatched: false, undoRequested: false } };
    await repository.replaceIntent(scope.libraryId, record, null);
    let commits = 0; repository.commit = async () => { commits++; throw new Error('must not dispatch'); };
    const recovered = create(); assert.equal(await recovered.refresh(), false); assert.equal(await recovered.retry(), false);
    assert.equal(recovered.canLeave(), false); assert.equal(commits, 0);
    assert.deepEqual(await repository.readIntent(scope.libraryId), record);
  }
});

test('pending history actions must refer to the latest recorded operation, never random or older IDs or a history gap', async () => {
  for (const action of ['undo', 'redo'] as const) for (const reference of ['random', 'older', 'gap'] as const) {
    const { repository, session, create, scope } = await setup(); await session.create({ kind: 'markdown', title: 'zero' });
    const itemId = session.getSnapshot().createdId!;
    await session.rename(itemId, 'one'); const older = session.getSnapshot().selectedVersion!;
    await session.rename(itemId, 'two'); const latest = session.getSnapshot().selectedVersion!;
    if (action === 'redo') assert.equal(await session.undo(), true);
    let parent = session.getSnapshot().selectedVersion!;
    if (reference === 'gap') {
      const previous = parent;
      parent = crypto.randomUUID();
      assert.equal((await repository.commit({ kind: 'library', id: parent, libraryId: scope.libraryId, targetId: scope.libraryId, parents: [previous],
        changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'remote gap', parentId: null, position: 0 } }] })).status, 'durable');
    }
    const id = crypto.randomUUID(), operationId = reference === 'random' ? crypto.randomUUID() : reference === 'older' ? older : latest;
    const item = session.getSnapshot().items[0];
    const record = { id: crypto.randomUUID(), intent: { request: { batch: { kind: 'library' as const, id, libraryId: scope.libraryId, targetId: scope.libraryId,
      parents: [parent], changes: [{ type: 'put-item' as const, item: { ...item, title: action === 'undo' ? 'one' : 'two' } }] }, history: {
      operationId: id, beforeVersion: parent, afterVersion: id, undoRequested: false, action: { kind: action, operationId } } }, dispatched: false, undoRequested: false } };
    await repository.replaceIntent(scope.libraryId, record, null);
    let commits = 0; repository.commit = async () => { commits++; throw new Error('must not dispatch'); };
    const recovered = create(); assert.equal(await recovered.refresh(), false); assert.equal(await recovered.retry(), false);
    assert.equal(commits, 0); assert.deepEqual(await repository.readIntent(scope.libraryId), record);
  }
});

test('owned note creation, links, detachment, owner deletion modes, local-edit guard, and Undo/Redo survive reload', async () => {
  const { repository, scope } = await setup();
  let allowDelete = true;
  const makeSession = () => new LibrarySession({
    repository, isActive: () => true,
    prepareDeleteTargets: async () => allowDelete,
    canDeleteTargetsSync: () => allowDelete,
  });
  const session = makeSession();
  await session.refresh();
  await session.createFolder('Papers', null);
  const folderId = session.getSnapshot().createdFolderId!;

  // Commit an independent PDF item in folderId and initialize its document history
  const pdfId = crypto.randomUUID(), resId = crypto.randomUUID(), pageId = crypto.randomUUID(), revId = crypto.randomUUID();
  const bytes = new Uint8Array([1, 2, 3, 4]), sha = await resourceHash(bytes);
  await repository.storeResource({ id: resId, sha256: sha, mediaType: 'application/pdf', bytes });
  await repository.initialize({ kind: 'document', id: pdfId, version: revId, deletedPages: [],
    pages: [{ id: pageId, backgroundRevision: revId, lifecycleVersion: revId, annotationVersion: revId,
      widthPt: 600, heightPt: 800, background: { kind: 'pdf', resourceId: resId, sourceRevision: sha, pdfPage: 1 }, annotations: [] }] });
  assert.equal((await repository.commit({
    kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [session.getSnapshot().selectedVersion!],
    changes: [{ type: 'put-item', item: { id: pdfId, kind: 'pdf', title: 'Paper A', ownerId: null, folderId, position: 0, tags: [], read: false, resourceId: resId, metadata: {} } }],
  })).status, 'durable');
  await session.refresh();

  // Create an independent note and an owned note under Paper A
  assert.equal(await session.create({ kind: 'markdown', title: 'Free Note', folderId: null }), true);
  const freeNoteId = session.getSnapshot().createdId!;
  assert.equal(await session.create({ kind: 'markdown', title: 'Owned Note', ownerId: pdfId }), true);
  const ownedNoteId = session.getSnapshot().createdId!;
  assert.equal(session.getSnapshot().items.find(item => item.id === ownedNoteId)!.ownerId, pdfId);
  assert.equal(session.getSnapshot().items.find(item => item.id === ownedNoteId)!.folderId, null);

  // Reject linking owned note, accept linking Paper A and Free Note, no-op on duplicate
  assert.equal(await session.addLinks([{ pdfId, noteId: ownedNoteId }]), false);
  assert.equal(await session.addLinks([{ pdfId, noteId: freeNoteId }]), true);
  assert.equal(session.getSnapshot().links.length, 1);
  const beforeDup = await repository.read(scope.libraryId);
  assert.equal(await session.addLinks([{ pdfId, noteId: freeNoteId }]), true);
  assert.deepEqual(await repository.read(scope.libraryId), beforeDup);

  // Detach owned note -> placed in Paper A's folder, then Undo re-attaches it to Paper A
  assert.equal(await session.detachNotes([ownedNoteId]), true);
  assert.equal(session.getSnapshot().items.find(item => item.id === ownedNoteId)!.ownerId, null);
  assert.equal(session.getSnapshot().items.find(item => item.id === ownedNoteId)!.folderId, folderId);
  assert.equal(await session.undo(), true);
  assert.equal(session.getSnapshot().items.find(item => item.id === ownedNoteId)!.ownerId, pdfId);

  // Guard blocks deletion when target has uncommitted local edits
  allowDelete = false;
  assert.equal(await session.deleteItems([pdfId], 'detach'), false);
  assert.match(session.getSnapshot().error, /library-delete-target-busy/);
  allowDelete = true;

  // Owner deletion with default 'detach' detaches Owned Note into folderId, removes link, and hides Paper A
  assert.equal(await session.deleteItems([pdfId], 'detach'), true);
  assert.equal(session.getSnapshot().items.some(item => item.id === pdfId), false);
  assert.equal(session.getSnapshot().links.length, 0);
  const keptNote = session.getSnapshot().items.find(item => item.id === ownedNoteId)!;
  assert.equal(keptNote.ownerId, null);
  assert.equal(keptNote.folderId, folderId);

  // Reload and Undo restores Paper A, re-attaches Owned Note, and restores the link
  const reloaded = makeSession();
  await reloaded.refresh();
  assert.equal(await reloaded.undo(), true);
  assert.equal(reloaded.getSnapshot().items.some(item => item.id === pdfId), true);
  assert.equal(reloaded.getSnapshot().links.length, 1);
  assert.equal(reloaded.getSnapshot().items.find(item => item.id === ownedNoteId)!.ownerId, pdfId);

  // Owner deletion with explicit 'delete' deletes both Paper A and Owned Note, and Undo restores both
  assert.equal(await reloaded.deleteItems([pdfId], 'delete'), true);
  assert.equal(reloaded.getSnapshot().items.some(item => item.id === pdfId), false);
  assert.equal(reloaded.getSnapshot().items.some(item => item.id === ownedNoteId), false);
  assert.equal(await reloaded.undo(), true);
  assert.equal(reloaded.getSnapshot().items.some(item => item.id === pdfId), true);
  assert.equal(reloaded.getSnapshot().items.find(item => item.id === ownedNoteId)!.ownerId, pdfId);
});

test('creation Undo after lost reply resends publication before committing deletion, and deletedContent tracks unobserved edits and restore', async () => {
  const { session, repository, create, scope } = await setup();
  const publish = repository.publish.bind(repository);
  let losePublish = true;
  const published: ContentPublication[] = [];
  repository.publish = async (publication, history) => {
    published.push(structuredClone(publication));
    const result = await publish(publication, history);
    if (losePublish) { losePublish = false; throw new Error('reply-lost'); }
    return result;
  };
  assert.equal(await session.create({ kind: 'markdown', title: 'Uncertain Note' }), false);
  assert.equal(session.getSnapshot().pendingKind, 'create');
  assert.equal(session.canLeave(), false);

  // Cancel/Undo the pending creation after lost reply -> resends same publication, then commits put-deletion
  assert.equal(await session.cancelCreate(), true);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1], published[0]);
  assert.equal(session.canLeave(), true);
  assert.equal(session.getSnapshot().items.length, 0);
  assert.equal(session.getSnapshot().createdId, null);
  assert.equal(session.getSnapshot().deletedItems.length, 1);
  const deletedId = session.getSnapshot().deletedItems[0].id;
  assert.equal(session.getSnapshot().deletedContent.find(entry => entry.itemId === deletedId)?.state, 'observed');

  // If a peer edit arrives on the deleted markdown item, deletedContent reports 'unobserved'
  const initialVersion = published[0].content!.version;
  await repository.receive([{
    kind: 'markdown', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: deletedId,
    parents: [initialVersion], content: 'post-delete peer edit', imageResources: [],
  }]);
  await session.refresh();
  assert.equal(session.getSnapshot().deletedContent.find(entry => entry.itemId === deletedId)?.state, 'unobserved');

  // Restore from recovery list brings the item back to active items, and Undo/Redo toggles restoration
  const deletionId = session.getSnapshot().deletions[0].id;
  assert.equal(await session.restoreDeleted(deletionId), true);
  assert.equal(session.getSnapshot().items.some(item => item.id === deletedId), true);
  assert.equal(session.getSnapshot().deletedItems.length, 0);
  assert.equal(await session.undo(), true);
  assert.equal(session.getSnapshot().items.some(item => item.id === deletedId), false);
  assert.equal(session.getSnapshot().deletedItems.length, 1);

  // Also verify updateBibliography on a PDF item and its Undo/Redo across reload
  const pdfId = crypto.randomUUID(), resId = crypto.randomUUID(), pageId = crypto.randomUUID(), revId = crypto.randomUUID();
  const bytes = new Uint8Array([1, 2, 3, 4]), sha = await resourceHash(bytes);
  await repository.storeResource({ id: resId, sha256: sha, mediaType: 'application/pdf', bytes });
  await repository.initialize({ kind: 'document', id: pdfId, version: revId, deletedPages: [],
    pages: [{ id: pageId, backgroundRevision: revId, lifecycleVersion: revId, annotationVersion: revId,
      widthPt: 600, heightPt: 800, background: { kind: 'pdf', resourceId: resId, sourceRevision: sha, pdfPage: 1 }, annotations: [] }] });
  assert.equal((await repository.commit({
    kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [session.getSnapshot().selectedVersion!],
    changes: [{ type: 'put-item', item: { id: pdfId, kind: 'pdf', title: 'Bib PDF', ownerId: null, folderId: null, position: 0, tags: [], read: false, resourceId: resId, metadata: {} } }],
  })).status, 'durable');
  await session.refresh();

  assert.equal(await session.updateBibliography(pdfId, {
    author: '  Euler, Leonhard ', year: '2023', venue: 'Journal  of   Math', doi: 'https://doi.org/10.1000/euler', arxiv_id: 'arXiv:2301.12345v1',
  }, { author: '', year: '', venue: '', doi: '', arxiv_id: '' }), true);
  assert.deepEqual(session.getSnapshot().items.find(item => item.id === pdfId)!.metadata, {
    author: 'Euler, Leonhard', year: '2023', venue: 'Journal of Math', doi: '10.1000/euler', arxiv_id: '2301.12345',
  });
  const reloaded = create();
  await reloaded.refresh();
  assert.equal(await reloaded.undo(), true);
  assert.deepEqual(reloaded.getSnapshot().items.find(item => item.id === pdfId)!.metadata, {});
  assert.equal(await reloaded.redo(), true, reloaded.getSnapshot().error);
  assert.equal(reloaded.getSnapshot().items.find(item => item.id === pdfId)!.metadata.author, 'Euler, Leonhard');

  // Verify creation Undo recovery across reload when the inverse deletion commit fails, and guard on Undo/Redo of restoration
  const commit = repository.commit.bind(repository);
  losePublish = true;
  let failInverseCommit = true;
  repository.commit = async (...args) => failInverseCommit ? { status: 'aborted', reason: 'inverse-offline' } : commit(...args);
  assert.equal(await reloaded.create({ kind: 'markdown', title: 'Interrupted Cancel' }), false);
  assert.equal(await reloaded.cancelCreate(), false);
  assert.equal(reloaded.getSnapshot().pendingKind, 'undo');
  assert.equal(reloaded.canLeave(), false);
  const recoveredCancel = create();
  assert.equal(await recoveredCancel.refresh(), true);
  assert.equal(recoveredCancel.getSnapshot().pendingKind, 'undo');
  assert.equal(recoveredCancel.getSnapshot().createdId, null);
  assert.equal(recoveredCancel.canLeave(), false);
  failInverseCommit = false;
  assert.equal(await recoveredCancel.retry(), true);
  assert.equal(recoveredCancel.canLeave(), true);
  assert.equal(recoveredCancel.getSnapshot().createdId, null);
  assert.equal(recoveredCancel.getSnapshot().items.some(item => item.title === 'Interrupted Cancel'), false);
  assert.equal(recoveredCancel.getSnapshot().deletedItems.some(item => item.title === 'Interrupted Cancel'), true);

  // Guard blocks Undo of restoreDeleted (or Redo of delete) when the restored item has uncommitted local edits
  const interruptedDeletionId = recoveredCancel.getSnapshot().deletions.find(d =>
    d.itemIds.includes(recoveredCancel.getSnapshot().deletedItems.find(i => i.title === 'Interrupted Cancel')!.id))!.id;
  assert.equal(await recoveredCancel.restoreDeleted(interruptedDeletionId), true);
  let allowRedoDelete = false;
  const guarded = new LibrarySession({
    repository, isActive: () => true,
    prepareDeleteTargets: async () => allowRedoDelete,
    canDeleteTargetsSync: () => allowRedoDelete,
  });
  await guarded.refresh();
  assert.equal(await guarded.undo(), false);
  assert.match(guarded.getSnapshot().error, /library-delete-target-busy/);
  allowRedoDelete = true;
  assert.equal(await guarded.undo(), true);
});


test('fixed create identity resumes only its own publication and recognizes its durable origin after reload', async () => {
  const { repository, session, create } = await setup();
  const identity = { itemId: crypto.randomUUID(), contentVersion: crypto.randomUUID(), batchId: crypto.randomUUID() };
  const input = { kind: 'markdown' as const, title: 'fixed creation' };
  const publish = repository.publish.bind(repository); let fail = true; const payloads: string[] = [];
  repository.publish = async (...args) => { payloads.push(JSON.stringify(args[0])); if (fail) throw new Error('offline'); return publish(...args); };
  assert.equal(await session.create(input, identity), false);
  assert.equal(await session.create(input, { ...identity, batchId: crypto.randomUUID() }), false);
  assert.equal(payloads.length, 1, 'a different caller cannot retry the pending writer');
  assert.equal(await session.create({ ...input, title: 'changed request' }, identity), false);
  const resumed = create(); await resumed.refresh();
  fail = false; assert.equal(await resumed.create(input, identity), true);
  assert.equal(new Set(payloads).size, 1);
  const restored = create(); await restored.refresh();
  const count = payloads.length;
  assert.equal(await restored.create(input, identity), true);
  assert.equal(payloads.length, count); assert.equal(restored.getSnapshot().createdId, identity.itemId);
  assert.equal(await restored.create({ ...input, title: 'another payload' }, identity), false);
  const snapshot = restored.getSelectedSnapshot()!; snapshot.items[0].title = 'caller mutation';
  assert.equal(restored.getSelectedSnapshot()!.items[0].title, input.title);
});


test('an automatic refresh cannot discard an in-flight explicit catalog choice', async () => {
  const { repository, scope, library: root, session } = await setup();
  const branch = (title: string) => ({ kind:'library' as const, id:crypto.randomUUID(), libraryId:scope.libraryId,
    targetId:scope.libraryId, parents:[root.version], changes:[{ type:'put-folder' as const,
      folder:{ id:crypto.randomUUID(), title, parentId:null, position:0 } }] });
  const a = branch('A'), b = branch('B'); await repository.receive([a,b]);
  assert.equal(await session.refresh(b.id), true);
  assert.equal(session.getSnapshot().selectedVersion, b.id);
  const entered = gate(), release = gate(), read = repository.read.bind(repository); let hold = true;
  repository.read = async id => {
    if (id === scope.libraryId && hold) { hold = false; entered.resolve(); await release.promise; }
    return read(id);
  };
  const selected = session.refresh(a.id); await entered.promise;
  const automatic = session.refresh();
  release.resolve(); await Promise.all([selected, automatic]);
  assert.equal(session.getSnapshot().selectedVersion, a.id, 'automatic refresh must preserve the requested explicit choice');
  assert.equal(session.getSnapshot().folders[0]?.title, 'A');
});

test('a later explicit catalog choice supersedes an earlier in-flight choice', async () => {
  const { repository, scope, library: root, session } = await setup();
  const branch = (title: string) => ({ kind:'library' as const, id:crypto.randomUUID(), libraryId:scope.libraryId,
    targetId:scope.libraryId, parents:[root.version], changes:[{ type:'put-folder' as const,
      folder:{ id:crypto.randomUUID(), title, parentId:null, position:0 } }] });
  const a = branch('A'), b = branch('B'); await repository.receive([a,b]);
  assert.equal(await session.refresh(b.id), true);
  const entered = gate(), release = gate(), read = repository.read.bind(repository); let hold = true;
  repository.read = async id => {
    if (id === scope.libraryId && hold) { hold = false; entered.resolve(); await release.promise; }
    return read(id);
  };
  const earlier = session.refresh(a.id); await entered.promise;
  assert.equal(await session.refresh(b.id), true);
  release.resolve(); assert.equal(await earlier, false);
  assert.equal(session.getSnapshot().selectedVersion, b.id);
  assert.equal(session.getSnapshot().folders[0]?.title, 'B');
});
