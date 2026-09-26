import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilePlus2, Languages, Loader2 } from "lucide-react";
import { isRunning, useStore, ZOOM_PRESETS } from "@/store";
import { useReading, type ReadingData } from "@/api/hooks";
import { backendUrl } from "@/api/client";
import { PdfPane } from "./PdfPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { importPdfs } from "@/app/actions";
import { changeZoom } from "./navigation";
import { createScrollSync } from "./scrollSync";
import { apiRequest } from "@/api/client";
import { ReaderExtras } from "./ReaderExtras";
import type { StickyNote } from "./stickyNotes";
import type { JumpTarget } from "./PdfPane";

// Stable while the notes are loading or failed: a new array would redraw the text layer on every render.
const NO_NOTES: StickyNote[] = [];

/** Caption for the translation pane, following the old reader's rules. */
function translatedCaption(reading: ReadingData | null | undefined, page: number): string {
  const preview = reading?.preview;
  const completed = reading?.completed_pages ?? [];
  if (preview?.skipped_pages?.includes(page)) return "原文（PDF生成をスキップ）";
  if (completed.includes(page)) return "日本語訳";
  if (preview && (preview.complete || !(preview.target_pages ?? []).includes(page))) {
    // Without target_pages every page was requested.
    if (preview.complete || preview.target_pages) return "原文（未翻訳）";
  }
  if (!preview && !reading?.has_translated) return "日本語訳";
  return "日本語訳（翻訳待ち）";
}

