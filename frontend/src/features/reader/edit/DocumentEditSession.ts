import type { AnnotationChange, DocumentEditBatch, DocumentSnapshot, EditBatch, PageChange, PageEditBatch, EditIntent, ResolutionBatch } from '../../../runtime/edits/contracts.ts';
import type { EditIntentRepository, HistoryRecord } from '../../../runtime/edits/ports.ts';
import { BatchCommitSession } from '../../../runtime/edits/batchCommitSession.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';
import { applyBatch, canonicalJson } from '../../../runtime/edits/editModel.ts';
import { activeDocumentPages, documentContent, pageExpectation } from '../../../runtime/edits/documentPages.ts';
import { DocumentEditHistory, inverseDocumentEdit, type HistoryCommand } from './documentHistory.ts';
import { EditIntentJournal } from '../../../runtime/edits/intentJournal.ts';
import { beginCanonicalAnnotationDraft, canonicalAnnotationDraftChanges, updateCanonicalAnnotationDraft,
  type AnnotationDraftPatch, type AnnotationDraftStart, type DocumentAnnotationDraft } from '../annotations/canonicalAnnotationOperations.ts';
export type { AnnotationDraftPatch, AnnotationDraftStart, AnnotationHighlightSeed, DocumentAnnotationDraft } from '../annotations/canonicalAnnotationOperations.ts';

export type DocumentCommandResult = { status: 'applied'; operationId: string } | { status: 'unchanged' } | { status: 'refused'; reason: string };
export type DocumentTextDraft = { id: string; at: { x: number; y: number }; text: string; baseVersion: string };
export type DocumentSurfaceState = { selectedIds: string[]; textDraft: DocumentTextDraft | null; annotationDraft: DocumentAnnotationDraft | null };
export type DocumentEditState = {
  ready: boolean; document: DocumentSnapshot | null; heads: string[]; selectedVersion: string | null;
  phase: 'idle' | 'saving' | 'aborted' | 'unknown'; error: string;
  canUndo: boolean; canRedo: boolean; affectedPages: string[]; inputActive: boolean;
  surfaces: Record<string, DocumentSurfaceState>;
};
type InputState = { token: symbol; phase: 'idle' | 'drawing' | 'text' | 'annotation' };
type Pending = { command: HistoryCommand; before: DocumentSnapshot; after: DocumentSnapshot; lifecycle: BatchCommitSession };
function immutableView<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutableView(child);
    Object.freeze(value);
  }
  return value;
}

