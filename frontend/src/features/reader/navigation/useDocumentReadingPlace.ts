import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { readingPlace, scrollForPlace, scrollDeltaForZoomAnchor, type PaneView, type ReadingPlace, type ZoomAnchor } from './readingPlace';
import type { ReaderPlace, ReaderSession, ReaderState, ReaderViewport } from '../ReaderSession';
import { READER_SCROLL_INTENT } from './readerCommands';

export function measureReaderPane(pane: HTMLElement): PaneView | null {
  const surface = pane.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]');
  if (!surface) return null;
  const frame = pane.getBoundingClientRect(), box = surface.getBoundingClientRect();
  return { scrollTop: pane.scrollTop, scrollLeft: pane.scrollLeft, clientWidth: pane.clientWidth, clientHeight: pane.clientHeight,
    page: { top: box.top - frame.top - pane.clientTop + pane.scrollTop, left: box.left - frame.left - pane.clientLeft + pane.scrollLeft,
      width: box.width, height: box.height } };
}
const measure = measureReaderPane;
function stamp(place: ReadingPlace, pageId: string, surfaceKey: string): ReaderPlace {
  const revision = surfaceKey.startsWith(`${pageId}:`) ? surfaceKey.slice(pageId.length + 1) : '';
  return { ...place, ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revision) ? { backgroundRevision: revision } : {}) };
}

