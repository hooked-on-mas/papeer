import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useStore } from "@/store";
import { useNotebookBusy } from "@/features/notebooks/notebooks";
import { changeZoom, historyBack, historyForward, movePage, moveToEdgePage, setZoomOf, zoomOf, type ZoomSubject } from "./navigation";
import { createReaderWheelPager, horizontalEdges, keyTarget, onScreen, paneEdges, readerKeyAction, readerOwnsKey, type KeyPlace } from "./pageTurn";
import { pinchLevel, pinchStart } from "./zoomLevels";
import { isImeKey } from "@/lib/imeKeys";

/**
 * What the PDF reader and the notebook share in taking the pointer and the keyboard: the wheel turning
 * pages at the page's end, Ctrl+wheel and pinch zooming, the paging keys, and the pane the pointer was
 * last in. `panes` are the scrolling panes inside `rootRef`, the first one the left; the wheel and the
 * keys act on the one the pointer was last over. `wheelTurns` says whether scrolling on past the end of a
 * page may turn it now (not while writing, where a stray wheel movement should not take the page away).
 * `resetKey` (the open item) starts the listeners over, as the root is there only once an item is open.
 * `zoomSubject` says whose zoom Ctrl+wheel and pinch change: the PDF's, or the notebook's own.
 */
export function useViewerInput({ rootRef, panes, wheelTurns, resetKey, zoomSubject = "pdf" }: {
  rootRef: RefObject<HTMLElement | null>;
  panes: RefObject<HTMLElement | null>[];
  wheelTurns: () => boolean;
  resetKey: unknown;
  zoomSubject?: ZoomSubject;
}): { ownsKey: (e: KeyboardEvent) => boolean } {
  const paneRefs = useRef(panes);
  paneRefs.current = panes;
  const turns = useRef(wheelTurns);
  turns.current = wheelTurns;
  // The pane the pointer was last over (an index into `panes`), which the paging keys scroll.
  const activePane = useRef(0);
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
    const pager = createReaderWheelPager();
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      // A mouse notch is a single large vertical step; touchpads send small, often diagonal ones.
      const mouseWheel = dx === 0 && Math.abs(dy) >= 50;

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+wheel, and touchpad pinch, which arrives as Ctrl+wheel, zoom both panes together.
        e.preventDefault();
        if (gestureStart !== null) return; // The pinch's gesture events zoom already.
        if (mouseWheel) {
          changeZoom(dy < 0 ? 1 : -1, zoomSubject);
          return;
        }
        // Pinch deltas follow scale = exp(-deltaY / 100) and are only a few pixels each.
        const zoom = zoomOf(zoomSubject);
        if (e.timeStamp - lastPinch > 300) pinchTarget = pinchStart(zoom);
        lastPinch = e.timeStamp;
        const pinch = pinchLevel(pinchTarget * Math.exp(-dy / 100));
        pinchTarget = pinch.scale;
        if (pinch.level !== zoom) setZoomOf(zoomSubject, pinch.level);
        return;
      }

      const index = paneRefs.current.findIndex((ref) => ref.current?.contains(e.target as Node));
      const pane = paneRefs.current[index]?.current;
      if (!pane) return;
      activePane.current = index;
      // Scrolling on past the end of the page turns it, except while writing on the page, where a
      // stray wheel movement should not take the page away.
      if (!e.shiftKey && (dx !== 0 || dy !== 0) && turns.current()) {
        const { turn, swallow, axis } = pager({ dx, dy, time: e.timeStamp, notch: mouseWheel,
          horizontal: horizontalEdges(pane), vertical: paneEdges(readingPane(activePane.current) ?? pane) });
        if (turn) {
          if (e.cancelable) e.preventDefault();
          movePage(turn, { toEnd: axis === "vertical" && turn < 0 });
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
      e.preventDefault();
      gestureStart = pinchStart(zoomOf(zoomSubject));
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale;
      if (gestureStart === null || typeof scale !== "number" || !(scale > 0)) return;
      const pinch = pinchLevel(gestureStart * scale);
      if (pinch.level !== zoomOf(zoomSubject)) setZoomOf(zoomSubject, pinch.level);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureStart = null;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
    };
  }, [resetKey, rootRef, readingPane, zoomSubject]);

  // Whether the last click was in the reader, and in which pane, for the keys below.
  const pointerInReader = useRef(false);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      pointerInReader.current = !!target && !!rootRef.current?.contains(target);
      const index = target ? paneRefs.current.findIndex((ref) => ref.current?.contains(target)) : -1;
      if (index >= 0) activePane.current = index;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [rootRef]);
  // Whether a key press is the reader's (see readerOwnsKey); the search's F3 follows it too.
  const ownsKey = useCallback((e: KeyboardEvent) => {
    const root = rootRef.current;
    if (!root || document.querySelector("[data-lightbox]")) return false;
    const target = e.target instanceof Element ? e.target : null;
    const place: KeyPlace = target && root.contains(target) ? "inside" : !target || target.contains(root) ? "around" : "elsewhere";
    const readerVisible = useStore.getState().activeTab === "reader" && onScreen(root);
    return readerOwnsKey({ place, pointerInReader: pointerInReader.current, readerVisible });
  }, [rootRef]);

  // The paging keys (see readerKeyAction), never taken from a text field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isImeKey(e) || !ownsKey(e) || useNotebookBusy.getState().ids.includes(useStore.getState().activePaperId ?? "")) return;
      const target = e.target instanceof Element ? e.target : null;
      const pane = readingPane(activePane.current);
      const action = readerKeyAction({
        key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
        target: keyTarget(target), ...(pane ? paneEdges(pane) : { atStart: true, atEnd: true }),
      });
      if (!action) return;
      e.preventDefault();
      if (action.type === "scroll") pane?.scrollBy({ top: action.direction * pane.clientHeight * 0.9 });
      else if (action.type === "turn") movePage(action.amount, { toEnd: action.toEnd });
      else if (action.type === "edge") moveToEdgePage(action.edge);
      else if (action.direction === "back") historyBack();
      else historyForward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ownsKey, readingPane]);

  return { ownsKey };
}
