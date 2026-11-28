import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ContentNavigationSession } from '../../../src/features/reader/navigation/ContentNavigationSession.ts';
import type { DocumentSnapshot, LibrarySnapshot, MarkdownSnapshot } from '../../../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../../../src/runtime/edits/ports.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import { DocumentEditSessions } from '../../../src/features/reader/DocumentEditSessions.ts';
import type { CitationTarget } from '../../../src/runtime/markdown/markdownCitations.ts';
import { resourceHash } from '../../../src/runtime/edits/contentPublication.ts';
import { projectCanonicalAnnotations } from '../../../src/features/library/annotations/canonicalAnnotationBrowser.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const clean = () => ({ prepareClose: async () => true, canClose: () => true });

test('annotation navigation freezes its payload before awaiting and carries the exact expectation', async () => {
  const { create, doc, scope } = await setup(undefined, true), nav = create(), gate = deferred();
  nav.registerCurrent(doc.id, { prepareClose: () => gate.promise.then(() => true), canClose: () => true });
  const row = structuredClone(projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'test', document: doc }])[0]);
  const request = { version: doc.version, row, target: structuredClone(row.target) };
  const opening = nav.openAnnotation(request);
  request.row.annotation.text = 'mutated'; request.target.anchor!.xPt = 200;
  gate.resolve(); assert.equal((await opening).status, 'applied');
  const retained = nav.getSnapshot().citation!.annotation!;
  assert.equal(retained.row.annotation.text, 'annotation'); assert.equal(retained.target.anchor!.xPt, 12);
  assert.equal(Object.isFrozen(retained.row.annotation.metadata), true);
  assert.equal(Object.isFrozen(retained.row.sourceVersions), true);
});

test('annotation navigation admits only the explicitly selected current head and exact payload', async () => {
  const { create, doc, scope, repository } = await setup(undefined, true), page = doc.pages[0];
  const branch = async (text: string) => {
    const id = crypto.randomUUID(), note = page.annotations[0];
    if (note.kind !== 'sticky') throw new Error('fixture');
    assert.equal((await repository.commit({ kind: 'page', id, libraryId: scope.libraryId, targetId: doc.id,
      parents: [doc.version], expected: { pageId: page.id, backgroundRevision: page.backgroundRevision,
        lifecycleVersion: page.lifecycleVersion, annotationVersion: page.annotationVersion },
      changes: [{ type: 'update', annotation: { ...note, text } }] })).status, 'durable');
    return id;
  };
  const first = await branch('first'), second = await branch('second');
  const read = await repository.read(doc.id);
  const { EditGraph } = await import('../../../src/runtime/edits/editGraph.ts');
  const document = new EditGraph(read.checkpoint).snapshot(first) as DocumentSnapshot;
  const row = projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'test', document }])[0];
  const request = { version: first, row, target: row.target };
  const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openAnnotation(request)).status, 'applied');
  assert.equal(nav.getSnapshot().citation!.annotation!.version, first);
  const before = nav.getSnapshot().citation;
  assert.equal((await nav.openAnnotation({ ...request, version: second })).status, 'blocked');
  assert.equal((await nav.openAnnotation({ ...request, version: doc.version })).status, 'blocked');
  assert.equal(nav.getSnapshot().citation, before); assert.deepEqual(nav.getSnapshot().back, []);
});

test('annotation catalog selection overrides an old pin without confusing the content head or source history', async () => {
  const { repository, scope, library, doc, note, create } = await setup(undefined, true);
  const nav = create(); nav.registerCurrent(doc.id, clean());
  const row = projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'test', document: doc }])[0];
  const request = { version: doc.version, row, target: row.target };
  await nav.openDocument(note.id, library.version); nav.registerCurrent(note.id, clean());
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  for (const id of [a, b]) assert.equal((await repository.commit({ kind: 'library', id, libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [library.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: id, parentId: null, position: 0 } }] })).status, 'durable');
  const back = nav.getSnapshot().back;
  assert.equal((await nav.openAnnotation(request)).reason, 'catalog-head-unavailable', 'undefined inherits the old pin');
  assert.equal((await nav.openAnnotation(request, null)).reason, 'catalog-head-selection-required');
  assert.equal((await nav.openAnnotation(request, doc.version)).reason, 'catalog-head-unavailable', 'content version is not a catalog version');
  assert.equal(nav.getSnapshot().back, back);
  assert.equal((await nav.openAnnotation(request, b)).status, 'applied');
  assert.equal(nav.getSnapshot().catalogVersion, b); assert.equal(nav.getSnapshot().citation!.annotation!.version, doc.version);
  assert.deepEqual(nav.getSnapshot().back[nav.getSnapshot().back.length - 1], { documentId: note.id, catalogVersion: library.version });
  nav.registerCurrent(doc.id, clean());
  const prior = nav.getSnapshot().back;
  assert.equal((await nav.openAnnotation(request, a)).status, 'applied');
  assert.deepEqual(nav.getSnapshot().back, prior); assert.equal(nav.getSnapshot().catalogVersion, a);
});

