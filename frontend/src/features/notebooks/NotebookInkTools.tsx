import { useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import { Eraser, Hand, Highlighter, PenLine, Redo2, Shapes, StickyNote, Type, Undo2, type LucideIcon } from "lucide-react";
import { withShortcutLabels } from "@/lib/platform";
import { SHAPE_KINDS, type InkTool } from "@/features/reader/inkGeometry";
import {
  EraserSettings, InkCustomColor, InkFavorites, InkShapeSelect, InkStraightOption, InkSwatches, InkWidthSelect, SelectionActions,
  useInkSaveRetry, type InkToolbarProps,
} from "@/features/reader/inkControls";
import { NotebookBarContext } from "./notebookBar";

type ToolId = "select" | "pen" | "highlighter" | "shape" | "text" | "eraser";

const toolButton = "size-7 shrink-0 rounded inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-ring";
const popup = "flex flex-wrap items-center gap-1.5 max-w-80 rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-lg outline-none origin-(--transform-origin) transition-[opacity,transform] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0";

/**
 * The notebook's writing tools, drawn into its toolbar (see NotebookToolbar) in place of the PDF's
 * InkToolbar: select, pen, highlighter, shapes, text, eraser and sticky note, the colours and width when
 * there is room beside them, and Undo and Redo. A tool's settings are in the popover that pressing the
 * tool again opens, so that the toolbar stays a single row whichever tool is picked.
 */
export function NotebookInkTools({ editor, disabled, onStickyNote, errorsOnly = false, slot }: InkToolbarProps) {
  const { ink, tool, setTool, lastRange, lastShape, selected, visible, locked } = editor;
  const { inlineStyle, historyInBar, setHistory, alertSlot } = useContext(NotebookBarContext);
  const editable = !disabled && !!ink.ready && visible && !locked;
  const { saveError, saveAll } = useInkSaveRetry(ink);
  // Without room for their buttons, Undo and Redo are in the toolbar's 「…」 menu, which acts through these.
  const entry = ink.entry, canUndo = editable && !!ink.canUndo, canRedo = editable && !!ink.canRedo;
  useEffect(() => {
    if (errorsOnly || historyInBar) { setHistory(null); return; }
    setHistory({ canUndo, canRedo, undo: () => entry?.undo(), redo: () => entry?.redo() });
    return () => setHistory(null);
  }, [errorsOnly, historyInBar, setHistory, entry, canUndo, canRedo]);
  const [styleOpen, setStyleOpen] = useState(false);
  const [openFor, setOpenFor] = useState<ToolId | null>(null);

  const drawing = ["pen", "highlighter", ...SHAPE_KINDS].includes(tool);
  const selecting = tool === "region" || tool === "lasso";
  const activeOf = (id: ToolId) => id === "select" ? selecting || tool === "select"
    : id === "shape" ? SHAPE_KINDS.includes(tool) : tool === id;
  const targetOf = (id: ToolId): InkTool => id === "select" ? lastRange : id === "shape" ? lastShape : id;
  // A popover left open for a tool that is no longer the one picked doesn't come back with it.
  if (openFor && !activeOf(openFor)) setOpenFor(null);

  const styleControls = (kind: "pen" | "highlighter" | "shape" | "text") => <>
    {kind === "shape" && <InkShapeSelect editor={editor} />}
    <InkSwatches editor={editor} />
    <InkCustomColor editor={editor} />
    {kind !== "text" && <InkWidthSelect editor={editor} />}
    {kind === "highlighter" && <InkStraightOption editor={editor} />}
    {kind !== "text" && <InkFavorites editor={editor} />}
  </>;
  const entries: { id: ToolId; label: string; hint: string; Icon: LucideIcon; content: ReactNode }[] = [
    { id: "select", label: "選択", hint: "選択（書き込みを囲んで選ぶ。Escで選択を解除）", Icon: Hand, content: <>
      <SelectionActions editor={editor} onStickyNote={onStickyNote} styleOpen={styleOpen} setStyleOpen={setStyleOpen} allowNone />
      {styleOpen && selected.length > 0 && <div className="flex basis-full flex-wrap items-center gap-1 border-t pt-1.5" role="group" aria-label="書き込みの色と太さ">{styleControls("pen")}</div>}
    </> },
    { id: "pen", label: "ペン", hint: "ペン", Icon: PenLine, content: styleControls("pen") },
    { id: "highlighter", label: "蛍光ペン", hint: "蛍光ペン", Icon: Highlighter, content: styleControls("highlighter") },
    { id: "shape", label: "図形", hint: "図形（直線・矢印・四角・丸）", Icon: Shapes, content: styleControls("shape") },
    { id: "text", label: "テキスト", hint: "テキスト", Icon: Type, content: styleControls("text") },
    { id: "eraser", label: "消しゴム", hint: "消しゴム", Icon: Eraser, content: <EraserSettings editor={editor} /> },
  ];

  const place = (node: ReactNode) => slot === undefined ? node : slot ? createPortal(node, slot) : null;
  const alertText = ink.error || saveError;
  const saveAlert = alertText && alertSlot && createPortal(
    <p role="alert" className="border-t bg-background px-3 py-1 text-xs text-destructive">
      {alertText}<button className="underline ml-1" onClick={() => void saveAll()}>再試行</button>
    </p>, alertSlot);
  if (errorsOnly) return saveAlert || null;

  const styleReady = editable && (drawing || tool === "text" || selected.length > 0);
  return <>
    {place(<>
      <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="書く道具">
        {entries.map(({ id, label, hint, Icon, content }) => {
          const active = activeOf(id);
          return <Popover.Root key={id} open={active && openFor === id} onOpenChange={(next) => {
            // The first press picks the tool; pressing the picked one again opens its settings.
            if (next && !active) { setTool(targetOf(id)); return; }
            setOpenFor(next ? id : null);
          }}>
            {/* Pressed or not says which tool is picked; the popover it opens is in the title, so that the
                button is not also read as expanded or collapsed. */}
            <Popover.Trigger aria-label={label} aria-pressed={active} aria-expanded={undefined} aria-haspopup={undefined} disabled={!editable}
              title={active ? `${hint}（もう一度押すと設定）` : hint}
              className={`${toolButton} ${active ? "bg-primary/10 text-primary" : ""}`}>
              <Icon className="size-4" aria-hidden="true" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
                <Popover.Popup className={popup}>{content}</Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>;
        })}
        <button aria-label="付箋" title="付箋を貼る（貼る場所をクリック）" disabled={disabled} className={toolButton} onClick={() => onStickyNote(false)}>
          <StickyNote className="size-4" aria-hidden="true" />
        </button>
      </div>
      {inlineStyle && <div role="group" aria-label="書き込みの色と太さ" className="ml-1 flex items-center gap-1 shrink-0">
        <InkSwatches editor={editor} disabled={!styleReady} />
        <InkWidthSelect editor={editor} disabled={!styleReady || tool === "text"} />
      </div>}
      {historyInBar && <>
        <span className="mx-1 h-4 shrink-0 border-l" />
        <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="元に戻す・やり直す">
          <button aria-label="書き込みを元に戻す" title={withShortcutLabels("元に戻す（Ctrl+Z）")} className={toolButton} disabled={!canUndo} onClick={ink.entry?.undo}><Undo2 className="size-4" aria-hidden="true" /></button>
          <button aria-label="書き込みをやり直す" title={withShortcutLabels("やり直し（Ctrl+Y）")} className={toolButton} disabled={!canRedo} onClick={ink.entry?.redo}><Redo2 className="size-4" aria-hidden="true" /></button>
        </div>
      </>}
    </>)}
    {saveAlert}
  </>;
}
