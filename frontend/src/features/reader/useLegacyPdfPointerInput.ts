// TODO M6: remove with legacy reader migration.
import { useEffect, useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { scopeOf, claim, getPdfPointerOwner } from "./input/pdfPointerOwner";
export { usePdfTouchOwner, getPdfPointerOwner } from "./input/pdfPointerOwner";
import { scrollDeltaForZoomAnchor, type ZoomAnchor } from "./navigation/readingPlace";
import { beginTouchPinch, moveTouchPinch, type TouchPinch, type TouchPoint } from "./input/touchZoom";
import { createTouchSwipe } from "./input/touchSwipe";
import { horizontalEdges } from "./navigation/pageTurn";


const contactPanes = new Map<HTMLElement, Set<HTMLDivElement>>();
/** Admission inventory for the existing touch gesture; it does not claim a second input owner. */
export const hasPdfPointerContact = (element: HTMLElement | null) => !!element && !!contactPanes.get(scopeOf(element))?.size;
function recordContact(pane: HTMLDivElement, active: boolean) {
  if (active) {
    const scope = scopeOf(pane), panes = contactPanes.get(scope) ?? new Set<HTMLDivElement>();
    panes.add(pane); contactPanes.set(scope, panes);
  } else for (const [scope, panes] of contactPanes) {
    // Cleanup can run after detachment, when closest(reader-root) no longer finds the registration scope.
    panes.delete(pane); if (!panes.size) contactPanes.delete(scope);
  }
}

export function usePdfPointerInput({ pageKey, enabled, paneRef, surfaceRef, pageWidth, drawnWidth, fitWidth, fitPageWidth, onPageSwipe, zoom, allowTouch }: {
  pageKey: string; enabled: boolean;
  paneRef: RefObject<HTMLDivElement | null>; surfaceRef: RefObject<HTMLDivElement | null>;
  pageWidth: number; drawnWidth: number; fitWidth: number; fitPageWidth: number;
  allowTouch?: () => boolean;
  onPageSwipe?: (direction: -1 | 1) => void;
  /** Whose zoom a pinch changes: the PDF's, or the notebook's own. */
  zoom: { get(): number; set(value: number): void };
}) {
  const touches = useRef(new Map<number, TouchPoint & { startX: number; startY: number }>());
  const panning = useRef(new Set<number>());
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
    const [a, b] = [...touches.current.values()];
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

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") { suppressClick.current = false; clearAnchor(); return; }
    if (!enabled || allowTouch?.() === false || touches.current.size >= 2) return;
    const owner = getPdfPointerOwner(e.currentTarget);
    if (owner && owner !== e.currentTarget) return;
    if (!touches.current.size) {
      suppressClick.current = false; clearAnchor();
      swipe.current.start(e.clientX, e.clientY, horizontalEdges(e.currentTarget));
    } else swipe.current.cancel(); // A pinch can never turn into a page swipe, even after one finger lifts.
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    recordContact(e.currentTarget, true);
    const page = surfaceRef.current;
    if (touches.current.size !== 2 || !page) return;
    const [a, b] = [...touches.current.values()];
    pinch.current = beginTouchPinch(a, b, page.getBoundingClientRect(), pageWidth / fitWidth, fitPageWidth / fitWidth);
    for (const id of touches.current.keys()) e.currentTarget.setPointerCapture(id);
    suppressClick.current = true;
    claim(e.currentTarget, true);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    const previous = touches.current.get(e.pointerId);
    if (!previous) return;
    touches.current.set(e.pointerId, { ...previous, x: e.clientX, y: e.clientY });
    if (pinch.current) {
      if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; applyPinch(); });
    } else if (touches.current.size === 1) {
      swipe.current.move(e.clientY);
      const dx = e.clientX - previous.x, dy = e.clientY - previous.y;
      if (Math.hypot(e.clientX - previous.startX, e.clientY - previous.startY) >= 5) panning.current.add(e.pointerId);
      if (panning.current.has(e.pointerId) && (dx || dy)) {
        clearAnchor();
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.scrollBy(-dx, -dy);
        suppressClick.current = true;
      }
    }
    if (e.cancelable) e.preventDefault();
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch" || !touches.current.has(e.pointerId)) return;
    cancelFrame();
    const wasPinching = pinch.current !== null;
    const turn = e.type === "pointerup" ? swipe.current.finish(e.clientX, e.clientY) : 0;
    swipe.current.cancel();
    applyPinch();
    touches.current.delete(e.pointerId);
    if (!touches.current.size) recordContact(e.currentTarget, false);
    panning.current.delete(e.pointerId);
    pinch.current = null;
    if (wasPinching) {
      const pane = paneRef.current;
      const { pageWidth: width, drawnWidth: drawn } = layout.current;
      if (width === drawn || !pane) clearAnchor();
      else pendingRedraw.current = { width, top: pane.scrollTop, left: pane.scrollLeft };
    }
    claim(e.currentTarget, false);
    // Resume one-finger panning without jumping back to the original down position.
    for (const [id, point] of touches.current) touches.current.set(id, { ...point, startX: point.x, startY: point.y });
    if (turn) { suppressClick.current = true; onPageSwipe?.(turn); }
  };

  useEffect(() => {
    const pane = paneRef.current;
    const reset = () => {
      cancelFrame();
      pinch.current = null; swipe.current.cancel(); clearAnchor();
      for (const id of touches.current.keys()) if (pane?.hasPointerCapture(id)) pane.releasePointerCapture(id);
      touches.current.clear(); panning.current.clear();
      if (pane) { claim(pane, false); recordContact(pane, false); }
    };
    window.addEventListener("resize", reset);
    window.addEventListener("blur", reset);
    return () => { window.removeEventListener("blur", reset); window.removeEventListener("resize", reset); reset(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancel on page changes and unmount
  }, [pageKey, enabled]);

  return {
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
    onLostPointerCapture: (e: PointerEvent<HTMLDivElement>) => {
      // Taking capture from a text span also bubbles its lost event through the pane.
      if (e.target === e.currentTarget && !e.currentTarget.hasPointerCapture(e.pointerId)) onPointerUp(e);
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