test('explicit null annotation catalog clears an expired pin only after the close guard succeeds', async () => {
  const { repository, scope, library, doc, create } = await setup(undefined, true);
  const nav = create(); let allowed = true;
  nav.registerCurrent(doc.id, { prepareClose: async () => allowed, canClose: () => allowed });
  await nav.openDocument(doc.id, library.version);
  const row = projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'test', document: doc }])[0];
  const request = { version: doc.version, row, target: row.target };
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [library.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'next', parentId: null, position: 0 } }] })).status, 'durable');
  assert.equal((await nav.openAnnotation(request)).reason, 'catalog-head-unavailable');
  allowed = false; assert.equal((await nav.openAnnotation(request, null)).reason, 'current-blocked');
  assert.equal(nav.getSnapshot().catalogVersion, library.version); assert.deepEqual(nav.getSnapshot().back, []);
  allowed = true; assert.equal((await nav.openAnnotation(request, null)).status, 'applied');
  assert.equal(nav.getSnapshot().catalogVersion, null); assert.equal(nav.getSnapshot().citation!.annotation!.version, doc.version);
  assert.deepEqual(nav.getSnapshot().back, []);
});

test('attachments navigate by their own catalog ID without a content read, including deleted inspection and back', async () => {
  const { repository, scope, doc, note, library, create, target } = await setup();
  const id = crypto.randomUUID(), resourceId = crypto.randomUUID(), bytes = new TextEncoder().encode('# attached source');
  await repository.storeResource({ id: resourceId, sha256: await resourceHash(bytes), mediaType: 'text/markdown', bytes });
  const attached = { ...library.items[1], id, kind: 'attachment' as const, ownerId: doc.id, resourceId, title: 'source.md' };
  const batchId = crypto.randomUUID();
  assert.equal((await repository.commit({ kind: 'library', id: batchId, libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [library.version], changes: [{ type: 'put-item', item: attached }] })).status, 'durable');
  const seen: string[] = [], read = repository.read.bind(repository);
  const nav = create(async targetId => { seen.push(targetId); assert.notEqual(targetId, id, 'an attachment has no content DAG'); return read(targetId); });
  nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(id)).status, 'applied'); assert.equal(nav.getSnapshot().documentId, id);
  assert.equal(seen.includes(note.id), false);
  nav.registerCurrent(id, clean()); assert.equal((await nav.back()).status, 'applied');
  nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openCitation({ ...target, documentId: id })).status, 'blocked');
  const deletion = { id: crypto.randomUUID(), itemIds: [id], observed: [], active: true };
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [batchId], changes: [{ type: 'put-deletion', deletion }] })).status, 'durable');
  assert.equal((await nav.openDocument(id)).status, 'blocked');
  assert.equal((await nav.openDeletedDocument(id)).status, 'applied');
  assert.equal(nav.getSnapshot().documentId, id); nav.registerCurrent(id, clean());
  assert.equal((await nav.back()).status, 'applied'); assert.equal(nav.getSnapshot().documentId, doc.id);
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(translation?: 'available' | 'orphan' | 'ambiguous', annotation = false) {
  const scope = { accountId: 'navigation', libraryId: fixture.libraryId as string, epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  const doc: DocumentSnapshot = structuredClone(fixture.translation.root);
  if (!translation) delete doc.translation;
  else {
    if (translation === 'orphan') doc.translation!.bindings = [];
    if (translation === 'ambiguous') doc.translation!.bindings[0].candidates.push({
      pageId: doc.translation!.pages[1].id, backgroundRevision: doc.translation!.pages[1].backgroundRevision,
    });
  }
  doc.deletedPages = [];
  if (annotation) doc.pages[0].annotations = [{ kind: 'sticky', id: crypto.randomUUID(), text: 'annotation', color: null,
    anchor: { x: 12, y: 24 }, metadata: { label: 'label', createdAt: null } }];
  if (!translation) for (const page of doc.pages) page.background = { kind: 'paper', spec: { template: 'blank', color: 'white' } };
  if (translation) {
    const bytes = new TextEncoder().encode('%PDF-1.7 navigation test'), sha256 = await resourceHash(bytes);
    for (const page of [...doc.pages, ...doc.translation!.pages]) if (page.background.kind === 'pdf') {
      page.background.sourceRevision = sha256;
      await repository.storeResource({ id: page.background.resourceId, sha256, mediaType: 'application/pdf', bytes });
    }
  }
  const note: MarkdownSnapshot = { kind: 'markdown', id: crypto.randomUUID(), version: crypto.randomUUID(), content: 'base', appendIds: [], imageResources: [] };
  const library: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), folders: [], links: [], deletions: [],
    items: [doc, note].map((value, position) => ({ id: value.id, kind: value.kind === 'markdown' ? 'markdown' : 'pdf', title: 'test',
      ownerId: null, folderId: null, position, tags: [], read: false, metadata: {} })) };
  await repository.initialize(doc); await repository.initialize(note); await repository.initialize(library);
  const target: CitationTarget = { libraryId: scope.libraryId, documentId: doc.id, pageId: doc.pages[0].id,
    backgroundRevision: doc.pages[0].backgroundRevision, surface: 'original', anchor: { xPt: 0, yPt: 0 } };
  const create = (read = repository.read.bind(repository)) => {
    const nav = new ContentNavigationSession({ repository: { scope, read }, documentId: doc.id, isActive: () => true });
    nav.setAvailable(true); return nav;
  };
  return { repository, scope, doc, note, library, target, create };
}