export function Reader() {
  const activePaperId = useStore((s) => s.activePaperId);
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.zoom);
  const readerSplit = useStore((s) => s.readerSplit);
  const setReaderSplit = useStore((s) => s.setReaderSplit);
  const translatedOnly = useStore((s) => s.translatedOnly);
  const activeJobs = useStore((s) => s.activeJobs);
  const [search, setSearch] = useState<{ query: string; side: "original" | "translated" }>({ query: "", side: "original" });
  const [bookmarkTarget, setBookmarkTarget] = useState<JumpTarget | null>(null);
  const { data: bookmarks = NO_NOTES } = useQuery({
    queryKey: ["sticky-notes", activePaperId],
    queryFn: () => apiRequest<StickyNote[]>("GET", `/api/papers/${activePaperId}/sticky-notes`),
    enabled: !!activePaperId,
  });
  const sourceHighlights = useMemo(() => bookmarks.filter(item => item.page === currentPage && item.side === "original"), [bookmarks, currentPage]);
  const translatedHighlights = useMemo(() => bookmarks.filter(item => item.page === currentPage && item.side === "translated"), [bookmarks, currentPage]);
  const { data: reading } = useReading(activePaperId);
  const translating = activeJobs.some((j) => j.paper_id === activePaperId && isRunning(j) && j.kind === "translate");

  const readerRef = useRef<HTMLDivElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const syncScroll = useMemo(() => createScrollSync(), [activePaperId, currentPage]);

  const pageCount = reading?.page_count ?? 0;
  const completed = reading?.completed_pages ?? [];
  useEffect(() => { setBookmarkTarget(null); setSearch({ query: "", side: "original" }); }, [activePaperId]);
  // A passage opened from the chat. Taken from the store so that it is shown once, not on every remount.
  const readerJump = useStore((s) => s.readerJump);
  useEffect(() => {
    const jump = useStore.getState().readerJump;
    if (!jump) return;
    useStore.getState().setReaderJump(null);
    if (jump.paperId !== activePaperId) return;
    setBookmarkTarget({ id: Date.now(), page: jump.page, side: jump.side, anchor_y: jump.anchor_y, anchor_x: jump.anchor_x, passage: jump });
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

  useEffect(() => {
    const element = readerRef.current;
    if (!element) return;
    // Scale the pinch is heading for; the zoom snaps to the nearest preset on the way.
    let pinchTarget = 1;
    let lastPinch = 0;
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
        if (e.timeStamp - lastPinch > 300) pinchTarget = zoom;
        lastPinch = e.timeStamp;
        pinchTarget = Math.max(ZOOM_PRESETS[0], Math.min(pinchTarget * Math.exp(-dy / 100), ZOOM_PRESETS[ZOOM_PRESETS.length - 1]));
        const nearest = ZOOM_PRESETS.reduce((best, value) =>
          Math.abs(Math.log(value / pinchTarget)) < Math.abs(Math.log(best / pinchTarget)) ? value : best);
        if (nearest !== zoom) setZoom(nearest);
        return;
      }

      // Touchpad swipes can latch onto the window rather than the PDF under the pointer,
      // so scroll that pane directly. Non-cancelable events belong to a native scroll already under way.
      const pane = [leftScrollRef.current, rightScrollRef.current].find((p) => p?.contains(e.target as Node));
      if (!pane || mouseWheel || !e.cancelable) return;
      e.preventDefault();
      pane.scrollBy(e.shiftKey && dx === 0 ? dy : dx, e.shiftKey && dx === 0 ? 0 : dy);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [activePaperId]);

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
        <FilePlus2 className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-[15px] font-medium mb-1 text-foreground">論文を追加して、読み始めよう</p>
        <p className="text-[13px] mb-6">左のライブラリから論文を選ぶか、PDF を追加してください（ドロップでも追加できます）</p>
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
  const caption = translatedCaption(reading, currentPage);
  const waiting = !!reading?.preview && !reading.preview.complete;

  let rightPlaceholder: React.ReactNode = null;
  if (reading && !ref) {
    rightPlaceholder = waiting ? (
      <span className="inline-flex flex-col items-center gap-3">
        {translating && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
        このページは翻訳待ちです。完了したページから表示します。
      </span>
    ) : (
      <span className="inline-flex flex-col items-center gap-3">
        まだ翻訳していません。「翻訳する」で訳文を作成します。
        <button
          onClick={() => window.dispatchEvent(new Event("open-translate-dialog"))}
          className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-[13px] font-medium hover:opacity-90"
        >
          <Languages className="w-4 h-4" /> 翻訳する
        </button>
      </span>
    );
  }
  const noTranslatedPages = translatedOnly && reading && !completed.length;

  return (
    <div ref={readerRef} className="flex flex-col h-full w-full bg-reader-bg">
      <ReaderToolbar />
      <ReaderExtras paperId={activePaperId} search={search} setSearch={setSearch}
        onSearchJump={(item, index) => setBookmarkTarget({ id: -index - 1, page: item.page, side: search.side, anchor_y: item.anchor_y })} />
      {noTranslatedPages ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-8 text-[13px]">
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
            <div className="h-[28px] border-b flex items-center px-4 bg-background shrink-0 text-muted-foreground font-medium text-xs">
              原文
            </div>
            <div className="flex-1 relative min-h-0">
              <PdfPane
                url={leftUrl}
                inkPage={reading ? { paperId: activePaperId, page: currentPage } : undefined}
                pageNumber={currentPage}
                zoom={zoom}
                onScroll={(e) => syncScroll(e.currentTarget, rightScrollRef.current)}
                scrollRef={leftScrollRef}
                missingPageMessage="対応する原文ページがありません。"
                searchTerm={search.side === "original" ? search.query : ""}
                jumpTarget={bookmarkTarget?.page === currentPage ? bookmarkTarget : null}
                savedHighlights={sourceHighlights}
              />
            </div>
          </ResizablePanel>

          <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize z-10" />

          <ResizablePanel id="translated" defaultSize={`${(1 - readerSplit) * 100}%`} minSize="15%" className="flex flex-col">
            <div className="h-[28px] border-b flex items-center px-4 bg-background shrink-0 justify-between">
              <span className="text-muted-foreground font-medium text-xs">{caption}</span>
              {translating && (
                <span className="flex items-center gap-1 text-[11px] text-primary">
                  <Loader2 className="w-3 h-3 animate-spin" /> 翻訳中
                </span>
              )}
            </div>
            <div className="flex-1 relative min-h-0">
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
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
