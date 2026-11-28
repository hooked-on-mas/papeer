import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentEditSessions } from '../../src/features/reader/DocumentEditSessions.ts';
import { DurableEditRepository } from '../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../support/editMemoryDatabase.ts';
import type { LibraryEditBatch, LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';
import type { MarkdownDraft, MarkdownDraftPort } from '../../src/features/notes/markdown/MarkdownDraftPort.ts';
import type { NoteAppendDraftPort, SavedAnnotationAppend } from '../../src/features/notes/append/NoteAppendDraftPort.ts';
import { freezeAnnotationExport, projectCanonicalAnnotations } from '../../src/features/library/annotations/canonicalAnnotationBrowser.ts';
async function setup() {
  const scope = { accountId: 'registry', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [], folders: [], links: [], deletions: [] };
  await repository.initialize(root); return { repository, scope };
}

test('library resolution recovers unknown result through registry with the same operation', async () => {
  const { repository, scope } = await setup();
  const root = (await repository.read(scope.libraryId)).checkpoint.root as LibrarySnapshot;
  const branch = (title: string): LibraryEditBatch => ({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [root.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position: 0 } }] });
  const a = branch('A'), b = branch('B'); await repository.receive([a, b]);
  const commit = repository.commit.bind(repository), ids: string[] = []; let lose = true;
  repository.commit = async (batch, history) => { if (batch.kind === 'resolution') { ids.push(batch.id); const result = await commit(batch, history);
    if (lose) { lose = false; return { status: 'unknown', reason: 'lost reply' }; } return result; } return commit(batch, history); };
  const registry = new DocumentEditSessions(repository); await registry.initialize(); const library = registry.getLibrary(); await library.refresh(a.id);
  assert.equal(library.conflictVersions().length, 2); assert.equal(await library.resolveConflict(a.id, library.getSnapshot().heads), false);
  assert.equal(library.canLeave(), false); assert.equal((await registry.prepareLeave()).status, 'refused');
  const restored = new DocumentEditSessions(repository); await restored.initialize();
  assert.deepEqual(restored.getSnapshot().unhandledTargets, []); const recovered = restored.getLibrary();
  assert.equal(recovered.canLeave(), false); assert.equal(await recovered.retry(), true); assert.equal(recovered.canLeave(), true);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal((await repository.read(scope.libraryId)).heads.length, 1);
  assert.equal(recovered.getSnapshot().canUndo, false);
});

test('library resolution rejects a newly arrived head without dropping branches', async () => {
  const { repository, scope } = await setup(); const root = (await repository.read(scope.libraryId)).checkpoint.root as LibrarySnapshot;
  const branch = (title: string): LibraryEditBatch => ({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [root.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position: 0 } }] });
  const a = branch('A'), b = branch('B'), c = branch('C'); await repository.receive([a, b]);
  const commit = repository.commit.bind(repository); let inject = true;
  repository.commit = async (batch, history) => { if (batch.kind === 'resolution' && inject) { inject = false; await repository.receive([c]); } return commit(batch, history); };
  const registry = new DocumentEditSessions(repository); await registry.initialize(); const library = registry.getLibrary(); await library.refresh(a.id);
  assert.equal(await library.resolveConflict(a.id, library.getSnapshot().heads), false);
  assert.equal(library.canDiscardRejectedResolution(), true); assert.equal(await library.discardRejectedResolution(), true);
  assert.deepEqual((await repository.read(scope.libraryId)).heads.sort(), [a.id, b.id, c.id].sort());
});

