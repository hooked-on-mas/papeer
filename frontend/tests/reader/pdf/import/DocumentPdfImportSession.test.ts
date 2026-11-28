import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DocumentPdfImportSession } from '../../../../src/features/reader/pdf/import/DocumentPdfImportSession.ts';
import { DocumentEditSession } from '../../../../src/features/reader/edit/DocumentEditSession.ts';
import { DurableEditRepository } from '../../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../../support/editMemoryDatabase.ts';
import type { DocumentSnapshot } from '../../../../src/runtime/edits/contracts.ts';
const fixture = JSON.parse(readFileSync(new URL('../../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from([37,80,68,70,45,49,46,55]);
async function setup(withInk = false, withHighlight = false, pageCount = 2) {
  const root = structuredClone(fixture.document) as DocumentSnapshot;
  if (withInk) root.pages[0].annotations = [{ kind: 'ink', id: crypto.randomUUID(), geometry: { kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 85, y: 25 }, head: 'both', headLengthPt: 12, preferredHeadLengthPt: 17 }, transform: { x: 250, y: 250, rotationRad: 0, scaleX: 1, scaleY: 1 }, style: { color: '#345678', widthPt: 3, opacity: 1, highlighter: false } }];
  if (withHighlight) { const page = root.pages[0]; page.annotations = [{ kind: 'highlight', id: crypto.randomUUID(), backgroundRevision: page.backgroundRevision, range: { kind: 'indexed', start: 0, end: 3 }, quote: 'abc', text: 'comment', anchor: { x: 1, y: 1 }, metadata: { label: 'highlight', createdAt: '2026-10-25T00:00:00Z' }, color: '#facc15', quads: [[{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 10 }, { x: 1, y: 10 }]] }]; }
  while (root.pages.length < pageCount) root.pages.push({ ...structuredClone(root.pages[0]), id: crypto.randomUUID() });
  const repo = new DurableEditRepository({ accountId: 'notebook-import', libraryId: fixture.libraryId, epoch: 'one' }, new EditMemoryDatabase(),
    { inspectPdf: async () => [{ widthPt: 1000, heightPt: 1000 }, { widthPt: 200, heightPt: 200 }] });
  await repo.initialize(root); const document = new DocumentEditSession(repo, root.id); assert.equal(await document.refresh(), true);
  let active = true, blocked = false;
  const session = new DocumentPdfImportSession({ repository: repo, document, active: () => active, inputBlocked: () => blocked, makeId: () => crypto.randomUUID() });
  return { root, repo, document, session, setActive: (v: boolean) => { active = v; }, setBlocked: (v: boolean) => { blocked = v; } };
}
test('insert verified chosen physical page and undo in existing document history', async () => {
  const f = await setup(), page = f.document.getSnapshot().document!.pages[0];
  assert.equal(await f.session.stage(page, async () => bytes), true); assert.equal(f.session.canLeave(), false);
  assert.equal((await f.session.submit('insert', 2)).status, 'applied');
  const inserted = f.document.getSnapshot().document!.pages[1]; assert.equal(inserted.background.kind, 'pdf');
  if (inserted.background.kind !== 'pdf') throw new Error('PDF required'); assert.equal(inserted.background.pdfPage, 2); assert.equal(inserted.widthPt, 200);
  assert.equal((await f.document.undo()).status, 'applied'); assert.equal(f.document.getSnapshot().document!.pages.some(p => p.id === inserted.id), false);
});
test('same-ID replacement preserves fitting annotations and rejects overflow', async () => {
  const f = await setup(true), original = f.document.getSnapshot().document!.pages[0];
  assert.equal(await f.session.stage(original, async () => bytes), true);
  const smaller = await f.session.submit('replace', 2); assert.equal(smaller.status, 'refused');
  assert.equal(await f.session.submit('replace', 1).then(v => v.status), 'applied');
  const replaced = f.document.getSnapshot().document!.pages[0]; assert.equal(replaced.id, original.id); assert.notEqual(replaced.backgroundRevision, original.backgroundRevision); assert.deepEqual(replaced.annotations, original.annotations);
  assert.equal((await f.document.undo()).status, 'applied'); assert.equal(f.document.getSnapshot().document!.pages[0].background.kind, original.background.kind);
});
test('resource readback failure retries same ID; stale and blocked submissions refuse', async () => {
  const f = await setup(), page = f.document.getSnapshot().document!.pages[0], ids: string[] = [], store = f.repo.storeResource.bind(f.repo), read = f.repo.readResource.bind(f.repo);
  f.repo.storeResource = async input => { ids.push(input.id); return store(input); }; let corrupt = true;
  f.repo.readResource = async id => { const value = await read(id); if (!value || !corrupt) return value; corrupt = false; return { ...value, bytes: Uint8Array.from(value.bytes, x => x ^ 1) }; };
  assert.equal(await f.session.stage(page, async () => bytes), false); assert.equal(await f.session.retry(), true); assert.equal(ids[0], ids[1]);
  f.setBlocked(true); assert.equal((await f.session.submit('insert', 1)).status, 'refused'); f.setBlocked(false);
  assert.equal((await f.document.editDocument([{ type: 'move', expected: { pageId: f.root.pages[1].id, backgroundRevision: f.root.pages[1].backgroundRevision, lifecycleVersion: f.root.pages[1].lifecycleVersion, annotationVersion: f.root.pages[1].annotationVersion }, index: 0 }])).status, 'applied');
  assert.equal((await f.session.submit('insert', 1)).status, 'refused');
});
test('submit acquires gate before head read; double submit and cancel cannot race', async () => {
  const f = await setup(), page = f.document.getSnapshot().document!.pages[0]; assert.equal(await f.session.stage(page, async () => bytes), true);
  const read = f.repo.read.bind(f.repo); let release!: () => void, entered!: () => void; const wait = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  f.repo.read = async id => { entered(); await wait; return read(id); };
  const first = f.session.submit('insert', 1); await started; assert.equal(f.session.canLeave(), false); assert.equal(f.session.cancel(), false);
  assert.equal((await f.session.submit('insert', 1)).status, 'refused'); release(); assert.equal((await first).status, 'applied');
});

test('replacement refuses a text highlight rather than rebinding its anchor', async () => {
  const f = await setup(false, true), page = f.document.getSnapshot().document!.pages[0];
  assert.equal(await f.session.stage(page, async () => bytes), true);
  const result = await f.session.submit('replace', 1); assert.equal(result.status, 'refused');
  if (result.status === 'refused') assert.match(result.reason, /highlight/);
  assert.deepEqual(f.document.getSnapshot().document!.pages[0], page);
});
test('cancel invalidates an outstanding file read', async () => {
  const f = await setup(), page = f.document.getSnapshot().document!.pages[0];
  let release!: (value: Uint8Array) => void; const pending = new Promise<Uint8Array>(r => { release = r; });
  const stage = f.session.stage(page, () => pending); assert.equal(f.session.cancel(), true); release(bytes);
  assert.equal(await stage, false); assert.equal(f.session.getSnapshot().phase, 'idle');
});

test('all PDF pages insert in one ordered batch and undo together', async () => {
  const f = await setup(), page = f.document.getSnapshot().document!.pages[0], original = f.document.getSnapshot().document!.pages.map(p => p.id);
  assert.equal(await f.session.stage(page, async () => bytes), true);
  assert.equal((await f.session.submit('insert-all', 1)).status, 'applied');
  const pages = f.document.getSnapshot().document!.pages; assert.equal(pages.length, original.length + 2);
  assert.deepEqual(pages.slice(1, 3).map(p => p.background.kind === 'pdf' ? p.background.pdfPage : 0), [1, 2]);
  assert.notEqual(pages[1].id, pages[2].id);
  assert.equal((await f.document.undo()).status, 'applied'); assert.deepEqual(f.document.getSnapshot().document!.pages.map(p => p.id), original);
});
test('standalone policy refuses insertion but permits same-ID background replacement', async () => {
  const f = await setup(), page = f.document.getSnapshot().document!.pages[0];
  const session = new DocumentPdfImportSession({ repository: f.repo, document: f.document, active: () => true, inputBlocked: () => false, makeId: () => crypto.randomUUID(), allowInsert: false });
  assert.equal(await session.stage(page, async () => bytes), true); assert.equal((await session.submit('insert-all', 1)).status, 'refused');
  assert.equal((await session.submit('replace', 1)).status, 'applied'); assert.equal(f.document.getSnapshot().document!.pages[0].id, page.id);
});

test('bulk limit refuses atomically and permits a single-page retry at 500', async () => {
  const f = await setup(false, false, 499), page = f.document.getSnapshot().document!.pages[0];
  assert.equal(await f.session.stage(page, async () => bytes), true);
  const refused = await f.session.submit('insert-all', 1); assert.equal(refused.status, 'refused');
  if (refused.status === 'refused') assert.match(refused.reason, /page-limit/);
  assert.equal(f.document.getSnapshot().document!.pages.length, 499);
  assert.equal((await f.repo.read(f.root.id)).receipts.length, 0);
  assert.equal((await f.session.submit('insert', 2)).status, 'applied');
  assert.equal(f.document.getSnapshot().document!.pages.length, 500);
});
