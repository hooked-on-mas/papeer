import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Document, Page, pdfjs } from "react-pdf";
import type { PageCallback } from "react-pdf/dist/shared/types.js";
import type { PDFDocumentProxy, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
// The legacy build, as for the main thread (vite.config.ts pdfjsLegacy): the worker must be the same release.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { MessageSquareText } from "lucide-react";
import { authToken } from "@/api/client";
import { shell } from "@/shell";
import { useStore } from "@/store";
import { useTheme } from "@/app/ThemeProvider";
import { externalHttpUrl } from "@/lib/externalLinks";
import { PdfContextMenu } from "./PdfContextMenu";
import { selectInTextLayer } from "./textLayerRange";
import { inkToolActive, useInkEditor, useInkPanes } from "./useInkEditor";
import { movePage } from "./navigation";
import { InkOverlay } from "./InkOverlay";
import { InkToolbar } from "./InkToolbar";
import { InkCapture } from "./InkCapture";
import type { Bounds } from "./inkGeometry";
import { isHighlight, type StickyNote } from "./stickyNotes";
import { StickyNoteMarker } from "./StickyNoteMarker";
import { openStickyNote, useStickyNotes } from "./stickyNotesStore";
import { highlightColor, highlightFill } from "./highlights";
import { SelectionToolbar } from "./SelectionToolbar";
import { cappedPixelRatio, snapshotSize } from "./canvasBudget";
import { resolveDestination, type PdfPlace } from "./pdfLinks";
import { fitWidthFor, pageWidthFor, scrollsSideways, ZOOM_FIT_PAGE } from "./zoomLevels";
import { createPlaceKeeper, scrollForPlace, type PaneView } from "./readingPlace";
import { pageAppearance } from "./pageAppearance";
import { inkToolbarSide } from "./readerBars";
import { usePdfTouch, usePdfTouchOwner } from "./usePdfTouch";

// Bundled worker, cMaps and fonts keep PDFs (including CJK text) readable offline.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPaneProps {
  inkPage?: { paperId: string; page: number; pageId?: string };
  preservePaperColor?: boolean;
  url: string | null;
  pageNumber: number;
  /** Multiplier over the width that fits the pane, or ZOOM_FIT_PAGE to fit the whole page. */
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
  /** The sticky notes and highlights on the page shown, of this pane's side. */
  savedHighlights?: StickyNote[];
  /** Called with each PDF once it has loaded, e.g. to read its table of contents. */
  onDocumentLoad?: (doc: PDFDocumentProxy) => void;
  /** A link to another place in this PDF was clicked; `page` is the PDF's own page number. */
  onInternalLink?: (place: PdfPlace) => void;
  /** Names the pane over its top-left corner while the view is at the top of the page. */
  caption?: React.ReactNode;
  /** A small mark kept over the top-right corner however far the page is scrolled, e.g. 翻訳中. */
  badge?: React.ReactNode;
  /**
   * Where the writing toolbar goes, shared by both panes: the pane it serves places it there.
   * Without one, the pane shows its own toolbar above the page.
   */
  inkToolbarSlot?: HTMLElement | null;
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
  /** Show the end of the page in both panes instead of an anchor, when paging back. */
  toEnd?: boolean;
}

const PADDING = 16;

/** The pane's view and the page in it (its box as drawn, CSS zoom and all), for readingPlace.ts. */
function paneView(scroller: HTMLElement, page: HTMLElement): PaneView {
  const box = page.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  return {
    scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft,
    clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight,
    page: { top: box.top - frame.top - scroller.clientTop + scroller.scrollTop, left: box.left - frame.left - scroller.clientLeft + scroller.scrollLeft,
      width: box.width, height: box.height },
  };
}

