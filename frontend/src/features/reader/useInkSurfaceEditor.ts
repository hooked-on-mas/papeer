import { useEffect, useRef, useState } from 'react';
import { boundsOf, fitInk, transformInk, type InkStroke, type Point } from '../ink/inkGeometry';
import type { InkEditor, InkPreferences } from './inkEditor';
import { onScreen } from './navigation/pageTurn';
import { INK_TOOLBAR_SLOT } from './WritingToolbar';

export type InkSurfaceSource = {
  strokes: InkStroke[]; ready: boolean;
  change(strokes: InkStroke[]): void;
  undo?(): void; redo?(): void;
  /** Explicit history admission can remain available during a pending canonical save. */
  canUndo?: boolean; canRedo?: boolean;
  onDrawingChange?: InkEditor['onDrawingChange'];
  registerFinalizer?: InkEditor['registerFinalizer'];
  renderStroke?: InkEditor['renderStroke'];
  operations?: InkEditor['operations'];
  text?: InkEditor['text'];
  selection?: { ids: string[]; set(ids: string[]): void };
};
export type InkSurfaceTools = Pick<InkEditor, 'tool' | 'setTool' | 'lastPen' | 'lastShape' | 'lastRange' | 'listOpen' | 'setListOpen'> & {
  version: number; getVersion(): number;
};
export type InkSurfaceClipboard = { strokes: InkStroke[]; ratio: number; put(strokes: InkStroke[], ratio: number): void };
let activeEditor: symbol | null = null;

/** Surface operations borrow content, commands and preferences from their owner.
 * No store, save transport, account or journal is created by the drawing view. */
