import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { notebookApplyPaper, notebookDuplicate, notebookInsert, notebookMove, notebookRemove } from '../src/features/notebooks/canonicalNotebookPages.ts';
import { DocumentEditSession } from '../src/features/reader/edit/DocumentEditSession.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { documentContent } from '../src/runtime/edits/documentPages.ts';
import { assertSnapshot } from '../src/runtime/edits/editModel.ts';
import type { DocumentSnapshot, InkObject, Page, PageChange, PaperSpec } from '../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const paper: PaperSpec = { template: 'grid5', color: 'cream' };
function notebook(): DocumentSnapshot {
  const document: DocumentSnapshot = structuredClone(fixture.document);
  const page = document.pages[0];
  page.background = { kind: 'paper', spec: paper };
  const ink: InkObject = { ...structuredClone(fixture.batches[0].changes[0].annotation),
    geometry: { kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 160, y: 20 }, head: 'both', headLengthPt: 10, preferredHeadLengthPt: 14 },
    transform: { x: 50, y: 60, rotationRad: .12, scaleX: 1.2, scaleY: .7 },
    style: { color: '#2468ac', widthPt: 2.75, opacity: .45, highlighter: false } };
  page.annotations = [ink,
    { kind: 'highlight', id: crypto.randomUUID(), backgroundRevision: page.backgroundRevision,
      range: { kind: 'unindexed' }, quote: 'source quote', text: 'highlight memo', anchor: { x: 480, y: 710 },
      quads: [[{ x: 450, y: 700 }, { x: 590, y: 700 }, { x: 590, y: 720 }, { x: 450, y: 720 }]],
      color: '#facc15', metadata: { label: 'original label', createdAt: '2026-10-26T00:00:00Z' } },
    { kind: 'sticky', id: crypto.randomUUID(), text: 'sticky memo', quote: 'sticky quote', anchor: { x: 570, y: 750 },
      color: null, metadata: { label: 'sticky label', createdAt: null } },
    { ...structuredClone(ink), id: crypto.randomUUID(),
      geometry: { kind: 'text', text: 'canonical font', widthPt: 100, heightPt: 30, fontSizePt: 14, fontFamily: 'serif' },
      transform: { x: 90, y: 160, rotationRad: .2, scaleX: 1.1, scaleY: .9 } },
  ];
  assertSnapshot(document); return document;
}
async function setup(document = notebook()) {
  const repository = new DurableEditRepository({ accountId: 'notebook-test', libraryId: fixture.libraryId, epoch: 'paper' }, new EditMemoryDatabase(),
    { inspectPdf: async () => structuredClone(fixture.resource.metadata.pdfPages) });
  if (document.pages.some(page => page.background.kind === 'pdf')) {
    await repository.storeResource({ id: fixture.resource.metadata.id, sha256: fixture.resource.metadata.sha256, mediaType: 'application/pdf',
      bytes: Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url))) });
  }
  await repository.initialize(document);
  const session = new DocumentEditSession(repository, document.id); assert.equal(await session.refresh(), true);
  return { repository, session, original: document, pageId: document.pages[0].id };
}
function replace(changes: PageChange[]): Page {
  assert.equal(changes.length, 1); const change = changes[0]; assert.ok(change.type === 'replace' || change.type === 'insert'); return change.page;
}
const pagesContent = (document: DocumentSnapshot) => documentContent(document).pages;

test('paper application uses the actual batch revision for highlights, preserves physical content, and fully undoes after reload', async () => {
  const { repository, session, original, pageId } = await setup();
  const spec: PaperSpec = { template: 'cornell', color: 'dark' };
  let batchId = '';
  const result = await session.buildDocumentEdit((document, id) => { batchId = id; return notebookApplyPaper(document, pageId, 700, 900, spec, id); });
  assert.deepEqual(result, { status: 'applied', operationId: batchId });
  const saved = session.getSnapshot().document!.pages[0];
  assert.equal(saved.backgroundRevision, batchId);
  assert.deepEqual(saved.background, { kind: 'paper', spec });
  assert.deepEqual(saved.annotations, original.pages[0].annotations.map(annotation => annotation.kind === 'highlight'
    ? { ...annotation, backgroundRevision: batchId } : annotation));
  assertSnapshot(session.getSnapshot().document!);
  const reopened = new DocumentEditSession(repository, original.id); await reopened.refresh();
  assert.equal((await reopened.undo()).status, 'applied');
  assert.deepEqual(pagesContent(reopened.getSnapshot().document!), pagesContent(original));
  assertSnapshot(reopened.getSnapshot().document!);
  assert.equal((await reopened.redo()).status, 'applied');
  const redone = reopened.getSnapshot().document!.pages[0];
  assert.equal(redone.widthPt, 700);
  assert.equal(redone.heightPt, 900);
  assert.deepEqual(redone.background, { kind: 'paper', spec });
  assert.equal(redone.annotations.find(annotation => annotation.kind === 'highlight')!.backgroundRevision, redone.backgroundRevision);
});

