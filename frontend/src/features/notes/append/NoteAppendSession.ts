import type { ContentRepository } from '../../../runtime/edits/ports.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';
import { assertAnnotation, canonicalJson } from '../../../runtime/edits/editModel.ts';
import { formatMarkdownCitationUri, parseMarkdownCitationUri, markdownCitationLink, markdownQuote, type CitationTarget } from '../../../runtime/markdown/markdownCitations.ts';
import type { MarkdownEditSession } from '../markdown/MarkdownEditSession.ts';
import { freezeAnnotationExport, type AnnotationBrowserExport } from '../../library/annotations/canonicalAnnotationBrowser.ts';
import type { LibraryCreateIdentity, LibraryCreateInput } from '../../library/LibrarySession.ts';
import type { AnnotationNoteCreation, NoteAppendDraftPort, SavedAnnotationAppend } from './NoteAppendDraftPort.ts';
export type { NoteAppendDraftPort, SavedAnnotationAppend } from './NoteAppendDraftPort.ts';

export type NoteAppendInput = ({ target: CitationTarget; label?: string } & (
  { kind: 'quote'; text: string } | { kind: 'image'; bytes: () => Promise<Uint8Array>; mediaType: string; alt?: string }))
  | { kind: 'annotations'; result: AnnotationBrowserExport };
export type NoteAppendState = {
  request: { id: string; input: NoteAppendInput } | null;
  candidates: readonly { id: string; title: string }[]; destinationId: string | null;
  phase: 'idle' | 'choosing' | 'loading' | 'saving' | 'failed' | 'accepted' | 'canceled'; busy: boolean; error: string;
  creation: AnnotationNoteCreation | null;
};
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(immutable); Object.freeze(value); } return value;
}
function validatedExport(value: AnnotationBrowserExport, libraryId: string): AnnotationBrowserExport {
  if (!value || !Array.isArray(value.rows) || !value.rows.length || typeof value.markdown !== 'string') throw new Error('append-annotations-invalid');
  for (const row of value.rows) {
    if (row.libraryId !== libraryId || !validId(row.documentId) || !validId(row.pageId) || !validId(row.backgroundRevision)
      || !Array.isArray(row.sourceVersions) || !row.sourceVersions.length || !row.sourceVersions.every(validId)
      || new Set(row.sourceVersions).size !== row.sourceVersions.length || typeof row.title !== 'string'
      || !Number.isInteger(row.pageIndex) || row.pageIndex < 0 || !Number.isInteger(row.annotationIndex) || row.annotationIndex < 0
      || !['original', 'translated'].includes(row.surface) || !row.annotation || !['sticky', 'highlight'].includes(row.annotation.kind)
      || row.annotationId !== row.annotation.id) throw new Error('append-annotations-invalid');
    assertAnnotation(row.annotation, row.backgroundRevision);
    const expected = { libraryId, documentId: row.documentId, pageId: row.pageId, backgroundRevision: row.backgroundRevision,
      surface: row.surface, anchor: { xPt: row.annotation.anchor.x, yPt: row.annotation.anchor.y } };
    if (canonicalJson(row.target) !== canonicalJson(expected)
      || row.key !== canonicalJson([libraryId, row.documentId, row.surface, row.pageId, row.backgroundRevision, row.annotation])) throw new Error('append-annotations-location');
  }
  const result = freezeAnnotationExport(value.rows);
  if (result.markdown !== value.markdown) throw new Error('append-annotations-markdown');
  return result;
}