test('same-scope opening reaches a recovered hidden dirty draft without requiring scope leave', async () => {
  const { repository, scope, doc, note, create } = await setup();
  const scratch = new Map<string, unknown>();
  const drafts = { scope, targets: () => [...scratch.keys()], read: (id: string) => scratch.get(id),
    write: (id: string, value: unknown) => { scratch.set(id, structuredClone(value)); }, remove: (id: string) => { scratch.delete(id); } };
  const first = new DocumentEditSessions(repository, drafts); await first.initialize();
  const edit = first.getMarkdown(note.id); await edit.refresh(); edit.editText('recovered unfinished');
  const registry = new DocumentEditSessions(repository, drafts); await registry.initialize();
  assert.equal((await registry.prepareLeave()).status, 'refused');
  const recovered = registry.getMarkdown(note.id);
  const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(note.id)).status, 'applied');
  assert.equal(recovered.getSnapshot().content, 'recovered unfinished'); assert.equal(recovered.canLeave(), false);
  assert.equal(registry.getMarkdown(note.id), recovered);
});

test('back closes the displayed authority and only consumes history after success', async () => {
  const { doc, note, create } = await setup(); const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(note.id)).status, 'applied');
  let permitted = false; const release = nav.registerCurrent(note.id, { prepareClose: async () => permitted, canClose: () => permitted });
  assert.equal((await nav.back()).status, 'blocked'); assert.deepEqual(nav.getSnapshot().back, [{ documentId: doc.id, catalogVersion: null }]);
  permitted = true; assert.equal((await nav.back()).status, 'applied'); release();
  assert.equal(nav.getSnapshot().documentId, doc.id); assert.deepEqual(nav.getSnapshot().back, []);
});

test('guard duplicates cannot replace the owner; release during a read invalidates navigation', async () => {
  const { repository, doc, note, create } = await setup(); const gate = deferred(), entered = deferred();
  const nav = create(async id => { if (id === note.id) { entered.resolve(); await gate.promise; } return repository.read(id); });
  const ownerRelease = nav.registerCurrent(doc.id, clean());
  nav.registerCurrent(doc.id, { prepareClose: async () => false, canClose: () => false })();
  const work = nav.openDocument(note.id); await entered.promise; ownerRelease(); gate.resolve();
  assert.equal((await work).status, 'blocked'); assert.equal(nav.getSnapshot().documentId, doc.id);
});

test('lifetime and last-moment input changes cannot commit an awaited navigation', async () => {
  for (const change of ['lifetime', 'input'] as const) {
    const { repository, doc, note, create } = await setup(); const gate = deferred(), entered = deferred(); let closable = true;
    const nav = create(async id => { if (id === note.id) { entered.resolve(); await gate.promise; } return repository.read(id); });
    nav.registerCurrent(doc.id, { prepareClose: async () => true, canClose: () => closable });
    const work = nav.openDocument(note.id); await entered.promise;
    assert.equal((await nav.openDocument(note.id)).reason, 'busy');
    if (change === 'lifetime') { nav.setAvailable(false); nav.setAvailable(true); } else closable = false;
    gate.resolve(); assert.equal((await work).status, 'blocked'); assert.equal(nav.getSnapshot().documentId, doc.id);
  }
});

test('citations are cloned, validated and completed by exact request identity', async () => {
  const { doc, target, create } = await setup(); const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openCitation({ ...target, libraryId: crypto.randomUUID() })).reason, 'library-mismatch');
  assert.equal((await nav.openCitation({ ...target, surface: 'translated' })).reason, 'wrong-surface');
  assert.equal((await nav.openCitation({ ...target, pageId: 'invalid' })).reason, 'citation-invalid');
  assert.equal((await nav.openCitation({ ...target, backgroundRevision: crypto.randomUUID() })).reason, 'background-changed');
  const work = nav.openCitation(target); target.anchor!.xPt = 123; assert.equal((await work).status, 'applied');
  const request = nav.getSnapshot().citation!; assert.equal(request.target.anchor!.xPt, 0); assert.deepEqual(nav.getSnapshot().back, []);
  nav.completeCitation('old'); assert.equal(nav.getSnapshot().citation, request);
  nav.completeCitation(request.id, 'landing-failed'); assert.equal(nav.getSnapshot().citation, null); assert.equal(nav.getSnapshot().error, 'landing-failed');
});

test('catalog deletion, ambiguous catalog and read failure retain the source', async () => {
  for (const failure of ['deleted', 'heads', 'read'] as const) {
    const { repository, scope, doc, note, create } = await setup();
    const nav = create(async id => {
      if (failure === 'read') throw new Error('offline');
      const state = structuredClone(await repository.read(id));
      if (id === scope.libraryId) {
        if (failure === 'heads') state.heads.push(crypto.randomUUID());
        else if (state.checkpoint.root.kind === 'library') state.checkpoint.root.deletions.push({ id: crypto.randomUUID(), itemIds: [note.id], observed: [], active: true });
      }
      return state;
    });
    nav.registerCurrent(doc.id, clean()); assert.equal((await nav.openDocument(note.id)).status, 'blocked');
    assert.equal(nav.getSnapshot().documentId, doc.id); assert.equal(nav.getSnapshot().busy, false);
  }
});

