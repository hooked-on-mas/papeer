import { useEffect, useSyncExternalStore } from 'react';
import { NoteEditSession } from './noteEditSession';

export function useNoteEditSession(session: NoteEditSession) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (!session.canLeave()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [session]);
  return state;
}
