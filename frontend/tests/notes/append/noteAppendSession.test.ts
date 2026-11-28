import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteAppendSession, type NoteAppendInput } from '../../../src/features/notes/append/NoteAppendSession.ts';
import type { MarkdownDraftPort } from '../../../src/features/notes/markdown/MarkdownDraftPort.ts';
import { MarkdownEditSession } from '../../../src/features/notes/markdown/MarkdownEditSession.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import type { LibrarySnapshot, MarkdownSnapshot } from '../../../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import { LibrarySession } from '../../../src/features/library/LibrarySession.ts';
import { freezeAnnotationExport, projectCanonicalAnnotations } from '../../../src/features/library/annotations/canonicalAnnotationBrowser.ts';
import type { NoteAppendDraftPort, SavedAnnotationAppend } from '../../../src/features/notes/append/NoteAppendDraftPort.ts';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=', 'base64'));
function annotationInput(libraryId: string): Extract<NoteAppendInput, { kind: 'annotations' }> {
  const uuid = () => crypto.randomUUID(), revision = uuid();
  return { kind: 'annotations', result: freezeAnnotationExport(projectCanonicalAnnotations([{ libraryId, title: 'source', document: {
    kind: 'document', id: uuid(), version: uuid(), deletedPages: [], pages: [{ id: uuid(), backgroundRevision: revision,
      annotationVersion: revision, lifecycleVersion: revision, widthPt: 600, heightPt: 800, background: { kind: 'paper', spec: { template: 'blank', color: 'white' } },
      annotations: [{ kind: 'sticky', id: uuid(), text: 'fixed annotation', quote: 'fixed quote', anchor: { x: 10, y: 20 }, color: null,
        metadata: { label: 'tag', createdAt: '2026-10-26T00:00:00.000001Z' } }],
    }],
  } }])) };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function setup() {
  const scope = { accountId: 'append', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: MarkdownSnapshot = { kind: 'markdown', id: crypto.randomUUID(), version: crypto.randomUUID(), content: 'base', appendIds: [], imageResources: [] };
  const library: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [{ id: root.id, kind: 'markdown', title: 'Note', ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} }], folders: [], links: [], deletions: [] };
  await repository.initialize(root); await repository.initialize(library);
  let raw: unknown, quota = false, active = true;
  const markdown = new MarkdownEditSession(repository, root.id, { scope, targets: () => raw === undefined ? [] : [root.id], read: () => raw,
    write: (_, value) => { if (quota) throw new Error('quota'); raw = structuredClone(value); }, remove: () => { raw = undefined; } }, undefined, () => active, repository);
  await markdown.refresh();
  const append = new NoteAppendSession({ repository, getMarkdown: () => markdown, isActive: () => active });
  const input: NoteAppendInput = { kind: 'quote', text: 'chosen text', label: 'source', target: { libraryId: scope.libraryId,
    documentId: crypto.randomUUID(), pageId: crypto.randomUUID(), backgroundRevision: crypto.randomUUID(), surface: 'original' } };
  return { repository, root, markdown, append, input, quota: (value: boolean) => { quota = value; }, active: (value: boolean) => { active = value; } };
}

test('dirty destination keeps its input and appends one immutable citation request', async () => {
  const { append, markdown, root, input } = await setup(); markdown.editText('unfinished');
  assert.equal(await append.begin(input), true); const id = append.getSnapshot().request!.id;
  input.target.pageId = crypto.randomUUID();
  assert.equal(append.canLeave(), false); assert.equal(await append.submit(root.id), true);
  assert.match(markdown.getSnapshot().content, /^unfinished\n\n> chosen text/);
  assert.equal(markdown.appendStatus(id), 'accepted'); assert.equal(append.canLeave(), true);
  const saved = markdown.getSnapshot().content; assert.equal(await append.retry(), true); assert.equal(markdown.getSnapshot().content, saved);
  assert.equal(append.dismiss(), true);
});

