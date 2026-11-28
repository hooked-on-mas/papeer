import { useCallback, useEffect, useRef, type RefObject } from "react";
import { READER_SCROLL_INTENT, readerShortcutCommand, type ReaderCommandPort } from "../navigation/readerCommands";
import { createReaderWheelPager, horizontalEdges, keyTarget, onScreen, paneEdges, readerKeyAction, readerOwnsKey, type KeyPlace } from "../navigation/pageTurn";
import { continuousZoom, pinchLevel, pinchStart } from "../zoomLevels";
import { isImeKey } from "@/lib/imeKeys";
import { routeReaderSelectionKey, type ReaderSelectionKeyPort } from './readerSelectionKeys';
import type { CanonicalManagedInputBundle } from './canonicalManagedInput';

/**
 * What the PDF reader and the notebook share in taking the pointer and the keyboard: the wheel turning
 * pages at the page's end, Ctrl+wheel and pinch zooming, the paging keys, and the pane the pointer was
 * last in. `panes` are the scrolling panes inside `rootRef`, the first one the left; the wheel and the
 * keys act on the one the pointer was last over. `wheelTurns` says whether scrolling on past the end of a
 * page may turn it now (not while writing, where a stray wheel movement should not take the page away).
 * `resetKey` (the open item) starts the listeners over, as the root is there only once an item is open.
 * Commands and current availability are supplied by the mounted document's host.
 */
