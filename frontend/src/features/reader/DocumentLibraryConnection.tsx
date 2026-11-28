import { startReplicationPolling } from '../library/replication/replicationPolling';
import { useDocumentPdfImport } from './pdf/import/useDocumentPdfImport';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Page, DocumentSnapshot, PageChange } from '../../runtime/edits/contracts';
import { EditGraph } from '../../runtime/edits/editGraph';
import { assertDocumentLibraryBinding, type DocumentLibraryBinding } from './DocumentLibraryBinding';
import { useDocumentInkEditor } from './ink/useDocumentInkEditor';
import { canonicalJson } from '../../runtime/edits/editModel';
import { pageExpectation } from '../../runtime/edits/documentPages';
import { notebookInsert, notebookDuplicate, notebookMove, notebookRemove, notebookApplyPaper } from '../notebooks/canonicalNotebookPages';
import { ReaderSession, type ReaderViewport } from './ReaderSession';
import { projectReferenceAnnotations, referenceTarget } from './reference/readerReference';
import { useDocumentReadingPlace } from './navigation/useDocumentReadingPlace';
import { useDocumentReferencePlace } from './reference/useDocumentReferencePlace';
import { useDocumentCompanionPlace } from './navigation/useDocumentCompanionPlace';
import { ReadingLanding } from './ReadingLanding';
import type { ReaderCommandPort } from './navigation/readerCommands';
import { useReaderInput } from './input/useReaderInput';
import type { CanonicalManagedInputBundle } from './input/canonicalManagedInput';
import { useWorkspaceEditor, useWorkspaceFocusGuard } from '../workspace/WorkspaceCommandContext';
import { appendAllowsFocusChange } from '../notes/append/appendAllowsFocusChange';
import { useContentNavigation } from './navigation/ContentNavigationContext';
import { resolveCitationLocation } from './navigation/citationLocation';
import { resolveAnnotationLocation } from './navigation/annotationLocation';
import { selectCanonicalPdfText } from './pdf/canonicalPdfSelection';
import { captureCanonicalPdfHighlight, canonicalPdfHighlightCaptureProblem } from './pdf/canonicalPdfHighlight';
import { canonicalPdfResourceBinding } from './pdf/canonicalPdfResource';
import { hasPdfPointerContact, hasOtherPdfPointerContact, getPdfPointerOwner, isPdfPointerDraining, consumeTerminalSwipe } from './input/usePdfPointerInput';
import type { PdfInkGestureReadPort } from './pdf/pdfTextGesture';
import { captureCanonicalPdf } from './pdf/canonicalPdfCapture';
import { useDocumentOutput } from './output/useDocumentOutput';
import { useTranslationPdfImport } from './translation/useTranslationPdfImport';
import { readerTranslationPages } from './readerSurfaceModel';
import type { CaptureBounds } from './pdf/canonicalPdfCapturePlan';
import { useLibraryItemDeleted, useLibraryItemTitle } from '../library/useLibraryItemTitle';
import type { AnnotationLocationRequest } from './navigation/annotationLocation';
import { useDocumentPdfAsset } from './useDocumentPdfAsset';
import type { DocumentLibraryView, DocumentSurfaceView, DocumentPdfSelectionController, DocumentPdfSelectionSurface } from './DocumentLibraryView';
export type { DocumentLibraryView, DocumentSurfaceView } from './DocumentLibraryView';

import { installHighlightDiagnostic, type HighlightDiagnostic, type HighlightSnapshot } from './highlightDiagnostics';

/** Both hosts use this authority and state transition path, supplying only their existing views. */
export function DocumentLibraryConnection({ binding, render }: { binding: DocumentLibraryBinding; render(view: DocumentLibraryView): ReactNode }) {
  assertDocumentLibraryBinding(binding);
  const scope = binding.repository.scope;
  return <DocumentLibraryState key={JSON.stringify([scope.accountId, scope.libraryId, scope.epoch, binding.documentId])} binding={binding} render={render} />;
}