test('lost durable reply retries the same append and batch, never duplicates content', async () => {
  const { append, markdown, repository, root, input } = await setup();
  const original = repository.commit.bind(repository); let lose = true; const ids: string[] = [];
  repository.commit = async (...args) => { ids.push(args[0].id); const result = await original(...args); if (lose) { lose = false; throw new Error('lost'); } return result; };
  await append.begin(input); const id = append.getSnapshot().request!.id;
  await append.submit(root.id);
  if (!append.canLeave()) assert.equal(await append.retry(), true);
  assert.equal(markdown.appendStatus(id), 'accepted'); assert.equal(markdown.getSnapshot().content.split('chosen text').length, 2);
  assert.equal(new Set(ids).size, 1); assert.equal((await repository.read(root.id)).checkpoint.batches.length, 1);
});

test('scratch quota retains destination, pending append and retry; cancel never drops handed-off work', async () => {
  const { append, markdown, root, input, quota } = await setup(); quota(true);
  await append.begin(input); const request = append.getSnapshot().request;
  assert.equal(await append.submit(root.id), false); assert.equal(append.getSnapshot().request, request);
  assert.equal(append.getSnapshot().destinationId, root.id); assert.equal(append.canLeave(), false); assert.equal(append.cancel(), false);
  assert.equal(append.dismiss(), false); quota(false); assert.equal(await append.retry(), true);
  assert.equal(markdown.appendStatus(request!.id), 'accepted');
});

test('cancel before handoff invalidates a delayed catalog response without acquiring a writer', async () => {
  const { repository, input } = await setup(); const entered = gate(), release = gate(); let acquired = false;
  const append = new NoteAppendSession({ repository: { scope: repository.scope, read: async id => { entered.resolve(); await release.promise; return repository.read(id); } },
    getMarkdown: () => { acquired = true; throw new Error('unexpected'); }, isActive: () => true });
  const begin = append.begin(input); await entered.promise; assert.equal(append.cancel(), true); release.resolve();
  assert.equal(await begin, false); assert.equal(acquired, false); assert.equal(append.getSnapshot().phase, 'canceled'); assert.equal(append.canLeave(), true);
});

test('another pending image is neither replaced nor canceled by a capture append', async () => {
  const { append, markdown, root, input } = await setup(); const entered = gate(), release = gate();
  const otherId = crypto.randomUUID(); const adding = markdown.appendImage({ appendId: otherId, mediaType: 'image/png', bytes: async () => { entered.resolve(); await release.promise; return png; } });
  await entered.promise;
  await append.begin({ kind: 'image', target: input.target, bytes: async () => png, mediaType: 'image/png', alt: 'capture' });
  assert.equal(await append.submit(root.id), false); assert.equal(markdown.appendStatus(otherId), 'pending');
  assert.equal(append.cancel(), true); release.resolve(); assert.equal(await adding, true); await markdown.flush();
  assert.equal(markdown.getSnapshot().accepted!.appendIds.length, 1); assert.equal(markdown.appendStatus(otherId), 'accepted');
});

test('image and citation are one history operation; late bytes while inactive do not append', async () => {
  const { append, markdown, root, input, active } = await setup(); const entered = gate(), release = gate();
  await append.begin({ kind: 'image', target: input.target, bytes: async () => { entered.resolve(); await release.promise; return png; }, mediaType: 'image/png', alt: 'capture' });
  const submit = append.submit(root.id); await entered.promise; active(false); release.resolve(); assert.equal(await submit, false);
  assert.equal(markdown.getSnapshot().content, 'base'); assert.equal(append.canLeave(), false);
  active(true); assert.equal(await append.retry(), true); const saved = markdown.getSnapshot().content;
  assert.match(saved, /!\[capture\]/); assert.match(saved, /papeer:\/\/citation/);
  assert.equal(await markdown.undo(), true); assert.equal(markdown.getSnapshot().content, 'base');
  assert.equal(await markdown.redo(), true); assert.equal(markdown.getSnapshot().content, saved);
});

test('source cancels its exact image preparation while the target retains the IO drain guard', async () => {
  const { append, markdown, root, input } = await setup(); const entered = gate(), release = gate();
  const owner = Symbol('target editor'); markdown.acquireEditor(owner);
  await append.begin({ kind: 'image', target: input.target, bytes: async () => { entered.resolve(); await release.promise; return png; }, mediaType: 'image/png' });
  const work = append.submit(root.id); await entered.promise;
  const id = append.getSnapshot().request!.id;
  assert.equal(markdown.cancelImage(Symbol('other editor')), false);
  assert.equal(markdown.cancelImageAppend(crypto.randomUUID()), false);
  assert.equal(markdown.appendStatus(id), 'pending'); assert.equal(append.canCancel(), true);
  assert.equal(append.cancel(), true); assert.equal(append.canLeave(), true); assert.equal(markdown.canLeave(), false);
  release.resolve(); assert.equal(await work, false);
  assert.equal(markdown.getSnapshot().content, 'base'); assert.equal(markdown.canLeave(), true);
  assert.equal(markdown.appendStatus(id), 'unseen'); assert.equal(append.getSnapshot().phase, 'canceled');
});

