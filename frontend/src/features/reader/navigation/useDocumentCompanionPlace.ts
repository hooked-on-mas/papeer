import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Page } from '../../../runtime/edits/contracts';
import type { ReaderPlace, ReaderSession, ReaderState, ReaderViewport } from '../ReaderSession';
import { measureReaderPane } from './useDocumentReadingPlace';
import { readingPlace, scrollForPlace, scrollDeltaForZoomAnchor, type ZoomAnchor } from './readingPlace';
import { READER_SCROLL_INTENT } from './readerCommands';

type Identity = Pick<Page, 'id' | 'backgroundRevision'>;
const validPlace = (at: ReaderPlace | undefined, page: Identity | null) => at && page && at.backgroundRevision === page.backgroundRevision ? at : null;

/** The other language has its own geometry and saved position. It never sets the active zoom minimum. */
export function useDocumentCompanionPlace({ reader, reading, paneRef, activePaneRef, page, activePage, enabled, placement }: {
  reader: ReaderSession; reading: ReaderState; paneRef: RefObject<HTMLDivElement | null>;
  activePaneRef: RefObject<HTMLDivElement | null>;
  page: Identity | null; activePage: Identity | null; enabled: boolean; placement: 'center' | 'right';
}) {
  const latest = useRef({ page, activePage, enabled, reading }); latest.current = { page, activePage, enabled, reading };
  const held = useRef<ReaderPlace | null>(null), pending = useRef(false), intent = useRef(false);
  const ready = useRef<{ pane: HTMLElement; key: string; width: number; height: number; drawnWidth: number } | null>(null);
  const frame = useRef<number | undefined>(undefined);
  const anchor = useRef<{ pane: HTMLElement; width: number; at: ZoomAnchor } | null>(null);
  const zoomSettled = useRef(false);
  const followInput = useRef(false);
  const key = page ? `${page.id}:${page.backgroundRevision}` : '';
  const restore = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const current = latest.current, pane = paneRef.current, target = current.page;
      if (!current.enabled || !pane || !target || ready.current?.pane !== pane || ready.current.key !== `${target.id}:${target.backgroundRevision}`) return;
      if (ready.current.width !== pane.clientWidth || ready.current.height !== pane.clientHeight) return;
      const measured = measureReaderPane(pane); if (!measured || measured.page.width <= 0 || measured.page.height <= 0) return;
      if (anchor.current) {
        // An older scroll/viewport RAF can run before the newly requested raster reports readiness.
        if (!zoomSettled.current) return;
        const zoom = anchor.current, surface = pane.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]');
        if (!surface || zoom.pane !== pane) { anchor.current = null; return; }
        const rect = surface.getBoundingClientRect();
        if (rect.width !== zoom.width) {
          const delta = scrollDeltaForZoomAnchor(zoom.at, rect);
          pane.scrollLeft += delta.left; pane.scrollTop += delta.top;
        }
        anchor.current = null;
        pending.current = false; intent.current = false;
        const view = measureReaderPane(pane), at = view && readingPlace(view);
        if (at) { held.current = { ...at, backgroundRevision: target.backgroundRevision }; reader.rememberSurface(target.id, held.current); }
        return;
      }
      if (!pending.current) return;
      const at = held.current?.backgroundRevision === target.backgroundRevision ? held.current : null;
      const scroll = at ? scrollForPlace(at, measured) : { top: current.reading.landing.toEnd ? pane.scrollHeight : 0, left: 0 };
      pane.scrollLeft = scroll.left; pane.scrollTop = scroll.top;
      pending.current = false; intent.current = false;
      // Application scrolling does not emit trusted input, but its own target position is durable.
      const view = measureReaderPane(pane), position = view && readingPlace(view);
      if (position) { held.current = { ...position, backgroundRevision: target.backgroundRevision }; reader.rememberSurface(target.id, held.current); }
    });
  }, [paneRef, reader]);
  const capturePlace = useCallback(() => {
    const current = latest.current, pane = paneRef.current, target = current.page;
    if (!current.enabled || !pane || !target || pending.current || anchor.current || ready.current?.pane !== pane || ready.current.key !== `${target.id}:${target.backgroundRevision}`
      || ready.current.width !== pane.clientWidth || ready.current.height !== pane.clientHeight) return;
    const measured = measureReaderPane(pane), at = measured && readingPlace(measured);
    if (at) { held.current = { ...at, backgroundRevision: target.backgroundRevision }; reader.rememberSurface(target.id, held.current); }
  }, [paneRef, reader]);
  const viewportReady = useCallback((expectedSurfaceKey: string, metrics: ReaderViewport) => {
    const current = latest.current, pane = paneRef.current;
    if (!current.enabled || !pane || !current.page || expectedSurfaceKey !== `${current.page.id}:${current.page.backgroundRevision}`) return;
    const previous = ready.current;
    if (previous?.key === expectedSurfaceKey && previous.drawnWidth !== metrics.drawnWidth) pending.current = true;
    reader.setViewport(current.page.id, metrics); // Caches this pane; Reader never lets an inactive pane rewrite shared zoom.
    ready.current = { pane, key: expectedSurfaceKey, width: pane.clientWidth, height: pane.clientHeight, drawnWidth: metrics.drawnWidth }; restore();
    zoomSettled.current = true;
  }, [paneRef, reader, restore]);
  const prepareZoom = useCallback((point?: { x: number; y: number }) => {
    followInput.current = false;
    const current = latest.current, pane = paneRef.current;
    if (!current.enabled || pending.current || !pane) return;
    const surface = pane.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]'); if (!surface) return;
    const rect = surface.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const within = point && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
    const x = within ? point.x : bounds.left + pane.clientWidth / 2, y = within ? point.y : Math.max(bounds.top, rect.top);
    anchor.current = { pane, width: rect.width, at: { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, atX: x, atY: y } };
    zoomSettled.current = false;
  }, [paneRef]);
  const cancelZoom = useCallback(() => { anchor.current = null; }, []);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (ready.current?.key !== key || ready.current.pane !== pane) ready.current = null;
    anchor.current = null; intent.current = false; pending.current = enabled;
    held.current = validPlace(page ? reader.getSnapshot().positions[page.id] : undefined, page)
      ?? (page && reading.landing.place ? { ...reading.landing.place, backgroundRevision: page.backgroundRevision } : null);
    if (!enabled || !pane || !page) return;
    let width = pane.clientWidth, height = pane.clientHeight;
    const resize = new ResizeObserver(() => {
      if (pane.clientWidth === width && pane.clientHeight === height) return;
      width = pane.clientWidth; height = pane.clientHeight;
      pending.current = true; intent.current = false;
      if (ready.current?.width !== width || ready.current.height !== height) ready.current = null;
      else restore();
    });
    resize.observe(pane);
    const input = () => { intent.current = true; pending.current = false; anchor.current = null; };
    const scroll = () => { if (intent.current) capturePlace(); };
    const flush = () => { if (intent.current) capturePlace(); reader.flush(); };
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    for (const name of ['pointerdown', 'wheel', 'keydown', READER_SCROLL_INTENT]) pane.addEventListener(name, input, { passive: true });
    pane.addEventListener('scroll', scroll, { passive: true }); window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', visibility);
    return () => {
      resize.disconnect(); if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      for (const name of ['pointerdown', 'wheel', 'keydown', READER_SCROLL_INTENT]) pane.removeEventListener(name, input);
      pane.removeEventListener('scroll', scroll); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility); reader.flush();
    };
  }, [reader, paneRef, key, enabled, placement, reading.landing.id, capturePlace, restore]); // eslint-disable-line react-hooks/exhaustive-deps -- identity and explicit landing, not every saved scroll
  useLayoutEffect(() => {
    const source = activePaneRef.current;
    followInput.current = false;
    if (!enabled || !source || !page || !activePage) return;
    let width = source.clientWidth, height = source.clientHeight;
    const input = (event: Event) => {
      const zoom = (event instanceof WheelEvent || event instanceof KeyboardEvent) && (event.ctrlKey || event.metaKey);
      followInput.current = !zoom;
    };
    const scroll = () => {
      const current = latest.current;
      if (!followInput.current || anchor.current || !current.enabled || !current.page || !current.activePage
        || source.clientWidth !== width || source.clientHeight !== height) return;
      // Primary's listener runs first and publishes only a ready, version-checked user position.
      const at = validPlace(reader.getSnapshot().positions[current.activePage.id], current.activePage); if (!at) return;
      held.current = { x: at.x, y: at.y, backgroundRevision: current.page.backgroundRevision };
      pending.current = true; restore();
    };
    const resized = new ResizeObserver(() => {
      if (source.clientWidth === width && source.clientHeight === height) return;
      width = source.clientWidth; height = source.clientHeight; followInput.current = false;
    });
    resized.observe(source);
    for (const name of ['pointerdown', 'wheel', 'keydown', READER_SCROLL_INTENT]) source.addEventListener(name, input, { passive: true });
    source.addEventListener('scroll', scroll, { passive: true });
    return () => {
      resized.disconnect(); followInput.current = false;
      for (const name of ['pointerdown', 'wheel', 'keydown', READER_SCROLL_INTENT]) source.removeEventListener(name, input);
      source.removeEventListener('scroll', scroll);
    };
  }, [reader, activePaneRef, key, activePage?.id, activePage?.backgroundRevision, enabled, placement, reading.landing.id, restore]); // eslint-disable-line react-hooks/exhaustive-deps -- identities only; poll and zoom positions must not trigger follow
  return { capturePlace, viewportReady, prepareZoom, cancelZoom };
}
