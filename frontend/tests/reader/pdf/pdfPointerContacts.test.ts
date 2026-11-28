import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drainPdfPointerScope, pdfPointerDownDisposition, pdfPointerScopeIsDraining, pdfPointerTargetBelongsToPane,
  settlePdfPointerContact, releasePdfPointerCapture, drainPdfPointerAfterCaptureLoss,
  isPdfPointerPhysicalTerminal, canContinueSamePanePinch, transferPdfFingerToPinch, type PdfPointerContactFacts, type PdfPointerPhase } from '../../../src/features/reader/pdf/pdfTextGesture.ts';

type Contact = PdfPointerContactFacts & { ending: boolean; capturedByHook: boolean; timer: boolean; range: boolean; swipe: boolean };
const contact = (phase: PdfPointerPhase, pointerType = 'touch', admittedInk = false): Contact => ({
  phase, pointerType, ownsInk: () => admittedInk, ending: false, capturedByHook: false,
  timer: phase === 'text-pending', range: phase === 'text-selecting', swipe: phase === 'pan',
});
const cancel = (contacts: ReadonlyMap<number, Contact>) => {
  for (const item of contacts.values()) { item.timer = false; item.range = false; item.swipe = false; }
};
test('second same-pane finger cancels only the admitted finger preview before pinch continuation', () => {
  let active = true, canceled = 0;
  const first = { ...contact('raw'), ownsInk: () => active }, second = contact('raw');
  const panes = new Map([['pane', new Map([[1, first], [2, second]])]]);
  assert.equal(transferPdfFingerToPinch(panes, 'pane', 2, () => true, id => { assert.equal(id, 1); active = false; canceled++; return true; }), true);
  assert.equal(canceled, 1); assert.equal(first.phase, 'pan-pending');
  assert.equal(canContinueSamePanePinch(panes, 'pane', 2, () => true), true);
});
test('finger takeover rejects stale, cross-pane and pen ownership', () => {
  const cancelTouch = () => { throw new Error('must not cancel'); };
  const first = contact('raw', 'touch', true), second = contact('raw');
  assert.equal(transferPdfFingerToPinch(new Map([['a', new Map([[1, first]])], ['b', new Map([[2, second]])]]), 'b', 2, () => true, cancelTouch), false);
  assert.equal(transferPdfFingerToPinch(new Map([['a', new Map([[1, first], [2, second]])]]), 'a', 2, () => false, cancelTouch), false);
  const pen = contact('raw', 'pen', true);
  assert.equal(transferPdfFingerToPinch(new Map([['a', new Map([[1, pen], [2, second]])]]), 'a', 2, () => true, cancelTouch), false);
});
test('scope drain cancels touch ink while preserving an admitted pen', () => {
  const canceled: number[] = [];
  const finger = { ...contact('raw', 'touch', true), cancelTouchInk: (id: number) => canceled.push(id) };
  const pen = { ...contact('raw', 'pen', true), cancelTouchInk: (id: number) => canceled.push(id) };
  const panes = new Map([['left', new Map([[1, finger]])], ['right', new Map([[2, pen]])]]);
  drainPdfPointerScope(panes, () => {});
  assert.deepEqual(canceled, [1]); assert.equal(finger.phase, 'drain'); assert.equal(pen.phase, 'raw');
});
test('raw second touch is eligible to pass capture only for an existing same-pane reading phase', () => {
  for (const phase of ['text-pending', 'text-selecting', 'pan-pending', 'pan'] as const) {
    const contacts = new Map([[1, contact(phase)], [2, contact('raw')]]), panes = new Map([['pane', contacts]]);
    assert.equal(pdfPointerDownDisposition(panes, 'pane', 2), 'pass');
    assert.equal(canContinueSamePanePinch(panes, 'pane', 2, () => true), true);
  }
});
test('same-pane continuation rejects stale facts, other panes, pen, palms, Ink and drain', () => {
  for (const first of [contact('raw'), contact('drain'), contact('palm'), contact('pinch'), contact('pan', 'pen'), contact('pan', 'touch', true)]) {
    const panes = new Map([['pane', new Map([[1, first], [2, contact('raw')]])]]);
    assert.equal(canContinueSamePanePinch(panes, 'pane', 2, () => true), false);
  }
  const local = new Map([[1, contact('text-pending')], [2, contact('raw')]]), panes = new Map([['pane', local]]);
  assert.equal(canContinueSamePanePinch(panes, 'pane', 2, () => false), false);
  assert.equal(canContinueSamePanePinch(new Map([['pane', new Map([[1, contact('pan')]])], ['other', new Map([[2, contact('raw')]])]]), 'other', 2, () => true), false);
  local.set(3, contact('raw')); assert.equal(pdfPointerDownDisposition(panes, 'pane', 3), 'drain');
  drainPdfPointerScope(panes, cancel); assert.equal(canContinueSamePanePinch(panes, 'pane', 3, () => true), false);
  for (const id of [1, 2, 3]) settlePdfPointerContact(local, id, () => {});
  local.set(4, contact('pan-pending')); local.set(5, contact('raw'));
  assert.equal(canContinueSamePanePinch(panes, 'pane', 5, () => true), true);
});
test('cross-pane second down cancels every reading candidate before any pane callback can re-enter', () => {
  for (const phase of ['text-pending', 'text-selecting', 'pan-pending', 'pan', 'pinch'] as const) {
    const left = new Map([[1, contact(phase)]]), right = new Map([[2, contact('raw', 'pen')]]);
    const panes = new Map([['left', left], ['right', right]]);
    assert.equal(pdfPointerDownDisposition(panes, 'right', 2), 'drain');
    let callbacks = 0;
    drainPdfPointerScope(panes, inventory => {
      callbacks++;
      assert.equal(left.get(1)?.phase, 'drain'); assert.equal(right.get(2)?.phase, 'drain');
      cancel(inventory);
    });
    assert.equal(callbacks, 2); assert.equal(left.get(1)?.timer, false);
    assert.equal(left.get(1)?.range, false); assert.equal(left.get(1)?.swipe, false);
  }
});
test('second contact ending immediately cannot revive the first timer or gesture; replacements drain until all up', () => {
  const left = new Map([[1, contact('text-pending')]]), right = new Map([[2, contact('raw')]]);
  const panes = new Map([['pdf', left], ['paper', right]]);
  drainPdfPointerScope(panes, cancel);
  settlePdfPointerContact(right, 2, () => {});
  assert.equal(left.get(1)?.phase, 'drain'); assert.equal(left.get(1)?.timer, false);
  assert.equal(pdfPointerScopeIsDraining(panes), true);
  right.set(3, contact('raw', 'pen'));
  assert.equal(pdfPointerDownDisposition(panes, 'paper', 3), 'drain'); drainPdfPointerScope(panes, cancel);
  settlePdfPointerContact(left, 1, () => {});
  assert.equal(pdfPointerScopeIsDraining(panes), true);
  settlePdfPointerContact(right, 3, () => {});
  assert.equal(pdfPointerScopeIsDraining(panes), false);
  left.set(4, contact('raw'));
  assert.equal(pdfPointerDownDisposition(panes, 'pdf', 4), 'pass');
});
test('touch/pen orders and PDF/paper pane names do not create cross-pane pinch', () => {
  for (const [first, second] of [['touch', 'touch'], ['touch', 'pen'], ['pen', 'touch'], ['pen', 'pen']]) {
    for (const names of [['pdf', 'pdf-reference'], ['pdf', 'paper'], ['paper', 'pdf'], ['paper', 'paper-reference']]) {
      const left = new Map([[1, contact('text-selecting', first)]]), right = new Map([[2, contact('raw', second)]]);
      const panes = new Map([[names[0], left], [names[1], right]]);
      assert.equal(pdfPointerDownDisposition(panes, names[1], 2), 'drain');
      drainPdfPointerScope(panes, cancel);
      assert.equal(left.get(1)?.phase, 'drain'); assert.equal(right.get(2)?.phase, 'drain');
    }
  }
});
test('admitted Ink pen survives cross-pane contact without a cancel/commit/owner transfer', () => {
  const owner = contact('raw', 'pen', true), secondary = contact('raw', 'touch');
  const left = new Map([[1, owner]]), right = new Map([[2, secondary]]);
  const panes = new Map([['left', left], ['right', right]]);
  let inkTerminals = 0;
  assert.equal(pdfPointerDownDisposition(panes, 'right', 2), 'drain');
  drainPdfPointerScope(panes, cancel);
  assert.equal(owner.phase, 'raw'); assert.equal(owner.ownsInk(), true); assert.equal(secondary.phase, 'drain');
  // The owner alone receives its existing normal terminal; the secondary remains drain.
  settlePdfPointerContact(left, 1, () => { inkTerminals++; });
  assert.equal(inkTerminals, 1); assert.equal(pdfPointerScopeIsDraining(panes), true);
  right.set(3, contact('raw', 'pen'));
  assert.equal(pdfPointerDownDisposition(panes, 'right', 3), 'drain');
});
test('admitted Ink owner remains protected when three same-pane touches arrive', () => {
  const ink = contact('raw', 'pen', true), panes = new Map([['pane', new Map([[1, ink]])]]);
  const contacts = panes.get('pane')!;
  for (const id of [2, 3, 4]) {
    const touch = contact('raw'); contacts.set(id, touch);
    assert.equal(pdfPointerDownDisposition(panes, 'pane', id), 'palm'); touch.phase = 'palm';
  }
  assert.equal(ink.ownsInk(), true); assert.equal(ink.phase, 'raw');
  assert.equal(canContinueSamePanePinch(panes, 'pane', 4, () => true), false);
});
test('raw phantom pen is no Ink owner; same-pane admitted pen plus touch is palm, later pen is suppressed', () => {
  const phantom = contact('text-selecting', 'pen', false);
  const left = new Map([[1, phantom]]), right = new Map([[2, contact('raw')]]);
  drainPdfPointerScope(new Map([['left', left], ['right', right]]), cancel);
  assert.equal(phantom.phase, 'drain');
  const ownerPane = new Map([[1, contact('raw', 'pen', true)], [2, contact('raw', 'touch')]]);
  const panes = new Map([['same', ownerPane]]);
  assert.equal(pdfPointerDownDisposition(panes, 'same', 2), 'palm');
  ownerPane.delete(2); ownerPane.set(3, contact('raw', 'pen'));
  assert.equal(pdfPointerDownDisposition(panes, 'same', 3), 'drain');
});
test('an admitted owner terminal leaves any same-pane palm in drain rather than promoting it', () => {
  const contacts = new Map([[1, contact('raw', 'pen', true)], [2, contact('palm', 'touch')]]);
  const panes = new Map([['same', contacts]]);
  settlePdfPointerContact(contacts, 1, () => { drainPdfPointerScope(panes, cancel); });
  assert.equal(contacts.get(2)?.phase, 'drain');
  contacts.set(3, contact('raw', 'pen'));
  assert.equal(pdfPointerDownDisposition(panes, 'same', 3), 'drain');
});
test('reading touch cannot be interrupted by a new pen, and another Reader is independent', () => {
  const local = new Map([[1, contact('text-pending')], [2, contact('raw', 'pen')]]);
  assert.equal(pdfPointerDownDisposition(new Map([['same', local]]), 'same', 2), 'drain');
  const other = new Map([[3, contact('raw', 'pen')]]);
  assert.equal(pdfPointerDownDisposition(new Map([['other-reader', other]]), 'other-reader', 3), 'pass');
  assert.equal(local.get(1)?.phase, 'text-pending');
});
test('portal target needs actual same Reader, exact current pane/controller and no foreign physical pane', () => {
  const pane = {}, otherPane = {}, reader = {}, otherReader = {};
  const facts = { pane, currentPane: pane, connected: true, scope: reader, targetScope: reader,
    containsTarget: false, scopeContainsTarget: true, physicalPane: null, ownHandle: true };
  assert.equal(pdfPointerTargetBelongsToPane(facts), true);
  for (const changed of [{ currentPane: otherPane }, { connected: false }, { targetScope: otherReader },
    { scopeContainsTarget: false }, { physicalPane: otherPane }, { ownHandle: false }])
    assert.equal(pdfPointerTargetBelongsToPane({ ...facts, ...changed }), false);
  assert.equal(pdfPointerTargetBelongsToPane({ ...facts, containsTarget: true, physicalPane: pane, ownHandle: false }), true);
});
test('raw external Ink capture is untouched; only hook-owned capture is released once before re-entry', () => {
  let releases = 0;
  const external = { capturedByHook: false, pane: { hasPointerCapture: () => true, releasePointerCapture() { releases++; } } };
  releasePdfPointerCapture(external, 1); assert.equal(releases, 0);
  const owned = { capturedByHook: true, pane: { hasPointerCapture: () => true,
    releasePointerCapture() { releases++; assert.equal(owned.capturedByHook, false); releasePdfPointerCapture(owned, 2); } } };
  releasePdfPointerCapture(owned, 2); assert.equal(releases, 1);
  releasePdfPointerCapture(owned, 2); assert.equal(releases, 1);
});
test('unexpected capture loss keeps still-down raw/contact guard/drain until one real up or cancel', () => {
  for (const phase of ['text-pending', 'text-selecting', 'pan', 'pinch'] as const) {
    for (const terminal of ['pointerup', 'pointercancel']) {
      const held = contact(phase); held.capturedByHook = true;
      const inventory = new Map([[1, held]]), panes = new Map([['pane', inventory]]);
      let cancellations = 0, terminals = 0;
      const lost = () => drainPdfPointerAfterCaptureLoss(inventory, 1, () => {
        cancellations++; drainPdfPointerScope(panes, cancel);
      });
      assert.equal(lost(), true); assert.equal(lost(), false);
      assert.equal(inventory.size, 1, terminal); assert.equal(inventory.has(1), true);
      assert.equal(pdfPointerScopeIsDraining(panes), true); assert.equal(held.timer, false); assert.equal(held.range, false);
      assert.equal(held.capturedByHook, false); assert.equal(cancellations, 1);
      assert.equal(isPdfPointerPhysicalTerminal('lostpointercapture'), false);
      assert.equal(isPdfPointerPhysicalTerminal(terminal), true);
      assert.equal(settlePdfPointerContact(inventory, 1, () => { terminals++; }), true);
      assert.equal(settlePdfPointerContact(inventory, 1, () => { terminals++; }), false);
      assert.equal(terminals, 1); assert.equal(inventory.size, 0); assert.equal(pdfPointerScopeIsDraining(panes), false);
    }
  }
});
test('pinch capture transfer retains both contacts and the remaining guard through staggered terminals', () => {
  const first = contact('pinch'), second = contact('pinch'); first.capturedByHook = true; second.capturedByHook = true;
  const inventory = new Map([[1, first], [2, second]]), panes = new Map([['pane', inventory]]);
  drainPdfPointerAfterCaptureLoss(inventory, 1, () => drainPdfPointerScope(panes, cancel));
  assert.equal(inventory.size, 2); assert.equal(first.phase, 'drain'); assert.equal(second.phase, 'drain');
  settlePdfPointerContact(inventory, 2, () => {});
  assert.equal(inventory.size, 1); assert.equal(pdfPointerScopeIsDraining(panes), true);
  assert.equal(pdfPointerDownDisposition(panes, 'pane', 1), 'drain');
  settlePdfPointerContact(inventory, 1, () => {});
  assert.equal(inventory.size, 0); assert.equal(pdfPointerScopeIsDraining(panes), false);
});
test('normal terminal release re-entry does not cancel or finish the same contact twice', () => {
  const held = contact('text-selecting'); held.capturedByHook = true;
  const inventory = new Map([[1, held]]);
  let releases = 0, cancellations = 0, terminals = 0;
  const withCapture = Object.assign(held, { pane: { hasPointerCapture: () => true,
    releasePointerCapture() {
      releases++;
      assert.equal(drainPdfPointerAfterCaptureLoss(inventory, 1, () => { cancellations++; }), false);
    } } });
  settlePdfPointerContact(inventory, 1, () => { terminals++; releasePdfPointerCapture(withCapture, 1); });
  assert.equal(terminals, 1); assert.equal(releases, 1); assert.equal(cancellations, 0); assert.equal(inventory.size, 0);
});
test('external Ink capture transfer preserves raw admission and leaves its genuine native terminal to Ink', () => {
  const ink = contact('raw', 'pen', true), inventory = new Map([[1, ink]]), panes = new Map([['pane', inventory]]);
  let inkCommits = 0, inkCancels = 0, releases = 0;
  drainPdfPointerAfterCaptureLoss(inventory, 1, () => drainPdfPointerScope(panes, cancel));
  assert.equal(inventory.has(1), true); assert.equal(pdfPointerScopeIsDraining(panes), true);
  releasePdfPointerCapture(Object.assign(ink, { pane: { hasPointerCapture: () => true, releasePointerCapture() { releases++; } } }), 1);
  assert.equal(releases, 0); assert.equal(inkCommits, 0); assert.equal(inkCancels, 0);
  settlePdfPointerContact(inventory, 1, () => {}); // hook consumes only its raw record; native event keeps propagating.
  inkCommits++; // the existing Ink owner alone receives its ordinary native up.
  assert.equal(inkCommits, 1); assert.equal(inkCancels, 0); assert.equal(inventory.size, 0);
});