test('exact image cancellation cannot discard a canonical queued text append', async () => {
  const { append, markdown, root, input, quota } = await setup(); quota(true);
  await append.begin(input); await append.submit(root.id); const id = append.getSnapshot().request!.id;
  assert.equal(markdown.appendStatus(id), 'pending'); assert.equal(markdown.cancelImageAppend(id), false);
  assert.equal(append.canCancel(), false); assert.equal(append.cancel(), false);
  quota(false); assert.equal(await append.retry(), true);
});

test('destination image cancellation terminates the matching retained source request', async () => {
  const { append, markdown, root, input } = await setup(); const owner = Symbol('destination editor');
  markdown.acquireEditor(owner);
  await append.begin({ kind: 'image', target: input.target, mediaType: 'image/png', bytes: async () => { throw new Error('capture-failed'); } });
  assert.equal(await append.submit(root.id), false);
  assert.equal(append.getSnapshot().phase, 'failed'); assert.equal(markdown.getSnapshot().imagePending, true);
  assert.equal(markdown.cancelImage(owner), true);
  assert.equal(markdown.canLeave(), true);
  assert.equal(append.getSnapshot().phase, 'canceled'); assert.equal(append.canLeave(), true);
});

test('destination cancellation during capture invalidates the source continuation and late bytes', async () => {
  const { append, markdown, root, input } = await setup(); const entered = gate(), release = gate();
  const owner = Symbol('destination'); markdown.acquireEditor(owner);
  await append.begin({ kind: 'image', target: input.target, mediaType: 'image/png', bytes: async () => { entered.resolve(); await release.promise; return png; } });
  const work = append.submit(root.id); await entered.promise;
  assert.equal(markdown.cancelImage(owner), true); assert.equal(append.getSnapshot().phase, 'canceled');
  assert.equal(append.canLeave(), true); assert.equal(markdown.canLeave(), false);
  release.resolve(); assert.equal(await work, false); assert.equal(markdown.getSnapshot().content, 'base');
  assert.equal(append.getSnapshot().phase, 'canceled'); assert.equal(markdown.canLeave(), true);
});

test('unrelated canceled image and canonical queued image do not terminate the source request', async () => {
  const { append, markdown, root, input, quota } = await setup();
  await markdown.appendImage({ mediaType: 'image/png', bytes: async () => { throw new Error('other'); } });
  await append.begin({ kind: 'image', target: input.target, mediaType: 'image/png', bytes: async () => png });
  assert.equal(await append.submit(root.id), false);
  markdown.cancelImage(); assert.equal(append.getSnapshot().phase, 'failed'); assert.equal(append.canLeave(), false);
  quota(true); assert.equal(await append.retry(), false);
  const id = append.getSnapshot().request!.id;
  assert.equal(markdown.appendStatus(id), 'pending'); assert.equal(markdown.getSnapshot().imagePending, false);
  assert.equal(markdown.cancelImage(), false); assert.equal(append.getSnapshot().phase, 'failed');
  quota(false); assert.equal(await append.retry(), true);
  await markdown.undo(); assert.equal(append.getSnapshot().phase, 'accepted'); assert.equal(append.canLeave(), true);
});


test('annotations persist before handoff, recover one fixed append into a dirty note, and Undo/Redo together', async () => {
  const { repository, markdown, root } = await setup(); let raw: unknown;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const make = () => new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  const first = make(), input = annotationInput(repository.scope.libraryId);
  assert.equal(await first.begin(input), true); const requestId = first.getSnapshot().request!.id;
  const saved = structuredClone(raw); markdown.editText('dirty prefix');
  const recovered = make(); assert.equal(recovered.restore(), true); assert.equal(recovered.canLeave(), false);
  assert.equal(await recovered.begin(annotationInput(repository.scope.libraryId)), false, 'a recovered request is never replaced');
  assert.deepEqual(raw, saved); assert.equal(await recovered.submit(root.id), true);
  assert.equal(markdown.appendStatus(requestId), 'accepted'); assert.equal(raw, undefined);
  const content = markdown.getSnapshot().content; assert.equal(content, 'dirty prefix\n\n' + input.result.markdown);
  await markdown.undo(); assert.equal(markdown.getSnapshot().content, 'base', 'the pending dirty edit and append share the existing durable commit');
  await markdown.redo(); assert.equal(markdown.getSnapshot().content, content);
  assert.equal(await recovered.retry(), true); assert.equal(markdown.getSnapshot().content, content);
});