test('library resolution retains selected template metadata and active deletion across recovery', async () => {
  const scope = { accountId: 'registry', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const templateId = crypto.randomUUID(), deletedId = crypto.randomUUID();
  const template = { id: templateId, kind: 'markdown' as const, title: 'Template', ownerId: null, folderId: null,
    position: 0, tags: [], read: false, metadata: { 'papeer.note-template': 'v1' } };
  const deleted = { id: deletedId, kind: 'markdown' as const, title: 'Deleted', ownerId: null, folderId: null,
    position: 1, tags: [], read: false, metadata: {} };
  const deletedVersion = crypto.randomUUID();
  await repository.initialize({ kind: 'markdown', id: deletedId, version: deletedVersion, content: 'retained', appendIds: [], imageResources: [] });
  await repository.initialize({ kind: 'markdown', id: templateId, version: crypto.randomUUID(), content: 'template', appendIds: [], imageResources: [] });
  const root: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [template, deleted], folders: [], links: [],
    deletions: [{ id: crypto.randomUUID(), itemIds: [deletedId], observed: [{ targetId: deletedId, heads: [deletedVersion] }], active: true }] };
  await repository.initialize(root);
  const branch = (title: string): LibraryEditBatch => ({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId,
    targetId: scope.libraryId, parents: [root.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position: 0 } }] });
  const a = branch('A'), b = branch('B');
  b.changes.push({ type: 'put-item', item: { ...template, title: 'Other template', metadata: { ...template.metadata, source: 'other' } } });
  b.changes.push({ type: 'put-deletion', deletion: { ...root.deletions[0], active: false } });
  await repository.receive([a, b]);
  const registry = new DocumentEditSessions(repository); await registry.initialize();
  const library = registry.getLibrary(); await library.refresh(a.id);
  const selected = library.conflictVersions().find(value => value.version === a.id); assert.ok(selected);
  const other = library.conflictVersions().find(value => value.version === b.id); assert.ok(other);
  assert.notDeepEqual(other.items, selected.items); assert.notDeepEqual(other.deletions, selected.deletions);
  assert.equal(await library.resolveConflict(a.id, library.getSnapshot().heads), true);
  const reopened = new DocumentEditSessions(repository); await reopened.initialize();
  assert.equal(await reopened.getLibrary().refresh(), true);
  const resolved = reopened.getLibrary().getSelectedSnapshot(); assert.ok(resolved);
  assert.notEqual(resolved.version, selected.version);
  assert.deepEqual(resolved, { ...selected, version: resolved.version });
  assert.deepEqual(resolved.items.find(item => item.id === templateId)?.metadata, { 'papeer.note-template': 'v1' });
  assert.equal(resolved.deletions.find(record => record.itemIds.includes(deletedId))?.active, true);
  assert.equal(reopened.getLibrary().getSnapshot().canUndo, false);
});

test('pending library resolution blocks a second writer and preserves a later branch', async () => {
  const { repository, scope } = await setup(); const root = (await repository.read(scope.libraryId)).checkpoint.root as LibrarySnapshot;
  const note = { kind: 'markdown' as const, id: crypto.randomUUID(), version: crypto.randomUUID(), content: 'retained', appendIds: [], imageResources: [] };
  await repository.initialize(note);
  const drafts: MarkdownDraftPort = { scope, targets: () => [], read: () => undefined, write: () => {}, remove: () => {} };
  const branch = (title: string): LibraryEditBatch => ({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [root.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position: 0 } }] });
  const a = branch('A'), b = branch('B'), c = branch('C'); await repository.receive([a, b]);
  const commit = repository.commit.bind(repository); let release: (() => void) | undefined;
  repository.commit = async (batch, history) => { if (batch.kind === 'resolution') await new Promise<void>(resolve => { release = resolve; }); return commit(batch, history); };
  const registry = new DocumentEditSessions(repository, drafts); await registry.initialize(); const library = registry.getLibrary(); await library.refresh(a.id);
  const noteSession = registry.getMarkdown(note.id); assert.equal(await noteSession.refresh(), true);
  const heads = [...library.getSnapshot().heads];
  const unregister = registry.registerScopeViewGuard(() => false);
  assert.equal(await library.resolveConflict(a.id, heads), false); unregister();
  const pending = library.resolveConflict(a.id, heads);
  for (let n = 0; n < 200 && !release; n++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(release); assert.equal(library.canLeave(), false); assert.equal(await library.resolveConflict(b.id, heads), false);
  assert.equal(noteSession.editText('must not race'), false);
  assert.equal(await library.create({ kind: 'markdown', title: 'blocked' }), false); assert.equal(await library.refresh(b.id), false);
  release(); assert.equal(await pending, true); const resolved = (await repository.read(scope.libraryId)).heads[0];
  await repository.receive([c]); await library.refresh(); assert.deepEqual((await repository.read(scope.libraryId)).heads.sort(), [resolved, c.id].sort());
});

