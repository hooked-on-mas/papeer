import { useEffect, useState } from 'react';
import type { NoteEditSession } from './noteEditSession';

export function useLoadedNoteSession(id: string, load: (id: string) => Promise<NoteEditSession>, cached?: (id: string) => NoteEditSession | undefined) {
  const [loaded, setLoaded] = useState<{ id: string; session: NoteEditSession }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setError('');
    void load(id).then(session => { if (alive) setLoaded({ id, session }); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [id, load]);
  return { session: cached?.(id) ?? (loaded?.id === id ? loaded.session : undefined), error };
}
