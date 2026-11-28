import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import type { CanonicalPdfHighlightRefusal, CanonicalPdfTextBinding,
  PdfHighlightMatrix, PdfHighlightViewport } from './canonicalPdfHighlight.ts';
import { assertCanonicalPdfDocument, assertCanonicalPdfPage, assertCanonicalPdfResource,
  type CanonicalPdfAsset } from './canonicalPdfResource.ts';
import { createPdfFontReadiness, type PdfFontReadiness } from './pdfFontReadiness.ts';

type ResourceFacts = {
  identity: string;
  document: PDFDocumentProxy | null;
  documentPages: number | null;
  error: CanonicalPdfHighlightRefusal | null;
  refresh: (() => void) | null;
};
type Source = {
  asset: CanonicalPdfAsset;
  resource: ResourceFacts;
  page: PDFPageProxy | null;
  textContent: TextContent | null;
  error: CanonicalPdfHighlightRefusal | null;
  refresh: (() => void) | null;
};
type Drawing = {
  source: Source | null;
  drawnWidth: number;
  pixelRatio: number;
  rotation: number | undefined;
  mount: HTMLElement | null;
  canvasReady: boolean;
  textReady: boolean;
  epoch: number;
  binding: CanonicalPdfTextBinding | null;
  fonts: PdfFontReadiness | null;
};
type Publication = { drawing: Drawing; binding: CanonicalPdfTextBinding | null; problem: CanonicalPdfHighlightRefusal | null };

function fixedAsset(asset: CanonicalPdfAsset): CanonicalPdfAsset {
  const binding = Object.freeze({ ...asset.binding, scope: Object.freeze({ ...asset.binding.scope }) });
  const metadata = structuredClone(asset.metadata);
  if (metadata.pdfPages) {
    metadata.pdfPages.forEach(Object.freeze);
    Object.freeze(metadata.pdfPages);
  }
  return Object.freeze({ binding, url: asset.url, metadata: Object.freeze(metadata) });
}

function viewportSnapshot(page: PDFPageProxy, scale: number, rotation?: number): PdfHighlightViewport | null {
  try {
    const viewport = page.getViewport({ scale, ...(rotation === undefined ? {} : { rotation }) });
    if (viewport.transform.length !== 6 || !viewport.transform.every(Number.isFinite)
      || ![viewport.width, viewport.height, viewport.scale, viewport.userUnit].every(value => Number.isFinite(value) && value > 0)
      || !Number.isFinite(viewport.rotation) || viewport.rotation % 90 !== 0) return null;
    return Object.freeze({ width: viewport.width, height: viewport.height, scale: viewport.scale,
      rotation: viewport.rotation, userUnit: viewport.userUnit,
      transform: Object.freeze([...viewport.transform]) as unknown as PdfHighlightMatrix });
  } catch {
    return null;
  }
}

function sourcePageProblem(source: Source): CanonicalPdfHighlightRefusal | null {
  const { binding, metadata, url } = source.asset;
  if (!url) return 'layout-mismatch';
  if (source.resource.error) return source.resource.error;
  const documentPages = source.resource.documentPages;
  try {
    if (documentPages === null) assertCanonicalPdfResource(binding, metadata, metadata.byteLength);
    else assertCanonicalPdfDocument(binding, metadata, documentPages);
    if (source.page) {
      assertCanonicalPdfPage(binding, source.page);
      // The common assertion owns actual page/dimensions. The text binding also
      // requires a finite, supported viewport transform for later DOM geometry.
      if (!viewportSnapshot(source.page, 1)) return 'layout-mismatch';
    }
  } catch {
    return 'layout-mismatch';
  }
  return null;
}

/** Shared readiness for the existing renderer callbacks. The asset provider owns
 * bytes/hash verification; this hook inspects the very PDF instance being drawn.
 * Document facts belong to scope/resource/hash/URL, not the displayed page.
 * Changing logical/physical pages within one verified PDF reuses numPages even
 * though Document.onLoadSuccess is not called again. Page/text facts belong to
 * the fixed page asset; canvas/text completion belongs to one drawing. Page
 * facts may be reused across width/DPR changes without a second page load.
 *
 * Call onTextLayerRendered only AFTER any host fitTextLayer correction, including
 * when there are no search terms. settled must be false while covering/CSS zoom
 * is transitional. Keep asset and pageRef stable for an unchanged source.
 *
 * This hook does not authorize capture/draft creation or commits. The Connection
 * still owns active-surface/contact admission and the session owns commit guards.
 *
 * Real-renderer acceptance remains required: same-URL page 1 -> 2 -> 1 must
 * become ready with one Document load; a Document load finishing after a same-
 * resource page change may supply numPages, while old Page/text/draw callbacks
 * and previous-resource/retry-URL/unmounted Document callbacks must be ignored.
 */
