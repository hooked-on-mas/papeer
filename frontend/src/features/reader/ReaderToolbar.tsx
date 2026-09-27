import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, ClipboardCheck, ListTree, Maximize2, MessageSquare, Minimize2, MoreHorizontal, NotebookPen, PenLine,
  ScrollText, Search, StickyNote, Undo2, ZoomIn, ZoomOut,
} from "lucide-react";
import { useStore, ZOOM_LEVELS } from "@/store";
import { useArticle, useMessages, useReading } from "@/api/hooks";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { emitAppEvent } from "@/lib/appEvents";
import { changeZoom, historyBack, jumpToPage, movePage, navigateTo } from "./navigation";
import { zoomLabel } from "./zoomLevels";
import { currentOutlineIndex, type OutlineEntry } from "./pdfLinks";
import { fitReaderToolbar, inkToolbarOpen } from "./readerBars";
import { ReaderSearch } from "./ReaderSearch";
import { TranslationReview } from "./TranslationReview";
import { translationIssues } from "./translationIssues";
import { useInkTools } from "./useInkEditor";

/** Tabs that focus mode can open beside the reader. */
const FOCUS_PANELS = [
  { tab: "summary", label: "サマリー", icon: ScrollText, key: "Ctrl+2" },
  { tab: "chat", label: "チャット", icon: MessageSquare, key: "Ctrl+3" },
  { tab: "notes", label: "メモ", icon: NotebookPen, key: "Ctrl+4" },
];

type Search = { query: string; side: "original" | "translated" };

/**
 * The reader's one row of controls: pages, table of contents, search, writing tools, zoom and focus
 * mode. Whatever doesn't fit its width goes into the 「…」 menu at its end (see readerBars.ts).
 */