export function useInkSurfaceEditor({ source, tools, clipboard, preferences, pageKey, ratio, onCopied }: {
  source: InkSurfaceSource; tools: InkSurfaceTools; clipboard?: InkSurfaceClipboard;
  preferences: InkPreferences; pageKey: string; ratio: number; onCopied(): void;
}): InkEditor {
  const owner = useRef(Symbol('ink-pane'));
  const scopeRef = useRef<HTMLDivElement>(null);
  const beforeCommand = useRef<(() => void) | null>(null);
  const { tool, lastPen, lastShape, lastRange, version, listOpen, setListOpen } = tools;
  const [selectionState, setSelectionState] = useState<{ ids: string[]; version: number }>({ ids: [], version: 0 });
  const selectedIds = source.selection?.ids ?? (selectionState.version === version ? selectionState.ids : []);
  const setSelectedIds = (ids: string[]) => {
    if (source.selection) source.selection.set(ids);
    else setSelectionState({ ids, version: tools.getVersion() });
  };
  const setTool: InkEditor['setTool'] = next => {
    if (source.selection) source.selection.set([]);
    tools.setTool(next);
  };
  const [visible, setVisible] = useState(true), [locked, setLocked] = useState(false);
  const strokes = source.strokes;
  const selected = strokes.filter(stroke => selectedIds.includes(stroke.id));
  const selection = boundsOf(selected);
  useEffect(() => { if (!source.selection) setSelectedIds([]); }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only local selection follows page identity; controlled selection belongs to its owner
  const writable = source.ready && !locked && visible;
  const change = (value: InkStroke[]) => { if (writable) source.change(value); };
  const replaceSelected = (value: InkStroke[]) => {
    if (!writable || source.operations) return;
    const replacements = new Map(value.map(stroke => [stroke.id, stroke]));
    change(strokes.map(stroke => replacements.get(stroke.id) ?? stroke));
  };
  const transformSelected = (scale = 1, angle = 0, delta: Point = [0, 0]) => {
    if (!writable || !selection) return;
    const center: Point = [selection.x + selection.width / 2, selection.y + selection.height / 2];
    if (source.operations) {
      source.operations.commit({ type: 'transform', ids: selectedIds, center, scale, angle, delta }); return;
    }
    replaceSelected(fitInk(transformInk(selected, center, scale, angle, delta, ratio), ratio));
  };
  const remove = () => {
    if (!writable || !selectedIds.length) return;
    if (source.operations) {
      if (source.operations.commit({ type: 'delete', ids: selectedIds })) setSelectedIds([]);
    } else { change(strokes.filter(stroke => !selectedIds.includes(stroke.id))); setSelectedIds([]); }
  };
  const copy = () => {
    if (!writable || !selected.length) return;
    if (source.operations) source.operations.copy(selectedIds);
    else if (clipboard) clipboard.put(selected, ratio);
    else return;
    onCopied();
  };
  const cut = () => { if (writable && (source.operations || clipboard)) { copy(); remove(); } };
  const insert = (items: InkStroke[], sourceRatio: number) => {
    if (!items.length || !writable) return;
    const box = boundsOf(items)!;
    const converted = items.map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(([x, y]): Point =>
      [x + .025, box.y + (y - box.y) * sourceRatio / ratio + .025 / ratio]) }));
    const pasted = fitInk(converted, ratio);
    change([...strokes, ...pasted]); setTool('region'); setSelectedIds(pasted.map(stroke => stroke.id)); setVisible(true);
  };
  const paste = (duplicate = false) => {
    if (!writable) return;
    if (source.operations) {
      if (duplicate && !selectedIds.length) return;
      const ids = source.operations.paste(duplicate ? selectedIds : undefined);
      if (ids.length) { setTool('region'); setSelectedIds(ids); }
    } else if (duplicate) insert(selected, ratio);
    else if (clipboard) insert(clipboard.strokes, clipboard.ratio);
  };
  const hasClipboard = source.operations ? source.operations.hasClipboard : !!clipboard?.strokes.length;
  const style = (values: { color?: string; width?: number }) => {
    if (!writable) return;
    if (selected.length) {
      if (source.operations) source.operations.commit({ type: 'style', ids: selectedIds, ...values });
      else replaceSelected(selected.map(stroke => ({ ...stroke, ...values })));
      return;
    }
    if (tool === 'highlighter') preferences.change({ ...(values.color ? { highColor: values.color } : {}), ...(values.width ? { highWidth: values.width } : {}) });
    else preferences.change(values);
  };
  const keyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
    if (tool === 'capture') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTool('select'); }
      return;
    }
    const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    const history = command && tool !== 'select' && (key === 'z' || key === 'y')
      ? (key === 'y' || event.shiftKey ? 'redo' : 'undo') : undefined;
    const historyAllowed = history === 'undo' ? source.canUndo : history === 'redo' ? source.canRedo : undefined;
    if (history && historyAllowed !== undefined && !locked && visible) {
      if (historyAllowed && source[history]) {
        event.preventDefault(); event.stopPropagation(); beforeCommand.current?.(); source[history]?.();
      }
      return;
    }
    if (!source.ready || locked || !visible) return;
    let action: (() => void) | undefined;
    if (command && key === 'c' && selected.length) action = copy;
    if (command && key === 'x' && selected.length) action = cut;
    if (command && key === 'v' && hasClipboard && tool !== 'select') action = () => paste();
    if (command && key === 'a' && ['region', 'lasso'].includes(tool)) action = () => setSelectedIds(strokes.map(stroke => stroke.id));
    if (command && key === 'z' && tool !== 'select') action = event.shiftKey ? source.redo : source.undo;
    if (command && key === 'y' && tool !== 'select') action = source.redo;
    if ((key === 'delete' || key === 'backspace') && selected.length && !(event.target as HTMLElement).closest('[data-sticky-note]')) action = remove;
    if (key === 'escape' && tool !== 'select') action = () => { if (selectedIds.length) setSelectedIds([]); else setTool('select'); };
    if (selected.length && key.startsWith('arrow')) {
      const distance = event.shiftKey ? .01 : .001;
      const delta: Point = [key === 'arrowleft' ? -distance : key === 'arrowright' ? distance : 0,
        (key === 'arrowup' ? -distance : key === 'arrowdown' ? distance : 0) / ratio];
      action = () => transformSelected(1, 0, delta);
    }
    if (action) { event.preventDefault(); event.stopPropagation(); beforeCommand.current?.(); action(); }
  };
  const keyHandler = useRef(keyDown); keyHandler.current = keyDown;
  useEffect(() => {
    const self = owner.current;
    const listener = (event: KeyboardEvent) => {
      if (activeEditor !== self || !scopeRef.current || !onScreen(scopeRef.current)) return;
      const inToolbar = event.target instanceof Element && !!event.target.closest(`[${INK_TOOLBAR_SLOT}]`);
      if (event.target !== document.body && !scopeRef.current.contains(event.target as Node) && !inToolbar) return;
      keyHandler.current(event);
    };
    window.addEventListener('keydown', listener, true);
    return () => { window.removeEventListener('keydown', listener, true); if (activeEditor === self) activeEditor = null; };
  }, []);
  return { tool, setTool, lastPen, lastShape, lastRange, preferences, strokes, selected, selectedIds, setSelectedIds, selection,
    visible, setVisible, locked, setLocked, listOpen, setListOpen, change, replaceSelected, transformSelected, remove, copy, cut,
    paste: () => paste(), duplicate: () => paste(true), hasClipboard,
    style, scopeRef, beforeCommand, activate: () => { activeEditor = owner.current; }, deactivate: () => { activeEditor = null; },
    registerFinalizer: source.registerFinalizer, onDrawingChange: source.onDrawingChange, renderStroke: source.renderStroke,
    operations: source.operations, text: source.text,
    color: tool === 'highlighter' ? preferences.highColor : preferences.color, width: tool === 'highlighter' ? preferences.highWidth : preferences.width };
}
