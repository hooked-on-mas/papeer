import { useState } from "react";
import { ChevronDown, ClipboardPaste, Copy, MoreHorizontal, Scissors, Trash2 } from "lucide-react";
import { api, authToken, backendUrl, unwrap } from "@/api/client";
import { getPaper } from "@/api/hooks";
import { paperExportFilename } from "@/lib/exportFilename";
import { shell, tauriShell } from "@/shell";
import { showError } from "@/components/errorDialog";
import { showSaved } from "@/app/savedNotice";
import { withShortcutLabels } from "@/lib/platform";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { flushInkSaves, type InkSide } from "./inkStore";
import type { InkEditor } from "./useInkEditor";
import type { InkTool } from "./inkGeometry";

/**
 * The parts of the writing tools that the PDF's toolbar (InkToolbar) and the notebook's
 * (NotebookInkTools) are both made of: the colours and widths, the eraser's settings, what to do with a
 * selection, and saving the writing into a PDF.
 */

/** What either writing toolbar is given by the pane it serves (see PdfPane). */
export type InkToolbarProps = {
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

export const inkButton = "h-7 px-1.5 rounded inline-flex items-center justify-center gap-1 text-xs hover:bg-muted disabled:opacity-40 disabled:pointer-events-none";
export const inkSelectionButton = `${inkButton} border bg-background whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

export const INK_COLORS = [["#dc2626", "赤"], ["#2563eb", "青"], ["#16a34a", "緑"], ["#18181b", "黒"], ["#facc15", "黄"]];

/** Saving the writing again after a failed save, with the message of the failure that is left. */
export function useInkSaveRetry(ink: InkEditor["ink"]) {
  const [saveError, setSaveError] = useState("");
  const saveAll = async () => {
    if (!ink.entry) return;
    setSaveError("");
    try {
      await ink.entry.load();
      await flushInkSaves(ink.entry.paperId, ink.entry.side);
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
  };
  return { saveError, saveAll };
}

/**
 * Saving `side` of the paper as a PDF with the writing drawn into it: to a file picked in the app, or as
 * a download in the browser.
 */
export function useInkPdfExport() {
  const [exporting, setExporting] = useState(false);
  const exportPdf = async (paperId: string, side: InkSide) => {
    setExporting(true);
    try {
      const paper = await getPaper(paperId);
      const name = paperExportFilename(paper, side === "original" ? "original-annotated" : "translated-annotated");
      const destination = shell === tauriShell ? await shell.saveFile(name, [{ name: "PDF", extensions: ["pdf"] }]) : null;
      if (shell === tauriShell && !destination) return;
      await flushInkSaves(paperId, side);
      const path = `/api/papers/${paperId}/ink-export`;
      if (destination) {
        await unwrap(api.POST("/api/papers/{paper_id}/ink-export", { params: { path: { paper_id: paperId } }, body: { side, destination } }));
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
  return { exporting, exportPdf };
}

/** The colour and width the style controls show: the selection's, else the pen's. */
function styleOf(editor: InkEditor) {
  const { selected, tool, width, color } = editor;
  const displayWidth = selected[0]?.width ?? width;
  const displayColor = selected[0]?.color ?? color;
  const widths = (selected.length ? selected.every(s => s.kind === "highlighter") : tool === "highlighter")
    ? [0.015, 0.025, 0.04] : [0.0015, 0.003, 0.006];
  return { displayWidth, displayColor, widths };
}

/** The pen kinds: the select that switches between them. */
export function InkKindSelect({ editor }: { editor: InkEditor }) {
  return <select aria-label="描画の種類" className="h-7 border rounded bg-background text-xs" value={editor.tool} onChange={e => editor.setTool(e.target.value as InkTool)}>
    <option value="pen">ペン</option><option value="highlighter">蛍光ペン</option><option value="line">直線</option><option value="arrow">矢印</option><option value="rectangle">四角</option><option value="ellipse">丸</option>
  </select>;
}

/** The shapes only, for the notebook's 図形 button. */
export function InkShapeSelect({ editor }: { editor: InkEditor }) {
  return <select aria-label="図形の種類" className="h-7 border rounded bg-background text-xs" value={editor.tool} onChange={e => editor.setTool(e.target.value as InkTool)}>
    <option value="line">直線</option><option value="arrow">矢印</option><option value="rectangle">四角</option><option value="ellipse">丸</option>
  </select>;
}

export function InkSwatches({ editor, disabled = false }: { editor: InkEditor; disabled?: boolean }) {
  const { displayColor } = styleOf(editor);
  return <>{INK_COLORS.map(([value, label]) => <button key={value} title={label} aria-label={`${label}のペン`} aria-pressed={displayColor === value} disabled={disabled}
    onClick={() => editor.style({ color: value })} className={`w-5 h-5 shrink-0 rounded-full border-2 disabled:opacity-40 ${displayColor === value ? "border-foreground" : "border-transparent"} p-0.5`}><span className="block w-full h-full rounded-full" style={{ backgroundColor: value }} /></button>)}</>;
}

export function InkCustomColor({ editor }: { editor: InkEditor }) {
  const { displayColor } = styleOf(editor);
  return <input type="color" aria-label="任意の色" value={displayColor} onChange={e => editor.style({ color: e.target.value })} className="w-6 h-6 bg-transparent" />;
}

export function InkWidthSelect({ editor, disabled = false }: { editor: InkEditor; disabled?: boolean }) {
  const { displayWidth, widths } = styleOf(editor);
  return <select aria-label="線の太さ" value={displayWidth} disabled={disabled} onChange={e => editor.style({ width: Number(e.target.value) })} className="h-6 border rounded bg-background text-xs disabled:opacity-40">
    {widths.map((value, i) => <option key={value} value={value}>{["細", "中", "太"][i]}</option>)}
    {!widths.includes(displayWidth) && <option value={displayWidth}>カスタム</option>}
  </select>;
}

export function InkStraightOption({ editor }: { editor: InkEditor }) {
  const { preferences } = editor;
  return <label className="text-xs inline-flex gap-1"><input type="checkbox" checked={preferences.straight} onChange={e => preferences.change({ straight: e.target.checked })} />直線</label>;
}

export function InkFavorites({ editor }: { editor: InkEditor }) {
  const { preferences, color, width } = editor;
  return <DropdownMenu><DropdownMenuTrigger className={inkButton}>お気に入り<ChevronDown className="size-3" /></DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem onClick={() => preferences.change({ presets: [...preferences.presets.filter(p => p.color !== color || p.width !== width), { color, width }].slice(-8) })}>現在の設定を登録</DropdownMenuItem>
      {preferences.presets.map((preset, i) => <DropdownMenuItem key={i} onClick={() => editor.style(preset)}><span className="size-3 rounded-full" style={{ background: preset.color }} />設定 {i + 1}（{preset.width * 1000}）</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The eraser's settings, as the label-and-check items they are in a row. */
export function EraserSettings({ editor }: { editor: InkEditor }) {
  const { preferences } = editor;
  return <>
    <label className="inline-flex items-center gap-1">大きさ
      <select aria-label="消しゴムの大きさ" value={preferences.eraserRadius} onChange={e => preferences.change({ eraserRadius: Number(e.target.value) })} className="h-7 border rounded bg-background text-xs">
        <option value={5}>小</option><option value={10}>中</option><option value={20}>大</option>
      </select>
    </label>
    <label title="線の触れた部分だけ消す（図形・テキストは全体）"><input type="checkbox" checked={preferences.partial} onChange={e => preferences.change({ partial: e.target.checked })} /> 部分消しゴム</label>
    <label title="蛍光ペン以外は残す"><input type="checkbox" checked={preferences.highlightOnly} onChange={e => preferences.change({ highlightOnly: e.target.checked })} /> 蛍光ペンだけ消す</label>
  </>;
}

/** Copy, cut and delete for the selected writing, and paste when there is something to paste. */
export function SelectionButtons({ editor }: { editor: InkEditor }) {
  const { selected } = editor;
  return <>
    {selected.length > 0 && <>
      <button className={inkSelectionButton} onClick={editor.copy} title={withShortcutLabels("書き込みをコピー（Ctrl+C）")}><Copy aria-hidden="true" className="size-3.5" />コピー</button>
      <button className={inkSelectionButton} onClick={editor.cut} title={withShortcutLabels("書き込みを切り取り（Ctrl+X）")}><Scissors aria-hidden="true" className="size-3.5" />切り取り</button>
      <button className={`${inkSelectionButton} text-destructive border-destructive/30 hover:bg-destructive/10`} onClick={editor.remove} title={withShortcutLabels("選択した書き込みを削除（Delete）")}><Trash2 aria-hidden="true" className="size-3.5" />削除</button>
    </>}
    {editor.hasClipboard && <button className={inkSelectionButton} onClick={editor.paste} title={withShortcutLabels("書き込みを貼り付け（Ctrl+V）")}><ClipboardPaste aria-hidden="true" className="size-3.5" />貼り付け</button>}
  </>;
}

/**
 * What the selecting tools offer: how to select, the selection's size, the actions on it and the 「…」 menu
 * of more. `allowNone` adds choosing nothing (the tool that only scrolls) to the ways of selecting.
 */
export function SelectionActions({ editor, onStickyNote, styleOpen, setStyleOpen, allowNone = false }: {
  editor: InkEditor;
  onStickyNote: (selection: boolean) => void;
  styleOpen: boolean;
  setStyleOpen: (open: boolean) => void;
  allowNone?: boolean;
}) {
  const { tool, selected } = editor;
  const selecting = tool === "region" || tool === "lasso";
  return <>
    <select aria-label="書き込みの選び方" className="h-7 border rounded bg-background" value={tool} onChange={e => editor.setTool(e.target.value as InkTool)}>
      {allowNone && <option value="select">選択しない（スクロールのみ）</option>}
      <option value="region">四角で選択</option><option value="lasso">投げ縄</option>
    </select>
    {selecting && <span className="rounded-full bg-muted px-2 py-0.5 text-[0.75rem] text-muted-foreground whitespace-nowrap select-none">{selected.length ? `${selected.length}件選択` : "書き込みを囲んで選択"}</span>}
    <SelectionButtons editor={editor} />
    <DropdownMenu><DropdownMenuTrigger aria-label="書き込み選択のその他" title="その他の操作" className={`${inkSelectionButton} ml-auto`}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
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
  </>;
}
