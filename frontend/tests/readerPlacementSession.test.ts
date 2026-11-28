import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderPlacementSession, type ReaderPlacementStatePort, type SavedMarkdownReaderState } from '../src/features/reader/ReaderPlacementSession.ts';
import { ReaderSession } from '../src/features/reader/ReaderSession.ts';
import { BrowserReaderStatePort } from '../src/adapters/browser/readerState.ts';

const documentId = crypto.randomUUID();
const scope = { accountId: 'placement', libraryId: crypto.randomUUID(), epoch: 'one' };

test('paged and pageless readers roundtrip through the same scoped storage without leaking state', () => {
  const stored = new Map<string, string>();
  const persistence = new BrowserReaderStatePort(scope, { getItem: id => stored.get(id) ?? null, setItem: (id, value) => { stored.set(id, value); } });
  const pdfId = crypto.randomUUID(), pageId = crypto.randomUUID();
  const markdown = new ReaderPlacementSession({ scope, documentId, persistence, canMove: () => true });
  const pdf = new ReaderSession({ scope, documentId: pdfId, persistence, canNavigate: () => true });
  markdown.setPlacement('right'); markdown.flush();
  pdf.reconcile([pageId]); pdf.setViewport(pageId, { fitWidth: 800, fitPageWidth: 400, drawnWidth: 400 });
  pdf.setZoom({ kind: 'scale', value: 1.25 }); pdf.remember(pageId, { x: .5, y: .3 }); pdf.flush();
  assert.equal(stored.size, 2);
  assert.deepEqual(new ReaderPlacementSession({ scope, documentId, persistence, canMove: () => true }).getSnapshot(), { placement: 'right', error: '' });
  const restored = new ReaderSession({ scope, documentId: pdfId, persistence, canNavigate: () => true });
  restored.reconcile([pageId]);
  assert.deepEqual(restored.getSnapshot().zoom, { kind: 'scale', value: 1.25 });
  assert.deepEqual(restored.getSnapshot().positions[pageId], { x: .5, y: .3 });
  assert.equal(restored.getSnapshot().placement, 'center');
});
function setup(initial?: unknown) {
  let raw = initial, failure = '', allowed = true;
  const writes: { id: string; value: SavedMarkdownReaderState }[] = [];
  const persistence: ReaderPlacementStatePort = { scope, read: () => raw, write: (id, value) => {
    if (failure) throw new Error(failure);
    raw = structuredClone(value); writes.push({ id, value: structuredClone(value) });
  } };
  const create = () => new ReaderPlacementSession({ scope, documentId, persistence, canMove: () => allowed });
  return { session: create(), create, persistence, writes, raw: () => raw,
    fail: (value: string) => { failure = value; }, allow: (value: boolean) => { allowed = value; } };
}

test('placement updates synchronously, subscribes, persists and reloads without page state', () => {
  const { session, create, writes } = setup();
  let notifications = 0; const unsubscribe = session.subscribe(() => notifications++);
  assert.equal(session.getSnapshot().placement, 'center'); assert.equal(session.setPlacement('right'), true);
  assert.equal(session.getSnapshot().placement, 'right'); assert.equal(notifications, 1);
  session.flush(); assert.deepEqual(writes, [{ id: documentId, value: { version: 1, kind: 'markdown', placement: 'right' } }]);
  assert.deepEqual(create().getSnapshot(), { placement: 'right', error: '' });
  unsubscribe(); session.setPlacement('center'); session.flush(); assert.equal(notifications, 1);
});

test('guarded and unchanged requests neither move nor write', () => {
  const { session, allow, writes } = setup();
  allow(false); assert.equal(session.setPlacement('right'), false); session.flush();
  assert.equal(session.getSnapshot().placement, 'center'); assert.equal(writes.length, 0);
  allow(true); assert.equal(session.setPlacement('center'), false); session.flush(); assert.equal(writes.length, 0);
});

test('failed save preserves chosen placement and retry writes the latest state', () => {
  const { session, fail, create, writes } = setup();
  fail('quota'); session.setPlacement('right'); session.flush();
  assert.equal(session.getSnapshot().placement, 'right'); assert.match(session.getSnapshot().error, /quota/);
  assert.equal(writes.length, 0);
  session.setPlacement('center'); session.flush(); assert.equal(session.getSnapshot().placement, 'center');
  fail(''); session.flush(); assert.equal(session.getSnapshot().error, '');
  assert.equal(create().getSnapshot().placement, 'center'); assert.equal(writes.length, 1);
});

test('invalid preferences remain raw until an explicit allowed placement change', () => {
  for (const invalid of [{ version: 1, kind: 'markdown', placement: 'bottom' }, { version: 2, kind: 'markdown', placement: 'right' },
    { version: 1, kind: 'markdown', placement: 'right', pageId: documentId }, { version: 1, placement: 'right' }, 'raw']) {
    const { session, raw, writes, allow } = setup(invalid);
    assert.match(session.getSnapshot().error, /invalid-markdown-reader-state/);
    session.flush(); allow(false); session.setPlacement('right'); session.flush();
    assert.deepEqual(raw(), invalid); assert.equal(writes.length, 0);
    allow(true); session.setPlacement('right'); session.flush(); assert.equal(session.getSnapshot().error, '');
  }
});

test('read errors do not write defaults, scope identity stays fixed and mismatches fail closed', () => {
  const localScope = { ...scope }; let writes = 0;
  const persistence: ReaderPlacementStatePort = { scope, read: () => { throw new Error('storage-unavailable'); }, write: () => { writes++; } };
  const session = new ReaderPlacementSession({ scope: localScope, documentId, persistence, canMove: () => true });
  localScope.epoch = 'mutated'; assert.equal(session.scope.epoch, 'one');
  assert.match(session.getSnapshot().error, /storage-unavailable/); session.flush(); assert.equal(writes, 0);
  assert.throws(() => new ReaderPlacementSession({ scope: localScope, documentId, persistence, canMove: () => true }), /reader-state-scope/);
  assert.throws(() => new ReaderPlacementSession({ scope, documentId: 'bad', persistence, canMove: () => true }), /reader-document-id/);
});
