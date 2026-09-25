import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Document, Page, pdfjs } from "react-pdf";
import type { PageCallback } from "react-pdf/dist/shared/types.js";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { authToken } from "@/api/client";
import { PdfContextMenu } from "./PdfContextMenu";

// Bundled worker, cMaps and fonts keep PDFs (including CJK text) readable offline.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPaneProps {
  url: string | null;
  pageNumber: number;
  /** Multiplier over the width that fits the pane. */
  zoom: number;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Shown instead of a page, e.g. while a translation is pending. */
  placeholder?: React.ReactNode;
  missingPageMessage?: string;
  /** Marks quotes taken from this pane as coming from the translation. */
  translated?: boolean;
}

const PADDING = 16;

/**
 * pdf.js sizes each text-layer span by measuring its text on a canvas, but the canvas and the page
 * can resolve the fallback font differently: in WebView2 on Japanese Windows the canvas measures
 * "sans-serif" as Arial while the spans render in Meiryo, so lines mixing Japanese and Latin come out
 * ~7% too wide and a selection lands on the wrong characters. Refit each span to its text's width in
 * the PDF, measured in the font the page actually renders.
 */
function fitTextLayer(layer: HTMLElement, content: TextContent, scale: number) {
  const spans = layer.querySelectorAll<HTMLElement>('span[role="presentation"]');
  // pdf.js appends a span for each non-empty item, in order.
  const items = content.items.filter((item): item is TextItem => "str" in item && item.str !== "");
  if (spans.length !== items.length) return;
  const minFontSize = Number(layer.style.getPropertyValue("--min-font-size")) || 1;
  // Read every width before writing so the page lays out once.
  const widths = Array.from(spans, (span) => span.offsetWidth);
  spans.forEach((span, i) => {
    // Only the spans pdf.js stretched; single characters keep their natural width.
    if (!span.style.getPropertyValue("--scale-x") || !widths[i]) return;
    const item = items[i];
    const width = content.styles[item.fontName]?.vertical ? item.height : item.width;
    span.style.setProperty("--scale-x", String((width * scale * minFontSize) / widths[i]));
  });
}

export function PdfPane({ url, pageNumber, zoom, onScroll, scrollRef, placeholder, missingPageMessage, translated = false }: PdfPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const loadedPage = useRef<PageCallback | null>(null);
  const textContent = useRef<TextContent | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      // Before the paint, so a pane that just narrowed never shows the page cut off.
      if (entries[0]) flushSync(() => setContainerWidth(entries[0].contentRect.width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => setNumPages(null), [url]);

  const token = authToken();
  const options = useMemo(() => ({
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
  }), [token]);

  const fitWidth = Math.max(250, containerWidth - PADDING * 2);
  const pageWidth = Math.round(fitWidth * zoom);

  // react-pdf replaces the canvas whenever the width changes, leaving the page blank until it is
  // redrawn. So while a side panel opens or the pane is resized or zoomed, the current drawing is
  // scaled to fit, and the page is redrawn once the width settles, with a copy of the old drawing
  // covering it until the new one is ready.
  const [drawnWidth, setDrawnWidth] = useState(0);
  const [covering, setCovering] = useState(false);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!containerWidth || pageWidth === drawnWidth) return;
    if (!drawnWidth) {
      setDrawnWidth(pageWidth);
      return;
    }
    const timer = setTimeout(() => {
      const canvas = pageRef.current?.querySelector("canvas");
      const snapshot = snapshotRef.current;
      // A canvas still hidden is mid-redraw; the snapshot already holds the last finished drawing.
      if (canvas?.width && snapshot && canvas.style.visibility !== "hidden") {
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        snapshot.getContext("2d")?.drawImage(canvas, 0, 0);
        setCovering(true);
      }
      setDrawnWidth(pageWidth);
    }, 150);
    return () => clearTimeout(timer);
  }, [containerWidth, pageWidth, drawnWidth]);

  useEffect(() => setCovering(false), [url, pageNumber]);

  // Stable, since react-pdf redraws the text layer whenever this callback changes.
  const onTextLayerRendered = useCallback(() => {
    const page = loadedPage.current;
    const layer = pageRef.current?.querySelector<HTMLElement>(".textLayer");
    if (!page || !layer || !textContent.current) return;
    // The scale react-pdf renders the text layer at for this width.
    const scale = page.getViewport({ scale: drawnWidth / page.getViewport({ scale: 1 }).width }).scale;
    fitTextLayer(layer, textContent.current, scale);
  }, [drawnWidth]);

  const message = (text: React.ReactNode) => (
    <div className="h-full flex items-center justify-center p-8 text-center text-[13px] text-muted-foreground leading-relaxed">
      <div className="max-w-sm">{text}</div>
    </div>
  );

  return (
    <PdfContextMenu translated={translated}>
      <div
        ref={(node) => {
          containerRef.current = node;
          if (scrollRef) scrollRef.current = node;
        }}
        onScroll={onScroll}
        className={`w-full h-full bg-reader-bg ${zoom > 1 ? "overflow-auto" : "overflow-y-auto overflow-x-hidden"}`}
      >
        {placeholder ? message(placeholder) : !url ? message("PDFがありません。") : (
          <div className="w-fit min-w-full" style={{ padding: PADDING }}>
            <Document
              file={url}
              options={options}
              onLoadSuccess={(doc) => setNumPages(doc.numPages)}
              loading={<PageSkeleton width={pageWidth} />}
              error={message("PDFを読み込めませんでした。")}
              className="mx-auto w-fit"
            >
              {numPages !== null && pageNumber > numPages ? message(missingPageMessage ?? "このページはありません。") : drawnWidth > 0 && (
                <div className="relative" style={{ zoom: pageWidth === drawnWidth ? undefined : pageWidth / drawnWidth }}>
                  <Page
                    pageNumber={pageNumber}
                    width={drawnWidth}
                    inputRef={pageRef}
                    onLoadSuccess={(page) => { loadedPage.current = page; }}
                    onGetTextSuccess={(content) => { textContent.current = content; }}
                    onRenderSuccess={() => setCovering(false)}
                    onRenderError={() => setCovering(false)}
                    onRenderTextLayerSuccess={onTextLayerRendered}
                    renderTextLayer
                    renderAnnotationLayer
                    loading={<PageSkeleton width={drawnWidth} />}
                    className="shadow-sm border bg-white"
                  />
                  {/* Sits over the canvas, inside the page's 1px border. */}
                  <canvas
                    ref={snapshotRef}
                    hidden={!covering}
                    className="absolute left-px top-px w-[calc(100%-2px)] h-[calc(100%-2px)] pointer-events-none"
                  />
                </div>
              )}
            </Document>
          </div>
        )}
      </div>
    </PdfContextMenu>
  );
}

function PageSkeleton({ width }: { width: number }) {
  // Letter-ish proportions keep the layout from jumping while the page renders.
  return <div className="bg-card border animate-pulse mx-auto" style={{ width, height: Math.round(width * 1.3) }} />;
}