test('target branches may open for explicit selection while catalog branches cannot', async () => {
  const { repository, scope, doc, note, create } = await setup();
  for (const content of ['left', 'right']) await repository.commit({ kind: 'markdown', id: crypto.randomUUID(),
    libraryId: scope.libraryId, targetId: note.id, parents: [note.version], content, imageResources: [] });
  const targetState: RepositoryState = await repository.read(note.id); assert.equal(targetState.heads.length, 2);
  const nav = create(); nav.registerCurrent(doc.id, clean()); assert.equal((await nav.openDocument(note.id)).status, 'applied');
});

test('back escapes a target whose read-only loader failed before any controller registered', async () => {
  const { doc, note, create } = await setup(); const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(note.id)).status, 'applied');
  // Simulate the selected target loader failing: no editing controller was mounted.
  assert.equal((await nav.openDocument(doc.id)).reason, 'current-unavailable');
  assert.equal((await nav.back()).status, 'applied'); assert.equal(nav.getSnapshot().documentId, doc.id);
  assert.deepEqual(nav.getSnapshot().back, []);
});

test('a released editing owner never qualifies for the read-only back escape', async () => {
  const { doc, note, create } = await setup(); const nav = create(); nav.registerCurrent(doc.id, clean());
  await nav.openDocument(note.id); const release = nav.registerCurrent(note.id, clean()); release();
  assert.equal((await nav.back()).reason, 'current-unavailable'); assert.equal(nav.getSnapshot().documentId, note.id);
  assert.deepEqual(nav.getSnapshot().back, [{ documentId: doc.id, catalogVersion: null }]);
});

test('controller registration during read-only back invalidates the fallback even if it then releases', async () => {
  for (const releaseAgain of [false, true]) {
    const { repository, doc, note, create } = await setup(); const entered = deferred(), gate = deferred(); let delay = false;
    const nav = create(async id => { if (delay && id === doc.id) { entered.resolve(); await gate.promise; } return repository.read(id); });
    nav.registerCurrent(doc.id, clean()); await nav.openDocument(note.id); delay = true;
    const back = nav.back(); await entered.promise;
    const release = nav.registerCurrent(note.id, { prepareClose: async () => false, canClose: () => false });
    if (releaseAgain) release(); gate.resolve();
    assert.equal((await back).status, 'blocked'); assert.equal(nav.getSnapshot().documentId, note.id);
    assert.deepEqual(nav.getSnapshot().back, [{ documentId: doc.id, catalogVersion: null }]);
  }
});

test('explicit current catalog head permits opening only an item admitted by that branch', async () => {
  const { repository, scope, library, doc, note, target, create } = await setup();
  const visible = crypto.randomUUID(), deleted = crypto.randomUUID();
  assert.equal((await repository.commit({ kind: 'library', id: visible, libraryId: scope.libraryId, targetId: scope.libraryId, parents: [library.version],
    changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'visible', parentId: null, position: 0 } }] })).status, 'durable');
  assert.equal((await repository.commit({ kind: 'library', id: deleted, libraryId: scope.libraryId, targetId: scope.libraryId, parents: [library.version],
    changes: [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), itemIds: [note.id], observed: [{ targetId: note.id, heads: [note.version] }], active: true } }] })).status, 'durable');
  const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(note.id)).reason, 'catalog-head-selection-required');
  assert.equal((await nav.openCitation(target)).reason, 'catalog-head-selection-required');
  assert.equal((await nav.openDocument(note.id, library.version)).reason, 'catalog-head-unavailable');
  assert.equal((await nav.openDocument(note.id, deleted)).reason, 'deleted');
  assert.equal((await nav.openDocument(note.id, visible)).status, 'applied');
  assert.equal(nav.getSnapshot().catalogVersion, visible);
  nav.registerCurrent(note.id, clean());
  assert.equal((await nav.back()).reason, 'catalog-head-selection-required');
  assert.equal(nav.getSnapshot().documentId, note.id);
  assert.equal((await nav.openDeletedDocument(doc.id, deleted)).reason, 'not-deleted');
  assert.equal((await nav.openDeletedDocument(note.id, deleted)).status, 'applied');
  nav.registerCurrent(note.id, clean());
  assert.equal((await nav.openDocument(doc.id, visible)).status, 'applied');
  assert.deepEqual(nav.getSnapshot().back, [{ documentId: doc.id, catalogVersion: null }]);
  // Navigating directly from a deleted item back to the exact location at the top of state.back pops the duplicate entry
  nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDeletedDocument(note.id, deleted)).status, 'applied');
  assert.deepEqual(nav.getSnapshot().back, [
    { documentId: doc.id, catalogVersion: null },
    { documentId: doc.id, catalogVersion: visible },
  ]);
  nav.registerCurrent(note.id, clean());
  assert.equal((await nav.openDocument(doc.id, visible)).status, 'applied');
  assert.deepEqual(nav.getSnapshot().back, [{ documentId: doc.id, catalogVersion: null }]);
});

