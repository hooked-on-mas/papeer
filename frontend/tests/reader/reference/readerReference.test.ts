import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderSession } from '../../../src/features/reader/ReaderSession.ts';
import { referenceTarget } from '../../../src/features/reader/reference/readerReference.ts';
import type { DocumentSnapshot, Page } from '../../../src/runtime/edits/contracts.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { accountId: 'account', libraryId: id(1), epoch: 'epoch' };
const page = (n: number): Page => ({ id: id(n), backgroundRevision: id(n + 100), lifecycleVersion: id(n + 200),
  annotationVersion: id(n + 300), widthPt: 600, heightPt: 800,
  background: { kind: 'paper', spec: { template: 'blank', color: 'white' } }, annotations: [] });
function setup() {
  let blocked = false, saved: unknown;
  const reader = new ReaderSession({ scope, documentId: id(2), persistence: { scope, read: () => saved, write: (_id, value) => { saved = value; } }, canNavigate: () => !blocked });
  const doc: DocumentSnapshot = { kind: 'document', id: id(2), version: id(9), pages: [page(3), page(4)], deletedPages: [] };
  reader.reconcileDocument(doc);
  return { reader, doc, block: (v: boolean) => { blocked = v; }, saved: () => saved };
}
test('pin is atomic, guarded, preserves main route and is ephemeral', () => {
  const h = setup(), r = h.reader, target = referenceTarget('original', h.doc.pages[0]);
  const before = r.getSnapshot(); h.block(true);
  assert.equal(r.pinCurrentReference(target).status, 'blocked'); assert.equal(r.getSnapshot(), before);
  h.block(false); assert.equal(r.pinCurrentReference(target).status, 'applied');
  assert.equal(r.getSnapshot().placement, 'right'); assert.equal(r.getSnapshot().pageId, before.pageId);
  assert.deepEqual(r.getSnapshot().back, before.back); assert.equal(r.step(1), true);
  assert.equal(r.resolveReference().status, 'ready'); assert.equal(r.getSnapshot().reference.target?.pageId, target.pageId);
  r.flush(); assert.equal('reference' in (h.saved() as object), false);
});
test('identity invalidation never falls back and same-page replacement preserves position', () => {
  const h = setup(), r = h.reader, target = referenceTarget('original', h.doc.pages[0]);
  r.pinCurrentReference(target);
  const expected = { target, targetGeneration: r.getSnapshot().reference.targetGeneration, paneInstance: {}, pointerLease: {} };
  assert.equal(r.registerReferenceLayout(expected, { layoutMeasurementGeneration: 1, paneWidth: 500, paneHeight: 600, dpr: 1, zoom: { kind: 'fit-page' } }), true);
  assert.equal(r.rememberReference(expected, { x: .3, y: .4 }), true);
  assert.equal(r.pinCurrentReference(target).status, 'unchanged'); assert.equal(r.getSnapshot().reference.place?.y, .4);
  const updated = structuredClone(h.doc); updated.pages[0].lifecycleVersion = id(900); r.reconcileDocument(updated);
  assert.equal(r.resolveReference().status, 'unavailable'); assert.equal(r.rememberReference(expected, { x: 0, y: 0 }), false);
});
test('old measurements cannot become current after A-B-A resize', () => {
  const h = setup(), r = h.reader, target = referenceTarget('original', h.doc.pages[0]); r.pinCurrentReference(target);
  const expected = { target, targetGeneration: r.getSnapshot().reference.targetGeneration, paneInstance: {}, pointerLease: {} };
  const make = (gen: number, width: number) => ({ layoutMeasurementGeneration: gen, paneWidth: width, paneHeight: 600, dpr: 1, zoom: { kind: 'fit-page' } as const });
  const metrics = { fitWidth: 500, fitPageWidth: 300, drawnWidth: 300 };
  r.registerReferenceLayout(expected, make(1, 500)); r.registerReferenceLayout(expected, make(2, 400)); r.registerReferenceLayout(expected, make(3, 500));
  assert.equal(r.setReferenceViewport({ expected, ...make(1, 500), requestedZoom: { kind: 'fit-page' }, metrics }), false);
  assert.equal(r.setReferenceViewport({ expected, ...make(3, 500), requestedZoom: { kind: 'fit-page' }, metrics }), true);
});

 test('pending annotation projection shares only matching page identity', async () => {
  const { projectReferenceAnnotations } = await import('../../../src/features/reader/reference/readerReference.ts');
  const h = setup(), pending = structuredClone(h.doc), accepted = h.doc.pages[0];
  pending.pages[0].annotations.push({ kind: 'sticky', id: id(700), anchor: { x: 1, y: 2 }, text: 'pending', color: null, metadata: { label: '', createdAt: null } });
  assert.equal(projectReferenceAnnotations(accepted, pending, true, 'original').annotations.length, 1);
  pending.pages[0].lifecycleVersion = id(999);
  assert.equal(projectReferenceAnnotations(accepted, pending, true, 'original'), accepted);
});
