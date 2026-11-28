import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { DocumentLibraryView } from './DocumentLibraryConnection';
import { CanonicalPaperBackground } from '../notebooks/CanonicalPaperBackground';
import { CanonicalPageAnnotations } from './annotations/CanonicalPageAnnotations';
import { CanonicalAnnotationLayer } from './annotations/CanonicalAnnotationLayer';
import { useCanonicalAnnotationReadiness } from './annotations/useCanonicalAnnotationReadiness';
import { InkOverlay } from './InkOverlay';
import { usePdfPointerInput } from './input/usePdfPointerInput';
import { fitWidthFor, pageWidthFor, ZOOM_FIT_PAGE } from './zoomLevels';

export type PaperPaneMetrics = { fitWidth: number; fitPageWidth: number; drawnWidth: number; ratio: number };

/** A canonical paper surface shares ink/input ownership with PDF, but has no PDF lifecycle. */
export function DocumentPaperPane({ view, onMetrics }: { view: DocumentLibraryView; onMetrics?: (metrics: PaperPaneMetrics) => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const page = view.page, key = page?.id ?? '', ratio = page ? page.heightPt / page.widthPt : 1;
  const fitWidth = fitWidthFor(room.width), fitPageWidth = pageWidthFor(ZOOM_FIT_PAGE, fitWidth, room.height, ratio);
  const drawnWidth = pageWidthFor(view.zoom, fitWidth, room.height, ratio);
  const ready = room.width > 0 && room.height > 0;
  useCanonicalAnnotationReadiness({ page, ready, available: view.annotation.available, generation: view.annotationRenderGeneration, report: view.reportAnnotationReady });
  const layout = useRef({ key, width: drawnWidth, room }); layout.current = { key, width: drawnWidth, room };
  const attachPane = useCallback((node: HTMLDivElement | null) => {
    view.paneRef.current = node; view.editor.scopeRef.current = node;
  }, [view.paneRef, view.editor.scopeRef]);
  useLayoutEffect(() => {
    const pane = view.paneRef.current;
    if (!pane) return;
    const measure = () => {
      const next = { width: pane.clientWidth, height: pane.clientHeight }, previous = layout.current;
      if (next.width === previous.room.width && next.height === previous.room.height) return;
      setRoom(next);
    };
    const observer = new ResizeObserver(measure); observer.observe(pane); measure();
    return () => observer.disconnect();
  }, [view.paneRef]);
  const { suppressClick, ...pointerHandlers } = usePdfPointerInput({ inputBundle: view.inputBundle, pageKey: key, enabled: ready && !!page,
    inkGesture: view.inkGesture, lifetimeKey: view.pointerLifetimeKey,
    paneRef: view.paneRef, surfaceRef, pageWidth: drawnWidth, drawnWidth, fitWidth, fitPageWidth,
    zoom: { get: () => view.zoom, set: view.changeZoom }, allowTouch: view.allowTouch,
    onPageSwipe: view.editor.tool === 'select' ? view.swipe : undefined });
  useLayoutEffect(() => { if (ready) onMetrics?.({ fitWidth, fitPageWidth, drawnWidth, ratio }); },
    [ready, onMetrics, key, page?.backgroundRevision, fitWidth, fitPageWidth, drawnWidth, ratio]);
  return <div ref={attachPane} className="document-paper-pane" data-canonical-input={view.inputBundle.kind} aria-label="用紙" {...pointerHandlers}
    style={{ width: '100%', height: '100%', minHeight: 0, minWidth: 0, overflow: 'auto', position: 'relative', overscrollBehavior: 'contain', touchAction: 'none' }}
    onPointerDownCapture={view.editor.activate} onFocusCapture={view.editor.activate}
    onClickCapture={event => { if (event.detail !== 0 && suppressClick()) { event.preventDefault(); event.stopPropagation(); } }}>
    {page?.background.kind === 'paper' ? <div ref={surfaceRef} className="ink-page relative" data-paper-page={page.id}
      style={{ width: drawnWidth, height: drawnWidth * ratio, marginInline: 'auto', flexShrink: 0 }}>
      <CanonicalPaperBackground page={page} />
      {view.editor.visible && <CanonicalPageAnnotations page={page} includeInk={!ready || !view.editable} omitAnnotationId={view.annotation.draft?.annotation.id} />}
      {ready && view.editable && <InkOverlay key={page.id} editor={view.editor} aspectRatio={ratio} surfaceName="ノート" onCapture={() => {}} gestureReadRef={view.inkGestureRef} />}
      {view.editor.visible && <CanonicalAnnotationLayer page={page} annotation={view.annotation} ready={ready} />}
    </div> : <p role="status">用紙がありません。</p>}
  </div>;
}

import type { DocumentReferenceView } from './reference/DocumentReferenceSurface';
const referenceNoInk = Object.freeze({ owns: (_id: number) => false });
/** Shares the canonical paper background and managed input; no InkOverlay or editing layer. */
export function ReferencePaperPane({ view }: { view: DocumentReferenceView }) {
  const surfaceRef = useRef<HTMLDivElement>(null), [room, setRoom] = useState({ width: 0, height: 0, dpr: 0 });
  const page = view.page, ratio = page.heightPt / page.widthPt;
  const request = useRef({ generation: 0, width: 0, height: 0, dpr: 0, zoom: view.zoom });
  if (request.current.zoom !== view.zoom) request.current = { ...request.current, zoom: view.zoom, generation: request.current.generation + 1 };
  const fitWidth = fitWidthFor(room.width), fitPageWidth = pageWidthFor(ZOOM_FIT_PAGE, fitWidth, room.height, ratio);
  const drawnWidth = pageWidthFor(view.zoom, fitWidth, room.height, ratio), ready = room.width > 0 && room.height > 0;
  const attach = useCallback((node: HTMLDivElement | null) => { view.paneRef.current = node; view.scopeRef.current = node; }, [view.paneRef, view.scopeRef]);
  useLayoutEffect(() => {
    const pane = view.paneRef.current; if (!pane) return;
    const measure = () => { const width = pane.clientWidth, height = pane.clientHeight, dpr = window.devicePixelRatio || 1;
      const old = request.current;
      if (old.width !== width || old.height !== height || old.dpr !== dpr) request.current = { ...old, width, height, dpr, generation: old.generation + 1 };
      setRoom(old => old.width === width && old.height === height && old.dpr === dpr ? old : { width, height, dpr }); };
    const observer = new ResizeObserver(measure); observer.observe(pane); window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [view.paneRef]);
  const { suppressClick, ...handlers } = usePdfPointerInput({ inputBundle: view.inputBundle, pageKey: page.id, enabled: ready,
    inkGesture: referenceNoInk, lifetimeKey: view.pointerLease, paneRef: view.paneRef, surfaceRef, pageWidth: drawnWidth, drawnWidth,
    fitWidth, fitPageWidth, zoom: { get: () => view.zoom, set: view.setZoom }, allowTouch: view.allowTouch, allowContinuation: view.allowContinuation });
  const generation = request.current.generation, dpr = request.current.dpr;
  const { paneRef, reportMeasurement, zoom } = view;
  useLayoutEffect(() => { const pane = paneRef.current;
    if (ready && pane) reportMeasurement({ pane, width: room.width, height: room.height, dpr, zoom, generation, isSettled: () => request.current.generation === generation,
      metrics: { fitWidth, fitPageWidth, drawnWidth }, isCurrent: () => pane.isConnected && paneRef.current === pane
        && request.current.generation === generation && pane.clientWidth === room.width && pane.clientHeight === room.height
        && (window.devicePixelRatio || 1) === dpr });
  }, [ready, fitWidth, fitPageWidth, drawnWidth, reportMeasurement, paneRef, zoom, room.width, room.height, generation, dpr]);
  return <div ref={attach} className="document-paper-pane" data-canonical-input={view.inputBundle.kind} aria-label="参照用紙" tabIndex={0}
    {...handlers} style={{ width: '100%', height: '100%', minHeight: 0, minWidth: 0, overflow: 'auto', position: 'relative', overscrollBehavior: 'contain', touchAction: 'none' }}
    onClickCapture={event => { if (event.detail !== 0 && suppressClick()) { event.preventDefault(); event.stopPropagation(); } }}>
    <div ref={surfaceRef} className="ink-page relative" data-paper-page={page.id} style={{ width: drawnWidth, height: drawnWidth * ratio, marginInline: 'auto' }}>
      <CanonicalPaperBackground page={page} /><CanonicalPageAnnotations page={page} includeInk />
    </div>
  </div>;
}
