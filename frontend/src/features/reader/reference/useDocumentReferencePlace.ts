import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { ReaderSession } from '../ReaderSession';
import { sameReferenceTarget, type ReferenceCommandExpectation } from './readerReference';
import type { ReferenceMeasurement } from './referenceMeasurement';
import type { ReaderCommandPort } from '../navigation/readerCommands';
import { measureReaderPane } from '../navigation/useDocumentReadingPlace';
import { readingPlace, scrollForPlace, scrollDeltaForZoomAnchor, type PaneView, type ReadingPlace } from '../navigation/readingPlace';
import { getPdfPointerOwner } from '../input/usePdfPointerInput';
import { placeBeforeReferenceResize, referenceReportCurrent, referenceRestoreDecision, referenceInputReady, referenceGestureContinues, type ReferenceRestoreIntent } from './referenceRestoreDecision';

type ReferenceInputSnapshot = Readonly<{ active: boolean; blocked: boolean; zoom: number; actualZoom: number | undefined }>;
const referenceInputDiagnostic: unique symbol = Symbol('reference-input-diagnostic');
type DiagnosticPane = HTMLDivElement & { [referenceInputDiagnostic]?: () => ReferenceInputSnapshot | null };
/** Read-only projection of the current input port for the exact connected pane and root. */
export function readReferenceInputSnapshot(root: HTMLElement | null, pane: HTMLElement | null): ReferenceInputSnapshot | null {
  if (!root?.isConnected || !pane?.isConnected || pane.closest('[data-reader-root]') !== root || !root.contains(pane)) return null;
  return (pane as DiagnosticPane)[referenceInputDiagnostic]?.() ?? null;
}

