import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderSession, type ReaderStatePort, type SavedReaderState } from '../src/features/reader/ReaderSession.ts';
import { BrowserReaderStatePort } from '../src/adapters/browser/readerState.ts';
import type { DocumentSnapshot, Page } from '../src/runtime/edits/contracts.ts';
import { originalForTranslatedPage, translatedPage } from '../src/features/reader/readerSurfaceModel.ts';

const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const scope = { accountId: 'account', libraryId: id(1), epoch: 'epoch' }, documentId = id(2), a = id(3), b = id(4), c = id(5);
function harness(initial?: unknown) {
  let saved = initial, blocked = false, failWrite = false, writes = 0;
  const port: ReaderStatePort = { scope, read: () => saved, write: (_id, state) => { if (failWrite) throw new Error('storage-full'); saved = structuredClone(state); writes++; } };
  const open = () => new ReaderSession({ scope, documentId, persistence: port, canNavigate: () => !blocked });
  return { open, port, saved: () => saved as SavedReaderState, writes: () => writes, block: (value: boolean) => { blocked = value; }, fail: (value: boolean) => { failWrite = value; } };
}

function translatedDocument(): DocumentSnapshot {
  const page = (value: number, physical: number): Page => ({ id: id(value), backgroundRevision: id(value + 100),
    lifecycleVersion: id(value + 200), annotationVersion: id(value + 300), widthPt: 600, heightPt: 800,
    background: { kind: 'pdf', resourceId: id(500), sourceRevision: 'a'.repeat(64), pdfPage: physical }, annotations: [] });
  const pages = Array.from({ length: 7 }, (_, index) => page(index + 3, index + 1));
  const translations = [page(30, 5), page(31, 1), page(32, 9)];
  return { kind: 'document', id: documentId, version: id(600), pages, deletedPages: [],
    translation: { revision: id(601), pages: translations, bindings: [0, 2, 6].map((index, n) => ({
      original: { pageId: pages[index].id, backgroundRevision: pages[index].backgroundRevision },
      candidates: [{ pageId: translations[n].id, backgroundRevision: translations[n].backgroundRevision }],
    })) } };
}

test('a guarded editor placement handoff never admits page, display, zoom or history navigation', () => {
  const h = harness(); let navigating = true, reposition = false;
  const reader = new ReaderSession({ scope, documentId, persistence: h.port, canNavigate: () => navigating,
    canReposition: () => navigating || reposition });
  reader.reconcileDocument(translatedDocument()); reader.remember(a, { x: .2, y: .4 });
  const route = reader.getSnapshot(); navigating = false;
  assert.equal(reader.setPlacement('right'), false);
  reposition = true; assert.equal(reader.setPlacement('right'), true);
  assert.equal(reader.getSnapshot().pageId, route.pageId); assert.equal(reader.getSnapshot().activeSurface, route.activeSurface);
  assert.deepEqual(reader.getSnapshot().positions, route.positions);
  assert.equal(reader.jump(b), false); assert.equal(reader.setDisplay('split').status, 'blocked');
  assert.equal(reader.setZoom({ kind: 'scale', value: 2 }), false); assert.equal(reader.history('back'), false);
  assert.equal(reader.setPlacement('center'), true); reposition = false; assert.equal(reader.setPlacement('right'), false);
  reader.flush();
});

test('sparse translation paging uses original order and filter; explicit destinations clear filter only after admission', () => {
  const h = harness(), reader = h.open(), doc = translatedDocument(); reader.reconcileDocument(doc);
  assert.deepEqual(reader.setDisplay('split'), { status: 'applied' }); reader.setSurface('translated'); reader.setTranslatedOnly(true);
  assert.deepEqual(reader.navigationPageIds, [a, c, id(9)]);
  assert.equal(reader.step(1), true); assert.equal(reader.getSnapshot().pageId, c); assert.equal(reader.getSnapshot().surfacePageId, id(31));
  assert.equal(reader.resolvePage('translated')?.background.kind, 'pdf');
  reader.last(); assert.equal(reader.getSnapshot().pageId, id(9)); assert.equal(reader.getSnapshot().landing.toEnd, false);
  reader.first(); assert.equal(reader.getSnapshot().pageId, a); assert.equal(reader.getSnapshot().landing.toEnd, false);
  h.block(true); assert.equal(reader.jump(b), false); assert.equal(reader.getSnapshot().translatedOnly, true);
  h.block(false); assert.equal(reader.jump(b), true); assert.equal(reader.getSnapshot().translatedOnly, false);
  assert.equal(reader.getSnapshot().surfacePageId, null); assert.equal(reader.getSnapshot().translationStatus, 'missing');
  reader.setTranslatedOnly(true); assert.equal(reader.step(1), true); assert.equal(reader.getSnapshot().pageId, c); reader.flush();
});

