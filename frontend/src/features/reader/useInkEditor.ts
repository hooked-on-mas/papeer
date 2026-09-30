import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useInkPage, type InkSide } from "./inkStore";
import { boundsOf, fitInk, SHAPE_KINDS, transformInk, type InkStroke, type InkTool, type Point } from "./inkGeometry";
import { onScreen } from "./pageTurn";
import { useStore } from "@/store";

type Preset = { color: string; width: number };
type Preferences = {
  color: string; width: number; highColor: string; highWidth: number; straight: boolean;
  partial: boolean; eraserRadius: number; highlightOnly: boolean; presets: Preset[];
  change: (values: Partial<Omit<Preferences, "change">>) => void;
};
export const useInkPreferences = create<Preferences>()(persist(set => ({
  color: "#dc2626", width: 0.003, highColor: "#facc15", highWidth: 0.025, straight: true,
  partial: false, eraserRadius: 10, highlightOnly: false, presets: [], change: values => set(values),
}), { name: "papeer-ink-preferences" }));

const useInkClipboard = create<{ strokes: InkStroke[]; ratio: number; put: (strokes: InkStroke[], ratio: number) => void }>(set => ({
  strokes: [], ratio: 1, put: (strokes, ratio) => set({ strokes: structuredClone(strokes), ratio }),
}));

// Both panes share the active tool and the last subtype in each tool group, and the 書き込み一覧,
// which lists both sides' pages.
export const useInkTools = create<{
  tool: InkTool; lastPen: InkTool; lastRange: InkTool; version: number; listOpen: boolean;
  setTool: (tool: InkTool) => void;
  setListOpen: (open: boolean) => void;
}>(set => ({
  tool: "select", lastPen: "pen", lastRange: "region", version: 0, listOpen: false,
  setListOpen: listOpen => set({ listOpen }),
  setTool: tool => set(state => ({ tool, version: state.version + 1,
    lastPen: ["pen", "highlighter", ...SHAPE_KINDS].includes(tool) ? tool : state.lastPen,
    lastRange: tool === "region" || tool === "lasso" ? tool : state.lastRange,
  })),
}));
let activeEditor: symbol | null = null;

/** Marks where the writing toolbar is placed, outside either pane (see Reader.tsx). */
export const INK_TOOLBAR_SLOT = "data-ink-toolbar-slot";

/**
 * The one writing toolbar serves the pane last used (`active`), among those with a page to write on
 * (`hosts`); see inkToolbarSide.
 */
export const useInkPanes = create<{
  active: InkSide; hosts: Record<InkSide, boolean>;
  setActive: (side: InkSide) => void;
  setHost: (side: InkSide, host: boolean) => void;
}>(set => ({
  active: "original", hosts: { original: false, translated: false },
  setActive: active => set(state => state.active === active ? state : { active }),
  setHost: (side, host) => set(state => state.hosts[side] === host ? state : { hosts: { ...state.hosts, [side]: host } }),
}));

/** Whether a writing tool is chosen (pen, eraser, range selection…), rather than text selection. */
export function inkToolActive(): boolean {
  return useInkTools.getState().tool !== "select";
}

