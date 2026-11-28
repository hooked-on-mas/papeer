import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLibraryContentKind } from '../src/features/reader/libraryContentKind.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { resourceHash } from '../src/runtime/edits/contentPublication.ts';
import type { ContentPublication, LibrarySnapshot } from '../src/runtime/edits/contracts.ts';
import { ContentNavigationSession } from '../src/features/reader/navigation/ContentNavigationSession.ts';
import { readFileSync } from 'node:fs';

async function setup() {
  const scope = { accountId: 'kind', libraryId: crypto.randomUUID(), epoch: 'one' };
  const local = new DurableEditRepository(scope, new EditMemoryDatabase());
  const peer = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [], folders: [], links: [], deletions: [] };
  await local.initialize(root); await peer.initialize(root);
  const id = crypto.randomUUID();
  const item = { id, kind: 'markdown' as const, title: 'note', ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} };
  const publication: ContentPublication = { libraryBatch: { kind: 'library', id: crypto.randomUUID(), libraryId: scope.libraryId,
    targetId: scope.libraryId, parents: [root.version], changes: [{ type: 'put-item', item }] },
  content: { kind: 'markdown', id, version: crypto.randomUUID(), content: 'arrived', imageResources: [], appendIds: [] } };
  assert.equal((await peer.publish(publication)).status, 'durable');
  return { local, peer, root, publication, item };
}

test('existing empty local catalog receives publication once and resolves without dropping an explicit head', async () => {
  for (const pinned of [false, true]) {
    const { local, publication, item } = await setup(); let refreshes = 0;
    assert.equal(await resolveLibraryContentKind({ repository: local, documentId: item.id,
      catalogVersion: pinned ? publication.libraryBatch.id : undefined,
      refresh: async () => { refreshes++; await local.receivePublications([publication]); } }), 'markdown');
    assert.equal(refreshes, 1);
    let rejectedRefreshes = 0;
    await assert.rejects(resolveLibraryContentKind({ repository: local, documentId: item.id, catalogVersion: crypto.randomUUID(),
      refresh: async () => { rejectedRefreshes++; } }), /catalog-head-unavailable/);
    assert.equal(rejectedRefreshes, 1);
  }
});

test('attachment startup receives exact resource publication and never reads attachment content', async () => {
  const { local, peer, publication, item, root } = await setup();
  const bytes = new TextEncoder().encode('# file'), resourceId = crypto.randomUUID(), id = crypto.randomUUID();
  const resource = { id: resourceId, bytes, sha256: await resourceHash(bytes), mediaType: 'text/markdown' };
  await peer.storeResource(resource);
  const attached: ContentPublication = { libraryBatch: { kind: 'library', id: crypto.randomUUID(), libraryId: root.id, targetId: root.id,
    parents: [publication.libraryBatch.id], changes: [{ type: 'put-item', item: { ...item, id, kind: 'attachment', ownerId: item.id, resourceId } }] } };
  assert.equal((await peer.publish(attached)).status, 'durable');
  const read = local.read.bind(local); let refreshes = 0;
  assert.equal(await resolveLibraryContentKind({ repository: { scope: local.scope,
    read: async targetId => { assert.equal(targetId, root.id, 'attachment routing reads only the catalog'); return read(targetId); } }, documentId: id,
  refresh: async () => { refreshes++; await local.storeResource(resource); await local.receivePublications([publication, attached]); } }), 'attachment');
  assert.equal(refreshes, 1);
  let active = true;
  await assert.rejects(resolveLibraryContentKind({ repository: { scope: local.scope, read: async () => { active = false; throw new Error('late'); } },
    documentId: id, alive: () => active, refresh: async () => { throw new Error('must not synchronize stale load'); } }), /content-load-stale/);
});

test('read-only loading guard permits explicit selection from multihead startup and hands off to the real owner', async () => {
  const { local, publication, item } = await setup();
  await local.receivePublications([publication]);
  const heads: string[] = [];
  for (const title of ['one', 'two']) {
    const id = crypto.randomUUID(); heads.push(id);
    assert.equal((await local.commit({ kind: 'library', id, libraryId: local.scope.libraryId, targetId: local.scope.libraryId,
      parents: [publication.libraryBatch.id], changes: [{ type: 'put-item', item: { ...item, title } }] })).status, 'durable');
  }
  await assert.rejects(resolveLibraryContentKind({ repository: local, documentId: item.id, refresh: async () => {} }), /head-unavailable/);
  const nav = new ContentNavigationSession({ repository: local, documentId: item.id, isActive: () => true });
  nav.setAvailable(true);
  assert.equal((await nav.openDocument(item.id, heads[0])).reason, 'current-unavailable');
  const releaseLoader = nav.registerCurrent(item.id, { prepareClose: async () => true, canClose: () => true });
  assert.equal((await nav.openDocument(item.id, heads[0])).status, 'applied');
  assert.equal(await resolveLibraryContentKind({ repository: local, documentId: item.id,
    catalogVersion: nav.getSnapshot().catalogVersion!, refresh: async () => {} }), 'markdown');
  releaseLoader();
  const releaseEditor = nav.registerCurrent(item.id, { prepareClose: async () => false, canClose: () => false });
  assert.equal((await nav.openDocument(item.id, heads[1])).reason, 'current-blocked');
  releaseEditor();
  assert.equal((await nav.openDocument(item.id, heads[1])).reason, 'current-unavailable');
  const source = readFileSync(new URL('../src/features/reader/LibraryContentConnection.tsx', import.meta.url), 'utf8');
  assert.match(source, /fallback=\{<ContentLoader documentId=\{binding.documentId\}/);
  assert.match(source, /useLayoutEffect\(\(\) => navigation\?\.registerCurrent\(documentId/);
});
