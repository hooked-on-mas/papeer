import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StickyNote, ChevronDown, ClipboardPaste, Copy, Download, Eraser, MoreHorizontal, MousePointer2, PenLine, Redo2, Scan, Scissors, SquareDashed, Trash2, Type, Undo2, X } from "lucide-react";
import { apiRequest, authToken, backendUrl } from "@/api/client";
import { getPaper } from "@/api/hooks";
import { paperExportFilename } from "@/lib/exportFilename";
import { shell, tauriShell } from "@/shell";
import { useStore } from "@/store";
import { showError } from "@/components/errorDialog";
import { showSaved } from "@/app/savedNotice";
import { flushInkSaves, type InkSide } from "./inkStore";
import { useInkPanes, type InkEditor } from "./useInkEditor";
import { inkToolbarOpen } from "./readerBars";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import type { InkTool } from "./inkGeometry";
import { InkPageList } from "./InkPageList";

type Props = {
  editor: InkEditor; disabled: boolean; onStickyNote: (selection: boolean) => void;
  /** The pane this toolbar serves: it is shared by both, and follows the one last used. */
  side: InkSide;
  /** For the pane the toolbar doesn't serve: shows only a failed save, in that pane. */
  errorsOnly?: boolean;
  /**
   * Where to show the toolbar, shared by both panes (see Reader.tsx); null while it isn't there
   * yet, undefined to show it in place. Kept inside this component, so that moving the toolbar
   * keeps its state (a PDF being saved, a save error).
   */
  slot?: HTMLElement | null;
};
const colors = [["#dc2626", "赤"], ["#2563eb", "青"], ["#16a34a", "緑"], ["#18181b", "黒"], ["#facc15", "黄"]];
const SIDES = [["original", "原文"], ["translated", "訳文"]] as const;
// Tool labels show only when the bar is wide enough for all of them on one row (about 780px with
// them, 440px without, at 100%; in rem so that it follows the UI size, lib/uiScale.ts); the buttons
// keep their aria-label and title either way.
const toolLabel = "hidden @min-[50rem]:inline";