/** A retained source-document request delegates every content write to its destination authority. */
export class NoteAppendSession {
  private state: NoteAppendState = Object.freeze({ request: null, candidates: Object.freeze([]), destinationId: null, phase: 'idle', busy: false, error: '', creation: null });
  private readonly repository: Pick<ContentRepository, 'scope' | 'read'>;
  private readonly getMarkdown: (id: string) => MarkdownEditSession;
  private readonly isActive: () => boolean;
  private readonly makeId: () => string;
  private readonly scopeKey: string;
  private readonly listeners = new Set<() => void>();
  private target?: MarkdownEditSession;
  private unsubscribe?: () => void;
  private generation = 0;
  private observedImagePreparation = false;
  private readonly drafts?: NoteAppendDraftPort;
  private readonly createNote?: (input: LibraryCreateInput & { kind: 'markdown' }, identity: LibraryCreateIdentity) => Promise<boolean>;
  private protectedDraft = false;
  private draftFailed = false;
  private restored = false;
  private available = true;
  private creationFlights = 0;
  private restoredDestinationUnverified = false;
  private appendStarted = false;
  constructor(options: { repository: Pick<ContentRepository, 'scope' | 'read'>; getMarkdown(id: string): MarkdownEditSession; isActive: () => boolean; makeId?: () => string;
    drafts?: NoteAppendDraftPort; createNote?: (input: LibraryCreateInput & { kind: 'markdown' }, identity: LibraryCreateIdentity) => Promise<boolean> }) {
    this.repository = options.repository; this.getMarkdown = options.getMarkdown; this.isActive = options.isActive;
    this.makeId = options.makeId ?? (() => crypto.randomUUID()); this.scopeKey = canonicalJson(options.repository.scope);
    if (options.drafts && canonicalJson(options.drafts.scope) !== this.scopeKey) throw new Error('append-draft-scope');
    this.drafts = options.drafts; this.createNote = options.createNote;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<NoteAppendState>) { this.state = Object.freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener()); }
  private active() { return this.available && this.isActive() && canonicalJson(this.repository.scope) === this.scopeKey; }
  setAvailable(value: boolean) {
    if (value === this.available) return;
    this.available = value;
    if (!value) { this.generation++; this.update({ busy: false }); }
    else this.observe();
  }
  private accepted() { return !!this.state.request && this.target?.appendStatus(this.state.request.id) === 'accepted'; }
  canLeave = () => !this.protectedDraft && !this.draftFailed && (!this.state.request || this.state.phase === 'canceled' || this.state.phase === 'accepted' || this.accepted());
  hasRecovery = () => this.protectedDraft || this.draftFailed || this.state.request?.input.kind === 'annotations' && !this.canLeave();
  isRecoveryBlocked = () => this.protectedDraft;
  restore = (): boolean => {
    if (this.restored && !this.protectedDraft || this.state.request) return !this.protectedDraft;
    this.restored = true;
    if (!this.drafts) return true;
    try {
      if (canonicalJson(this.drafts.scope) !== this.scopeKey || canonicalJson(this.repository.scope) !== this.scopeKey) throw new Error('append-draft-scope');
      const raw = this.drafts.read(); if (raw === undefined) { this.protectedDraft = false; this.update({ phase: 'idle', error: '' }); return true; }
      const saved = raw as SavedAnnotationAppend;
      if (!saved || saved.version !== 1 || !validId(saved.request?.id) || saved.request.input.kind !== 'annotations'
        || typeof saved.appendStarted !== 'boolean' || saved.appendStarted && saved.destinationId === null
        || saved.destinationId !== null && !validId(saved.destinationId)) throw new Error('append-draft-invalid');
      const result = validatedExport(saved.request.input.result, this.repository.scope.libraryId);
      const creation = saved.creation;
      if (creation !== null && (!creation || creation.input?.kind !== 'markdown' || typeof creation.input.title !== 'string' || !creation.input.title.trim()
        || !creation.identity || ![creation.identity.itemId, creation.identity.contentVersion, creation.identity.batchId].every(validId)
        || new Set(Object.values(creation.identity)).size !== 3 || saved.destinationId !== creation.identity.itemId
        || creation.input.ownerId != null && !validId(creation.input.ownerId) || creation.input.folderId != null && !validId(creation.input.folderId)
        || creation.input.ownerId != null && creation.input.folderId != null)) throw new Error('append-draft-creation');
      this.protectedDraft = false;
      this.appendStarted = saved.appendStarted;
      this.restoredDestinationUnverified = saved.appendStarted;
      this.update({ request: immutable({ id: saved.request.id, input: { kind: 'annotations', result } }), destinationId: saved.destinationId,
        creation: creation ? immutable(structuredClone(creation)) : null, phase: 'failed', error: 'append-recovery-pending' }); return true;
    } catch (error) { this.protectedDraft = true; this.update({ phase: 'failed', error: String(error) }); return false; }
  };
  private saveDraft(): boolean {
    if (this.state.request?.input.kind !== 'annotations') return true;
    try {
      if (this.protectedDraft || !this.drafts || canonicalJson(this.drafts.scope) !== this.scopeKey) throw new Error('append-draft-unavailable');
      this.drafts.write(structuredClone({ version: 1, request: { id: this.state.request.id, input: this.state.request.input },
        destinationId: this.state.destinationId, appendStarted: this.appendStarted, creation: this.state.creation })); this.draftFailed = false; return true;
    } catch (error) { this.draftFailed = true; this.update({ phase: 'failed', error: String(error) }); return false; }
  }
  private clearDraft(): boolean {
    if (this.state.request?.input.kind !== 'annotations') return true;
    try {
      if (this.protectedDraft || !this.drafts || canonicalJson(this.drafts.scope) !== this.scopeKey) throw new Error('append-draft-unavailable');
      this.drafts.remove(); this.draftFailed = false; if (this.state.error) this.update({ error: '' }); return true;
    } catch (error) { this.draftFailed = true; this.update({ error: String(error) }); return false; }
  }
  private observe() {
    if (!this.active()) return;
    const request = this.state.request;
    if (request?.input.kind === 'image' && this.target?.canCancelImageAppend(request.id)) this.observedImagePreparation = true;
    if (request?.input.kind === 'image' && this.observedImagePreparation && this.state.phase !== 'accepted'
      && this.target?.appendStatus(request.id) === 'unseen') {
      this.finishCancel(); return;
    }
    if (this.accepted() && this.state.phase !== 'accepted') { this.update({ phase: 'accepted', error: '' }); this.clearDraft(); }
    else this.update({}); // Exact image cancellation availability can change in the destination UI.
  }
  begin = async (input: NoteAppendInput): Promise<boolean> => {
    if (!this.restore()) return false;
    if (!this.active() || this.state.busy || !this.canLeave()) return false;
    let copy: NoteAppendInput;
    try {
      if (input.kind === 'annotations') copy = immutable({ kind: 'annotations', result: validatedExport(input.result, this.repository.scope.libraryId) });
      else {
      const target = parseMarkdownCitationUri(formatMarkdownCitationUri(input.target));
      if (!target || target.libraryId !== this.repository.scope.libraryId) throw new Error('append-citation-scope');
      if (input.kind !== 'quote' && input.kind !== 'image' || input.kind === 'quote' && typeof input.text !== 'string'
        || input.kind === 'image' && (typeof input.bytes !== 'function' || typeof input.mediaType !== 'string')) throw new Error('append-input-invalid');
      if (target.anchor) Object.freeze(target.anchor); Object.freeze(target);
      copy = Object.freeze({ ...input, target });
      }
    } catch (error) { this.update({ error: String(error) }); return false; }
    this.unsubscribe?.(); this.unsubscribe = undefined; this.target = undefined; this.generation++; this.observedImagePreparation = false;
    this.restoredDestinationUnverified = false;
    this.appendStarted = false;
    this.update({ request: Object.freeze({ id: this.makeId(), input: copy }), destinationId: null, candidates: Object.freeze([]), phase: 'choosing', error: '', creation: null });
    if (!this.saveDraft()) return false;
    return this.loadCandidates();
  };
  private async candidates() {
    const read = await this.repository.read(this.repository.scope.libraryId);
    if (read.checkpoint.libraryId !== this.repository.scope.libraryId || read.heads.length !== 1) throw new Error('append-catalog-head-selection');
    const library = new EditGraph(read.checkpoint).snapshot(read.heads[0]);
    if (library?.kind !== 'library' || library.id !== this.repository.scope.libraryId) throw new Error('append-catalog-invalid');
    const deleted = new Set(library.deletions.filter(value => value.active).flatMap(value => value.itemIds));
    return library.items.filter(item => item.kind === 'markdown' && !deleted.has(item.id)).map(({ id, title }) => Object.freeze({ id, title }));
  }
  private loadCandidates = async (): Promise<boolean> => {
    if (!this.active() || this.state.busy || !this.state.request) return false;
    const generation = this.generation;
    this.update({ busy: true, phase: 'loading', error: '' });
    try {
      const candidates = await this.candidates();
      if (generation !== this.generation || !this.active()) return false;
      this.update({ candidates: Object.freeze(candidates), phase: 'choosing' }); return true;
    } catch (error) { if (generation === this.generation) this.update({ phase: 'failed', error: String(error) }); return false; }
    finally { if (generation === this.generation) this.update({ busy: false }); }
  };
  submit = async (noteId: string): Promise<boolean> => {
    const request = this.state.request;
    if (!request || !validId(noteId) || !this.active() || this.state.busy || this.state.phase === 'canceled') return false;
    if (this.accepted()) { this.observe(); return this.clearDraft(); }
    if (this.state.destinationId && this.state.destinationId !== noteId) return false;
    const generation = this.generation, alive = () => generation === this.generation && this.active();
    this.update({ busy: true, destinationId: noteId, phase: 'saving', error: '' });
    try {
      if (!this.saveDraft()) return false;
      const candidates = await this.candidates(); if (!alive()) return false;
      if (!candidates.some(value => value.id === noteId)) throw new Error('append-target-unavailable');
      const read = await this.repository.read(noteId); if (!alive()) return false;
      if (read.checkpoint.libraryId !== this.repository.scope.libraryId || read.checkpoint.root.id !== noteId
        || read.checkpoint.root.kind !== 'markdown' || !read.heads.length) throw new Error('append-target-invalid');
      const target = this.getMarkdown(noteId);
      if (target.documentId !== noteId) throw new Error('append-target-authority');
      if (this.target !== target) { this.unsubscribe?.(); this.target = target; this.unsubscribe = target.subscribe(() => this.observe()); }
      if ((!target.getSnapshot().ready || target.canLeave()) && !await target.refresh()) throw new Error('append-target-not-ready');
      if (!alive()) return false;
      // Only the recovered destination authority can distinguish an unhanded request from its
      // durable scratch/journal append. A source restart alone never grants cancellation.
      this.restoredDestinationUnverified = false;
      const input = request.input;
      if (target.appendStatus(request.id) !== 'accepted') {
        if (input.kind === 'quote' || input.kind === 'annotations') {
          const text = input.kind === 'annotations' ? `\n\n${input.result.markdown}` : `\n\n${markdownQuote(input.text, input.target, input.label)}\n`;
          if (input.kind === 'annotations' && target.appendStatus(request.id) === 'unseen') {
            this.appendStarted = true;
            if (!this.saveDraft()) return false;
          }
          if (target.appendStatus(request.id) === 'unseen' && !target.appendText(request.id, text))
            throw new Error('append-target-blocked');
        } else if (!await target.appendImage({ appendId: request.id, bytes: async () => {
          if (!alive()) throw new Error('append-inactive');
          const bytes = Uint8Array.from(await input.bytes());
          if (!alive()) throw new Error('append-inactive'); return bytes;
        }, mediaType: input.mediaType, alt: input.alt, suffix: `\n${markdownCitationLink(input.target, input.label)}\n` })) throw new Error('append-image-unconfirmed');
      }
      if (!alive()) return false;
      await target.flush(); if (!alive()) return false;
      if (target.appendStatus(request.id) !== 'accepted') throw new Error(target.getSnapshot().error || 'append-save-unconfirmed');
      this.update({ phase: 'accepted', error: '' }); return this.clearDraft();
    } catch (error) { if (generation === this.generation) this.update({ phase: this.accepted() ? 'accepted' : 'failed', error: this.accepted() ? '' : String(error) }); return false; }
    finally { if (generation === this.generation) this.update({ busy: false }); }
  };
  createAndSubmit = async (input: Omit<LibraryCreateInput, 'kind'>): Promise<boolean> => {
    if (!this.restore() || !this.active() || this.state.busy || this.creationFlights || this.state.phase === 'canceled'
      || this.state.request?.input.kind !== 'annotations' || !this.createNote) return false;
    if (this.accepted()) { this.observe(); return this.clearDraft(); }
    const existing = this.state.creation;
    if (this.state.destinationId && !existing) return false;
    const fixed = { kind: 'markdown' as const, title: input.title, ownerId: input.ownerId ?? null, folderId: input.folderId ?? null };
    if (existing && canonicalJson(existing.input) !== canonicalJson(fixed)) return false;
    if (!fixed.title.trim() || fixed.ownerId !== null && !validId(fixed.ownerId) || fixed.folderId !== null && !validId(fixed.folderId)
      || fixed.ownerId !== null && fixed.folderId !== null) return false;
    const creation = existing ?? immutable({ input: fixed, identity: { itemId: this.makeId(), contentVersion: this.makeId(), batchId: this.makeId() } });
    const generation = this.generation;
    this.update({ creation, destinationId: creation.identity.itemId, busy: true, phase: 'saving', error: '' });
    let created = false;
    try {
      if (!this.saveDraft()) return false;
      this.creationFlights++;
      try { created = await this.createNote(creation.input, creation.identity); }
      finally { this.creationFlights--; if (this.active() && generation !== this.generation) this.update({}); }
      if (!this.active() || generation !== this.generation) return false;
      if (!created) { this.update({ phase: 'failed', error: 'append-create-unconfirmed' }); return false; }
    } catch (error) { if (generation === this.generation) this.update({ phase: 'failed', error: String(error) }); return false; }
    finally { if (generation === this.generation) this.update({ busy: false }); }
    return created && this.active() && generation === this.generation ? this.submit(creation.identity.itemId) : false;
  };
  retry = async (): Promise<boolean> => {
    if (!this.restore() || !this.active() || this.state.busy || this.state.phase === 'canceled') return false;
    if (this.state.phase === 'accepted' || this.accepted()) return this.clearDraft();
    // Cleanup may have failed after acceptance. Recover that receipt from the body before consulting
    // the now-mutable catalog (the destination may since have been renamed or logically deleted).
    const request = this.state.request, destination = this.state.destinationId;
    if (request?.input.kind === 'annotations' && destination) {
      const generation = this.generation;
      this.update({ busy: true });
      try {
        const read = await this.repository.read(destination);
        if (!this.active() || generation !== this.generation) return false;
        if (read.checkpoint.libraryId !== this.repository.scope.libraryId || read.checkpoint.root.id !== destination
          || read.checkpoint.root.kind !== 'markdown') throw new Error('append-target-invalid');
        const graph = new EditGraph(read.checkpoint);
        if (read.heads.some(head => { const value = graph.snapshot(head); return value?.kind === 'markdown' && value.appendIds.includes(request.id); })) {
          this.update({ phase: 'accepted', error: '' }); return this.clearDraft();
        }
        if (this.restoredDestinationUnverified || this.target?.appendStatus(request.id) === 'pending') {
          // Recover an existing operation before admitting a new one through the live catalog.
          // Logical deletion must neither hide a pending append nor prevent proving it was never handed off.
          const target = this.getMarkdown(destination);
          if (target.documentId !== destination) throw new Error('append-target-authority');
          if (this.target !== target) { this.unsubscribe?.(); this.target = target; this.unsubscribe = target.subscribe(() => this.observe()); }
          if ((!target.getSnapshot().ready || target.canLeave()) && !await target.refresh()) throw new Error('append-target-not-ready');
          if (!this.active() || generation !== this.generation) return false;
          this.restoredDestinationUnverified = false;
          if (target.appendStatus(request.id) === 'pending') await target.retry();
          if (!this.active() || generation !== this.generation) return false;
          if (target.appendStatus(request.id) === 'accepted') { this.update({ phase: 'accepted', error: '' }); return this.clearDraft(); }
          if (target.appendStatus(request.id) === 'pending') {
            this.update({ phase: 'failed', error: target.getSnapshot().error || 'append-save-unconfirmed' }); return false;
          }
        }
      } catch (error) {
        if (this.restoredDestinationUnverified) {
          if (this.active() && generation === this.generation) this.update({ phase: 'failed', error: String(error) });
          return false;
        }
        // Requests without a possible handoff still use the ordinary creation/catalog admission below.
      }
      finally { if (generation === this.generation) this.update({ busy: false }); }
      if (!this.active() || generation !== this.generation) return false;
    }
    if (this.state.creation) return this.createAndSubmit(this.state.creation.input);
    if (!this.saveDraft()) return false;
    return this.state.destinationId ? this.submit(this.state.destinationId) : this.loadCandidates();
  };
  canCancel = (): boolean => {
    const id = this.state.request?.id;
    return this.active() && !!id && this.state.phase !== 'accepted' && this.state.phase !== 'canceled'
      && !this.restoredDestinationUnverified
      && (!this.state.creation || !this.state.busy && !this.creationFlights)
      && (!this.target || this.target.appendStatus(id) === 'unseen' || this.target.canCancelImageAppend(id));
  };
  cancel = (): boolean => {
    const id = this.state.request?.id;
    if (!id || !this.canCancel()) return false;
    if (!this.clearDraft()) return false;
    if (this.target?.appendStatus(id) === 'pending' && !this.target.cancelImageAppend(id)) return false;
    if (this.state.phase !== 'canceled') this.finishCancel();
    return true;
  };
  private finishCancel() {
    this.generation++; this.unsubscribe?.(); this.unsubscribe = undefined; this.target = undefined;
    this.observedImagePreparation = false;
    this.update({ phase: 'canceled', busy: false, error: '' });
  }
  dismiss = (): boolean => {
    if (this.state.busy || !this.canLeave()) return false;
    this.generation++; this.unsubscribe?.(); this.unsubscribe = undefined; this.target = undefined;
    this.update({ request: null, candidates: Object.freeze([]), destinationId: null, creation: null, phase: 'idle', error: '' }); return true;
  };
}
