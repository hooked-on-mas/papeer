import { useLayoutEffect, useRef } from 'react';
import type { NoteEditSession } from './noteEditSession';
import { useNoteEditSession } from './useNoteEditSession';

/** Only the current token can edit, release drawing ownership, or detach the active editor. */
export function useNoteEditorOwner(session: NoteEditSession) {
  const owner = useRef(Symbol('note-editor'));
  const state = useNoteEditSession(session);
  useLayoutEffect(() => {
    const token = owner.current;
    session.acquireEditor(token);
    return () => session.releaseEditor(token);
  }, [session]);
  useLayoutEffect(() => { if (!state.editorOwner) session.acquireEditor(owner.current); }, [session, state.editorOwner]);
  return { owner: owner.current, state, editable: state.editorOwner === owner.current && !state.editingBlocked };
}
