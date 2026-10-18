import { ZoomIn, ZoomOut } from "lucide-react";
import { useStore, ZOOM_LEVELS } from "@/store";
import { DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { withShortcutLabels } from "@/lib/platform";
import { changeZoom, type ZoomSubject } from "./navigation";
import { zoomLabel } from "./zoomLevels";

const button = "p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0";

/** What the zoom is said to change: the PDF's two panes, or the notebook's paper. */
const SUBJECT = {
  pdf: { out: "原文・日本語訳を縮小", in: "原文・日本語訳を拡大",
    select: "原文・日本語訳の共通倍率（幅に合わせた表示が基準。「ページ全体」はページ全体が収まる大きさ）" },
  notebook: { out: "縮小", in: "拡大",
    select: "用紙の倍率（幅に合わせた表示が基準。「ページ全体」は用紙全体が収まる大きさ）" },
} as const;

/** The zoom select with the − and + buttons beside it when there is room (`steps`). */
export function ZoomControl({ steps, subject = "pdf" }: { steps: boolean; subject?: ZoomSubject }) {
  const zoom = useStore((s) => subject === "notebook" ? s.notebookZoom : s.zoom);
  const setZoom = useStore((s) => subject === "notebook" ? s.setNotebookZoom : s.setZoom);
  const text = SUBJECT[subject];
  return <div className="ml-1.5 flex items-center gap-1 shrink-0">
    {steps && (
      <button onClick={() => changeZoom(-1, subject)} disabled={zoom <= ZOOM_LEVELS[0]} className={button} aria-label="縮小"
        title={withShortcutLabels(`${text.out}（Ctrl＋マウスホイール下 / Ctrl+-）`)}>
        <ZoomOut className="w-4 h-4" />
      </button>
    )}
    <select
      value={String(zoom)}
      onChange={(e) => setZoom(Number(e.target.value))}
      aria-label="表示倍率"
      title={text.select}
      className="h-6 bg-transparent border rounded text-[0.75rem] px-1 hover:bg-muted cursor-pointer tabular-nums"
    >
      {!ZOOM_LEVELS.includes(zoom) && <option value={String(zoom)}>{zoomLabel(zoom)}</option>}
      {ZOOM_LEVELS.map((value) => (
        <option key={value} value={String(value)}>{zoomLabel(value)}</option>
      ))}
    </select>
    {steps && (
      <button onClick={() => changeZoom(1, subject)} disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} className={button} aria-label="拡大"
        title={withShortcutLabels(`${text.in}（Ctrl＋マウスホイール上 / Ctrl+=）`)}>
        <ZoomIn className="w-4 h-4" />
      </button>
    )}
  </div>;
}

/** The zoom levels as a menu group, for the toolbar's 「…」 menu when the select doesn't fit. */
export function ZoomMenuGroup({ subject = "pdf" }: { subject?: ZoomSubject }) {
  const zoom = useStore((s) => subject === "notebook" ? s.notebookZoom : s.zoom);
  const setZoom = useStore((s) => subject === "notebook" ? s.setNotebookZoom : s.setZoom);
  return <DropdownMenuGroup>
    <DropdownMenuLabel>表示倍率</DropdownMenuLabel>
    <DropdownMenuRadioGroup value={String(zoom)} onValueChange={(value) => setZoom(Number(value))}>
      {!ZOOM_LEVELS.includes(zoom) && <DropdownMenuRadioItem value={String(zoom)} className="tabular-nums">{zoomLabel(zoom)}</DropdownMenuRadioItem>}
      {ZOOM_LEVELS.map((value) => (
        <DropdownMenuRadioItem key={value} value={String(value)} className="tabular-nums">{zoomLabel(value)}</DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  </DropdownMenuGroup>;
}