test('same-document explicit catalog changes use the guard and persist metadata selection without adding history', async () => {
  const { doc, library, note, create } = await setup(); const nav = create(); let allowed = false, closed = 0;
  nav.registerCurrent(doc.id, { prepareClose: async () => { closed++; return allowed; }, canClose: () => allowed });
  assert.equal(nav.getSnapshot().catalogVersion, null);
  assert.equal((await nav.openDocument(doc.id, library.version)).status, 'blocked');
  allowed = true; assert.equal((await nav.openDocument(doc.id, library.version)).status, 'applied');
  assert.equal(nav.getSnapshot().catalogVersion, library.version); assert.deepEqual(nav.getSnapshot().back, []);
  const attempts = closed;
  assert.equal((await nav.openDocument(doc.id, library.version)).status, 'unchanged');
  assert.equal(closed, attempts);
  assert.equal((await nav.openDocument(doc.id)).status, 'applied'); assert.equal(closed, attempts + 1);
  assert.equal(nav.getSnapshot().catalogVersion, null);
  assert.equal((await nav.openDocument(note.id)).status, 'applied'); assert.equal(nav.getSnapshot().catalogVersion, null);
  nav.registerCurrent(note.id, clean()); assert.equal((await nav.back()).status, 'applied');
  assert.equal(nav.getSnapshot().catalogVersion, null);
});

test('same-document ordinary open clears an obsolete pin through the guard and citations then use current catalog', async () => {
  const { repository, scope, library, doc, note, target, create } = await setup(); const nav = create(); let allowed = true;
  nav.registerCurrent(doc.id, { prepareClose: async () => allowed, canClose: () => allowed });
  assert.equal((await nav.openDocument(doc.id, library.version)).status, 'applied');
  const next = crypto.randomUUID();
  assert.equal((await repository.commit({ kind: 'library', id: next, libraryId: scope.libraryId, targetId: scope.libraryId, parents: [library.version],
    changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'next', parentId: null, position: 0 } }] })).status, 'durable');
  assert.equal((await nav.openCitation(target)).reason, 'catalog-head-unavailable');
  allowed = false; assert.equal((await nav.openDocument(doc.id)).status, 'blocked'); assert.equal(nav.getSnapshot().catalogVersion, library.version);
  allowed = true; assert.equal((await nav.openDocument(doc.id)).status, 'applied'); assert.equal(nav.getSnapshot().catalogVersion, null);
  assert.equal((await nav.openCitation(target)).status, 'applied'); assert.equal(nav.getSnapshot().catalogVersion, null);
  assert.equal((await nav.openDocument(note.id)).status, 'applied'); nav.registerCurrent(note.id, clean());
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId, parents: [next],
    changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'newer', parentId: null, position: 0 } }] })).status, 'durable');
  assert.equal((await nav.back()).status, 'applied'); assert.equal(nav.getSnapshot().documentId, doc.id); assert.equal(nav.getSnapshot().catalogVersion, null);
});

test('back and citations retain explicit catalog context, while invalidated history is not consumed', async () => {
  const { repository, scope, library, doc, note, target, create } = await setup();
  const versions = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of versions) assert.equal((await repository.commit({ kind: 'library', id, libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [library.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: id, parentId: null, position: 0 } }] })).status, 'durable');
  const nav = create(); nav.registerCurrent(doc.id, clean());
  await nav.openDocument(doc.id, versions[0]); await nav.openDocument(note.id, versions[1]); nav.registerCurrent(note.id, clean());
  assert.deepEqual(nav.getSnapshot().back, [{ documentId: doc.id, catalogVersion: versions[0] }]);
  assert.equal((await nav.openCitation(target)).status, 'applied'); assert.equal(nav.getSnapshot().catalogVersion, versions[1]);
  nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openCitation({ ...target, anchor: { xPt: 1, yPt: 2 } })).status, 'applied');
  assert.equal(nav.getSnapshot().back.length, 2); assert.equal(nav.getSnapshot().catalogVersion, versions[1]);
  assert.equal((await nav.back()).status, 'applied'); nav.registerCurrent(note.id, clean());
  assert.equal(nav.getSnapshot().catalogVersion, versions[1]);
  assert.equal((await nav.back()).status, 'applied'); nav.registerCurrent(doc.id, clean());
  assert.equal(nav.getSnapshot().catalogVersion, versions[0]);
  await nav.openDocument(note.id, versions[1]); nav.registerCurrent(note.id, clean());
  const before = nav.getSnapshot().back;
  assert.equal((await repository.commit({ kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: scope.libraryId,
    parents: [versions[0]], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title: 'advanced', parentId: null, position: 0 } }] })).status, 'durable');
  assert.equal((await nav.back()).reason, 'catalog-head-unavailable'); assert.equal(nav.getSnapshot().back, before);
  assert.equal(nav.getSnapshot().documentId, note.id); assert.equal(nav.getSnapshot().catalogVersion, versions[1]);
  assert.equal((await nav.openDocument(doc.id)).reason, 'catalog-head-selection-required');
});

 test('translated citations keep actual page and anchor; orphan and ambiguous routes cannot redirect', async () => {
  for (const mapping of ['available', 'orphan', 'ambiguous'] as const) {
    const { doc, target, create } = await setup(mapping);
    const nav = create(); nav.registerCurrent(doc.id, clean());
    const page = doc.translation!.pages[0];
    const translated: CitationTarget = { ...target, surface: 'translated', pageId: page.id,
      backgroundRevision: page.backgroundRevision, anchor: { xPt: 120, yPt: 80 } };
    const result = await nav.openCitation(translated);
    if (mapping === 'available') {
      assert.equal(result.status, 'applied');
      assert.deepEqual(nav.getSnapshot().citation!.target, translated);
      assert.notEqual(nav.getSnapshot().citation!.target.pageId, doc.pages[0].id);
    } else {
      assert.equal(result.reason, mapping === 'orphan' ? 'translation-unmapped' : 'translation-ambiguous');
      assert.equal(nav.getSnapshot().citation, null);
      assert.deepEqual(nav.getSnapshot().back, []);
    }
  }
});


