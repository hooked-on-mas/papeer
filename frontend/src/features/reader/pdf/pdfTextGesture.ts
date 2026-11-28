/** One-shot recognition facts stored on a contact in usePdfPointerInput's inventory.
 * This helper owns no pointers, timers, DOM, session, or claim. */
export const PDF_TEXT_HOLD_MS = 450;
export const PDF_TEXT_SLOP_PX = 8;
export type PdfTextPending = Readonly<{ startX: number; startY: number; deadline: number;
  x: number; y: number; maxDistance: number }>;
export type PdfTextDecision = 'pending' | 'pan' | 'select';
export type PdfPointerPhase = 'raw' | 'pan-pending' | 'pan' | 'text-pending' | 'text-selecting' | 'pinch' | 'drain' | 'palm';
export type PdfPointerContactFacts = { phase: PdfPointerPhase; pointerType: string; ownsInk(): boolean };
/** Read existing active Ink admission directly; never populate another ID set. */
export type PdfInkGestureReadPort = { owns(pointerId: number): boolean; cancelTouch?(pointerId: number): boolean };
export const isPdfPointerPhysicalTerminal = (type: string): boolean => type === 'pointerup' || type === 'pointercancel';
/** Release only a capture this hook actually took. Raw external/legacy Ink
 * contacts must keep their capture and their own terminal event path. */
export function releasePdfPointerCapture(contact: { capturedByHook: boolean;
  pane: { hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void } }, id: number): void {
  if (!contact.capturedByHook) return;
  contact.capturedByHook = false;
  try { if (contact.pane.hasPointerCapture(id)) contact.pane.releasePointerCapture(id); } catch { /* already ended */ }
}
/** Capture loss is not physical release. Keep the raw contact counted until a
 * genuine up/cancel; the existing phases remember that it cannot resume reading. */
export function drainPdfPointerAfterCaptureLoss<Contact extends { ending: boolean; capturedByHook: boolean; phase: PdfPointerPhase }>(
  inventory: ReadonlyMap<number, Contact>, id: number, cancelReadingCandidates: (contact: Contact) => void,
): boolean {
  const contact = inventory.get(id);
  if (!contact || contact.ending || contact.phase === 'drain' && !contact.capturedByHook) return false;
  contact.capturedByHook = false;
  contact.phase = 'drain';
  cancelReadingCandidates(contact);
  return true;
}
export type PdfPointerPaneInventory<Pane, Contact> = ReadonlyMap<Pane, ReadonlyMap<number, Contact>>;
/** DOM identity facts, not a second hit-test/owner registry. A portalled handle
 * needs BOTH the exact current controller identity and physical Reader membership. */
export function pdfPointerTargetBelongsToPane<Pane, Scope>({ pane, currentPane, connected, scope, targetScope,
  containsTarget, scopeContainsTarget, physicalPane, ownHandle }: {
  pane: Pane; currentPane: Pane | null; connected: boolean; scope: Scope; targetScope: Scope | null;
  containsTarget: boolean; scopeContainsTarget: boolean; physicalPane: Pane | null; ownHandle: boolean;
}): boolean {
  if (pane !== currentPane || !connected || targetScope !== null && targetScope !== scope) return false;
  if (containsTarget) return physicalPane === null || physicalPane === pane;
  return targetScope === scope && scopeContainsTarget && physicalPane === null && ownHandle;
}
/** Query the actual admitted Ink fact, never infer it from a raw pen contact. */
export const isAdmittedPdfInkContact = (contact: PdfPointerContactFacts) => contact.pointerType === 'pen' && contact.ownsInk();
export function pdfPointerScopeIsDraining<Pane, Contact extends { phase: PdfPointerPhase }>(panes: PdfPointerPaneInventory<Pane, Contact>): boolean {
  return [...panes.values()].some(contacts => [...contacts.values()].some(contact => contact.phase === 'drain'));
}
/** Capture-phase pass-through for an already admitted reading gesture only.
 * The caller separately verifies current owner, reading mode and input idle. */
