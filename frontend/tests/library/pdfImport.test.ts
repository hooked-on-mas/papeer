import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibrarySession } from '../../src/features/library/LibrarySession.ts';
import { DurableEditRepository } from '../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../support/editMemoryDatabase.ts';
import type { LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';

async function setup() {
  const scope = { accountId: 'pdf-import', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase(), {
    inspectPdf: async () => [{ widthPt: 600, heightPt: 800 }, { widthPt: 300, heightPt: 500 }],
  });
  const library: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), items: [], folders: [], links: [], deletions: [] };
  await repository.initialize(library);
  const reopen = () => new LibrarySession({ repository, isActive: () => true });
  const session = reopen(); assert.equal(await session.refresh(), true);
  return { repository, session, reopen };
}
const bytes = () => new TextEncoder().encode('%PDF-unit-inspection-fixture');
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('PDF import atomically publishes inspected physical pages and durable library Undo/Redo', async () => {
  const { repository, session, reopen } = await setup();
  await session.createFolder('PDFs', null); const folderId = session.getSnapshot().createdFolderId!;
  const input = bytes(), expected = Uint8Array.from(input);
  const saving = session.importPdf({ name: '論文.pdf', folderId, bytes: input }); input.fill(0);
  assert.equal(session.canLeave(), false); assert.equal(await saving, true, session.getSnapshot().error);
  const item = session.getSnapshot().items[0]; assert.equal(item.kind, 'pdf'); assert.equal(item.folderId, folderId); assert.equal(item.ownerId, null);
  const resource = await repository.readResource(item.resourceId!); assert.deepEqual(resource?.bytes, expected);
  const state = await repository.read(item.id); assert.equal(state.checkpoint.root.kind, 'document');
  if (state.checkpoint.root.kind !== 'document') throw new Error('document required');
  const pages = state.checkpoint.root.pages;
  assert.deepEqual(pages.map(page => [page.widthPt, page.heightPt]), [[600, 800], [300, 500]]);
  pages.forEach((page, i) => assert.deepEqual(page.background, { kind: 'pdf', resourceId: item.resourceId, sourceRevision: resource!.metadata.sha256, pdfPage: i + 1 }));
  const fresh = reopen(); assert.equal(await fresh.refresh(), true); assert.equal(await fresh.undo(), true, fresh.getSnapshot().error);
  assert.equal(fresh.getSnapshot().items.length, 0); assert.ok(await repository.readResource(item.resourceId!));
  assert.equal(await fresh.redo(), true, fresh.getSnapshot().error); assert.equal(fresh.getSnapshot().items[0].id, item.id);
  assert.deepEqual((await repository.read(item.id)).checkpoint.root, state.checkpoint.root);
});

test('resource failure retains original PDF bytes and fixed identity for retry', async () => {
  const { repository, session } = await setup(), store = repository.storeResource.bind(repository);
  const attempts: Parameters<typeof store>[0][] = [];
  repository.storeResource = async input => { attempts.push(structuredClone(input)); if (attempts.length === 1) throw new Error('offline'); return store(input); };
  assert.equal(await session.importPdf({ name: 'retry.pdf', bytes: bytes() }), false);
  assert.equal(session.getSnapshot().items.length, 0); assert.equal(session.canLeave(), false); assert.equal(session.getSnapshot().attachment?.pdf, true);
  assert.equal(await session.retryAttachment(), true, session.getSnapshot().error);
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(session.getSnapshot().items.length, 1); assert.equal(session.canLeave(), true);
});

test('lost publication reply recovers the exact PDF request after restart without a duplicate item', async () => {
  const { repository, session, reopen } = await setup(), publish = repository.publish.bind(repository);
  const requests: Parameters<typeof publish>[0][] = [];
  repository.publish = async (value, history) => {
    requests.push(structuredClone(value)); const result = await publish(value, history);
    return requests.length === 1 ? { status: 'unknown', reason: 'lost-reply' } : result;
  };
  assert.equal(await session.importPdf({ name: 'unknown.pdf', bytes: bytes() }), false);
  const fresh = reopen(); assert.equal(await fresh.refresh(), true); assert.equal(fresh.getSnapshot().attachment?.pdf, true);
  assert.equal(await fresh.retryAttachment(), true, fresh.getSnapshot().error);
  assert.deepEqual(requests[0], requests[1]); assert.equal(fresh.getSnapshot().items.length, 1); assert.equal(fresh.canLeave(), true);
});

test('cancel during PDF storage fences the late write and publishes neither catalog nor document', async () => {
  const { repository, session } = await setup(), waiting = gate(), entered = gate(), store = repository.storeResource.bind(repository);
  repository.storeResource = async input => { entered.resolve(); await waiting.promise; return store(input); };
  const pending = session.importPdf({ name: 'late.pdf', bytes: bytes() }); await entered.promise;
  assert.equal(await session.cancelAttachment(), true); waiting.resolve(); assert.equal(await pending, false);
  assert.equal(session.getSnapshot().items.length, 0); assert.equal((await repository.checkpoint()).roots.length, 1); assert.equal(session.canLeave(), true);
});

test('PDF metadata inspection failure is retained for explicit retry or cancellation', async () => {
  const { repository, session } = await setup(), read = repository.readResource.bind(repository);
  repository.readResource = async id => { const value = await read(id); return value ? { ...value, metadata: { ...value.metadata, pdfPages: [] } } : value; };
  assert.equal(await session.importPdf({ name: 'bad.pdf', bytes: bytes() }), false); assert.match(session.getSnapshot().error, /pdf-resource/);
  assert.equal(session.getSnapshot().items.length, 0); assert.equal(session.canLeave(), false);
  assert.equal(await session.cancelAttachment(), true); assert.equal(session.canLeave(), true);
});