test('surface positions, active zoom floor and translated citation history survive reload without confusing physical pages', () => {
  const h = harness(), reader = h.open(), doc = translatedDocument(); reader.reconcileDocument(doc);
  reader.remember(a, { x: .1, y: .2 }); reader.rememberSurface(id(30), { x: .7, y: .8 });
  reader.setViewport(a, { fitWidth: 100, fitPageWidth: 10, drawnWidth: 100 });
  reader.setViewport(id(30), { fitWidth: 100, fitPageWidth: 40, drawnWidth: 100 });
  assert.equal(reader.minimumZoom, .1); reader.setSurface('translated'); assert.equal(reader.minimumZoom, .4);
  assert.deepEqual(reader.getSnapshot().landing.place, { x: .7, y: .8 });
  reader.setSurface('original'); assert.deepEqual(reader.getSnapshot().landing.place, { x: .1, y: .2 });
  assert.equal(reader.jumpSurface('translated', id(31), { x: .3, y: .4 }, id(131)).status, 'applied');
  assert.equal(reader.getSnapshot().pageId, c); assert.equal(reader.getSnapshot().surfacePageId, id(31)); reader.flush();
  const restored = h.open(); restored.reconcileDocument(doc); assert.equal(restored.getSnapshot().activeSurface, 'translated');
  assert.deepEqual(restored.getSnapshot().landing.place, { x: .3, y: .4 });
  assert.equal(restored.history('back'), true); assert.equal(restored.getSnapshot().activeSurface, 'original');
  assert.equal(restored.history('forward'), true); assert.equal(restored.getSnapshot().surfacePageId, id(31)); restored.flush();
});

test('mapping replacement is guarded as a whole; annotation-only read model updates are admitted and stale anchors refused', () => {
  const h = harness(), reader = h.open(), doc = translatedDocument(); reader.reconcileDocument(doc);
  reader.jumpSurface('translated', id(30), { x: .4, y: .5 }, id(130)); reader.jump(c);
  h.block(true); const annotations = structuredClone(doc); annotations.pages[0].annotations.push({ kind: 'sticky', id: id(700),
    anchor: { x: 1, y: 2 }, text: 'pending', color: null, metadata: { label: '', createdAt: null } });
  assert.equal(reader.reconcileDocument(annotations), true); assert.equal(reader.documentModel?.pages[0].annotations.length, 1);
  const changed = structuredClone(doc); changed.translation!.pages[0].backgroundRevision = id(777);
  changed.translation!.bindings[0].candidates[0].backgroundRevision = id(777);
  assert.equal(reader.reconcileDocument(changed), false); assert.equal(reader.documentModel?.translation?.pages[0].backgroundRevision, id(130));
  h.block(false); assert.equal(reader.reconcileDocument(changed), true);
  const back = reader.getSnapshot().back; assert.equal(reader.history('back'), false); assert.equal(reader.getSnapshot().back, back);
  reader.flush();
});

test('ambiguous, stale and orphan translation mappings never fabricate routes; empty filter preserves original', () => {
  const doc = translatedDocument(), h = harness(), reader = h.open();
  doc.translation!.bindings[1].candidates = structuredClone(doc.translation!.bindings[0].candidates);
  assert.equal(translatedPage(doc, a).status, 'ambiguous'); assert.equal(translatedPage(doc, c).status, 'ambiguous');
  assert.deepEqual(originalForTranslatedPage(doc, id(30)), { status: 'unresolved', reason: 'translation-ambiguous' });
  reader.reconcileDocument(doc); assert.equal(reader.jumpSurface('translated', id(31)).status, 'blocked');
  doc.translation!.bindings = []; reader.reconcileDocument(doc); reader.setTranslatedOnly(true);
  const pageId = reader.getSnapshot().pageId; assert.deepEqual(reader.navigationPageIds, []);
  assert.equal(reader.step(1), false); assert.equal(reader.first(), false); assert.equal(reader.last(), false);
  assert.equal(reader.getSnapshot().pageId, pageId); reader.flush();
});

