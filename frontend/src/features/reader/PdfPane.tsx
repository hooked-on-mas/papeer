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
import { selectInTextLayer } from "./textLayerRange";
import { useInkEditor } from "./useInkEditor";
import { InkOverlay } from "./InkOverlay";
import { InkToolbar } from "./InkToolbar";
import { InkCapture } from "./InkCapture";
import type { Bounds } from "./inkGeometry";
import type { StickyNote } from "./stickyNotes";
import { StickyNoteMarker } from "./StickyNoteMarker";
import { openStickyNote } from "./stickyNotesStore";

// Bundled worker, cMaps and fonts keep PDFs (including CJK text) readable offline.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPaneProps {
  inkPage?: { paperId: string; page: number };
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
  searchTerm?: string;
  jumpTarget?: JumpTarget | null;
  savedHighlights?: StickyNote[];
}

/** A place to scroll to, from a bookmark, a search result or a chat attachment. */
export interface JumpTarget {
  id: number;
  page: number;
  side: "original" | "translated";
  anchor_y: number;
  anchor_x?: number;
  /** A chat attachment's passage, selected once its text layer is ready. */
  passage?: { start?: number | null; end?: number | null; raw?: string };
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

export function PdfPane({ url, pageNumber, zoom, onScroll, scrollRef, placeholder, missingPageMessage,
  translated = false, searchTerm = "", jumpTarget,
  savedHighlights = [], inkPage }: PdfPaneProps) {
  const [inkViewport, setInkViewport] = useState<{ key: string; ratio: number } | null>(null);
  const editor = useInkEditor(url && !placeholder ? inkPage?.paperId : undefined, translated ? "translated" : "original", inkPage?.page ?? pageNumber, inkViewport?.ratio ?? 1);
  const { ink } = editor;
  const [capture, setCapture] = useState<Bounds | null>(null);
  useEffect(() => setCapture(null), [url, pageNumber, editor.tool]);
  const [placingNote, setPlacingNote] = useState(false);
  useEffect(() => setPlacingNote(false), [url, pageNumber]);
  useEffect(() => { if (editor.tool !== "select") setPlacingNote(false); }, [editor.tool]);
  const inkKey = `${url}:${pageNumber}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const loadedPage = useRef<PageCallback | null>(null);
  const textContent = useRef<TextContent | null>(null);
  const [matches, setMatches] = useState<{ left: number; top: number; width: number; height: number; saved: boolean }[]>([]);

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

  // Whether the text layer shows this page yet, rather than the one before it.
  const textLayerReady = useRef(false);
  useEffect(() => { setCovering(false); setMatches([]); textLayerReady.current = false; }, [url, pageNumber]);
  const jumpToBookmark = useCallback(() => {
    if (!jumpTarget || jumpTarget.side !== (translated ? "translated" : "original")) return;
    const page = pageRef.current;
    const scroller = containerRef.current;
    if (!page || !scroller) return;
    const top = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top + jumpTarget.anchor_y * page.clientHeight - scroller.clientHeight * 0.25);
    if (jumpTarget.anchor_x !== undefined) {
      const left = page.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
      scroller.scrollLeft = Math.max(0, left + jumpTarget.anchor_x * page.clientWidth - scroller.clientWidth * 0.5);
    }
  }, [jumpTarget, translated]);
  useEffect(() => { jumpToBookmark(); }, [jumpToBookmark, pageNumber, url]);

  // Read through a ref: the text layer callback must stay stable (see below).
  const jumpRef = useRef(jumpTarget);
  jumpRef.current = jumpTarget;
  const selectedJump = useRef<JumpTarget | null>(null);
  const selectJumpPassage = useCallback(() => {
    const target = jumpRef.current;
    if (!target?.passage || selectedJump.current === target || target.side !== (translated ? "translated" : "original")) return;
    const layer = pageRef.current?.querySelector<HTMLElement>(".textLayer");
    if (!textLayerReady.current || !layer?.textContent) return;
    // Once per jump, so that a redraw after zooming keeps whatever the user selected since.
    selectedJump.current = target;
    selectInTextLayer(layer, target.passage);
  }, [translated]);
  useEffect(() => { selectJumpPassage(); }, [selectJumpPassage, jumpTarget]);

  // Stable, since react-pdf redraws the text layer whenever this callback changes.
  const onTextLayerRendered = useCallback(() => {
    const page = loadedPage.current;
    const layer = pageRef.current?.querySelector<HTMLElement>(".textLayer");
    if (!page || !layer || !textContent.current) return;
    // The scale react-pdf renders the text layer at for this width.
    const scale = page.getViewport({ scale: drawnWidth / page.getViewport({ scale: 1 }).width }).scale;
    fitTextLayer(layer, textContent.current, scale);
    const terms = [...savedHighlights.map(item => ({ text: item.quote.trim().slice(0, 32).toLocaleLowerCase(), saved: true })),
      { text: searchTerm.trim().toLocaleLowerCase(), saved: false }].filter(item => item.text);
    const spans = Array.from(layer.querySelectorAll<HTMLElement>('span[role="presentation"]'));
    if (!terms.length || !spans.length) { setMatches([]); return; }
    const content = spans.map(span => span.textContent ?? "");
    const joined = content.join("").toLocaleLowerCase();
    const positions: number[] = [];
    let at = 0;
    for (const value of content) { positions.push(at); at += value.length; }
    const rects: { left: number; top: number; width: number; height: number; saved: boolean }[] = [];
    const base = pageRef.current?.getBoundingClientRect();
    if (!base) return;
    for (const term of terms) for (let start = joined.indexOf(term.text); start >= 0 && rects.length < 100; start = joined.indexOf(term.text, start + term.text.length)) {
      const end = start + term.text.length;
      let first = -1;
      let last = -1;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] <= start) first = i;
        if (positions[i] < end) last = i;
      }
      if (first < 0 || last < 0) continue;
      const range = document.createRange();
      const firstNode = spans[first].firstChild;
      const lastNode = spans[last].firstChild;
      if (!firstNode || !lastNode || firstNode.nodeType !== Node.TEXT_NODE || lastNode.nodeType !== Node.TEXT_NODE) continue;
      range.setStart(firstNode, Math.min(start - positions[first], firstNode.textContent?.length ?? 0));
      range.setEnd(lastNode, Math.min(end - positions[last], lastNode.textContent?.length ?? 0));
      for (const rect of Array.from(range.getClientRects())) rects.push({ left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height, saved: term.saved });
    }
    setMatches(rects);
  }, [drawnWidth, searchTerm, savedHighlights]);
  useEffect(() => { onTextLayerRendered(); }, [onTextLayerRendered, pageNumber]);
  const handleTextLayerRendered = useCallback(() => {
    textLayerReady.current = true;
    onTextLayerRendered();
    selectJumpPassage();
  }, [onTextLayerRendered, selectJumpPassage]);

  const message = (text: React.ReactNode) => (
    <div className="h-full flex items-center justify-center p-8 text-center text-[13px] text-muted-foreground leading-relaxed">
      <div className="max-w-sm">{text}</div>
    </div>
  );

  return (
    <div ref={editor.scopeRef} className="flex flex-col h-full min-h-0" onPointerDownCapture={editor.activate} onFocusCapture={editor.activate}>
    {inkPage && url && !placeholder && <InkToolbar editor={editor} disabled={inkViewport?.key !== inkKey} onStickyNote={selection => {
      const box = editor.selection;
      if (selection && box) {
        void openStickyNote({ paperId: inkPage.paperId, page: inkPage.page, side: translated ? "translated" : "original",
          anchorY: box.y, anchorX: box.x, quote: editor.selected.map(s => s.text ?? "").filter(Boolean).join("\n") });
      } else {
        editor.setTool("select"); setCapture(null); setPlacingNote(value => !value);
      }
    }} />}
    {placingNote && <div role="status" className="flex items-center gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-950">
      PDF上の貼りたい場所をクリックしてください。
      <button className="ml-auto underline" onClick={() => setPlacingNote(false)}>キャンセル</button>
    </div>}
    <div className="flex-1 min-h-0 relative">
    {capture && inkPage && <InkCapture key={`${inkPage.paperId}:${inkPage.page}`} paperId={inkPage.paperId} page={inkPage.page}
      side={translated ? "translated" : "original"} box={capture} onClose={() => setCapture(null)} />}
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
                    onRenderSuccess={(page) => {
                      setCovering(false); jumpToBookmark();
                      const viewport = page.getViewport({ scale: 1 });
                      setInkViewport({ key: inkKey, ratio: viewport.height / viewport.width });
                    }}
                    onRenderError={() => setCovering(false)}
                    onRenderTextLayerSuccess={handleTextLayerRendered}
                    renderTextLayer
                    renderAnnotationLayer
                    loading={<PageSkeleton width={drawnWidth} />}
                    className="shadow-sm border bg-white"
                  />
                  {matches.map(({ saved, ...rect }, index) => <div key={index} className={`absolute pointer-events-none ${saved ? "bg-amber-400/30" : "bg-yellow-300/50"}`} style={rect} />)}
                  {savedHighlights.map(item => <StickyNoteMarker key={`sticky-${item.id}`} item={item}
                    movable={!editor.locked && !placingNote && ["select", "region", "lasso"].includes(editor.tool)} />)}
                  {placingNote && inkPage && <button autoFocus aria-label="PDFのこの位置に付箋を貼る" className="absolute inset-0 z-30 cursor-copy bg-amber-100/10 outline-2 outline-amber-400"
                    onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setPlacingNote(false); } }}
                    onClick={e => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      void openStickyNote({ paperId: inkPage.paperId, page: inkPage.page, side: translated ? "translated" : "original", quote: "",
                        anchorY: e.detail === 0 ? 0.5 : Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
                        anchorX: e.detail === 0 ? 0.5 : Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) });
                      setPlacingNote(false);
                    }} />}
                  {/* Sits over the canvas, inside the page's 1px border. */}
                  <canvas
                    ref={snapshotRef}
                    hidden={!covering}
                    className="absolute left-px top-px w-[calc(100%-2px)] h-[calc(100%-2px)] pointer-events-none"
                  />
                  {ink.entry && (ink.ready || editor.tool === "capture") && inkViewport?.key === inkKey && <InkOverlay key={`${inkPage?.paperId}:${inkPage?.page}:${inkKey}:${editor.tool}:${editor.locked}:${editor.visible}`}
                    editor={editor} aspectRatio={inkViewport.ratio} onCapture={setCapture} />}
                </div>
              )}
            </Document>
          </div>
        )}
      </div>
    </PdfContextMenu>
    </div>
    </div>
  );
}

function PageSkeleton({ width }: { width: number }) {
  // Letter-ish proportions keep the layout from jumping while the page renders.
  return <div className="bg-card border animate-pulse mx-auto" style={{ width, height: Math.round(width * 1.3) }} />;
}
