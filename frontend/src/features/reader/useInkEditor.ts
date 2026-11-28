import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useInkPage, type InkSide } from './inkStore';
import { SHAPE_KINDS, type InkStroke, type InkTool } from '../ink/inkGeometry';
import { useStore } from '@/store';
import type { InkPreferences, PersistedInkEditor } from './inkEditor';
import { useNotebookPageInk } from '../notes/NotebookEditorContext';
import { useInkSurfaceEditor } from './useInkSurfaceEditor';

export const useInkPreferences = create<InkPreferences>()(persist(set => ({
  color: '#dc2626', width: .003, highColor: '#facc15', highWidth: .025, straight: true,
  partial: false, eraserRadius: 10, highlightOnly: false, fingerDraw: false, presets: [], change: values => set(values),
}), { name: 'papeer-ink-preferences' }));

const useInkClipboard = create<{ strokes: InkStroke[]; ratio: number; put: (strokes: InkStroke[], ratio: number) => void }>(set => ({
  strokes: [], ratio: 1, put: (strokes, ratio) => set({ strokes: structuredClone(strokes), ratio }),
}));

export const useInkTools = create<{
  tool: InkTool; lastPen: InkTool; lastShape: InkTool; lastRange: InkTool; version: number; listOpen: boolean;
  setTool: (tool: InkTool) => void; setListOpen: (open: boolean) => void;
}>(set => ({
  tool: 'select', lastPen: 'pen', lastShape: 'rectangle', lastRange: 'region', version: 0, listOpen: false,
  setListOpen: listOpen => set({ listOpen }),
  setTool: tool => set(state => ({ tool, version: state.version + 1,
    lastPen: ['pen', 'highlighter', ...SHAPE_KINDS].includes(tool) ? tool : state.lastPen,
    lastShape: SHAPE_KINDS.includes(tool) ? tool : state.lastShape,
    lastRange: tool === 'region' || tool === 'lasso' ? tool : state.lastRange,
  })),
}));

export { INK_TOOLBAR_SLOT } from './WritingToolbar';
export function inkToolActive(): boolean { return useInkTools.getState().tool !== 'select'; }

/** Existing host storage is adapted here; the surface owns no persistence. */
export function useInkEditor(paperId: string | undefined, side: InkSide, page: number, ratio: number, pageId?: string): PersistedInkEditor {
  const notebook = useNotebookPageInk(pageId);
  const pdf = useInkPage(notebook ? undefined : paperId, side, page);
  const ink = notebook ?? pdf;
  const preferences = useInkPreferences(), clipboard = useInkClipboard(), tools = useInkTools();
  const editor = useInkSurfaceEditor({
    source: { strokes: ink.strokes ?? [], ready: !!ink.ready, change: strokes => ink.entry?.change(strokes),
      undo: ink.entry?.undo, redo: ink.entry?.redo,
      onDrawingChange: notebook?.entry?.setDrawing, registerFinalizer: notebook?.entry?.registerFinalizer },
    preferences, clipboard, tools: { ...tools, getVersion: () => useInkTools.getState().version },
    pageKey: JSON.stringify([paperId, side, page]), ratio,
    onCopied: () => useStore.getState().setStatus('書き込みをコピーしました。別ページや原文・訳文側でも貼り付けられます。'),
  });
  return { ...editor, ink };
}