test('overflow refusal keeps history and physical geometry; explicit uniform fit is reversible and same-paper application is unchanged', async () => {
  const { repository, session, original, pageId } = await setup();
  const state = session.getSnapshot(), durable = await repository.read(original.id);
  const refused = await session.buildDocumentEdit((document, id) => notebookApplyPaper(document, pageId, 100, 100, paper, id));
  assert.equal(refused.status, 'refused');
  if (refused.status === 'refused') assert.match(refused.reason, /paper-content-overflow/);
  assert.equal(session.getSnapshot(), state);
  assert.deepEqual(await repository.read(original.id), durable);
  assert.equal((await session.buildDocumentEdit((document, id) => notebookApplyPaper(document, pageId, 306, 396, paper, id, true))).status, 'applied');
  const fitted = session.getSnapshot().document!.pages[0], ink = fitted.annotations[0], before = original.pages[0].annotations[0];
  assert.ok(ink.kind === 'ink' && before.kind === 'ink');
  assert.deepEqual(ink.geometry, before.geometry);
  assert.deepEqual(ink.style, before.style);
  assert.equal(ink.transform.x, before.transform.x * .5);
  assert.equal(ink.transform.y, before.transform.y * .5);
  assert.equal(ink.transform.scaleX, before.transform.scaleX * .5);
  assert.equal(ink.transform.scaleY, before.transform.scaleY * .5);
  const sticky = fitted.annotations[2]; assert.ok(sticky.kind === 'sticky');
  assert.deepEqual(sticky.anchor, { x: 285, y: 375 });
  await session.undo();
  assert.deepEqual(pagesContent(session.getSnapshot().document!), pagesContent(original));
  const afterUndo = await repository.read(original.id);
  assert.deepEqual(await session.buildDocumentEdit((document, id) => notebookApplyPaper(document, pageId, 612, 792, paper, id)), { status: 'unchanged' });
  assert.deepEqual(await repository.read(original.id), afterUndo);
});

test('add, duplicate all annotation kinds, move and remove share document history, tombstones and reload Undo', async () => {
  const { repository, session, original, pageId } = await setup();
  const insertedId = crypto.randomUUID(), copiedId = crypto.randomUUID(), annotationIds = original.pages[0].annotations.map(() => crypto.randomUUID());
  assert.equal((await session.buildDocumentEdit((document, id) => notebookInsert(document, pageId, 'before', insertedId, id))).status, 'applied');
  const inserted = session.getSnapshot().document!.pages[0];
  assert.equal(inserted.id, insertedId); assert.deepEqual(inserted.annotations, []);
  assert.deepEqual(inserted.background, original.pages[0].background);
  assert.equal(inserted.widthPt, original.pages[0].widthPt);
  assert.equal((await session.buildDocumentEdit((document, id) => notebookDuplicate(document, pageId, copiedId, annotationIds, id))).status, 'applied');
  const copied = session.getSnapshot().document!.pages[2];
  assert.equal(copied.id, copiedId);
  assert.deepEqual(copied.annotations, original.pages[0].annotations.map((annotation, i) => ({ ...annotation, id: annotationIds[i],
    ...(annotation.kind === 'highlight' ? { backgroundRevision: copied.backgroundRevision } : {}) })));
  assert.equal((await session.buildDocumentEdit(document => notebookMove(document, copiedId, 0))).status, 'applied');
  assert.deepEqual(session.getSnapshot().document!.pages.map(page => page.id), [copiedId, insertedId, pageId, original.pages[1].id]);
  assert.equal((await session.buildDocumentEdit(document => notebookRemove(document, copiedId))).status, 'applied');
  assert.equal(session.getSnapshot().document!.deletedPages[0].id, copiedId);
  const reopened = new DocumentEditSession(repository, original.id); await reopened.refresh();
  for (let i = 0; i < 4; i++) assert.equal((await reopened.undo()).status, 'applied');
  assert.deepEqual(pagesContent(reopened.getSnapshot().document!), pagesContent(original));
  assert.deepEqual(new Set(reopened.getSnapshot().document!.deletedPages.map(page => page.id)), new Set([insertedId, copiedId]));
  for (let i = 0; i < 4; i++) assert.equal((await reopened.redo()).status, 'applied');
  assert.deepEqual(reopened.getSnapshot().document!.pages.map(page => page.id), [insertedId, pageId, original.pages[1].id]);
  assert.deepEqual(reopened.getSnapshot().document!.deletedPages.find(page => page.id === copiedId)!.annotations, copied.annotations);
});

