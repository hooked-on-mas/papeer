import type { ContentRepository, EditIntentRepository } from '../../runtime/edits/ports.ts';
import { LibrarySession, type LibraryRepository } from '../library/LibrarySession.ts';
import { DocumentEditSession } from './edit/DocumentEditSession.ts';
import { MarkdownEditSession, type MarkdownImagePort } from '../notes/markdown/MarkdownEditSession.ts';
import type { MarkdownDraftPort } from '../notes/markdown/MarkdownDraftPort.ts';
import { NoteAppendSession } from '../notes/append/NoteAppendSession.ts';
import type { NoteAppendDraftPort } from '../notes/append/NoteAppendDraftPort.ts';
import { AnnotationBrowserSession } from '../library/annotations/AnnotationBrowserSession.ts';
import { canonicalJson } from '../../runtime/edits/editModel.ts';
import type { LibraryQueryPreferencePort } from '../library/query/LibraryQuerySession.ts';

type RegistryRepository = EditIntentRepository & Partial<Pick<ContentRepository, 'publish'>>;
function supportsLibrary(repository: RegistryRepository): repository is LibraryRepository {
  return typeof repository.publish === 'function';
}

export type DocumentSessionsState = { ready: boolean; active: boolean; error: string; unhandledTargets: readonly string[] };
export type ScopeLeaveResult = { status: 'allowed' } | { status: 'refused'; reason: string; targets: string[] };

