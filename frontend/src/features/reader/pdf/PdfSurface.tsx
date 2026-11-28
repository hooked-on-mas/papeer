import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import { PdfDocument, PdfPage } from './PdfDocument';
import { assertCanonicalPdfDocument, assertCanonicalPdfPage, type CanonicalPdfAsset } from './canonicalPdfResource';
import type { CanonicalPdfTextBinding } from './canonicalPdfHighlight';
import { useCanonicalPdfTextBinding } from './useCanonicalPdfTextBinding';
import { createPdfTextLayoutState, fitCanonicalPdfTextLayer } from './pdfTextLayout';
import { cappedPixelRatio, snapshotSize } from '../canvasBudget';
import { fitWidthFor, pageWidthFor, scrollsSideways, ZOOM_FIT_PAGE } from '../zoomLevels';
import { usePdfPointerInput, usePdfTouchOwner, type TerminalSwipeProof } from '../input/usePdfPointerInput';
import type { PdfInkGestureReadPort, PdfTextPointerPort } from './pdfTextGesture';
import type { CanonicalManagedInputBundle } from '../input/canonicalManagedInput';
import './managedPdfTextSelection.css';
import type { ReferenceMeasurement } from '../reference/referenceMeasurement';
import { referenceDrawSettled } from '../reference/referenceRestoreDecision';
import { completePdfTextLayer, createPdfTextLayerCompletion, invalidatePdfTextLayerCompletion,
  recordPdfTextLayerRendered, refitCompletedPdfTextLayer, type PdfTextLayerCompletion } from './pdfTextLayerCompletion';
import { CanonicalPdfLinks } from './PdfLinksLayer';

export type PdfSurfacePresentation = { ratio: number; rasterReady: boolean };
/** Opaque instance identity exposes no PDF.js methods or mutable application state. */
export type PdfDocumentObservation = Readonly<{ resourceKey: string; instance: object; numPages: number }>;
export type PdfSurfaceProps = {
  asset: CanonicalPdfAsset | null;
  assetError: string;
  retryAsset(): void;
  zoom: number;
  paneRef: RefObject<HTMLDivElement | null>;
  scopeRef: RefObject<HTMLDivElement | null>;
  pointer: { zoom: { get(): number; set(value: number): void }; allowTouch?: () => boolean; allowContinuation?: () => boolean;
    onPageSwipe?: (direction: -1 | 1, proof: TerminalSwipeProof) => void; activate(): void;
    inkGesture?: PdfInkGestureReadPort; lifetimeKey?: unknown };
  inputBundle: CanonicalManagedInputBundle;
  textSelection?: PdfTextPointerPort;
  textSelectionOverlay?: ReactNode;
  onMetrics(metrics: { fitWidth: number; fitPageWidth: number; drawnWidth: number }): void;
  onReferenceMeasurement?(measurement: ReferenceMeasurement): void;
  onPdfTextSurface?: (binding: CanonicalPdfTextBinding | null) => void;
  onDocumentObserved?: (event: PdfDocumentObservation) => void;
  links?: { enabled: boolean; admit(): boolean; navigate(page: number, y?: number): boolean };
  renderOverlay(presentation: PdfSurfacePresentation): ReactNode;
};

const PADDING = 16;
const releaseCanvas = (canvas: HTMLCanvasElement | null) => { if (canvas) { canvas.width = 0; canvas.height = 0; } };