/** Pane-local scroll and viewport. Callers supply the existing input/scope guard. */
export function useDocumentReferencePlace(reader: ReaderSession, paneRef: RefObject<HTMLDivElement | null>, lease: object,
  allowed: () => boolean) {
  const latestAllowed = useRef(allowed); latestAllowed.current = allowed;
  const accepted = useRef<ReferenceCommandExpectation | null>(null), layout = useRef(-1);
  const pending = useRef<ReferenceRestoreIntent | null>(null);
  const landing = useRef<number | null>(null);
  const held = useRef<ReadingPlace | null>(null);
  const settledView = useRef<PaneView | null>(null);
  const measured = useRef<ReferenceMeasurement | null>(null);
  const registration = useRef<{ lease: object; expected: ReferenceCommandExpectation | null }>({ lease, expected: null });
  if (registration.current.lease !== lease) registration.current = { lease, expected: null };
  const owner = useRef(lease);
  if (owner.current !== lease) { owner.current = lease; layout.current = -1; pending.current = null; landing.current = null; held.current = null; settledView.current = null; accepted.current = null; measured.current = null; }
  const state = reader.getSnapshot().reference;
  const reportMeasurement = useCallback((m: ReferenceMeasurement) => {
    const current = reader.getSnapshot().reference, target = current.target;
    if (!target || !referenceReportCurrent(current.targetGeneration === state.targetGeneration && sameReferenceTarget(target, state.target),
      paneRef.current === m.pane, m.isCurrent(), m.zoom === (current.zoom.kind === 'fit-page' ? 0 : current.zoom.value), m.generation, layout.current)) return;
    const expected = { target, targetGeneration: current.targetGeneration, paneInstance: m.pane, pointerLease: lease };
    // An old producer cannot gain a newer generation at delivery: isCurrent captures its calculation generation.
    if (m.generation < layout.current) return;
    if (m.generation > layout.current) {
      if (!reader.registerReferenceLayout(expected, { layoutMeasurementGeneration: m.generation, paneWidth: m.width,
        paneHeight: m.height, dpr: m.dpr, zoom: current.zoom })) return;
      layout.current = m.generation; accepted.current = expected; registration.current.expected = expected;
    }
    if (!reader.setReferenceViewport({ expected, layoutMeasurementGeneration: m.generation, paneWidth: m.width,
      paneHeight: m.height, dpr: m.dpr, requestedZoom: current.zoom, metrics: m.metrics })) return;
    if (!m.isCurrent() || reader.getSnapshot().reference.zoom !== current.zoom) return;
    const prior = measured.current;
    if (landing.current !== current.landingId) {
      landing.current = current.landingId; held.current = current.place; settledView.current = null;
      pending.current = { kind: 'place', place: current.place };
    } else if (prior && (prior.width !== m.width || prior.height !== m.height) && pending.current?.kind !== 'zoom') {
      // Recover a native scroll whose notification arrived after the old draw became stale.
      // Only position is reconstructed; all current-producer and identity checks above remain required.
      if (!pending.current) held.current = placeBeforeReferenceResize(held.current, settledView.current, {
        top: m.pane.scrollTop, left: m.pane.scrollLeft,
        maxTop: Math.max(0, m.pane.scrollHeight - m.pane.clientHeight), maxLeft: Math.max(0, m.pane.scrollWidth - m.pane.clientWidth),
      });
      pending.current = { kind: 'place', place: held.current };
    }
    measured.current = m;
    const intent = pending.current;
    if (!intent || !m.isCurrent()) return;
    const view = measureReaderPane(m.pane);
    if (!view || !(view.page.width > 0 && view.page.height > 0)) return;
    const decision = referenceRestoreDecision(intent, m.isSettled());
    if (decision.apply === 'anchor' && intent.kind === 'zoom' && intent.anchor) {
      const surface = m.pane.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]');
      if (!surface) return;
      const delta = scrollDeltaForZoomAnchor(intent.anchor, surface.getBoundingClientRect());
      m.pane.scrollLeft += delta.left; m.pane.scrollTop += delta.top;
    } else if (decision.apply === 'place' && intent.kind === 'place') {
      const at = intent.place ? scrollForPlace(intent.place, view) : { top: 0, left: 0 };
      m.pane.scrollTop = at.top; m.pane.scrollLeft = at.left;
    }
    if (decision.consume && pending.current === intent && m.isCurrent()) {
      pending.current = null;
      const after = measureReaderPane(m.pane), at = after && readingPlace(after);
      if (at) { held.current = at; settledView.current = after; reader.rememberReference(expected, at); }
    }
  }, [reader, paneRef, lease, state.targetGeneration, state.target]);
  useLayoutEffect(() => {
    const owned = registration.current;
    return () => { const expected = owned.expected; if (expected) reader.releaseReferencePane(expected);
      if (registration.current === owned) { accepted.current = null; measured.current = null; settledView.current = null; } };
  }, [reader, lease]);
  useLayoutEffect(() => {
    const pane = paneRef.current; if (!pane) return;
    const scroll = () => { const expected = accepted.current, view = measureReaderPane(pane), at = view && readingPlace(view);
      if (expected && at && !pending.current && measured.current?.isCurrent() && measured.current.isSettled()) { held.current = at; settledView.current = view; reader.rememberReference(expected, at); } };
    pane.addEventListener('scroll', scroll, { passive: true }); return () => pane.removeEventListener('scroll', scroll);
  });
  const prepareZoom = (point?: { x: number; y: number }, pointerOwned = false) => {
    const pane = paneRef.current, surface = pane?.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]');
    if (!pane || !surface) return false;
    const rect = surface.getBoundingClientRect(), frame = pane.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const x = point?.x ?? frame.left + pane.clientWidth / 2, y = point?.y ?? Math.max(frame.top, rect.top);
    if (![x, y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return false;
    pending.current = { kind: 'zoom', anchor: pointerOwned ? null : { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, atX: x, atY: y } };
    return true;
  };
  const resolvePort = (): (ReaderCommandPort & { continueGesture(value: number): void; canContinueGesture(): boolean }) | null => {
    const expectation = accepted.current;
    return expectation ? {
    getSnapshot: () => ({ active: reader.referenceMatches(expectation), blocked: !referenceInputReady(reader.referenceMatches(expectation), latestAllowed.current(), !!measured.current?.isCurrent(), !!measured.current?.isSettled()),
      zoom: reader.getSnapshot().reference.zoom.kind === 'fit-page' ? 0 : (reader.getSnapshot().reference.zoom as { kind: 'scale'; value: number }).value,
      actualZoom: reader.referenceActualZoom, minimumZoom: reader.referenceMinimumZoom }),
    canContinueGesture: () => referenceGestureContinues(reader.referenceMatches(expectation), paneRef.current === expectation.paneInstance, true, latestAllowed.current()),
    continueGesture: value => {
      if (referenceGestureContinues(reader.referenceMatches(expectation), paneRef.current === expectation.paneInstance, true, latestAllowed.current()) && prepareZoom()) reader.setReferenceZoom(expectation,
        value === 0 ? { kind: 'fit-page' } : { kind: 'scale', value }, true);
    },
    dispatch: command => {
      if (!latestAllowed.current() || !measured.current?.isCurrent() || !measured.current?.isSettled() || !reader.referenceMatches(expectation)) return { status: 'blocked' };
      const value = command.type === 'zoom' ? command.value : command.type === 'zoom-reset' ? 0
        : command.type === 'zoom-step' ? reader.referenceActualZoom * (command.steps > 0 ? 1.25 : .8) : NaN;
      if (!Number.isFinite(value)) return { status: 'blocked' };
      if (!prepareZoom(command.type === 'zoom' ? command.anchor : undefined)) return { status: 'blocked' };
      const changed = reader.setReferenceZoom(expectation, value === 0 ? { kind: 'fit-page' } : { kind: 'scale', value });
      if (!changed) pending.current = null;
      return { status: changed ? 'applied' : 'unchanged' };
    },
  } : null;
  };
  const diagnosticPort = useRef(resolvePort); diagnosticPort.current = resolvePort;
  useLayoutEffect(() => {
    const pane = paneRef.current as DiagnosticPane | null; if (!pane) return;
    const getter = (): ReferenceInputSnapshot | null => {
      if (paneRef.current !== pane || accepted.current?.paneInstance !== pane) return null;
      const port = diagnosticPort.current(); if (!port) return null;
      const snapshot = port.getSnapshot();
      return Object.freeze({ active: snapshot.active, blocked: snapshot.blocked, zoom: snapshot.zoom, actualZoom: snapshot.actualZoom });
    };
    pane[referenceInputDiagnostic] = getter;
    return () => { if (pane[referenceInputDiagnostic] === getter) delete pane[referenceInputDiagnostic]; };
  });
  const setGestureZoom = (value: number) => {
    const expected = accepted.current, pane = paneRef.current;
    // Only an already admitted pinch owned by this pane may bypass a later command guard.
    if (!expected || !pane || !referenceGestureContinues(reader.referenceMatches(expected), pane === expected.paneInstance, getPdfPointerOwner(pane) === pane, latestAllowed.current())) return;
    if (!prepareZoom(undefined, true)) return;
    reader.setReferenceZoom(expected, value === 0 ? { kind: 'fit-page' } : { kind: 'scale', value }, true);
  };
  const continuationAllowed = () => { const expected = accepted.current, pane = paneRef.current;
    return !!expected && !!pane && (!getPdfPointerOwner(pane) || getPdfPointerOwner(pane) === pane)
      && referenceGestureContinues(reader.referenceMatches(expected), pane === expected.paneInstance, true, latestAllowed.current()); };
  return { reportMeasurement, resolvePort, setGestureZoom, continuationAllowed, state };
}