test('null shell opens first real member without guard or synthetic back entry', async () => {
  const { repository, doc, note } = await setup();
  const nav = new ContentNavigationSession({ repository, documentId: null, isActive: () => true });
  assert.equal((await nav.openDocument(doc.id)).reason, 'unavailable');
  nav.setAvailable(true); assert.equal((await nav.openDocument(crypto.randomUUID())).reason, 'missing');
  assert.equal(nav.getSnapshot().documentId, null); assert.deepEqual(nav.getSnapshot().back, []);
  assert.equal((await nav.openDocument(doc.id)).status, 'applied');
  assert.equal(nav.getSnapshot().documentId, doc.id); assert.deepEqual(nav.getSnapshot().back, []);
  assert.equal((await nav.openDocument(note.id)).reason, 'current-unavailable');
  const release = nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(note.id)).status, 'applied');
  assert.deepEqual(nav.getSnapshot().back.map(value => value.documentId), [doc.id]);
  release();
});


test('scope form guard refuses leave and owned cleanup cannot remove a newer guard', async () => {
  const { repository } = await setup(); const sessions = new DocumentEditSessions(repository); await sessions.initialize();
  let dirty = true; const old = sessions.registerScopeViewGuard(() => !dirty);
  assert.equal((await sessions.prepareLeave()).status, 'refused');
  const current = sessions.registerScopeViewGuard(() => false); old(); dirty = false;
  assert.equal((await sessions.prepareLeave()).status, 'refused');
  current(); assert.equal((await sessions.prepareLeave()).status, 'allowed');
});


test('external navigation fixes its original full scope even when document IDs coincide', async () => {
  const { repository, scope, doc } = await setup();
  const nav = new ContentNavigationSession({ repository, documentId: doc.id, isActive: () => true });
  assert.doesNotThrow(() => nav.assertScope({ ...scope }));
  assert.throws(() => nav.assertScope({ ...scope, accountId: 'other' }), /navigation-scope/);
  assert.throws(() => nav.assertScope({ ...scope, libraryId: crypto.randomUUID() }), /navigation-scope/);
  assert.throws(() => nav.assertScope({ ...scope, epoch: 'other' }), /navigation-scope/);
  assert.equal(Object.isFrozen(nav.scope), true);
  assert.equal(nav.getSnapshot().documentId, doc.id);
});


test('cross-document forward restores the exact citation and respects the source guard', async () => {
  const { doc, note, target, create } = await setup(); const nav = create(); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.openDocument(note.id)).status, 'applied'); nav.registerCurrent(note.id, clean());
  assert.equal((await nav.openCitation(target)).status, 'applied');
  const first = nav.getSnapshot().citation!; nav.completeCitation(first.id); nav.registerCurrent(doc.id, clean());
  assert.equal((await nav.back()).status, 'applied');
  let allowed = false; const release = nav.registerCurrent(note.id, { prepareClose: async () => allowed, canClose: () => allowed });
  const retained = nav.getSnapshot().forward; assert.equal((await nav.forward()).status, 'blocked'); assert.equal(nav.getSnapshot().forward, retained);
  allowed = true; assert.equal((await nav.forward()).status, 'applied'); release();
  assert.deepEqual(nav.getSnapshot().citation?.target, target); assert.notEqual(nav.getSnapshot().citation?.id, first.id);
  assert.equal(nav.getSnapshot().forward.length, 0);
});

test('new cross-document navigation clears forward', async () => {
  const { doc, note, target, create } = await setup(); const nav = create(); nav.registerCurrent(doc.id, clean());
  await nav.openDocument(note.id); nav.registerCurrent(note.id, clean()); await nav.openCitation(target);
  nav.registerCurrent(doc.id, clean()); await nav.back(); nav.registerCurrent(note.id, clean());
  assert.equal(nav.getSnapshot().forward.length, 1);
  await nav.openDocument(doc.id); assert.equal(nav.getSnapshot().forward.length, 0);
});