export function useReaderInput({ rootRef, panes, wheelTurns, resetKey, commands, safariGestures = true, selectionKeyPort, pointerContacts, inputBundle, referenceInput, nativeGestureActive }: {
  inputBundle: CanonicalManagedInputBundle;
  nativeGestureActive?: (active: boolean) => void;
  referenceInput?: { paneRef: RefObject<HTMLElement | null>; resolve(): (ReaderCommandPort & { continueGesture?(value: number): void; canContinueGesture?(): boolean }) | null };
  rootRef: RefObject<HTMLElement | null>;
  panes: RefObject<HTMLElement | null>[];
  wheelTurns: () => boolean;
  resetKey: unknown;
  commands: ReaderCommandPort;
  /** Disable when a surface adapter already owns Safari's GestureEvent stream. */
  safariGestures?: boolean;
  selectionKeyPort?: ReaderSelectionKeyPort;
  /** Canonical composition supplies the existing pointer-hook inventory query.
   * Legacy callers alone retain the local safety Set until M6 removes them. */
  pointerContacts?: { hasContact(): boolean };
}): { ownsKey: (e: KeyboardEvent) => boolean } {
  const reference = useRef(referenceInput); reference.current = referenceInput;
  const gestureActivity = useRef(nativeGestureActive); gestureActivity.current = nativeGestureActive;
  const isReferenceTarget = useCallback((target: EventTarget | null): boolean => {
    const pane = reference.current?.paneRef.current;
    const section = pane?.closest('[data-reader-reference]');
    return target instanceof Node && (!!pane?.contains(target) || !!section?.contains(target)
      || target instanceof Element && !!target.closest('[data-reader-reference]'));
  }, []);
  const referenceFor = useCallback((target: EventTarget | null): ReaderCommandPort | null =>
    isReferenceTarget(target) ? reference.current?.resolve() ?? null : null, [isReferenceTarget]);
  const paneRefs = useRef(panes);
  paneRefs.current = panes;
  const turns = useRef(wheelTurns);
  turns.current = wheelTurns;
  const port = useRef(commands);
  port.current = commands;
  const selectionKeys = useRef(selectionKeyPort); selectionKeys.current = selectionKeyPort;
  const contactPort = useRef(pointerContacts); contactPort.current = pointerContacts;
  // The pane the pointer was last over (an index into `panes`), which the paging keys scroll.
  const activePane = useRef(0);
  // A held pen, mouse selection or finger stroke keeps the page it started on. This also
  // protects in-page keyboard scrolling, which does not dispatch a navigation command.
  const contacts = useRef(new Set<number>());
  const hasContact = useCallback(() => contactPort.current ? contactPort.current.hasContact() : contacts.current.size > 0, []);
  // The pane to scroll and to judge the page's end by: `preferred`, unless it shows no page (a
  // translation still pending, say) and the other one does.
  const readingPane = useCallback((preferred: number) => {
    const [left, right] = paneRefs.current.map((ref) => ref.current);
    const [first, second] = preferred === 1 ? [right, left] : [left, right];
    const hasPage = (pane: HTMLElement | null | undefined) => !!pane?.querySelector(".react-pdf__Page");
    return !hasPage(first) && hasPage(second) ? second : first ?? second;
  }, []);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    // Scale the pinch is heading for; the zoom snaps to the nearest preset on the way.
    let pinchTarget = 1;
    let lastPinch = 0;
    // Safari's engine (WKWebView, macOS) reports a touchpad pinch as gesture events whose scale is from
    // the pinch's start, not as Ctrl+wheel; the zoom the pinch started from while one is under way.
    let gestureStart: number | null = null;
    let gesturePort: (ReaderCommandPort & { continueGesture?(value: number): void; canContinueGesture?(): boolean }) | null = null;
    let gestureRejected = false;
    const pager = createReaderWheelPager();
    const onWheel = (e: WheelEvent) => {
      const isReference = isReferenceTarget(e.target);
      const selected = isReference ? referenceFor(e.target) : port.current;
      if (isReference && !selected) { if (e.cancelable) e.preventDefault(); return; }
      const commandPort = selected ?? port.current;
      const state = commandPort.getSnapshot();
      if (e.defaultPrevented || !state.active || !onScreen(element)) return;
      if (state.blocked || hasContact()) { if (e.cancelable) e.preventDefault(); return; }
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      // A mouse notch is a single large vertical step; touchpads send small, often diagonal ones.
      const mouseWheel = dx === 0 && Math.abs(dy) >= 50;

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+wheel, and touchpad pinch, which arrives as Ctrl+wheel, zoom both panes together.
        e.preventDefault();
        if (gestureStart !== null) return; // The pinch's gesture events zoom already.
        if (state.actualZoom !== undefined && state.minimumZoom !== undefined && state.actualZoom > 0 && state.minimumZoom > 0) {
          const value = continuousZoom(state.actualZoom, Math.exp(-dy / 100), state.minimumZoom);
          if (value !== state.actualZoom) commandPort.dispatch({ type: 'zoom', value, anchor: { x: e.clientX, y: e.clientY } });
          return;
        }
        if (mouseWheel) {
          commandPort.dispatch({ type: "zoom-step", steps: dy < 0 ? 1 : -1 });
          return;
        }
        // Pinch deltas follow scale = exp(-deltaY / 100) and are only a few pixels each.
        const zoom = state.zoom;
        if (e.timeStamp - lastPinch > 300) pinchTarget = pinchStart(zoom);
        lastPinch = e.timeStamp;
        const pinch = pinchLevel(pinchTarget * Math.exp(-dy / 100));
        pinchTarget = pinch.scale;
        if (pinch.level !== zoom) commandPort.dispatch({ type: "zoom", value: pinch.level });
        return;
      }

      const index = paneRefs.current.findIndex((ref) => ref.current?.contains(e.target as Node));
      const pane = paneRefs.current[index]?.current;
      if (!pane) return;
      activePane.current = index;
      // Scrolling on past the end of the page turns it, except while writing on the page, where a
      // stray wheel movement should not take the page away.
      if (!isReference && !e.shiftKey && (dx !== 0 || dy !== 0) && turns.current()) {
        const { turn, swallow, axis } = pager({ dx, dy, time: e.timeStamp, notch: mouseWheel,
          horizontal: horizontalEdges(pane), vertical: paneEdges(readingPane(activePane.current) ?? pane) });
        if (turn) {
          if (e.cancelable) e.preventDefault();
          commandPort.dispatch({ type: "step", amount: turn, toEnd: axis === "vertical" && turn < 0 });
          return;
        }
        if (swallow) {
          if (e.cancelable) e.preventDefault();
          return;
        }
      }

      // Touchpad swipes can latch onto the window rather than the PDF under the pointer,
      // so scroll that pane directly. Non-cancelable events belong to a native scroll already under way.
      if (mouseWheel || !e.cancelable) return;
      e.preventDefault();
      pane.scrollBy(e.shiftKey && dx === 0 ? dy : dx, e.shiftKey && dx === 0 ? 0 : dy);
    };
    const onGestureStart = (e: Event) => {
      gestureActivity.current?.(true);
      const target = e.target instanceof Node && e.target !== element && element.contains(e.target) ? e.target : document.activeElement;
      const isReference = isReferenceTarget(target);
      const selected = isReference ? referenceFor(target) : port.current;
      gesturePort = selected; gestureStart = null; gestureRejected = true;
      if (!selected) return;
      const state = selected.getSnapshot();
      if (!state.active || state.blocked || hasContact() || !onScreen(element)) return;
      e.preventDefault();
      gestureStart = state.actualZoom !== undefined && state.minimumZoom !== undefined && state.actualZoom > 0 && state.minimumZoom > 0
        ? state.actualZoom : pinchStart(state.zoom);
      gestureRejected = false;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale;
      if (gestureRejected || gestureStart === null || !gesturePort || typeof scale !== "number" || !(scale > 0)) return;
      const state = gesturePort.getSnapshot();
      if (!state.active || (!gesturePort.continueGesture && state.blocked) || (gesturePort.continueGesture && !gesturePort.canContinueGesture?.()) || hasContact()) { gestureRejected = true; return; }
      if (state.actualZoom !== undefined && state.minimumZoom !== undefined && state.actualZoom > 0 && state.minimumZoom > 0) {
        const value = continuousZoom(gestureStart, scale, state.minimumZoom);
        if (value !== state.actualZoom) { if (gesturePort.continueGesture) gesturePort.continueGesture(value); else gesturePort.dispatch({ type: 'zoom', value }); }
      } else {
        const pinch = pinchLevel(gestureStart * scale);
        if (pinch.level !== state.zoom) { if (gesturePort.continueGesture) gesturePort.continueGesture(pinch.level); else gesturePort.dispatch({ type: "zoom", value: pinch.level }); }
      }
    };
    const clearGesture = () => { gestureStart = null; gesturePort = null; gestureRejected = false; gestureActivity.current?.(false); };
    const onGestureEnd = (e: Event) => { e.preventDefault(); clearGesture(); };
    window.addEventListener('blur', clearGesture); window.addEventListener('pagehide', clearGesture);
    element.addEventListener("wheel", onWheel, { passive: false });
    if (safariGestures) {
      element.addEventListener("gesturestart", onGestureStart);
      element.addEventListener("gesturechange", onGestureChange);
      element.addEventListener("gestureend", onGestureEnd);
      element.addEventListener("gesturecancel", onGestureEnd);
    }
    return () => {
      clearGesture(); window.removeEventListener('blur', clearGesture); window.removeEventListener('pagehide', clearGesture);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
      element.removeEventListener("gesturecancel", onGestureEnd);
    };
  }, [resetKey, rootRef, readingPane, safariGestures, hasContact, isReferenceTarget, referenceFor]);

  // Whether the last click was in the reader, and in which pane, for the keys below.
  const pointerInReader = useRef(false);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      pointerInReader.current = !!target && !!rootRef.current?.contains(target);
      const index = target ? paneRefs.current.findIndex((ref) => ref.current?.contains(target)) : -1;
      if (index >= 0) {
        activePane.current = index;
        if (!contactPort.current) contacts.current.add(e.pointerId);
      }
    };
    const onPointerUp = (e: PointerEvent) => { contacts.current.delete(e.pointerId); };
    const reset = () => { contacts.current.clear(); };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("blur", reset);
    return () => {
      reset(); window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("blur", reset);
    };
  }, [rootRef, resetKey, inputBundle]);
  // Whether a key press is the reader's (see readerOwnsKey); the search's F3 follows it too.
  const ownsKey = useCallback((e: KeyboardEvent) => {
    const root = rootRef.current;
    if (!root || document.querySelector("[data-lightbox]")) return false;
    const target = e.target instanceof Element ? e.target : null;
    const place: KeyPlace = target && root.contains(target) ? "inside" : !target || target.contains(root) ? "around" : "elsewhere";
    const readerVisible = port.current.getSnapshot().active && onScreen(root);
    return readerOwnsKey({ place, pointerInReader: pointerInReader.current, readerVisible });
  }, [rootRef]);

  // The paging keys (see readerKeyAction), never taken from a text field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || !ownsKey(e)) return;
      // One invocation at the existing window BUBBLE entry. Capture zoom never
      // calls this port. A selection refusal must not fall through into paging.
      const refPane = reference.current?.paneRef.current;
      const isReference = isReferenceTarget(e.target);
      if (isReference) {
        const selected = referenceFor(e.target), target = e.target instanceof Element ? e.target : null;
        if (keyTarget(target) === 'editable') return;
        const shortcut = readerShortcutCommand(e, keyTarget(target));
        if (shortcut?.type === 'zoom-step' || shortcut?.type === 'zoom-reset') {
          e.preventDefault(); if (selected && !selected.getSnapshot().blocked && !hasContact()) selected.dispatch(shortcut); return;
        }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
          e.preventDefault(); if (!selected || selected.getSnapshot().blocked || hasContact() || !refPane) return;
          if (e.key === 'Home') refPane.scrollTo({ top: 0 });
          else if (e.key === 'End') refPane.scrollTo({ top: refPane.scrollHeight });
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') refPane.scrollBy({ left: e.key === 'ArrowLeft' ? -40 : 40 });
          else refPane.scrollBy({ top: (e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1) * (e.key.startsWith('Page') ? refPane.clientHeight * .9 : 40) });
          return;
        }
        return;
      }
      if (routeReaderSelectionKey(e, selectionKeys.current)) return;
      const blocked = port.current.getSnapshot().blocked || hasContact();
      const target = e.target instanceof Element ? e.target : null;
      const shortcut = readerShortcutCommand(e, keyTarget(target));
      if (shortcut) { e.preventDefault(); if (!blocked) port.current.dispatch(shortcut); return; }
      const pane = readingPane(activePane.current);
      const action = readerKeyAction({
        key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
        target: keyTarget(target), ...(pane ? paneEdges(pane) : { atStart: true, atEnd: true }),
      });
      if (!action) return;
      e.preventDefault();
      if (blocked) return;
      if (action.type === "scroll") {
        if (pane) {
          pane.dispatchEvent(new Event(READER_SCROLL_INTENT, { bubbles: true }));
          pane.scrollBy({ top: action.direction * pane.clientHeight * 0.9 });
        }
      }
      else if (action.type === "turn") port.current.dispatch({ type: "step", amount: action.amount, toEnd: action.toEnd });
      else if (action.type === "edge") port.current.dispatch({ type: "edge", edge: action.edge });
      else port.current.dispatch({ type: "history", direction: action.direction });
    };
    // The desktop shell cancels native webview zoom on window bubble. Claim only reader zoom
    // shortcuts earlier; ordinary arrows remain in bubble so an ink editor can keep its own keys.
    const onZoomKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || !ownsKey(e)) return;
      const command = readerShortcutCommand(e, keyTarget(e.target instanceof Element ? e.target : null));
      if (command?.type !== "zoom-step" && command?.type !== "zoom-reset") return;
      e.preventDefault();
      const isReference = isReferenceTarget(e.target);
      const selected = isReference ? referenceFor(e.target) : port.current;
      if (selected && !selected.getSnapshot().blocked && !hasContact()) selected.dispatch(command);
    };
    window.addEventListener("keydown", onZoomKey, true);
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onZoomKey, true); window.removeEventListener("keydown", onKeyDown); };
  }, [ownsKey, readingPane, hasContact, isReferenceTarget, referenceFor]);

  return { ownsKey };
}