test('catalog sibling reorder uses the existing writer and survives Undo and Redo', async () => {
  const { repository } = await setup(); const registry = new DocumentEditSessions(repository); await registry.initialize();
  const library = registry.getLibrary(); await library.refresh();
  assert.equal(await library.createFolder('A', null), true); const a = library.getSnapshot().createdFolderId!;
  assert.equal(await library.createFolder('B', null), true); const b = library.getSnapshot().createdFolderId!;
  const order = () => [...library.getSnapshot().folders].sort((x, y) => x.position - y.position).map(folder => folder.id);
  assert.deepEqual(order(), [a, b]);
  assert.equal(await library.reorderEntry({ kind: 'folder', id: b }, { kind: 'folder', id: a }, 'before'), true);
  assert.deepEqual(order(), [b, a]); assert.equal(await library.undo(), true); assert.deepEqual(order(), [a, b]);
  assert.equal(await library.redo(), true); assert.deepEqual(order(), [b, a]);
});
test('library authority is singular, blocks unready exit, and obeys scope suspension', async () => {
  const { repository } = await setup(); const registry = new DocumentEditSessions(repository);
  await registry.initialize(); const library = registry.getLibrary(); assert.equal(registry.getLibrary(), library);
  assert.equal(registry.needsExitConfirmation(), true); assert.equal((await registry.prepareLeave()).status, 'refused');
  assert.equal(await library.refresh(), true); assert.equal(registry.needsExitConfirmation(), false);
  assert.equal((await registry.suspend()).status, 'allowed');
  assert.equal(await library.create({ kind: 'markdown', title: 'inactive' }), false);
  await registry.resume(); assert.equal(await library.create({ kind: 'markdown', title: 'active' }), true);
});
test('registry startup recovers publication read-only and retains exact unknown request for retry', async () => {
  const { repository, scope } = await setup(); const first = new DocumentEditSessions(repository); await first.initialize();
  const library = first.getLibrary(); await library.refresh();
  const publish = repository.publish.bind(repository); let lose = true;
  repository.publish = async (...args) => { const result = await publish(...args); if (lose) { lose = false; throw new Error('lost'); } return result; };
  assert.equal(await library.create({ kind: 'notebook', title: 'paper' }), false);
  const raw = structuredClone(await repository.pendingIntents());
  const restored = new DocumentEditSessions(repository); await restored.initialize();
  assert.equal(restored.getSnapshot().ready, true); assert.deepEqual(restored.getSnapshot().unhandledTargets, []);
  assert.deepEqual(await repository.pendingIntents(), raw); assert.equal(restored.needsExitConfirmation(), true);
  assert.deepEqual((await restored.prepareLeave()), { status: 'refused', reason: 'editing-or-pending-save', targets: [scope.libraryId] });
  assert.equal(await restored.getLibrary().retry(), true); assert.equal(restored.needsExitConfirmation(), false);
});
test('failed publication recovery preserves raw intent while allowing existing documents to initialize', async () => {
  const { repository, scope } = await setup(); const first = new DocumentEditSessions(repository); await first.initialize();
  const library = first.getLibrary(); await library.refresh();
  const publish = repository.publish.bind(repository);
  repository.publish = async () => ({ status: 'aborted', reason: 'quota' });
  await library.create({ kind: 'markdown', title: 'held' }); const raw = structuredClone(await repository.pendingIntents());
  const read = repository.read.bind(repository); repository.read = async id => { if (id === scope.libraryId) throw new Error('read-failed'); return read(id); };
  const restored = new DocumentEditSessions(repository); await restored.initialize();
  assert.equal(restored.getSnapshot().ready, true); assert.deepEqual(restored.getSnapshot().unhandledTargets, [scope.libraryId]);
  assert.deepEqual(await repository.pendingIntents(), raw); assert.equal(restored.needsExitConfirmation(), true);
  repository.read = read; repository.publish = publish;
  assert.equal(await restored.getLibrary().refresh(), true);
  assert.deepEqual(restored.getSnapshot().unhandledTargets, [scope.libraryId]);
  assert.equal(await restored.getLibrary().retry(), true);
  assert.deepEqual(restored.getSnapshot().unhandledTargets, []); assert.equal(restored.needsExitConfirmation(), false);
});

