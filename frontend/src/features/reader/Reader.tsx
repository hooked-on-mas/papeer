import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, Languages, Loader2 } from "lucide-react";
import { useStore } from "@/store";
import { StartupReader } from "@/app/StartupReader";
import { runningPaperJob } from "@/features/jobs/jobSelectors";
import { useItemCapabilities, useReading, type ReadingData } from "@/api/hooks";
import { backendUrl } from "@/api/client";
import { PdfPane } from "./PdfPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { ReaderSplit } from "./ReaderSplit";
import { importPdfs } from "@/app/actions";
import { ContinueReading } from "@/features/library/ContinueReading";
import { navigateTo } from "./navigation";
import { loadOutline, originalPageFor, type OutlineEntry, type PdfPlace } from "./pdfLinks";
import { inkToolActive } from "./useInkEditor";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { createScrollSync } from "./scrollSync";
import { emitAppEvent } from "@/lib/appEvents";
import { useRebuilding } from "./rebuildJobs";
import { useViewerInput } from "./useViewerInput";
import { usePageAnchor } from "./usePageAnchor";
import { usePageNotes } from "./usePageNotes";
import { usePdfTouchOwner } from "./usePdfTouch";

const NO_PAGES: number[] = [];

/** Only completed translations are displayed in this pane. */
function translatedCaption(reading: ReadingData | null | undefined, page: number, rebuilding = false): string {
  const preview = reading?.preview;
  const completed = reading?.completed_pages ?? [];
  if (completed.includes(page)) return "日本語訳";
  if ((preview ?? reading?.report)?.skipped_pages?.includes(page)) return "日本語訳（PDF生成に失敗）";
  if (preview && !preview.complete && (preview.target_pages?.includes(page) ?? true)) {
    return rebuilding ? "日本語訳（PDF作り直し中）" : "日本語訳（翻訳待ち）";
  }
  return "日本語訳（未翻訳）";
}

