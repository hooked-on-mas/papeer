import { Download, FileText, Maximize2, Minimize2, MoreHorizontal, PanelLeft, PanelRight, Scan } from "lucide-react";
import { useStore } from "@/store";
import { useItemCapabilities } from "@/api/hooks";
import { tabAvailable } from "@/lib/itemKinds";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { emitAppEvent } from "@/lib/appEvents";
import { withShortcutLabels } from "@/lib/platform";
import { PageNavigator } from "@/features/reader/PageNavigator";
import { ZoomControl, ZoomMenuGroup } from "@/features/reader/ZoomControl";
import { SIDE_PANEL_BUTTONS } from "@/features/reader/sidePanelButtons";
import { useInkPdfExport } from "@/features/reader/inkControls";
import { useInkPreferences, useInkTools } from "@/features/reader/useInkEditor";
import type { BarFit } from "@/features/reader/readerBars";
import type { NotebookDocument } from "./notebooks";

const moreButton = "p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0";
const chip = (active: boolean) => `flex items-center gap-1 h-6 px-2 rounded text-[0.75rem] border transition-colors shrink-0 whitespace-nowrap ${active ? "text-primary bg-primary/10 border-primary/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;

/**
 * The notebook's one row of controls: the writing tools (drawn into `setToolsSlot` by the page, see
 * NotebookInkTools), the page, the zoom and focus mode, and a 「…」 menu for the rest. It is a single row
 * whatever tool is picked, so that the paper under it never moves; what doesn't fit goes into the menu
 * (see fitNotebookToolbar). A failed save is reported in `setAlertSlot`, under the row.
 */
export function NotebookToolbar({ paperId, document, fit, busy, rowRef, setToolsSlot, setAlertSlot }: {
  paperId: string;
  document: NotebookDocument | undefined;
  fit: BarFit;
  /** A page operation is under way: the writing tools wait for it. */
  busy: boolean;
  rowRef: (row: HTMLDivElement | null) => void;
  setToolsSlot: (slot: HTMLDivElement | null) => void;
  setAlertSlot: (slot: HTMLDivElement | null) => void;
}) {
  const currentPage = useStore((s) => s.currentPage);
  const focusMode = useStore((s) => s.focusMode);
  const setFocusMode = useStore((s) => s.setFocusMode);
  const sidePanel = useStore((s) => s.sidePanel);
  const setSidePanel = useStore((s) => s.setSidePanel);
  const sidebarHidden = useStore((s) => s.notebookSidebarHidden);
  const setSidebarHidden = useStore((s) => s.setNotebookSidebarHidden);
  const caps = useItemCapabilities(paperId);
  const preferences = useInkPreferences();
  const { exporting, exportPdf } = useInkPdfExport();

  const count = document?.pages.length ?? 0;
  const shown = (id: string) => (fit[id] ?? -1) >= 0;
  const full = (id: string) => (fit[id] ?? -1) >= 1;
  const panelButtons = SIDE_PANEL_BUTTONS.filter(({ tab }) => tabAvailable(caps, tab));
  const panelTitle = (label: string, key: string) => `${label}を右に表示${focusMode ? `（${withShortcutLabels(key)}）` : ""}`;

  return <div className="shrink-0 border-b bg-background/50">
    <div ref={rowRef} className="h-[2.4375rem] flex items-center px-3 gap-1 text-[0.8125rem] min-w-0" role="toolbar" aria-label="ノートの道具">
      {/* Clips anything the width estimates got wrong; the 「…」 button stays outside, always reachable. */}
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
        {/* 自動 (the default): the page sidebar is shown beside the paper, or folded into a tab when there is no room. */}
        <button aria-label="ページ一覧" aria-pressed={!sidebarHidden} onClick={() => setSidebarHidden(!sidebarHidden)}
          title={sidebarHidden ? "ページ一覧を表示する（余白に置き、狭いときは左端のつまみに畳みます）" : "ページ一覧を隠す（今は余白またはつまみに表示）"}
          className={`size-7 shrink-0 rounded inline-flex items-center justify-center hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${sidebarHidden ? "text-muted-foreground hover:text-foreground" : "bg-primary/10 text-primary"}`}>
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="mx-1 h-4 shrink-0 border-l" />
        {/* data-ink-toolbar-slot: INK_TOOLBAR_SLOT, which lets the tools' keys through to the page. */}
        <div ref={setToolsSlot} data-ink-toolbar-slot="" inert={busy} className="flex items-center gap-1 shrink-0" />
        <PageNavigator paperId={paperId} currentPage={currentPage} count={count}
          atStart={currentPage <= 1} atEnd={!count || currentPage >= count} compact />
        {shown("zoom") && <ZoomControl steps={full("zoom")} subject="notebook" />}
      </div>

      {/* Outside the clipped area like the 「…」 button, so that a wrong width estimate never cuts it off. */}
      {shown("focus") && <button
        onClick={() => setFocusMode(!focusMode)}
        className={chip(focusMode)}
        aria-label={focusMode ? "集中表示を終了" : "集中表示"}
        aria-pressed={focusMode}
        title={withShortcutLabels("ノートを大きく表示（F11で切り替え）")}
      >
        {focusMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>}

      <DropdownMenu>
        <DropdownMenuTrigger className={moreButton} aria-label="その他の表示・操作" title="その他の表示・操作">
          <MoreHorizontal className="w-4 h-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56 max-w-[calc(100vw-2rem)]">
          <DropdownMenuItem disabled={exporting || !document} title="書き込みを描き込んだPDFとして、ノート全体を保存します" onClick={() => void exportPdf(paperId, "original")}>
            <Download /> {exporting ? "出力中…" : "書き込み付きPDFとして保存…"}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!document} title="囲んだ範囲を画像としてキャプチャします" onClick={() => useInkTools.getState().setTool("capture")}>
            <Scan /> 範囲キャプチャ
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {panelButtons.length > 0 && <DropdownMenuGroup>
            <DropdownMenuLabel>右パネル</DropdownMenuLabel>
            {panelButtons.map(({ tab, label, icon: Icon, key }) => (
              <DropdownMenuCheckboxItem key={tab} checked={sidePanel === tab} closeOnClick
                aria-label={`${label}を右に表示`} title={panelTitle(label, key)}
                onCheckedChange={() => setSidePanel(sidePanel === tab ? null : tab)}>
                <Icon /> {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuItem disabled={!sidePanel} onClick={() => setSidePanel(null)}><PanelRight /> 右パネルを閉じる</DropdownMenuItem>
          </DropdownMenuGroup>}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>消しゴムの設定</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuLabel>大きさ</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={String(preferences.eraserRadius)} onValueChange={(value) => preferences.change({ eraserRadius: Number(value) })}>
                <DropdownMenuRadioItem value="5">小</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="10">中</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="20">大</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={preferences.partial} onCheckedChange={(checked) => preferences.change({ partial: checked })}
                title="線の触れた部分だけ消す（図形・テキストは全体）">部分消しゴム</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={preferences.highlightOnly} onCheckedChange={(checked) => preferences.change({ highlightOnly: checked })}
                title="蛍光ペン以外は残す">蛍光ペンだけ消す</DropdownMenuCheckboxItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {(!shown("zoom") || !shown("focus") || focusMode) && <DropdownMenuSeparator />}
          {!shown("zoom") && <ZoomMenuGroup subject="notebook" />}
          {!shown("focus") && (
            <DropdownMenuItem onClick={() => setFocusMode(!focusMode)}>
              {focusMode ? <Minimize2 /> : <Maximize2 />} {withShortcutLabels(focusMode ? "集中表示を終了（F11）" : "集中表示（F11）")}
            </DropdownMenuItem>
          )}
          {focusMode && <DropdownMenuItem onClick={() => emitAppEvent("open-paper-details", { paperId })}>
            <FileText /> 情報・整理
          </DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {/* Empty (and so flat) unless a save has failed. */}
    <div ref={setAlertSlot} className="empty:hidden" />
  </div>;
}