test('catalog metadata recovery uses the retained library authority and preserves retry identity and history', async () => {
  const { repository } = await setup();
  const first = new DocumentEditSessions(repository); await first.initialize();
  const library = first.getLibrary(); await library.refresh();
  await library.create({ kind: 'markdown', title: 'Original' });
  const id = library.getSnapshot().createdId!;
  const commit = repository.commit.bind(repository), attempts: unknown[] = [];
  let lose = true;
  repository.commit = async (batch, history) => {
    attempts.push(structuredClone({ batch, history }));
    const result = await commit(batch, history);
    if (lose) { lose = false; throw new Error('metadata-reply-lost'); }
    return result;
  };
  assert.equal(await library.rename(id, 'Renamed', 'Original'), false);
  const raw = structuredClone(await repository.pendingIntents());
  assert.equal(raw.length, 1);
  const restored = new DocumentEditSessions(repository); await restored.initialize();
  assert.equal(restored.getSnapshot().ready, true);
  assert.deepEqual(restored.getSnapshot().unhandledTargets, []);
  assert.deepEqual(await repository.pendingIntents(), raw);
  assert.equal(restored.needsExitConfirmation(), true);
  const recovered = restored.getLibrary();
  assert.equal(recovered.getSnapshot().pendingKind, 'edit');
  assert.equal(await recovered.retry(), true);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(recovered.getSnapshot().createdId, null);
  assert.equal(recovered.getSnapshot().canUndo, true);
  assert.equal(restored.needsExitConfirmation(), false);
  assert.equal(await recovered.undo(), true);
  assert.equal(recovered.getSnapshot().items.find(item => item.id === id)!.title, 'Original');
  assert.equal(recovered.getSnapshot().canRedo, true);
});

