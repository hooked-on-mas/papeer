import { useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown, ClipboardCheck, ListTree, Maximize2, Minimize2, MoreHorizontal, PanelRight,
  Search, StickyNote, Undo2, ZoomIn, ZoomOut, Network, FileText,
} from "lucide-react";
import { useStore, ZOOM_LEVELS } from "@/store";
import { useUiScale } from "@/app/uiScale";
import { useArticle, useItemCapabilities, useMessages, useReading } from "@/api/hooks";
import { tabAvailable } from "@/lib/itemKinds";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { emitAppEvent } from "@/lib/appEvents";
import { changeZoom, historyBack, navigateTo } from "./navigation";
import { PageNavigator } from "./PageNavigator";
import { ZoomControl, ZoomMenuGroup } from "./ZoomControl";
import { SIDE_PANEL_BUTTONS } from "./sidePanelButtons";
import { currentOutlineIndex, type OutlineEntry } from "./pdfLinks";
import { fitReaderToolbar } from "./readerBars";
import { ReaderSearch } from "./ReaderSearch";
import { ReaderInkButton } from "./ReaderInkButton";
import { TranslationReview } from "./TranslationReview";
import { translationIssues } from "@/lib/translationIssues";
import { withShortcutLabels } from "@/lib/platform";

type Search = { query: string; side: "original" | "translated" };

/**
 * The reader's one row of controls: pages, writing tools, table of contents, search, zoom and focus
 * mode. Whatever doesn't fit its width goes into the 「…」 menu at its end (see readerBars.ts).
 */