test('annotations scratch and cleanup failures retain the request and refuse leaving; corrupt raw is untouched', async () => {
  const { repository, markdown, root } = await setup(); let raw: unknown, quota = true, removeFailure = false;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { if (quota) throw new Error('quota'); raw = structuredClone(value); },
    remove: () => { if (removeFailure) throw new Error('remove failed'); raw = undefined; } };
  const append = new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  assert.equal(await append.begin(annotationInput(repository.scope.libraryId)), false);
  const requestId = append.getSnapshot().request!.id; assert.equal(append.canLeave(), false); assert.equal(raw, undefined);
  quota = false; assert.equal(await append.retry(), true); removeFailure = true;
  assert.equal(await append.submit(root.id), false); assert.equal(markdown.appendStatus(requestId), 'accepted');
  assert.equal(append.getSnapshot().phase, 'accepted'); assert.equal(append.canLeave(), false); assert.ok(raw);
  removeFailure = false; assert.equal(await append.retry(), true); assert.equal(append.canLeave(), true); assert.equal(append.getSnapshot().error, '');
  raw = { broken: true }; const broken = structuredClone(raw);
  const restored = new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  assert.equal(restored.restore(), false); assert.equal(restored.isRecoveryBlocked(), true);
  assert.equal(await restored.begin(annotationInput(repository.scope.libraryId)), false); assert.deepEqual(raw, broken);
  assert.equal(restored.canLeave(), false);
});

test('a durable new destination followed by a scope stop recovers the same creation and append IDs without another publication', async () => {
  const { repository } = await setup(); let raw: unknown, active = true;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const library = new LibrarySession({ repository, isActive: () => true }); await library.refresh();
  const markdowns = new Map<string, MarkdownEditSession>(), scratches = new Map<string, unknown>();
  const getMarkdown = (id: string) => {
    let found = markdowns.get(id);
    if (!found) { found = new MarkdownEditSession(repository, id, { scope: repository.scope, targets: () => [...scratches.keys()],
      read: id => scratches.get(id), write: (id, value) => { scratches.set(id, structuredClone(value)); }, remove: id => { scratches.delete(id); } }); markdowns.set(id, found); }
    return found;
  };
  let publications = 0; const publish = repository.publish.bind(repository);
  repository.publish = async (...args) => { publications++; return publish(...args); };
  const first = new NoteAppendSession({ repository, drafts, getMarkdown, isActive: () => active,
    createNote: async (input, identity) => { const created = await library.create(input, identity); active = false; return created; } });
  await first.begin(annotationInput(repository.scope.libraryId)); const requestId = first.getSnapshot().request!.id;
  assert.equal(await first.createAndSubmit({ title: 'new destination' }), false);
  const identity = first.getSnapshot().creation!.identity; assert.ok(raw); assert.equal(first.canCancel(), false, 'inactive scope cannot cancel');
  const reloadedLibrary = new LibrarySession({ repository, isActive: () => true }); await reloadedLibrary.refresh(); active = true;
  const recovered = new NoteAppendSession({ repository, drafts, getMarkdown, isActive: () => active,
    createNote: (input, identity) => reloadedLibrary.create(input, identity) });
  assert.equal(recovered.restore(), true); assert.equal(await recovered.retry(), true);
  assert.equal(recovered.getSnapshot().destinationId, identity.itemId); assert.equal(recovered.getSnapshot().request!.id, requestId);
  assert.equal(publications, 1); assert.equal(getMarkdown(identity.itemId).appendStatus(requestId), 'accepted'); assert.equal(raw, undefined);
});


