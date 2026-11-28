import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { ArrowLeft, ArrowLeftRight, ArrowRight, BookOpen, Maximize2, Minimize2, PanelLeft, PanelRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { WorkspaceHeader, WorkspaceRail, WorkspaceRoot, WorkspaceSidebar } from '../../components/WorkspaceChrome';
import { assertLibraryScopeBinding, type LibraryScopeBinding, type DocumentLibraryBinding } from './DocumentLibraryBinding';
import { ContentNavigationSession } from './navigation/ContentNavigationSession';
import { ContentNavigationContext, useContentNavigation } from './navigation/ContentNavigationContext';
import { LibraryCatalogPanel } from '../library/catalog/LibraryCatalogPanel';
import { AnnotationBrowserConnection } from '../library/annotations/AnnotationBrowserConnection';
import { resolveLibraryContentKind } from './libraryContentKind';
import { AttachmentLibraryView } from './AttachmentLibraryView';
import { WorkspaceCommandSession } from '../workspace/WorkspaceCommandSession';
import { WorkspaceCommandContext, useWorkspaceFocusGuard } from '../workspace/WorkspaceCommandContext';
import { WorkspaceSelectionSession } from '../workspace/WorkspaceSelectionSession';
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../workspace/WorkspaceSession';
import { WorkspacePreferencesProvider, WorkspaceSettings, useWorkspacePreferences } from '../workspace/WorkspacePreferences';
import { RelatedContentPanel } from '../workspace/related/RelatedContentPanel';

const emptySubscribe = () => () => {};

export type LibrarySwitcherProps = { label: string; onSwitch(): void; error?: boolean; extra?: ReactNode };

/** Resolve the stored content before obtaining its kind-specific editing authority. */
export function LibraryContentConnection(props: {
  binding: LibraryScopeBinding;
  navigation?: ContentNavigationSession;
  librarySwitcher?: LibrarySwitcherProps;
  renderDocument(binding: DocumentLibraryBinding): ReactNode;
  renderMarkdown(binding: DocumentLibraryBinding): ReactNode;
}) {
  assertLibraryScopeBinding(props.binding);
  props.navigation?.assertScope(props.binding.repository.scope);
  if (!props.navigation && !('documentId' in props.binding)) throw new Error('scope-navigation-required');
  const scope = props.binding.repository.scope;
  return <NavigableLibraryContent key={JSON.stringify([scope.accountId, scope.libraryId, scope.epoch])} {...props} />;
}

function NavigableLibraryContent(props: {
  binding: LibraryScopeBinding;
  navigation?: ContentNavigationSession;
  librarySwitcher?: LibrarySwitcherProps;
  renderDocument(binding: DocumentLibraryBinding): ReactNode;
  renderMarkdown(binding: DocumentLibraryBinding): ReactNode;
}) {
  const base = props.binding;
  // The injected target is a mount-time value; later selection belongs to navigation.
  const [initialDocumentId] = useState(() => 'documentId' in base ? (base as DocumentLibraryBinding).documentId : null);
  const { repository, sessions } = base, externalNavigation = props.navigation;
  const fallback = useMemo(() => externalNavigation ? null : new ContentNavigationSession({ repository,
    documentId: initialDocumentId,
    isActive: () => { const registry = sessions.getSnapshot(); return registry.ready && registry.active; } }),
  [externalNavigation, repository, sessions, initialDocumentId]);
  const navigation = props.navigation ?? fallback!;
  const commands = useMemo(() => {
    const library = sessions.getLibrary();
    return new WorkspaceCommandSession({ navigation, active: () => { const current = sessions.getSnapshot(); return current.ready && current.active; },
      validateTarget: target => {
        const snapshot = library.getSelectedSnapshot();
        return !!snapshot && !snapshot.deletions.some(d => d.active && d.itemIds.includes(target.id))
          && library.getSnapshot().items.some(item => item.id === target.id && item.kind === target.kind);
      },
      observe: listener => { const releases = [navigation.subscribe(listener), sessions.subscribe(listener), library.subscribe(listener)]; return () => releases.forEach(release => release()); },
      readiness: () => { const registry = sessions.getSnapshot(), catalog = library.getSnapshot();
        return JSON.stringify([registry.ready, registry.active, catalog.ready, catalog.selectedVersion, navigation.getSnapshot().documentId]); },
    });
  }, [navigation, sessions]);
  const selection = useMemo(() => base.selectionPreferences ? new WorkspaceSelectionSession(base.selectionPreferences, () => { const state = sessions.getSnapshot(); return state.ready && state.active; }) : null, [base.selectionPreferences, sessions]);
  useLayoutEffect(() => selection ? navigation.observeSelection(id => { selection.select({ documentId: id }); }, () => selection.invalidate()) : undefined, [navigation, selection]);
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const focused = useSyncExternalStore(commands.subscribeFocus, commands.getFocusSnapshot, commands.getFocusSnapshot);
  const panelOpen = useSyncExternalStore(commands.subscribeRelatedPanel, commands.getRelatedPanelSnapshot, commands.getRelatedPanelSnapshot);
  const focusOrigin = useRef<HTMLElement | null>(null), focusButton = useRef<HTMLButtonElement>(null);
  const panelButton = useRef<HTMLButtonElement>(null), panelRef = useRef<HTMLElement>(null);
  const [focusError, setFocusError] = useState(false);
  const [panelError, setPanelError] = useState(false);
  useEffect(() => {
    if (!focused) return;
    const changed = (event: FocusEvent) => { if (event.target !== focusButton.current) focusOrigin.current = null; };
    document.addEventListener('focusin', changed);
    return () => document.removeEventListener('focusin', changed);
  }, [focused]);
  // Readmission replaces private replication while the reader binding stays mounted.
  const binding = useMemo<DocumentLibraryBinding | null>(() => state.documentId === null ? null : ({ ...base, get replication() { return base.replication; }, documentId: state.documentId, catalogVersion: state.catalogVersion ?? undefined }),
    [base, state.documentId, state.catalogVersion]);
  useEffect(() => { void base.sessions.initialize(); }, [base.sessions]);
  useLayoutEffect(() => {
    const show = () => navigation.setAvailable(true), hide = () => navigation.setAvailable(false);
    show(); window.addEventListener('pageshow', show); window.addEventListener('pagehide', hide);
    return () => { hide(); window.removeEventListener('pageshow', show); window.removeEventListener('pagehide', hide); };
  }, [navigation]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (base.sessions.needsExitConfirmation()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [base.sessions]);
  return <WorkspacePreferencesProvider binding={base}><ContentNavigationContext.Provider value={navigation}><WorkspaceCommandContext.Provider value={commands}>
    <WorkspaceShell {...props} base={base} navigation={navigation} commands={commands} selection={selection}
      state={state} binding={binding} focused={focused} panelOpen={panelOpen}
      focusOrigin={focusOrigin} focusButton={focusButton} panelButton={panelButton} panelRef={panelRef}
      focusError={focusError} setFocusError={setFocusError} panelError={panelError} setPanelError={setPanelError} />
  </WorkspaceCommandContext.Provider></ContentNavigationContext.Provider></WorkspacePreferencesProvider>;
}

function WorkspaceShell({
  base, navigation, commands, selection, state, binding, focused, panelOpen,
  focusOrigin, focusButton, panelButton, panelRef,
  focusError, setFocusError, panelError, setPanelError,
  librarySwitcher, renderDocument, renderMarkdown,
}: {
  base: LibraryScopeBinding;
  navigation: ContentNavigationSession;
  commands: WorkspaceCommandSession;
  selection: WorkspaceSelectionSession | null;
  state: ReturnType<ContentNavigationSession['getSnapshot']>;
  binding: DocumentLibraryBinding | null;
  focused: boolean;
  panelOpen: boolean;
  focusOrigin: MutableRefObject<HTMLElement | null>;
  focusButton: RefObject<HTMLButtonElement | null>;
  panelButton: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  focusError: boolean;
  setFocusError(value: boolean): void;
  panelError: boolean;
  setPanelError(value: boolean): void;
  librarySwitcher?: LibrarySwitcherProps;
  renderDocument(binding: DocumentLibraryBinding): ReactNode;
  renderMarkdown(binding: DocumentLibraryBinding): ReactNode;
}) {
  const workspace = useWorkspacePreferences();
  const [fallbackOpen, setFallbackOpen] = useState(true);
  const catalogOpen = useSyncExternalStore(workspace?.subscribe ?? emptySubscribe,
    () => workspace?.getSnapshot().value.catalogOpen ?? fallbackOpen,
    () => workspace?.getSnapshot().value.catalogOpen ?? fallbackOpen);
  const setCatalogOpen = useCallback((next: boolean) => {
    if (workspace) workspace.set({ catalogOpen: next });
    else setFallbackOpen(next);
  }, [workspace]);
  const storedWidth = useSyncExternalStore(workspace?.subscribe ?? emptySubscribe,
    () => workspace?.getSnapshot().value.sidebarWidth ?? 280,
    () => workspace?.getSnapshot().value.sidebarWidth ?? 280);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const sidebarWidth = dragWidth ?? storedWidth;

  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 1023px)').matches : false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow) return;
    event.preventDefault();
    const startX = event.clientX, startW = sidebarWidth;
    let latest = startW;
    const move = (moveEvent: PointerEvent) => {
      latest = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(startW + moveEvent.clientX - startX)));
      setDragWidth(latest);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setDragWidth(null);
      workspace?.set({ sidebarWidth: latest });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const sidebarHidden = focused || !catalogOpen;
  const sidebarFooter = librarySwitcher ? (
    <div className="shrink-0 border-t bg-muted/30 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-muted-foreground" title={librarySwitcher.label}>{librarySwitcher.label}</span>
        <Button type="button" variant="ghost" size="xs" onClick={librarySwitcher.onSwitch}>
          <ArrowLeftRight className="size-3.5" />ライブラリを切り替える
        </Button>
      </div>
      {librarySwitcher.error && <p role="alert" className="mt-1 text-destructive">入力を確定または取り消し、保存を確認してから切り替えてください。</p>}
      {librarySwitcher.extra}
    </div>
  ) : undefined;

  return <WorkspaceRoot contained={!!librarySwitcher} className="relative" data-content-document={state.documentId} data-workspace-focus={focused}>
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {!sidebarHidden && narrow && (
        <button type="button" aria-label="資料一覧を閉じる" className="absolute inset-0 z-20 bg-black/40"
          onClick={() => setCatalogOpen(false)} />
      )}
      <aside id="workspace-catalog-chrome" hidden={sidebarHidden} inert={sidebarHidden}
        style={sidebarHidden ? { display: 'none' } : narrow ? undefined : { width: `${sidebarWidth}px` }}
        className={sidebarHidden ? 'hidden'
          : narrow ? 'absolute inset-y-0 left-0 z-30 flex w-[min(20rem,85vw)] flex-col border-r bg-sidebar shadow-xl'
          : 'flex h-full min-h-0 shrink-0 flex-col border-r bg-sidebar'}>
        <WorkspaceSidebar onCollapse={() => setCatalogOpen(false)} footer={sidebarFooter}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <LibraryCatalogPanel binding={base} navigation={navigation} selection={selection}
                onItemOpen={narrow ? () => setCatalogOpen(false) : undefined} />
            </div>
            <AnnotationBrowserConnection binding={base} navigation={navigation} />
          </div>
        </WorkspaceSidebar>
      </aside>
      {!sidebarHidden && !narrow && (
        <div role="separator" aria-orientation="vertical" aria-label="サイドバーの幅を調整"
          onPointerDown={startResize}
          className="w-1 shrink-0 cursor-col-resize bg-border/60 transition-colors hover:bg-primary/60" />
      )}
      {!focused && !narrow && !catalogOpen && <WorkspaceRail onExpand={() => setCatalogOpen(true)} />}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspaceHeader className={focused ? 'pointer-events-none h-0 border-0 p-0 overflow-visible' : 'h-11 gap-1.5 px-2'}>
          <div id="workspace-chrome" data-workspace-chrome hidden={focused} inert={focused}
            className={focused ? 'hidden' : 'flex min-w-0 flex-1 items-center gap-1.5'}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="資料一覧" aria-expanded={catalogOpen}
              aria-controls="workspace-catalog-chrome" title={catalogOpen ? '資料一覧を閉じる' : '資料一覧を開く'}
              onClick={() => setCatalogOpen(!catalogOpen)}>
              <PanelLeft className="size-4" />
            </Button>
            {state.back.length > 0 && (
              <Button type="button" variant="ghost" size="sm" aria-label="前の資料に戻る" title="前の資料に戻る"
                disabled={state.busy} onClick={() => { void navigation.back(); }}>
                <ArrowLeft className="size-4" /><span className="hidden md:inline">戻る</span>
              </Button>
            )}
            {state.forward.length > 0 && (
              <Button type="button" variant="ghost" size="sm" aria-label="次の資料に進む" title="次の資料に進む"
                disabled={state.busy} onClick={() => { void navigation.forward(); }}>
                <ArrowRight className="size-4" /><span className="hidden md:inline">進む</span>
              </Button>
            )}
            {state.busy && <span role="status" className="truncate text-xs text-muted-foreground">資料を開いています…</span>}
            {state.error && <p role="alert" className="truncate text-xs text-destructive">{state.error === 'current-blocked'
              ? '入力を確定または取り消し、保存を確認してから資料を変更してください。'
              : '引用先や資料を確認できません。現在の内容は保持しています。'}</p>}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <div className="relative">
                <Button ref={panelButton} type="button" variant="ghost" size="sm" aria-expanded={panelOpen}
                  aria-controls="workspace-related-panel"
                  aria-label={panelOpen ? '付属ノート・添付を閉じる' : '付属ノート・添付を開く'}
                  title={panelOpen ? '付属ノート・添付を閉じる' : '付属ノート・添付を開く'}
                  onClick={() => {
                    const hidingFocus = panelOpen && panelRef.current?.contains(document.activeElement);
                    if (!commands.setRelatedPanelOpen(!panelOpen)) { setPanelError(true); return; }
                    setPanelError(false);
                    if (hidingFocus) panelButton.current?.focus();
                  }}>
                  <PanelRight className="size-4" /><span className="hidden lg:inline">付属</span>
                </Button>
                {panelError && <p role="alert" className="pointer-events-none absolute right-0 top-full z-50 w-max max-w-[min(90vw,32rem)] rounded border bg-background p-2 text-xs shadow-md">操作を完了または取り消してから付属ノート・添付を切り替えてください。</p>}
              </div>
              <WorkspaceSettings />
            </div>
          </div>
          <div className={focused ? 'pointer-events-auto absolute right-3 top-2 z-40' : 'relative shrink-0'}>
            <Button ref={focusButton} type="button" variant={focused ? 'secondary' : 'ghost'} size="sm"
              className={focused ? 'border shadow-sm' : undefined}
              aria-pressed={focused} aria-controls="workspace-chrome workspace-catalog-chrome"
              aria-label={focused ? '集中表示を終了' : '集中表示'} title={focused ? '集中表示を終了' : '集中表示'}
              onPointerDown={() => { if (!focused && document.activeElement instanceof HTMLElement) focusOrigin.current = document.activeElement; }}
              onKeyDown={event => { if (!focused && (event.key === 'Enter' || event.key === ' ') && document.activeElement instanceof HTMLElement) focusOrigin.current = document.activeElement; }}
              onClick={() => {
                if (!commands.setFocusMode(!focused)) { setFocusError(true); return; }
                setFocusError(false);
                if (focused && document.activeElement === focusButton.current) {
                  const origin = focusOrigin.current;
                  queueMicrotask(() => { if (document.activeElement === focusButton.current && origin?.isConnected && origin.getClientRects().length && !origin.closest('[inert], [hidden]')) origin.focus(); });
                }
              }}>
              {focused ? <><Minimize2 className="size-4" /><span>集中表示を終了</span></> : <><Maximize2 className="size-4" /><span className="hidden lg:inline">集中表示</span></>}
            </Button>
            {focusError && <p role="alert" className="pointer-events-none absolute right-0 top-full z-50 w-max max-w-[min(90vw,32rem)] rounded border bg-background p-2 text-xs shadow-md">操作を完了または取り消してから集中表示を切り替えてください。</p>}
          </div>
        </WorkspaceHeader>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {binding ? <LibraryContentState key={binding.documentId} binding={binding} renderDocument={renderDocument} renderMarkdown={renderMarkdown} /> : <EmptyContent />}
          </div>
          <aside ref={panelRef} id="workspace-related-panel"
            className={focused || !panelOpen ? 'hidden' : 'w-[min(20rem,35%)] min-w-0 shrink-0'}
            hidden={focused || !panelOpen} inert={focused || !panelOpen}>
            <RelatedContentPanel binding={base} navigation={navigation} />
          </aside>
        </div>
      </div>
    </div>
  </WorkspaceRoot>;
}
function EmptyContent() {
  useWorkspaceFocusGuard('reader', () => true);
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
    <BookOpen className="size-10 opacity-30" />
    <p role="status" className="text-sm">資料を選択してください。</p>
  </div>;
}