export function ReaderToolbar({ paperId, search, setSearch, outline, ownsKey }: {
  paperId: string;
  search: Search;
  setSearch: (value: Search) => void;
  /** The original's table of contents; null is loading, empty means no outline. */
  outline: OutlineEntry[] | null;
  /** Whether a key press is the reader's, as the paging keys decide it. */
  ownsKey: (e: KeyboardEvent) => boolean;
}) {
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.zoom);
  // What the open item can do (see lib/itemKinds.ts): the controls of what it cannot are not offered.
  const caps = useItemCapabilities(paperId);
  const translatedOnly = useStore((s) => s.translatedOnly) && caps.translate;
  const setTranslatedOnly = useStore((s) => s.setTranslatedOnly);
  const focusMode = useStore((s) => s.focusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const sidePanel = useStore((s) => s.sidePanel);
  const setSidePanel = useStore((s) => s.setSidePanel);
  const canGoBack = useStore((s) => s.readerHistory.back.length > 0);
  const { data: reading } = useReading(paperId);
  // Load what the side panels show, so opening one doesn't flash a loading state first.
  useArticle(caps.summary ? paperId : null);
  useMessages(caps.chat ? paperId : null);
  const [searchOpen, setSearchOpen] = useState(false);

  const count = reading?.page_count ?? 0;
  const completed = reading?.completed_pages ?? [];
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
  const reviewCount = translationIssues(reading).length;
  const outlineIndex = outline?.length ? currentOutlineIndex(outline, currentPage) : -1;

  // What fits: measured before the first paint, and again whenever the row changes width.
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const uiScale = useUiScale((s) => s.scale);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  // The widths in readerBars.ts are at 100%, less the row's padding (px-3); the UI size (lib/uiScale.ts)
  // scales everything drawn in the row.
  // Reserve the outline's space before the PDF loads, so other controls never move when it arrives.
  const fit = fitReaderToolbar(Math.max(0, rowWidth / uiScale - 24), { focusMode, hasOutline: true });
  const shown = (id: string) => (fit[id] ?? -1) >= 0;
  const full = (id: string) => (fit[id] ?? -1) >= 1;
  const panelTitle = (label: string, key: string) => `${label}を右に表示${focusMode ? `（${withShortcutLabels(key)}）` : ""}`;
  const panelButtons = SIDE_PANEL_BUTTONS.filter(({ tab }) => tabAvailable(caps, tab));
  const panelLabel = panelButtons.find(({ tab }) => tab === sidePanel)?.label ?? "右パネル";

  const setPageFilter = (value: string) => {
    const only = value === "translated";
    setTranslatedOnly(only);
    if (only && completed.length && !completed.includes(currentPage)) useStore.getState().setCurrentPage(completed[0]);
  };
  const outlineItems = (outline ?? []).map((entry, index) => (
    <DropdownMenuItem key={index} disabled={entry.page === undefined}
      className={`gap-3 text-[0.75rem] ${index === outlineIndex ? "font-medium text-primary" : ""}`}
      style={{ paddingLeft: 8 + Math.min(entry.depth, 6) * 14 }}
      onClick={() => entry.page !== undefined && navigateTo({ page: entry.page, anchor_y: entry.anchor_y, side: "original" })}>
      <span className="min-w-0 flex-1 truncate" title={entry.title}>{entry.title}</span>
      {entry.page !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">p.{entry.page}</span>}
    </DropdownMenuItem>
  ));
  const outlineMenuClass = "w-96 max-w-[calc(100vw-2rem)] max-h-[min(60vh,var(--available-height))]";
  const outlineTitle = outline === null ? "目次を読み込んでいます…"
    : !outline.length ? "このPDFに目次はありません。"
    : withShortcutLabels("PDF の目次から移動（Alt+← で戻る）");

  const button = "p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0";
  // An icon with a label beside it when there is room (see readerToolbarItems for the widths).
  const labeled = "inline-flex items-center gap-1 h-6 px-1.5 rounded text-[0.75rem] text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 whitespace-nowrap aria-pressed:bg-primary/10 aria-pressed:text-primary";
  const chip = (active: boolean) => `flex items-center gap-1 h-6 px-2 rounded text-[0.75rem] border transition-colors shrink-0 whitespace-nowrap ${active ? "text-primary bg-primary/10 border-primary/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  const reviewLabel = `翻訳の確認・修正${reviewCount ? `（要確認 ${reviewCount} ページ）` : ""}`;

  return (
    <div className="shrink-0 border-b bg-background/50">
      <div ref={rowRef} className="h-[2.4375rem] flex items-center px-3 gap-1 text-[0.8125rem] min-w-0" role="toolbar" aria-label="PDFの表示">
        {/* Clips anything the width estimates got wrong; the 「…」 button stays outside, always reachable. */}
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
        <PageNavigator paperId={paperId} currentPage={currentPage} count={count} atStart={atStart} atEnd={atEnd} showGo={shown("go")} />
        {shown("back") && (
          <button onClick={historyBack} disabled={!canGoBack} className={button} aria-label="戻る"
            title={withShortcutLabels("リンク・目次・検索で移動する前の場所に戻る（Alt+←）")}>
            <Undo2 className="w-4 h-4" />
          </button>
        )}
        {/* Takes the room left over, so it also pushes the groups after it to the end. */}
        <span className="ml-1.5 flex-1 min-w-0 text-muted-foreground tabular-nums truncate" title={pageLabel}>
          {shown("label") ? pageLabel : null}
        </span>

        {caps.annotate && <ReaderInkButton />}
        {shown("outline") && (
          <DropdownMenu>
            <DropdownMenuTrigger className={`${labeled} disabled:opacity-40`} aria-label="目次" title={outlineTitle} disabled={!outline?.length}>
              <ListTree className="size-3.5" />{full("outline") && "目次"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={outlineMenuClass}>{outlineItems}</DropdownMenuContent>
          </DropdownMenu>
        )}
        {caps.fullTextSearch && shown("search") && <button className={labeled} aria-label="論文内検索" aria-pressed={searchOpen} title={withShortcutLabels("論文内検索（Ctrl+F）")} onClick={() => setSearchOpen(!searchOpen)}>
          <Search className="size-3.5" />{full("search") && "検索"}
        </button>}
        {shown("zoom") && <ZoomControl steps={full("zoom")} />}
        {caps.stickyNotes && focusMode && shown("sticky") && (
          <button onClick={() => useStore.getState().setActiveTab("sticky-notes")} className={`${button} ml-1.5`} title={withShortcutLabels("付箋タブへ（Ctrl+5）")} aria-label="付箋タブへ">
            <StickyNote className="w-4 h-4" />
          </button>
        )}
        {panelButtons.length > 0 && shown("panels") && !focusMode && (
          <DropdownMenu>
            <DropdownMenuTrigger className={`${chip(!!sidePanel)} ml-1.5`} aria-label="右パネルを選択"
              title={sidePanel ? `${panelLabel}を右に表示中` : "サマリー・チャット・メモを右に表示"}>
              <PanelRight className="size-3.5" />
              {panelLabel}
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {panelButtons.map(({ tab, label, icon: Icon, key }) => (
                <DropdownMenuCheckboxItem key={tab} checked={sidePanel === tab} closeOnClick
                  aria-label={`${label}を右に表示`} title={panelTitle(label, key)}
                  onCheckedChange={() => setSidePanel(sidePanel === tab ? null : tab)}>
                  <Icon /> {label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!sidePanel} onClick={() => setSidePanel(null)}>右パネルを閉じる</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {panelButtons.length > 0 && shown("panels") && focusMode && (
          <div className="ml-1.5 flex items-center gap-1 shrink-0">
            {panelButtons.map(({ tab, label, icon: Icon, key }) => (
              <button
                key={tab}
                onClick={() => setSidePanel(sidePanel === tab ? null : tab)}
                className={chip(sidePanel === tab)}
                aria-label={`${label}を右に表示`}
                aria-pressed={sidePanel === tab}
                title={panelTitle(label, key)}
              >
                <Icon className="w-3.5 h-3.5" />
                {full("panels") && label}
              </button>
            ))}
          </div>
        )}
        </div>

        {/* Outside the clipped area like the 「…」 button, so that a wrong width estimate never cuts it off. */}
        <button
          onClick={() => setFocusMode(!focusMode)}
          className={chip(focusMode)}
          aria-label={focusMode ? "集中表示を終了" : "集中表示"}
          aria-pressed={focusMode}
          title={withShortcutLabels("PDFとページ操作を大きく表示（F11で切り替え）")}
        >
          {focusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          {full("focus") && (focusMode ? "集中表示を終了" : "集中表示")}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger className={button} aria-label="その他の表示・操作" title="その他の表示・操作">
            <MoreHorizontal className="w-4 h-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-[calc(100vw-2rem)]">
            {caps.citationMap && <DropdownMenuItem onClick={() => useStore.getState().setActiveTab("references")}><Network /> 論文マップ</DropdownMenuItem>}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="tabular-nums">{pageLabel}</DropdownMenuLabel>
              {caps.translate && version && (
                <DropdownMenuLabel className="font-normal" title="このページを翻訳したときの翻訳キー（接続先・モデル・プロンプトなどから計算）とモデル">
                  翻訳時SHA：{version.sha} ({version.model})
                </DropdownMenuLabel>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {caps.fullTextSearch && !shown("search") && (
              <DropdownMenuItem onClick={() => setSearchOpen(true)}><Search /> {withShortcutLabels("論文内検索（Ctrl+F）")}</DropdownMenuItem>
            )}
            {!shown("back") && (
              <DropdownMenuItem disabled={!canGoBack} onClick={historyBack}><Undo2 /> {withShortcutLabels("移動する前の場所に戻る（Alt+←）")}</DropdownMenuItem>
            )}
            {!shown("outline") && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!outline?.length} title={outlineTitle}><ListTree /> 目次</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className={outlineMenuClass}>{outlineItems}</DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {caps.translate && <DropdownMenuItem title={reviewLabel} onClick={() => emitAppEvent("open-translation-review")}>
              <ClipboardCheck /> 翻訳の確認・修正{reviewCount ? `（${reviewCount}）` : ""}
            </DropdownMenuItem>}
            {focusMode && <DropdownMenuItem onClick={() => emitAppEvent("open-paper-details", { paperId })}>
              <FileText /> 論文情報・整理
            </DropdownMenuItem>}
            {!shown("panels") && panelButtons.map(({ tab, label, icon: Icon, key }) => (
              <DropdownMenuCheckboxItem key={tab} checked={sidePanel === tab} closeOnClick onCheckedChange={() => setSidePanel(sidePanel === tab ? null : tab)}>
                <Icon /> {panelTitle(label, key)}
              </DropdownMenuCheckboxItem>
            ))}
            {caps.stickyNotes && focusMode && !shown("sticky") && (
              <DropdownMenuItem onClick={() => useStore.getState().setActiveTab("sticky-notes")}><StickyNote /> {withShortcutLabels("付箋タブへ（Ctrl+5）")}</DropdownMenuItem>
            )}
            {!full("zoom") && <>
              <DropdownMenuItem disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} onClick={() => changeZoom(1)}><ZoomIn /> {withShortcutLabels("拡大（Ctrl++）")}</DropdownMenuItem>
              <DropdownMenuItem disabled={zoom <= ZOOM_LEVELS[0]} onClick={() => changeZoom(-1)}><ZoomOut /> {withShortcutLabels("縮小（Ctrl+-）")}</DropdownMenuItem>
            </>}
            {!shown("zoom") && <ZoomMenuGroup />}
            {caps.translate && <DropdownMenuGroup>
              <DropdownMenuLabel>表示するページ</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={translatedOnly ? "translated" : "all"} onValueChange={(value) => setPageFilter(String(value))}>
                <DropdownMenuRadioItem value="all">全ページ</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="translated">翻訳済みページのみ</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ReaderSearch paperId={paperId} search={search} setSearch={setSearch} ownsKey={ownsKey} open={searchOpen && caps.fullTextSearch} setOpen={setSearchOpen} />
      <TranslationReview paperId={paperId} />
    </div>
  );
}