export function InkToolbar({ editor, disabled, onStickyNote, side, errorsOnly = false, slot }: Props) {
  const { ink, tool, setTool, lastPen, lastRange, color, width, preferences, selected, visible, locked } = editor;
  const barOpen = useStore(s => s.inkBarOpen);
  const hosts = useInkPanes(s => s.hosts);
  const editable = !disabled && !!ink.ready && visible && !locked;
  const [exporting, setExporting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [styleOpen, setStyleOpen] = useState(false);
  const drawing = ["pen", "highlighter", "line", "arrow", "rectangle", "ellipse"].includes(tool);
  const selecting = tool === "region" || tool === "lasso";
  const displayWidth = selected[0]?.width ?? width;
  const displayColor = selected[0]?.color ?? color;
  const widths = (selected.length ? selected.every(s => s.kind === "highlighter") : tool === "highlighter")
    ? [0.015, 0.025, 0.04] : [0.0015, 0.003, 0.006];
  const button = "h-7 px-1.5 rounded inline-flex items-center justify-center gap-1 text-xs hover:bg-muted disabled:opacity-40 disabled:pointer-events-none";
  const selectionButton = `${button} border bg-background whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;
  const exportPdf = async () => {
    if (!ink.entry) return;
    setExporting(true);
    try {
      const { paperId, side } = ink.entry;
      const paper = await getPaper(paperId);
      const name = paperExportFilename(paper, side === "original" ? "original-annotated" : "translated-annotated");
      const destination = shell === tauriShell ? await shell.saveFile(name, [{ name: "PDF", extensions: ["pdf"] }]) : null;
      if (shell === tauriShell && !destination) return;
      await flushInkSaves(paperId, side);
      const path = `/api/papers/${paperId}/ink-export`;
      if (destination) {
        await apiRequest("POST", path, { side, destination });
      } else {
        const response = await fetch(backendUrl(path), { method: "POST", headers: {
          "Content-Type": "application/json", Authorization: `Bearer ${authToken()}`,
        }, body: JSON.stringify({ side }) });
        if (!response.ok) throw new Error((await response.json()).detail ?? "PDFを保存できませんでした。");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      showSaved("書き込み付きPDFを保存しました", destination);
    } catch (error) { showError(error, "書き込み付きPDFを保存できませんでした"); }
    finally { setExporting(false); }
  };
  const saveAll = async () => {
    if (!ink.entry) return;
    setSaveError("");
    try {
      await ink.entry.load();
      await flushInkSaves(ink.entry.paperId, ink.entry.side);
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
  };
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
      <button aria-label="書き込みを元に戻す" title="元に戻す（Ctrl+Z）" className={button} disabled={!editable || !ink.canUndo || exporting} onClick={ink.entry?.undo}><Undo2 className="size-3.5" /></button>
      <button aria-label="書き込みをやり直す" title="やり直し（Ctrl+Y）" className={button} disabled={!editable || !ink.canRedo || exporting} onClick={ink.entry?.redo}><Redo2 className="size-3.5" /></button>
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
          <DropdownMenuItem disabled={disabled || !ink.ready || exporting} title="ペンの書き込みと文章のハイライトを描き込んだPDFを保存します" onClick={() => void exportPdf()}><Download />{exporting ? "出力中…" : "書き込み付きPDFを保存"}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button aria-label="書き込みツールを閉じる" title="書き込みツールを閉じて本文選択に戻る" className={button} onClick={close}><X className="size-4" /></button>
    </div>
    {editable && (drawing || tool === "text" || (selected.length > 0 && styleOpen)) && <div className="flex flex-wrap items-center gap-1 border-t mt-1 pt-1" role="group" aria-label="書き込みの色と太さ">
      {drawing && <select aria-label="描画の種類" className="h-7 border rounded bg-background text-xs" value={tool} onChange={e => setTool(e.target.value as InkTool)}>
        <option value="pen">ペン</option><option value="highlighter">蛍光ペン</option><option value="line">直線</option><option value="arrow">矢印</option><option value="rectangle">四角</option><option value="ellipse">丸</option>
      </select>}
      {colors.map(([value, label]) => <button key={value} title={label} aria-label={`${label}のペン`} aria-pressed={displayColor === value}
        onClick={() => editor.style({ color: value })} className={`w-5 h-5 rounded-full border-2 ${displayColor === value ? "border-foreground" : "border-transparent"} p-0.5`}><span className="block w-full h-full rounded-full" style={{ backgroundColor: value }} /></button>)}
      <input type="color" aria-label="任意の色" value={displayColor} onChange={e => editor.style({ color: e.target.value })} className="w-6 h-6 bg-transparent" />
      {tool !== "text" && <select aria-label="線の太さ" value={displayWidth} onChange={e => editor.style({ width: Number(e.target.value) })} className="h-6 border rounded bg-background text-xs">
        {widths.map((value, i) => <option key={value} value={value}>{["細", "中", "太"][i]}</option>)}
        {!widths.includes(displayWidth) && <option value={displayWidth}>カスタム</option>}
      </select>}
      {tool === "highlighter" && <label className="text-xs inline-flex gap-1"><input type="checkbox" checked={preferences.straight} onChange={e => preferences.change({ straight: e.target.checked })} />直線</label>}
      {drawing && <DropdownMenu><DropdownMenuTrigger className={button}>お気に入り<ChevronDown className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => preferences.change({ presets: [...preferences.presets.filter(p => p.color !== color || p.width !== width), { color, width }].slice(-8) })}>現在の設定を登録</DropdownMenuItem>
          {preferences.presets.map((preset, i) => <DropdownMenuItem key={i} onClick={() => editor.style(preset)}><span className="size-3 rounded-full" style={{ background: preset.color }} />設定 {i + 1}（{preset.width * 1000}）</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>}
    {editable && tool === "eraser" && <div className="flex flex-wrap items-center gap-3 text-xs border-t mt-1 pt-1">
      <label className="inline-flex items-center gap-1">大きさ
        <select aria-label="消しゴムの大きさ" value={preferences.eraserRadius} onChange={e => preferences.change({ eraserRadius: Number(e.target.value) })} className="h-7 border rounded bg-background text-xs">
          <option value={5}>小</option><option value={10}>中</option><option value={20}>大</option>
        </select>
      </label>
      <label title="線の触れた部分だけ消す（図形・テキストは全体）"><input type="checkbox" checked={preferences.partial} onChange={e => preferences.change({ partial: e.target.checked })} /> 部分消しゴム</label>
      <label title="蛍光ペン以外は残す"><input type="checkbox" checked={preferences.highlightOnly} onChange={e => preferences.change({ highlightOnly: e.target.checked })} /> 蛍光ペンだけ消す</label>
    </div>}
    {editable && selecting && <div className="flex flex-wrap items-center gap-1.5 border-t mt-1 pt-1 text-xs text-foreground" role="toolbar" aria-label="書き込みの選択操作">
      <select aria-label="書き込みの選び方" className="h-7 border rounded bg-background" value={tool} onChange={e => setTool(e.target.value as InkTool)}><option value="region">四角で選択</option><option value="lasso">投げ縄</option></select>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[0.75rem] text-muted-foreground whitespace-nowrap select-none">{selected.length ? `${selected.length}件選択` : "書き込みを囲んで選択"}</span>
      {selected.length > 0 && <>
        <button className={selectionButton} onClick={editor.copy} title="書き込みをコピー（Ctrl+C）"><Copy aria-hidden="true" className="size-3.5" />コピー</button>
        <button className={selectionButton} onClick={editor.cut} title="書き込みを切り取り（Ctrl+X）"><Scissors aria-hidden="true" className="size-3.5" />切り取り</button>
        <button className={`${selectionButton} text-destructive border-destructive/30 hover:bg-destructive/10`} onClick={editor.remove} title="選択した書き込みを削除（Delete）"><Trash2 aria-hidden="true" className="size-3.5" />削除</button>
      </>}
      {editor.hasClipboard && <button className={selectionButton} onClick={editor.paste} title="書き込みを貼り付け（Ctrl+V）"><ClipboardPaste aria-hidden="true" className="size-3.5" />貼り付け</button>}
      <DropdownMenu><DropdownMenuTrigger aria-label="書き込み選択のその他" title="その他の操作" className={`${selectionButton} ml-auto`}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => editor.setSelectedIds(editor.strokes.map(s => s.id))}>書き込みを全選択</DropdownMenuItem>
          <DropdownMenuItem disabled={!selected.length} onClick={() => setStyleOpen(!styleOpen)}>色・太さを変更</DropdownMenuItem>
          <DropdownMenuItem disabled={!selected.length} onClick={editor.duplicate}>複製</DropdownMenuItem>
          <DropdownMenuItem disabled={!selected.length} onClick={() => onStickyNote(true)}>選択した書き込みに付箋を貼る</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!selected.length} onClick={() => editor.transformSelected(0.9)}>縮小</DropdownMenuItem>
          <DropdownMenuItem disabled={!selected.length} onClick={() => editor.transformSelected(1.1)}>拡大</DropdownMenuItem>
          <DropdownMenuItem disabled={!selected.length} onClick={() => editor.transformSelected(1, -Math.PI / 12)}>左に15°回転</DropdownMenuItem>
          <DropdownMenuItem disabled={!selected.length} onClick={() => editor.transformSelected(1, Math.PI / 12)}>右に15°回転</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>}
    {editor.listOpen && ink.entry && <InkPageList paperId={ink.entry.paperId} onClose={() => editor.setListOpen(false)} />}
    {saveAlert}
  </div>);
}