test('document route history is bounded and forward restores an annotation expectation', async () => {
  const { doc, note, scope, create } = await setup(undefined, true), nav = create();
  nav.registerCurrent(doc.id, clean());
  for (let index = 0; index < 110; index++) {
    const next = index % 2 ? doc.id : note.id;
    assert.equal((await nav.openDocument(next)).status, 'applied'); nav.registerCurrent(next, clean());
  }
  assert.equal(nav.getSnapshot().back.length, 100);
  const row = projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'test', document: doc }])[0];
  const request = { version: doc.version, row, target: row.target };
  await nav.openDocument(note.id); nav.registerCurrent(note.id, clean());
  assert.equal((await nav.openAnnotation(request)).status, 'applied'); nav.registerCurrent(doc.id, clean());
  nav.completeCitation(nav.getSnapshot().citation!.id);
  assert.equal((await nav.back()).status, 'applied'); nav.registerCurrent(note.id, clean());
  assert.equal((await nav.forward()).status, 'applied');
  assert.deepEqual(nav.getSnapshot().citation?.annotation, request);
});

test('stale forward read preserves both document history stacks', async () => {
  const { repository, doc, note, target, create } = await setup();
  const gate = deferred(), entered = deferred(); let hold = false;
  const nav = create(async id => { if (hold && id === doc.id) { entered.resolve(); await gate.promise; } return repository.read(id); });
  nav.registerCurrent(doc.id, clean()); await nav.openDocument(note.id); nav.registerCurrent(note.id, clean());
  await nav.openCitation(target); nav.registerCurrent(doc.id, clean()); nav.completeCitation(nav.getSnapshot().citation!.id);
  await nav.back(); const release = nav.registerCurrent(note.id, clean());
  const beforeBack = nav.getSnapshot().back, beforeForward = nav.getSnapshot().forward;
  hold = true; const work = nav.forward(); await entered.promise; release(); gate.resolve();
  assert.equal((await work).status, 'blocked');
  assert.equal(nav.getSnapshot().back, beforeBack); assert.equal(nav.getSnapshot().forward, beforeForward);
  assert.equal(nav.getSnapshot().documentId, note.id);
});

test('annotation forward revalidates its selected head after the target changes', async () => {
  const { repository, scope, doc, note, create } = await setup(undefined, true), nav = create();
  nav.registerCurrent(doc.id, clean()); await nav.openDocument(note.id); nav.registerCurrent(note.id, clean());
  const row = projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'test', document: doc }])[0];
  const request = { version: doc.version, row, target: row.target };
  assert.equal((await nav.openAnnotation(request)).status, 'applied'); nav.registerCurrent(doc.id, clean());
  nav.completeCitation(nav.getSnapshot().citation!.id); await nav.back(); nav.registerCurrent(note.id, clean());
  const page = doc.pages[0], annotation = page.annotations[0]; if (annotation.kind !== 'sticky') throw new Error('fixture');
  assert.equal((await repository.commit({ kind: 'page', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: doc.id,
    parents: [doc.version], expected: { pageId: page.id, backgroundRevision: page.backgroundRevision, lifecycleVersion: page.lifecycleVersion, annotationVersion: page.annotationVersion },
    changes: [{ type: 'update', annotation: { ...annotation, text: 'new head' } }] })).status, 'durable');
  const before = nav.getSnapshot().forward;
  assert.equal((await nav.forward()).reason, 'annotation-head-changed'); assert.equal(nav.getSnapshot().forward, before);
});

test('selection restore yields to an explicit navigation while its catalog read is pending', async () => {
  const { repository, scope, doc, note } = await setup();
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); let first = true;
  const nav = new ContentNavigationSession({ repository: { scope, read: async id => { if (first && id === scope.libraryId) { first = false; await waiting; } return repository.read(id); } }, documentId: null, isActive: () => true });
  nav.setAvailable(true); let interactions = 0; const selected: string[] = [];
  nav.observeSelection(id => selected.push(id), () => { interactions++; });
  const restore = nav.restoreDocument(doc.id, () => interactions === 0);
  await Promise.resolve(); assert.equal(nav.isRestoring(), true); const explicit = nav.openDocument(note.id); release();
  assert.equal((await explicit).status, 'applied'); assert.equal((await restore).status, 'blocked');
  assert.equal(nav.getSnapshot().documentId, note.id); assert.deepEqual(selected, [note.id]);
});

test('cached missing and conflicted content never become an automatic selected head', async () => {
  const { repository, scope, doc } = await setup();
  const nav = new ContentNavigationSession({ repository: { scope, read: async id => {
    const value = await repository.read(id);
    return id === doc.id ? { ...value, heads: [doc.version, crypto.randomUUID()] } : value;
  } }, documentId: null, isActive: () => true });
  nav.setAvailable(true); const missing = await nav.restoreDocument(crypto.randomUUID(), () => true);
  assert.equal(missing.reason, 'missing'); assert.equal(nav.getSnapshot().documentId, null);
  const conflict = await nav.restoreDocument(doc.id, () => true);
  assert.equal(conflict.reason, 'content-head-selection-required'); assert.equal(nav.getSnapshot().documentId, null);
});

