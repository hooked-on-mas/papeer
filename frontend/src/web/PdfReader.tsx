import { useWritingToolbar } from "../features/reader/WritingToolbar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PdfDocument as Document, PdfPage as Page } from "../features/reader/pdf/PdfDocument";
import { PageNavigatorView } from "../features/reader/PageNavigatorView";
import { cappedPixelRatio } from "../features/reader/canvasBudget";
import { pageWidthFor, ZOOM_FIT_PAGE } from "../features/reader/zoomLevels";
import { usePdfPinchZoom } from "./usePdfPinchZoom";
import { usePdfReadingPlace, type PdfReadingPlacePort } from "./usePdfReadingPlace";
import { useMediaQuery } from "../lib/useMediaQuery";
import { COMPACT_LAYOUT_QUERY } from "./readerLayout";
export type PdfViewport = { ratio: number; pageWidth: number; fitWidth: number; fitPageWidth: number; enabled: boolean };
export type PdfPagePresentation = PdfViewport & { page: number; compactTools: boolean; children: ReactNode };

export function PdfReader({ url, renderPage, emptyEditingHint, readingPlace, surfaceInput = true, externalReadingState = false, onViewport, swipeEnabled = true, beforeNavigate = () => true, pageNumber, onPageCount, zoom: requestedZoom, fitPage: requestedFit = false, onZoom: suppliedOnZoom, navigation = true, editing = true, readingKey, onPageSwipe }: {
  url: string; pageNumber?: number; renderPage?: (page: PdfPagePresentation) => ReactNode;
  emptyEditingHint?: ReactNode; readingPlace?: PdfReadingPlacePort; swipeEnabled?: boolean; beforeNavigate?: () => boolean;
  surfaceInput?: boolean; onViewport?: (viewport: PdfViewport) => void;
  /** A common ReaderSession owns zoom normalization, landing and persisted position. */
  externalReadingState?: boolean;
  onPageSwipe?: (direction: -1 | 1) => void; readingKey?: string; onPageCount?: (count: number) => void; zoom?: number; fitPage?: boolean; onZoom?: (zoom: number) => void; navigation?: boolean; editing?: boolean;
}) {
  const [localZoom, setLocalZoom] = useState(1);
  const zoom = requestedZoom ?? localZoom;
  const fitPage = requestedFit || zoom === 0;
  const onZoom = useCallback((value: number) => { if (suppliedOnZoom) suppliedOnZoom(value); else setLocalZoom(value); }, [suppliedOnZoom]);
  const [pages, setPages] = useState(0), [localPage, setPage] = useState(1);
  const page = pageNumber ?? localPage;
  useEffect(() => { if (pages > 0) onPageCount?.(pages); }, [pages, onPageCount]);
  const [width, setWidth] = useState(700), [ratio, setRatio] = useState(1.414);
  const writingToolbar = useWritingToolbar();
  const compactViewport = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const container = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  useLayoutEffect(() => {
    const root = container.current, pane = root?.closest<HTMLElement>(".web-pdf-pane");
    if (!root || !pane) return;
    // Measure the viewport and controls, never the rendered page: the latter would
    // feed its own size back into fitting. Works for portrait and landscape pages.
    const controls = [pane.querySelector(".asset-heading"), root.querySelector(".ink-tools"), root.querySelector(".pdf-tools")].filter((element): element is HTMLElement => element instanceof HTMLElement);
    const measure = () => setAvailableHeight(Math.max(1, pane.clientHeight - controls.reduce((height, element) => height + element.getBoundingClientRect().height, 0) - 4));
    const observer = new ResizeObserver(measure);
    observer.observe(pane); controls.forEach(element => observer.observe(element)); measure();
    if (fitPage && !externalReadingState) pane.scrollTo(0, 0);
    return () => observer.disconnect();
  }, [fitPage, editing, navigation, url, page, externalReadingState]);
  const minimumZoom = pageWidthFor(ZOOM_FIT_PAGE, width, availableHeight, ratio) / width;
  const effectiveZoom = pageWidthFor(fitPage ? ZOOM_FIT_PAGE : zoom, width, availableHeight, ratio) / width;
  // Match react-pdf's integer CSS canvas width, rather than tracking subpixel layout noise.
  const drawnWidth = Math.max(1, Math.floor(width * effectiveZoom));
  const pixelRatio = cappedPixelRatio(window.devicePixelRatio, drawnWidth, drawnWidth * ratio);
  const render = useMemo(() => ({ key: `${url}:${page}:${drawnWidth}:${pixelRatio}` }), [url, page, drawnWidth, pixelRatio]);
  const activeRender = useRef<typeof render | null>(render);
  const [rendered, setRendered] = useState<typeof render | null>(null);
  useLayoutEffect(() => {
    activeRender.current = render;
    return () => { activeRender.current = null; };
  }, [render]);
  const initialZoom = useRef(zoom), normalized = useRef(false);
  useEffect(() => {
    if (externalReadingState || normalized.current || rendered !== render || availableHeight <= 0) return;
    normalized.current = true;
    const pane = container.current?.closest(".web-pdf-pane");
    const primary = pane?.closest(".web-document-reader")?.querySelector(".web-pdf-pane");
    // Only normalize a restored value once, on the primary pane. A follower's different
    // aspect ratio must clamp its own drawing without rewriting the touched pane's zoom.
    if ((!primary || primary === pane) && !fitPage && zoom === initialZoom.current && zoom < minimumZoom) onZoom(0);
  }, [fitPage, rendered, render, availableHeight, zoom, minimumZoom, onZoom, externalReadingState]);
  usePdfPinchZoom(container, effectiveZoom, onZoom, `${url}:${page}`, { minimumZoom, onPageSwipe: onPageSwipe ?? (navigation ? direction => { if (beforeNavigate()) setPage(value => Math.max(1, Math.min(pages || 1, value + direction))); } : undefined), swipeEnabled, enabled: surfaceInput });
  const fitPageWidth = pageWidthFor(ZOOM_FIT_PAGE, width, availableHeight, ratio);
  useLayoutEffect(() => { onViewport?.({ ratio, pageWidth: drawnWidth, fitWidth: width, fitPageWidth, enabled: rendered === render }); },
    [onViewport, ratio, drawnWidth, width, fitPageWidth, rendered, render]);
  usePdfReadingPlace(container, { key: `${url}:${page}`, storageKey: readingKey, page, fitPage, width, pageWidth: drawnWidth, ready: rendered === render }, setWidth, readingPlace, !externalReadingState);
  const document = <Document file={url} loading="PDFを読み込んでいます…" error="PDFを表示できません。ダウンロードしてご確認ください。"
    onLoadSuccess={({ numPages }) => setPages(numPages)}>
    {pages > 0 && (page < 1 || page > pages) ? <p role="alert" className="error">保存されたPDFに指定ページがありません。PCから再アップロードしてください。</p>
    : <Page key={render.key} pageNumber={page} width={drawnWidth} devicePixelRatio={pixelRatio}
      renderAnnotationLayer={false} onLoadSuccess={pdf => {
      const viewport = pdf.getViewport({ scale: 1 }); setRatio(viewport.height / viewport.width);
    }} onRenderSuccess={() => {
      // A cancelled old canvas can finish late. It must not enable or disable the current editor.
      if (activeRender.current === render) setRendered(render);
    }} onRenderError={() => { if (activeRender.current === render) setRendered(null); }} />}
  </Document>;
  return <div className={`pdf${fitPage ? " pdf-fit-page" : ""}`} ref={container} data-fit-page={fitPage} data-rendered={rendered === render}
    style={{ width: Math.max(width, drawnWidth), "--pdf-pane-width": `${width}px` } as CSSProperties}>
    {navigation && <div className="pdf-tools"><PageNavigatorView paperId={url} currentPage={page} count={pages} compact shortcuts={false}
      atStart={page <= 1} atEnd={page >= pages} onJump={value => { if (beforeNavigate()) setPage(value); }} onMove={delta => { if (beforeNavigate()) setPage(value => Math.max(1, Math.min(pages || 1, value + delta))); }} /></div>}
    {renderPage ? renderPage({ page, ratio, pageWidth: drawnWidth, fitWidth: width, fitPageWidth, enabled: rendered === render,
      compactTools: compactViewport || (writingToolbar?.width || width) <= 440, children: document })
      : <>{emptyEditingHint}<div className="web-pdf-surface" style={{ width: drawnWidth, minHeight: drawnWidth * ratio }}>{document}</div></>}
  </div>;
}
