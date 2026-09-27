import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type Ref } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Sparkles, StickyNote as StickyIcon, Trash2 } from "lucide-react";
import { showError } from "@/components/errorDialog";
import { useStore } from "@/store";
import {
  HIGHLIGHT_COLORS, highlightAt, highlightColor, rectsBounds, selectionToolbarAllowed, toolbarPlacement,
  type Box, type HighlightColor,
} from "./highlights";
import {
  capturePassage, explainPassage, highlightPassage, quotePassageInNote, selectedRange, selectionTextBoxes,
  stickyNoteForPassage, type Passage,
} from "./readerPassage";
import { noteDraft, type StickyNote } from "./stickyNotes";
import { deleteStickyNote, openStickyNote, recolorHighlight, useStickyNotes } from "./stickyNotesStore";

type Target = { mode: "selection" } | { mode: "highlight"; id: number };

/** The toolbar's buttons: for a selection, or for a highlight clicked on the page. */
export function SelectionToolbarView({ mode, color, busy, style, toolbarRef, onColor, onExplain, onQuote, onSticky, onDelete }: {
  mode: Target["mode"];
  /** The highlight's colour, or the one last used for a selection. */
  color: HighlightColor;
  busy?: boolean;
  style?: CSSProperties;
  toolbarRef?: Ref<HTMLDivElement>;
  onColor: (color: HighlightColor) => void;
  onExplain: () => void;
  onQuote: () => void;
  onSticky: () => void;
  onDelete?: () => void;
}) {
  const button = "h-7 px-1.5 rounded inline-flex items-center gap-1 text-xs hover:bg-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring";
  // Pressing a button must not clear the selection it acts on.
  const keep = (event: MouseEvent) => event.preventDefault();
  return <div ref={toolbarRef} role="toolbar" aria-label={mode === "selection" ? "選択した文章" : "ハイライト"} data-selection-toolbar=""
    className="absolute z-30 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md" style={style}
    onMouseDown={keep}>
    <div role="group" aria-label={mode === "selection" ? "ハイライトする色" : "ハイライトの色"} className="flex items-center gap-0.5 px-0.5">
      {HIGHLIGHT_COLORS.map(({ id, label, rgb }) => <button key={id} type="button" disabled={busy}
        aria-label={mode === "selection" ? `ハイライト：${label}` : `色を${label}にする`} title={mode === "selection" ? `${label}でハイライト` : `${label}に変える`}
        aria-pressed={mode === "highlight" ? id === color : undefined}
        className={`size-6 rounded-full border-2 p-0.5 disabled:opacity-40 ${id === color ? "border-foreground/70" : "border-transparent"}`}
        onClick={() => onColor(id)}><span className="block size-full rounded-full" style={{ backgroundColor: `rgb(${rgb})` }} /></button>)}
    </div>
    <span className="mx-0.5 h-4 border-l" />
    <button type="button" className={button} disabled={busy} title="チャットでこの箇所を説明してもらう" onClick={onExplain}><Sparkles className="size-3.5" />説明</button>
    <button type="button" className={button} disabled={busy} title="メモに引用する（ページへのリンク付き）" onClick={onQuote}><NotebookPen className="size-3.5" />メモへ</button>
    <button type="button" className={button} disabled={busy} title={mode === "selection" ? "選択した文章に付箋を貼る" : "このハイライトにメモ（付箋）を書く"} onClick={onSticky}>
      <StickyIcon className="size-3.5" />付箋</button>
    {onDelete && <button type="button" className={button} disabled={busy} aria-label="ハイライトを削除" title="ハイライトを削除" onClick={onDelete}><Trash2 className="size-3.5" /></button>}
  </div>;
}

/** A highlight's text as a passage, to explain or quote it like a selection. */
function highlightPassageOf(item: StickyNote): Passage {
  return { paperId: item.paper_id, page: item.page, side: item.side, anchorY: item.anchor_y, offsets: null, rects: item.rects ?? [], text: Promise.resolve(item.quote) };
}

/**
 * The small toolbar over text selected in a pane (highlight colours, 説明, メモへ, 付箋), and over a
 * highlight clicked on the page (its colour, 説明, メモへ, its memo, 削除). Only in reading mode: a writing
 * tool or placing a sticky note uses the pointer for itself. Positioned within `frame`, the element around
 * the pane's scroller `container`.
 */