test('accepted annotations recover failed scratch removal even if their destination was subsequently deleted', async () => {
  const { repository, markdown, root } = await setup(); let raw: unknown, failRemoval = true;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); },
    remove: () => { if (failRemoval) throw new Error('remove failed'); raw = undefined; } };
  const first = new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  await first.begin(annotationInput(repository.scope.libraryId)); assert.equal(await first.submit(root.id), false);
  const requestId = first.getSnapshot().request!.id; assert.equal(markdown.appendStatus(requestId), 'accepted');
  const read = await repository.read(repository.scope.libraryId);
  await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: repository.scope.libraryId, targetId: repository.scope.libraryId,
    parents: read.heads, changes: [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), itemIds: [root.id],
      observed: [{ targetId: root.id, heads: (await repository.read(root.id)).heads }], active: true } }] });
  failRemoval = false;
  const recovered = new NoteAppendSession({ repository, drafts, getMarkdown: () => { throw new Error('cleanup cannot acquire an editor'); }, isActive: () => true });
  assert.equal(recovered.restore(), true); assert.equal(await recovered.retry(), true);
  assert.equal(recovered.getSnapshot().phase, 'accepted'); assert.equal(recovered.canLeave(), true); assert.equal(raw, undefined);
});


test('view lifetime interruption keeps annotation scratch and rejects late IO until an explicit retry', async () => {
  const { repository, markdown } = await setup(); let raw: unknown; const entered = gate(), release = gate(); let delay = true;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const append = new NoteAppendSession({ repository: { scope: repository.scope, read: async id => {
    if (delay) { entered.resolve(); await release.promise; } return repository.read(id);
  } }, drafts, getMarkdown: () => markdown, isActive: () => true });
  const begin = append.begin(annotationInput(repository.scope.libraryId)); await entered.promise;
  append.setAvailable(false); assert.equal(append.getSnapshot().busy, false); assert.equal(append.cancel(), false);
  const retained = append.getSnapshot().request; release.resolve(); assert.equal(await begin, false);
  assert.ok(raw); assert.equal(append.getSnapshot().request, retained); assert.equal(append.canLeave(), false);
  delay = false; append.setAvailable(true); assert.equal(await append.retry(), true); assert.equal(append.canCancel(), true);
  assert.equal(append.cancel(), true); assert.equal(raw, undefined);
});


test('annotation scratch recovery applies canonical annotation semantics and preserves corrupted raw', async () => {
  const { repository, markdown } = await setup(); let raw: unknown;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const make = () => new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  await make().begin(annotationInput(repository.scope.libraryId));
  const corrupted = structuredClone(raw) as SavedAnnotationAppend;
  corrupted.request.input.result.rows[0].annotation.metadata.createdAt = '2026-02-30T00:00:00Z'; raw = corrupted;
  const recovered = make(); assert.equal(recovered.restore(), false);
  assert.match(recovered.getSnapshot().error, /annotation-time/); assert.equal(recovered.isRecoveryBlocked(), true);
  assert.deepEqual(raw, corrupted); assert.equal(recovered.canLeave(), false);
});


test('canceling a failed new-destination append keeps its separate library journal and never appends after recovery', async () => {
  const { repository } = await setup(); let raw: unknown, failRemoval = true, offline = true;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); },
    remove: () => { if (failRemoval) throw new Error('remove failed'); raw = undefined; } };
  const library = new LibrarySession({ repository, isActive: () => true }); await library.refresh();
  const publish = repository.publish.bind(repository), entered = gate(), release = gate();
  repository.publish = async (...args) => { entered.resolve(); await release.promise; if (offline) throw new Error('offline'); return publish(...args); };
  const append = new NoteAppendSession({ repository, drafts, isActive: () => true,
    getMarkdown: () => { throw new Error('canceled request cannot acquire a destination editor'); }, createNote: (input, identity) => library.create(input, identity) });
  await append.begin(annotationInput(repository.scope.libraryId));
  const work = append.createAndSubmit({ title: 'retained empty note' }); await entered.promise;
  assert.equal(append.canCancel(), false); assert.equal(append.cancel(), false);
  release.resolve(); assert.equal(await work, false); const creation = append.getSnapshot().creation!;
  assert.equal(append.canCancel(), true); assert.equal(append.cancel(), false); assert.ok(raw);
  assert.equal(append.canLeave(), false); failRemoval = false;
  assert.equal(append.cancel(), true); assert.equal(raw, undefined); assert.equal(append.canLeave(), true);
  assert.equal(library.canLeave(), false); const pending = (await repository.readIntent(repository.scope.libraryId))!.intent.request;
  assert.ok('publication' in pending); if ('publication' in pending) assert.equal(pending.publication.libraryBatch.id, creation.identity.batchId);
  offline = false; assert.equal(await library.retry(), true);
  const content = (await repository.read(creation.identity.itemId)).checkpoint.root;
  assert.equal(content.kind, 'markdown'); if (content.kind === 'markdown') { assert.equal(content.content, ''); assert.deepEqual(content.appendIds, []); }
  assert.equal(append.getSnapshot().phase, 'canceled');
  assert.equal(await append.retry(), false); assert.equal(await append.createAndSubmit({ title: 'retained empty note' }), false);
});