/** Canonical raster/text/input presentation. ReaderSession owns all positions and commands. */
export function PdfSurface({ asset, assetError, retryAsset, zoom, paneRef, scopeRef, pointer, onMetrics,
  onPdfTextSurface, onDocumentObserved, renderOverlay, inputBundle, textSelection, textSelectionOverlay, onReferenceMeasurement, links }: PdfSurfaceProps) {
  const documentObserver = useRef(onDocumentObserved); documentObserver.current = onDocumentObserved;
  const documentIdentities = useRef(new WeakMap<PDFDocumentProxy, object>());
  const container = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null), pageRef = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const attachPreview = useCallback((node: HTMLCanvasElement | null) => {
    if (preview.current !== node) releaseCanvas(preview.current);
    preview.current = node;
  }, []);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const layoutRequest = useRef({ generation: 0, width: 0, height: 0, dpr: 0, zoom });
  if (layoutRequest.current.zoom !== zoom) { layoutRequest.current = { ...layoutRequest.current, zoom, generation: layoutRequest.current.generation + 1 }; }
  const [deviceRatio, setDeviceRatio] = useState(() => window.devicePixelRatio || 1);
  const attachPane = useCallback((node: HTMLDivElement | null) => {
    container.current = node; paneRef.current = node; scopeRef.current = node;
  }, [paneRef, scopeRef]);
  useLayoutEffect(() => {
    const pane = container.current; if (!pane) return;
    const measure = () => {
      const width = pane.clientWidth, height = pane.clientHeight, dpr = window.devicePixelRatio || 1;
      const old = layoutRequest.current;
      if (old.width !== width || old.height !== height || old.dpr !== dpr)
        layoutRequest.current = { ...old, width, height, dpr, generation: old.generation + 1 };
      setRoom(previous => previous.width === width && previous.height === height ? previous : { width, height });
      setDeviceRatio(window.devicePixelRatio || 1);
    };
    const observer = new ResizeObserver(measure); observer.observe(pane); measure();
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const resourceKey = asset ? JSON.stringify([asset.binding.scope, asset.binding.resourceId, asset.binding.sourceRevision, asset.url]) : '';
  const resource = useMemo(() => ({ key: resourceKey }), [resourceKey]);
  const source = useMemo(() => ({ asset, resource }), [asset, resource]);
  const [linkDocument, setLinkDocument] = useState<{ resource: object; value: PDFDocumentProxy } | null>(null);
  const [linkPage, setLinkPage] = useState<{ source: object; value: PDFPageProxy } | null>(null);
  const [inspectedDocument, setInspectedDocument] = useState<object | null>(null);
  const [inspectedPage, setInspectedPage] = useState<object | null>(null);
  const ratio = asset ? asset.binding.heightPt / asset.binding.widthPt : Math.SQRT2;
  const fitWidth = fitWidthFor(room.width - PADDING * 2 - 2);
  const fitPageWidth = pageWidthFor(ZOOM_FIT_PAGE, fitWidth, room.height - PADDING * 2 - 2, ratio);
  const pageWidth = pageWidthFor(zoom, fitWidth, room.height - PADDING * 2 - 2, ratio);
  const [drawnWidth, setDrawnWidth] = useState(0), [covering, setCovering] = useState(false);
  const [rendered, setRendered] = useState<object | null>(null), [failed, setFailed] = useState<object | null>(null);
  const pixelRatio = cappedPixelRatio(deviceRatio, drawnWidth, drawnWidth * ratio);
  const drawing = useMemo(() => ({ source, width: drawnWidth, pixelRatio, textLayout: createPdfTextLayoutState() }), [source, drawnWidth, pixelRatio]);
  const active = useRef<{ resource: typeof resource; drawing: typeof drawing } | null>(null);
  const pageFacts = useRef<PdfTextLayerCompletion<PDFPageProxy, TextContent> & { drawing: object }>({
    drawing, ...createPdfTextLayerCompletion<PDFPageProxy, TextContent>(),
  });
  const touchZooming = usePdfTouchOwner(state => !!container.current && [...state.owners.keys()].some(scope => scope.contains(container.current)));
  const settled = !!asset && !assetError && failed !== drawing && failed !== source && failed !== resource
    && room.width > 0 && room.height > 0 && pageWidth === drawnWidth && !covering && !touchZooming;
  const refitAfterFonts = useCallback(() => refitCompletedPdfTextLayer(pageFacts.current, pageRef.current,
    () => active.current?.resource === resource && active.current.drawing === drawing && pageFacts.current.drawing === drawing,
    (page, content, layer) => {
      const viewport = page.getViewport({ scale: 1 });
      fitCanonicalPdfTextLayer(drawing.textLayout, layer, content, drawnWidth, viewport);
    }), [resource, drawing, drawnWidth]);
  const text = useCanonicalPdfTextBinding({ asset, drawnWidth, pixelRatio, pageRef, settled, onPdfTextSurface, refitAfterFonts });
  const rasterReady = settled && rendered === drawing && failed !== drawing && failed !== resource;
  const currentDrawProof = useRef({ drawing, ready: rasterReady, binding: text.binding }); currentDrawProof.current = { drawing, ready: rasterReady, binding: text.binding };
  const { suppressClick, ...pointerHandlers } = usePdfPointerInput({ inputBundle, pageKey: asset ? `${resourceKey}:${asset.binding.pageId}:${asset.binding.backgroundRevision}` : '',
    enabled: !!asset && room.width > 0, paneRef: container, surfaceRef: surface, pageWidth, drawnWidth, fitWidth, fitPageWidth,
    zoom: pointer.zoom, allowTouch: pointer.allowTouch, allowContinuation: pointer.allowContinuation, onPageSwipe: pointer.onPageSwipe,
    textSelection, inkGesture: pointer.inkGesture, lifetimeKey: pointer.lifetimeKey });

  useLayoutEffect(() => {
    active.current = { resource, drawing };
    pageFacts.current = {
      drawing, ...createPdfTextLayerCompletion<PDFPageProxy, TextContent>(),
    };
    const facts = pageFacts.current;
    return () => {
      invalidatePdfTextLayerCompletion(facts);
      if (active.current?.drawing === drawing) active.current = null;
    };
  }, [resource, drawing]);
  useLayoutEffect(() => {
    if (!room.width || !room.height || touchZooming || drawnWidth === pageWidth) return;
    if (!drawnWidth) { setDrawnWidth(pageWidth); return; }
    // Keep the last raster during resize, then replace it once the width settles.
    const timer = setTimeout(() => {
      const canvas = pageRef.current?.querySelector('canvas'), snapshot = preview.current;
      if (canvas?.width && snapshot && rendered === drawing) {
        const size = snapshotSize(canvas.width, canvas.height);
        snapshot.width = size.width; snapshot.height = size.height;
        snapshot.getContext('2d')?.drawImage(canvas, 0, 0, size.width, size.height);
        setCovering(true);
      }
      setDrawnWidth(pageWidth);
    }, 150);
    return () => clearTimeout(timer);
  }, [room, touchZooming, drawnWidth, pageWidth, rendered, drawing]);
  const measurementGeneration = layoutRequest.current.generation;
  useLayoutEffect(() => {
    // Metadata alone cannot authorize ReaderSession's persistent zoom
    // normalization: inspect the very Document and Page being presented first.
    // These facts survive width/DPR changes, independently of raster/text work.
    if (asset && !assetError && inspectedDocument === resource && inspectedPage === source
      && failed !== drawing && failed !== source && failed !== resource && surface.current?.isConnected
      && room.width > 0 && room.height > 0) {
      const metrics = { fitWidth, fitPageWidth, drawnWidth: pageWidth }; onMetrics(metrics);
      const pane = container.current;
      const binding = text.binding;
      if (pane && onReferenceMeasurement) onReferenceMeasurement({ pane, width: room.width, height: room.height, dpr: deviceRatio, zoom,
        generation: measurementGeneration, isSettled: () => referenceDrawSettled(binding, currentDrawProof.current.binding, currentDrawProof.current.drawing === drawing, currentDrawProof.current.ready), metrics, isCurrent: () => pane.isConnected && container.current === pane
          && layoutRequest.current.generation === measurementGeneration && pane.clientWidth === room.width && pane.clientHeight === room.height
          && (window.devicePixelRatio || 1) === deviceRatio });
    }
  }, [asset, assetError, inspectedDocument, inspectedPage, failed, drawing, source, resource, room.width, room.height,
    onMetrics, onReferenceMeasurement, fitWidth, fitPageWidth, pageWidth, rasterReady, text.binding, zoom, deviceRatio, measurementGeneration]);
  useLayoutEffect(() => {
    setCovering(false); releaseCanvas(preview.current);
  }, [asset?.binding.pageId, asset?.binding.backgroundRevision, resource]);
  const { onRenderError, onDocumentLoad, onPageLoad, onTextContent, onCanvasRendered, onTextLayerRendered } = text;
  // react-pdf rebuilds its text layer when its callback changes. Keep callbacks
  // fixed for this draw, including while publishing the completed text binding.
  const events = useMemo(() => {
    const current = () => active.current?.resource === resource && active.current.drawing === drawing
      && pageFacts.current.drawing === drawing && !pageFacts.current.invalid;
    const tryCompleteText = () => {
      completePdfTextLayer(pageFacts.current, pageRef.current, current, (page, content, layer) => {
        const viewport = page.getViewport({ scale: 1 });
        fitCanonicalPdfTextLayer(drawing.textLayout, layer, content, drawnWidth, viewport);
        onTextLayerRendered();
      });
    };
    const failure = () => {
      if (current()) {
        invalidatePdfTextLayerCompletion(pageFacts.current);
        setFailed(drawing); onRenderError(); setCovering(false); releaseCanvas(preview.current);
      }
    };
    return {
      failure,
      documentLoaded(document: Parameters<typeof onDocumentLoad>[0]) {
        // Observe real load completion, including a subsequently rejected PDF.
        // The callback stays outside proof admission and callback memo identity.
        if (documentObserver.current) {
          let instance = documentIdentities.current.get(document);
          if (!instance) { instance = Object.freeze({}); documentIdentities.current.set(document, instance); }
          documentObserver.current(Object.freeze({ resourceKey: resource.key, instance, numPages: document.numPages }));
        }
        if (active.current?.resource !== resource || !asset) return;
        try { assertCanonicalPdfDocument(asset.binding, asset.metadata, document.numPages); setInspectedDocument(resource); setLinkDocument({ resource, value: document }); onDocumentLoad(document); }
        catch {
          invalidatePdfTextLayerCompletion(pageFacts.current);
          setInspectedDocument(null); setFailed(resource);
        }
      },
      documentFailed() {
        if (active.current?.resource === resource) {
          invalidatePdfTextLayerCompletion(pageFacts.current);
          setInspectedDocument(null); setFailed(resource);
        }
      },
      pageLoaded(page: PDFPageProxy) {
        if (!current() || !asset) return;
        try {
          assertCanonicalPdfPage(asset.binding, page); setInspectedPage(source); setLinkPage({ source, value: page }); pageFacts.current.page = page;
          onPageLoad(page); tryCompleteText();
        }
        catch { failure(); setInspectedPage(null); setFailed(source); }
      },
      textLoaded(content: TextContent) {
        if (current()) { pageFacts.current.text = content; onTextContent(content); tryCompleteText(); }
      },
      canvasRendered(page: PDFPageProxy) {
        if (!current() || !asset) return;
        try { assertCanonicalPdfPage(asset.binding, page); setRendered(drawing); setCovering(false); releaseCanvas(preview.current); onCanvasRendered(); }
        catch { failure(); setInspectedPage(null); setFailed(source); }
      },
      textRendered() {
        if (!current()) return;
        recordPdfTextLayerRendered(pageFacts.current, pageRef.current);
        tryCompleteText();
      },
    };
  }, [drawing, source, resource, asset, drawnWidth, onRenderError, onDocumentLoad, onPageLoad, onTextContent, onCanvasRendered, onTextLayerRendered]);
  const error = !!assetError || failed === drawing || failed === source || failed === resource;
  const pageKey = asset ? JSON.stringify([resourceKey, asset.binding, drawnWidth, pixelRatio]) : '';
  return <div ref={attachPane} data-pdf-scroller data-canonical-input={inputBundle.kind} data-rendered={rasterReady ? 'true' : 'false'}
    data-managed-pdf-text-selection={textSelection ? '' : undefined}
    className={`pdf h-full min-h-0 min-w-0 w-full bg-reader-bg [scrollbar-gutter:stable] [touch-action:none] [overflow-anchor:none] ${scrollsSideways(zoom, pageWidth, room.width - PADDING * 2) ? 'overflow-auto' : 'overflow-y-auto overflow-x-hidden'}`}
    {...pointerHandlers} onPointerDownCapture={pointer.activate} onFocusCapture={pointer.activate}
    onClickCapture={event => { if (event.detail !== 0 && suppressClick()) { event.preventDefault(); event.stopPropagation(); } }}>
    {textSelectionOverlay}
    {error ? <div role="alert" className="p-4">PDFを確認できません。注釈は保持しています。<button type="button" onClick={retryAsset}>PDFを再取得</button></div>
      : !asset ? <p role="status" className="p-4">PDFを読み込んでいます…</p>
      : <div className="w-fit min-w-full" style={{ padding: PADDING }}>
        <PdfDocument key={resourceKey} file={asset.url} className="mx-auto w-fit"
          loading={<p role="status">PDFを読み込んでいます…</p>} error={<p role="alert">PDFを読み込めません。</p>}
          onLoadSuccess={events.documentLoaded} onLoadError={events.documentFailed}>
          {drawnWidth > 0 && <div className="relative border bg-white shadow-sm"
            style={{ width: drawnWidth + 2, height: drawnWidth * ratio + 2, zoom: pageWidth === drawnWidth ? undefined : pageWidth / drawnWidth }}>
            <div ref={surface} data-pdf-surface className="relative" style={{ width: drawnWidth, height: drawnWidth * ratio }}>
            <PdfPage key={pageKey} pageNumber={asset.binding.pdfPage} width={drawnWidth} devicePixelRatio={pixelRatio}
              inputRef={pageRef} renderTextLayer renderAnnotationLayer={false} className="[&_.textLayer]:select-text"
              onLoadSuccess={events.pageLoaded} onGetTextSuccess={events.textLoaded}
              onRenderSuccess={events.canvasRendered} onRenderError={events.failure} onLoadError={events.failure}
              onRenderTextLayerSuccess={events.textRendered} onRenderTextLayerError={events.failure} onGetTextError={events.failure}
              loading={<div style={{ width: drawnWidth, height: drawnWidth * ratio }} />} />
            <canvas ref={attachPreview} hidden={!covering} className="pointer-events-none absolute inset-0" style={{ width: drawnWidth, height: drawnWidth * ratio }} />
            {links && linkDocument?.resource === resource && linkPage?.source === source && rasterReady && <CanonicalPdfLinks key={`links:${pageKey}`} document={linkDocument.value} page={linkPage.value} {...links} />}
            <div className="pointer-events-none absolute inset-0 [&>div]:inset-0 [&>svg]:inset-0" style={{ width: drawnWidth, height: drawnWidth * ratio }}>
              {renderOverlay({ ratio, rasterReady })}
            </div>
            </div>
          </div>}
        </PdfDocument>
      </div>}
  </div>;
}