export function useInkEditor(paperId: string | undefined, side: InkSide, page: number, ratio: number) {
  const owner = useRef(Symbol("ink-pane"));
  const scopeRef = useRef<HTMLDivElement>(null);
  const beforeCommand = useRef<(() => void) | null>(null);
  const ink = useInkPage(paperId, side, page);
  const preferences = useInkPreferences();
  const clipboard = useInkClipboard();
  const { tool, setTool, lastPen, lastRange, version, listOpen, setListOpen } = useInkTools();
  const [selectionState, setSelectionState] = useState<{ ids: string[]; version: number }>({ ids: [], version: 0 });
  // Clear both panes on tool changes, while retaining a newly pasted/created selection.
  const selectedIds = selectionState.version === version ? selectionState.ids : [];
  const setSelectedIds = (ids: string[]) => setSelectionState({ ids, version: useInkTools.getState().version });
  const [visible, setVisible] = useState(true);
  const [locked, setLocked] = useState(false);
  const strokes = ink.strokes ?? [];
  const selected = strokes.filter(s => selectedIds.includes(s.id));
  const selection = boundsOf(selected);
  useEffect(() => { setSelectedIds([]); }, [paperId, side, page]);
  const change = (value: InkStroke[]) => { if (!locked && visible) ink.entry?.change(value); };
  const replaceSelected = (value: InkStroke[]) => {
    const replacements = new Map(value.map(s => [s.id, s]));
    change(strokes.map(s => replacements.get(s.id) ?? s));
  };
  const transformSelected = (scale = 1, angle = 0, delta: Point = [0, 0]) => {
    if (!selection) return;
    const center: Point = [selection.x + selection.width / 2, selection.y + selection.height / 2];
    replaceSelected(fitInk(transformInk(selected, center, scale, angle, delta, ratio), ratio));
  };
  const remove = () => { change(strokes.filter(s => !selectedIds.includes(s.id))); setSelectedIds([]); };
  const copy = () => {
    if (!selected.length) return;
    clipboard.put(selected, ratio);
    useStore.getState().setStatus("書き込みをコピーしました。別ページや原文・訳文側でも貼り付けられます。");
  };
  const cut = () => { copy(); remove(); };
  const insert = (items: InkStroke[], sourceRatio: number) => {
    if (!items.length || !ink.ready || locked) return;
    const b = boundsOf(items)!;
    const converted = items.map(s => ({ ...s, id: crypto.randomUUID(), points: s.points.map(([x, y]): Point => [x + 0.025, b.y + (y - b.y) * sourceRatio / ratio + 0.025 / ratio]) }));
    const pasted = fitInk(converted, ratio);
    change([...strokes, ...pasted]); setTool("region"); setSelectedIds(pasted.map(s => s.id)); setVisible(true);
  };
  const style = (values: { color?: string; width?: number }) => {
    // Restyling a selection leaves the pen's own settings alone.
    if (selected.length) { replaceSelected(selected.map(s => ({ ...s, ...values }))); return; }
    if (tool === "highlighter") preferences.change({ ...(values.color ? { highColor: values.color } : {}), ...(values.width ? { highWidth: values.width } : {}) });
    else preferences.change(values);
  };
  const keyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
    if (tool === "capture") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setTool("select"); }
      return;
    }
    if (!ink.ready || locked || !visible) return;
    const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    let action: (() => void) | undefined;
    if (command && key === "c" && selected.length) action = copy;
    if (command && key === "x" && selected.length) action = cut;
    if (command && key === "v" && clipboard.strokes.length && tool !== "select") action = () => insert(clipboard.strokes, clipboard.ratio);
    if (command && key === "a" && ["region", "lasso"].includes(tool)) action = () => setSelectedIds(strokes.map(s => s.id));
    if (command && key === "z" && tool !== "select") action = event.shiftKey ? ink.entry?.redo : ink.entry?.undo;
    if (command && key === "y" && tool !== "select") action = ink.entry?.redo;
    // A focused sticky note marker deletes itself rather than the ink selection.
    if ((key === "delete" || key === "backspace") && selected.length && !(event.target as HTMLElement).closest("[data-sticky-note]")) action = remove;
    if (key === "escape" && tool !== "select") action = () => { if (selectedIds.length) setSelectedIds([]); else setTool("select"); };
    if (selected.length && key.startsWith("arrow")) {
      const d = event.shiftKey ? 0.01 : 0.001;
      const delta: Point = [key === "arrowleft" ? -d : key === "arrowright" ? d : 0, (key === "arrowup" ? -d : key === "arrowdown" ? d : 0) / ratio];
      action = () => transformSelected(1, 0, delta);
    }
    if (action) { event.preventDefault(); event.stopPropagation(); beforeCommand.current?.(); action(); }
  };
  const keyHandler = useRef(keyDown);
  keyHandler.current = keyDown;
  useEffect(() => {
    const self = owner.current;
    const listener = (event: KeyboardEvent) => {
      // A clicked Cut/Delete button becomes disabled and loses focus to body.
      // Remember the active pane so Undo still works, without hijacking other panels.
      if (activeEditor !== self || !scopeRef.current) return;
      // Not while another tab is shown, where the reader stays mounted but hidden.
      if (!onScreen(scopeRef.current)) return;
      // The writing toolbar sits outside the pane, and serves the active one.
      const inToolbar = event.target instanceof Element && !!event.target.closest(`[${INK_TOOLBAR_SLOT}]`);
      if (event.target !== document.body && !scopeRef.current.contains(event.target as Node) && !inToolbar) return;
      keyHandler.current(event);
    };
    window.addEventListener("keydown", listener, true);
    return () => { window.removeEventListener("keydown", listener, true); if (activeEditor === self) activeEditor = null; };
  }, []);
  return { ink, tool, setTool, lastPen, lastRange, preferences, strokes, selected, selectedIds, setSelectedIds, selection, visible, setVisible, locked, setLocked,
    listOpen, setListOpen, change, replaceSelected, transformSelected, remove, copy, cut,
    paste: () => insert(clipboard.strokes, clipboard.ratio), duplicate: () => insert(selected, ratio), hasClipboard: !!clipboard.strokes.length,
    style, scopeRef, beforeCommand, activate: () => { activeEditor = owner.current; }, color: tool === "highlighter" ? preferences.highColor : preferences.color, width: tool === "highlighter" ? preferences.highWidth : preferences.width };
}
export type InkEditor = ReturnType<typeof useInkEditor>;
