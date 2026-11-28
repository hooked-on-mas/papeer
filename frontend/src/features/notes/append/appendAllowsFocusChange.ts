import type { NoteAppendSession } from './NoteAppendSession';

/** Hidden canceled/idle requests may leave only when recovery has also settled. */
export function appendAllowsFocusChange(session: Pick<NoteAppendSession, 'getSnapshot' | 'canLeave'>): boolean {
  const state = session.getSnapshot();
  return session.canLeave() && !state.busy && !state.error
    && (!state.request || state.phase === 'idle' || state.phase === 'canceled');
}