/** Frees a canvas's pixels; a hidden canvas otherwise keeps them for as long as it is mounted. */
function releaseCanvas(canvas: HTMLCanvasElement | null) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

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
  savedHighlights = [], inkPage, preservePaperColor = false, onDocumentLoad, onInternalLink, caption, badge, inkToolbarSlot }: PdfPaneProps) {
  const [inkViewport, setInkViewport] = useState<{ key: string; ratio: number } | null>(null);
  const side = translated ? "translated" : "original";
  const editor = useInkEditor(url && !placeholder ? inkPage?.paperId : undefined, side, inkPage?.page ?? pageNumber, inkViewport?.ratio ?? 1, inkPage?.pageId);
  const { ink } = editor;
  // Whether this pane has a page to write on, and so can be the one the writing toolbar serves.
  const inkHost = !!inkPage && !!url && !placeholder;
  useEffect(() => {
    const { setHost } = useInkPanes.getState();
    setHost(side, inkHost);
    return () => setHost(side, false);
  }, [side, inkHost]);
  const servesToolbar = useInkPanes((s) => inkToolbarSide(s.active, s.hosts)) === side && inkHost;
  // The toolbar's keys (Ctrl+Z, Delete…) follow it when it moves to this pane from its 原文/訳文 switch.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- editor is new on every render: activate only when the toolbar comes here
  useEffect(() => { if (servesToolbar) editor.activate(); }, [servesToolbar]);
  const activate = () => {
    editor.activate();
    if (inkHost) useInkPanes.getState().setActive(side);
  };
  // The caption steps aside once the page is scrolled, so that it never covers the text.
  const [scrolled, setScrolled] = useState(false);
  const [capture, setCapture] = useState<Bounds | null>(null);
  useEffect(() => setCapture(null), [url, pageNumber, editor.tool]);
  const [placingNote, setPlacingNote] = useState(false);
  useEffect(() => setPlacingNote(false), [url, pageNumber]);
  useEffect(() => { if (editor.tool !== "select") setPlacingNote(false); }, [editor.tool]);
  const inkKey = `${url}:${pageNumber}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The scroller and the element around it, for the toolbar over a selection.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (scrollRef) scrollRef.current = node;
    setScroller(node);
  }, [scrollRef]);
  // Sticky notes show as markers (and their quotes as marks in the text), highlights as coloured rectangles.
  const notes = useMemo(() => savedHighlights.filter((item) => !isHighlight(item)), [savedHighlights]);
  const highlights = useMemo(() => savedHighlights.filter(isHighlight), [savedHighlights]);
  const selectedId = useStickyNotes((s) => s.selectedId);
  // The notes' quotes marked in the text, as one string: adding or recolouring a highlight must not redraw
  // the text layer (see onTextLayerRendered), which would drop the selection.
  const noteQuotes = JSON.stringify(notes.map((item) => item.quote.trim().slice(0, 32).toLocaleLowerCase()).filter(Boolean));
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerWidth = containerSize.width;
  const [numPages, setNumPages] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const loadedPage = useRef<PageCallback | null>(null);
  const textContent = useRef<TextContent | null>(null);
  const [matches, setMatches] = useState<{ left: number; top: number; width: number; height: number; saved: boolean }[]>([]);
  const appearance = pageAppearance(useStore((s) => s.pageFilter), useTheme().dark && !preservePaperColor);
  // Only the canvases are filtered: the text layer, links, highlights, sticky notes and ink above
  // them keep their own colours.
  const pageStyle = { "--pdf-page-filter": appearance.filter ?? "none", "--pdf-page-bg": appearance.background } as React.CSSProperties;

  // The page shown and the width it is laid out at, read by the observer below.
  const pageKey = useRef(inkKey);
  pageKey.current = inkKey;
  const layoutWidth = useRef(0);
  const placeKeeper = useMemo(createPlaceKeeper, []);
  useEffect(() => placeKeeper.reset(), [placeKeeper, inkKey]);
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const scroller = containerRef.current;
      if (!rect || !scroller) return;
      // The page still has its old size here: where the view is on it, to come back to at the new size
      // (see readingPlace.ts). The same scroll position would land elsewhere on a page drawn larger or smaller.
      const page = pageRef.current?.isConnected ? pageRef.current : null;
      const key = pageKey.current;
      const place = page && usePdfTouchOwner.getState().pane !== scroller ? placeKeeper.measure(key, paneView(scroller, page), layoutWidth.current) : null;
      // Before the paint, so a pane that just narrowed never shows the page cut off or out of place.
      flushSync(() => setContainerSize((size) =>
        size.width === rect.width && size.height === rect.height ? size : { width: rect.width, height: rect.height }));
      const resized = pageRef.current;
      if (!place || !resized?.isConnected || pageKey.current !== key) return;
      const sideways = getComputedStyle(scroller).overflowX !== "hidden";
      const { top, left } = scrollForPlace(place, paneView(scroller, resized), { sideways });
      if (scroller.scrollTop !== top) scroller.scrollTop = top;
      if (scroller.scrollLeft !== left) scroller.scrollLeft = left;
      placeKeeper.restored(key, place, paneView(scroller, resized), layoutWidth.current);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [placeKeeper]);

  useEffect(() => setNumPages(null), [url]);

  const docRef = useRef<PDFDocumentProxy | null>(null);
  const internalLinkRef = useRef(onInternalLink);
  internalLinkRef.current = onInternalLink;
  // react-pdf keeps the first handler it is given, so this one stays the same and reads the latest props.
  const handleItemClick = useCallback(({ dest, pageNumber: target }: { dest?: unknown; pageNumber: number }) => {
    const report = (place: PdfPlace) => internalLinkRef.current?.(place);
    const doc = docRef.current;
    if (!doc || !dest) { report({ page: target }); return; }
    void resolveDestination(doc, dest).then((place) => report(place ?? { page: target }));
  }, []);

  // Web links in the PDF open in the default browser rather than inside the app. Links within the
  // PDF are pdf.js's own "#" links, handled by handleItemClick.
  const handleLinkClick = useCallback((e: React.MouseEvent) => {
    const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>(".annotationLayer a[href]");
    const href = link?.getAttribute("href");
    if (!link || !href || href.startsWith("#")) return;
    e.preventDefault();
    if (e.type !== "click") return;
    const safe = externalHttpUrl(link.href);
    if (!safe) {
      useStore.getState().setStatus("このリンクは開けません（開けるのは http・https のリンクだけです）。");
      return;
    }
    shell.openUrl(safe).catch(() => useStore.getState().setStatus(`リンクを開けませんでした: ${safe}`));
  }, []);

  const token = authToken();
  const options = useMemo(() => ({
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
  }), [token]);

  // Height over width of the page, known once it has loaded. Until then, a paper's pages usually share
  // the last page's shape (A4 before the first); but the canvas is sized for the last shape or A4,
  // whichever is taller, so that it stays within the memory limit for any page it turns out to be.
  const [pageShape, setPageShape] = useState<{ key: string; ratio: number } | null>(null);
  const shapeKnown = pageShape?.key === inkKey;
  const layoutRatio = shapeKnown ? pageShape.ratio : pageShape?.ratio ?? Math.SQRT2;
  const canvasRatio = shapeKnown ? pageShape.ratio : Math.max(pageShape?.ratio ?? Math.SQRT2, Math.SQRT2);
  const fitWidth = fitWidthFor(containerWidth - PADDING * 2);
  // The page's 1px border sits outside its canvas.
  const pageWidth = pageWidthFor(zoom, fitWidth, containerSize.height - PADDING * 2 - 2, layoutRatio);
  layoutWidth.current = pageWidth;

  // react-pdf replaces the canvas whenever the width changes, leaving the page blank until it is
  // redrawn. So while a side panel opens or the pane is resized or zoomed, the current drawing is
  // scaled to fit, and the page is redrawn once the width settles, with a copy of the old drawing
  // covering it until the new one is ready.
  const [drawnWidth, setDrawnWidth] = useState(0);
  const [covering, setCovering] = useState(false);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const touchZooming = usePdfTouchOwner(s => s.pane !== null);
  const { suppressClick: suppressTouchClick, ...touchHandlers } = usePdfTouch({
    pageKey: inkKey, enabled: !!url && !placeholder, paneRef: containerRef, surfaceRef,
    pageWidth, drawnWidth, fitWidth,
    fitPageWidth: pageWidthFor(ZOOM_FIT_PAGE, fitWidth, containerSize.height - PADDING * 2 - 2, layoutRatio),
    onPageSwipe: direction => { if (!inkToolActive()) movePage(direction); },
  });

  useEffect(() => {
    if (!containerWidth || pageWidth === drawnWidth || touchZooming) return;
    if (!drawnWidth) {
      setDrawnWidth(pageWidth);
      return;
    }
    const timer = setTimeout(() => {
      const canvas = pageRef.current?.querySelector("canvas");
      const snapshot = snapshotRef.current;
      // A canvas still hidden is mid-redraw; the snapshot already holds the last finished drawing.
      if (canvas?.width && snapshot && canvas.style.visibility !== "hidden") {
        // Scaled down when zoomed in: it only covers the page for a moment (see canvasBudget.ts).
        const size = snapshotSize(canvas.width, canvas.height);
        snapshot.width = size.width;
        snapshot.height = size.height;
        snapshot.getContext("2d")?.drawImage(canvas, 0, 0, size.width, size.height);
        setCovering(true);
      }
      setDrawnWidth(pageWidth);
    }, 150);
    return () => clearTimeout(timer);
  }, [containerWidth, pageWidth, drawnWidth, touchZooming]);
  const endCovering = useCallback(() => {
    setCovering(false);
    releaseCanvas(snapshotRef.current);
  }, []);
  // Zoomed in on a high-DPI display, the page is drawn at a lower resolution than the display's so
  // that its canvas stays within a memory limit.
  const pixelRatio = cappedPixelRatio(window.devicePixelRatio || 1, drawnWidth, drawnWidth * canvasRatio);

  // Whether the text layer shows this page yet, rather than the one before it.
  const textLayerReady = useRef(false);
  // Whether the canvas shows this page yet, so that a jump made now lands in the right place.
  const pageRendered = useRef(false);
  useEffect(() => { endCovering(); setMatches([]); textLayerReady.current = false; pageRendered.current = false; }, [url, pageNumber, endCovering]);
  // Each target is scrolled to once, so that zooming or resizing later doesn't pull the view back.
  const jumpedTo = useRef<JumpTarget | null>(null);
  const jumpToBookmark = useCallback(() => {
    if (!jumpTarget || jumpedTo.current === jumpTarget || (!jumpTarget.toEnd && jumpTarget.side !== (translated ? "translated" : "original"))) return;
    const page = pageRef.current;
    const scroller = containerRef.current;
    if (!page || !scroller) return;
    if (jumpTarget.toEnd) {
      // The browser clamps this to the end.
      scroller.scrollTop = scroller.scrollHeight;
      if (pageRendered.current) jumpedTo.current = jumpTarget;
      return;
    }
    const top = page.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top + jumpTarget.anchor_y * page.clientHeight - scroller.clientHeight * 0.25);
    if (jumpTarget.anchor_x !== undefined) {
      const left = page.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
      scroller.scrollLeft = Math.max(0, left + jumpTarget.anchor_x * page.clientWidth - scroller.clientWidth * 0.5);
    }
    if (pageRendered.current) jumpedTo.current = jumpTarget;
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
    const terms = [...(JSON.parse(noteQuotes) as string[]).map(text => ({ text, saved: true })),
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
  }, [drawnWidth, searchTerm, noteQuotes]);
  useEffect(() => { onTextLayerRendered(); }, [onTextLayerRendered, pageNumber]);
  const handleTextLayerRendered = useCallback(() => {
    textLayerReady.current = true;
    onTextLayerRendered();
    selectJumpPassage();
  }, [onTextLayerRendered, selectJumpPassage]);

  const message = (text: React.ReactNode) => (
    <div className="h-full flex items-center justify-center p-8 text-center text-[0.8125rem] text-muted-foreground leading-relaxed">
      <div className="max-w-sm">{text}</div>
    </div>
  );

  return (
    // React events bubble up from the portaled toolbar too, so using it activates this pane.
    <div ref={editor.scopeRef} className="flex flex-col h-full min-h-0" onPointerDownCapture={activate} onFocusCapture={activate}>
    {/* The same element either way, so that its state survives the toolbar moving between panes. */}
    {inkPage && inkHost && <InkToolbar editor={editor} side={side} errorsOnly={!servesToolbar} slot={servesToolbar ? inkToolbarSlot : undefined}
      disabled={inkViewport?.key !== inkKey} onStickyNote={selection => {
      const box = editor.selection;
      if (selection && box) {
        void openStickyNote({ paperId: inkPage.paperId, pageId: inkPage.pageId, page: inkPage.page, side: translated ? "translated" : "original",
          anchorY: box.y, anchorX: box.x, quote: editor.selected.map(s => s.text ?? "").filter(Boolean).join("\n") });
      } else {
        editor.setTool("select"); setCapture(null); setPlacingNote(value => !value);
      }
    }} />}
    {placingNote && <div role="status" className="flex items-center gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      PDF上の貼りたい場所をクリックしてください。
      <button className="ml-auto underline" onClick={() => setPlacingNote(false)}>キャンセル</button>
    </div>}
    <div ref={setFrame} className="flex-1 min-h-0 relative">
    {caption && <div className={`pointer-events-none absolute left-1 top-0.5 z-10 max-w-[calc(100%-2rem)] truncate rounded bg-background/80 px-1.5 text-[0.75rem] font-medium text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity duration-200 ${scrolled ? "opacity-0" : "opacity-100"}`}>
      {caption}
    </div>}
    {/* Clear of the scrollbar, which takes up to 16px. */}
    {badge && <div className="pointer-events-none absolute right-5 top-1 z-10 flex rounded-full bg-background/80 p-0.5 shadow-sm backdrop-blur-sm">
      {badge}
    </div>}
    {capture && inkPage && <InkCapture key={`${inkPage.paperId}:${inkPage.page}`} paperId={inkPage.paperId} page={inkPage.page} pageId={inkPage.pageId}
      side={translated ? "translated" : "original"} box={capture} onClose={() => setCapture(null)} />}
    <PdfContextMenu translated={translated}>
      <div
        ref={attachScroller}
        data-pdf-scroller
        onScroll={(e) => {
          setScrolled(e.currentTarget.scrollTop > 4);
          onScroll?.(e);
        }}
        onAuxClickCapture={handleLinkClick}
        {...touchHandlers}
        onClickCapture={(e) => {
          if ((e.nativeEvent as PointerEvent).pointerType === "touch" && suppressTouchClick()) {
            e.preventDefault(); e.stopPropagation(); return;
          }
          handleLinkClick(e);
        }}
        // A stable gutter keeps the width from changing as the scrollbar comes and goes; otherwise a
        // page that only just overflows at "fit width" shrinks to fit, loses its scrollbar and grows back.
        className={`w-full h-full bg-reader-bg [scrollbar-gutter:stable] [touch-action:none] [overflow-anchor:none] ${scrollsSideways(zoom, pageWidth, containerWidth - PADDING * 2) ? "overflow-auto" : "overflow-y-auto overflow-x-hidden"}`}
      >
        {placeholder ? message(placeholder) : !url ? message("PDFがありません。") : (
          <div className="w-fit min-w-full" style={{ padding: PADDING }}>
            {/* Suspense mode would throw load errors past `error=` to the root, blanking the app. */}
            <Document
              suspense={false}
              file={url}
              options={options}
              onLoadSuccess={(doc) => {
                docRef.current = doc;
                setNumPages(doc.numPages);
                onDocumentLoad?.(doc);
              }}
              onItemClick={handleItemClick}
              externalLinkTarget="_blank"
              loading={<PageSkeleton width={pageWidth} />}
              error={message("PDFを読み込めませんでした。")}
              className="mx-auto w-fit"
            >
              {numPages !== null && pageNumber > numPages ? message(missingPageMessage ?? "このページはありません。") : drawnWidth > 0 && (
                // Keep the whole page box while react-pdf replaces its drawing. Its temporary loading
                // content must not shrink the scroll extent or change the touch anchor's coordinates.
                <div ref={surfaceRef} data-pdf-surface className="relative" style={{
                  ...pageStyle,
                  zoom: pageWidth === drawnWidth ? undefined : pageWidth / drawnWidth,
                  // Stable geometry for touch anchoring while react-pdf replaces its canvas/text.
                  width: drawnWidth + 2,
                  height: shapeKnown ? drawnWidth * layoutRatio + 2 : undefined,
                }}>
                  <Page
                    pageNumber={pageNumber}
                    width={drawnWidth}
                    devicePixelRatio={pixelRatio}
                    inputRef={pageRef}
                    onLoadSuccess={(page) => {
                      loadedPage.current = page;
                      const viewport = page.getViewport({ scale: 1 });
                      setPageShape({ key: inkKey, ratio: viewport.height / viewport.width });
                    }}
                    onGetTextSuccess={(content) => { textContent.current = content; }}
                    onRenderSuccess={(page) => {
                      endCovering(); pageRendered.current = true; jumpToBookmark();
                      const viewport = page.getViewport({ scale: 1 });
                      setInkViewport({ key: inkKey, ratio: viewport.height / viewport.width });
                    }}
                    onRenderError={endCovering}
                    onRenderTextLayerSuccess={handleTextLayerRendered}
                    renderTextLayer
                    renderAnnotationLayer
                    loading={<PageSkeleton width={drawnWidth} />}
                    // `!` because react-pdf gives the page an inline white background, which would flash
                    // before each page is drawn. Not its canvasBackground prop: pdf.js would also paint
                    // that colour into the canvas, where the filter would change it a second time.
                    className="shadow-sm border bg-(--pdf-page-bg)! [&_canvas]:[filter:var(--pdf-page-filter)]"
                  />
                  {matches.map(({ saved, ...rect }, index) => <div key={index} className={`absolute pointer-events-none ${saved ? "bg-amber-400/30" : "bg-yellow-300/50"}`} style={rect} />)}
                  {highlights.map(item => item.rects?.map((rect, index) => <div key={`highlight-${item.id}-${index}`} data-highlight={item.id} aria-hidden="true"
                    className="absolute pointer-events-none rounded-[1px]"
                    style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%`,
                      backgroundColor: highlightFill(item.color), mixBlendMode: appearance.highlightBlend ?? "multiply",
                      boxShadow: selectedId === item.id ? `0 2px 0 rgb(${highlightColor(item.color).rgb})` : undefined }} />))}
                  {highlights.map(item => {
                    // A highlight with a memo shows a small mark after its last line; the memo opens from a click on it.
                    const last = item.note.trim() && item.rects?.[item.rects.length - 1];
                    return last && <MessageSquareText key={`highlight-note-${item.id}`} aria-hidden="true"
                      className="absolute size-3 -translate-y-1/2 pointer-events-none text-foreground/70 drop-shadow-sm"
                      style={{ left: `min(calc(100% - 0.75rem), ${(last[0] + last[2]) * 100}%)`, top: `${last[1] * 100}%` }} />;
                  })}
                  {notes.map(item => <StickyNoteMarker key={`sticky-${item.id}`} item={item}
                    movable={!editor.locked && !placingNote && ["select", "region", "lasso"].includes(editor.tool)} />)}
                  {placingNote && inkPage && <button autoFocus aria-label="PDFのこの位置に付箋を貼る" className="absolute inset-0 z-30 cursor-copy bg-amber-100/10 outline-2 outline-amber-400"
                    onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setPlacingNote(false); } }}
                    onClick={e => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      void openStickyNote({ paperId: inkPage.paperId, pageId: inkPage.pageId, page: inkPage.page, side: translated ? "translated" : "original", quote: "",
                        anchorY: e.detail === 0 ? 0.5 : Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
                        anchorX: e.detail === 0 ? 0.5 : Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) });
                      setPlacingNote(false);
                    }} />}
                  {/* Sits over the canvas, inside the page's 1px border. */}
                  <canvas
                    ref={snapshotRef}
                    hidden={!covering}
                    className="absolute left-px top-px w-[calc(100%-2px)] h-[calc(100%-2px)] pointer-events-none [filter:var(--pdf-page-filter)]"
                  />
                  {ink.entry && (ink.ready || editor.tool === "capture") && inkViewport?.key === inkKey && <InkOverlay key={`${inkPage?.paperId}:${inkPage?.page}:${inkKey}:${editor.tool}:${editor.locked}:${editor.visible}`}
                    editor={editor} aspectRatio={inkViewport.ratio} inkColor={appearance.inkColor} onCapture={setCapture} />}
                </div>
              )}
            </Document>
          </div>
        )}
      </div>
    </PdfContextMenu>
    {url && !placeholder && <SelectionToolbar container={scroller} frame={frame} translated={translated} highlights={highlights}
      inkTool={editor.tool !== "select"} placingNote={placingNote} />}
    </div>
    </div>
  );
}

function PageSkeleton({ width }: { width: number }) {
  // Letter-ish proportions keep the layout from jumping while the page renders.
  return <div className="bg-card border animate-pulse mx-auto" style={{ width, height: Math.round(width * 1.3) }} />;
}