test('ordinary destinations clear both panes but surface and placement changes retain each pane position', () => {
  const h = harness(), reader = h.open(), doc = translatedDocument(); reader.reconcileDocument(doc);
  reader.rememberSurface(a, { x: .1, y: .2 }); reader.rememberSurface(id(30), { x: .4, y: .5 });
  reader.setSurface('translated'); reader.setPlacement('right'); reader.setSurface('original');
  assert.ok(reader.getSnapshot().positions[a]); assert.ok(reader.getSnapshot().positions[id(30)]);
  reader.jump(a, true); assert.equal(reader.getSnapshot().positions[a], undefined); assert.equal(reader.getSnapshot().positions[id(30)], undefined);
  reader.flush();
});

test('history outside the translated filter clears it only when the guarded move succeeds', () => {
  const h = harness(), reader = h.open(); reader.reconcileDocument(translatedDocument());
  reader.jump(b); reader.jump(c); reader.setTranslatedOnly(true);
  const before = reader.getSnapshot(); h.block(true);
  assert.equal(reader.history('back'), false); assert.equal(reader.getSnapshot(), before);
  h.block(false); assert.equal(reader.history('back'), true);
  assert.equal(reader.getSnapshot().pageId, b); assert.equal(reader.getSnapshot().translatedOnly, false); reader.flush();
});

test('enabling the translated filter moves an excluded route to the first result only after the guard', () => {
  const h = harness(), reader = h.open(); reader.reconcileDocument(translatedDocument()); reader.jump(b);
  h.block(true); const before = reader.getSnapshot();
  assert.equal(reader.setTranslatedOnly(true).status, 'blocked'); assert.equal(reader.getSnapshot(), before);
  h.block(false); assert.equal(reader.setTranslatedOnly(true).status, 'applied');
  assert.equal(reader.getSnapshot().pageId, a); assert.equal(reader.getSnapshot().translatedOnly, true); reader.flush();
});

test('a changed translated set waits for an explicit action after refusal and consumes no extra step', () => {
  for (const command of ['retry', 'step', 'first', 'last'] as const) {
    const h = harness(), reader = h.open(), document = translatedDocument(); reader.reconcileDocument(document); reader.setTranslatedOnly(true);
    const updated = structuredClone(document); updated.translation!.bindings = updated.translation!.bindings.slice(1);
    h.block(true); assert.equal(reader.reconcileDocument(updated), false);
    assert.equal(reader.getSnapshot().pageId, a); assert.equal(reader.getSnapshot().filterPending, true);
    assert.equal(reader.getSnapshot().filterCandidateCount, 2); assert.equal(reader.documentModel?.translation?.bindings.length, 3);
    h.block(false); assert.equal(reader.reconcileDocument(updated), false, 'guard release is not a navigation command');
    assert.equal(reader.getSnapshot().pageId, a);
    if (command === 'retry') assert.equal(reader.retryFilteredNavigation().status, 'applied');
    else if (command === 'step') assert.equal(reader.step(1), true);
    else assert.equal(reader[command](), true);
    assert.equal(reader.getSnapshot().pageId, c, 'explicit retry lands on first result once');
    assert.equal(reader.getSnapshot().filterPending, false); assert.equal(reader.documentModel?.translation?.bindings.length, 2);
    reader.flush();
  }
});

test('an admitted translated set change moves to its first result, while an empty set preserves the route', () => {
  const h = harness(), reader = h.open(), document = translatedDocument(); reader.reconcileDocument(document); reader.setTranslatedOnly(true);
  document.translation!.bindings = document.translation!.bindings.slice(1);
  assert.equal(reader.reconcileDocument(document), true); assert.equal(reader.getSnapshot().pageId, c);
  document.translation!.bindings = []; assert.equal(reader.reconcileDocument(document), true);
  assert.equal(reader.getSnapshot().pageId, c); assert.equal(reader.getSnapshot().filterPending, false); reader.flush();
});

test('initial hydration displays the restored page even when a pending editor blocks its filtered relocation', () => {
  const h = harness(), initial = h.open(), document = translatedDocument(); initial.reconcileDocument(document); initial.jump(b); initial.flush();
  const saved = structuredClone(h.saved()); saved.translatedOnly = true;
  const restoredHarness = harness(saved); restoredHarness.block(true); const reader = restoredHarness.open();
  assert.equal(reader.reconcileDocument(document), true, 'first document model is admitted for recovered editor display');
  assert.equal(reader.documentModel?.id, documentId); assert.equal(reader.resolvePage('original')?.id, b);
  assert.equal(reader.getSnapshot().pageId, b); assert.equal(reader.getSnapshot().filterPending, true);
  restoredHarness.block(false); assert.equal(reader.reconcileDocument(document), false);
  assert.equal(reader.getSnapshot().pageId, b); assert.equal(reader.retryFilteredNavigation().status, 'applied');
  assert.equal(reader.getSnapshot().pageId, a); assert.equal(reader.getSnapshot().filterPending, false); reader.flush();
});

