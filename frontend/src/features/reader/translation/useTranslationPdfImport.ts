import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DocumentLibraryBinding } from '../DocumentLibraryBinding';
import type { DocumentEditSession } from '../edit/DocumentEditSession';
import { TranslationPdfImportSession } from './TranslationPdfImportSession';

/** One UI attachment to the existing document authority; host storage remains injected. */
export function useTranslationPdfImport({ binding, document, active, inputBlocked }: {
  binding: DocumentLibraryBinding; document: DocumentEditSession; active(): boolean; inputBlocked(): boolean;
}) {
  const providers = useRef({ active, inputBlocked }); providers.current = { active, inputBlocked };
  const mounted = useRef(false), [name, setName] = useState('');
  const session = useMemo(() => new TranslationPdfImportSession({ repository: binding.repository, document,
    active: () => mounted.current && providers.current.active(), inputBlocked: () => providers.current.inputBlocked(), makeId: () => crypto.randomUUID() }), [binding, document]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    mounted.current = true; session.activate();
    const release = binding.sessions.registerScopeViewGuard(session.canLeave);
    const hide = () => { mounted.current = false; session.dispose(); }, show = () => { mounted.current = true; session.activate(); };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { mounted.current = false; session.dispose(); release(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, [binding.sessions, session]);
  // Raw pointer inventory changes outside React. Admission reads it synchronously;
  // the control's disabled state follows the subscribed document state instead.
  const current = document.getSnapshot();
  return { state, name, available: active() && current.ready && !!current.document
    && current.selectedVersion === current.document.version && document.canNavigate(),
    stage(file: File) { setName(file.name); return session.stage(async () => {
      if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('translation-import-size');
      return new Uint8Array(await file.arrayBuffer());
    }); },
    setMapping: (index: number, originalPageId: string | null) => session.setMapping(index, originalPageId),
    submit: () => session.submit(), retry: session.retry, cancel: () => { session.cancel(); }, canLeave: session.canLeave };
}
export type TranslationPdfImportController = ReturnType<typeof useTranslationPdfImport>;