test('destination-bearing recovery cannot cancel an append hidden in the destination scratch or journal', async () => {
  const { repository, root } = await setup(); let sourceRaw: unknown, markdownRaw: unknown, offline = true;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => sourceRaw,
    write: value => { sourceRaw = structuredClone(value); }, remove: () => { sourceRaw = undefined; } };
  const markdownDrafts: MarkdownDraftPort = { scope: repository.scope, targets: () => markdownRaw === undefined ? [] : [root.id], read: () => markdownRaw,
    write: (_, value) => { markdownRaw = structuredClone(value); }, remove: () => { markdownRaw = undefined; } };
  const commit = repository.commit.bind(repository);
  repository.commit = async (...args) => { if (offline) throw new Error('offline'); return commit(...args); };
  const firstTarget = new MarkdownEditSession(repository, root.id, markdownDrafts); await firstTarget.refresh();
  const first = new NoteAppendSession({ repository, drafts, getMarkdown: () => firstTarget, isActive: () => true });
  await first.begin(annotationInput(repository.scope.libraryId)); const requestId = first.getSnapshot().request!.id;
  assert.equal(await first.submit(root.id), false); assert.equal(firstTarget.appendStatus(requestId), 'pending');
  const retained = structuredClone(sourceRaw); assert.ok(markdownRaw); assert.ok(await repository.readIntent(root.id));
  const target = new MarkdownEditSession(repository, root.id, markdownDrafts);
  const recovered = new NoteAppendSession({ repository, drafts, getMarkdown: () => target, isActive: () => true });
  assert.equal(recovered.restore(), true); assert.equal(recovered.canCancel(), false); assert.equal(recovered.cancel(), false);
  assert.deepEqual(sourceRaw, retained);
  assert.equal(await recovered.retry(), false); assert.equal(target.appendStatus(requestId), 'pending');
  assert.equal(recovered.canCancel(), false); assert.equal(recovered.cancel(), false); assert.deepEqual(sourceRaw, retained);
  offline = false; await target.retry();
  assert.equal(target.appendStatus(requestId), 'accepted'); assert.equal(recovered.getSnapshot().phase, 'accepted');
  assert.equal(sourceRaw, undefined); assert.equal(recovered.canLeave(), true);
  assert.equal(target.getSnapshot().content.split('fixed annotation').length, 2);
});


test('pre-handoff creation recovery can cancel using its durable marker without discarding the library publication', async () => {
  const { repository } = await setup(); let raw: unknown;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const library = new LibrarySession({ repository, isActive: () => true }); await library.refresh();
  repository.publish = async () => { throw new Error('offline'); };
  const createNote = (input: Parameters<LibrarySession['create']>[0], identity: Parameters<LibrarySession['create']>[1]) => library.create(input, identity);
  const make = () => new NoteAppendSession({ repository, drafts, createNote, isActive: () => true,
    getMarkdown: () => { throw new Error('pre-handoff cancellation cannot acquire an editor'); } });
  const first = make(); await first.begin(annotationInput(repository.scope.libraryId));
  assert.equal(await first.createAndSubmit({ title: 'never handed off' }), false);
  assert.equal((raw as SavedAnnotationAppend).appendStarted, false);
  const journal = structuredClone(await repository.readIntent(repository.scope.libraryId)); assert.ok(journal);
  const restored = make(); assert.equal(restored.restore(), true); assert.equal(restored.canCancel(), true);
  assert.equal(restored.cancel(), true); assert.equal(raw, undefined); assert.equal(restored.canLeave(), true);
  assert.deepEqual(await repository.readIntent(repository.scope.libraryId), journal); assert.equal(library.canLeave(), false);
});