test('recovered text drafts force their actual language surface despite navigation guard and keep split display', () => {
  for (const split of [false, true]) {
    const h = harness(), reader = h.open(), document = translatedDocument(); reader.reconcileDocument(document);
    if (split) reader.setDisplay('split');
    h.block(true); assert.equal(reader.reconcileDocument(document, id(31)), true);
    assert.equal(reader.getSnapshot().pageId, c); assert.equal(reader.getSnapshot().surfacePageId, id(31));
    assert.equal(reader.getSnapshot().activeSurface, 'translated'); assert.equal(reader.getSnapshot().display, split ? 'split' : 'translated');
    assert.equal(reader.reconcileDocument(document, a), true);
    assert.equal(reader.getSnapshot().surfacePageId, a); assert.equal(reader.getSnapshot().activeSurface, 'original');
    assert.equal(reader.getSnapshot().display, split ? 'split' : 'original'); reader.flush();
  }
  const h = harness(); h.block(true); const initial = h.open();
  assert.equal(initial.reconcileDocument(translatedDocument(), id(31)), true);
  assert.equal(initial.getSnapshot().activeSurface, 'translated'); assert.equal(initial.getSnapshot().surfacePageId, id(31)); initial.flush();
});

test('switching active surface normalizes scale to its cached floor even when metrics are unchanged', () => {
  const h = harness(), reader = h.open(); reader.reconcileDocument(translatedDocument());
  reader.setViewport(a, { fitWidth: 100, fitPageWidth: 10, drawnWidth: 20 });
  const translated = { fitWidth: 100, fitPageWidth: 50, drawnWidth: 50 };
  reader.setViewport(id(30), translated); reader.setZoom({ kind: 'scale', value: .2 });
  reader.setSurface('translated'); assert.deepEqual(reader.getSnapshot().zoom, { kind: 'fit-page' });
  assert.equal(reader.numericZoom, 0); assert.equal(reader.actualZoom, .5);
  reader.setViewport(id(30), translated); assert.deepEqual(reader.getSnapshot().zoom, { kind: 'fit-page' }); reader.flush();
});

test('numeric page input always clears translation filtering including in-set and same-page targets after guard', () => {
  const h = harness(), reader = h.open(); reader.reconcileDocument(translatedDocument()); reader.setTranslatedOnly(true);
  h.block(true); const before = reader.getSnapshot();
  assert.equal(reader.jumpLogicalPage(3).status, 'blocked'); assert.equal(reader.getSnapshot(), before);
  h.block(false); assert.equal(reader.jumpLogicalPage(3).status, 'applied');
  assert.equal(reader.getSnapshot().pageId, c); assert.equal(reader.getSnapshot().translatedOnly, false);
  reader.setTranslatedOnly(true); const history = reader.getSnapshot().back;
  assert.equal(reader.jumpLogicalPage(3).status, 'applied'); assert.equal(reader.getSnapshot().translatedOnly, false);
  assert.equal(reader.getSnapshot().back, history); reader.flush();
});

test('background-aware anchors retain their revision across remember, history and reload', () => {
  const h = harness(), session = h.open(), revisions = { [a]: id(10), [b]: id(11) };
  session.reconcile([a, b], undefined, revisions);
  session.remember(a, { x: .25, y: .3 });
  assert.deepEqual(session.getSnapshot().positions[a], { x: .25, y: .3, backgroundRevision: id(10) });
  assert.equal(session.jumpTo(b, { x: .7, y: .8 }, id(11)), true);
  assert.equal(session.getSnapshot().back[session.getSnapshot().back.length - 1]?.backgroundRevision, id(10));
  session.flush();
  assert.equal(h.saved().landing?.backgroundRevision, id(11));
  const restored = h.open(); restored.reconcile([a, b], undefined, revisions);
  assert.deepEqual(restored.getSnapshot().landing.place, { x: .7, y: .8 });
  assert.equal(restored.history('back'), true);
  assert.equal(restored.getSnapshot().landing.backgroundRevision, id(10));
  assert.equal(restored.history('forward'), true);
  assert.equal(restored.getSnapshot().landing.backgroundRevision, id(11)); restored.flush();
});