export function Reader() {
  const activePaperId = useStore((s) => s.activePaperId);
  const uiStateLoaded = useStore((s) => s.uiStateLoaded);
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.zoom);
  const readerSplit = useStore((s) => s.readerSplit);
  const setReaderSplit = useStore((s) => s.setReaderSplit);
  // What the open item can do (see lib/itemKinds.ts): an item that is not translated has no right pane
  // and no 翻訳済みページのみ filter, whatever the filter is set to for the papers.
  const caps = useItemCapabilities(activePaperId);
  const translatedOnly = useStore((s) => s.translatedOnly) && caps.translate;
  const [search, setSearch] = useState<{ query: string; side: "original" | "translated" }>({ query: "", side: "original" });
  const { original: sourceHighlights, translated: translatedHighlights } = usePageNotes(activePaperId, currentPage);
  const { data: reading } = useReading(activePaperId);
  const translateJobId = useStore((s) => runningPaperJob(s.activeJobs, s.activePaperId, ["translate"])?.job_id);
  const translating = !!translateJobId;
  // 「保存済みの訳文でPDFを作り直す」: no AI is called, so neither 翻訳中 nor 翻訳待ち is said.
  const rebuilding = useRebuilding(translateJobId);

  const readerRef = useRef<HTMLDivElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  // A fresh one for each page of each paper.
  const syncScroll = useMemo(() => {
    return createScrollSync(() => usePdfTouchOwner.getState().pane);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the page and paper are what start it over
  }, [activePaperId, currentPage]);
  const { jumpTarget: bookmarkTarget, recordAnchor } = usePageAnchor({ paperId: activePaperId, panes: [leftScrollRef, rightScrollRef] });
  const { ownsKey } = useViewerInput({ rootRef: readerRef, panes: [leftScrollRef, rightScrollRef], wheelTurns: () => !inkToolActive(), resetKey: activePaperId });
  // Where the pane being written on places the writing toolbar, across both panes.
  const [inkToolbarSlot, setInkToolbarSlot] = useState<HTMLDivElement | null>(null);

  // The original's table of contents, for the 目次 menu.
  const [loadedOutline, setLoadedOutline] = useState<{ paperId: string | null; entries: OutlineEntry[] } | null>(null);
  // Switching papers must not expose the previous paper's menu before the resetting effect runs.
  const outline = loadedOutline?.paperId === activePaperId ? loadedOutline.entries : null;
  const outlineDoc = useRef<PDFDocumentProxy | null>(null);
  const onOriginalLoad = useCallback((doc: PDFDocumentProxy) => {
    // The sidecar resolves the outline before the PDF is downloaded. Older sidecars (or an
    // unreadable original there) still use pdf.js as a fallback.
    if (reading?.outline != null) return;
    if (outlineDoc.current === doc) return;
    outlineDoc.current = doc;
    void loadOutline(doc).then((entries) => { if (outlineDoc.current === doc) setLoadedOutline({ paperId: activePaperId, entries }); });
  }, [activePaperId, reading?.outline]);
  useEffect(() => { outlineDoc.current = null; setLoadedOutline(null); }, [activePaperId]);

  const pageCount = reading?.page_count ?? 0;
  const completed = reading?.completed_pages ?? NO_PAGES;
  useEffect(() => { setSearch({ query: "", side: "original" }); }, [activePaperId]);

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

  if (!activePaperId && !uiStateLoaded) return <StartupReader />;

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 overflow-y-auto">
        <FilePlus2 className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-[0.9375rem] font-medium mb-1 text-foreground">論文を選んで、読み始めよう</p>
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
  const result = reading?.preview ?? reading?.report;
  const failed = !!result?.skipped_pages?.includes(currentPage);
  const pageError = result?.page_errors?.[String(currentPage)];
  const waiting = !!reading?.preview && !reading.preview.complete && !failed
    && (reading.preview.target_pages?.includes(currentPage) ?? true);

  let rightPlaceholder: React.ReactNode = null;
  if (caps.split && reading && !ref) {
    rightPlaceholder = waiting ? (
      <span className="inline-flex flex-col items-center gap-3">
        {translating && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
        {rebuilding ? "保存済みの訳文からPDFを作り直しています。できたページから表示します。" : "このページは翻訳待ちです。完了したページから表示します。"}
      </span>
    ) : (
      <span className="inline-flex flex-col items-center gap-3">
        {failed ? "このページの日本語PDFを作成できませんでした。" : "このページは未翻訳です。「翻訳する」で訳文を作成します。"}
        {failed && pageError && <span className="max-w-md px-4 text-center text-[0.75rem]">{pageError}</span>}
        <button
          onClick={() => emitAppEvent("open-translate-dialog")}
          className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-[0.8125rem] font-medium hover:opacity-90"
        >
          <Languages className="w-4 h-4" /> {failed ? "再試行する" : "翻訳する"}
        </button>
      </span>
    );
  }
  const noTranslatedPages = translatedOnly && reading && !completed.length;

  return (
    <div ref={readerRef} className="flex flex-col h-full w-full bg-reader-bg">
      <ReaderToolbar paperId={activePaperId} search={search} setSearch={setSearch} outline={reading?.outline ?? outline} ownsKey={ownsKey} />
      <span role="status" className="sr-only">{rebuilding ? "PDFを作り直しています" : translating ? "翻訳中" : ""}</span>
      {/* data-ink-toolbar-slot: INK_TOOLBAR_SLOT, which lets the toolbar's keys through to its pane. */}
      <div id="reader-ink-tools" ref={setInkToolbarSlot} data-ink-toolbar-slot="" className="flex flex-col shrink-0 max-h-[40%]" />
      {noTranslatedPages ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-8 text-[0.8125rem]">
          翻訳済みのページはまだありません。完了すると自動で表示します。
        </div>
      ) : (
        <ReaderSplit fraction={readerSplit} onResize={setReaderSplit}
          original={<div className="flex-1 relative min-h-0" role="region" aria-label="原文">
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
            </div>}
          translated={caps.split ? (<div className="flex-1 relative min-h-0" role="region" aria-label={caption}>
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
            </div>) : undefined}
        />
      )}
    </div>
  );
}