test('restore lifecycle transitions notify even if stale read completes before resume', async () => {
  const { repository, scope, doc, note } = await setup();
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); let first = true;
  const nav = new ContentNavigationSession({ repository: { scope, read: async id => { if (first && id === scope.libraryId) { first = false; await waiting; } return repository.read(id); } }, documentId: null, isActive: () => true });
  let events = 0; nav.subscribe(() => { events++; }); nav.setAvailable(true);
  const revision = nav.getAvailabilityRevision(); const pending = nav.restoreDocument(doc.id, () => true);
  await Promise.resolve(); nav.setAvailable(false); release(); assert.equal((await pending).reason, 'stale');
  assert.equal(nav.isAvailable(), false); const beforeResume = events; nav.setAvailable(true);
  assert.ok(events > beforeResume); assert.ok(nav.getAvailabilityRevision() > revision);
  assert.equal((await nav.restoreDocument(doc.id, () => true)).status, 'applied'); assert.equal(nav.getSnapshot().documentId, doc.id);
  assert.equal((await nav.openDocument(note.id)).reason, 'current-unavailable');
});

test('loader handoff rechecks the real successor guard before applying the original explicit navigation', async () => {
  for (const permitted of [true, false]) {
    const { repository, doc, note } = await setup();
    const nav = new ContentNavigationSession({ repository, documentId: doc.id, isActive: () => true }); nav.setAvailable(true);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const old = nav.registerCurrent(doc.id, { prepareClose: async () => { await wait; return true; }, canClose: () => true }, 'loading');
    const pending = nav.openDocument(note.id); await Promise.resolve(); old(); let prepared = 0;
    nav.registerCurrent(doc.id, { prepareClose: async () => { prepared++; return permitted; }, canClose: () => permitted }); release();
    const result = await pending; assert.equal(prepared, 1);
    assert.equal(result.status, permitted ? 'applied' : 'blocked'); assert.equal(nav.getSnapshot().documentId, permitted ? note.id : doc.id);
  }
});

test('loader gap and lifecycle loss stay stale without guardless fallback', async () => {
  for (const hide of [false, true]) {
    const { repository, doc, note } = await setup();
    const nav = new ContentNavigationSession({ repository, documentId: doc.id, isActive: () => true }); nav.setAvailable(true);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const old = nav.registerCurrent(doc.id, { prepareClose: async () => { await wait; return true; }, canClose: () => true }, 'loading');
    const pending = nav.openDocument(note.id); await Promise.resolve(); old(); if (hide) nav.setAvailable(false); release();
    assert.equal((await pending).reason, 'stale'); assert.equal(nav.getSnapshot().documentId, doc.id);
  }
});

test('failed loader guard permits a fresh validated exit, while controller replacement remains stale', async () => {
  for (const kind of ['loading', 'controller'] as const) {
    const { repository, doc, note } = await setup();
    const nav = new ContentNavigationSession({ repository, documentId: doc.id, isActive: () => true }); nav.setAvailable(true);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const old = nav.registerCurrent(doc.id, { prepareClose: async () => { await wait; return true; }, canClose: () => true }, kind);
    const pending = nav.openDocument(note.id); await Promise.resolve(); old();
    nav.registerCurrent(doc.id, { prepareClose: async () => true, canClose: () => true }, kind === 'loading' ? 'error' : 'controller'); release();
    assert.equal((await pending).status, kind === 'loading' ? 'applied' : 'blocked');
    assert.equal(nav.getSnapshot().documentId, kind === 'loading' ? note.id : doc.id);
  }
});

test('same mounted loader replay preserves the guard but a different loader does not', async () => {
  for (const same of [true, false]) {
    const { repository, doc, note } = await setup();
    const nav = new ContentNavigationSession({ repository, documentId: doc.id, isActive: () => true }); nav.setAvailable(true);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), loader = {};
    const guard = { prepareClose: async () => { await gate; return true; }, canClose: () => true };
    const old = nav.registerCurrent(doc.id, guard, 'loading', loader), pending = nav.openDocument(note.id);
    await Promise.resolve(); old(); nav.registerCurrent(doc.id, guard, 'loading', same ? loader : {}); release();
    assert.equal((await pending).status, same ? 'applied' : 'blocked'); assert.equal(nav.getSnapshot().documentId, same ? note.id : doc.id);
  }
});

test('a loader token cannot revive an old pending guard after another owner or a lifecycle transition', async () => {
  for (const transition of ['other-loader', 'controller', 'availability', 'absent'] as const) {
    const { repository, doc, note } = await setup();
    const nav = new ContentNavigationSession({ repository, documentId: doc.id, isActive: () => true }); nav.setAvailable(true);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), a = {}, b = {};
    const guard = { prepareClose: async () => { await gate; return true; }, canClose: () => true };
    const old = nav.registerCurrent(doc.id, guard, 'loading', a), pending = nav.openDocument(note.id);
    await Promise.resolve(); old();
    if (transition === 'other-loader') { const different = nav.registerCurrent(doc.id, guard, 'loading', b); different(); nav.registerCurrent(doc.id, guard, 'loading', a); }
    if (transition === 'controller') { const controller = nav.registerCurrent(doc.id, guard); controller(); nav.registerCurrent(doc.id, guard, 'loading', a); }
    if (transition === 'availability') { nav.setAvailable(false); nav.setAvailable(true); nav.registerCurrent(doc.id, guard, 'loading', a); }
    release(); const result = await pending; assert.equal(result.status, 'blocked', transition); assert.equal(nav.getSnapshot().documentId, doc.id);
  }
});
