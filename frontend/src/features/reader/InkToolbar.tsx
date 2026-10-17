import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StickyNote, Download, Eraser, MoreHorizontal, MousePointer2, PenLine, Redo2, Scan, SquareDashed, Type, Undo2, X } from "lucide-react";
import { useStore } from "@/store";
import { useInkPanes } from "./useInkEditor";
import { inkToolbarOpen } from "./readerBars";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { InkPageList } from "./InkPageList";
import { withShortcutLabels } from "@/lib/platform";
import {
  EraserSettings, InkCustomColor, InkFavorites, InkKindSelect, InkStraightOption, InkSwatches, InkWidthSelect, SelectionActions,
  inkButton as button, useInkPdfExport, useInkSaveRetry, type InkToolbarProps,
} from "./inkControls";

type Props = InkToolbarProps;
const SIDES = [["original", "原文"], ["translated", "訳文"]] as const;
// Tool labels show only when the bar is wide enough for all of them on one row (about 780px with
// them, 440px without, at 100%; in rem so that it follows the UI size, lib/uiScale.ts); the buttons
// keep their aria-label and title either way.
const toolLabel = "hidden @min-[50rem]:inline";

export function InkToolbar({ editor, disabled, onStickyNote, side, errorsOnly = false, slot }: Props) {
  const { ink, tool, setTool, lastPen, lastRange, selected, visible, locked } = editor;
  const barOpen = useStore(s => s.inkBarOpen);
  const hosts = useInkPanes(s => s.hosts);
  const editable = !disabled && !!ink.ready && visible && !locked;
  const { exporting, exportPdf } = useInkPdfExport();
  const { saveError, saveAll } = useInkSaveRetry(ink);
  const [styleOpen, setStyleOpen] = useState(false);
  const drawing = ["pen", "highlighter", "line", "arrow", "rectangle", "ellipse"].includes(tool);
  const selecting = tool === "region" || tool === "lasso";
  const close = () => {
    useStore.getState().setInkBarOpen(false);
    editor.setListOpen(false);
    setTool("select");
  };
  const place = (node: ReactNode) => slot === undefined ? node : slot ? createPortal(node, slot) : null;
  // Names the side, as the error may come from the pane the toolbar isn't serving.
  const saveAlert = (ink.error || saveError) && <p role="alert" className="text-xs text-destructive px-1 py-1">
    {side === "original" ? "原文" : "訳文"}：{ink.error || saveError}<button className="underline ml-1" onClick={() => void saveAll()}>再試行</button>
  </p>;
  // Hidden while reading, but a failed save is still reported.
  if (errorsOnly || !inkToolbarOpen({ open: barOpen, tool, listOpen: editor.listOpen })) {
    return saveAlert ? place(<div className="shrink-0 border-b bg-background px-2">{saveAlert}</div>) : null;
  }
  // Scrolls within the slot's height limit (Reader.tsx) when its option rows and page list run long.
  return place(<div className="@container min-h-0 border-b bg-background px-2 py-1 text-muted-foreground overflow-y-auto">
    <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="PDFの書き込み">
      <div role="group" aria-label="書き込むPDF" className="mr-1 inline-flex h-7 shrink-0 overflow-hidden rounded border text-xs">
        {SIDES.map(([value, label]) => <button key={value} aria-pressed={side === value} disabled={!hosts[value]}
          title={`${label}のPDFに書き込む（PDFをクリックしても切り替わります）`}
          className={`px-2 disabled:opacity-40 ${side === value ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted"}`}
          onClick={() => useInkPanes.getState().setActive(value)}>{label}</button>)}
      </div>
      <button aria-label="本文選択" title="本文選択（Esc）" aria-pressed={tool === "select"} className={`${button} ${tool === "select" ? "bg-primary/10 text-primary" : ""}`} onClick={() => setTool("select")}><MousePointer2 className="size-3.5" /><span className={toolLabel}>本文</span></button>
      <span className="mx-1 h-4 border-l" />
      {([{ value: lastPen, label: "ペン・図形", Icon: PenLine, active: drawing },
        { value: "eraser", label: "消しゴム", Icon: Eraser, active: tool === "eraser" },
        { value: "text", label: "テキスト", Icon: Type, active: tool === "text" },
        { value: "sticky", label: "付箋", Icon: StickyNote, active: false },
        { value: lastRange, label: "選択", Icon: SquareDashed, active: selecting }] as const).map(({ value, label, Icon, active }) =>
        <button key={label} aria-label={label} aria-pressed={active} title={label} disabled={value === "sticky" ? disabled : !editable} onClick={() => value === "sticky" ? onStickyNote(false) : setTool(value)}
          className={`${button} ${active ? "bg-primary/10 text-primary" : ""}`}><Icon className="size-3.5" /><span className={toolLabel}>{label}</span></button>)}
      <span className="mx-1 h-4 border-l" />
      <button aria-label="範囲キャプチャ" aria-pressed={tool === "capture"} disabled={disabled} title="囲んだ範囲をキャプチャする"
        className={`${button} ${tool === "capture" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : ""}`} onClick={() => setTool("capture")}><Scan className="size-3.5" /><span className={toolLabel}>範囲キャプチャ</span></button>
      <button aria-label="書き込みを元に戻す" title={withShortcutLabels("元に戻す（Ctrl+Z）")} className={button} disabled={!editable || !ink.canUndo || exporting} onClick={ink.entry?.undo}><Undo2 className="size-3.5" /></button>
      <button aria-label="書き込みをやり直す" title={withShortcutLabels("やり直し（Ctrl+Y）")} className={button} disabled={!editable || !ink.canRedo || exporting} onClick={ink.entry?.redo}><Redo2 className="size-3.5" /></button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="書き込みのその他" title="表示・一覧・PDF保存" className={`${button} ml-auto`}>
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={() => editor.setVisible(!visible)}>{visible ? "書き込みを非表示" : "書き込みを表示"}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.setLocked(!locked)}>{locked ? "編集ロックを解除" : "編集をロック"}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.setListOpen(!editor.listOpen)}>書き込み一覧</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={ink.saving} onClick={() => void saveAll()}>保存を再試行</DropdownMenuItem>
          <DropdownMenuItem disabled={disabled || !ink.ready || exporting} title="ペンの書き込みと文章のハイライトを描き込んだPDFを保存します" onClick={() => ink.entry && void exportPdf(ink.entry.paperId, ink.entry.side)}><Download />{exporting ? "出力中…" : "書き込み付きPDFを保存"}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button aria-label="書き込みツールを閉じる" title="書き込みツールを閉じて本文選択に戻る" className={button} onClick={close}><X className="size-4" /></button>
    </div>
    {editable && (drawing || tool === "text" || (selected.length > 0 && styleOpen)) && <div className="flex flex-wrap items-center gap-1 border-t mt-1 pt-1" role="group" aria-label="書き込みの色と太さ">
      {drawing && <InkKindSelect editor={editor} />}
      <InkSwatches editor={editor} />
      <InkCustomColor editor={editor} />
      {tool !== "text" && <InkWidthSelect editor={editor} />}
      {tool === "highlighter" && <InkStraightOption editor={editor} />}
      {drawing && <InkFavorites editor={editor} />}
    </div>}
    {editable && tool === "eraser" && <div className="flex flex-wrap items-center gap-3 text-xs border-t mt-1 pt-1">
      <EraserSettings editor={editor} />
    </div>}
    {editable && selecting && <div className="flex flex-wrap items-center gap-1.5 border-t mt-1 pt-1 text-xs text-foreground" role="toolbar" aria-label="書き込みの選択操作">
      <SelectionActions editor={editor} onStickyNote={onStickyNote} styleOpen={styleOpen} setStyleOpen={setStyleOpen} />
    </div>}
    {editor.listOpen && ink.entry && <InkPageList paperId={ink.entry.paperId} onClose={() => editor.setListOpen(false)} />}
    {saveAlert}
  </div>);
}