async function annotationRegistry() {
  const { repository, scope } = await setup();
  const scratch = new Map<string, MarkdownDraft>(); let raw: unknown;
  const drafts: MarkdownDraftPort = { scope, targets: () => [...scratch.keys()], read: id => scratch.get(id),
    write: (id, value) => { scratch.set(id, structuredClone(value)); }, remove: id => { scratch.delete(id); } };
  const appendDrafts: NoteAppendDraftPort = { scope, read: () => raw,
    write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const registry = new DocumentEditSessions(repository, drafts, repository, appendDrafts);
  await registry.initialize(); const library = registry.getLibrary(); await library.refresh();
  const ids: string[] = [];
  for (const kind of ['notebook', 'notebook', 'markdown', 'markdown'] as const) {
    assert.equal(await library.create({ kind, title: `${kind} ${ids.length}` }), true); ids.push(library.getSnapshot().createdId!);
  }
  const sources = await Promise.all(ids.slice(0, 2).map(async id => {
    const document = structuredClone((await repository.read(id)).checkpoint.root); assert.equal(document.kind, 'document');
    if (document.kind !== 'document') throw new Error('document required');
    document.pages[0].annotations = [{ kind: 'sticky', id: crypto.randomUUID(), text: 'retained export',
      anchor: { x: 10, y: 20 }, color: null, metadata: { label: '', createdAt: null } }];
    return { libraryId: scope.libraryId, title: id, document };
  }));
  return { repository, scope, registry, library, ids, drafts, appendDrafts,
    result: freezeAnnotationExport(projectCanonicalAnnotations(sources)),
    raw: () => raw, setRaw: (value: unknown) => { raw = value; } };
}

test('annotation read singleton acquires no editing authority and requires durable append capability', async () => {
  const { repository, registry, library, ids } = await annotationRegistry();
  registry.get = () => { throw new Error('phantom document authority'); };
  registry.getMarkdown = () => { throw new Error('phantom markdown authority'); };
  const browser = registry.getAnnotationBrowser(); assert.equal(registry.getAnnotationBrowser(), browser);
  await browser.setCatalog(library.getSelectedSnapshot(), ids[0]); await browser.refresh();
  assert.equal((await registry.prepareLeave()).status, 'allowed');
  assert.equal(registry.getAnnotationAppend(), registry.getAnnotationAppend());
  const readonly = new DocumentEditSessions(repository); await readonly.initialize();
  assert.equal(readonly.canAppendAnnotations, false);
  assert.throws(() => readonly.getAnnotationAppend(), /annotation-append-unavailable/);
  await readonly.getAnnotationBrowser().setCatalog(library.getSelectedSnapshot(), ids[0]);
  assert.equal((await readonly.prepareLeave()).status, 'allowed');
});

test('restored annotation export guards every source, destination and creation target without phantom sessions', async () => {
  const { repository, scope, ids, drafts, appendDrafts, result, setRaw } = await annotationRegistry();
  const saved: SavedAnnotationAppend = { version: 1, appendStarted: false, request: { id: crypto.randomUUID(), input: { kind: 'annotations', result } },
    destinationId: ids[2], creation: { input: { kind: 'markdown', title: 'retained new note', ownerId: null, folderId: null },
      identity: { itemId: ids[2], contentVersion: crypto.randomUUID(), batchId: crypto.randomUUID() } } };
  setRaw(saved);
  const registry = new DocumentEditSessions(repository, drafts, repository, appendDrafts);
  registry.get = () => { throw new Error('phantom source'); }; registry.getMarkdown = () => { throw new Error('phantom destination'); };
  await registry.initialize(); const library = registry.getLibrary(); await library.refresh();
  assert.equal(registry.getAnnotationAppend().isRecoveryBlocked(), false, registry.getAnnotationAppend().getSnapshot().error);
  const leave = await registry.prepareLeave(); assert.equal(leave.status, 'refused');
  if (leave.status === 'refused') assert.deepEqual(new Set(leave.targets), new Set([scope.libraryId, ...ids.slice(0, 3)]));
  for (const id of ids.slice(0, 3)) {
    assert.equal(await library.deleteItems([id]), false); assert.match(library.getSnapshot().error, /target-busy/);
  }
  assert.deepEqual(appendDrafts.read(), saved);
  assert.equal(await library.deleteItems([ids[3]]), true, 'unrelated durable content remains deletable');
});

test('malformed annotation recovery retains exact raw and blocks exit and all target deletion', async () => {
  const { repository, ids, drafts, appendDrafts, setRaw, raw } = await annotationRegistry();
  const broken = { version: 1, request: { id: 'invalid', input: { kind: 'annotations', result: 'unreadable' } } }; setRaw(broken);
  const registry = new DocumentEditSessions(repository, drafts, repository, appendDrafts); await registry.initialize();
  assert.equal(registry.getSnapshot().ready, true); assert.equal(registry.getAnnotationAppend().isRecoveryBlocked(), true);
  const library = registry.getLibrary(); await library.refresh();
  assert.equal((await registry.prepareLeave()).status, 'refused'); assert.equal(registry.needsExitConfirmation(), true);
  assert.equal(await library.deleteItems([ids[3]]), false); assert.equal(registry.getAnnotationAppend().cancel(), false);
  assert.deepEqual(raw(), broken); assert.equal(await registry.getAnnotationAppend().retry(), false); assert.deepEqual(raw(), broken);
});