/** One document authority per repository scope. Views borrow sessions; closing/moving a view never discards one. */
export class DocumentEditSessions {
  private readonly repository: RegistryRepository;
  private librarySession?: LibrarySession;
  private readonly markdownDrafts?: MarkdownDraftPort;
  private readonly markdownImages?: MarkdownImagePort;
  private readonly sessions = new Map<string, DocumentEditSession>();
  private readonly markdownSessions = new Map<string, MarkdownEditSession>();
  private readonly appendSessions = new Map<string, NoteAppendSession>();
  private annotationBrowser?: AnnotationBrowserSession;
  private annotationAppend?: NoteAppendSession;
  private readonly appendDrafts?: NoteAppendDraftPort;
  private readonly queryPreferences?: LibraryQueryPreferencePort;
  private state: DocumentSessionsState = Object.freeze({ ready: false, active: false, error: '', unhandledTargets: Object.freeze([]) });
  private readonly listeners = new Set<() => void>();
  private readonly scopeViewGuards = new Set<() => boolean>();
  registerScopeViewGuard(guard: () => boolean): () => void { this.scopeViewGuards.add(guard); return () => { this.scopeViewGuards.delete(guard); }; }
  private scopeViewHeld(): boolean { try { return [...this.scopeViewGuards].some(guard => !guard()); } catch { return true; } }
  private opening?: Promise<void>;
  private hostGeneration = 0;
  private hostAuthorized = true;
  constructor(repository: RegistryRepository, markdownDrafts?: MarkdownDraftPort, markdownImages?: MarkdownImagePort, appendDrafts?: NoteAppendDraftPort, queryPreferences?: LibraryQueryPreferencePort) {
    if (markdownDrafts && canonicalJson(markdownDrafts.scope) !== canonicalJson(repository.scope)) throw new Error('markdown-draft-scope');
    if (markdownImages && canonicalJson(markdownImages.scope) !== canonicalJson(repository.scope)) throw new Error('markdown-image-scope');
    if (appendDrafts && canonicalJson(appendDrafts.scope) !== canonicalJson(repository.scope)) throw new Error('annotation-append-draft-scope');
    this.repository = repository; this.markdownDrafts = markdownDrafts; this.markdownImages = markdownImages;
    this.appendDrafts = appendDrafts;
    this.queryPreferences = queryPreferences;
  }
  get scope() { return this.repository.scope; }
  isScopeWritable = () => this.state.ready && this.state.active && !this.librarySession?.hasPendingResolution();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<DocumentSessionsState>) {
    if (fields.active === false) this.librarySession?.query.cancel();
    if (fields.active !== undefined) this.annotationBrowser?.setAvailable(fields.active);
    this.state = Object.freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener());
  }
  private canDeleteTargetsSync = (targetIds: readonly string[]): boolean => {
    if (!this.state.ready || !this.state.active || this.annotationRecoveryBlocked()) return false;
    let draftTargets: string[] = [];
    try { draftTargets = this.markdownDrafts?.targets() ?? []; }
    catch { return false; }
    const held = new Set([...this.state.unhandledTargets, ...this.heldTargets(), ...draftTargets]);
    return targetIds.every(id => !held.has(id));
  };
  private prepareDeleteTargets = async (targetIds: readonly string[]): Promise<boolean> => {
    if (!this.canDeleteTargetsSync(targetIds)) return false;
    const pending = new Set((await this.repository.pendingIntents()).map(entry => entry.targetId));
    return targetIds.every(id => !pending.has(id)) && this.canDeleteTargetsSync(targetIds);
  };
  getLibrary(): LibrarySession {
    if (!supportsLibrary(this.repository)) throw new Error('library-publication-unavailable');
    if (!this.librarySession) {
      const library = new LibrarySession({
        repository: this.repository,
        isActive: () => this.state.ready && this.state.active,
        prepareDeleteTargets: this.prepareDeleteTargets,
        canDeleteTargetsSync: this.canDeleteTargetsSync,
        queryPreferences: this.queryPreferences,
        canResolve: () => {
          if (!this.state.ready || !this.state.active || this.scopeViewHeld() || this.state.unhandledTargets.length || this.heldTargets().length) return false;
          try { return !(this.markdownDrafts?.targets().length); } catch { return false; }
        },
      });
      this.librarySession = library;
      let resolutionHeld = false;
      library.subscribe(() => {
        const nextHeld = library.hasPendingResolution();
        if (nextHeld !== resolutionHeld) { resolutionHeld = nextHeld; this.update({}); }
        if (library.getSnapshot().ready && library.canLeave() && this.state.unhandledTargets.includes(this.scope.libraryId)) {
          this.update({ unhandledTargets: Object.freeze(this.state.unhandledTargets.filter(id => id !== this.scope.libraryId)) });
        }
      });
    }
    return this.librarySession;
  }
  get(documentId: string): DocumentEditSession {
    let session = this.sessions.get(documentId);
    if (!session) {
      session = new DocumentEditSession(this.repository, documentId, undefined, this.isScopeWritable);
      this.sessions.set(documentId, session);
    }
    return session;
  }
  getMarkdown(documentId: string): MarkdownEditSession {
    if (!this.markdownDrafts) throw new Error('markdown-drafts-unavailable');
    let session = this.markdownSessions.get(documentId);
    if (!session) {
      session = new MarkdownEditSession(this.repository, documentId, this.markdownDrafts, undefined, this.isScopeWritable, this.markdownImages);
      this.markdownSessions.set(documentId, session);
    }
    return session;
  }
  getAppend(sourceId: string): NoteAppendSession {
    let session = this.appendSessions.get(sourceId);
    if (!session) {
      session = new NoteAppendSession({ repository: this.repository, getMarkdown: id => this.getMarkdown(id),
        isActive: () => this.state.ready && this.state.active && !this.librarySession?.hasPendingResolution() });
      this.appendSessions.set(sourceId, session);
    }
    return session;
  }
  get canAppendAnnotations(): boolean { return !!this.appendDrafts && !!this.markdownDrafts && supportsLibrary(this.repository); }
  getAnnotationBrowser(): AnnotationBrowserSession {
    return this.annotationBrowser ??= new AnnotationBrowserSession({ repository: this.repository,
      isActive: () => this.state.ready && this.state.active,
      readExistingConfirmed: id => this.sessions.get(id)?.getSnapshot().document });
  }
  getAnnotationAppend(): NoteAppendSession {
    if (!this.canAppendAnnotations) throw new Error('annotation-append-unavailable');
    return this.annotationAppend ??= new NoteAppendSession({ repository: this.repository, drafts: this.appendDrafts,
      getMarkdown: id => this.getMarkdown(id), isActive: () => this.state.ready && this.state.active && !this.librarySession?.hasPendingResolution(),
      createNote: (input, identity) => this.getLibrary().create(input, identity) });
  }
  private annotationRecoveryBlocked(): boolean {
    if (this.annotationAppend) return this.annotationAppend.isRecoveryBlocked();
    try { return this.appendDrafts?.read() !== undefined; }
    catch { return true; }
  }
  private annotationHeldTargets(): string[] {
    if (this.annotationRecoveryBlocked()) return [this.scope.libraryId];
    const append = this.annotationAppend;
    if (!append || append.canLeave()) return [];
    const state = append.getSnapshot();
    const sources = state.request?.input.kind === 'annotations' ? state.request.input.result.rows.map(row => row.documentId) : [];
    return [...sources, ...(state.destinationId ? [state.destinationId] : []),
      ...(state.creation ? [state.creation.identity.itemId, this.scope.libraryId] : [])];
  }
  private heldTargets() {
    return [...new Set([...this.sessions].filter(([, session]) => !session.canNavigate()).map(([id]) => id)
      .concat([...this.markdownSessions].filter(([, session]) => !session.canLeave()).map(([id]) => id))
      .concat([...this.appendSessions].filter(([, session]) => !session.canLeave()).flatMap(([id, session]) => {
        const dest = session.getSnapshot().destinationId;
        return dest ? [id, dest] : [id];
      }))
      .concat(this.librarySession && !this.librarySession.canLeave() ? [this.scope.libraryId] : [])
      .concat(this.annotationHeldTargets()))];
  }
  /** Browser exit cannot await journal I/O. Include authorities outside the visible document. */
  needsExitConfirmation(): boolean {
    if (!this.state.ready || this.scopeViewHeld() || this.state.unhandledTargets.length || this.heldTargets().length) return true;
    try { return (this.markdownDrafts?.targets().length ?? 0) > 0; }
    catch { return true; }
  }
  initialize(): Promise<void> {
    if (!this.hostAuthorized) return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.state.ready) return Promise.resolve();
    const generation = this.hostGeneration, current = () => this.hostAuthorized && this.hostGeneration === generation;
    this.opening = Promise.resolve().then(async () => {
      const unhandled: string[] = [];
      try {
        // Restore the fixed export before any view can replace it. Invalid raw data stays in its port;
        // the dedicated guard blocks all deletion when its source IDs cannot be trusted.
        if (this.canAppendAnnotations) this.getAnnotationAppend().restore();
        const markdownTargets = new Set(this.markdownDrafts?.targets() ?? []);
        const pending = await this.repository.pendingIntents(); if (!current()) return;
        for (const { targetId, record } of pending) {
          if (!current()) return;
          const request = record.intent.request;
          if (targetId === this.scope.libraryId && ('publication' in request || request.batch.kind === 'library'
            || (request.batch.kind === 'resolution' && request.batch.snapshot.kind === 'library')) && supportsLibrary(this.repository)) {
            if (!await this.getLibrary().refresh()) unhandled.push(targetId);
            if (!current()) return;
            continue;
          }
          if ('batch' in request && (request.batch.kind === 'markdown'
            || (request.batch.kind === 'resolution' && request.batch.snapshot.kind === 'markdown')) && this.markdownDrafts) {
            markdownTargets.add(targetId); continue;
          }
          if (!('batch' in request) || (!['page', 'document'].includes(request.batch.kind)
            && !(request.batch.kind === 'resolution' && request.batch.snapshot.kind === 'document'))) { unhandled.push(targetId); continue; }
          const session = this.get(targetId);
          if ((!session.getSnapshot().ready || session.canNavigate()) && !await session.refresh()) throw new Error('document-recovery-failed: ' + targetId);
          if (!current()) return;
        }
        for (const targetId of markdownTargets) {
          if (!current()) return;
          const session = this.getMarkdown(targetId);
          if ((!session.getSnapshot().ready || session.canLeave()) && !await session.refresh()) {
            if (session.getSnapshot().editingBlocked) unhandled.push(targetId);
            else throw new Error('markdown-recovery-failed: ' + targetId);
          }
          if (!current()) return;
        }
        if (!current()) return;
        this.update({ ready: true, active: true, error: '', unhandledTargets: Object.freeze(unhandled) });
      } catch (error) { if (current()) this.update({ ready: false, active: false, error: String(error) }); }
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }
  /** External host loss blocks new input immediately but retains every session and draft. */
  deactivateForHostLoss(): void { this.hostAuthorized = false; this.hostGeneration++; this.update({ active: false }); }
  async prepareLeave(): Promise<ScopeLeaveResult> {
    if (!this.state.ready) return { status: 'refused', reason: 'recovery-not-ready', targets: [] };
    if (this.scopeViewHeld()) return { status: 'refused', reason: 'editing-or-pending-save', targets: [this.scope.libraryId] };
    const held = () => this.heldTargets();
    let targets = held();
    if (targets.length) return { status: 'refused', reason: 'editing-or-pending-save', targets };
    try {
      targets = [...new Set([...(await this.repository.pendingIntents()).map(value => value.targetId), ...(this.markdownDrafts?.targets() ?? []), ...held()])];
      return targets.length || this.scopeViewHeld() ? { status: 'refused', reason: 'pending-recovery', targets: targets.length ? targets : [this.scope.libraryId] } : { status: 'allowed' };
    } catch (error) { return { status: 'refused', reason: String(error), targets: [] }; }
  }
  async suspend(): Promise<ScopeLeaveResult> {
    const result = await this.prepareLeave();
    // Recheck after I/O: a view may have started a gesture/save while the journal was enumerated.
    if (result.status === 'allowed') {
      if (this.scopeViewHeld()) return { status: 'refused', reason: 'editing-or-pending-save', targets: [this.scope.libraryId] };
      const held = this.heldTargets();
      if (held.length) return { status: 'refused', reason: 'editing-or-pending-save', targets: held };
      this.update({ active: false });
    }
    return result;
  }
  async resume(): Promise<void> {
    if (!this.hostAuthorized) return;
    if (this.opening) await this.opening;
    if (!this.hostAuthorized || (this.state.ready && this.state.active)) return;
    this.update({ ready: false, active: false }); await this.initialize();
  }
  /** Only a newly reauthorized host gate may call this after old I/O is drained. */
  async resumeForHost(isCurrent: () => boolean): Promise<void> {
    if (this.opening) await this.opening;
    if (!isCurrent()) return;
    this.hostAuthorized = true; this.hostGeneration++;
    this.update({ ready: false, active: false }); await this.initialize();
  }
}
