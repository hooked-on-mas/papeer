import { useCallback, useState } from "react";

export type SessionState<T> = { session: string | null; value: T };

/**
 * The state for `session`: `state` itself while the session is the same; kept, but marked closed, when
 * the dialog closes (null); started over (`initial`) when it opens, or opens for another key.
 */
export function sessionStateFor<T>(state: SessionState<T>, session: string | null, initial: () => T): SessionState<T> {
  if (state.session === session) return state;
  return { session, value: session === null ? state.value : initial() };
}

/**
 * State that starts over each time a dialog opens (`session` becomes a key, such as the paper's id) or
 * opens for another key, and is kept while it is closed (null), so that it does not change during the
 * closing animation. Started over during the render, rather than in an effect after it, so that no
 * render (and no effect) sees the previous opening's state. An update made for an opening that has
 * since ended (a request answered after the dialog was closed and opened again) is dropped.
 */
export function useSessionState<T extends object>(session: string | null, initial: () => T):
  [T, (change: Partial<T> | ((state: T) => Partial<T>)) => void] {
  const [state, setState] = useState<SessionState<T>>(() => ({ session, value: initial() }));
  const current = sessionStateFor(state, session, initial);
  if (current !== state) setState(current);
  const update = useCallback((change: Partial<T> | ((state: T) => Partial<T>)) => setState((s) => s.session !== session ? s
    : { session, value: { ...s.value, ...(typeof change === "function" ? change(s.value) : change) } }), [session]);
  return [current.value, update];
}