test('replacing a background resets stale positions and refuses old-revision history without consuming it', () => {
  const h = harness(), session = h.open();
  session.reconcile([a, b], undefined, { [a]: id(10), [b]: id(11) });
  session.jumpTo(a, { x: .2, y: .6 }); session.jump(b);
  session.remember(b, { x: .4, y: .5 });
  session.reconcile([a, b], undefined, { [a]: id(12), [b]: id(13) });
  assert.equal(session.getSnapshot().landing.place, null);
  assert.equal(session.getSnapshot().landing.backgroundRevision, id(13));
  assert.equal(session.getSnapshot().positions[b], undefined);
  const { back, forward, pageId, landing } = session.getSnapshot();
  assert.equal(session.history('back'), false);
  assert.equal(session.getSnapshot().back, back); assert.equal(session.getSnapshot().forward, forward);
  assert.equal(session.getSnapshot().pageId, pageId); assert.equal(session.getSnapshot().landing, landing);
  assert.match(session.getSnapshot().error, /background/);
  assert.equal(session.jumpTo(a, { x: .3, y: .4 }, id(10)), false);
  assert.equal(session.jump(a, false, id(10)), false);
  session.remember(b, { x: .8, y: .9, backgroundRevision: id(11) });
  assert.equal(session.getSnapshot().positions[b], undefined);
  assert.equal(session.jump(a, true), true);
  assert.equal(session.getSnapshot().landing.backgroundRevision, id(12));
  assert.equal(session.getSnapshot().landing.toEnd, true); session.flush();
});

test('unknown legacy anchors are not assigned a newly supplied background revision', () => {
  const h = harness(), legacy = h.open(); legacy.reconcile([a, b]);
  legacy.remember(a, { x: .2, y: .3 }); legacy.jumpTo(b, { x: .7, y: .8 }); legacy.flush();
  const restored = h.open(); restored.reconcile([a, b], undefined, { [a]: id(10), [b]: id(11) });
  assert.equal(restored.getSnapshot().landing.place, null);
  assert.deepEqual(restored.getSnapshot().positions, {});
  assert.equal(restored.history('back'), false);
  assert.equal(restored.jumpTo(a, { x: .1, y: .2 }), true);
  assert.equal(restored.getSnapshot().landing.backgroundRevision, id(10)); restored.flush();
  // A known landing must not lend its revision to an unrelated legacy position.
  const saved = structuredClone(h.saved());
  saved.positions[a] = { x: .9, y: .9 };
  const mixed = harness(saved).open(); mixed.reconcile([a, b], undefined, { [a]: id(10), [b]: id(11) });
  assert.equal(mixed.getSnapshot().landing.place, null); mixed.flush();
});

test('versioned commands reject malformed expectations and copy the background map', () => {
  const h = harness(), session = h.open(), revisions = { [a]: id(10), [b]: id(11) };
  session.reconcile([a, b], undefined, revisions); revisions[a] = id(12);
  assert.equal(session.jumpTo(a, { x: .5, y: .6 }, id(10)), true);
  for (const revision of ['', 'bad']) {
    assert.equal(session.jump(a, false, revision), false);
    assert.equal(session.jumpTo(a, { x: .7, y: .8 }, revision), false);
  }
  assert.equal(session.getSnapshot().landing.backgroundRevision, id(10)); session.flush();
  const saved = structuredClone(h.saved()); saved.landing!.backgroundRevision = 'bad';
  assert.match(harness(saved).open().getSnapshot().error, /invalid-reader-state/);
});

test('explicit anchor replaces stale positions, keeps same-page history and survives reload', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b]);
  session.remember(a, { x: .2, y: .3 });
  const anchor = { x: .7, y: .8 };
  assert.equal(session.jumpTo(a, anchor), true);
  assert.deepEqual(session.getSnapshot().landing.place, anchor);
  assert.equal(session.getSnapshot().positions[a], undefined);
  assert.equal(Object.isFrozen(anchor), false); anchor.y = .9;
  assert.equal(session.getSnapshot().landing.place?.y, .8);
  const snapshot = session.getSnapshot();
  assert.equal(session.jumpTo(a, { x: .7, y: .8 }), false); assert.equal(session.getSnapshot(), snapshot);
  session.flush();
  const restored = h.open(); restored.reconcile([a, b]);
  assert.deepEqual(restored.getSnapshot().landing.place, { x: .7, y: .8 });
  assert.equal(restored.history('back'), true); assert.deepEqual(restored.getSnapshot().landing.place, { x: .2, y: .3 });
  assert.equal(restored.history('forward'), true); assert.deepEqual(restored.getSnapshot().landing.place, { x: .7, y: .8 });
  restored.history('back'); restored.jumpTo(b, { x: .5, y: .6 });
  assert.equal(restored.getSnapshot().pageId, b); assert.equal(restored.getSnapshot().landing.toEnd, false);
  assert.equal(restored.history('forward'), false); restored.flush();
});

