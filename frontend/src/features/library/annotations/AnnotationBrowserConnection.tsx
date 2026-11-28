import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LibraryScopeBinding } from '../../reader/DocumentLibraryBinding';
import type { ContentNavigationSession } from '../../reader/navigation/ContentNavigationSession';
import { NoteAppendDialog } from '../../notes/append/NoteAppendDialog';
import type { NoteAppendSession } from '../../notes/append/NoteAppendSession';
import { AnnotationBrowserPanel } from './AnnotationBrowserPanel';
import { useWorkspaceFocusGuard } from '../../workspace/WorkspaceCommandContext';
import { appendAllowsFocusChange } from '../../notes/append/appendAllowsFocusChange';
import { AnnotationAppendHandoff } from './AnnotationAppendHandoff';

/** One scope-owned read model and one durable export request across all document switches. */
export function AnnotationBrowserConnection({ binding, navigation }: {
  binding: LibraryScopeBinding; navigation: ContentNavigationSession;
}) {
  const browser = useMemo(() => binding.sessions.getAnnotationBrowser(), [binding.sessions]);
  const library = useMemo(() => binding.sessions.getLibrary(), [binding.sessions]);
  const append = useMemo(() => binding.sessions.canAppendAnnotations ? binding.sessions.getAnnotationAppend() : null, [binding.sessions]);
  const handoff = useMemo(() => append ? new AnnotationAppendHandoff(append) : null, [append]);
  useWorkspaceFocusGuard('annotation-session', () => !append || appendAllowsFocusChange(append));
  const registry = useSyncExternalStore(binding.sessions.subscribe, binding.sessions.getSnapshot, binding.sessions.getSnapshot);
  const catalog = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const selected = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const replication = useSyncExternalStore(binding.replication.subscribe, binding.replication.getSnapshot, binding.replication.getSnapshot);
  const lifetime = useRef({ active: false, generation: 0 });
  const [resume, setResume] = useState(0);
  useLayoutEffect(() => {
    const current = lifetime.current;
    const show = (event?: PageTransitionEvent) => {
      if (event && !event.persisted) return;
      current.active = true; current.generation++; append?.setAvailable(true);
      if (event?.persisted) setResume(value => value + 1);
    };
    const hide = () => { current.active = false; current.generation++; browser.setAvailable(false); append?.setAvailable(false); };
    show(); window.addEventListener('pageshow', show); window.addEventListener('pagehide', hide);
    return () => { hide(); window.removeEventListener('pageshow', show); window.removeEventListener('pagehide', hide); };
  }, [browser, append]);
  useEffect(() => {
    const generation = lifetime.current.generation;
    const refresh = () => {
      const current = binding.sessions.getSnapshot();
      const active = lifetime.current.active && lifetime.current.generation === generation && current.ready && current.active;
      // Only use the catalog's explicitly accepted version. No new content writer is obtained here.
      const snapshot = library.getSelectedSnapshot();
      browser.setAvailable(active && !!snapshot);
      // Keep earlier rows visible, but never admit navigation/export against an unavailable catalog.
      if (!active || !snapshot) return;
      void browser.setCatalog(snapshot, navigation.getSnapshot().documentId);
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { window.clearInterval(timer); };
  }, [browser, library, binding.sessions, navigation, registry.ready, registry.active,
    catalog.ready, catalog.selectedVersion, selected.documentId, replication.running, resume]);
  return <>
    <AnnotationBrowserPanel session={browser} openLocation={location => {
      const current = library.getSnapshot();
      if (!current.ready || !current.selectedVersion) return Promise.resolve({ status: 'blocked' as const, reason: 'catalog-unavailable' });
      return navigation.openAnnotation(location, current.heads.length > 1 ? current.selectedVersion : null);
    }}
      unavailableReason={!registry.ready || !registry.active ? '資料の準備ができていないため、注釈の移動と書き出しは利用できません。'
        : !catalog.ready || !catalog.selectedVersion ? '資料一覧を確認できません。以前の結果を保持しています。資料一覧の版を確認するか、一覧を更新してください。' : undefined}
      refreshSources={async () => {
        const generation = lifetime.current.generation;
        if (!lifetime.current.active || !binding.sessions.getSnapshot().active) return;
        await library.refresh();
        if (!lifetime.current.active || lifetime.current.generation !== generation || !binding.sessions.getSnapshot().active) return;
        const snapshot = library.getSelectedSnapshot();
        browser.setAvailable(!!snapshot);
        if (!snapshot) return;
        browser.cancel(); await browser.setCatalog(snapshot, navigation.getSnapshot().documentId);
      }}
      appendUnavailableReason={append ? undefined : 'この接続では追記の復旧情報を保存できないため、ノートへの追加は利用できません。'}
      appendResults={async result => {
        if (!handoff || !lifetime.current.active) return false;
        const generation = lifetime.current.generation;
        return handoff.begin(result, () => lifetime.current.active && lifetime.current.generation === generation
          && binding.sessions.getSnapshot().active);
      }} />
    {append && handoff && <AnnotationAppendDialog session={append} handoff={handoff} navigation={navigation} />}
  </>;
}

function AnnotationAppendDialog({ session, handoff, navigation }: { session: NoteAppendSession; handoff: AnnotationAppendHandoff; navigation: ContentNavigationSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return <NoteAppendDialog append={{ state, canCancel: session.canCancel(),
    submit: id => { void session.submit(id); }, retry: () => { void session.retry(); },
    createAndSubmit: input => { void session.createAndSubmit(input); },
    cancel: () => { handoff.cancel(); }, dismiss: () => { session.dismiss(); },
    openTarget: () => {
      const current = session.getSnapshot();
      if (!current.destinationId) return;
      void navigation.openDocument(current.destinationId).then(result => {
        if ((result.status === 'applied' || result.status === 'unchanged') && current.phase === 'accepted'
          && session.getSnapshot().request?.id === current.request?.id) session.dismiss();
      });
    },
  }} />;
}