function DocumentLibraryState({ binding, render }: { binding: DocumentLibraryBinding; render(view: DocumentLibraryView): ReactNode }) {
  const nativeGestureActive = useRef(false);
  const inputBundle = useMemo<CanonicalManagedInputBundle>(() => Object.freeze({ kind: 'canonical-managed' }), []);
  const session = useMemo(() => binding.sessions.get(binding.documentId), [binding]);
  const notebookImportGuard = useRef<() => boolean>(() => true);
  const append = useMemo(() => binding.sessions.getAppend(binding.documentId), [binding]);
  const appendState = useSyncExternalStore(append.subscribe, append.getSnapshot, append.getSnapshot);
  const [includeInk, setIncludeInk] = useState(true);
  const [pdfSearchHit, setPdfSearchHit] = useState<import('./pdf/pdfTextSearch').PdfSearchHit | null>(null);
  const registry = useSyncExternalStore(binding.sessions.subscribe, binding.sessions.getSnapshot, binding.sessions.getSnapshot);
  const replication = useSyncExternalStore(binding.replication.subscribe, binding.replication.getSnapshot, binding.replication.getSnapshot);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const settings = binding.inkSettings;
  const reposition = useRef<() => boolean>(() => false);
  const reader = useMemo(() => new ReaderSession({ scope: binding.repository.scope, documentId: binding.documentId,
    persistence: binding.readerState, canNavigate: () => session.canNavigate() && notebookImportGuard.current(), canReposition: () => notebookImportGuard.current() && (session.canNavigate() || reposition.current()) }), [binding, session]);
  const reading = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const zoom = reader.numericZoom, placement = reading.placement, landing = reading.landing;
  const [title, setTitle] = useState('文書'), [loadError, setLoadError] = useState('');
  const [initiallyDeleted, setInitiallyDeleted] = useState(false);
  const displayedTitle = useLibraryItemTitle(binding, title);
  const deleted = useLibraryItemDeleted(binding, initiallyDeleted);
  useLayoutEffect(() => { if (deleted) reader.invalidateReference('reference-document-deleted'); }, [deleted, reader]);
  const [kind, setKind] = useState<'pdf' | 'notebook'>('pdf');
  const [commandError, setCommandError] = useState('');
  const highlightEvidence = useRef<HighlightDiagnostic>({ attempts: 0, stage: 'idle', refusal: null, problem: null, draftCreated: null, selectionAdmitted: null });
  const [initialized, setInitialized] = useState(false);
  const [, resumeView] = useState(0);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0), [resourceAttempt, setResourceAttempt] = useState(0);
  const [annotationCandidate, setCandidateState] = useState<AnnotationLocationRequest | null>(null);
  const candidateRef = useRef<AnnotationLocationRequest | null>(null);
  const pdfSelections = useRef(new Map<'original' | 'translated', { instance: object; controller: DocumentPdfSelectionController; generation: number; pageId: string; revision: string }>());
  const setAnnotationCandidate = useCallback((value: AnnotationLocationRequest | null) => { candidateRef.current = value; setCandidateState(value); }, []);
  const annotationReady = useRef(new Map<string, number>());
  const reportAnnotationReady = useCallback((pageId: string, revision: string, ready: boolean, generation: number) => {
    if (!lifetime.current.active || lifetime.current.generation !== generation) return;
    const key = `${pageId}:${revision}`;
    if (ready) annotationReady.current.set(key, generation);
    else if (annotationReady.current.get(key) === generation) annotationReady.current.delete(key);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null), originalPaneRef = useRef<HTMLDivElement>(null), translatedPaneRef = useRef<HTMLDivElement>(null), referencePaneRef = useRef<HTMLDivElement>(null);
  const referenceScopeRef = useRef<HTMLDivElement>(null);
  const referenceLease = useMemo(() => ({ targetGeneration: reading.reference.targetGeneration, placement: reading.placement }), [reading.reference.targetGeneration, reading.placement]);
  const paneRef = reading.activeSurface === 'translated' ? translatedPaneRef : originalPaneRef;
  const lifetime = useRef({ active: false, generation: 0 });
  const initializedRef = useRef(initialized); initializedRef.current = initialized;
  const deletedRef = useRef(deleted); deletedRef.current = deleted;
  const output = useDocumentOutput({ binding, session, title: displayedTitle,
    active: () => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.isScopeWritable(),
    inputBlocked: () => nativeGestureActive.current || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current) });
  const translationImport = useTranslationPdfImport({ binding, document: session,
    active: () => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.isScopeWritable(),
    inputBlocked: () => nativeGestureActive.current || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current) || !append.canLeave() });
  const translationCanLeave = translationImport.canLeave;
  const { navigation, state: navigationState } = useContentNavigation();
  const citation = navigationState?.documentId === binding.documentId ? navigationState.citation : null;
  useLayoutEffect(() => {
    const current = lifetime.current;
    const show = (event?: PageTransitionEvent) => {
      if (event && !event.persisted) return;
      current.active = true; current.generation++;
      if (event?.persisted) resumeView(value => value + 1);
      if (event?.persisted && !initializedRef.current) setLoadAttempt(value => value + 1);
    };
    const hide = () => { current.active = false; current.generation++; annotationReady.current.clear(); pdfSelections.current.clear(); setAnnotationCandidate(null); };
    const pageHide = () => {
      hide();
      const pending = navigation?.getSnapshot().citation;
      if (pending?.annotation && pending.target.documentId === binding.documentId)
        navigation?.completeCitation(pending.id, 'annotation-request-stale');
    };
    show();
    // pagehide also covers reload/navigation where React never unmounts. Unlike
    // beforeunload it does not close a view after the user cancels leaving.
    window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', show);
    return () => { hide(); window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', show); };
  }, [navigation, binding.documentId, setAnnotationCandidate]);
  const draftPageId = Object.entries(state.surfaces).find(([, surface]) => surface.textDraft || surface.annotationDraft)?.[0];
  useLayoutEffect(() => { if (state.document) reader.reconcileDocument(state.document, draftPageId); }, [reader, state.document, draftPageId, state.phase, state.inputActive]);
  const pages = reader.documentModel?.pages ?? [];
  const translatedSearch = state.document ? readerTranslationPages(state.document) : new Map();
  const searchSource = reading.activeSurface === 'translated' ? pages.flatMap(original => {
    const mapped = translatedSearch.get(original.id); return mapped?.status === 'available' && mapped.page ? [mapped.page] : [];
  }) : pages;
  const searchSignature = canonicalJson(searchSource.map(value => [value.id, value.backgroundRevision, value.background, value.widthPt, value.heightPt]));
  // Annotation changes must not restart an in-flight read-only search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const searchPages = useMemo(() => structuredClone(searchSource), [searchSignature]);
  // Both main and reference project pending annotations over the same accepted structure.
  const displayedPage = (accepted: Page | null, pool: 'original' | 'translated') => accepted
    ? projectReferenceAnnotations(accepted, state.document, state.phase !== 'idle', pool) : null;
  const originalPage = displayedPage(reader.resolvePage('original'), 'original'), translatedPage = displayedPage(reader.resolvePage('translated'), 'translated');
  const referenceResolution = reader.resolveReference();
  const referencePage = referenceResolution.status === 'ready'
    ? displayedPage(referenceResolution.page, referenceResolution.target.pool) : null;
  const selectedIndex = pages.findIndex(value => value.id === reading.pageId);
  const displayedIndex = Math.max(0, selectedIndex);
  const navigationIds = reader.navigationPageIds;
  const navigationIndex = navigationIds.indexOf(reading.pageId);
  const canRetryFilter = reading.filterPending && reading.filterCandidateCount > 0;
  const canPrevious = canRetryFilter || (navigationIndex >= 0 ? navigationIndex > 0
    : navigationIds.some(id => pages.findIndex(value => value.id === id) < displayedIndex));
  const canNext = canRetryFilter || (navigationIndex >= 0 ? navigationIndex < navigationIds.length - 1
    : navigationIds.some(id => pages.findIndex(value => value.id === id) > displayedIndex));
  const page = reading.activeSurface === 'translated' ? translatedPage : originalPage;
  const notebookImport = useDocumentPdfImport({ binding, document: session, page: reading.activeSurface === 'original' ? page : null, allowInsert: kind === 'notebook',
    active: () => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.getSnapshot().active && binding.sessions.getSnapshot().ready,
    inputBlocked: () => nativeGestureActive.current || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current) || !append.canLeave() || !translationCanLeave() });
  notebookImportGuard.current = notebookImport.canLeave;
  const primaryPlace = useDocumentReadingPlace({ reader, paneRef, pageId: page?.id ?? '',
    surfaceKey: `${page?.id}:${page?.backgroundRevision}`, placement, landing });
  const referencePlace = useDocumentReferencePlace(reader, referencePaneRef, referenceLease,
    () => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.getSnapshot().active
      && binding.sessions.getSnapshot().ready && session.canNavigate() && append.canLeave() && !isPdfPointerDraining(rootRef.current));
  const companionPage = reading.activeSurface === 'translated' ? originalPage : translatedPage;
  const companionPlace = useDocumentCompanionPlace({ reader, reading, page: companionPage, activePage: page,
    activePaneRef: paneRef,
    paneRef: reading.activeSurface === 'translated' ? originalPaneRef : translatedPaneRef,
    enabled: reading.display === 'split', placement });
  const { viewportReady } = primaryPlace;
  const capturePrimary = primaryPlace.capturePlace, captureCompanion = companionPlace.capturePlace;
  const preparePrimaryZoom = primaryPlace.prepareZoom, prepareCompanionZoom = companionPlace.prepareZoom;
  const cancelPrimaryZoom = primaryPlace.cancelZoom, cancelCompanionZoom = companionPlace.cancelZoom;
  const capturePlace = useCallback(() => { capturePrimary(); captureCompanion(); }, [capturePrimary, captureCompanion]);
  const prepareZoom = useCallback((point?: { x: number; y: number }) => { preparePrimaryZoom(point); prepareCompanionZoom(point); }, [preparePrimaryZoom, prepareCompanionZoom]);
  const cancelZoom = useCallback(() => { cancelPrimaryZoom(); cancelCompanionZoom(); }, [cancelPrimaryZoom, cancelCompanionZoom]);
  const reportViewport = useCallback((metrics: ReaderViewport) => {
    if (page && reading.surfacePageId === page.id) viewportReady(metrics, `${page.id}:${page.backgroundRevision}`);
  }, [page, reading.surfacePageId, viewportReady]);
  const surfaceGeneration = lifetime.current.generation;
  const annotationLifetime = () => lifetime.current.active && lifetime.current.generation === surfaceGeneration && binding.sessions.getSnapshot().active;
  const originalInk = useDocumentInkEditor(session, originalPage?.id ?? '', settings, initialized && !deleted && reading.activeSurface === 'original', annotationLifetime,
    () => initializedRef.current && !deletedRef.current && reader.getSnapshot().activeSurface === 'original');
  const translatedInk = useDocumentInkEditor(session, translatedPage?.id ?? '', settings, initialized && !deleted && reading.activeSurface === 'translated', annotationLifetime,
    () => initializedRef.current && !deletedRef.current && reader.getSnapshot().activeSurface === 'translated');
  const ink = reading.activeSurface === 'translated' ? translatedInk : originalInk;
  const originalInkGestureRef = useRef<PdfInkGestureReadPort | null>(null), translatedInkGestureRef = useRef<PdfInkGestureReadPort | null>(null);
  const originalInkGesture = useMemo<PdfInkGestureReadPort>(() => ({ owns: id => originalInkGestureRef.current?.owns(id) === true,
    cancelTouch: id => originalInkGestureRef.current?.cancelTouch?.(id) === true }), []);
  const translatedInkGesture = useMemo<PdfInkGestureReadPort>(() => ({ owns: id => translatedInkGestureRef.current?.owns(id) === true,
    cancelTouch: id => translatedInkGestureRef.current?.cancelTouch?.(id) === true }), []);
  // Opaque view lifetime only. The writer's private token never leaves its hook.
  // Ordinary renders, settings changes and resize keep the raw-contact lifetime stable.
  const originalActive = reading.activeSurface === 'original', translatedActive = reading.activeSurface === 'translated';
  const originalPointerLifetime = useMemo(() => ({ lease: originalInk.ownerLease, generation: surfaceGeneration,
    pageId: originalPage?.id, revision: originalPage?.backgroundRevision }),
  [originalInk.ownerLease, surfaceGeneration, originalPage?.id, originalPage?.backgroundRevision]);
  const translatedPointerLifetime = useMemo(() => ({ lease: translatedInk.ownerLease, generation: surfaceGeneration,
    pageId: translatedPage?.id, revision: translatedPage?.backgroundRevision }),
  [translatedInk.ownerLease, surfaceGeneration, translatedPage?.id, translatedPage?.backgroundRevision]);
  const selectionMode = settings.getSnapshot().mode, selectionTool = settings.getSnapshot().tool;
  const originalSelectionLifetime = useMemo(() => ({ pointer: originalPointerLifetime, active: originalActive, mode: selectionMode, tool: selectionTool }), [originalPointerLifetime, originalActive, selectionMode, selectionTool]);
  const translatedSelectionLifetime = useMemo(() => ({ pointer: translatedPointerLifetime, active: translatedActive, mode: selectionMode, tool: selectionTool }), [translatedPointerLifetime, translatedActive, selectionMode, selectionTool]);
  const selectionOwners = useRef({ original: originalInk, translated: translatedInk });
  selectionOwners.current = { original: originalInk, translated: translatedInk };
  const selectionAvailable = (surface: 'original' | 'translated') => {
    const active = reader.getSnapshot(), owner = selectionOwners.current[surface], preferences = settings.getSnapshot();
    return initializedRef.current && lifetime.current.active && binding.sessions.getSnapshot().active
      && !isPdfPointerDraining(rootRef.current)
      && active.activeSurface === surface && active.surfacePageId === owner.page?.id
      && preferences.mode === 'ink' && preferences.tool === 'select' && owner.annotation.canSelectText();
  };
  const selectionAvailableRef = useRef(selectionAvailable); selectionAvailableRef.current = selectionAvailable;
  const registerPdfSelection = useCallback((surface: 'original' | 'translated', instance: object,
    controller: DocumentPdfSelectionController, generation: number, pageId: string, revision: string) => {
    const registration = { instance, controller, generation, pageId, revision };
    pdfSelections.current.set(surface, registration);
    return () => { if (pdfSelections.current.get(surface) === registration) pdfSelections.current.delete(surface); };
  }, []);
  const makeSelectionSurface = (surface: 'original' | 'translated', targetPage: Page | null): DocumentPdfSelectionSurface => ({
    managedTextSelection: surface === reading.activeSurface && selectionMode === 'ink' && selectionTool === 'select',
    lifetimeKey: surface === 'original' ? originalSelectionLifetime : translatedSelectionLifetime,
    readerRootRef: rootRef, paneRef: surface === 'original' ? originalPaneRef : translatedPaneRef,
    available: () => selectionAvailableRef.current(surface),
    register: (instance, controller) => registerPdfSelection(surface, instance, controller, surfaceGeneration, targetPage?.id ?? '', targetPage?.backgroundRevision ?? ''),
  });
  const originalSelection = makeSelectionSurface('original', originalPage), translatedSelection = makeSelectionSurface('translated', translatedPage);
  reposition.current = () => lifetime.current.active && registry.active && ink.annotation.canReposition();
  const activateEditor = ink.editor.activate;
  useLayoutEffect(() => { activateEditor(); }, [activateEditor, reading.activeSurface, page?.id]);
  const notebookCanLeave = notebookImport.canLeave;
  useWorkspaceFocusGuard('reader', () => lifetime.current.active && binding.sessions.getSnapshot().active
    && !nativeGestureActive.current && !hasPdfPointerContact(rootRef.current) && !isPdfPointerDraining(rootRef.current)
    && !session.getSnapshot().inputActive && appendAllowsFocusChange(append) && translationCanLeave() && notebookCanLeave() && output.canRelayout());
  useLayoutEffect(() => {
    if (!navigation) return;
    const canClose = () => lifetime.current.active && session.canNavigate() && translationCanLeave() && notebookCanLeave();
    return navigation.registerCurrent(binding.documentId, { canClose, prepareClose: async () => {
      reader.flush();
      // Navigation does not force a held pointer or text draft to complete.
      if (session.getSnapshot().inputActive || !translationCanLeave() || !notebookCanLeave()) return false;
      if (!session.getSnapshot().ready) return canClose();
      await session.retry(); return canClose();
    } });
  }, [navigation, binding.documentId, reader, session, translationCanLeave, notebookCanLeave]);
  useLayoutEffect(() => {
    if (!navigation || !citation || citation.annotation || !initialized || !state.ready || !state.document) return;
    if (!session.canNavigate()) { navigation.completeCitation(citation.id, 'current-blocked'); return; }
    const resolved = resolveCitationLocation(citation.target, { libraryId: binding.repository.scope.libraryId, document: state.document });
    if (resolved.status === 'unresolved') { navigation.completeCitation(citation.id, resolved.reason); return; }
    capturePlace();
    const result = reader.jumpSurface(citation.target.surface, resolved.page.id, resolved.place ?? undefined, citation.target.backgroundRevision);
    navigation.completeCitation(citation.id, result.status === 'blocked' ? result.reason : undefined);
  }, [navigation, citation, initialized, state.ready, state.document, session, reader, binding.repository.scope.libraryId, capturePlace]);
  useEffect(() => {
    if (!navigation || !citation?.annotation || !initialized) return;
    const request = citation.annotation, id = citation.id, generation = lifetime.current.generation;
    let mounted = true;
    const alive = () => mounted && lifetime.current.active && lifetime.current.generation === generation
      && binding.sessions.getSnapshot().ready && binding.sessions.getSnapshot().active
      && navigation.getSnapshot().citation?.id === id;
    void (async () => {
      try {
        if (!alive()) return;
        if (!session.canNavigate()) { navigation.completeCitation(id, 'current-blocked'); return; }
        capturePlace();
        // Same-document requests may name a newly arrived head missing from the retained controller.
        // Refresh before an explicit checkout; never reinterpret the request in the previously selected head.
        let refusal = 'annotation-source-unavailable';
        const refreshed = await session.refresh(request.version, (document, heads) => {
          if (!alive()) return false;
          if (!heads.includes(request.version)) { refusal = 'annotation-head-changed'; return false; }
          if (!document) return false;
          const location = resolveAnnotationLocation(request, { libraryId: binding.repository.scope.libraryId, document });
          if (location.status === 'unresolved') { refusal = location.reason; return false; }
          return true;
        });
        if (!alive()) return;
        if (!refreshed || !session.canNavigate()) {
          navigation.completeCitation(id, session.canNavigate() ? refusal : 'current-blocked'); return;
        }
        if (!session.getSnapshot().heads.includes(request.version) || !session.checkout(request.version)) {
          navigation.completeCitation(id, 'annotation-head-changed'); return;
        }
        const document = session.getSnapshot().document;
        if (!document) { navigation.completeCitation(id, 'annotation-source-unavailable'); return; }
        const resolved = resolveAnnotationLocation(request, { libraryId: binding.repository.scope.libraryId, document });
        if (resolved.status === 'unresolved') { navigation.completeCitation(id, resolved.reason); return; }
        if (!reader.reconcileDocument(document)) { navigation.completeCitation(id, 'current-blocked'); return; }
        const result = reader.jumpSurface(request.target.surface, resolved.page.id, resolved.place ?? undefined, request.target.backgroundRevision);
        if (result.status !== 'blocked') setAnnotationCandidate(structuredClone(request));
        navigation.completeCitation(id, result.status === 'blocked' ? result.reason : undefined);
      } catch { if (alive()) navigation.completeCitation(id, 'annotation-source-unavailable'); }
    })();
    return () => { mounted = false; };
  }, [navigation, citation, initialized, session, reader, binding.repository.scope.libraryId, binding.sessions, capturePlace, setAnnotationCandidate]);
  useEffect(() => {
    if (navigationState?.busy || navigationState?.citation || !registry.active || deleted) setAnnotationCandidate(null);
  }, [navigationState?.busy, navigationState?.citation, registry.active, deleted, setAnnotationCandidate]);
  const synchronizing = useRef<Promise<void> | undefined>(undefined);
  const synchronize = useCallback(() => {
    const current = session.getSnapshot(), surfaces = Object.values(current.surfaces);
    const annotationInput = surfaces.some(surface => !!surface.annotationDraft)
      || current.inputActive && settings.getSnapshot().mode === 'sticky-place' && surfaces.every(surface => !surface.textDraft);
    if (!initialized || !lifetime.current.active || !binding.sessions.getSnapshot().active
      || !session.canNavigate() && !annotationInput || binding.replication.getSnapshot().suspended) return Promise.resolve();
    if (synchronizing.current) return synchronizing.current;
    const generation = lifetime.current.generation;
    const alive = () => lifetime.current.active && lifetime.current.generation === generation && binding.sessions.getSnapshot().active;
    const work = Promise.resolve().then(async () => {
    if (!alive() || binding.replication.getSnapshot().suspended) return;
    try {
      await binding.replication.flush();
      if (!alive()) return;
      // Annotation input may receive immutable remote records without adopting them into its protected draft/base.
      // A location request owns its guarded read until it lands or refuses.
      // Keep immutable reception running, but do not supersede that read with
      // a background adoption that began before the request was installed.
      if (session.canNavigate() && !navigation?.getSnapshot().citation?.annotation) await session.refresh();
    } catch { /* Replication retains its error and durable outbox for retry. */ }
    if (!alive()) return;
    try {
      const pending = await binding.repository.pendingRecords();
      if (alive()) setPendingCount(pending.filter(record => record.batch.targetId === binding.documentId || record.publication?.content?.id === binding.documentId).length);
    } catch { if (alive()) setPendingCount(null); }
    });
    synchronizing.current = work;
    return work.finally(() => { if (synchronizing.current === work) synchronizing.current = undefined; });
  }, [binding, session, initialized, settings, navigation]);
  useEffect(() => {
    let mounted = true;
    const generation = lifetime.current.generation;
    const alive = () => mounted && lifetime.current.active && lifetime.current.generation === generation;
    setInitialized(false);
    void (async () => {
      try {
        await binding.sessions.initialize();
        if (!alive()) return;
        if (!binding.sessions.getSnapshot().ready) throw new Error('recovery-unavailable');
        // Read durable local content first; network availability cannot gate offline opening.
        if ((!session.getSnapshot().ready || session.canNavigate()) && !await session.refresh() && !session.getSnapshot().ready) {
          if (!alive()) return;
          await binding.replication.flush();
          if (!alive()) return;
          if (!await session.refresh()) throw new Error('document-unavailable');
        }
        if (!alive()) return;
        const library = await binding.repository.read(binding.repository.scope.libraryId);
        if (!alive()) return;
        const graph = new EditGraph(library.checkpoint);
        const catalogVersion = binding.catalogVersion ?? (library.heads.length === 1 ? library.heads[0] : undefined);
        const current = catalogVersion && library.heads.includes(catalogVersion) ? graph.snapshot(catalogVersion) : undefined;
        if (current?.kind !== 'library') throw new Error('library-unavailable');
        const item = current.items.find(item => item.id === binding.documentId);
        if (!item || (item.kind !== 'pdf' && item.kind !== 'notebook')) throw new Error('document-item-unavailable');
        if (alive()) { setInitiallyDeleted(current.deletions.some(record => record.active && record.itemIds.includes(binding.documentId))); setTitle(item.title); setKind(item.kind); setLoadError(''); setInitialized(true); }
      } catch { if (alive()) setLoadError('文書を開けません。接続と保存データを確認して再試行してください。'); }
    })();
    return () => { mounted = false; };
  }, [binding, session, loadAttempt]);
  useEffect(() => {
    if (!registry.ready || !state.ready || state.phase !== 'idle' || state.inputActive) return;
    void synchronize();
  }, [registry.ready, state.ready, state.phase, state.inputActive, state.document?.version, synchronize]);
  useEffect(() => {
    return startReplicationPolling(() => binding.replication.getSnapshot().running, synchronize);
  }, [synchronize, session, binding]);
  const originalAsset = useDocumentPdfAsset(binding.repository, originalPage, resourceAttempt);
  const translatedAsset = useDocumentPdfAsset(binding.repository, translatedPage, resourceAttempt);
  const [referenceAttempt, setReferenceAttempt] = useState(0);
  const referenceAsset = useDocumentPdfAsset(binding.repository, referencePage, referenceAttempt);
  const asset = reading.activeSurface === 'translated' ? translatedAsset : originalAsset;
  const selectionAssets = useRef({ original: originalAsset.asset, translated: translatedAsset.asset });
  selectionAssets.current = { original: originalAsset.asset, translated: translatedAsset.asset };
  const assetError = originalAsset.error || translatedAsset.error;
  const retryAsset = () => setResourceAttempt(value => value + 1);
  const cancelAnnotationLanding = () => {
    setAnnotationCandidate(null);
    const pending = navigation?.getSnapshot().citation;
    if (pending?.annotation) navigation?.completeCitation(pending.id);
  };
  const changeZoom = (value: number, keepPlace = false) => {
    if (session.canNavigate()) cancelAnnotationLanding();
    if (keepPlace) prepareZoom();
    if (!reader.setZoom(value === 0 ? { kind: 'fit-page' } : { kind: 'scale', value }) && keepPlace) cancelZoom();
  };
  const changeReaderSurface = (change: () => { status: string; reason?: string }, admittedPointer = false) => {
    if (!initialized || !lifetime.current.active || !session.canNavigate() || isPdfPointerDraining(rootRef.current)
      || !admittedPointer && hasPdfPointerContact(rootRef.current)) return false;
    cancelAnnotationLanding();
    capturePlace();
    const result = change();
    if (result.status === 'blocked') { setCommandError('入力・保存状態と訳文の対応を確認してください。'); return false; }
    setCommandError(''); return true;
  };
  const commands: ReaderCommandPort = {
    getSnapshot: () => ({ active: session.getSnapshot().ready, blocked: !session.canNavigate(), zoom: reader.numericZoom,
      actualZoom: reader.actualZoom, minimumZoom: reader.minimumZoom }),
    dispatch(command) {
      if (!session.canNavigate() || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current)) return { status: 'blocked' };
      cancelAnnotationLanding();
      let changed = false;
      if (command.type === 'zoom' || command.type === 'zoom-step' || command.type === 'zoom-reset') prepareZoom(command.type === 'zoom' ? command.anchor : undefined);
      if (command.type === 'zoom') changed = reader.setZoom(command.value === 0 ? { kind: 'fit-page' } : { kind: 'scale', value: command.value });
      else if (command.type === 'zoom-step') changed = reader.zoomBy(command.steps);
      else if (command.type === 'zoom-reset') changed = reader.setZoom({ kind: 'fit-page' });
      else if (command.type === 'focus-page-input') { rootRef.current?.querySelector<HTMLInputElement>('#page-input')?.focus(); changed = true; }
      else {
        capturePlace();
        if (command.type === 'step') changed = reader.step(command.amount, command.toEnd);
        else if (command.type === 'history') changed = reader.history(command.direction);
        else {
          if (command.type === 'edge') return { status: (command.edge === 'first' ? reader.first() : reader.last()) ? 'applied' : 'unchanged' };
          return reader.jumpLogicalPage(command.page, command.toEnd);
        }
      }
      if (!changed && (command.type === 'zoom' || command.type === 'zoom-step' || command.type === 'zoom-reset')) cancelZoom();
      return { status: changed ? 'applied' : 'unchanged' };
    },
  };
  useReaderInput({ inputBundle, rootRef, panes: [paneRef, referencePaneRef], wheelTurns: () => settings.getSnapshot().tool === 'select', resetKey: binding.documentId, commands,
    referenceInput: { paneRef: referencePaneRef, resolve: referencePlace.resolvePort }, nativeGestureActive: active => { nativeGestureActive.current = active; },
    pointerContacts: { hasContact: () => hasPdfPointerContact(rootRef.current) },
    selectionKeyPort: { handleKey: event => pdfSelections.current.get(reader.getSnapshot().activeSurface)?.controller.selectionKeyPort.handleKey(event) ?? 'pass' } });
  const retry = () => {
    setCommandError(''); reader.flush();
    if (assetError) setResourceAttempt(value => value + 1);
    if (loadError) setLoadAttempt(value => value + 1);
    void session.retry().then(synchronize).catch(() => setLoadError('保存を再試行できませんでした。内容は保持しています。'));
  };
  const status = !state.ready ? '読み込み中…' : state.phase === 'saving' ? '保存中…'
    : state.phase !== 'idle' ? '未保存の変更があります' : deleted ? 'この資料は削除されています（閲覧のみ）' : replication.suspended ? '端末保存済み・同期停止中（未送信の変更は保持されます）' : replication.error ? '端末保存済み・送信を再試行できます'
      : pendingCount === null || replication.running ? '端末保存済み・送信状態を確認中' : pendingCount ? '端末保存済み・未送信' : '送信済み';
  const runDocumentChange = async (build: (document: DocumentSnapshot, batchId: string) => PageChange[], selectId?: string, report = true) => {
    if (!initialized || deleted || kind !== 'notebook' || !lifetime.current.active) return { status: 'refused', reason: 'notebook-unavailable' } as const;
    setCommandError('');
    const result = await session.buildDocumentEdit(build);
    if (!lifetime.current.active) return result;
    if (result.status === 'refused' && report) setCommandError('ページを変更できません。入力・保存状態を確認してください。');
    if (result.status === 'applied' && selectId && session.canNavigate()) {
      const document = session.getSnapshot().document;
      if (document) reader.reconcileDocument(document);
      reader.jump(selectId);
    }
    return result;
  };
  const moveEditor = async (target: 'center' | 'right', stillCurrent: () => boolean = () => true) => {
    if (!stillCurrent() || !binding.sessions.isScopeWritable()) return false;
    if (target === placement) return true;
    if (!initialized || !lifetime.current.active || nativeGestureActive.current || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current)) return false;
    const generation = lifetime.current.generation;
    capturePlace();
    if (ink.annotation.draft) {
      if (!ink.annotation.canReposition() || !stillCurrent() || !binding.sessions.isScopeWritable() || !lifetime.current.active || deletedRef.current) return false;
      setCommandError(''); return reader.setPlacement(target);
    }
    ink.finalize();
    await session.retry();
    if (!stillCurrent() || !initializedRef.current || !lifetime.current.active || lifetime.current.generation !== generation
      || !binding.sessions.getSnapshot().active || !binding.sessions.isScopeWritable() || deletedRef.current) return false;
    if (!session.getSnapshot().ready && session.canNavigate()) await session.refresh();
    if (!initializedRef.current || !lifetime.current.active || lifetime.current.generation !== generation
      || !binding.sessions.getSnapshot().active || !binding.sessions.isScopeWritable() || !stillCurrent() || deletedRef.current || nativeGestureActive.current
      || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current) || !append.canLeave()) return false;
    if (!session.getSnapshot().ready || !session.canNavigate()) {
      setCommandError('入力を確定またはキャンセルし、保存を確認してから編集面を移動してください。'); return false;
    }
    if (!stillCurrent() || !binding.sessions.isScopeWritable()) return false;
    setCommandError(''); return reader.setPlacement(target);
  };
  const workspaceMoveEditor = useWorkspaceEditor({ id: binding.documentId, kind }, moveEditor);
  const diagnosticState = useRef((): HighlightSnapshot | null => null);
  diagnosticState.current = () => {
    const surface = reader.getSnapshot().activeSurface, registration = pdfSelections.current.get(surface);
    if ((surface === 'original' ? originalPaneRef : translatedPaneRef).current !== paneRef.current) return null;
    return { highlight: { ...highlightEvidence.current }, commandError, keys: registration?.controller.readKeyEvidence() ?? [] };
  };
  useLayoutEffect(() => {
    const pane = paneRef.current; if (!pane) return;
    const getter = () => paneRef.current === pane ? diagnosticState.current() : null;
    return installHighlightDiagnostic(pane, getter);
  });
  const sourcePage = () => {
    if (!initializedRef.current || !lifetime.current.active || !binding.sessions.getSnapshot().active || !session.canNavigate()) return null;
    const document = session.getSnapshot().document;
    const active = reader.getSnapshot();
    const collection = active.activeSurface === 'translated' ? document?.translation?.pages : document?.pages;
    const current = collection?.find(value => value.id === active.surfacePageId);
    return current?.background.kind === 'pdf' && page && canonicalJson(pageExpectation(current)) === canonicalJson(pageExpectation(page))
      ? structuredClone(current) : null;
  };
  const quoteTarget = (source: Page) => ({ libraryId: binding.repository.scope.libraryId, documentId: binding.documentId,
    pageId: source.id, backgroundRevision: source.backgroundRevision, surface: reader.getSnapshot().activeSurface });
  const quoteLabel = (_source: Page) => `${reading.activeSurface === 'translated' ? '訳文' : '出典'} p.${displayedIndex + 1}`;
  const readActivePdfSelection = () => {
    try {
      const source = sourcePage(), surface = reader.getSnapshot().activeSurface, registration = pdfSelections.current.get(surface);
      const pane = (surface === 'original' ? originalPaneRef : translatedPaneRef).current;
      if (!source || !registration || !selectionAvailableRef.current(surface) || getPdfPointerOwner(rootRef.current)
        || hasPdfPointerContact(rootRef.current) || isPdfPointerDraining(rootRef.current) || registration.generation !== lifetime.current.generation
        || registration.pageId !== source.id || registration.revision !== source.backgroundRevision || !pane?.isConnected) return null;
      const selected = registration.controller.readSelection(), asset = selectionAssets.current[surface];
      if (!selected || !asset || selected.range.collapsed || !selected.binding.isCurrent()
        || selected.binding.asset.url !== asset.url
        || canonicalJson(selected.binding.asset.binding) !== canonicalJson(canonicalPdfResourceBinding(binding.repository.scope, source))
        || canonicalJson(asset.binding) !== canonicalJson(selected.binding.asset.binding)
        || !pane.contains(selected.binding.pageElement) || !pane.contains(selected.binding.textLayer)
        || !pane.contains(selected.binding.canvas) || !selected.binding.textLayer.contains(selected.range.startContainer)
        || !selected.binding.textLayer.contains(selected.range.endContainer)) return null;
      return { ...selected, source, surface, registration, version: session.getSnapshot().document!.version };
    } catch { return null; }
  };
  const sameSelection = (before: NonNullable<ReturnType<typeof readActivePdfSelection>>, after: ReturnType<typeof readActivePdfSelection>) => !!after
    && before.binding === after.binding && before.registration === after.registration && before.surface === after.surface && before.version === after.version
    && canonicalJson(pageExpectation(before.source)) === canonicalJson(pageExpectation(after.source))
    && before.range.startContainer === after.range.startContainer && before.range.startOffset === after.range.startOffset
    && before.range.endContainer === after.range.endContainer && before.range.endOffset === after.range.endOffset;
  const quoteSelection = () => {
    const selected = readActivePdfSelection();
    if (!selected || !append.canLeave()) {
      setCommandError('「読む」でPDFの文章を選択してから追加してください。'); return;
    }
    const chosen = selectCanonicalPdfText({ range: selected.range, textLayer: selected.binding.textLayer, page: selected.source, target: quoteTarget(selected.source) });
    if (!chosen || !sameSelection(selected, readActivePdfSelection()) || !append.canLeave()) { setCommandError('PDF内の文章を選び直してください。'); return; }
    setCommandError(''); void append.begin({ kind: 'quote', ...chosen, label: quoteLabel(selected.source) });
  };
  const copyPdfSelection = () => {
    const selected = readActivePdfSelection();
    if (!selected) { setCommandError('「読む」でPDFの文章を選択してください。'); return; }
    const generation = lifetime.current.generation;
    const alive = () => lifetime.current.active && lifetime.current.generation === generation && pdfSelections.current.get(selected.surface) === selected.registration;
    void selected.registration.controller.copySelection().then(copied => {
      if (alive()) setCommandError(copied ? '' : '選択した文章をコピーできませんでした。選び直してもう一度お試しください。');
    }).catch(() => { if (alive()) setCommandError('選択した文章をコピーできませんでした。もう一度お試しください。'); });
  };
  const createPdfHighlight = () => {
    highlightEvidence.current = { attempts: highlightEvidence.current.attempts + 1, stage: 'selection', refusal: null, problem: null, draftCreated: null, selectionAdmitted: null };
    const selected = readActivePdfSelection();
    highlightEvidence.current.selectionAdmitted = !!selected;
    const refusal = (reason: string, failed: boolean) => { if (failed) highlightEvidence.current.refusal = reason; return failed; };
    if (!selected || refusal('deleted', deletedRef.current) || refusal('annotation-guard', !selectionOwners.current[selected.surface].annotation.canCreateHighlight()) || refusal('append-guard', !append.canLeave())) {
      highlightEvidence.current.stage = 'pre-capture-refused'; if (!selected) highlightEvidence.current.refusal = 'selection';
      setCommandError('入力と保存を確認し、「読む」でPDFの文章を選択してください。'); return;
    }
    highlightEvidence.current.stage = 'capture';
    const result = captureCanonicalPdfHighlight({ range: selected.range, binding: selected.binding });
    if (result.status === 'refused') {
      highlightEvidence.current.stage = 'capture-refused'; highlightEvidence.current.refusal = result.reason;
      const explanation = { 'stale-render': 'ページを描画し直しています。', 'fonts-pending': '文字を読み込んでいます。',
        'item-map-mismatch': '表示中の文字の対応を確認できません。', 'unsupported-transform': 'この向きや変形の文章には対応していません。',
        'unsupported-text-boundary': '文字の途中を含まないように選び直してください。', 'layout-mismatch': '文章の表示位置を確認できません。',
        'invalid-selection': 'PDF内の文章を選び直してください。' };
      setCommandError(`本文ハイライトを作成できません。${explanation[result.reason]}`); return;
    }
    const capture = result.capture;
    // Canonical data only. Capture evidence and render tokens end at this synchronous admission boundary.
    const seed = { quote: capture.quote, range: { kind: 'unindexed' as const },
      quads: capture.quads.map(quad => quad.map(p => ({ x: p.x, y: p.y }))),
      anchor: { x: capture.anchor.x, y: capture.anchor.y }, backgroundRevision: capture.backgroundRevision };
    const problem = canonicalPdfHighlightCaptureProblem(capture, selected.binding), after = readActivePdfSelection();
    highlightEvidence.current.stage = 'post-capture'; highlightEvidence.current.problem = problem ?? null;
    if (problem || refusal('selection-changed', !sameSelection(selected, after)) || refusal('page-changed', capture.pageId !== selected.source.id)
      || refusal('background-changed', capture.backgroundRevision !== selected.source.backgroundRevision) || refusal('deleted', deletedRef.current) || refusal('append-guard', !append.canLeave())
      || refusal('annotation-guard', !selectionOwners.current[selected.surface].annotation.canCreateHighlight())
      || refusal('draft-refused', !(highlightEvidence.current.draftCreated = selectionOwners.current[selected.surface].annotation.createHighlight(seed)))) {
      highlightEvidence.current.stage = 'post-capture-refused'; if (problem) highlightEvidence.current.refusal = 'capture-problem';
      setCommandError('ページや選択状態が変わりました。文章を選び直してください。'); return;
    }
    highlightEvidence.current.stage = 'draft-created';
    selected.registration.controller.clearSelection(); setCommandError('');
  };
  const startCapture = () => {
    if (!sourcePage() || !append.canLeave()) { setCommandError('入力と保存を確認してから範囲を選択してください。'); return; }
    setCommandError(''); ink.editor.setTool(ink.editor.tool === 'capture' ? 'select' : 'capture');
  };
  const capture = (bounds: CaptureBounds) => {
    // InkOverlay releases its transient selection owner at the end of this pointer event.
    const source = page ? structuredClone(page) : null, box = { ...bounds }, withInk = includeInk;
    const sourceSurface = reader.getSnapshot().activeSurface;
    const sourceTarget = source && quoteTarget(source);
    queueMicrotask(() => {
      const current = sourcePage();
      if (!source || !sourceTarget || !current || reader.getSnapshot().activeSurface !== sourceSurface
        || canonicalJson(pageExpectation(current)) !== canonicalJson(pageExpectation(source)) || !append.canLeave()) return;
      ink.editor.setTool('select');
      if (output.destination !== 'note') { void output.capture(source, box); return; }
      const target = { ...sourceTarget, anchor: { xPt: box.x * source.widthPt, yPt: box.y * source.heightPt } };
      setCommandError('');
      void append.begin({ kind: 'image', target, label: quoteLabel(source), mediaType: 'image/png',
        alt: `p.${displayedIndex + 1}の選択範囲`,
        bytes: async () => {
          const signal = new AbortController().signal;
          const fonts = withInk ? await binding.outputFile?.fonts([source], signal) ?? [] : [];
          return (await captureCanonicalPdf({ page: source, resources: binding.repository, bounds: box, includeInk: withInk, fonts, signal })).bytes;
        } });
    });
  };
  const surfaceView = (surface: 'original' | 'translated'): DocumentSurfaceView => {
    const active = reading.activeSurface === surface;
    const targetPage = surface === 'original' ? originalPage : translatedPage;
    const targetInk = surface === 'original' ? originalInk : translatedInk;
    return { inputBundle, surface, active, status: targetPage ? 'ready' : surface === 'translated' && reading.translationStatus === 'ambiguous' ? 'ambiguous' : 'missing',
      page: targetPage, asset: (surface === 'original' ? originalAsset : translatedAsset).asset,
      assetError: (surface === 'original' ? originalAsset : translatedAsset).error, retryAsset, zoom,
      editor: targetInk.editor, paneRef: surface === 'original' ? originalPaneRef : translatedPaneRef,
      annotation: targetInk.annotation,
      pdfSelection: surface === 'original' ? originalSelection : translatedSelection,
      inkGesture: surface === 'original' ? originalInkGesture : translatedInkGesture,
      inkGestureRef: surface === 'original' ? originalInkGestureRef : translatedInkGestureRef,
      pointerLifetimeKey: surface === 'original' ? originalPointerLifetime : translatedPointerLifetime,
      editable: active && targetInk.ready && !deleted, reportViewport: metrics => {
        if (active) reportViewport(metrics);
        else if (targetPage) companionPlace.viewportReady(`${targetPage.id}:${targetPage.backgroundRevision}`, metrics);
      },
      changeZoom: (value, keepPlace) => { if (active) changeZoom(value, keepPlace); },
      swipe: (amount, proof) => {
        const pane = (surface === 'original' ? originalPaneRef : translatedPaneRef).current;
        consumeTerminalSwipe(proof, rootRef.current, pane, stillValid => {
          if (!initializedRef.current || !lifetime.current.active || deletedRef.current || !binding.sessions.getSnapshot().active
            || nativeGestureActive.current || !append.canLeave() || !session.canNavigate()
            || reader.getSnapshot().activeSurface !== surface || reader.getSnapshot().surfacePageId !== targetPage?.id) return false;
          cancelAnnotationLanding(); capturePlace();
          return stillValid() && reader.step(amount);
        });
      },
      allowTouch: () => active && settings.getSnapshot().mode === 'ink' && !session.getSnapshot().inputActive,
      capture: bounds => { if (active && !deleted) capture(bounds); } };
  };
  const referenceCommandAllowed = () => initializedRef.current && lifetime.current.active && !deletedRef.current
    && binding.sessions.getSnapshot().active && session.canNavigate() && append.canLeave()
    && !nativeGestureActive.current && !hasPdfPointerContact(rootRef.current) && !isPdfPointerDraining(rootRef.current);
  const referenceControls = {
    pinned: reading.reference.mode === 'pinned',
    label: reading.reference.target ? `${reading.reference.target.pool === 'original' ? '原文' : '訳文'}・${reading.reference.target.pageId}` : '表示対象なし',
    pin: () => {
      if (!referenceCommandAllowed()) { setCommandError('入力や保存、接触の終了後に操作してください。'); return false; }
      const active = reader.getSnapshot(), current = reader.resolvePage(active.activeSurface);
      if (!current) { setCommandError('現在のページを固定できません。'); return false; }
      const result = reader.pinCurrentReference(referenceTarget(active.activeSurface, current));
      if (result.status === 'blocked') { setCommandError('現在のページを固定できません。'); return false; }
      setCommandError(''); return true;
    },
    clear: () => {
      if (!referenceCommandAllowed()) { setCommandError('入力や保存、接触の終了後に操作してください。'); return false; }
      const result = reader.clearReference();
      if (result.status === 'blocked') { setCommandError('固定を解除できません。'); return false; }
      setCommandError(''); return true;
    },
  };
  // Reference asset and input lifetimes remain independent of main resource attempts.
  const reference: DocumentLibraryView['reference'] = referencePage && !deleted ? { status: 'ready', view: {
    page: referencePage, asset: referenceAsset.asset, assetError: referenceAsset.error,
    retryAsset: () => setReferenceAttempt(value => value + 1), inputBundle, paneRef: referencePaneRef, scopeRef: referenceScopeRef,
    pointerLease: referenceLease, zoom: reading.reference.zoom.kind === 'fit-page' ? 0 : reading.reference.zoom.value,
    setZoom: referencePlace.setGestureZoom, allowContinuation: referencePlace.continuationAllowed,
    allowTouch: () => { const port = referencePlace.resolvePort(); const proof = port?.getSnapshot(); return !!proof?.active && !proof.blocked && initializedRef.current && lifetime.current.active && !deletedRef.current
      && binding.sessions.getSnapshot().active && session.canNavigate() && append.canLeave() && !isPdfPointerDraining(rootRef.current); },
    reportMeasurement: referencePlace.reportMeasurement,
  } } : { status: 'unavailable', reason: deleted ? 'この文書は削除されています。' : '固定されたページを表示できません。' };
  const conflictAllowed = () => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.getSnapshot().active
    && binding.sessions.getSnapshot().ready && session.canNavigate() && append.canLeave() && translationCanLeave() && notebookCanLeave()
    && !nativeGestureActive.current && !hasPdfPointerContact(rootRef.current) && !isPdfPointerDraining(rootRef.current);
  const view: DocumentLibraryView = { inputBundle, reference, referenceControls, documentId: binding.documentId, title: displayedTitle, kind, placement, moveEditor: workspaceMoveEditor,
    conflict: { heads: state.heads, busy: state.phase === 'saving' || state.inputActive, canDiscardRejected: session.canDiscardRejectedResolution(),
      compare: () => conflictAllowed() ? session.conflictVersions() : [],
      checkout: version => conflictAllowed() && session.checkout(version),
      adopt: (version, heads) => conflictAllowed() ? session.resolveConflict(version, heads) : Promise.resolve(false),
      discardRejected: () => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.getSnapshot().active
        && binding.sessions.getSnapshot().ready ? session.discardRejectedResolution() : Promise.resolve(false) },
    annotation: ink.annotation,
    pdfSelection: reading.activeSurface === 'original' ? originalSelection : translatedSelection,
    inkGesture: reading.activeSurface === 'original' ? originalInkGesture : translatedInkGesture,
    inkGestureRef: reading.activeSurface === 'original' ? originalInkGestureRef : translatedInkGestureRef,
    pointerLifetimeKey: reading.activeSurface === 'original' ? originalPointerLifetime : translatedPointerLifetime,
    pdfTextCommands: { canBegin: page?.background.kind === 'pdf' && initialized && registry.active && settings.getSnapshot().mode === 'ink'
      && settings.getSnapshot().tool === 'select' && session.canNavigate(), copy: copyPdfSelection, highlight: createPdfHighlight },
    annotationRenderGeneration: surfaceGeneration,
    annotationCandidate: !annotationCandidate ? null : {
      cancel: () => setAnnotationCandidate(null),
      edit: () => {
        const request = annotationCandidate, generation = lifetime.current.generation;
        const alive = () => candidateRef.current === request && lifetime.current.active && lifetime.current.generation === generation
          && binding.sessions.getSnapshot().active && !navigation?.getSnapshot().busy && !navigation?.getSnapshot().citation;
        if (!alive()) return;
        const refuse = () => { if (alive()) { setCommandError('注釈や表示中の版が変わりました。一覧から選び直してください。'); setAnnotationCandidate(null); } };
        void binding.repository.read(binding.documentId).then(read => {
          if (!alive()) return;
          const document = session.getSnapshot().document, current = reader.getSnapshot();
          const fresh = read.heads.includes(request.version) ? new EditGraph(read.checkpoint).snapshot(request.version) : null;
          if (!document || !session.getSnapshot().heads.includes(request.version) || fresh?.kind !== 'document'
            || resolveAnnotationLocation(request, { libraryId: binding.repository.scope.libraryId, document: fresh }).status === 'unresolved'
            || resolveAnnotationLocation(request, { libraryId: binding.repository.scope.libraryId, document }).status === 'unresolved') { refuse(); return; }
          if (current.activeSurface !== request.target.surface || current.surfacePageId !== request.target.pageId) { refuse(); return; }
          if (annotationReady.current.get(`${request.target.pageId}:${request.target.backgroundRevision}`) !== generation) {
            setCommandError('ページの描画を確認してから、もう一度「この注釈を編集」を押してください。'); return;
          }
          const owner = selectionOwners.current[current.activeSurface];
          if (!owner.annotation.edit(request.row.annotation)) { refuse(); return; }
          setAnnotationCandidate(null);
        }).catch(refuse);
      },
    },
    reportAnnotationReady,
    pdfSearchHit,
    pdfLinks: {
      admit: source => initializedRef.current && lifetime.current.active && !deletedRef.current && binding.sessions.getSnapshot().active
        && session.canNavigate() && append.canLeave() && !nativeGestureActive.current && !hasPdfPointerContact(rootRef.current)
        && !isPdfPointerDraining(rootRef.current) && reader.getSnapshot().surfacePageId === source.id
        && reader.resolvePage(reader.getSnapshot().activeSurface)?.backgroundRevision === source.backgroundRevision
        && ink.editor.tool === 'select' && ink.annotation.mode === 'ink',
      navigate: (source, physicalPage, y) => {
        if (source.background.kind !== 'pdf') return false;
        const background = source.background;
        const current = reader.getSnapshot(), document = session.getSnapshot().document;
        const collection = current.activeSurface === 'translated' ? document?.translation?.pages : document?.pages;
        const matches = collection?.filter(value => value.background.kind === 'pdf' && value.background.resourceId === background.resourceId
          && value.background.sourceRevision === background.sourceRevision && value.background.pdfPage === physicalPage);
        if (matches?.length !== 1) return false;
        const target = matches[0];
        capturePlace(); setPdfSearchHit(null);
        return reader.jumpSurface(current.activeSurface, target.id, y === undefined ? undefined : { x: .5, y }, target.backgroundRevision).status !== 'blocked';
      },
    },
    pdfSearch: { pages: searchPages, currentPageId: page?.id ?? '', resources: binding.repository, clear: () => setPdfSearchHit(null), navigate: hit => {
      if (!initializedRef.current || !lifetime.current.active || deletedRef.current || !session.canNavigate() || !append.canLeave()) return false;
      const surface = reading.activeSurface;
      const current = surface === 'translated' ? session.getSnapshot().document?.translation?.pages : session.getSnapshot().document?.pages;
      if (!current?.some(value => value.id === hit.pageId && value.backgroundRevision === hit.backgroundRevision)) return false;
      capturePlace();
      const result = reader.jumpSurface(surface, hit.pageId, hit.y === undefined ? undefined : { x: .5, y: hit.y }, hit.backgroundRevision);
      if (result.status !== 'blocked') setPdfSearchHit(hit);
      return result.status !== 'blocked';
    } },
    surfaces: { original: surfaceView('original'), translated: surfaceView('translated') },
    display: reading.display, activeSurface: reading.activeSurface, translatedOnly: reading.translatedOnly,
    filterPending: reading.filterPending, filterCandidateCount: reading.filterCandidateCount,
    retryFilter: () => changeReaderSurface(() => reader.retryFilteredNavigation()),
    changeDisplay: mode => changeReaderSurface(() => reader.setDisplay(mode)),
    activateSurface: (surface, origin = { kind: 'programmatic' }) => {
      const root = rootRef.current;
      if (!root || isPdfPointerDraining(root)) return false;
      if (origin.kind === 'pointer') {
        const target = origin.target instanceof Element ? origin.target : origin.target instanceof Node ? origin.target.parentElement : null;
        if (!target || target.closest('[data-reader-root]') !== root || !root.contains(target)
          || target.closest<HTMLElement>('[data-reader-surface]')?.dataset.readerSurface !== surface
          || hasOtherPdfPointerContact(root, origin.pointerId)) return false;
      } else if (hasPdfPointerContact(root)) return false;
      return changeReaderSurface(() => reader.setSurface(surface), origin.kind === 'pointer');
    },
    changeTranslatedOnly: value => changeReaderSurface(() => reader.setTranslatedOnly(value)),
    notebookPdfImport: notebookImport,
    notebook: kind !== 'notebook' || !page ? null : {
      insert: () => { const id = crypto.randomUUID(); return runDocumentChange((document, batchId) => {
        const paper = document.pages.find(page => page.background.kind === 'paper')?.background;
        return notebookInsert(document, page.id, 'after', id, batchId, paper?.kind === 'paper' ? paper.spec : { template: 'ruled7', color: 'white' });
      }, id); },
      duplicate: () => { const id = crypto.randomUUID(); return runDocumentChange((document, batchId) => {
        const current = document.pages.find(value => value.id === page.id);
        if (!current) throw new Error('missing-notebook-page');
        return notebookDuplicate(document, page.id, id, current.annotations.map(() => crypto.randomUUID()), batchId);
      }, id); },
      remove: () => runDocumentChange(document => notebookRemove(document, page.id)),
      reorder: amount => runDocumentChange(document => notebookMove(document, page.id, document.pages.findIndex(value => value.id === page.id) + amount)),
      applyPaper: request => runDocumentChange((document, batchId) => {
        const current = document.pages.find(value => value.id === request.pageId);
        if (!current || canonicalJson(pageExpectation(current)) !== canonicalJson(request.expected)) throw new Error('stale-paper-page');
        return notebookApplyPaper(document, request.pageId, request.widthPt, request.heightPt, request.spec, batchId, request.fit);
      }, undefined, false),
    }, loading: !initialized || !registry.ready || !state.ready,
    error: loadError || assetError || commandError || ink.error || (reading.error === 'reader-background-changed'
      ? '背景が変わったため、以前の位置への移動を停止しました。'
      : reading.error ? '表示位置を保存できません。再試行してください。' : '') || (state.error ? '書き込みを保存できません。内容を保持しています。再試行してください。' : ''), status,
    page, asset: asset.asset, assetError: asset.error, retryAsset,
    pageIndex: displayedIndex, pageCount: pages.length, canPrevious, canNext, zoom, editor: ink.editor, state,
    editable: ink.ready && !deleted && binding.sessions.isScopeWritable(), translationImport, rootRef, paneRef, referencePaneRef, landing, reportViewport, changeZoom,
    swipe: () => {},
    move: amount => { commands.dispatch({ type: 'step', amount }); }, jump: value => { commands.dispatch({ type: 'jump', page: value }); },
    undo: () => { if (!deleted) void session.undo().catch(() => setLoadError('元に戻せませんでした。内容は保持しています。')); },
    redo: () => { if (!deleted) void session.redo().catch(() => setLoadError('やり直せませんでした。内容は保持しています。')); },
    retry, syncDisabled: replication.suspended, sync: () => { if (!binding.replication.getSnapshot().suspended) void synchronize(); }, checkout: version => { session.checkout(version); },
    allowTouch: () => settings.getSnapshot().mode === 'ink' && !session.getSnapshot().inputActive, capture: bounds => { if (!deleted) capture(bounds); }, output,
    noteAppend: page?.background.kind !== 'pdf' && !appendState.request ? null : {
      state: appendState, canCancel: append.canCancel(), canBegin: !deleted && page?.background.kind === 'pdf' && initialized && !appendState.busy && session.canNavigate() && append.canLeave(), includeInk,
      changeIncludeInk: setIncludeInk, quoteSelection, startCapture,
      submit: id => { void append.submit(id); }, retry: () => { void append.retry(); },
      cancel: () => { if (append.cancel()) append.dismiss(); }, dismiss: () => { append.dismiss(); },
      openTarget: () => {
        const request = append.getSnapshot();
        if (request.destinationId && navigation) void navigation.openDocument(request.destinationId).then(result => {
          // Once the destination owns a confirmed operation, release its captured source page/renderer closure.
          if (result.status === 'applied' && request.phase === 'accepted'
            && append.getSnapshot().request?.id === request.request?.id) append.dismiss();
        });
      },
    } };
  const readingLanding = useMemo(() => ({ toEnd: landing.toEnd, consumed: new Set<string>() }), [landing]);
  return <ReadingLanding.Provider value={readingLanding}>{render(view)}</ReadingLanding.Provider>;
}

