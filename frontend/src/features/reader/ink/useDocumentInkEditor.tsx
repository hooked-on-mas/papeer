import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InkObject, Page } from '../../../runtime/edits/contracts';
import { activeDocumentPages } from '../../../runtime/edits/documentPages';
import { CanonicalInkDrawing } from './CanonicalInkDrawing';
import { InkDrawing } from '../InkDrawing';
import { projectInkObject } from './canonicalInk';
import { applyCanonicalInkOperation, canonicalInkResult, type CanonicalInkOperation } from './canonicalInkOperations';
import { CanonicalEraseCursor } from './canonicalEraseCursor';
import type { InkStroke } from '../../ink/inkGeometry';
import type { InkActivationEvent, InkOperationPort, InkTextPort } from '../inkEditor';
import { useInkSurfaceEditor } from '../useInkSurfaceEditor';
import type { DocumentEditSession } from '../edit/DocumentEditSession';
import type { DocumentInkSettings } from './DocumentInkSettings';
import type { CanonicalAnnotationFacade } from '../annotations/CanonicalAnnotationEditor';
import { hasOtherPdfPointerContact, hasPdfPointerContact, isPdfPointerDraining, isSamePaneReadingPinchContinuation } from '../input/usePdfPointerInput';

/** Canonical authority owns originals; surface projections are only for display and hit testing. */
export function useDocumentInkEditor(session: DocumentEditSession, pageId: string, settings: DocumentInkSettings, enabled = true,
  isActive: () => boolean = () => true, isEditable: () => boolean = () => true) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const preferences = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
  const token = useRef(Symbol('document-surface'));
  const finalizers = useRef(new Set<() => void>());
  const operationBase = useRef<{ page: Page; version: string } | null>(null);
  const erasePreview = useRef<{ page: Page; seed: string; radius: number; partial: boolean; highlightOnly: boolean; cursor: CanonicalEraseCursor } | null>(null);
  const previewAnnotations = useRef(new WeakMap<InkStroke, InkObject>());
  const [owned, setOwned] = useState(false), [error, setError] = useState('');
  const leaseRef = useRef<object | null>(null), [ownerLease, setOwnerLease] = useState<object | null>(null);
  const lifetime = useRef({ active: false, generation: 0 }), annotationFlight = useRef(false);
  const annotationGesture = useRef<{ id: string; generation: number; draftId: string | null } | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const page = state.document && activeDocumentPages(state.document).find(value => value.id === pageId);
  const livePage = () => {
    const document = session.getSnapshot().document;
    return document && { page: activeDocumentPages(document).find(value => value.id === pageId), version: document.version };
  };
  const claimPage = useCallback(() => {
    const admitted = session.claimPage(pageId, token.current);
    if (admitted && !leaseRef.current) { leaseRef.current = {}; setOwnerLease(leaseRef.current); }
    else if (!admitted && leaseRef.current) { leaseRef.current = null; setOwnerLease(null); }
    setOwned(admitted);
  }, [session, pageId]);
  useLayoutEffect(() => {
    const owner = token.current, callbacks = finalizers.current;
    const current = lifetime.current; current.active = true; current.generation++;
    claimPage();
    const hide = () => {
      const gesture = annotationGesture.current; annotationGesture.current = null;
      if (gesture && !gesture.draftId) session.setInput(pageId, owner, 'idle');
    };
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('pagehide', hide);
      current.active = false; current.generation++; annotationGesture.current = null;
      leaseRef.current = null;
      if (!session.getSnapshot().surfaces[pageId]?.annotationDraft) for (const finish of callbacks) finish();
      callbacks.clear(); operationBase.current = null; erasePreview.current = null; previewAnnotations.current = new WeakMap();
      session.releasePage(pageId, owner);
    };
  }, [session, pageId, claimPage]);
  useLayoutEffect(() => {
    if (!owned && state.ready && page) claimPage();
  }, [owned, state, page, claimPage]);
  const registerFinalizer = useCallback((finish: () => void) => {
    finalizers.current.add(finish); return () => { finalizers.current.delete(finish); };
  }, [session, pageId]); // eslint-disable-line react-hooks/exhaustive-deps -- each logical page has its own finalization lifetime
  const finalize = useCallback(() => {
    if (!session.getSnapshot().surfaces[pageId]?.annotationDraft) for (const finish of finalizers.current) finish();
  }, [session, pageId]);
  const projected = useMemo(() => page ? page.annotations.filter((value): value is InkObject => value.kind === 'ink')
    .map(value => projectInkObject(value, page)) : [], [page]);
  const originals = useMemo(() => new Map(page?.annotations.filter((value): value is InkObject => value.kind === 'ink').map(value => [value.id, value]) ?? []), [page]);
  const projectionById = useMemo(() => new Map(projected.map(value => [value.id, value])), [projected]);
  const renderStroke = useCallback((stroke: InkStroke, ratio: number, inkColor: (color: string) => string) => {
    const original = previewAnnotations.current.get(stroke) ?? (projectionById.get(stroke.id) === stroke ? originals.get(stroke.id) : undefined);
    return original && page ? <CanonicalInkDrawing annotation={original} page={page} inkColor={inkColor} />
      : <InkDrawing stroke={stroke} ratio={ratio} inkColor={inkColor} />;
  }, [originals, projectionById, page]);
  const clearInput = () => {
    operationBase.current = null; erasePreview.current = null; previewAnnotations.current = new WeakMap();
    session.setInput(pageId, token.current, 'idle');
  };
  const onDrawingChange = (drawing: boolean) => {
    if (!drawing) { clearInput(); return true; }
    if (!enabled || !session.setInput(pageId, token.current, 'drawing')) return false;
    const current = livePage();
    if (!current?.page) { clearInput(); return false; }
    operationBase.current ??= { page: current.page, version: current.version };
    return true;
  };
  const apply = (page: Page, operation: CanonicalInkOperation) => {
    if (operation.type !== 'erase') return applyCanonicalInkOperation(page, operation);
    let cached = erasePreview.current;
    if (!cached || cached.page !== page || cached.seed !== operation.fragmentIdSeed || cached.radius !== operation.radius
      || cached.partial !== operation.partial || cached.highlightOnly !== operation.highlightOnly) {
      cached = { page, seed: operation.fragmentIdSeed, radius: operation.radius, partial: operation.partial,
        highlightOnly: operation.highlightOnly, cursor: new CanonicalEraseCursor(page, operation) };
      erasePreview.current = cached;
    }
    cached.cursor.append(operation.path);
    return canonicalInkResult(page, cached.cursor.getAnnotations());
  };
  const commit = (operation: CanonicalInkOperation): boolean => {
    if (!enabled || !session.canEditPage(pageId, token.current)) return false;
    const current = livePage(), base = operationBase.current ?? current;
    const draft = session.getSnapshot().surfaces[pageId]?.textDraft;
    if (draft && (operation.type !== 'text' || operation.id !== draft.id)) return false;
    if (!base?.page || !current?.page || base.page.id !== pageId || current.version !== (draft?.baseVersion ?? base.version)) {
      setError('編集開始時の版が変わっています。入力内容を確認してください。'); return false;
    }
    try {
      const result = apply(base.page, operation);
      setError('');
      // Admission and pending save begin synchronously, without an idle notification.
      void session.commitPageInput(pageId, token.current, result.changes, draft?.baseVersion ?? base.version)
        .then(result => { if (result.status === 'refused') setError('変更を確定できません。入力内容を保持しています。'); })
        .catch(cause => setError(String(cause)));
      operationBase.current = null; erasePreview.current = null; previewAnnotations.current = new WeakMap();
      return true;
    } catch { setError('この変更を確定できません。形や文字数を確認してください。'); return false; }
  };
  const operations: InkOperationPort = {
    commit, cancel: clearInput, hasClipboard: preferences.clipboard.annotations.length > 0,
    preview(operation) {
      const base = operationBase.current ?? livePage();
      if (!base?.page) return;
      try {
        const result = apply(base.page, operation), lookup = previewAnnotations.current;
        const projected = result.annotations.filter((value): value is InkObject => value.kind === 'ink').map(value => {
          const stroke = projectInkObject(value, base.page!); lookup.set(stroke, value); return stroke;
        });
        previewAnnotations.current = lookup; return projected;
      } catch { return; }
    },
    copy(ids) {
      const current = livePage();
      if (!current?.page) return;
      const selected = current.page.annotations.filter((value): value is InkObject => value.kind === 'ink' && ids.includes(value.id));
      if (selected.length) settings.put(selected, current.page.widthPt);
    },
    paste(duplicateIds) {
      const current = livePage();
      if (!current?.page) return [];
      const clipboard = settings.getSnapshot().clipboard;
      const annotations = duplicateIds ? current.page.annotations.filter((value): value is InkObject => value.kind === 'ink' && duplicateIds.includes(value.id)) : clipboard.annotations;
      if (!annotations.length) return [];
      const ids = annotations.map(() => crypto.randomUUID());
      return commit({ type: 'paste', annotations, ids, sourceWidthPt: duplicateIds ? current.page.widthPt : clipboard.sourceWidthPt }) ? ids : [];
    },
  };
  const surface = state.surfaces[pageId], draft = surface?.textDraft;
  const text: InkTextPort = {
    draft: draft && page ? { id: draft.id, at: [draft.at.x / page.widthPt, draft.at.y / page.heightPt], text: draft.text,
      previous: projected.find(value => value.id === draft.id) } : null,
    begin(at, previous) {
      const current = livePage();
      return !!enabled && !!current?.page && session.beginText(pageId, token.current, {
        id: previous?.id ?? crypto.randomUUID(), at: { x: at[0] * current.page.widthPt, y: at[1] * current.page.heightPt }, text: previous?.text ?? '',
      });
    },
    change: value => { session.updateText(pageId, token.current, value); },
    cancel: () => { session.cancelText(pageId, token.current); },
    save() {
      const draft = session.getSnapshot().surfaces[pageId]?.textDraft, current = livePage();
      if (!draft || !draft.text.trim() || !current?.page) return false;
      const saved = commit({ type: 'text', id: draft.id, text: draft.text, at: [draft.at.x / current.page.widthPt, draft.at.y / current.page.heightPt],
        color: settings.getSnapshot().color, width: settings.getSnapshot().width });
      if (saved) { settings.setTool('region'); session.setSelection(pageId, token.current, [draft.id]); }
      return saved;
    },
  };
  const editor = useInkSurfaceEditor({
    source: { strokes: projected, ready: enabled && owned && preferences.mode === 'ink' && session.canEditPage(pageId, token.current),
      change: () => setError('操作内容を指定して編集してください。'), operations, text,
      selection: { ids: surface?.selectedIds ?? [], set: ids => { session.setSelection(pageId, token.current, ids); } },
      canUndo: enabled && state.canUndo && !state.inputActive, canRedo: enabled && state.canRedo && !state.inputActive,
      undo: () => { void session.undo().catch(cause => setError(String(cause))); }, redo: () => { void session.redo().catch(cause => setError(String(cause))); },
      onDrawingChange, registerFinalizer, renderStroke },
    pageKey: pageId, ratio: page ? page.heightPt / page.widthPt : 1,
    tools: { ...preferences, setTool: settings.setTool, setListOpen: settings.setListOpen, getVersion: settings.getVersion },
    preferences: { ...preferences, change: settings.change, retryPersistence: settings.retryPersistence }, onCopied: () => setError(''),
  });
  const generation = lifetime.current.generation;
  const liveOwner = () => lifetime.current.active && lifetime.current.generation === generation && isActive() && owned;
  const currentOwner = () => liveOwner() && enabled && isEditable() && editor.visible && !editor.locked;
  const annotationDraft = surface?.annotationDraft;
  const available = currentOwner() && state.ready && state.phase === 'idle' && (annotationDraft
    ? session.canRepositionAnnotationDraft(pageId, token.current, annotationDraft.draftId) : session.canEditPage(pageId, token.current));
  const annotation: CanonicalAnnotationFacade = {
    mode: preferences.mode, draft: surface?.annotationDraft ?? null, available, busy: annotationBusy,
    cancelAllowed: liveOwner() && !annotationFlight.current && !!annotationDraft,
    setMode(mode) {
      if (!currentOwner() || annotationFlight.current || annotationGesture.current) return false;
      const current = session.getSnapshot();
      if (current.phase !== 'idle' || current.surfaces[pageId]?.textDraft) return false;
      if (mode === 'annotation-move' && !current.surfaces[pageId]?.annotationDraft) return false;
      if (current.inputActive && !current.surfaces[pageId]?.annotationDraft) return false;
      settings.setAnnotationMode(mode); return true;
    },
    edit(value) {
      if (!currentOwner() || annotationFlight.current || !session.canNavigate()) return false;
      const id = session.beginAnnotationDraft(pageId, token.current, value.kind === 'highlight'
        ? { kind: 'edit-highlight', annotation: value } : { kind: 'edit-sticky', annotation: value });
      if (id) settings.setAnnotationMode('annotation-select'); return !!id;
    },
    canSelectText() {
      return liveOwner() && !annotationFlight.current && session.canNavigate() && session.canEditPage(pageId, token.current);
    },
    canCreateHighlight() {
      const current = livePage(), mode = settings.getSnapshot();
      return currentOwner() && !annotationFlight.current && !annotationGesture.current && !!current?.page
        && current.page.background.kind === 'pdf' && mode.mode === 'ink' && mode.tool === 'select'
        && session.canNavigate() && session.canEditPage(pageId, token.current);
    },
    createHighlight(seed) {
      const mode = settings.getSnapshot();
      if (!currentOwner() || annotationFlight.current || annotationGesture.current || !session.canNavigate()
        || !session.canEditPage(pageId, token.current) || livePage()?.page?.background.kind !== 'pdf'
        || mode.mode !== 'ink' || mode.tool !== 'select') return false;
      const id = session.beginAnnotationDraft(pageId, token.current, { kind: 'create-highlight', seed });
      if (id) settings.setAnnotationMode('annotation-select'); return !!id;
    },
    change(id, patch) { return currentOwner() && !annotationFlight.current && session.updateAnnotationDraft(pageId, token.current, id, patch); },
    cancel(id) {
      if (!liveOwner() || annotationFlight.current) return false;
      const canceled = session.cancelAnnotationDraft(pageId, token.current, id);
      if (canceled) settings.setAnnotationMode('annotation-select'); return canceled;
    },
    commit(id) {
      if (!currentOwner() || annotationFlight.current) return;
      annotationFlight.current = true; setAnnotationBusy(true); setError('');
      void session.commitAnnotationDraft(pageId, token.current, id, currentOwner).then(result => {
        if (liveOwner() && result.status === 'refused') setError('注釈を保存できません。入力内容を保持しています。');
      }).catch(() => { if (liveOwner()) setError('注釈を保存できません。入力内容を保持しています。'); })
        .finally(() => {
          annotationFlight.current = false;
          if (lifetime.current.active && lifetime.current.generation === generation) setAnnotationBusy(false);
        });
    },
    beginGesture() {
      if (!currentOwner() || annotationGesture.current || annotationFlight.current) return null;
      const draft = session.getSnapshot().surfaces[pageId]?.annotationDraft;
      const mode = settings.getSnapshot().mode;
      if (mode === 'sticky-place' ? !session.setInput(pageId, token.current, 'drawing') : mode !== 'annotation-move' || !draft) return null;
      const id = crypto.randomUUID(); annotationGesture.current = { id, generation, draftId: draft?.draftId ?? null }; return id;
    },
    endGesture(id, point) {
      const gesture = annotationGesture.current;
      if (!gesture || gesture.id !== id || gesture.generation !== generation || !liveOwner()) return false;
      annotationGesture.current = null;
      if (!currentOwner()) point = null;
      if (gesture.draftId) return !!point && session.updateAnnotationDraft(pageId, token.current, gesture.draftId, { anchor: point });
      session.setInput(pageId, token.current, 'idle');
      if (!point) return false;
      const created = session.beginAnnotationDraft(pageId, token.current, { kind: 'create-sticky', anchor: point });
      if (created) settings.setAnnotationMode('annotation-select'); return !!created;
    },
    canReposition() {
      const draft = session.getSnapshot().surfaces[pageId]?.annotationDraft;
      return currentOwner() && !annotationFlight.current && !annotationGesture.current && !!draft
        && session.canRepositionAnnotationDraft(pageId, token.current, draft.draftId);
    },
  };
  const admitsActivation = (event?: InkActivationEvent) => {
    const source = event?.nativeEvent ?? event;
    const pointerId = source?.type === 'pointerdown' && 'pointerId' in source && typeof source.pointerId === 'number' ? source.pointerId : null;
    const pane = editor.scopeRef.current;
    if (!liveOwner() || isPdfPointerDraining(pane) || (pointerId === null ? hasPdfPointerContact(pane) : hasOtherPdfPointerContact(pane, pointerId))) {
      event?.preventDefault?.(); event?.stopPropagation?.(); return false;
    }
    return true;
  };
  const activate = (event?: InkActivationEvent) => {
    const source = event?.nativeEvent ?? event, pane = editor.scopeRef.current;
    const mode = settings.getSnapshot();
    // Existing active reading owns this sequence. Pass its second same-pane
    // touch through without activating or transferring any editor owner.
    if (source?.type === 'pointerdown' && 'pointerId' in source && typeof source.pointerId === 'number'
      && 'pointerType' in source && source.pointerType === 'touch' && liveOwner() && enabled
      && mode.mode === 'ink' && !annotationFlight.current && !annotationGesture.current
      && session.canNavigate() && isSamePaneReadingPinchContinuation(pane, source.pointerId)) return;
    if (admitsActivation(event)) editor.activate();
  };
  const deactivate = (event?: InkActivationEvent) => { if (admitsActivation(event)) editor.deactivate(); };
  return { editor: { ...editor, activate, deactivate }, annotation, state, page, owned, ownerLease: liveOwner() ? ownerLease : null,
    error, finalize, ready: enabled && owned && session.canEditPage(pageId, token.current) };
}