export function useCanonicalPdfTextBinding({ asset, drawnWidth, pixelRatio, rotation, pageRef, settled,
  onPdfTextSurface, refitAfterFonts }: {
  asset: CanonicalPdfAsset | null;
  drawnWidth: number;
  pixelRatio: number;
  rotation?: number;
  pageRef: RefObject<HTMLElement | null>;
  settled: boolean;
  onPdfTextSurface?: (binding: CanonicalPdfTextBinding | null) => void;
  refitAfterFonts(): boolean;
}) {
  const resourceIdentity = asset ? JSON.stringify([asset.binding.scope.accountId, asset.binding.scope.libraryId,
    asset.binding.scope.epoch, asset.binding.resourceId, asset.binding.sourceRevision, asset.url]) : null;
  const resource = useMemo<ResourceFacts | null>(() => resourceIdentity === null ? null : {
    identity: resourceIdentity, document: null, documentPages: null, error: null, refresh: null,
  }, [resourceIdentity]);
  const source = useMemo<Source | null>(() => asset && resource ? { asset: fixedAsset(asset), resource,
    page: null, textContent: null, error: null, refresh: null } : null, [asset, resource]);
  const drawing = useMemo<Drawing>(() => ({ source, drawnWidth, pixelRatio, rotation,
    mount: null, canvasReady: false, textReady: false, epoch: 0, binding: null, fonts: null }),
  [source, drawnWidth, pixelRatio, rotation]);
  const active = useRef<Drawing | null>(null);
  const isSettled = useRef(false);
  const [publication, setPublication] = useState<Publication | null>(null);
  const refit = useRef(refitAfterFonts); refit.current = refitAfterFonts;

  const events = useMemo(() => {
    const publish = (binding: CanonicalPdfTextBinding | null, problem: CanonicalPdfHighlightRefusal | null) => {
      if (active.current !== drawing) return;
      setPublication(previous => previous?.drawing === drawing && previous.binding === binding && previous.problem === problem
        ? previous : { drawing, binding, problem });
    };
    const invalidate = (problem: CanonicalPdfHighlightRefusal) => {
      drawing.epoch++;
      drawing.binding = null;
      publish(null, problem);
    };
    const mount = () => {
      const node = pageRef.current;
      if (!drawing.mount && node) drawing.mount = node;
      return !!node && node === drawing.mount && node.isConnected;
    };
    const refresh = () => {
      if (active.current !== drawing) return;
      const source = drawing.source;
      if (!source || !isSettled.current || !mount()) { invalidate('stale-render'); return; }
      const problem = source.error ?? sourcePageProblem(source);
      if (problem) { invalidate(problem); return; }
      const pageElement = drawing.mount;
      const textLayer = pageElement?.querySelector<HTMLElement>('.textLayer');
      const canvas = pageElement?.querySelector<HTMLCanvasElement>('canvas');
      if (!pageElement || !textLayer || !canvas || !drawing.canvasReady || !drawing.textReady
        || source.resource.documentPages === null || !source.page || !source.textContent) { publish(null, 'stale-render'); return; }
      const fonts = pageElement.ownerDocument.fonts;
      const gate = drawing.fonts;
      if (!fonts || !gate || gate.fonts !== fonts) { invalidate('fonts-pending'); return; }
      if (fonts.status !== 'loaded') {
        if (!gate.pending) gate.loading();
        else invalidate('fonts-pending');
        return;
      }
      if (gate.pending && !gate.tryRelease()) { publish(null, 'fonts-pending'); return; }
      const naturalViewport = viewportSnapshot(source.page, 1);
      const rotatedNatural = viewportSnapshot(source.page, 1, drawing.rotation);
      if (!naturalViewport || !rotatedNatural || !Number.isFinite(drawing.drawnWidth) || drawing.drawnWidth <= 0
        || !Number.isFinite(drawing.pixelRatio) || drawing.pixelRatio <= 0) { invalidate('layout-mismatch'); return; }
      const renderViewport = viewportSnapshot(source.page, drawing.drawnWidth / rotatedNatural.width, drawing.rotation);
      if (!renderViewport) { invalidate('unsupported-transform'); return; }
      if (drawing.binding && drawing.binding.pageElement === pageElement && drawing.binding.textLayer === textLayer
        && drawing.binding.canvas === canvas && drawing.binding.textContent === source.textContent) {
        publish(drawing.binding, null); return;
      }
      const epoch = drawing.epoch, fixedText = source.textContent;
      const renderToken = Object.freeze({ asset: source.asset, drawnWidth: drawing.drawnWidth, pixelRatio: drawing.pixelRatio,
        rotation: renderViewport.rotation, pageElement, textLayer, canvas, epoch });
      const binding: CanonicalPdfTextBinding = Object.freeze({ asset: source.asset, renderToken,
        pageElement, textLayer, canvas, textContent: fixedText, naturalViewport, renderViewport,
        drawnWidth: drawing.drawnWidth, pixelRatio: drawing.pixelRatio,
        isCurrent: () => active.current === drawing && drawing.epoch === epoch && isSettled.current
          && pageRef.current === pageElement && pageElement.isConnected && source.error === null
          && source.resource.error === null
          && source.textContent === fixedText && pageElement.querySelector('.textLayer') === textLayer
          && pageElement.querySelector('canvas') === canvas && fonts.status === 'loaded'
          && drawing.fonts === gate && !gate.pending,
      });
      drawing.binding = binding;
      publish(binding, null);
    };
    const refreshSource = () => {
      // A previous-width callback may provide immutable source facts, but can
      // never mark canvas/text rendering complete for the new width.
      if (active.current?.source === source) source?.refresh?.();
    };
    return {
      refresh,
      invalidate,
      onDocumentLoad(document: PDFDocumentProxy) {
        // Document's retained callback can originate on the previous page. It
        // may update only the captured resource, never a newer resource/URL.
        if (!resource || active.current?.source?.resource !== resource) return;
        if (resource.document && resource.document !== document) return;
        resource.document = document;
        resource.documentPages = document.numPages;
        if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) resource.error = 'layout-mismatch';
        resource.refresh?.();
      },
      onPageLoad(page: PDFPageProxy) {
        if (!source || active.current?.source !== source) return;
        if (source.page && source.page !== page) {
          // An instance replacement needs a new asset/mount lifecycle; do not
          // combine old textContent with a page from a second PDF instance.
          source.error = 'stale-render';
        } else { source.page = page; source.error = sourcePageProblem(source); }
        refreshSource();
      },
      onTextContent(content: TextContent) {
        if (!source || active.current?.source !== source) return;
        if (source.textContent !== content) {
          source.textContent = content;
          // Source-content replacement revokes already published evidence.
          if (drawing.binding) invalidate('stale-render');
        }
        refreshSource();
      },
      onCanvasRendered() {
        if (active.current !== drawing || !mount()) return;
        drawing.canvasReady = true;
        refresh();
      },
      onTextLayerRendered() {
        if (active.current !== drawing || !mount()) return;
        // This is also the explicit notification after a host refits the layer.
        if (drawing.binding) invalidate('stale-render');
        drawing.textReady = true;
        refresh();
      },
      onRenderError() {
        if (active.current !== drawing) return;
        drawing.canvasReady = false; drawing.textReady = false;
        invalidate('stale-render');
      },
    };
  }, [drawing, source, resource, pageRef]);

  useLayoutEffect(() => {
    active.current = drawing;
    drawing.mount = pageRef.current;
    if (source) source.refresh = events.refresh;
    if (resource) resource.refresh = events.refresh;
    return () => {
      drawing.epoch++; drawing.binding = null;
      if (active.current === drawing) active.current = null;
      if (source?.refresh === events.refresh) source.refresh = null;
      if (resource?.refresh === events.refresh) resource.refresh = null;
    };
  }, [drawing, pageRef, source, resource, events]);
  useLayoutEffect(() => {
    isSettled.current = settled;
    events.refresh();
  }, [events, settled]);
  useLayoutEffect(() => {
    const document = pageRef.current?.ownerDocument ?? window.document;
    const fonts = document?.fonts;
    if (!fonts) { events.invalidate('fonts-pending'); return; }
    const gate = createPdfFontReadiness({ fonts,
      isCurrent: () => active.current === drawing && (pageRef.current?.ownerDocument ?? window.document) === document
        && document.fonts === fonts,
      invalidate: () => events.invalidate('fonts-pending'),
      refit: () => {
        const node = pageRef.current, source = drawing.source;
        if (!isSettled.current || !node?.isConnected || node !== drawing.mount || !drawing.canvasReady || !drawing.textReady
          || !source || source.error || source.resource.error || source.resource.documentPages === null
          || !source.page || !source.textContent || sourcePageProblem(source)) return false;
        return refit.current();
      }, onReady: events.refresh });
    drawing.fonts = gate;
    fonts.addEventListener('loading', gate.loading);
    fonts.addEventListener('loadingdone', gate.notify);
    fonts.addEventListener('loadingerror', gate.notify);
    gate.loading();
    return () => {
      gate.dispose();
      if (drawing.fonts === gate) drawing.fonts = null;
      fonts.removeEventListener('loading', gate.loading);
      fonts.removeEventListener('loadingdone', gate.notify);
      fonts.removeEventListener('loadingerror', gate.notify);
    };
  }, [events, pageRef, drawing]);

  const binding = publication?.drawing === drawing && settled ? publication.binding : null;
  const problem = publication?.drawing === drawing ? publication.problem : 'stale-render';
  useLayoutEffect(() => {
    onPdfTextSurface?.(binding);
    return () => onPdfTextSurface?.(null);
  }, [binding, onPdfTextSurface]);
  return { binding, problem, onDocumentLoad: events.onDocumentLoad, onPageLoad: events.onPageLoad,
    onTextContent: events.onTextContent, onCanvasRendered: events.onCanvasRendered,
    onTextLayerRendered: events.onTextLayerRendered, onRenderError: events.onRenderError };
}
