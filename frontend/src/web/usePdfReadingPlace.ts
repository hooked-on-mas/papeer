import { ReadingLanding } from "../features/reader/ReadingLanding";
import { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { createPlaceKeeper, scrollForPlace, type PaneView, type ReadingPlace } from "../features/reader/navigation/readingPlace";
export type PdfReadingPlacePort = {
  get: (key: string, page: number) => ReadingPlace | undefined;
  remember: (key: string, page: number, place: ReadingPlace) => void;
  flush: (key: string) => void;
};

function paneView(pane: HTMLElement, surface: HTMLElement): PaneView {
  const frame = pane.getBoundingClientRect(), box = surface.getBoundingClientRect();
  return { scrollTop: pane.scrollTop, scrollLeft: pane.scrollLeft, clientWidth: pane.clientWidth, clientHeight: pane.clientHeight,
    page: { top: box.top - frame.top - pane.clientTop + pane.scrollTop, left: box.left - frame.left - pane.clientLeft + pane.scrollLeft,
      width: box.width, height: box.height } };
}

type Layout = { key: string; storageKey?: string; page: number; fitPage: boolean; width: number; pageWidth: number; ready: boolean };

/** Keep a page's passage across width changes, pane remounts and offline restarts. */
export function usePdfReadingPlace(container: RefObject<HTMLDivElement | null>, layout: Layout, onWidth: (width: number) => void, persistence?: PdfReadingPlacePort, positionEnabled = true) {
  const landing = useContext(ReadingLanding);
  const keeper = useMemo(createPlaceKeeper, []);
  const current = useRef<Layout>({ ...layout, key: "" });
  const pending = useRef<{ key: string; place: ReadingPlace } | null>(null);
  const resume = useRef<{ key: string; place: ReadingPlace } | null>(null);
  const lastView = useRef<{ key: string; pageWidth: number; view: PaneView } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const remember = useCallback((view: PaneView) => {
    const state = current.current;
    if (!positionEnabled || !state.storageKey || !state.ready || state.fitPage || pending.current || resume.current) return;
    const point = keeper.measure(state.key, view, state.pageWidth);
    if (!point) return;
    persistence?.remember(state.storageKey, state.page, point);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => persistence?.flush(state.storageKey!), 300);
  }, [keeper, persistence, positionEnabled]);
  const { key, storageKey, page, fitPage, width, pageWidth, ready } = layout;
  const landingKey = JSON.stringify([storageKey ?? key, page]);
  useLayoutEffect(() => {
    const previous = current.current;
    current.current = { key, storageKey, page, fitPage, width, pageWidth, ready };
    if (!positionEnabled) {
      pending.current = null; resume.current = null; lastView.current = null; keeper.reset(); clearTimeout(timer.current);
      return;
    }
    if (key !== previous.key) {
      pending.current = null; lastView.current = null; keeper.reset();
      const saved = (landing && !landing.consumed.has(landingKey)) || (landing === undefined && previous.key && previous.storageKey === storageKey && previous.page !== page) ? { x: 0, y: landing?.toEnd ? 1 : 0 }
        : !fitPage && storageKey ? persistence?.get(storageKey, page) : undefined;
      resume.current = !fitPage ? { key, place: saved ?? { x: 0, y: 0 } } : null;
    }
    if (fitPage) { pending.current = null; resume.current = null; lastView.current = null; keeper.reset(); }
    const root = container.current, pane = root?.closest<HTMLElement>(".web-pdf-pane");
    const surface = root?.querySelector<HTMLElement>(".web-pdf-surface");
    if (!pane || !surface) return;
    const restore = resume.current ?? pending.current;
    // Wait for the actual page's aspect ratio and current canvas, not a placeholder.
    if (restore?.key === key && ready && !fitPage) {
      resume.current = null; pending.current = null;
      const scroll = scrollForPlace(restore.place, paneView(pane, surface));
      pane.scrollTo(scroll.left, scroll.top);
      keeper.restored(key, restore.place, paneView(pane, surface), pageWidth);
    }
    if (ready) landing?.consumed.add(landingKey);
    const view = paneView(pane, surface);
    lastView.current = { key, pageWidth, view }; remember(view);
  }, [container, key, storageKey, page, fitPage, width, pageWidth, ready, keeper, remember, landing, landingKey, persistence, positionEnabled]);
  useEffect(() => {
    const root = container.current, pane = root?.closest<HTMLElement>(".web-pdf-pane");
    if (!root) return;
    let previousPaneWidth = pane?.clientWidth ?? 0, measured = false;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(1, entry.contentRect.width), state = current.current;
      const surface = root.querySelector<HTMLElement>(".web-pdf-surface");
      if (positionEnabled && measured && nextWidth !== state.width && !state.fitPage && !resume.current && pane && surface?.querySelector("canvas")) {
        const saved = lastView.current;
        // Widening can clamp scrollLeft before ResizeObserver; keep the earlier view.
        const before = saved?.key === state.key && saved.pageWidth === state.pageWidth ? saved.view
          : { ...paneView(pane, surface), clientWidth: previousPaneWidth };
        const place = keeper.measure(state.key, before, state.pageWidth);
        if (place) pending.current = { key: state.key, place };
      }
      previousPaneWidth = pane?.clientWidth ?? 0; measured = true; onWidth(nextWidth);
    });
    const scroll = () => {
      const state = current.current, saved = lastView.current;
      if (!pane || pending.current || resume.current || (saved && saved.view.clientWidth !== pane.clientWidth)) return;
      const surface = root.querySelector<HTMLElement>(".web-pdf-surface");
      if (surface && !surface.style.transform) {
        const view = paneView(pane, surface);
        lastView.current = { key: state.key, pageWidth: state.pageWidth, view }; remember(view);
      }
    };
    // The viewport supplies base width; the PDF itself grows with zoom for sticky tools.
    observer.observe(pane ?? root.parentElement ?? root);
    if (positionEnabled) pane?.addEventListener("scroll", scroll, { passive: true });
    return () => { observer.disconnect(); pane?.removeEventListener("scroll", scroll); };
  }, [container, onWidth, keeper, remember, positionEnabled]);
  useEffect(() => {
    if (!positionEnabled || !storageKey) return;
    const flush = () => { clearTimeout(timer.current); persistence?.flush(storageKey); };
    const visibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", visibility);
    return () => { flush(); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", visibility); };
  }, [storageKey, persistence, positionEnabled]);
}