test('PDF-backed notebook pages duplicate, move and remove; adjacent paper uses an explicit spec at exact PDF dimensions', async () => {
  const document = notebook(), source = document.pages[0];
  const dimensions = fixture.resource.metadata.pdfPages[4];
  source.widthPt = dimensions.widthPt; source.heightPt = dimensions.heightPt;
  source.background = { kind: 'pdf', resourceId: fixture.resource.metadata.id, sourceRevision: fixture.resource.metadata.sha256, pdfPage: 5 };
  const { session, pageId } = await setup(document);
  const copiedId = crypto.randomUUID(), copiedAnnotationIds = source.annotations.map(() => crypto.randomUUID());
  assert.equal((await session.buildDocumentEdit((document, id) => notebookDuplicate(document, pageId, copiedId, copiedAnnotationIds, id))).status, 'applied');
  assert.deepEqual(session.getSnapshot().document!.pages[1].background, source.background);
  assert.equal((await session.buildDocumentEdit(document => notebookMove(document, copiedId, 2))).status, 'applied');
  assert.equal((await session.buildDocumentEdit(document => notebookRemove(document, copiedId))).status, 'applied');
  assert.throws(() => notebookInsert(session.getSnapshot().document!, pageId, 'after', crypto.randomUUID(), crypto.randomUUID()), /paper-seed-required/);
  const insertedId = crypto.randomUUID();
  assert.equal((await session.buildDocumentEdit((document, id) => notebookInsert(document, pageId, 'after', insertedId, id, paper))).status, 'applied');
  const inserted = session.getSnapshot().document!.pages[1];
  assert.equal(inserted.id, insertedId);
  assert.equal(inserted.widthPt, dimensions.widthPt); assert.equal(inserted.heightPt, dimensions.heightPt);
  assert.deepEqual(inserted.background, { kind: 'paper', spec: paper });
  assert.deepEqual(inserted.annotations, []);
  assert.throws(() => notebookApplyPaper(document, pageId, 612, 792, paper, crypto.randomUUID()), /paper-background-required/);
});

test('builders reject last-page removal, invalid positions, reused IDs and the 500-page limit without mutating source', () => {
  const document = notebook(), pageId = document.pages[0].id, before = structuredClone(document);
  assert.throws(() => notebookRemove({ ...document, pages: [document.pages[0]] }, pageId), /notebook-last-page/);
  assert.throws(() => notebookMove(document, pageId, -1), /notebook-move-index/);
  assert.throws(() => notebookMove(document, pageId, 2), /notebook-move-index/);
  assert.deepEqual(notebookMove(document, pageId, 0), []);
  assert.throws(() => notebookDuplicate(document, pageId, crypto.randomUUID(), [], crypto.randomUUID()), /notebook-copy-annotation-ids/);
  assert.throws(() => notebookDuplicate(document, pageId, crypto.randomUUID(), document.pages[0].annotations.map(annotation => annotation.id), crypto.randomUUID()), /notebook-annotation-id-reused/);
  const removed = { ...document, deletedPages: [{ ...document.pages[0], id: crypto.randomUUID() }] };
  assert.throws(() => notebookInsert(removed, pageId, 'after', removed.deletedPages[0].id, crypto.randomUUID()), /notebook-page-id-reused/);
  const full = { ...document, pages: Array.from({ length: 500 }, (_, i) => ({ ...document.pages[0], id: i === 0 ? pageId : crypto.randomUUID(), annotations: [] })) };
  assert.throws(() => notebookInsert(full, pageId, 'after', crypto.randomUUID(), crypto.randomUUID()), /notebook-page-limit/);
  assert.throws(() => notebookDuplicate(full, pageId, crypto.randomUUID(), [], crypto.randomUUID()), /notebook-page-limit/);
  const inserted = replace(notebookInsert(document, pageId, 'after', crypto.randomUUID(), crypto.randomUUID(), { template: 'blank', color: 'white' }));
  assert.deepEqual(inserted.background, document.pages[0].background, 'existing paper is the authoritative template');
  assert.deepEqual(document, before);
});