/** Owns persistence and landing; rasterization and device events remain surface responsibilities. */
export function useDocumentReadingPlace({ reader, paneRef, pageId, surfaceKey, placement, landing }: {
  reader: ReaderSession; paneRef: RefObject<HTMLDivElement | null>; pageId: string;
  surfaceKey: string;
  placement: 'center' | 'right'; landing: ReaderState['landing'];
}) {
  const held = useRef<ReaderPlace | null>(null), intent = useRef(false), pending = useRef(false);
  const ready = useRef<{ pageId: string; surfaceKey: string; pane: HTMLElement; width: number; height: number; fitWidth: number; fitPageWidth: number } | null>(null);
  const frame = useRef<number | undefined>(undefined);
  const zoomAnchors = useRef<{ pane: HTMLElement; anchor: ZoomAnchor; width: number }[]>([]);
  const settledPanes = useRef(new Set<HTMLElement>());
  const latest = useRef({ pageId, surfaceKey, landing }); latest.current = { pageId, surfaceKey, landing };
  const restore = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const pane = paneRef.current, current = latest.current;
      if ((!pending.current && !zoomAnchors.current.length) || !pane || ready.current?.pageId !== current.pageId
        || ready.current.surfaceKey !== current.surfaceKey || ready.current.pane !== pane
        || ready.current.width !== pane.clientWidth || ready.current.height !== pane.clientHeight) return;
      if (current.landing.backgroundRevision && current.surfaceKey !== `${current.pageId}:${current.landing.backgroundRevision}`) return;
      if (held.current && (held.current.backgroundRevision
        ? current.surfaceKey !== `${current.pageId}:${held.current.backgroundRevision}` : !!current.landing.backgroundRevision)) {
        held.current = null; zoomAnchors.current = [];
      }
      const view = measure(pane); if (!view || !(view.page.width > 0 && view.page.height > 0)) return;
      if (!pending.current && zoomAnchors.current.length) {
        zoomAnchors.current = zoomAnchors.current.filter(held => {
          if (!held.pane.isConnected) return false;
          const surface = held.pane.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]');
          if (!surface) return true;
          const rect = surface.getBoundingClientRect();
          if (rect.width === held.width) return !settledPanes.current.has(held.pane); // Wait only while this pane is rasterizing.
          const delta = scrollDeltaForZoomAnchor(held.anchor, rect);
          held.pane.scrollLeft += delta.left; held.pane.scrollTop += delta.top;
          return false;
        });
        const next = measure(pane), at = next && readingPlace(next);
        held.current = at && stamp(at, current.pageId, current.surfaceKey);
        return;
      }
      if (!pending.current) return;
      intent.current = false;
      const place = held.current;
      const scroll = place ? scrollForPlace(place, view) : { top: current.landing.toEnd ? pane.scrollHeight : 0, left: 0 };
      pane.scrollTop = scroll.top; pane.scrollLeft = scroll.left;
      pending.current = false;
    });
  }, [paneRef]);
  const capturePlace = useCallback(() => {
    const pane = paneRef.current, id = latest.current.pageId;
    if (!pane || !id || pending.current) return;
    if (ready.current?.pageId !== id || ready.current.pane !== pane || ready.current.surfaceKey !== latest.current.surfaceKey
      || ready.current.width !== pane.clientWidth || ready.current.height !== pane.clientHeight
      || latest.current.landing.backgroundRevision && latest.current.surfaceKey !== `${id}:${latest.current.landing.backgroundRevision}`) return;
    if (!intent.current && !held.current) return;
    const measured = measure(pane);
    const place = !intent.current && held.current ? held.current : measured && readingPlace(measured);
    if (place) {
      if ('backgroundRevision' in place && place.backgroundRevision && latest.current.surfaceKey !== `${id}:${place.backgroundRevision}`) return;
      const at = stamp(place, id, latest.current.surfaceKey); held.current = at; reader.remember(id, at);
    }
  }, [reader, paneRef]);
  const viewportReady = useCallback((metrics: ReaderViewport, expectedSurfaceKey: string) => {
    const pane = paneRef.current;
    if (!pane || !latest.current.pageId || expectedSurfaceKey !== latest.current.surfaceKey) return;
    const previous = ready.current;
    // Layout may first report the old fit metrics at the new pane size. Restore again when the
    // new fit arrives. A gesture's scale-only change keeps its own pointer anchor authority.
    if (previous?.pane === pane && previous.surfaceKey === expectedSurfaceKey
      && (previous.fitWidth !== metrics.fitWidth || previous.fitPageWidth !== metrics.fitPageWidth)
      && !zoomAnchors.current.length) pending.current = true;
    ready.current = { pageId: latest.current.pageId, surfaceKey: latest.current.surfaceKey, pane,
      width: pane.clientWidth, height: pane.clientHeight, fitWidth: metrics.fitWidth, fitPageWidth: metrics.fitPageWidth };
    settledPanes.current.add(pane);
    reader.setViewport(latest.current.pageId, metrics); restore();
  }, [reader, paneRef, restore]);
  const prepareZoom = useCallback((point?: { x: number; y: number }) => {
    if (pending.current) return;
    zoomAnchors.current = []; settledPanes.current.clear();
    for (const pane of [paneRef.current]) {
      const surface = pane?.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]');
      if (!pane || !surface) continue;
      const rect = surface.getBoundingClientRect(), frame = pane.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      const within = point && point.x >= frame.left && point.x <= frame.right && point.y >= frame.top && point.y <= frame.bottom;
      const x = within ? point.x : frame.left + pane.clientWidth / 2, y = within ? point.y : Math.max(frame.top, rect.top);
      zoomAnchors.current.push({ pane, width: rect.width,
        anchor: { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, atX: x, atY: y } });
    }
  }, [paneRef]);
  const cancelZoom = useCallback(() => { zoomAnchors.current = []; }, []);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    held.current = reader.getSnapshot().positions[pageId] ?? (landing.place
      ? { ...landing.place, ...(landing.backgroundRevision ? { backgroundRevision: landing.backgroundRevision } : {}) } : null);
    intent.current = false; pending.current = true; zoomAnchors.current = [];
    if (!pane || !pageId) return;
    restore();
    let width = pane.clientWidth, height = pane.clientHeight;
    const resize = new ResizeObserver(() => {
      if (width === pane.clientWidth && height === pane.clientHeight) return;
      width = pane.clientWidth; height = pane.clientHeight;
      pending.current = true; intent.current = false;
      // The surface reports again after calculating its new fit size.
      restore();
    });
    resize.observe(pane);
    const userIntent = (event: Event) => {
      const zoomModifier = (event instanceof WheelEvent || event instanceof KeyboardEvent) && (event.ctrlKey || event.metaKey);
      if (!zoomModifier) zoomAnchors.current = [];
      intent.current = true; pending.current = false;
    };
    const scroll = () => { if (intent.current && !pending.current) capturePlace(); };
    const flush = () => { if (intent.current) capturePlace(); reader.flush(); };
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    const inputPanes = [pane].filter((element): element is HTMLDivElement => !!element);
    for (const inputPane of inputPanes) for (const name of ['pointerdown', 'wheel', 'keydown', READER_SCROLL_INTENT]) inputPane.addEventListener(name, userIntent, { passive: true });
    pane.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', visibility);
    return () => {
      resize.disconnect(); if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      for (const inputPane of inputPanes) for (const name of ['pointerdown', 'wheel', 'keydown', READER_SCROLL_INTENT]) inputPane.removeEventListener(name, userIntent);
      pane.removeEventListener('scroll', scroll);
      window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility);
      reader.flush();
    };
  }, [reader, paneRef, pageId, surfaceKey, placement, landing.id, capturePlace, restore, prepareZoom]); // eslint-disable-line react-hooks/exhaustive-deps -- positions update continuously; landing is an explicit request
  return { capturePlace, viewportReady, prepareZoom, cancelZoom };
}