test('anchor rejection leaves state and persistence unchanged; top/end jumps still clear anchors', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b]); session.flush();
  const snapshot = session.getSnapshot(), writes = h.writes();
  h.block(true); assert.equal(session.jumpTo(b, { x: .3, y: .4 }), false); h.block(false);
  assert.equal(session.jumpTo(c, { x: .3, y: .4 }), false);
  for (const at of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: -Infinity, y: 0 }]) assert.equal(session.jumpTo(a, at), false);
  assert.equal(session.getSnapshot(), snapshot); session.flush(); assert.equal(h.writes(), writes);
  // ReadingPlace accepts finite positions; physical page-bound validation belongs to the resolver.
  assert.equal(session.jumpTo(b, { x: -.1, y: 1.1 }), true);
  assert.equal(session.jump(b, true), true); assert.equal(session.getSnapshot().landing.place, null);
  assert.equal(session.getSnapshot().landing.toEnd, true); assert.equal(session.jump(b, true), false);
  assert.equal(session.jump(b), true); assert.equal(session.getSnapshot().landing.toEnd, false); session.flush();
});

test('reload restores the logical page, continuous zoom, placement, positions and location history', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b, c]);
  session.remember(a, { x: .5, y: .3 }); session.jump(b); session.remember(b, { x: .6, y: .7 });
  session.setZoom({ kind: 'scale', value: .075 }); session.setPlacement('right'); session.flush();
  assert.equal(h.writes(), 1);
  const restored = h.open(); restored.reconcile([a, b, c]);
  assert.equal(restored.getSnapshot().pageId, b); assert.deepEqual(restored.getSnapshot().zoom, { kind: 'scale', value: .075 });
  assert.equal(restored.getSnapshot().placement, 'right'); assert.deepEqual(restored.getSnapshot().landing.place, { x: .6, y: .7 });
  assert.equal(restored.history('back'), true); assert.equal(restored.getSnapshot().pageId, a);
  assert.deepEqual(restored.getSnapshot().landing.place, { x: .5, y: .3 });
  restored.history('forward'); assert.deepEqual(restored.getSnapshot().landing.place, { x: .6, y: .7 }); restored.flush();
});

test('reorder preserves ID, deletion falls back to old index, and held draft reconciliation bypasses the user guard', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b, c]); session.jump(b);
  session.reconcile([c, a, b]); assert.equal(session.getSnapshot().pageId, b);
  session.reconcile([c, a]); assert.equal(session.getSnapshot().pageId, a);
  h.block(true);
  assert.equal(session.jump(c), false); assert.equal(session.setZoom({ kind: 'scale', value: 2 }), false); assert.equal(session.setPlacement('right'), false);
  session.reconcile([c, a], c); assert.equal(session.getSnapshot().pageId, c);
  session.flush(); const writes = h.writes(); session.reconcile([]); session.flush();
  assert.equal(session.getSnapshot().pageId, c); assert.equal(h.writes(), writes);
});

test('fit uses real viewport ratios, supports values below .1, ignores stale reports and clamps at the actual floor', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b]);
  session.setViewport(a, { fitWidth: 1000, fitPageWidth: 40, drawnWidth: 40 });
  assert.equal(session.actualZoom, .04); assert.equal(session.minimumZoom, .04); assert.equal(session.numericZoom, 0);
  session.zoomBy(1); assert.deepEqual(session.getSnapshot().zoom, { kind: 'scale', value: .05 });
  session.zoomBy(1); assert.equal(session.numericZoom, .0625);
  session.setZoom({ kind: 'scale', value: .03 }); assert.deepEqual(session.getSnapshot().zoom, { kind: 'fit-page' });
  session.setViewport(a, { fitWidth: 1000, fitPageWidth: 60, drawnWidth: 60 }); assert.equal(session.actualZoom, .06);
  session.setZoom({ kind: 'scale', value: 100 }); assert.equal(session.numericZoom, 4); assert.equal(session.zoomBy(1), false);
  session.jump(b); session.setViewport(a, { fitWidth: 1000, fitPageWidth: 999, drawnWidth: 999 }); assert.equal(session.minimumZoom, 0);
  session.setZoom({ kind: 'scale', value: .02 });
  session.setViewport(b, { fitWidth: 1000, fitPageWidth: 50, drawnWidth: 50 }); assert.deepEqual(session.getSnapshot().zoom, { kind: 'fit-page' });
  session.flush();
});