test('the handoff marker is durable before appendText and raw without that marker is preserved as broken', async () => {
  const { repository, markdown, root } = await setup(); let raw: unknown, blockMarker = true;
  const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => raw, write: value => {
    if (blockMarker && value.appendStarted) throw new Error('handoff quota'); raw = structuredClone(value);
  }, remove: () => { raw = undefined; } };
  const append = new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  await append.begin(annotationInput(repository.scope.libraryId)); const requestId = append.getSnapshot().request!.id;
  assert.equal(await append.submit(root.id), false); assert.equal(markdown.appendStatus(requestId), 'unseen');
  assert.equal((raw as SavedAnnotationAppend).appendStarted, false); assert.equal(markdown.getSnapshot().content, 'base');
  const old = structuredClone(raw) as Record<string, unknown>; delete old.appendStarted; raw = old;
  const recovered = new NoteAppendSession({ repository, drafts, getMarkdown: () => markdown, isActive: () => true });
  assert.equal(recovered.restore(), false); assert.equal(recovered.canCancel(), false); assert.deepEqual(raw, old);
  blockMarker = false;
});


test('deleted destinations permit recovered unseen cancellation and preserve pending append recovery before catalog admission', async () => {
  for (const handoff of ['unseen', 'pending'] as const) {
    const { repository, root } = await setup(); let sourceRaw: unknown, markdownRaw: unknown, offline = true;
    const drafts: NoteAppendDraftPort = { scope: repository.scope, read: () => sourceRaw,
      write: value => { sourceRaw = structuredClone(value); }, remove: () => { sourceRaw = undefined; } };
    const markdownDrafts: MarkdownDraftPort = { scope: repository.scope, targets: () => markdownRaw === undefined ? [] : [root.id], read: () => markdownRaw,
      write: (_, value) => { markdownRaw = structuredClone(value); }, remove: () => { markdownRaw = undefined; } };
    const commit = repository.commit.bind(repository);
    repository.commit = async (...args) => { if (offline) throw new Error('offline'); return commit(...args); };
    const initialTarget = new MarkdownEditSession(repository, root.id, markdownDrafts); await initialTarget.refresh();
    const first = new NoteAppendSession({ repository, drafts, getMarkdown: () => initialTarget, isActive: () => true });
    await first.begin(annotationInput(repository.scope.libraryId)); const requestId = first.getSnapshot().request!.id;
    if (handoff === 'pending') assert.equal(await first.submit(root.id), false);
    else {
      // Exact durable checkpoint immediately before appendText is allowed to run.
      const marker = structuredClone(sourceRaw) as SavedAnnotationAppend;
      marker.destinationId = root.id; marker.appendStarted = true; sourceRaw = marker;
    }
    const catalog = await repository.read(repository.scope.libraryId);
    await commit({ kind: 'library', id: crypto.randomUUID(), libraryId: repository.scope.libraryId, targetId: repository.scope.libraryId,
      parents: catalog.heads, changes: [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), itemIds: [root.id],
        observed: [{ targetId: root.id, heads: (await repository.read(root.id)).heads }], active: true } }] });
    const target = new MarkdownEditSession(repository, root.id, markdownDrafts);
    const recovered = new NoteAppendSession({ repository, drafts, getMarkdown: () => target, isActive: () => true });
    assert.equal(recovered.restore(), true); assert.equal(recovered.canCancel(), false);
    assert.equal(await recovered.retry(), false);
    if (handoff === 'unseen') {
      assert.equal(target.appendStatus(requestId), 'unseen'); assert.equal(target.getSnapshot().content, 'base');
      assert.equal(recovered.canCancel(), true); assert.equal(recovered.cancel(), true); assert.equal(sourceRaw, undefined);
      assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0, 'a deleted target cannot receive a new append');
    } else {
      assert.equal(target.appendStatus(requestId), 'pending'); assert.equal(recovered.canCancel(), false); assert.ok(sourceRaw);
      offline = false; assert.equal(await recovered.retry(), true);
      assert.equal(target.appendStatus(requestId), 'accepted'); assert.equal(recovered.getSnapshot().phase, 'accepted'); assert.equal(sourceRaw, undefined);
    }
  }
});