function LibraryContentState({ binding, renderDocument, renderMarkdown }: {
  binding: DocumentLibraryBinding;
  renderDocument(binding: DocumentLibraryBinding): ReactNode;
  renderMarkdown(binding: DocumentLibraryBinding): ReactNode;
}) {
  const [kind, setKind] = useState<'document' | 'markdown' | 'attachment' | null>(null);
  // One logical read-only loader spans kind resolution and the Suspense chunk fallback.
  const loaderIdentity = useRef<object>({});
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const lifetime = useRef({ active: false, generation: 0 });
  const selected = useRef(kind); selected.current = kind;
  useLayoutEffect(() => {
    const current = lifetime.current;
    const show = (event?: PageTransitionEvent) => {
      if (event && !event.persisted) return;
      current.active = true; current.generation++;
      if (event?.persisted && !selected.current) setAttempt(value => value + 1);
    };
    const hide = () => { current.active = false; current.generation++; };
    show(); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { hide(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, []);
  useEffect(() => {
    let mounted = true;
    const generation = lifetime.current.generation;
    const alive = () => mounted && lifetime.current.active && generation === lifetime.current.generation;
    setError(''); setKind(null);
    void (async () => {
      try {
        await binding.sessions.initialize();
        if (!alive()) return;
        if (!binding.sessions.getSnapshot().ready) throw new Error('content-recovery-unavailable');
        const resolved = await resolveLibraryContentKind({ repository: binding.repository, documentId: binding.documentId,
          catalogVersion: binding.catalogVersion, refresh: () => binding.replication.flush(), alive });
        if (alive()) setKind(resolved);
      } catch { if (alive()) setError('資料を開けません。接続と保存データを確認して再試行してください。'); }
    })();
    return () => { mounted = false; };
  }, [binding, attempt]);
  if (kind === 'attachment') return <AttachmentLibraryView binding={binding} />;
  // Load the complete composition before its controller commits effects or claims an editor.
  if (kind) return <Suspense fallback={<ContentLoader documentId={binding.documentId} identity={loaderIdentity.current} />}>
    {kind === 'document' ? renderDocument(binding) : renderMarkdown(binding)}
  </Suspense>;
  return <ContentLoader documentId={binding.documentId} identity={loaderIdentity.current} error={error} retry={() => setAttempt(value => value + 1)} />;
}

/** No editing surface exists in this branch. Unmount releases this guard before a controller claims it. */
function ContentLoader({ documentId, identity, error, retry }: { documentId: string; identity: object; error?: string; retry?(): void }) {
  const { navigation } = useContentNavigation();
  useWorkspaceFocusGuard('reader', () => true);
  useLayoutEffect(() => navigation?.registerCurrent(documentId, {
    prepareClose: async () => true, canClose: () => true,
  }, error ? 'error' : 'loading', identity), [navigation, documentId, error, identity]);
  return error ? <div role="alert">{error}<button type="button" onClick={retry}>再試行</button></div>
    : <p role="status">資料を開いています…</p>;
}