test('history restores places while explicit jumps retain top/end intent', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b]);
  session.remember(a, { x: .4, y: .42 }); session.jump(b, true);
  assert.equal(session.getSnapshot().pageId, b); assert.equal(session.getSnapshot().landing.toEnd, true); assert.equal(session.getSnapshot().landing.place, null);
  session.history('back'); assert.deepEqual(session.getSnapshot().landing.place, { x: .4, y: .42 });
  session.history('forward'); assert.equal(session.getSnapshot().landing.toEnd, true); assert.equal(session.getSnapshot().landing.place, null);
  session.jump(a); assert.equal(session.getSnapshot().landing.toEnd, false); assert.equal(session.getSnapshot().landing.place, null);
  assert.equal(session.history('forward'), false);
  session.remember(a, { x: .5, y: .2 }); session.setPlacement('right'); assert.deepEqual(session.getSnapshot().landing.place, { x: .5, y: .2 });
  session.flush();
});

test('reload preserves explicit page-end landing before a user scroll position is recorded', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b]);
  session.step(1, true); session.flush();
  assert.deepEqual(h.saved().landing, { toEnd: true, place: null });
  const restored = h.open(); restored.reconcile([a, b]);
  assert.equal(restored.getSnapshot().pageId, b);
  assert.deepEqual(restored.getSnapshot().landing, { id: 0, toEnd: true, place: null });
  restored.setPlacement('right'); assert.equal(restored.getSnapshot().landing.toEnd, true);
  restored.remember(b, { x: .5, y: .72 }); restored.flush();
  const scrolled = h.open(); scrolled.reconcile([a, b]);
  assert.deepEqual(scrolled.getSnapshot().landing.place, { x: .5, y: .72 });
  scrolled.jump(a); scrolled.flush();
  const top = h.open(); top.reconcile([a, b]);
  assert.equal(top.getSnapshot().landing.toEnd, false); assert.equal(top.getSnapshot().landing.place, null);
});

test('earlier v1 records without landing retain saved positions, while malformed landing is rejected', () => {
  const saved: SavedReaderState = { version: 1, pageId: b, zoom: { kind: 'fit-page' }, placement: 'center', positions: { [b]: { x: .5, y: .4 } }, back: [], forward: [] };
  const h = harness(saved), session = h.open(); session.reconcile([a, b]);
  assert.equal(session.getSnapshot().error, ''); assert.deepEqual(session.getSnapshot().landing.place, saved.positions[b]);
  for (const landing of [{ toEnd: 'true', place: null }, { toEnd: true, place: { x: 0, y: NaN } }, null])
    assert.match(harness({ ...saved, landing }).open().getSnapshot().error, /invalid-reader-state/);
});

test('write failure retains state and retries without blocking editing or reverting navigation', () => {
  const h = harness(), session = h.open(); session.reconcile([a, b]); h.fail(true);
  session.jump(b); session.flush(); assert.match(session.getSnapshot().error, /storage-full/); assert.equal(session.getSnapshot().pageId, b);
  assert.equal(session.setZoom({ kind: 'scale', value: 2 }), true);
  h.fail(false); session.flush(); assert.equal(session.getSnapshot().error, ''); assert.equal(h.saved().pageId, b); assert.deepEqual(h.saved().zoom, { kind: 'scale', value: 2 });
});

test('malformed and failed loads retain raw data until a user changes reading state', () => {
  const invalid = { version: 1, pageId: a, zoom: { kind: 'scale', value: NaN }, placement: 'center', positions: {}, back: [], forward: [] };
  const h = harness(invalid), session = h.open(); assert.match(session.getSnapshot().error, /invalid-reader-state/);
  session.reconcile([a, b]); session.setViewport(a, { fitWidth: 100, fitPageWidth: 50, drawnWidth: 50 }); session.flush();
  assert.equal(h.writes(), 0); assert.equal(h.saved(), invalid);
  session.jump(b); session.flush(); assert.equal(h.writes(), 1); assert.equal(session.getSnapshot().error, '');
  const failing = new ReaderSession({ scope, documentId, persistence: { scope, read: () => { throw new Error('access-denied'); }, write: () => { throw new Error('must-not-write'); } }, canNavigate: () => true });
  assert.match(failing.getSnapshot().error, /access-denied/); failing.reconcile([a]); failing.flush(); assert.match(failing.getSnapshot().error, /access-denied/);
});