export function SelectionToolbar({ container, frame, translated, highlights, inkTool, placingNote }: {
  container: HTMLElement | null;
  frame: HTMLElement | null;
  translated: boolean;
  /** The highlights on the page shown, for clicks on them. */
  highlights: StickyNote[];
  /** A writing tool is chosen (see inkToolActive). */
  inkTool: boolean;
  placingNote: boolean;
}) {
  const client = useQueryClient();
  const [target, setTarget] = useState<Target | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  // Bumped when the pane scrolls or resizes, to place the toolbar again.
  const [layout, setLayout] = useState(0);
  const [busy, setBusy] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const lastColor = useStickyNotes(s => s.highlightColor);
  const highlight = target?.mode === "highlight" ? highlights.find(item => item.id === target.id) ?? null : null;
  const enabled = !inkTool && !placingNote;
  const live = useRef({ inkTool, placingNote, highlights });
  live.current = { inkTool, placingNote, highlights };

  useEffect(() => { if (!enabled) setTarget(null); }, [enabled]);
  // Deleted, or another page shown.
  useEffect(() => { if (target?.mode === "highlight" && !highlight) setTarget(null); }, [target, highlight]);

  useEffect(() => {
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Anywhere but on the toolbar itself: in the pane, the other pane, the side panel, a tab…
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && toolbarRef.current?.contains(event.target))) setTarget(null);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const element = event.target instanceof Element ? event.target : null;
      // Not the toolbar's own buttons, which leave the selection as it is.
      if (element?.closest("[data-sticky-note], [data-selection-toolbar], .annotationLayer a")) return;
      clearTimeout(timer);
      // Once the browser has updated the selection.
      timer = setTimeout(() => {
        const { inkTool: writing, placingNote: placing } = live.current;
        const range = selectedRange(container);
        if (range) {
          const text = window.getSelection()?.toString() ?? "";
          // Only text of the page's text layer, not a caption or message.
          if (selectionTextBoxes(range).length && selectionToolbarAllowed({ text, inkTool: writing, placingNote: placing })) {
            setTarget({ mode: "selection" });
          }
          return;
        }
        if (writing || placing) return;
        // A click, with nothing selected: on a highlight, its toolbar.
        const page = container.querySelector<HTMLElement>(".react-pdf__Page");
        const rect = page?.getBoundingClientRect();
        if (!page || !rect?.width || !element || !page.contains(element)) return;
        const hit = highlightAt(live.current.highlights, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
        if (hit) {
          setTarget({ mode: "highlight", id: hit.id });
          useStickyNotes.setState({ selectedId: hit.id });
        }
      }, 0);
    };
    const onSelectionChange = () => setTarget(current => current?.mode === "selection" && !selectedRange(container) ? null : current);
    const onLayout = () => setLayout(value => value + 1);
    const hide = () => setTarget(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setTarget(null); };
    document.addEventListener("pointerdown", onPointerDown, true);
    // On the document: a selection dragged out of the pane ends there.
    document.addEventListener("pointerup", onPointerUp);
    container.addEventListener("scroll", onLayout, { passive: true });
    container.addEventListener("contextmenu", hide);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    const observer = new ResizeObserver(onLayout);
    observer.observe(container);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("scroll", onLayout);
      container.removeEventListener("contextmenu", hide);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
    };
  }, [container]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!target || !frame || !container || !toolbar) { setPlacement(null); return; }
    const bounds = frame.getBoundingClientRect();
    let box: Box | null = null;
    if (target.mode === "selection") {
      const range = selectedRange(container);
      const boxes = range ? selectionTextBoxes(range) : [];
      if (boxes.length) {
        const left = Math.min(...boxes.map(b => b.left)), top = Math.min(...boxes.map(b => b.top));
        box = { left, top, width: Math.max(...boxes.map(b => b.left + b.width)) - left, height: Math.max(...boxes.map(b => b.top + b.height)) - top };
      }
    } else if (highlight) {
      const page = container.querySelector(".react-pdf__Page")?.getBoundingClientRect();
      const around = rectsBounds(highlight.rects);
      if (page && around) box = { left: page.left + around[0] * page.width, top: page.top + around[1] * page.height, width: around[2] * page.width, height: around[3] * page.height };
    }
    const size = toolbar.getBoundingClientRect();
    setPlacement(box && toolbarPlacement({ ...box, left: box.left - bounds.left, top: box.top - bounds.top }, bounds, size));
  }, [target, highlight, layout, frame, container]);

  if (!target || (target.mode === "highlight" && !highlight)) return null;
  const run = async (action: () => Promise<unknown>, hide = true) => {
    setBusy(true);
    try { await action(); if (hide) setTarget(null); }
    catch (error) { showError(error, "操作できませんでした"); }
    finally { setBusy(false); }
  };
  const passage = () => highlight ? highlightPassageOf(highlight) : capturePassage(container, translated);
  const withPassage = (action: (passage: Passage) => Promise<unknown>) => () => {
    const current = passage();
    if (current) void run(() => action(current));
  };
  const color = highlight ? highlightColor(highlight.color).id : lastColor;
  return <SelectionToolbarView mode={target.mode} color={color} busy={busy} toolbarRef={toolbarRef}
    // Measured while hidden, then placed.
    style={placement ? { left: placement.left, top: placement.top } : { left: 0, top: 0, visibility: "hidden" }}
    onColor={next => {
      if (highlight) { if (next !== color) void run(() => recolorHighlight(highlight, next, client), false); return; }
      const current = capturePassage(container, translated);
      if (current) void run(async () => { if (await highlightPassage(current, next, client)) window.getSelection()?.removeAllRanges(); });
    }}
    onExplain={withPassage(explainPassage)}
    onQuote={withPassage(quotePassageInNote)}
    onSticky={highlight ? () => { setTarget(null); void openStickyNote(noteDraft(highlight)); } : withPassage(stickyNoteForPassage)}
    onDelete={highlight ? () => void run(async () => {
      if (await deleteStickyNote(highlight, client)) useStore.getState().setStatus("ハイライトを削除しました。付箋タブの「削除を取り消す」で戻せます。");
    }) : undefined} />;
}
