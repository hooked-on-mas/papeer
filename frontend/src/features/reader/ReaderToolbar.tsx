import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, MessageSquare, Minimize2, NotebookPen, ScrollText, ZoomIn, ZoomOut } from "lucide-react";
import { useStore, ZOOM_PRESETS } from "@/store";
import { useArticle, useMessages, useReading } from "@/api/hooks";
import { changeZoom, jumpToPage, movePage } from "./navigation";

const ZOOM_LABELS: Record<number, string> = { 1: "幅に合わせる" };

/** Tabs that focus mode can open beside the reader. */
const FOCUS_PANELS = [
  { tab: "summary", label: "サマリー", icon: ScrollText, key: "Ctrl+2" },
  { tab: "chat", label: "質問", icon: MessageSquare, key: "Ctrl+3" },
  { tab: "notes", label: "メモ", icon: NotebookPen, key: "Ctrl+4" },
];

export function ReaderToolbar() {
  const activePaperId = useStore((s) => s.activePaperId);
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const translatedOnly = useStore((s) => s.translatedOnly);
  const setTranslatedOnly = useStore((s) => s.setTranslatedOnly);
  const focusMode = useStore((s) => s.focusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const focusPanel = useStore((s) => s.focusPanel);
  const setFocusPanel = useStore((s) => s.setFocusPanel);
  const { data: reading } = useReading(activePaperId);
  // Load what the side panels show, so opening one doesn't flash a loading state first.
  useArticle(focusMode ? activePaperId : null);
  useMessages(focusMode ? activePaperId : null);

  const count = reading?.page_count ?? 0;
  const completed = reading?.completed_pages ?? [];
  const [pageText, setPageText] = useState(String(currentPage));
  useEffect(() => setPageText(String(currentPage)), [currentPage, activePaperId]);

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

  const button = "p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none";

  return (
    <div className="h-[40px] flex items-center px-3 gap-1 border-b shrink-0 bg-background/50 text-[13px] min-w-0">
      <button onClick={() => movePage(-1)} disabled={!activePaperId || atStart} className={button} title="前のページ（←）">
        <ChevronLeft className="w-4 h-4" />
      </button>
      <input
        id="page-input"
        type="text"
        inputMode="numeric"
        value={pageText}
        disabled={!activePaperId}
        onChange={(e) => setPageText(e.target.value.replace(/[^0-9０-９]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitPage();
          if (e.key === "Escape") { setPageText(String(currentPage)); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={commitPage}
        title="ページ番号を入力し、Enterで移動（Ctrl+G）"
        className="w-11 h-6 text-center border rounded bg-background focus:ring-2 focus:ring-ring focus:outline-none tabular-nums"
      />
      <button onClick={commitPage} disabled={!activePaperId} className="h-6 px-2 rounded border text-[12px] hover:bg-muted disabled:opacity-40">
        移動
      </button>
      <button onClick={() => movePage(1)} disabled={!activePaperId || atEnd} className={button} title="次のページ（→）">
        <ChevronRight className="w-4 h-4" />
      </button>
      <span className="ml-2 text-muted-foreground tabular-nums truncate min-w-0" title={pageLabel}>{pageLabel}</span>
      {version && (
        <span className="ml-2 text-[11px] text-muted-foreground/80 truncate hidden lg:inline" title="このページを翻訳したときのコード版とモデル">
          翻訳時SHA：{version.sha} ({version.model})
        </span>
      )}

      <div className="ml-auto flex items-center gap-1 shrink-0">
        <select
          value={translatedOnly ? "translated" : "all"}
          onChange={(e) => {
            const only = e.target.value === "translated";
            setTranslatedOnly(only);
            if (only && completed.length && !completed.includes(currentPage)) {
              useStore.getState().setCurrentPage(completed[0]);
            }
          }}
          title="表示するページ"
          className="h-6 bg-transparent border rounded text-[12px] px-1 hover:bg-muted cursor-pointer"
        >
          <option value="all">全ページ</option>
          <option value="translated">翻訳済みページのみ</option>
        </select>
        <div className="w-px h-4 bg-border mx-2" />
        <button onClick={() => changeZoom(-1)} disabled={zoom <= ZOOM_PRESETS[0]} className={button}
          title="原文・日本語訳を縮小（Ctrl＋マウスホイール下 / Ctrl+-）">
          <ZoomOut className="w-4 h-4" />
        </button>
        <select
          value={String(ZOOM_PRESETS.includes(zoom) ? zoom : 1)}
          onChange={(e) => setZoom(Number(e.target.value))}
          title="原文・日本語訳の共通倍率（幅に合わせた表示が基準）"
          className="h-6 bg-transparent border rounded text-[12px] px-1 hover:bg-muted cursor-pointer tabular-nums"
        >
          {ZOOM_PRESETS.map((value) => (
            <option key={value} value={String(value)}>{ZOOM_LABELS[value] ?? `${Math.round(value * 100)}%`}</option>
          ))}
        </select>
        <button onClick={() => changeZoom(1)} disabled={zoom >= ZOOM_PRESETS[ZOOM_PRESETS.length - 1]} className={button}
          title="原文・日本語訳を拡大（Ctrl＋マウスホイール上 / Ctrl+=）">
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-border mx-2" />
        {focusMode && (
          <>
            {FOCUS_PANELS.map(({ tab, label, icon: Icon, key }) => (
              <button
                key={tab}
                onClick={() => setFocusPanel(focusPanel === tab ? null : tab)}
                className={`flex items-center gap-1 h-6 px-2 rounded text-[12px] border transition-colors ${focusPanel === tab ? "text-primary bg-primary/10 border-primary/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                title={`${label}を右に表示（${key}）`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">{label}</span>
              </button>
            ))}
            <div className="w-px h-4 bg-border mx-2" />
          </>
        )}
        <button
          onClick={() => setFocusMode(!focusMode)}
          className={`flex items-center gap-1 h-6 px-2 rounded text-[12px] border transition-colors ${focusMode ? "text-primary bg-primary/10 border-primary/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          title="PDFとページ操作を大きく表示（F11で切り替え）"
        >
          {focusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          {focusMode ? "集中表示を終了" : "集中表示"}
        </button>
      </div>
    </div>
  );
}