export function canContinueSamePanePinch<Pane, Contact extends PdfPointerContactFacts>(
  panes: PdfPointerPaneInventory<Pane, Contact>, pane: Pane, pointerId: number,
  current: (contact: Contact) => boolean,
): boolean {
  const entries = [...panes.entries()].flatMap(([owner, contacts]) => [...contacts.entries()].map(([id, contact]) => ({ owner, id, contact })));
  if (entries.length !== 2 || entries.some(entry => entry.owner !== pane || entry.contact.pointerType !== 'touch'
    || entry.contact.ownsInk() || !current(entry.contact))) return false;
  const incoming = entries.find(entry => entry.id === pointerId), first = entries.find(entry => entry.id !== pointerId);
  return incoming?.contact.phase === 'raw' && !!first
    && ['text-pending', 'text-selecting', 'pan-pending', 'pan'].includes(first.contact.phase);
}
/** Transfer an admitted finger preview to the existing same-pane pinch recognizer. */
export function transferPdfFingerToPinch<Pane, Contact extends PdfPointerContactFacts>(
  panes: PdfPointerPaneInventory<Pane, Contact>, pane: Pane, incomingId: number,
  current: (contact: Contact) => boolean, cancel: (id: number) => boolean,
): boolean {
  const entries = [...panes.entries()].flatMap(([owner, contacts]) => [...contacts.entries()].map(([id, contact]) => ({ owner, id, contact })));
  if (entries.length !== 2 || entries.some(entry => entry.owner !== pane || entry.contact.pointerType !== 'touch' || !current(entry.contact))) return false;
  const incoming = entries.find(entry => entry.id === incomingId), first = entries.find(entry => entry.id !== incomingId);
  if (!incoming || incoming.contact.phase !== 'raw' || !first || first.contact.phase !== 'raw' || !first.contact.ownsInk()) return false;
  first.contact.phase = 'pan-pending';
  if (cancel(first.id)) return true;
  first.contact.phase = 'drain'; return false;
}
/** Only facts in the existing scope inventory are consulted. No new gesture owner
 * or drain registry is needed; surviving drain contacts remember the whole sequence. */
export function pdfPointerDownDisposition<Pane, Contact extends PdfPointerContactFacts>(
  panes: PdfPointerPaneInventory<Pane, Contact>, pane: Pane, pointerId: number,
): 'pass' | 'palm' | 'drain' {
  const incoming = panes.get(pane)?.get(pointerId); if (!incoming) return 'pass';
  if (pdfPointerScopeIsDraining(panes)) return 'drain';
  for (const [otherPane, contacts] of panes) for (const [id, contact] of contacts) {
    if (id !== pointerId && isAdmittedPdfInkContact(contact))
      return otherPane === pane && incoming.pointerType === 'touch' ? 'palm' : 'drain';
  }
  if ([...panes.values()].reduce((count, contacts) => count + [...contacts.values()].filter(contact => contact.pointerType === 'touch').length, 0) > 2)
    return 'drain';
  if ([...panes.values()].filter(contacts => contacts.size > 0).length > 1) return 'drain';
  // An already-started reading touch cannot be interrupted by a newly arriving
  // pen. A suppressed/palm/raw touch is not itself proof of a reading gesture.
  if (incoming.pointerType === 'pen' && [...panes.get(pane)?.values() ?? []].some(contact => contact !== incoming
    && contact.pointerType === 'touch' && ['pan-pending', 'pan', 'text-pending', 'text-selecting', 'pinch'].includes(contact.phase))) return 'drain';
  return 'pass';
}
export function drainPdfPointerScope<Pane, Contact extends PdfPointerContactFacts & { cancelTouchInk?(id: number): void }>(
  panes: PdfPointerPaneInventory<Pane, Contact>, cancelReadingCandidates: (contacts: ReadonlyMap<number, Contact>) => void,
): void {
  // Set every unprotected phase before callbacks. A callback may synchronously
  // re-enter through capture loss; it must already observe the cancellation.
  const current = [...panes.values()].filter(contacts => contacts.size > 0);
  for (const contacts of current) for (const contact of contacts.values()) if (!isAdmittedPdfInkContact(contact)) contact.phase = 'drain';
  for (const contacts of current) for (const [id, contact] of contacts) if (contact.pointerType === 'touch') contact.cancelTouchInk?.(id);
  for (const contacts of current) cancelReadingCandidates(contacts);
}
export type PdfContactTerminalEffect = Readonly<{ clear: boolean; finishSelection: boolean; drain: boolean; maySwipe: boolean }>;
export function pdfContactTerminalEffect(phase: PdfPointerPhase, type: string): PdfContactTerminalEffect {
  const released = type === 'pointerup';
  return { clear: phase === 'text-pending' || !released, finishSelection: phase === 'text-selecting' && released,
    drain: phase === 'pinch' || !released && phase !== 'raw', maySwipe: phase === 'pan' && released };
}
/** Terminal re-entry protection lives on the same contact, not another inventory.
 * Native window capture and React up/lostcapture may call this with the same ID. */
export function settlePdfPointerContact<T extends { ending: boolean }>(inventory: Map<number, T>, id: number, finish: (contact: T) => void): boolean {
  const contact = inventory.get(id); if (!contact || contact.ending) return false;
  contact.ending = true;
  try { finish(contact); } finally { inventory.delete(id); }
  return true;
}
export function drainPdfPointerContacts<T extends { phase: PdfPointerPhase }>(inventory: ReadonlyMap<number, T>, cancelPending: (contact: T) => void): void {
  for (const contact of inventory.values()) { cancelPending(contact); contact.phase = 'drain'; }
}
export function movePdfTextPending(pending: PdfTextPending, x: number, y: number): PdfTextPending {
  return { ...pending, x, y, maxDistance: Math.max(pending.maxDistance, Math.hypot(x - pending.startX, y - pending.startY)) };
}
/** Distance is checked first even when the deadline callback was delayed. A move
 * already observed beyond slop cannot become a selection when its timer runs. */