/** A document's editing authority outlives page/pane instances. All surfaces use this same history/guard/save path. */
export class DocumentEditSession {
  private state: DocumentEditState = immutableView({ ready: false, document: null, heads: [], selectedVersion: null,
    phase: 'idle', error: '', canUndo: false, canRedo: false, affectedPages: [], inputActive: false, surfaces: {} });
  private graph?: EditGraph;
  private batches = new Map<string, EditBatch>();
  private records: HistoryRecord[] = [];
  private readonly history = new DocumentEditHistory();
  private readonly inputs = new Map<string, InputState>();
  private readonly listeners = new Set<() => void>();
  private pending?: Pending;
  private resolution?: { batch: ResolutionBatch; lifecycle: BatchCommitSession };
  private resolutionDiscarding = false;
  private readGeneration = 0;
  private preferredVersion?: string;
  private explicitCheckout = false;
  private readonly repository: EditIntentRepository;
  private readonly journal: EditIntentJournal;
  readonly documentId: string;
  private readonly makeId: () => string;
  private readonly enabled: () => boolean;
  constructor(repository: EditIntentRepository, documentId: string, makeId: () => string = () => crypto.randomUUID(), enabled: () => boolean = () => true) {
    this.repository = repository; this.documentId = documentId; this.makeId = makeId;
    this.enabled = enabled;
    this.journal = new EditIntentJournal(repository, documentId);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  conflictVersions = (): readonly DocumentSnapshot[] => this.state.heads.map(head => {
    const value = this.graph?.snapshot(head); if (value?.kind !== 'document') throw new Error('document-conflict-head-missing');
    return structuredClone(value);
  });
  canDiscardRejectedResolution = () => !!this.resolution && !this.resolutionDiscarding && this.resolution.lifecycle.getSnapshot().phase === 'aborted';
  private resolutionFlight(batch: ResolutionBatch, intent?: EditIntent) {
    if (batch.snapshot.kind !== 'document' || batch.snapshot.id !== this.documentId || batch.snapshot.version !== batch.id
      || batch.targetId !== this.documentId || batch.libraryId !== this.repository.scope.libraryId) throw new Error('document-resolution-invalid');
    return { batch: structuredClone(batch), lifecycle: new BatchCommitSession(this.repository, { batch }, () => { throw new Error('resolution-undo-unsupported'); },
      intent?.dispatched ? 'unknown' : 'new', { journal: this.journal, ...(intent ? { intent } : {}) }) };
  }
  resolveConflict = async (version: string, expectedHeads: readonly string[]): Promise<boolean> => {
    if (!this.enabled() || !this.state.ready || !this.canNavigate() || expectedHeads.length < 2 || !expectedHeads.includes(version)
      || new Set(expectedHeads).size !== expectedHeads.length || canonicalJson([...expectedHeads].sort()) !== canonicalJson([...this.state.heads].sort())) return false;
    const selected = this.graph?.snapshot(version); if (selected?.kind !== 'document') return false;
    const id = this.makeId(), batch: ResolutionBatch = { kind: 'resolution', id, libraryId: this.repository.scope.libraryId,
      targetId: this.documentId, parents: [...expectedHeads], snapshot: { ...selected, version: id } };
    this.readGeneration++; this.resolution = this.resolutionFlight(batch); this.update({ phase: 'saving', error: '', canUndo: false, canRedo: false });
    await this.retry(); return !this.resolution;
  };
  discardRejectedResolution = async (): Promise<boolean> => {
    const pending = this.resolution;
    if (!this.enabled() || !pending || this.resolutionDiscarding || pending.lifecycle.getSnapshot().phase !== 'aborted') return false;
    this.resolutionDiscarding = true;
    try { await this.journal.clear(); if (this.resolution !== pending) return false;
      this.resolution = undefined; this.update({ phase: 'idle', error: '' }); return await this.refresh();
    } catch (error) { this.update({ error: String(error) }); return false; }
    finally { this.resolutionDiscarding = false; }
  };
  private update(fields: Partial<DocumentEditState>) {
    const surfaces = fields.surfaces ?? this.state.surfaces;
    this.state = immutableView({ ...this.state, ...fields, inputActive: [...this.inputs.values()].some(input => input.phase !== 'idle')
      || Object.values(surfaces).some(surface => surface.textDraft !== null || surface.annotationDraft != null) }); this.listeners.forEach(listener => listener());
  }
  private versions(pending = this.pending) {
    return {
      batch: (id: string) => id === pending?.command.batch.id ? pending.command.batch : this.batches.get(id),
      snapshot: (id: string): DocumentSnapshot | undefined => id === pending?.before.version ? pending.before
        : id === pending?.after.version ? pending.after : this.graph?.snapshot(id) as DocumentSnapshot | undefined,
    };
  }
  async refresh(preferred?: string, mayAdopt?: (document: DocumentSnapshot | undefined, heads: readonly string[]) => boolean): Promise<boolean> {
    if (!this.canNavigate()) return false;
    if (preferred !== undefined && !mayAdopt) this.preferredVersion = preferred;
    const generation = ++this.readGeneration;
    try {
      const read = await this.repository.read(this.documentId);
      if (generation !== this.readGeneration || !this.canNavigate()) return false;
      const recovered = await this.journal.reload();
      if (generation !== this.readGeneration || !this.canNavigate()) return false;
      // A guarded navigation cannot acquire a newly discovered recovery writer or change its raw intent.
      if (mayAdopt && recovered) return false;
      const graph = new EditGraph(read.checkpoint);
      if (graph.root.kind !== 'document') throw new Error('document-required');
      const selected = (mayAdopt ? preferred ?? this.preferredVersion : this.preferredVersion)
        ?? (read.heads.length === 1 ? read.heads[0] : this.state.selectedVersion);
      const document = selected ? graph.snapshot(selected) as DocumentSnapshot | undefined : undefined;
      if (mayAdopt && (!mayAdopt(immutableView(structuredClone(document)), Object.freeze([...read.heads]))
        || generation !== this.readGeneration || !this.canNavigate())) return false;
      if (mayAdopt && preferred !== undefined) this.preferredVersion = preferred;
      this.graph = graph;
      this.batches = new Map(read.checkpoint.batches.map(batch => [batch.id, batch])); this.records = read.history;
      let error = '';
      if (document) {
        try { this.history.restore(this.versions(), document.version, read.history); }
        catch (cause) { error = String(cause); }
      }
      const history = this.history.getSnapshot();
      const fields: Partial<DocumentEditState> = { ready: true, document: document ?? null, heads: read.heads, selectedVersion: document?.version ?? null,
        phase: 'idle', error, canUndo: !error && !!document && history.undo.length > 0,
        canRedo: !error && !!document && history.redo.length > 0 };
      if (recovered) {
        const { intent } = recovered, request = intent.request;
        if ('batch' in request && request.batch.kind === 'resolution') {
          if (request.history || intent.undoRequested) throw new Error('unsupported-document-resolution-intent');
          const prior = graph.snapshot(request.batch.parents[0]);
          if (prior?.kind !== 'document') throw new Error('intent-parent-missing');
          this.resolution = this.resolutionFlight(request.batch, intent);
          this.update({ ...fields, document: prior, selectedVersion: prior.version,
            phase: intent.dispatched ? 'unknown' : 'aborted', error: '回復した版の採用があります。保存を再試行してください。', canUndo: false, canRedo: false });
          return true;
        }
        if (!('batch' in request) || !request.history || !['page', 'document'].includes(request.batch.kind)) throw new Error('unsupported-document-intent');
        const before = graph.snapshot(request.batch.parents[0]);
        if (before?.kind !== 'document') throw new Error('intent-parent-missing');
        const batch = request.batch as PageEditBatch | DocumentEditBatch, after = applyBatch(before, batch) as DocumentSnapshot;
        const command = { batch, history: request.history, affectedPages: this.affectedPages(batch, before) };
        this.pending = this.createPending(command, before, after, intent);
        this.update({ ...fields, document: after, selectedVersion: after.version, affectedPages: command.affectedPages,
          phase: intent.dispatched ? 'unknown' : 'aborted', error: '回復した編集があります。保存を再試行してください。',
          canUndo: !request.history.action && !intent.undoRequested, canRedo: false });
      } else {
        if (document?.version === this.preferredVersion) this.preferredVersion = undefined;
        this.update(fields);
      }
      return true;
    } catch (error) {
      if (!mayAdopt && generation === this.readGeneration) this.update({ ready: false, error: String(error), canUndo: false, canRedo: false });
      return false;
    }
  }
  checkout(version: string): boolean {
    if (!this.canNavigate()) return false;
    const document = this.graph?.snapshot(version);
    if (document?.kind !== 'document') return false;
    this.readGeneration++;
    this.preferredVersion = undefined;
    this.explicitCheckout = true;
    let error = '';
    try { this.history.restore(this.versions(), version, this.records); } catch (cause) { error = String(cause); }
    const history = this.history.getSnapshot();
    this.update({ document, selectedVersion: version, error, canUndo: !error && history.undo.length > 0, canRedo: !error && history.redo.length > 0 });
    return true;
  }
  claimPage(pageId: string, token: symbol): boolean {
    if (!this.enabled()) return false;
    const existing = this.inputs.get(pageId);
    if (existing && existing.token !== token) return false;
    if (!this.state.document || !activeDocumentPages(this.state.document).some(page => page.id === pageId)) return false;
    if (existing) return true;
    const draft = this.state.surfaces[pageId]?.annotationDraft;
    this.inputs.set(pageId, { token, phase: draft ? 'annotation' : this.state.surfaces[pageId]?.textDraft ? 'text' : 'idle' });
    // Reclaiming even with the same token invalidates callbacks from the released form.
    this.update(draft ? this.surfaceFields(pageId, { annotationDraft: { ...draft, draftId: this.makeId() } }) : {}); return true;
  }
  canEditPage(pageId: string, token: symbol): boolean {
    return this.enabled() && this.state.ready && !!this.state.document && !this.pending && !this.resolution
      && (this.state.heads.length <= 1 || this.explicitCheckout)
      && this.inputs.get(pageId)?.token === token
      && activeDocumentPages(this.state.document).some(page => page.id === pageId)
      && Object.entries(this.state.surfaces).every(([id, surface]) => !surface.annotationDraft && (!surface.textDraft || id === pageId))
      && [...this.inputs].every(([id, input]) => input.phase === 'idle' || (id === pageId && input.token === token));
  }
  setInput(pageId: string, token: symbol, phase: InputState['phase']): boolean {
    const input = this.inputs.get(pageId);
    if (!input || input.token !== token) return false;
    if (this.state.surfaces[pageId]?.annotationDraft || phase === 'annotation') return false;
    if (this.state.surfaces[pageId]?.textDraft && phase !== 'text') return false;
    if (phase !== 'idle' && !this.canEditPage(pageId, token)) return false;
    // A read started before this input belongs to an older gesture base, even if
    // the input finishes before the asynchronous read returns.
    if (phase !== 'idle') this.readGeneration++;
    this.inputs.set(pageId, { token, phase }); this.update({}); return true;
  }
  releasePage(pageId: string, token: symbol) {
    if (this.inputs.get(pageId)?.token === token) { this.inputs.delete(pageId); this.update({}); }
  }
  private ownedPage(pageId: string, token: symbol) {
    return this.enabled() && this.inputs.get(pageId)?.token === token
      ? this.state.document && activeDocumentPages(this.state.document).find(page => page.id === pageId) : undefined;
  }
  private surfaceFields(pageId: string, fields: Partial<DocumentSurfaceState>): Pick<DocumentEditState, 'surfaces'> {
    return { surfaces: { ...this.state.surfaces, [pageId]: { ...(this.state.surfaces[pageId] ?? { selectedIds: [], textDraft: null, annotationDraft: null }), ...fields } } };
  }
  setSelection(pageId: string, token: symbol, ids: string[]): boolean {
    if (!this.ownedPage(pageId, token)) return false;
    this.update(this.surfaceFields(pageId, { selectedIds: [...new Set(ids)] })); return true;
  }
  beginText(pageId: string, token: symbol, draft: Omit<DocumentTextDraft, 'baseVersion'>): boolean {
    const page = this.ownedPage(pageId, token);
    if (!page || !this.canEditPage(pageId, token) || this.inputs.get(pageId)?.phase !== 'idle'
      || Object.values(this.state.surfaces).some(surface => surface.textDraft)) return false;
    const annotation = page.annotations.find(value => value.id === draft.id);
    if (annotation && (annotation.kind !== 'ink' || annotation.geometry.kind !== 'text')) return false;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(draft.id)
      || !Number.isFinite(draft.at.x) || !Number.isFinite(draft.at.y)) return false;
    this.readGeneration++;
    this.inputs.set(pageId, { token, phase: 'text' });
    this.update(this.surfaceFields(pageId, { textDraft: { ...structuredClone(draft), baseVersion: this.state.document!.version } })); return true;
  }
  updateText(pageId: string, token: symbol, text: string): boolean {
    const draft = this.state.surfaces[pageId]?.textDraft;
    if (!this.ownedPage(pageId, token) || !draft) return false;
    this.update(this.surfaceFields(pageId, { textDraft: { ...draft, text } })); return true;
  }
  cancelText(pageId: string, token: symbol): boolean {
    if (!this.ownedPage(pageId, token) || !this.state.surfaces[pageId]?.textDraft) return false;
    this.readGeneration++;
    this.inputs.set(pageId, { token, phase: 'idle' });
    this.update(this.surfaceFields(pageId, { textDraft: null })); return true;
  }
  beginAnnotationDraft(pageId: string, token: symbol, input: AnnotationDraftStart): string | null {
    const page = this.ownedPage(pageId, token);
    if (!page || !this.canEditPage(pageId, token) || this.inputs.get(pageId)?.phase !== 'idle'
      || Object.values(this.state.surfaces).some(surface => surface.textDraft || surface.annotationDraft)) return null;
    try {
      const draftId = this.makeId();
      const draft = beginCanonicalAnnotationDraft(page, this.state.document!.version, draftId, structuredClone(input),
        { id: input.kind === 'create-sticky' || input.kind === 'create-highlight' ? this.makeId() : input.annotation.id,
          createdAt: new Date().toISOString() });
      this.readGeneration++; this.inputs.set(pageId, { token, phase: 'annotation' });
      this.update(this.surfaceFields(pageId, { annotationDraft: draft })); return draftId;
    } catch { return null; }
  }
  updateAnnotationDraft(pageId: string, token: symbol, draftId: string, patch: AnnotationDraftPatch): boolean {
    const draft = this.state.surfaces[pageId]?.annotationDraft;
    if (!this.ownedPage(pageId, token) || !draft || draft.draftId !== draftId || this.inputs.get(pageId)?.phase !== 'annotation') return false;
    try {
      const next = updateCanonicalAnnotationDraft(draft, structuredClone(patch));
      this.update(this.surfaceFields(pageId, { annotationDraft: next })); return true;
    } catch { return false; }
  }
  cancelAnnotationDraft(pageId: string, token: symbol, draftId: string): boolean {
    const draft = this.state.surfaces[pageId]?.annotationDraft;
    if (!this.ownedPage(pageId, token) || !draft || draft.draftId !== draftId || this.inputs.get(pageId)?.phase !== 'annotation') return false;
    this.readGeneration++; this.inputs.set(pageId, { token, phase: 'idle' });
    this.update(this.surfaceFields(pageId, { annotationDraft: null })); return true;
  }
  canRepositionAnnotationDraft(pageId: string, token: symbol, draftId: string): boolean {
    const draft = this.state.surfaces[pageId]?.annotationDraft;
    return !!this.ownedPage(pageId, token) && this.state.ready && !this.pending && !!draft && draft.draftId === draftId
      && this.inputs.get(pageId)?.phase === 'annotation'
      && [...this.inputs].every(([id, input]) => id === pageId || input.phase === 'idle')
      && Object.entries(this.state.surfaces).every(([id, surface]) => !surface.textDraft && (!surface.annotationDraft || id === pageId));
  }
  async commitAnnotationDraft(pageId: string, token: symbol, draftId: string, mayCommit?: () => boolean): Promise<DocumentCommandResult> {
    const reason = this.refusal(pageId, token, true); if (reason) return { status: 'refused', reason };
    const draft = this.state.surfaces[pageId]?.annotationDraft, current = this.state.document!, scopeKey = canonicalJson(this.repository.scope);
    if (!draft || draft.draftId !== draftId || this.inputs.get(pageId)?.phase !== 'annotation') return { status: 'refused', reason: 'annotation-draft-owner' };
    try {
      // Keep the form and its guard throughout I/O. A changed owner/form or a new remote head requires explicit recovery.
      const read = await this.repository.read(this.documentId);
      const refused = this.refusal(pageId, token, true); if (refused) return { status: 'refused', reason: refused };
      if (this.state.surfaces[pageId]?.annotationDraft !== draft || draft.draftId !== draftId || this.state.document !== current)
        return { status: 'refused', reason: 'annotation-draft-changed' };
      if (canonicalJson(this.repository.scope) !== scopeKey || read.checkpoint.libraryId !== this.repository.scope.libraryId || read.checkpoint.root.id !== this.documentId
        || read.checkpoint.root.kind !== 'document') return { status: 'refused', reason: 'annotation-draft-scope' };
      if (canonicalJson([...read.heads].sort()) !== canonicalJson([...this.state.heads].sort()) || !read.heads.includes(current.version) || read.waiting.length)
        return { status: 'refused', reason: 'annotation-draft-heads-changed' };
      const latest = new EditGraph(read.checkpoint).snapshot(current.version);
      if (latest?.kind !== 'document' || canonicalJson(latest) !== canonicalJson(current)) return { status: 'refused', reason: 'annotation-draft-base-changed' };
      const page = activeDocumentPages(current).find(value => value.id === pageId);
      if (!page) return { status: 'refused', reason: 'missing-page' };
      const changes = canonicalAnnotationDraftChanges(page, current.version, draft);
      if (mayCommit && mayCommit() !== true) return { status: 'refused', reason: 'annotation-draft-admission' };
      // Admission is caller code: it may have changed scope, ownership or the retained form while inspecting UI state.
      const admissionRefusal = this.refusal(pageId, token, true);
      if (admissionRefusal) return { status: 'refused', reason: admissionRefusal };
      if (canonicalJson(this.repository.scope) !== scopeKey || this.state.surfaces[pageId]?.annotationDraft !== draft
        || this.inputs.get(pageId)?.phase !== 'annotation' || this.state.document !== current)
        return { status: 'refused', reason: 'annotation-draft-changed' };
      const accepted = () => {
        this.inputs.set(pageId, { token, phase: 'idle' });
        return this.surfaceFields(pageId, { annotationDraft: null });
      };
      if (!changes.length) { this.readGeneration++; this.update(accepted()); return { status: 'unchanged' }; }
      return this.execute({ kind: 'page', id: this.makeId(), libraryId: this.repository.scope.libraryId,
        targetId: this.documentId, parents: [draft.baseVersion], expected: structuredClone(draft.expected), changes }, undefined, undefined, accepted);
    } catch (cause) { return { status: 'refused', reason: String(cause) }; }
  }
  canNavigate = () => !this.pending && !this.resolution && [...this.inputs.values()].every(input => input.phase === 'idle')
    && Object.values(this.state.surfaces).every(surface => !surface.textDraft && !surface.annotationDraft);
  private refusal(pageId?: string, token?: symbol, allowPageInput = false): string | undefined {
    if (!this.enabled()) return 'session-inactive';
    if (!this.state.ready || !this.state.document) return 'not-ready';
    if (this.pending || this.resolution) return 'pending-save';
    if (this.state.heads.length > 1 && !this.explicitCheckout) return 'checkout-required';
    if (pageId && (!token || this.inputs.get(pageId)?.token !== token)) return 'editor-owner';
    if ([...this.inputs].some(([id, input]) => input.phase !== 'idle' && !(allowPageInput && id === pageId && input.token === token))
      || Object.entries(this.state.surfaces).some(([id, surface]) => (surface.textDraft || surface.annotationDraft) && !(allowPageInput && id === pageId))) return 'input-active';
  }
  async commitPageInput(pageId: string, token: symbol, changes: AnnotationChange[], baseVersion?: string): Promise<DocumentCommandResult> {
    const reason = this.refusal(pageId, token, true); if (reason) return { status: 'refused', reason };
    if (this.state.surfaces[pageId]?.annotationDraft) return { status: 'refused', reason: 'annotation-draft-operation-required' };
    const current = this.state.document!, page = activeDocumentPages(current).find(value => value.id === pageId);
    if (!page) return { status: 'refused', reason: 'missing-page' };
    const draft = this.state.surfaces[pageId]?.textDraft;
    if ((baseVersion !== undefined && baseVersion !== current.version) || (draft && draft.baseVersion !== current.version))
      return { status: 'refused', reason: 'stale-version' };
    if (draft) {
      const existing = page.annotations.find(annotation => annotation.id === draft.id);
      const change = changes[0];
      const unchangedText = changes.length === 0 && existing?.kind === 'ink'
        && existing.geometry.kind === 'text' && existing.geometry.text === draft.text;
      const matchingText = changes.length === 1 && change
        && change.type === (existing ? 'update' : 'create')
        && (change.type === 'create' || change.type === 'update')
        && change.annotation.id === draft.id && change.annotation.kind === 'ink'
        && change.annotation.geometry.kind === 'text' && change.annotation.geometry.text === draft.text;
      if (!unchangedText && !matchingText) return { status: 'refused', reason: 'text-draft-operation-required' };
    }
    const accepted = () => {
      this.inputs.set(pageId, { token, phase: 'idle' });
      return this.surfaceFields(pageId, { textDraft: null });
    };
    if (!changes.length) { this.readGeneration++; this.update(accepted()); return { status: 'unchanged' }; }
    const batch: PageEditBatch = { kind: 'page', id: this.makeId(), libraryId: this.repository.scope.libraryId,
      targetId: this.documentId, parents: [current.version], expected: pageExpectation(page), changes: structuredClone(changes) };
    return this.execute(batch, undefined, undefined, accepted);
  }
  async editPage(pageId: string, token: symbol, changes: AnnotationChange[]): Promise<DocumentCommandResult> {
    const reason = this.refusal(pageId, token); if (reason) return { status: 'refused', reason };
    if (!changes.length) return { status: 'unchanged' };
    const current = this.state.document!, page = activeDocumentPages(current).find(page => page.id === pageId);
    if (!page) return { status: 'refused', reason: 'missing-page' };
    const batch: PageEditBatch = { kind: 'page', id: this.makeId(), libraryId: this.repository.scope.libraryId,
      targetId: this.documentId, parents: [current.version], expected: pageExpectation(page), changes: structuredClone(changes) };
    return this.execute(batch);
  }
  async editDocument(changes: PageChange[]): Promise<DocumentCommandResult> {
    const reason = this.refusal(); if (reason) return { status: 'refused', reason };
    if (!changes.length) return { status: 'unchanged' };
    return this.execute({ kind: 'document', id: this.makeId(), libraryId: this.repository.scope.libraryId,
      targetId: this.documentId, parents: [this.state.document!.version], changes: structuredClone(changes) });
  }
  /** Build revision-sensitive page changes against one immutable base and the final batch ID. */
  async buildDocumentEdit(build: (document: DocumentSnapshot, batchId: string) => PageChange[]): Promise<DocumentCommandResult> {
    const reason = this.refusal(); if (reason) return { status: 'refused', reason };
    const current = this.state.document!;
    try {
      const id = this.makeId(), changes = structuredClone(build(current, id));
      const refused = this.refusal(); if (refused) return { status: 'refused', reason: refused };
      if (this.state.document !== current) return { status: 'refused', reason: 'stale-document' };
      if (!changes.length) return { status: 'unchanged' };
      return this.execute({ kind: 'document', id, libraryId: this.repository.scope.libraryId,
        targetId: this.documentId, parents: [current.version], changes });
    } catch (error) { return { status: 'refused', reason: String(error) }; }
  }
  private async execute(batch: PageEditBatch | DocumentEditBatch, history?: HistoryRecord, affectedPages?: string[], accepted?: () => Partial<DocumentEditState>): Promise<DocumentCommandResult> {
    const before = this.state.document!;
    let after: DocumentSnapshot;
    try {
      after = applyBatch(before, batch) as DocumentSnapshot;
      if (canonicalJson(documentContent(after)) === canonicalJson(documentContent(before))) {
        if (accepted) { this.readGeneration++; this.update(accepted()); }
        return { status: 'unchanged' };
      }
    } catch (error) { return { status: 'refused', reason: String(error) }; }
    const record = history ?? { operationId: batch.id, beforeVersion: before.version, afterVersion: batch.id, undoRequested: false };
    const command = { batch, history: record, affectedPages: affectedPages ?? this.affectedPages(batch, before) };
    this.readGeneration++;
    this.pending = this.createPending(command, before, after);
    this.update({ ...accepted?.(), document: after, selectedVersion: after.version, affectedPages: command.affectedPages,
      phase: 'saving', error: '', canUndo: !history?.action, canRedo: false });
    await this.retry();
    return { status: 'applied', operationId: batch.id };
  }
  private affectedPages(batch: PageEditBatch | DocumentEditBatch, before: DocumentSnapshot): string[] {
    return batch.kind === 'page' ? [batch.expected.pageId]
      : batch.changes.flatMap(change => change.type === 'mapping' ? change.bindings.map(binding => binding.original.pageId)
        : change.type === 'translation' ? [...(before.translation?.pages ?? []), ...(change.translation?.pages ?? [])].map(page => page.id)
          : [change.type === 'insert' ? change.page.id : change.expected.pageId]);
  }
  private createPending(command: HistoryCommand, before: DocumentSnapshot, after: DocumentSnapshot, intent?: EditIntent): Pending {
    const { batch, history } = command;
    const lifecycle = new BatchCommitSession(this.repository, { batch, history }, () => {
      const id = this.makeId(), inverse = inverseDocumentEdit(this.versions(), batch.id, after, id);
      return { batch: inverse, history: { operationId: id, beforeVersion: after.version, afterVersion: id,
        undoRequested: false, action: { kind: 'undo', operationId: batch.id } } };
    }, intent?.dispatched ? 'unknown' : 'new', { journal: this.journal, ...(intent ? { intent } : {}) });
    return { command, before, after, lifecycle };
  }
  async retry(): Promise<void> {
    if (!this.enabled()) return;
    if (this.resolution) {
      if (this.resolutionDiscarding) return;
      const pending = this.resolution; this.update({ phase: 'saving', error: '' });
      await pending.lifecycle.flush(); if (this.resolution !== pending) return;
      const result = pending.lifecycle.getSnapshot();
      if (result.phase !== 'durable') { this.update({ phase: result.phase === 'unknown' ? 'unknown' : 'aborted', error: result.error }); return; }
      this.preferredVersion = pending.batch.id; this.resolution = undefined;
      this.update({ ready: false, phase: 'idle', canUndo: false, canRedo: false }); await this.refresh(); return;
    }
    const pending = this.pending; if (!pending) return;
    this.update({ phase: 'saving', error: '' });
    await pending.lifecycle.flush();
    if (this.pending !== pending) return;
    const result = pending.lifecycle.getSnapshot();
    if (pending.lifecycle.canLeave()) {
      const preferred = result.phase === 'cancelled' ? pending.before.version : result.phase === 'undone' ? result.inverseId : pending.after.version;
      // Polling may start synchronously when pending is released. Preserve the
      // chosen outcome until a read adopts it, even if that read is superseded.
      this.preferredVersion = preferred;
      this.pending = undefined; this.update({ ready: false, phase: 'idle', canUndo: false, canRedo: false });
      await this.refresh();
    } else this.update({ phase: result.phase === 'unknown' ? 'unknown' : 'aborted', error: result.error });
  }
  async undo(): Promise<DocumentCommandResult> {
    if (!this.enabled()) return { status: 'refused', reason: 'session-inactive' };
    if (this.pending) {
      if (this.pending.command.history.action) return { status: 'refused', reason: 'pending-history-save' };
      const id = this.pending.command.batch.id;
      this.pending.lifecycle.requestUndo(); await this.retry(); return { status: 'applied', operationId: id };
    }
    return this.compensate('undo');
  }
  async redo(): Promise<DocumentCommandResult> { return this.compensate('redo'); }
  private async compensate(kind: 'undo' | 'redo'): Promise<DocumentCommandResult> {
    const reason = this.refusal(); if (reason) return { status: 'refused', reason };
    try {
      const command = this.history.command(kind, this.versions(), this.state.document!, this.makeId());
      return command ? this.execute(command.batch, command.history, command.affectedPages) : { status: 'unchanged' };
    } catch (error) { return { status: 'refused', reason: String(error) }; }
  }
}