export function ReaderToolbar({ paperId, search, setSearch, outline, ownsKey }: {
  paperId: string;
  search: Search;
  setSearch: (value: Search) => void;
  /** The original's table of contents; null or empty hides the 目次 menu. */
  outline: OutlineEntry[] | null;
  /** Whether a key press is the reader's, as the paging keys decide it. */
  ownsKey: (e: KeyboardEvent) => boolean;
}) {
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const translatedOnly = useStore((s) => s.translatedOnly);
  const setTranslatedOnly = useStore((s) => s.setTranslatedOnly);
  const focusMode = useStore((s) => s.focusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const focusPanel = useStore((s) => s.focusPanel);
  const setFocusPanel = useStore((s) => s.setFocusPanel);
  const canGoBack = useStore((s) => s.readerHistory.back.length > 0);
  const inkBarOpen = useStore((s) => s.inkBarOpen);
  const inkTool = useInkTools((s) => s.tool);
  const inkListOpen = useInkTools((s) => s.listOpen);
  const { data: reading } = useReading(paperId);
  // Load what the side panels show, so opening one doesn't flash a loading state first.
  useArticle(focusMode ? paperId : null);
  useMessages(focusMode ? paperId : null);
  const [searchOpen, setSearchOpen] = useState(false);

  const count = reading?.page_count ?? 0;
  const completed = reading?.completed_pages ?? [];
  const [pageText, setPageText] = useState(String(currentPage));
  useEffect(() => setPageText(String(currentPage)), [currentPage, paperId]);

  const commitPage = () => {
    const value = parseInt(pageText.normalize("NFKC"), 10);
    if (Number.isFinite(value) && value !== currentPage) jumpToPage(value);
    else setPageText(String(currentPage));
  };

  let pageLabel = count ? `${currentPage} / ${count}` : "—";
  if (translatedOnly) {
    pageLabel = completed.length
      ? `原文 p.${currentPage}（表示 ${Math.max(1, completed.indexOf(currentPage) + 1)} / ${completed.length}）`
      : "翻訳済みページ: 0";
  } else if (reading?.preview && completed.length < count) {
    pageLabel = `${currentPage} / ${count}（${completed.length}ページ翻訳済み）`;
  }
  const version = reading?.page_versions?.[String(currentPage)];
  const atStart = translatedOnly ? completed[0] === undefined || currentPage <= completed[0] : currentPage <= 1;
  const atEnd = translatedOnly ? !completed.length || currentPage >= completed[completed.length - 1] : currentPage >= count;
  const reviewCount = translationIssues(reading).size;
  const outlineIndex = outline?.length ? currentOutlineIndex(outline, currentPage) : -1;
  // Pressed whenever the writing toolbar is on screen (see inkToolbarOpen).
  const inkPressed = inkToolbarOpen({ open: inkBarOpen, tool: inkTool, listOpen: inkListOpen });

  // What fits: measured before the first paint, and again whenever the row changes width.
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setRowWidth(row.clientWidth - 24);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const fit = fitReaderToolbar(rowWidth, { focusMode, hasOutline: !!outline?.length, reviewCount });
  const shown = (id: string) => (fit[id] ?? -1) >= 0;
  const full = (id: string) => (fit[id] ?? -1) >= 1;
  // Whether the menu holds anything besides the page information.
  const folded = ["back", "ink", "review", "filter", "zoom"].some((id) => !shown(id)) || !full("zoom")
    || (!!outline?.length && !shown("outline")) || (focusMode && (!shown("panels") || !shown("sticky")));

  const toggleInk = () => {
    if (inkPressed) {
      useStore.getState().setInkBarOpen(false);
      useInkTools.getState().setListOpen(false);
      useInkTools.getState().setTool("select");
    } else {
      useStore.getState().setInkBarOpen(true);
    }
  };
  const setPageFilter = (value: string) => {
    const only = value === "translated";
    setTranslatedOnly(only);
    if (only && completed.length && !completed.includes(currentPage)) useStore.getState().setCurrentPage(completed[0]);
  };
  const outlineItems = (outline ?? []).map((entry, index) => (
    <DropdownMenuItem key={index} disabled={entry.page === undefined}
      className={`gap-3 text-[12px] ${index === outlineIndex ? "font-medium text-primary" : ""}`}
      style={{ paddingLeft: 8 + Math.min(entry.depth, 6) * 14 }}
      onClick={() => entry.page !== undefined && navigateTo({ page: entry.page, anchor_y: entry.anchor_y, side: "original" })}>
      <span className="min-w-0 flex-1 truncate" title={entry.title}>{entry.title}</span>
      {entry.page !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">p.{entry.page}</span>}
    </DropdownMenuItem>
  ));
  const outlineMenuClass = "w-96 max-w-[calc(100vw-2rem)] max-h-[min(60vh,var(--available-height))]";

  const button = "p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0";
  // An icon with a label beside it when there is room (see readerToolbarItems for the widths).
  const labeled = "inline-flex items-center gap-1 h-6 px-1.5 rounded text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 whitespace-nowrap aria-pressed:bg-primary/10 aria-pressed:text-primary";
  const chip = (active: boolean) => `flex items-center gap-1 h-6 px-2 rounded text-[12px] border transition-colors shrink-0 whitespace-nowrap ${active ? "text-primary bg-primary/10 border-primary/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  const reviewLabel = `翻訳の確認・修正${reviewCount ? `（要確認 ${reviewCount} ページ）` : ""}`;

  return (
    <div className="shrink-0 border-b bg-background/50">
      <div ref={rowRef} className="h-[39px] flex items-center px-3 gap-1 text-[13px] min-w-0" role="toolbar" aria-label="PDFの表示">
        {/* Clips anything the width estimates got wrong; the 「…」 button stays outside, always reachable. */}
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
        <button onClick={() => movePage(-1)} disabled={atStart} className={button} aria-label="前のページ" title="前のページ（← / PageUp / ページ先頭でホイール上）">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <input
          id="page-input"
          type="text"
          inputMode="numeric"
          value={pageText}
          onChange={(e) => setPageText(e.target.value.replace(/[^0-9０-９]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPage();
            if (e.key === "Escape") { setPageText(String(currentPage)); (e.target as HTMLInputElement).blur(); }
          }}
          onBlur={commitPage}
          aria-label="ページ番号"
          title="ページ番号を入力し、Enterで移動（Ctrl+G）"
          className="w-11 h-6 shrink-0 text-center border rounded bg-background focus:ring-2 focus:ring-ring focus:outline-none tabular-nums"
        />
        {shown("go") && (
          <button onClick={commitPage} className="h-6 px-2 shrink-0 rounded border text-[12px] hover:bg-muted">
            移動
          </button>
        )}
        <button onClick={() => movePage(1)} disabled={atEnd} className={button} aria-label="次のページ" title="次のページ（→ / PageDown / ページ末尾でホイール下）">
          <ChevronRight className="w-4 h-4" />
        </button>
        {shown("back") && (
          <button onClick={historyBack} disabled={!canGoBack} className={button} aria-label="戻る"
            title="リンク・目次・検索で移動する前の場所に戻る（Alt+←）">
            <Undo2 className="w-4 h-4" />
          </button>
        )}
        {/* Takes the room left over, so it also pushes the groups after it to the end. */}
        <span className="ml-1.5 flex-1 min-w-0 text-muted-foreground tabular-nums truncate" title={pageLabel}>
          {shown("label") ? pageLabel : null}
        </span>

        {shown("outline") && (
          <DropdownMenu>
            <DropdownMenuTrigger className={labeled} aria-label="目次" title="PDF の目次から移動（Alt+← で戻る）">
              <ListTree className="size-3.5" />{full("outline") && "目次"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={outlineMenuClass}>{outlineItems}</DropdownMenuContent>
          </DropdownMenu>
        )}
        <button className={labeled} aria-label="論文内検索" aria-pressed={searchOpen} title="論文内検索（Ctrl+F）" onClick={() => setSearchOpen(!searchOpen)}>
          <Search className="size-3.5" />{full("search") && "検索"}
        </button>
        {shown("review") && (
          <button className={labeled} aria-label={reviewLabel} title={reviewLabel} onClick={() => emitAppEvent("open-translation-review")}>
            <ClipboardCheck className="size-3.5" />
            {full("review") && "翻訳の確認・修正"}
            {!!reviewCount && <span className="tabular-nums">{full("review") ? `(${reviewCount})` : reviewCount}</span>}
          </button>
        )}
        {shown("ink") && (
          <button className={labeled} aria-label="書き込みツール" aria-pressed={inkPressed} onClick={toggleInk}
            title={inkPressed ? "書き込みツールを閉じて本文選択に戻る" : "書き込みツールを表示（ペン・消しゴム・付箋・範囲キャプチャ・書き込み付きPDFの保存）"}>
            <PenLine className="size-3.5" />{full("ink") && "書き込み"}
          </button>
        )}

        {shown("filter") && (
          <select
            value={translatedOnly ? "translated" : "all"}
            onChange={(e) => setPageFilter(e.target.value)}
            aria-label="表示するページ"
            title="表示するページ"
            className="ml-1.5 h-6 shrink-0 bg-transparent border rounded text-[12px] px-1 hover:bg-muted cursor-pointer"
          >
            <option value="all">全ページ</option>
            <option value="translated">翻訳済みページのみ</option>
          </select>
        )}
        {shown("zoom") && <div className="ml-1.5 flex items-center gap-1 shrink-0">
          {full("zoom") && (
            <button onClick={() => changeZoom(-1)} disabled={zoom <= ZOOM_LEVELS[0]} className={button} aria-label="縮小"
              title="原文・日本語訳を縮小（Ctrl＋マウスホイール下 / Ctrl+-）">
              <ZoomOut className="w-4 h-4" />
            </button>
          )}
          <select
            value={String(ZOOM_LEVELS.includes(zoom) ? zoom : 1)}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="表示倍率"
            title="原文・日本語訳の共通倍率（幅に合わせた表示が基準。「ページ全体」はページ全体が収まる大きさ）"
            className="h-6 bg-transparent border rounded text-[12px] px-1 hover:bg-muted cursor-pointer tabular-nums"
          >
            {ZOOM_LEVELS.map((value) => (
              <option key={value} value={String(value)}>{zoomLabel(value)}</option>
            ))}
          </select>
          {full("zoom") && (
            <button onClick={() => changeZoom(1)} disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} className={button} aria-label="拡大"
              title="原文・日本語訳を拡大（Ctrl＋マウスホイール上 / Ctrl+=）">
              <ZoomIn className="w-4 h-4" />
            </button>
          )}
        </div>}
        {focusMode && shown("sticky") && (
          <button onClick={() => useStore.getState().setActiveTab("sticky-notes")} className={`${button} ml-1.5`} title="付箋タブへ（Ctrl+5）" aria-label="付箋タブへ">
            <StickyNote className="w-4 h-4" />
          </button>
        )}
        {focusMode && shown("panels") && (
          <div className="ml-1.5 flex items-center gap-1 shrink-0">
            {FOCUS_PANELS.map(({ tab, label, icon: Icon, key }) => (
              <button
                key={tab}
                onClick={() => setFocusPanel(focusPanel === tab ? null : tab)}
                className={chip(focusPanel === tab)}
                aria-label={label}
                aria-pressed={focusPanel === tab}
                title={`${label}を右に表示（${key}）`}
              >
                <Icon className="w-3.5 h-3.5" />
                {full("panels") && label}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => setFocusMode(!focusMode)}
          className={`${chip(focusMode)} ml-1.5`}
          aria-label={focusMode ? "集中表示を終了" : "集中表示"}
          aria-pressed={focusMode}
          title="PDFとページ操作を大きく表示（F11で切り替え）"
        >
          {focusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          {full("focus") && (focusMode ? "集中表示を終了" : "集中表示")}
        </button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className={button} aria-label="その他の表示・操作" title="その他の表示・操作">
            <MoreHorizontal className="w-4 h-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-[calc(100vw-2rem)]">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="tabular-nums">{pageLabel}</DropdownMenuLabel>
              {version && (
                <DropdownMenuLabel className="font-normal" title="このページを翻訳したときのコード版とモデル">
                  翻訳時SHA：{version.sha} ({version.model})
                </DropdownMenuLabel>
              )}
            </DropdownMenuGroup>
            {folded && <DropdownMenuSeparator />}
            {!shown("back") && (
              <DropdownMenuItem disabled={!canGoBack} onClick={historyBack}><Undo2 /> 移動する前の場所に戻る（Alt+←）</DropdownMenuItem>
            )}
            {!shown("outline") && !!outline?.length && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><ListTree /> 目次</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={outlineMenuClass}>{outlineItems}</DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {!shown("ink") && (
              <DropdownMenuCheckboxItem checked={inkPressed} onCheckedChange={toggleInk}><PenLine /> 書き込みツール</DropdownMenuCheckboxItem>
            )}
            {!shown("review") && (
              <DropdownMenuItem onClick={() => emitAppEvent("open-translation-review")}>
                <ClipboardCheck /> 翻訳の確認・修正{reviewCount ? `（${reviewCount}）` : ""}
              </DropdownMenuItem>
            )}
            {focusMode && !shown("panels") && FOCUS_PANELS.map(({ tab, label, icon: Icon, key }) => (
              <DropdownMenuCheckboxItem key={tab} checked={focusPanel === tab} onCheckedChange={() => setFocusPanel(focusPanel === tab ? null : tab)}>
                <Icon /> {label}を右に表示（{key}）
              </DropdownMenuCheckboxItem>
            ))}
            {focusMode && !shown("sticky") && (
              <DropdownMenuItem onClick={() => useStore.getState().setActiveTab("sticky-notes")}><StickyNote /> 付箋タブへ（Ctrl+5）</DropdownMenuItem>
            )}
            {!full("zoom") && <>
              <DropdownMenuItem disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} onClick={() => changeZoom(1)}><ZoomIn /> 拡大（Ctrl++）</DropdownMenuItem>
              <DropdownMenuItem disabled={zoom <= ZOOM_LEVELS[0]} onClick={() => changeZoom(-1)}><ZoomOut /> 縮小（Ctrl+-）</DropdownMenuItem>
            </>}
            {!shown("zoom") && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>表示倍率</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={String(ZOOM_LEVELS.includes(zoom) ? zoom : 1)} onValueChange={(value) => setZoom(Number(value))}>
                  {ZOOM_LEVELS.map((value) => (
                    <DropdownMenuRadioItem key={value} value={String(value)} className="tabular-nums">{zoomLabel(value)}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            )}
            {!shown("filter") && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>表示するページ</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={translatedOnly ? "translated" : "all"} onValueChange={(value) => setPageFilter(String(value))}>
                  <DropdownMenuRadioItem value="all">全ページ</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="translated">翻訳済みページのみ</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ReaderSearch paperId={paperId} search={search} setSearch={setSearch} ownsKey={ownsKey} open={searchOpen} setOpen={setSearchOpen} />
      <TranslationReview paperId={paperId} />
    </div>
  );
}
