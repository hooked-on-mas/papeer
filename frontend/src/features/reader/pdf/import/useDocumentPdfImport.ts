import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Page } from '../../../../runtime/edits/contracts';
import type { DocumentLibraryBinding } from '../../DocumentLibraryBinding';
import type { DocumentEditSession } from '../../edit/DocumentEditSession';
import { DocumentPdfImportSession } from './DocumentPdfImportSession';

export function useDocumentPdfImport({ binding, document, page, active, inputBlocked, allowInsert }: {
  binding: DocumentLibraryBinding; document: DocumentEditSession; page: Page | null; active(): boolean; inputBlocked(): boolean; allowInsert: boolean;
}) {
  const providers = useRef({ active, inputBlocked }); providers.current = { active, inputBlocked };
  const mounted = useRef(false), [name, setName] = useState('');
  const session = useMemo(() => new DocumentPdfImportSession({ repository: binding.repository, document,
    active: () => mounted.current && providers.current.active(), inputBlocked: () => providers.current.inputBlocked(), makeId: () => crypto.randomUUID(), allowInsert }), [binding, document, allowInsert]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    mounted.current = true; session.activate(); const release = binding.sessions.registerScopeViewGuard(session.canLeave);
    const hide = () => { mounted.current = false; session.dispose(); }, show = () => { mounted.current = true; session.activate(); };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { mounted.current = false; session.dispose(); release(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, [binding.sessions, session]);
  const current = document.getSnapshot();
  return { state, name, available: active() && !!page && current.ready && !!current.document && current.selectedVersion === current.document.version && document.canNavigate(),
    stage(file: File) { if (!page) return Promise.resolve(false); setName(file.name); return session.stage(page, async () => {
      if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('notebook-pdf-size'); return new Uint8Array(await file.arrayBuffer());
    }); }, retry: session.retry, submit: (mode: 'insert' | 'insert-all' | 'replace', physical: number) => session.submit(mode, physical), cancel: () => session.cancel(), canLeave: session.canLeave };
}
export type DocumentPdfImportController = ReturnType<typeof useDocumentPdfImport>;
