import { createContext, useContext, useMemo } from 'react';
import type { NoteEditSession, NoteEditState } from './noteEditSession';
import type { InkStroke } from '../ink/inkGeometry';

export const NotebookEditorContext = createContext<{ session: NoteEditSession; owner: symbol; editable: boolean; state: NoteEditState } | null>(null);

/** The PDF paper surface is a page view of the same document session as the side panel.
 * There is no page-specific snapshot, history, journal or save request here.
 */
export function useNotebookPageInk(pageId?: string) {
  const context = useContext(NotebookEditorContext);
  const state = context?.state;
  const entry = useMemo(() => context ? {
    paperId: context.session.getSnapshot().note.id, side: 'original' as const,
    load: async () => {}, save: context.session.flush,
    change: (strokes: InkStroke[]) => {
      const note = context.session.getSnapshot().note;
      if (!pageId || !note.document?.pages.some(page => page.id === pageId)) return;
      context.session.editFrom(context.owner, { ...note, ink: { ...note.ink, [pageId]: strokes } });
    },
    undo: () => context.session.undo(context.owner), redo: () => context.session.redo(context.owner),
    setDrawing: (drawing: boolean) => context.session.setDrawingFrom(context.owner, drawing),
    registerFinalizer: (finalize: () => void) => context.session.registerEditorFinalizer(context.owner, finalize),
  } : null, [context?.session, context?.owner, pageId]); // eslint-disable-line react-hooks/exhaustive-deps -- ownership is read live by the session
  if (!context || !state) return null;
  return { entry, strokes: state.note.ink?.[pageId ?? ''] ?? [], ready: context.editable && !state.editingBlocked && state.note.document?.revision === state.remote.document?.revision,
    dirty: state.pending, saving: state.saving, error: state.error, canUndo: state.canUndo, canRedo: state.canRedo };
}
