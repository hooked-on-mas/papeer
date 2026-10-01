import { useEffect, useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { useStore } from "@/store";
import { scrollDeltaForZoomAnchor, type ZoomAnchor } from "./readingPlace";
import { beginTouchPinch, moveTouchPinch, type TouchPinch, type TouchPoint } from "./touchZoom";
import { horizontalEdges, touchSwipePage, type PaneEdges } from "./pageTurn";

// Both panes defer their expensive PDF redraw until the fingers lift. The touched pane owns
// scrolling while zoom changes both layouts; the other pane must not send its clamped scroll back.
export const usePdfTouchOwner = create<{ pane: HTMLDivElement | null }>(() => ({ pane: null }));

export function usePdfTouch({ pageKey, enabled, paneRef, surfaceRef, pageWidth, drawnWidth, fitWidth, fitPageWidth, onPageSwipe }: {
  pageKey: string; enabled: boolean;
  paneRef: RefObject<HTMLDivElement | null>; surfaceRef: RefObject<HTMLDivElement | null>;
  pageWidth: number; drawnWidth: number; fitWidth: number; fitPageWidth: number;
  onPageSwipe?: (direction: -1 | 1) => void;
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
  const swipe = useRef<{ x: number; y: number; maxY: number; edges: PaneEdges } | null>(null);

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
    if (next.zoom !== useStore.getState().zoom) flushSync(() => useStore.getState().setZoom(next.zoom));
    restoreAnchor();
  };
  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") { suppressClick.current = false; clearAnchor(); return; }
    if (!enabled || touches.current.size >= 2) return;
    const owner = usePdfTouchOwner.getState().pane;
    if (owner && owner !== e.currentTarget) return;
    if (!touches.current.size) {
      suppressClick.current = false; clearAnchor();
      swipe.current = { x: e.clientX, y: e.clientY, maxY: 0, edges: horizontalEdges(e.currentTarget) };
    } else swipe.current = null; // A pinch can never turn into a page swipe, even after one finger lifts.
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    const page = surfaceRef.current;
    if (touches.current.size !== 2 || !page) return;
    const [a, b] = [...touches.current.values()];
    pinch.current = beginTouchPinch(a, b, page.getBoundingClientRect(), pageWidth / fitWidth, fitPageWidth / fitWidth);
    for (const id of touches.current.keys()) e.currentTarget.setPointerCapture(id);
    suppressClick.current = true;
    usePdfTouchOwner.setState({ pane: e.currentTarget });
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
      if (swipe.current) swipe.current.maxY = Math.max(swipe.current.maxY, Math.abs(e.clientY - swipe.current.y));
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
    const gesture = swipe.current;
    const turn = e.type === "pointerup" && gesture
      ? touchSwipePage(e.clientX - gesture.x, Math.max(gesture.maxY, Math.abs(e.clientY - gesture.y)), gesture.edges) : 0;
    swipe.current = null;
    applyPinch();
    touches.current.delete(e.pointerId);
    panning.current.delete(e.pointerId);
    pinch.current = null;
    if (wasPinching) {
      const pane = paneRef.current;
      const { pageWidth: width, drawnWidth: drawn } = layout.current;
      if (width === drawn || !pane) clearAnchor();
      else pendingRedraw.current = { width, top: pane.scrollTop, left: pane.scrollLeft };
    }
    if (usePdfTouchOwner.getState().pane === e.currentTarget) usePdfTouchOwner.setState({ pane: null });
    // Resume one-finger panning without jumping back to the original down position.
    for (const [id, point] of touches.current) touches.current.set(id, { ...point, startX: point.x, startY: point.y });
    if (turn) { suppressClick.current = true; onPageSwipe?.(turn); }
  };

  useEffect(() => {
    const pane = paneRef.current;
    const reset = () => {
      cancelFrame();
      pinch.current = null; swipe.current = null; clearAnchor();
      for (const id of touches.current.keys()) if (pane?.hasPointerCapture(id)) pane.releasePointerCapture(id);
      touches.current.clear(); panning.current.clear();
      if (usePdfTouchOwner.getState().pane === pane) usePdfTouchOwner.setState({ pane: null });
    };
    window.addEventListener("blur", reset);
    return () => { window.removeEventListener("blur", reset); reset(); };
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
