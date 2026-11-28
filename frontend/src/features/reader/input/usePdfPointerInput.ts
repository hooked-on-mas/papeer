import { useEffect, useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { CanonicalManagedInputBundle } from './canonicalManagedInput';
import { scopeOf, claim, getPdfPointerOwner } from "./pdfPointerOwner";
export { usePdfTouchOwner, getPdfPointerOwner } from "./pdfPointerOwner";
import { scrollDeltaForZoomAnchor, type ZoomAnchor } from "../navigation/readingPlace";
import { beginTouchPinch, moveTouchPinch, type TouchPinch, type TouchPoint } from "./touchZoom";
import { createTouchSwipe } from "./touchSwipe";
import { referenceTouchAdmission } from '../reference/referenceRestoreDecision';
import { horizontalEdges } from "../navigation/pageTurn";
import { PDF_TEXT_HOLD_MS, decidePdfTextPending, movePdfTextPending,
  pdfContactTerminalEffect, settlePdfPointerContact, drainPdfPointerContacts, withSynchronousTerminalContinuation, isSoleTerminalSwipeContact,
  beginPdfLongPressMotion, observePdfLongPressMotion, movePdfTextPointerSelection, pdfHandleMovePoint, observePdfHandleMotion,
  pdfPointerScopeIsDraining, pdfPointerDownDisposition, drainPdfPointerScope, pdfPointerTargetBelongsToPane, releasePdfPointerCapture, isAdmittedPdfInkContact,
  drainPdfPointerAfterCaptureLoss, isPdfPointerPhysicalTerminal, canContinueSamePanePinch, transferPdfFingerToPinch,
  type PdfTextPending, type PdfTextPointerPort, type PdfTextEndpoint, type PdfPointerPhase, type PdfLongPressMotion, type PdfInkGestureReadPort, type PdfHandleMotion } from '../pdf/pdfTextGesture';


const terminalSwipeBrand: unique symbol = Symbol('terminal-swipe');
export type TerminalSwipeProof = { readonly [terminalSwipeBrand]: (root: HTMLElement | null, pane: HTMLElement | null, action: (stillValid: () => boolean) => boolean) => boolean | undefined };
/** Only this hook can construct the branded proof; it expires before terminal cleanup. */
export function consumeTerminalSwipe(proof: TerminalSwipeProof, root: HTMLElement | null, pane: HTMLElement | null, action: (stillValid: () => boolean) => boolean): boolean {
  return proof?.[terminalSwipeBrand]?.(root, pane, action) === true;
}

type Contact = TouchPoint & { pointerType: string; startX: number; startY: number; lastX: number; lastY: number;
  phase: PdfPointerPhase; ending: boolean;
  capturedByHook: boolean;
  pane: HTMLDivElement; scope: HTMLElement; lifetimeKey: unknown; ownsInk(): boolean; cancelTouchInk(id: number): void; cancelReadingCandidates(): void;
  pending?: PdfTextPending; longPressMotion: PdfLongPressMotion | null;
  endpoint: PdfTextEndpoint; handleMotion?: PdfHandleMotion; timer: ReturnType<typeof setTimeout> | null };
// This is the existing inventory, expanded to references to each pane's ONE raw Map.
// No second pointer/selection owner map is introduced.
const contactPanes = new Map<HTMLElement, Map<HTMLDivElement, ReadonlyMap<number, Contact>>>();
/** Admission inventory for the existing touch gesture; it does not claim a second input owner. */
export const hasPdfPointerContact = (element: HTMLElement | null) => !!element
  && [...contactPanes.get(scopeOf(element))?.values() ?? []].some(contacts => contacts.size > 0);
/** Gesture-down admission only: ignore this event's already-recorded raw contact.
 * Toolbar/copy/quote/highlight admission must continue to require ALL contacts zero. */
export const hasOtherPdfPointerContact = (element: HTMLElement | null, pointerId: number) => !!element
  && [...contactPanes.get(scopeOf(element))?.values() ?? []].some(contacts => [...contacts.keys()].some(id => id !== pointerId));
/** Readonly guard for the existing activation/annotation/Ink admission gates. */
export const isPdfPointerDraining = (element: HTMLElement | null) => {
  const panes = element && contactPanes.get(scopeOf(element));
  return !!panes && pdfPointerScopeIsDraining(panes);
};
/** Read-only capture admission: use the existing raw inventory, never a new owner. */
export const isSamePaneReadingPinchContinuation = (pane: HTMLDivElement | null, pointerId: number): boolean => {
  if (!pane?.isConnected) return false;
  const owner = getPdfPointerOwner(pane);
  if (owner && owner !== pane) return false;
  const scope = scopeOf(pane), panes = contactPanes.get(scope), incoming = panes?.get(pane)?.get(pointerId);
  if (!panes || !incoming) return false;
  return canContinueSamePanePinch(panes, pane, pointerId, contact => !contact.ending
    && contact.pane === pane && contact.scope === scope && contact.lifetimeKey === incoming.lifetimeKey);
};
function recordContact(pane: HTMLDivElement, contacts: ReadonlyMap<number, Contact>) {
  if (contacts.size) {
    const scope = scopeOf(pane), panes = contactPanes.get(scope) ?? new Map();
    panes.set(pane, contacts); contactPanes.set(scope, panes);
  } else for (const [scope, panes] of contactPanes) {
    // Cleanup can run after detachment, when closest(reader-root) no longer finds the registration scope.
    panes.delete(pane); if (!panes.size) contactPanes.delete(scope);
  }
}

export function usePdfPointerInput({ pageKey, enabled, paneRef, surfaceRef, pageWidth, drawnWidth, fitWidth, fitPageWidth, onPageSwipe, zoom, allowTouch, allowContinuation, textSelection, inkGesture, lifetimeKey, inputBundle }: {
  inputBundle: CanonicalManagedInputBundle;
  pageKey: string; enabled: boolean;
  paneRef: RefObject<HTMLDivElement | null>; surfaceRef: RefObject<HTMLDivElement | null>;
  pageWidth: number; drawnWidth: number; fitWidth: number; fitPageWidth: number;
  allowTouch?: () => boolean;
  allowContinuation?: () => boolean;
  /** Omit for paper/legacy. DOM/Range operations only; this hook owns gesture decisions. */
  textSelection?: PdfTextPointerPort;
  /** The existing InkOverlay exposes ownership and cancellation of touch preview only. */
  inkGesture?: PdfInkGestureReadPort;
  /** Existing scope/owner lease invalidation; host must pass its current identity. */
  lifetimeKey?: unknown;
  onPageSwipe?: (direction: -1 | 1, proof: TerminalSwipeProof) => void;
  /** Whose zoom a pinch changes: the PDF's, or the notebook's own. */
  zoom: { get(): number; set(value: number): void };
}) {
  const contacts = useRef(new Map<number, Contact>());
  const latest = useRef({ textSelection, enabled, allowTouch, allowContinuation, onPageSwipe, inkGesture, lifetimeKey });
  latest.current = { textSelection, enabled, allowTouch, allowContinuation, onPageSwipe, inkGesture, lifetimeKey };
  const draining = useRef(false);
  const pinch = useRef<TouchPinch | null>(null);
  const anchor = useRef<ZoomAnchor | null>(null);
  const pendingRedraw = useRef<{ width: number; top: number; left: number } | null>(null);
  const layout = useRef({ pageWidth, drawnWidth });
  layout.current = { pageWidth, drawnWidth };
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const swipe = useRef(createTouchSwipe());

  const clearAnchor = () => { anchor.current = null; pendingRedraw.current = null; };

  const restoreAnchor = () => {
    const pane = paneRef.current, page = surfaceRef.current, point = anchor.current;
    if (!pane || !page || !point) return;
    const delta = scrollDeltaForZoomAnchor(point, page.getBoundingClientRect());
    pane.scrollLeft += delta.left;
    pane.scrollTop += delta.top;
  };
  useLayoutEffect(() => {
    // A later zoom or pane resize has its own position. Only the redraw of this gesture may
    // reuse its final anchor; intervening scrolling also discards it (onScrollCapture below).
    if (!pinch.current && pendingRedraw.current?.width !== pageWidth) clearAnchor();
    restoreAnchor();
    // Keep the last anchor until the sharp drawing replaces the scaled preview.
    if (!pinch.current && pageWidth === drawnWidth) clearAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measure after layout changes, not every render
  }, [pageWidth, drawnWidth]);

  const applyPinch = () => {
    const [a, b] = [...contacts.current.values()].filter(contact => contact.phase === 'pinch');
    if (!pinch.current || !a || !b) return;
    const next = moveTouchPinch(pinch.current, a, b);
    anchor.current = next.anchor;
    // One layout per animation frame for both pointer streams. Restore against that layout,
    // including when only the midpoint moves or the scale is already at its limit.
    if (next.zoom !== zoom.get()) flushSync(() => zoom.set(next.zoom));
    restoreAnchor();
  };
  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const stopTimer = (contact: Contact) => {
    if (contact.timer !== null) clearTimeout(contact.timer);
    contact.timer = null; contact.pending = undefined;
  };
  const capture = (id: number) => {
    const pane = paneRef.current;
    const contact = contacts.current.get(id);
    try {
      if (pane && contact?.pane === pane && !pane.hasPointerCapture(id)) {
        pane.setPointerCapture(id); contact.capturedByHook = true;
      }
    } catch { /* already cancelled */ }
  };
  const ownsTarget = (pane: HTMLDivElement, target: EventTarget | null) => {
    if (!(target instanceof Node)) return false;
    const element = target instanceof Element ? target : target.parentElement;
    if (!element) return false;
    const scope = scopeOf(pane), reader = element.closest<HTMLElement>('[data-reader-root]');
    const physicalPane = element.closest<HTMLElement>('[data-pdf-scroller],.document-paper-pane');
    const port = latest.current.textSelection;
    const hit = port?.available() ? port.hit(target) : null;
    // A portalled handle belongs to this pane only through the current exact
    // controller identity, AND its actual DOM Reader membership must agree.
    return pdfPointerTargetBelongsToPane<HTMLElement, HTMLElement>({ pane, currentPane: paneRef.current, connected: pane.isConnected,
      scope, targetScope: reader, containsTarget: pane.contains(target), scopeContainsTarget: scope.contains(target), physicalPane,
      ownHandle: hit === 'anchor' || hit === 'focus' });
  };
  const register = (event: { pointerId: number; pointerType: string; clientX: number; clientY: number; target: EventTarget | null }) => {
    const pane = paneRef.current;
    if (!pane || !ownsTarget(pane, event.target)) return null;
    const scope = scopeOf(pane), existing = contacts.current.get(event.pointerId);
    if (existing) return existing.pane === pane && existing.scope === scope && existing.lifetimeKey === latest.current.lifetimeKey ? existing : null;
    // A moved/replaced pane cannot lend its old contacts to a new reader scope.
    if ([...contacts.current.values()].some(contact => contact.pane !== pane || contact.scope !== scope || contact.lifetimeKey !== latest.current.lifetimeKey)) return null;
    const registeredLifetime = latest.current.lifetimeKey;
    const contact: Contact = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      lastX: event.clientX, lastY: event.clientY, pointerType: event.pointerType,
      phase: 'raw', endpoint: 'focus', timer: null, ending: false, capturedByHook: false, longPressMotion: null, pane, scope, lifetimeKey: registeredLifetime,
      ownsInk: () => paneRef.current === pane && scopeOf(pane) === scope && latest.current.lifetimeKey === registeredLifetime
        && latest.current.inkGesture?.owns(event.pointerId) === true,
      cancelTouchInk: id => { if (latest.current.lifetimeKey === registeredLifetime) latest.current.inkGesture?.cancelTouch?.(id); },
      cancelReadingCandidates: () => { if (latest.current.lifetimeKey === registeredLifetime) cancelReadingCandidates(); } };
    contacts.current.set(event.pointerId, contact);
    recordContact(pane, contacts.current);
    const panes = contactPanes.get(scope)!;
    const disposition = pdfPointerDownDisposition(panes, pane, event.pointerId);
    if (disposition === 'palm') contact.phase = 'palm';
    else if (disposition === 'drain') drainPdfPointerScope(panes, inventory => inventory.values().next().value?.cancelReadingCandidates());
    return contact;
  };
  const rawMove = (event: { pointerId: number; clientX: number; clientY: number }) => {
    const contact = contacts.current.get(event.pointerId); if (!contact) return;
    contact.x = event.clientX; contact.y = event.clientY;
    if (contact.pending) contact.pending = movePdfTextPending(contact.pending, contact.x, contact.y);
    if (contact.longPressMotion) contact.longPressMotion = observePdfLongPressMotion(contact.longPressMotion, contact);
    if (contact.handleMotion) contact.handleMotion = observePdfHandleMotion(contact.handleMotion, contact);
  };
  const drain = (preserveSelection = false) => {
    draining.current = true; swipe.current.cancel(); if (!preserveSelection) latest.current.textSelection?.clear();
    for (const contact of contacts.current.values()) contact.handleMotion = undefined;
    drainPdfPointerContacts(contacts.current, stopTimer);
    suppressClick.current = true;
  };
  const cancelReadingCandidates = () => {
    // Cross-pane overlap cancels only this hook's reading candidates. An
    // admitted Ink pen keeps its existing owner, preview, capture and terminal.
    draining.current = true; cancelFrame(); pinch.current = null; clearAnchor(); swipe.current.cancel();
    for (const contact of contacts.current.values()) { stopTimer(contact); contact.longPressMotion = null; contact.handleMotion = undefined; }
    latest.current.textSelection?.clear(); suppressClick.current = true;
    const pane = paneRef.current; if (pane) claim(pane, false);
  };
  const pan = (id: number, contact: Contact) => {
    const pane = paneRef.current; if (!pane) return;
    const dx = contact.x - contact.lastX, dy = contact.y - contact.lastY;
    if (dx || dy) {
      clearAnchor(); capture(id); pane.scrollBy(-dx, -dy); suppressClick.current = true;
      contact.lastX = contact.x; contact.lastY = contact.y;
    }
  };
  const resolvePending = (id: number, contact: Contact) => {
    if (contact.phase !== 'text-pending' || !contact.pending) return;
    if (contact.pane !== paneRef.current || contact.scope !== scopeOf(contact.pane) || contact.lifetimeKey !== latest.current.lifetimeKey) {
      stopTimer(contact); contact.phase = 'drain'; return;
    }
    if (!latest.current.enabled
      || [...contacts.current.values()].some(other => other.pointerType === 'pen')) {
      stopTimer(contact); contact.phase = 'palm'; swipe.current.cancel(); latest.current.textSelection?.clear(); return;
    }
    const decision = decidePdfTextPending(contact.pending, performance.now());
    if (decision === 'pending') {
      // A timer may fire just before a fractional performance.now deadline.
      // Re-arm only that exhausted timer; moves never add another timer.
      if (contact.timer === null) contact.timer = setTimeout(() => {
        contact.timer = null; resolvePending(id, contact);
      }, Math.max(1, Math.ceil(contact.pending.deadline - performance.now())));
      return;
    }
    stopTimer(contact);
    if (decision === 'pan') {
      // One-way decision. No later timer or text hit may reinterpret this contact.
      contact.phase = 'pan'; latest.current.textSelection?.clear(); pan(id, contact); return;
    }
    swipe.current.cancel();
    const port = latest.current.textSelection;
    if (port?.available() && port.start(contact, 'longpress')) {
      contact.phase = 'text-selecting'; contact.longPressMotion = beginPdfLongPressMotion(contact); suppressClick.current = true;
    }
    else drain();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Raw capture may already have seen this event. Registration is idempotent;
    // phase advancement happens here only, never in the capture observer.
    const contact = register(e);
    if (!contact) return;
    if (contact.phase !== 'raw') { if ((contact.phase === 'drain' || contact.phase === 'palm') && e.cancelable) e.preventDefault(); return; }
    const pane = paneRef.current;
    if (!pane || !latest.current.enabled) return;
    const port = latest.current.textSelection;
    const all = [...contacts.current.entries()];
    const penHeld = all.some(([id, other]) => id !== e.pointerId && other.pointerType === 'pen');
    if (e.pointerType === 'touch' && penHeld) {
      contact.phase = 'palm'; swipe.current.cancel(); if (e.cancelable) e.preventDefault(); return;
    }
    if (e.pointerType === 'pen') {
      // Existing touches become palms. Pen+touch never enters pinch.
      if (all.some(([, other]) => other.pointerType === 'touch')) {
        cancelFrame(); pinch.current = null; claim(pane, false); swipe.current.cancel(); port?.clear();
        for (const [, other] of all) if (other.pointerType === 'touch') { stopTimer(other); other.phase = 'palm'; }
      }
    }
    if (e.pointerType !== 'touch') {
      suppressClick.current = false; clearAnchor();
      // button 5 / buttons 32 eraser; button 2 / buttons 2 barrel are excluded.
      const tipOrLeft = e.button === 0 && (e.buttons & ~1) === 0;
      const hit = port?.available() ? port.hit(e.target) : null;
      const onlyLocalPalms = e.pointerType === 'pen' && all.every(([id, other]) => id === e.pointerId || other.phase === 'palm')
        && ![...contactPanes.get(scopeOf(pane))?.entries() ?? []].some(([registered, pointers]) => registered !== pane && pointers.size > 0);
      if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && tipOrLeft && hit
        && (!hasOtherPdfPointerContact(pane, e.pointerId) || onlyLocalPalms) && port) {
        const motion = hit === 'text' ? undefined : port.startHandle(contact, hit);
        const started = hit === 'text' ? port.start(contact, 'drag') : !!motion;
        if (started) { contact.phase = 'text-selecting'; contact.endpoint = hit === 'anchor' ? 'anchor' : 'focus'; contact.handleMotion = motion ?? undefined; }
        else if (hit !== 'text') drain(true);
        if (started || hit !== 'text') { capture(e.pointerId); swipe.current.cancel(); e.preventDefault(); }
      }
      return;
    }
    // A second touch may complete an already admitted same-pane reading gesture even
    // while its draw is unsettled. New gestures still require the start gate.
    if (!referenceTouchAdmission(latest.current.allowTouch?.() !== false, isSamePaneReadingPinchContinuation(pane, e.pointerId),
      latest.current.allowContinuation?.() !== false)) return;
    const owner = getPdfPointerOwner(pane);
    if (owner && owner !== pane) return;
    const fingers = all.filter(([, other]) => other.pointerType === 'touch' && other.phase !== 'palm');
    if (fingers.length > 2) { drain(); pinch.current = null; claim(pane, false); e.preventDefault(); return; }
    if (fingers.length === 2) {
      const page = surfaceRef.current; if (!page) { drain(); return; }
      swipe.current.cancel(); port?.clear();
      for (const [id, finger] of fingers) { stopTimer(finger); finger.phase = 'pinch'; capture(id); }
      pinch.current = beginTouchPinch(fingers[0][1], fingers[1][1], page.getBoundingClientRect(), pageWidth / fitWidth, fitPageWidth / fitWidth);
      suppressClick.current = true; claim(pane, true); e.preventDefault(); return;
    }
    suppressClick.current = false; clearAnchor();
    contact.phase = 'pan-pending';
    swipe.current.start(contact.x, contact.y, horizontalEdges(pane));
    const hit = port?.available() ? port.hit(e.target) : null;
    if (hit === 'anchor' || hit === 'focus') {
      swipe.current.cancel(); contact.endpoint = hit;
      const motion = port?.startHandle(contact, hit);
      if (motion) { contact.phase = 'text-selecting'; contact.handleMotion = motion; } else drain(true);
      capture(e.pointerId); e.preventDefault(); return;
    }
    if (hit === 'text') {
      contact.phase = 'text-pending';
      contact.pending = { startX: contact.x, startY: contact.y, x: contact.x, y: contact.y,
        maxDistance: 0, deadline: performance.now() + PDF_TEXT_HOLD_MS };
      // Clear the previous range at the start of a new body touch. No native Selection.
      port?.clear(); capture(e.pointerId);
      suppressClick.current = true;
      contact.timer = setTimeout(() => { contact.timer = null; resolvePending(e.pointerId, contact); }, PDF_TEXT_HOLD_MS);
      e.preventDefault();
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    rawMove(e);
    const contact = contacts.current.get(e.pointerId); if (!contact) return;
    if (contact.pane !== paneRef.current || contact.scope !== scopeOf(contact.pane) || contact.lifetimeKey !== latest.current.lifetimeKey) return;
    if (!latest.current.enabled) { drain(); if (e.cancelable) e.preventDefault(); return; }
    if (contact.phase === 'text-selecting' && e.pointerType === 'pen' && (e.buttons & ~1) !== 0) {
      drain(); if (e.cancelable) e.preventDefault(); return;
    }
    if (contact.phase === 'text-pending') resolvePending(e.pointerId, contact);
    if (contact.phase === 'pinch') {
      if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; applyPinch(); });
    } else if (contact.phase === 'text-selecting') {
      const port = latest.current.textSelection;
      if (!port?.available()) drain(); else {
        const point = contact.handleMotion ? pdfHandleMovePoint(contact.handleMotion, contact) : contact;
        if (point) movePdfTextPointerSelection(port, point, contact.endpoint, contact.longPressMotion,
          contact.handleMotion ? { motion: contact.handleMotion, point: contact } : undefined);
      }
      suppressClick.current = true;
    } else if (e.pointerType === 'touch' && !draining.current && (contact.phase === 'pan-pending' || contact.phase === 'pan')) {
      swipe.current.move(contact.y);
      if (contact.phase === 'pan-pending' && Math.hypot(contact.x - contact.startX, contact.y - contact.startY) >= 5) contact.phase = 'pan';
      if (contact.phase === 'pan') pan(e.pointerId, contact);
    }
    if (contact.phase !== 'raw' && e.cancelable) e.preventDefault();
  };
  type Terminal = { pointerId: number; clientX: number; clientY: number; type: string };
  const finish = (event: Terminal) => {
    // Capture transfer/loss has its own cancellation path and cannot remove a
    // still-down raw contact or reopen contact-zero command admission.
    if (!isPdfPointerPhysicalTerminal(event.type)) return;
    const registered = contacts.current.get(event.pointerId); if (!registered) return;
    const pane = registered.pane;
    const ended = settlePdfPointerContact(contacts.current, event.pointerId, contact => {
    if (paneRef.current !== pane || contact.scope !== scopeOf(pane) || contact.lifetimeKey !== latest.current.lifetimeKey) {
      stopTimer(contact); releasePdfPointerCapture(contact, event.pointerId); return;
    }
    rawMove(event); cancelFrame();
    const wasAdmittedInk = isAdmittedPdfInkContact(contact);
    if (event.type === 'pointerup' && contact.phase === 'text-pending') resolvePending(event.pointerId, contact);
    const wasPinching = contact.phase === 'pinch' && pinch.current !== null;
    const effect = pdfContactTerminalEffect(contact.phase, event.type);
    if (wasPinching && event.type === 'pointerup') applyPinch();
    const turn = contact.pointerType === 'touch' && effect.maySwipe && !draining.current
      ? swipe.current.finish(contact.x, contact.y) : 0;
    swipe.current.cancel(); stopTimer(contact);
    if (effect.clear) latest.current.textSelection?.clear();
    else if (effect.finishSelection) {
      const port = latest.current.textSelection;
      if (port?.available()) {
        // A no-motion up preserves the initial whole word. The same rule applies
        // when this up, rather than the delayed timer, resolved the long press.
        const point = contact.handleMotion ? pdfHandleMovePoint(contact.handleMotion, contact) : contact;
        if (point) movePdfTextPointerSelection(port, point, contact.endpoint, contact.longPressMotion,
          contact.handleMotion ? { motion: contact.handleMotion, point: contact } : undefined);
        port.finish();
      } else port?.clear();
    }
    // Remove only after terminal semantics have run. React's later up sees no
    // entry and cannot finish the same gesture twice.
    releasePdfPointerCapture(contact, event.pointerId);
    if (wasPinching) {
      pinch.current = null;
      const { pageWidth: width, drawnWidth: drawn } = layout.current;
      if (width === drawn) clearAnchor();
      else pendingRedraw.current = { width, top: pane.scrollTop, left: pane.scrollLeft };
      claim(pane, false); drain();
    } else if (effect.drain || event.type !== 'pointerup' && contacts.current.size > 1) drain();
    if (wasAdmittedInk) {
      const panes = contactPanes.get(contact.scope);
      if (panes && [...panes.values()].some(inventory => [...inventory.keys()].some(id => id !== event.pointerId)))
        drainPdfPointerScope(panes, inventory => inventory.values().next().value?.cancelReadingCandidates());
    }
    if (turn) {
      const valid = () => pane.isConnected && paneRef.current === pane && scopeOf(pane) === contact.scope
        && contact.scope.isConnected && contact.scope.contains(pane) && contact.lifetimeKey === latest.current.lifetimeKey
        && contacts.current.get(event.pointerId) === contact
        && isSoleTerminalSwipeContact(contactPanes.get(contact.scope), pane, event.pointerId, contact)
        && event.type === 'pointerup' && !draining.current && !isPdfPointerDraining(pane)
        && (!getPdfPointerOwner(pane) || getPdfPointerOwner(pane) === pane);
      withSynchronousTerminalContinuation<boolean>(valid, consume => {
        if (!valid()) return;
        const proof: TerminalSwipeProof = { [terminalSwipeBrand]: (root, expectedPane, action) =>
          consume(action, root === contact.scope && expectedPane === pane) };
        suppressClick.current = true; latest.current.onPageSwipe?.(turn, proof);
      });
    }
    });
    if (!ended) return;
    if (!contacts.current.size) { draining.current = false; recordContact(pane, contacts.current); claim(pane, false); }
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => finish(event);
  const callbacks = useRef({ register, rawMove, finish }); callbacks.current = { register, rawMove, finish };

  useEffect(() => {
    const pane = paneRef.current; if (!pane) return;
    const view = pane.ownerDocument.defaultView; if (!view) return;
    const down = (event: globalThis.PointerEvent) => {
      // Capture raw facts before descendant gates. Cross-pane cancellation must
      // happen here even when the second event never reaches React. Normal
      // text/pan/pinch start still occurs only in the existing React handler.
      const contact = callbacks.current.register(event);
      const panes = contact && contactPanes.get(contact.scope);
      if (contact && panes && contact.phase === 'raw') {
        const touches = [...panes.values()].flatMap(inventory => [...inventory.entries()])
          .filter(([id, other]) => id !== event.pointerId && other.pointerType === 'touch' && other.ownsInk());
        if (event.pointerType === 'touch' && touches.length) {
          if (!transferPdfFingerToPinch(panes, contact.pane, event.pointerId,
            other => !other.ending && other.lifetimeKey === contact.lifetimeKey && other.scope === contact.scope,
            id => latest.current.inkGesture?.cancelTouch?.(id) === true))
            drainPdfPointerScope(panes, inventory => inventory.values().next().value?.cancelReadingCandidates());
        } else if (event.pointerType !== 'touch' && touches.length) {
          drainPdfPointerScope(panes, inventory => inventory.values().next().value?.cancelReadingCandidates());
        }
      }
      if (contact?.phase === 'drain' || contact?.phase === 'palm') {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation(); // Keep later window observers; forbid descendant activation/new Ink admission.
      }
    };
    const move = (event: globalThis.PointerEvent) => callbacks.current.rawMove(event);
    // A raw contact can belong to legacy/external Ink. Never stop its genuine
    // up/cancel: only its existing Ink owner may perform that terminal action.
    const up = (event: globalThis.PointerEvent) => callbacks.current.finish(event);
    const reset = () => {
      cancelFrame(); pinch.current = null; swipe.current.cancel(); clearAnchor(); draining.current = false;
      const previous = [...contacts.current.entries()];
      for (const [id, contact] of previous) if (contact.pointerType === 'touch') contact.cancelTouchInk(id);
      for (const contact of contacts.current.values()) stopTimer(contact);
      // Clear before releasePointerCapture can synchronously dispatch lostcapture.
      contacts.current.clear(); recordContact(pane, contacts.current); claim(pane, false);
      for (const [id, contact] of previous) releasePdfPointerCapture(contact, id);
      latest.current.textSelection?.clear();
    };
    view.addEventListener('pointerdown', down, true); view.addEventListener('pointermove', move, true);
    view.addEventListener('pointerup', up, true); view.addEventListener('pointercancel', up, true);
    view.addEventListener('resize', reset); view.addEventListener('blur', reset); view.addEventListener('pagehide', reset);
    return () => {
      view.removeEventListener('pointerdown', down, true); view.removeEventListener('pointermove', move, true);
      view.removeEventListener('pointerup', up, true); view.removeEventListener('pointercancel', up, true);
      view.removeEventListener('resize', reset); view.removeEventListener('blur', reset); view.removeEventListener('pagehide', reset); reset();
    };
  }, [pageKey, enabled, paneRef, lifetimeKey, inputBundle]);

  return {
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
    onLostPointerCapture: (e: PointerEvent<HTMLDivElement>) => {
      // Taking capture from a text span also bubbles its lost event through the pane.
      if (e.target !== e.currentTarget || e.currentTarget.hasPointerCapture(e.pointerId)) return;
      drainPdfPointerAfterCaptureLoss(contacts.current, e.pointerId, contact => {
        if (paneRef.current !== contact.pane || contact.scope !== scopeOf(contact.pane) || contact.lifetimeKey !== latest.current.lifetimeKey) {
          stopTimer(contact); return;
        }
        const panes = contactPanes.get(contact.scope);
        if (panes) drainPdfPointerScope(panes, inventory => inventory.values().next().value?.cancelReadingCandidates());
        else { drain(); cancelReadingCandidates(); }
      });
    },
    onWheelCapture: clearAnchor,
    onScrollCapture: () => {
      const pending = pendingRedraw.current, pane = paneRef.current;
      if (pending && pane && (Math.abs(pane.scrollTop - pending.top) > 1 || Math.abs(pane.scrollLeft - pending.left) > 1)) clearAnchor();
    },
    suppressClick: () => {
      const value = suppressClick.current;
      suppressClick.current = false;
      return value;
    },
  };
}