test('portrait to landscape fit preserves physical annotation proportions, text metrics, stroke width and ordered quads', () => {
  const document = notebook(), source = document.pages[0], before = structuredClone(source), revision = crypto.randomUUID();
  assert.throws(() => notebookApplyPaper(document, source.id, 792, 612, paper, revision), /paper-content-overflow/);
  const fitted = replace(notebookApplyPaper(document, source.id, 792, 612, paper, revision, true));
  const scale = 17 / 22, xPadding = 1755 / 11;
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
  const ink = fitted.annotations[0], originalInk = source.annotations[0]; assert.ok(ink.kind === 'ink' && originalInk.kind === 'ink');
  assert.deepEqual(ink.geometry, originalInk.geometry); assert.deepEqual(ink.style, originalInk.style);
  close(ink.transform.x, 50 * scale + xPadding); close(ink.transform.y, 60 * scale);
  close(ink.transform.scaleX, 1.2 * scale); close(ink.transform.scaleY, .7 * scale);
  close(ink.style.widthPt * ink.transform.scaleX, 2.75 * 1.2 * scale);
  close(ink.style.widthPt * ink.transform.scaleY, 2.75 * .7 * scale);
  assert.equal(ink.transform.rotationRad, originalInk.transform.rotationRad);
  const highlight = fitted.annotations[1]; assert.ok(highlight.kind === 'highlight');
  assert.equal(highlight.backgroundRevision, revision);
  close(highlight.anchor.x, 480 * scale + xPadding); close(highlight.anchor.y, 710 * scale);
  const expected = [[450, 700], [590, 700], [590, 720], [450, 720]];
  for (const [i, point] of highlight.quads[0].entries()) { close(point.x, expected[i][0] * scale + xPadding); close(point.y, expected[i][1] * scale); }
  const originalHighlight = source.annotations[1]; assert.ok(originalHighlight.kind === 'highlight');
  assert.deepEqual(highlight.metadata, originalHighlight.metadata);
  assert.equal(highlight.quote, originalHighlight.quote);
  const sticky = fitted.annotations[2]; assert.ok(sticky.kind === 'sticky');
  close(sticky.anchor.x, 570 * scale + xPadding); close(sticky.anchor.y, 750 * scale);
  const text = fitted.annotations[3]; assert.ok(text.kind === 'ink' && text.geometry.kind === 'text');
  assert.deepEqual(text.geometry, source.annotations[3].kind === 'ink' ? source.annotations[3].geometry : null);
  close(text.transform.scaleX, 1.1 * scale); close(text.transform.scaleY, .9 * scale);
  assert.deepEqual(source, before, 'refusal and fitting never mutate their source');
});

test('explicit fit into larger custom bounds centers without enlarging strokes, text or highlight quads', () => {
  const document = notebook(), source = document.pages[0], revision = crypto.randomUUID();
  const centered = replace(notebookApplyPaper(document, source.id, 900, 1000, paper, revision, true));
  const physical = replace(notebookApplyPaper(document, source.id, 900, 1000, paper, revision));
  for (const [index, annotation] of centered.annotations.entries()) {
    const original = source.annotations[index], unchanged = physical.annotations[index];
    assert.equal(annotation.id, original.id);
    if (annotation.kind === 'ink' && original.kind === 'ink') {
      assert.deepEqual(annotation.geometry, original.geometry); assert.deepEqual(annotation.style, original.style);
      assert.deepEqual(annotation.transform, { ...original.transform, x: original.transform.x + 144, y: original.transform.y + 104 });
      assert.deepEqual(unchanged, original);
    } else if (annotation.kind === 'sticky' && original.kind === 'sticky') {
      assert.deepEqual(annotation, { ...original, anchor: { x: original.anchor.x + 144, y: original.anchor.y + 104 } }); assert.deepEqual(unchanged, original);
    } else if (annotation.kind === 'highlight' && original.kind === 'highlight') {
      assert.deepEqual(annotation, { ...original, backgroundRevision: revision,
        anchor: { x: original.anchor.x + 144, y: original.anchor.y + 104 },
        quads: original.quads.map(quad => quad.map(point => ({ x: point.x + 144, y: point.y + 104 }))) });
      assert.deepEqual(unchanged, { ...original, backgroundRevision: revision });
    } else assert.fail('annotation kind changed');
  }
});
