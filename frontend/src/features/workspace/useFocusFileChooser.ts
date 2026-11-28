import { useCallback, useEffect, useRef } from 'react';
import { FileChooserHold } from './FileChooserHold';
import { useWorkspaceFocusBlocker } from './WorkspaceCommandContext';

/** Holds layout while a native file input or the selected-file preparation is active. */
export function useFocusFileChooser() {
  const input = useRef<HTMLInputElement>(null), hold = useRef(new FileChooserHold());
  useWorkspaceFocusBlocker(() => !hold.current.current());
  const cancel = useCallback(() => { const flight = hold.current, token = flight.current(); if (token) flight.end(token); }, []);
  const attach = useCallback((element: HTMLInputElement | null) => {
    input.current?.removeEventListener('cancel', cancel);
    input.current = element;
    element?.addEventListener('cancel', cancel);
  }, [cancel]);
  useEffect(() => {
    const flight = hold.current;
    const element = input.current;
    element?.removeEventListener('cancel', cancel);
    element?.addEventListener('cancel', cancel);
    return () => { flight.clear(); element?.removeEventListener('cancel', cancel); };
  }, [cancel]);
  return { attach, open: () => { try { input.current?.click(); } catch { hold.current.clear(); } }, begin: () => { hold.current.begin(); },
    selected: (operation?: Promise<unknown>) => {
      const token = hold.current.current() ?? hold.current.begin();
      if (!token) return;
      if (operation) void operation.then(() => hold.current.end(token), () => hold.current.end(token));
      else hold.current.end(token);
    } };
}
