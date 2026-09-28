import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilePlus2, Languages, Loader2 } from "lucide-react";
import { useStore } from "@/store";
import { runningPaperJob } from "@/features/jobs/jobSelectors";
import { useReading, type ReadingData } from "@/api/hooks";
import { backendUrl } from "@/api/client";
import { PdfPane } from "./PdfPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { importPdfs } from "@/app/actions";
import { ContinueReading } from "@/features/library/ContinueReading";
import { bindReaderViewport, changeZoom, historyBack, historyForward, movePage, moveToEdgePage, navigateTo } from "./navigation";
import { createWheelPager, keyTarget, onScreen, paneEdges, readerKeyAction, readerOwnsKey, type KeyPlace } from "./pageTurn";
import { savedAnchor } from "./sidePanel";
import { loadOutline, originalPageFor, type OutlineEntry, type PdfPlace } from "./pdfLinks";
import { pinchLevel, pinchStart } from "./zoomLevels";
import { inkToolActive } from "./useInkEditor";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { createScrollSync } from "./scrollSync";
import { api, unwrap } from "@/api/client";
import type { StickyNote } from "./stickyNotes";
import type { JumpTarget } from "./PdfPane";
import { emitAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";
import { useRebuilding } from "./rebuildJobs";

// Stable while the notes are loading or failed: a new array would redraw the text layer on every render.
const NO_NOTES: StickyNote[] = [];
const NO_PAGES: number[] = [];

/**
 * Where the view is on the page in `pane`, as JumpTarget.anchor_y takes it: jumping there again
 * brings back the same view.
 */
function viewAnchor(pane: HTMLElement | null): number | null {
  const page = pane?.querySelector<HTMLElement>(".react-pdf__Page");
  if (!pane || !page || !page.clientHeight) return null;
  const top = page.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  return Math.max(0, Math.min(1, (pane.scrollTop + pane.clientHeight * 0.25 - top) / page.clientHeight));
}

/** Caption for the translation pane, following the old reader's rules. */
function translatedCaption(reading: ReadingData | null | undefined, page: number, rebuilding = false): string {
  const preview = reading?.preview;
  const completed = reading?.completed_pages ?? [];
  if (preview?.skipped_pages?.includes(page)) return "原文（PDF生成をスキップ）";
  if (completed.includes(page)) return "日本語訳";
  if (preview && (preview.complete || !(preview.target_pages ?? []).includes(page))) {
    // Without target_pages every page was requested.
    if (preview.complete || preview.target_pages) return "原文（未翻訳）";
  }
  if (!preview && !reading?.has_translated) return "日本語訳";
  return rebuilding ? "日本語訳（PDF作り直し中）" : "日本語訳（翻訳待ち）";
}

export function Reader() {
  const activePaperId = useStore((s) => s.activePaperId);
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.zoom);
  const readerSplit = useStore((s) => s.readerSplit);
  const setReaderSplit = useStore((s) => s.setReaderSplit);
  const translatedOnly = useStore((s) => s.translatedOnly);
  const [search, setSearch] = useState<{ query: string; side: "original" | "translated" }>({ query: "", side: "original" });
  const [bookmarkTarget, setBookmarkTarget] = useState<JumpTarget | null>(null);
  const { data: bookmarks = NO_NOTES } = useQuery({
    queryKey: [QK.stickyNotes, activePaperId],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/sticky-notes", {
      params: { path: { paper_id: activePaperId as string } } })) as StickyNote[],
    enabled: !!activePaperId,
  });
  const sourceHighlights = useMemo(() => bookmarks.filter(item => item.page === currentPage && item.side === "original"), [bookmarks, currentPage]);
  const translatedHighlights = useMemo(() => bookmarks.filter(item => item.page === currentPage && item.side === "translated"), [bookmarks, currentPage]);
  const { data: reading } = useReading(activePaperId);
  const translateJobId = useStore((s) => runningPaperJob(s.activeJobs, s.activePaperId, ["translate"])?.job_id);
  const translating = !!translateJobId;
  // 「保存済みの訳文でPDFを作り直す」: no AI is called, so neither 翻訳中 nor 翻訳待ち is said.
  const rebuilding = useRebuilding(translateJobId);

  const readerRef = useRef<HTMLDivElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  // A fresh one for each page of each paper.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the page and paper are what start it over
  const syncScroll = useMemo(() => createScrollSync(), [activePaperId, currentPage]);
  // The pane the pointer was last over, which the paging keys scroll.
  const activePane = useRef<"left" | "right">("left");
  // The pane to scroll and to judge the page's end by: `preferred`, unless it shows no page (a
  // translation still pending, say) and the other one does.
  const readingPane = (preferred: "left" | "right") => {
    const [first, second] = preferred === "right" ? [rightScrollRef.current, leftScrollRef.current] : [leftScrollRef.current, rightScrollRef.current];
    const hasPage = (pane: HTMLElement | null) => !!pane?.querySelector(".react-pdf__Page");
    return !hasPage(first) && hasPage(second) ? second : first ?? second;
  };
  useEffect(() => bindReaderViewport(() => viewAnchor(leftScrollRef.current)), []);
  // Where the pane being written on places the writing toolbar, across both panes.
  const [inkToolbarSlot, setInkToolbarSlot] = useState<HTMLDivElement | null>(null);

  // The original's table of contents, for the 目次 menu.
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const outlineDoc = useRef<PDFDocumentProxy | null>(null);
  const onOriginalLoad = useCallback((doc: PDFDocumentProxy) => {
    if (outlineDoc.current === doc) return;
    outlineDoc.current = doc;
    void loadOutline(doc).then((entries) => { if (outlineDoc.current === doc) setOutline(entries); });
  }, []);
  useEffect(() => { outlineDoc.current = null; setOutline(null); }, [activePaperId]);

  const pageCount = reading?.page_count ?? 0;
  const completed = reading?.completed_pages ?? NO_PAGES;
  // A paper opens where its page was last left (paperAnchors, saved in ui-state.json), from the top otherwise.
  // Until the view has moved there, the scrolls to the top of the page on the way are not kept (recordAnchor).
  const restoringAnchor = useRef(false);
  useEffect(() => {
    setSearch({ query: "", side: "original" });
    const { paperAnchors, currentPage: page } = useStore.getState();
    const anchor = activePaperId ? paperAnchors[activePaperId] : undefined;
    restoringAnchor.current = anchor !== undefined;
    setBookmarkTarget(anchor === undefined ? null : { id: Date.now(), page, side: "original", anchor_y: anchor });
  }, [activePaperId]);
  // A passage opened from the chat. Taken from the store so that it is shown once, not on every remount.
  const readerJump = useStore((s) => s.readerJump);
  useEffect(() => {
    const jump = useStore.getState().readerJump;
    if (!jump) return;
    useStore.getState().setReaderJump(null);
    if (jump.paperId !== activePaperId) return;
    setBookmarkTarget({ id: Date.now(), page: jump.page, side: jump.side, anchor_y: jump.anchor_y, anchor_x: jump.anchor_x, passage: jump, toEnd: jump.toEnd });
  }, [readerJump, activePaperId]);

  // Keep the page valid for the paper and the 翻訳済みページのみ filter.
  useEffect(() => {
    if (!reading) return;
    const { setCurrentPage } = useStore.getState();
    if (translatedOnly) {
      if (completed.length && !completed.includes(currentPage)) setCurrentPage(completed[0]);
    } else if (pageCount && currentPage > pageCount) {
      setCurrentPage(pageCount);
    } else if (currentPage < 1) {
      setCurrentPage(1);
    }
  }, [reading, translatedOnly, currentPage, pageCount, completed]);

  // New pages start at the top, as in the old reader.
  useEffect(() => {
    for (const pane of [leftScrollRef.current, rightScrollRef.current]) if (pane) pane.scrollTop = 0;
  }, [currentPage, activePaperId]);

  // Keeps where the view is within the page for the paper, a moment after scrolling stops. Measured as
  // it scrolls, so that switching to another paper before then keeps the place in this one.
  const pendingAnchor = useRef<{ paperId: string; anchor: number | null } | null>(null);
  const anchorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commitAnchor = useCallback(() => {
    clearTimeout(anchorTimer.current);
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (pending) useStore.getState().setPaperAnchor(pending.paperId, pending.anchor);
  }, []);
  const recordAnchor = useCallback((pane: HTMLElement) => {
    const paperId = useStore.getState().activePaperId;
    if (!paperId || !onScreen(pane)) return;
    // The saved place is only ever below the top, so the first scroll away from it is the move there
    // (or the reader's own scrolling, once it has given up on it).
    if (restoringAnchor.current) {
      if (pane.scrollTop <= 0) return;
      restoringAnchor.current = false;
    }
    pendingAnchor.current = { paperId, anchor: savedAnchor(pane.scrollTop, viewAnchor(pane)) };
    clearTimeout(anchorTimer.current);
    anchorTimer.current = setTimeout(commitAnchor, 500);
  }, [commitAnchor]);
  useEffect(() => commitAnchor, [activePaperId, commitAnchor]);

  useEffect(() => {
    const element = readerRef.current;
    if (!element) return;
    // Scale the pinch is heading for; the zoom snaps to the nearest preset on the way.
    let pinchTarget = 1;
    let lastPinch = 0;
    const pager = createWheelPager();
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      // A mouse notch is a single large vertical step; touchpads send small, often diagonal ones.
      const mouseWheel = dx === 0 && Math.abs(dy) >= 50;

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+wheel, and touchpad pinch, which arrives as Ctrl+wheel, zoom both panes together.
        e.preventDefault();
        if (mouseWheel) {
          changeZoom(dy < 0 ? 1 : -1);
          return;
        }
        // Pinch deltas follow scale = exp(-deltaY / 100) and are only a few pixels each.
        const { zoom, setZoom } = useStore.getState();
        if (e.timeStamp - lastPinch > 300) pinchTarget = pinchStart(zoom);
        lastPinch = e.timeStamp;
        const pinch = pinchLevel(pinchTarget * Math.exp(-dy / 100));
        pinchTarget = pinch.scale;
        if (pinch.level !== zoom) setZoom(pinch.level);
        return;
      }

      const pane = [leftScrollRef.current, rightScrollRef.current].find((p) => p?.contains(e.target as Node));
      if (!pane) return;
      activePane.current = pane === rightScrollRef.current ? "right" : "left";
      // Scrolling on past the end of the page turns it, except while writing on the page, where a
      // stray wheel movement should not take the page away.
      if (!e.shiftKey && Math.abs(dy) > Math.abs(dx) && !inkToolActive()) {
        const { turn, swallow } = pager({ dy, time: e.timeStamp, notch: mouseWheel, ...paneEdges(readingPane(activePane.current) ?? pane) });
        if (turn) {
          if (e.cancelable) e.preventDefault();
          movePage(turn, { toEnd: turn < 0 });
          return;
        }
        if (swallow) {
          if (e.cancelable) e.preventDefault();
          return;
        }
      }

      // Touchpad swipes can latch onto the window rather than the PDF under the pointer,
      // so scroll that pane directly. Non-cancelable events belong to a native scroll already under way.
      if (mouseWheel || !e.cancelable) return;
      e.preventDefault();
      pane.scrollBy(e.shiftKey && dx === 0 ? dy : dx, e.shiftKey && dx === 0 ? 0 : dy);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [activePaperId]);

  // Whether the last click was in the reader, and in which pane, for the keys below.
  const pointerInReader = useRef(false);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      pointerInReader.current = !!target && !!readerRef.current?.contains(target);
      if (target && rightScrollRef.current?.contains(target)) activePane.current = "right";
      else if (target && leftScrollRef.current?.contains(target)) activePane.current = "left";
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  // Whether a key press is the reader's (see readerOwnsKey); the search's F3 follows it too.
  const ownsKey = useCallback((e: KeyboardEvent) => {
    const root = readerRef.current;
    if (!root || document.querySelector("[data-lightbox]")) return false;
    const target = e.target instanceof Element ? e.target : null;
    const place: KeyPlace = target && root.contains(target) ? "inside" : !target || target.contains(root) ? "around" : "elsewhere";
    const readerVisible = useStore.getState().activeTab === "reader" && onScreen(root);
    return readerOwnsKey({ place, pointerInReader: pointerInReader.current, readerVisible });
  }, []);

  // The paging keys (see readerKeyAction), never taken from a text field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !ownsKey(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      const pane = readingPane(activePane.current);
      const action = readerKeyAction({
        key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
        target: keyTarget(target), ...(pane ? paneEdges(pane) : { atStart: true, atEnd: true }),
      });
      if (!action) return;
      e.preventDefault();
      if (action.type === "scroll") pane?.scrollBy({ top: action.direction * pane.clientHeight * 0.9 });
      else if (action.type === "turn") movePage(action.amount, { toEnd: action.toEnd });
      else if (action.type === "edge") moveToEdgePage(action.edge);
      else if (action.direction === "back") historyBack();
      else historyForward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ownsKey]);

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 overflow-y-auto">
        <FilePlus2 className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-[0.9375rem] font-medium mb-1 text-foreground">論文を追加して、読み始めよう</p>
        <p className="text-[0.8125rem] mb-6">左のライブラリから論文を選ぶか、PDF を追加してください（ドロップでも追加できます）</p>
        <ContinueReading />
        <button onClick={importPdfs} className="bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium hover:opacity-90 transition-opacity">
          PDF を追加
        </button>
      </div>
    );
  }

  const fileUrl = (file: string, version: number) =>
    backendUrl(`/api/papers/${activePaperId}/files/${file}?v=${version}`);
  const leftUrl = fileUrl("original.pdf", reading?.original_mtime ?? 0);
  const ref = reading?.translated_pages?.[String(currentPage)];
  const rightUrl = ref ? fileUrl(ref.file, ref.mtime) : null;
  const caption = translatedCaption(reading, currentPage, rebuilding);
  const waiting = !!reading?.preview && !reading.preview.complete;

  let rightPlaceholder: React.ReactNode = null;
  if (reading && !ref) {
    rightPlaceholder = waiting ? (
      <span className="inline-flex flex-col items-center gap-3">
        {translating && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
        {rebuilding ? "保存済みの訳文からPDFを作り直しています。できたページから表示します。" : "このページは翻訳待ちです。完了したページから表示します。"}
      </span>
    ) : (
      <span className="inline-flex flex-col items-center gap-3">
        まだ翻訳していません。「翻訳する」で訳文を作成します。
        <button
          onClick={() => emitAppEvent("open-translate-dialog")}
          className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-[0.8125rem] font-medium hover:opacity-90"
        >
          <Languages className="w-4 h-4" /> 翻訳する
        </button>
      </span>
    );
  }
  const noTranslatedPages = translatedOnly && reading && !completed.length;

  return (
    <div ref={readerRef} className="flex flex-col h-full w-full bg-reader-bg">
      <ReaderToolbar paperId={activePaperId} search={search} setSearch={setSearch} outline={outline} ownsKey={ownsKey} />
      <span role="status" className="sr-only">{rebuilding ? "PDFを作り直しています" : translating ? "翻訳中" : ""}</span>
      {/* data-ink-toolbar-slot: INK_TOOLBAR_SLOT, which lets the toolbar's keys through to its pane. */}
      <div ref={setInkToolbarSlot} data-ink-toolbar-slot="" className="flex flex-col shrink-0 max-h-[40%]" />
      {noTranslatedPages ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-8 text-[0.8125rem]">
          翻訳済みのページはまだありません。完了すると自動で表示します。
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 min-h-0"
          onLayoutChanged={(layout) => {
            const left = layout.original;
            const total = (layout.original ?? 0) + (layout.translated ?? 0);
            if (left !== undefined && total > 0) setReaderSplit(left / total);
          }}
        >
          <ResizablePanel id="original" defaultSize={`${readerSplit * 100}%`} minSize="15%" className="flex flex-col">
            <div className="flex-1 relative min-h-0" role="region" aria-label="原文">
              <PdfPane
                url={leftUrl}
                inkPage={reading ? { paperId: activePaperId, page: currentPage } : undefined}
                pageNumber={currentPage}
                zoom={zoom}
                onScroll={(e) => { syncScroll(e.currentTarget, rightScrollRef.current); recordAnchor(e.currentTarget); }}
                scrollRef={leftScrollRef}
                missingPageMessage="対応する原文ページがありません。"
                searchTerm={search.side === "original" ? search.query : ""}
                jumpTarget={bookmarkTarget?.page === currentPage ? bookmarkTarget : null}
                savedHighlights={sourceHighlights}
                onDocumentLoad={onOriginalLoad}
                onInternalLink={(place) => navigateTo({ ...place, side: "original" })}
                caption="原文"
                inkToolbarSlot={inkToolbarSlot}
              />
            </div>
          </ResizablePanel>

          <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize z-10" />

          <ResizablePanel id="translated" defaultSize={`${(1 - readerSplit) * 100}%`} minSize="15%" className="flex flex-col">
            <div className="flex-1 relative min-h-0" role="region" aria-label={caption}>
              <PdfPane
                url={rightUrl}
                inkPage={{ paperId: activePaperId, page: currentPage }}
                pageNumber={(ref?.index ?? 0) + 1}
                zoom={zoom}
                onScroll={(e) => syncScroll(e.currentTarget, leftScrollRef.current)}
                scrollRef={rightScrollRef}
                placeholder={rightPlaceholder}
                translated
                missingPageMessage="対応する原文ページがありません。再翻訳すると原文と同じページ数になります。"
                searchTerm={search.side === "translated" ? search.query : ""}
                jumpTarget={bookmarkTarget?.page === currentPage ? bookmarkTarget : null}
                savedHighlights={translatedHighlights}
                onInternalLink={(place: PdfPlace) => {
                  // The translation pane's file has its own page numbers; open the original page it shows.
                  const page = ref && reading ? originalPageFor(reading.translated_pages, ref.file, place.page - 1) : null;
                  if (page) navigateTo({ page, anchor_y: place.anchor_y, side: "translated" });
                }}
                caption={caption}
                badge={translating && (
                  // Announced by the status line under the toolbar, which is there before the translation starts.
                  <span aria-hidden="true" className="flex items-center gap-1 pr-1 text-[0.75rem] leading-none text-primary">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />{rebuilding ? "PDF作り直し中" : "翻訳中"}
                  </span>
                )}
                inkToolbarSlot={inkToolbarSlot}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
