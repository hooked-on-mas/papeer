import React, { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
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

export function PdfPane({ url, pageNumber, zoom, onScroll, scrollRef, placeholder, missingPageMessage, translated = false }: PdfPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setContainerWidth(entries[0].contentRect.width);
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
              {numPages !== null && pageNumber > numPages ? message(missingPageMessage ?? "このページはありません。") : (
                <Page
                  pageNumber={pageNumber}
                  width={pageWidth}
                  renderTextLayer
                  renderAnnotationLayer
                  loading={<PageSkeleton width={pageWidth} />}
                  className="shadow-sm border bg-white"
                />
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