test('state validation bounds history and verifies IDs, positions and typed zoom', () => {
  const valid: SavedReaderState = { version: 1, pageId: a, zoom: { kind: 'fit-page' }, placement: 'center', positions: {}, back: [], forward: [] };
  for (const bad of [{ ...valid, pageId: 'legacy-page' }, { ...valid, zoom: { kind: 'scale', value: 0 } },
    { ...valid, positions: { [a]: { x: .2, y: Infinity } } }, { ...valid, back: Array.from({ length: 101 }, () => ({ pageId: b, toEnd: false, place: null })) }])
    assert.match(harness(bad).open().getSnapshot().error, /invalid-reader-state/);
  const h = harness(), session = h.open(); session.reconcile([a, b]);
  for (let i = 0; i < 110; i++) session.jump(i % 2 ? a : b);
  assert.equal(session.getSnapshot().back.length, 100); session.flush(); assert.equal(h.saved().back.length, 100);
});

test('browser storage is partitioned by account, library, epoch and document; scope mismatches fail', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const adapter = new BrowserReaderStatePort(scope, storage);
  const session = new ReaderSession({ scope, documentId, persistence: adapter, canNavigate: () => true }); session.reconcile([a]); session.flush();
  assert.equal(values.size, 1); assert.equal(new BrowserReaderStatePort({ ...scope, accountId: 'other' }, storage).read(documentId), null);
  assert.equal(new BrowserReaderStatePort({ ...scope, libraryId: id(99) }, storage).read(documentId), null);
  assert.equal(new BrowserReaderStatePort({ ...scope, epoch: 'next' }, storage).read(documentId), null); assert.equal(adapter.read(id(99)), null);
  assert.throws(() => new ReaderSession({ scope: { ...scope, accountId: 'other' }, documentId, persistence: adapter, canNavigate: () => true }), /reader-state-scope/);
});

test('reading-state writes debounce and flushing while unloaded persists the last valid pending position', async () => {
  const h = harness(), session = h.open(); session.reconcile([a]);
  session.remember(a, { x: .5, y: .1 }); session.remember(a, { x: .5, y: .2 }); assert.equal(h.writes(), 0);
  await new Promise(resolve => setTimeout(resolve, 190)); assert.equal(h.writes(), 1); assert.equal(h.saved().positions[a].y, .2);
  session.remember(a, { x: .5, y: .3 }); session.reconcile([]); session.flush(); assert.equal(h.saved().positions[a].y, .3);
});


test('ordinary paging preserves back history, clears future only on success, and keeps versioned top/end intent', () => {
  const h = harness(), session = h.open();
  session.reconcile([a, b, c], undefined, { [a]: id(10), [b]: id(11), [c]: id(12) });
  session.jump(b); session.jump(c); session.history('back');
  const back = session.getSnapshot().back;
  const before = session.getSnapshot();
  h.block(true); assert.equal(session.step(1, true), false); assert.equal(session.getSnapshot(), before);
  h.block(false); assert.equal(session.step(1, true), true);
  assert.equal(session.getSnapshot().back, back); assert.deepEqual(session.getSnapshot().forward, []);
  assert.equal(session.getSnapshot().landing.toEnd, true);
  assert.equal(session.getSnapshot().landing.backgroundRevision, id(12));
  const end = session.getSnapshot(); assert.equal(session.step(1), false); assert.equal(session.getSnapshot(), end);
  assert.equal(session.step(-1), true); assert.equal(session.getSnapshot().landing.toEnd, false);
  assert.equal(session.getSnapshot().landing.backgroundRevision, id(11));
  assert.equal(session.getSnapshot().back, back);
  session.flush(); const restored = h.open(); restored.reconcile([a, b, c]);
  assert.deepEqual(restored.getSnapshot().back, back); assert.deepEqual(restored.getSnapshot().forward, []);
  assert.equal(restored.history('back'), true); assert.equal(restored.getSnapshot().pageId, a);
  restored.flush();
});