export function decidePdfTextPending(pending: PdfTextPending, now: number): PdfTextDecision {
  if (pending.maxDistance > PDF_TEXT_SLOP_PX) return 'pan';
  return now >= pending.deadline ? 'select' : 'pending';
}
export type PdfTextEndpoint = 'anchor' | 'focus';
export type PdfTextPoint = Readonly<{ x: number; y: number }>;
export type PdfHandleMotion = Readonly<{ down: PdfTextPoint; offset: PdfTextPoint; moved: boolean;
  /** Current binding/map/lifetime-checked logical origin, owned by the existing selection port. */
  restoreOrigin?(endpoint: PdfTextEndpoint): boolean }>;
export function pdfHandleMotion(rects: readonly Readonly<{ left: number; top: number; width: number; height: number }>[], down: PdfTextPoint): PdfHandleMotion | null {
  if (![down.x, down.y].every(Number.isFinite) || !rects.length) return null;
  const centers = rects.map(rect => {
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0 || (!rect.width && !rect.height)) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const first = centers[0];
  if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.y) || centers.some(value => !value || value.x !== first.x || value.y !== first.y)) return null;
  return { down: { ...down }, offset: { x: first.x - down.x, y: first.y - down.y }, moved: false };
}
export function observePdfHandleMotion(motion: PdfHandleMotion, point: PdfTextPoint): PdfHandleMotion {
  return motion.moved || point.x === motion.down.x && point.y === motion.down.y ? motion : { ...motion, moved: true };
}
export function pdfHandleMovePoint(motion: PdfHandleMotion, point: PdfTextPoint): PdfTextPoint | null {
  if (!motion.moved) return null;
  const result = { x: point.x + motion.offset.x, y: point.y + motion.offset.y };
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
}
/** Facts on the existing contact, initialized only AFTER a word has been selected.
 * Pre-deadline slop does not count as extension of the newly selected word. */
export type PdfLongPressMotion = Readonly<{ x: number; y: number; moved: boolean }>;
export function beginPdfLongPressMotion(point: PdfTextPoint): PdfLongPressMotion {
  return { x: point.x, y: point.y, moved: false };
}
export function observePdfLongPressMotion(motion: PdfLongPressMotion, point: PdfTextPoint): PdfLongPressMotion {
  return motion.moved || point.x === motion.x && point.y === motion.y ? motion : { ...motion, moved: true };
}
export function mayMovePdfTextSelection(motion: PdfLongPressMotion | null): boolean {
  return motion === null || motion.moved;
}
export function movePdfTextPointerSelection(port: Pick<PdfTextPointerPort, 'move'>, point: PdfTextPoint,
  endpoint: PdfTextEndpoint, motion: PdfLongPressMotion | null,
  handle?: Readonly<{ motion: PdfHandleMotion; point: PdfTextPoint }>): boolean {
  if (!mayMovePdfTextSelection(motion)) return false;
  // A collapsed Range's pixel centre is not an invertible logical caret map.
  // Only a moved handle returning to the exact raw down point uses its origin.
  // A rejected origin is stale: never fall back to another DOM hit-test.
  if (handle?.motion.moved && handle.motion.restoreOrigin
    && handle.point.x === handle.motion.down.x && handle.point.y === handle.motion.down.y)
    return handle.motion.restoreOrigin(endpoint);
  return port.move(point, endpoint);
}
export type PdfTextPointerPort = {
  /** Current ready binding, active reading surface, scope and owner. No contact check here. */
  available(): boolean;
  hit(target: EventTarget | null): 'text' | PdfTextEndpoint | null;
  start(point: PdfTextPoint, kind: 'drag' | 'longpress' | PdfTextEndpoint): boolean;
  startHandle(point: PdfTextPoint, endpoint: PdfTextEndpoint): PdfHandleMotion | null;
  move(point: PdfTextPoint, endpoint: PdfTextEndpoint): boolean;
  finish(): void;
  clear(): void;
};

/** Bounds a terminal continuation to one synchronous invocation; this grants no input authority. */
export function withSynchronousTerminalContinuation<T>(valid: () => boolean, deliver: (consume: (action: (stillValid: () => boolean) => T, eligible?: boolean) => T | undefined) => void): void {
  let live = true, consumed = false;
  const stillValid = () => live && valid();
  try { deliver((action, eligible = true) => { if (consumed) return undefined; consumed = true; if (!eligible || !stillValid()) return undefined; return action(stillValid); }); }
  finally { live = false; }
}

/** Evidence check only; this function does not mint a continuation. */
export function isSoleTerminalSwipeContact<P, C extends { ending: boolean; phase: PdfPointerPhase; pointerType: string }>(
  panes: ReadonlyMap<P, ReadonlyMap<number, C>> | undefined, pane: P, id: number, contact: C): boolean {
  if (!panes || panes.get(pane)?.get(id) !== contact || !contact.ending || contact.phase !== 'pan' || contact.pointerType !== 'touch') return false;
  let count = 0;
  for (const entries of panes.values()) count += entries.size;
  return count === 1;
}
