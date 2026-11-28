// LEGACY-COPY B13-d U2: verbatim copy of the pre-U2 product file (only the import specifiers are rewritten for tests/support).
// LEGACY-COPY Do not edit: tests/libraryHistoryEquivalence.test.ts maps the specifiers back and checks the sha256 of the original.
import { isNoteTemplate, noteTemplateMetadata, validateTemplateInput } from '../../src/runtime/markdown/noteTemplates.ts';
import { analyzeMarkdownImages } from '../../src/runtime/markdown/markdownImages.ts';
import type { ContentRepository, EditIntentRepository } from '../../src/runtime/edits/ports.ts';
import type { ContentPublication, DeletionRecord, DocumentSnapshot, EditIntent, Folder, HistoryRecord, ItemLink, LibraryChange, LibraryEditBatch, LibraryItem, LibrarySnapshot, ResolutionBatch } from '../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../src/runtime/edits/editGraph.ts';
import { applyBatch, canonicalJson } from '../../src/runtime/edits/editModel.ts';
import { publicationItem, resourceHash } from '../../src/runtime/edits/contentPublication.ts';
import { BatchCommitSession } from '../../src/runtime/edits/batchCommitSession.ts';
import { EditIntentJournal } from '../../src/runtime/edits/intentJournal.ts';
import {
  addLibraryLinks, createLibraryFolder, deleteLibraryItems, detachLibraryNotes, libraryAppendPosition,
  libraryOwnedAppendPosition, moveLibraryFolder, moveLibraryItems, removeLibraryFolder, removeLibraryLinks,
  renameLibraryFolder, renameLibraryItem, resolveLibraryDeleteTargets, restoreDeletedLibraryItems,
  setLibraryItemsRead, updateLibraryBibliography, updateLibraryTags,
  type LibraryBibliographyField, type LibraryBibliographyValues, type LibraryDeleteMode, type LibraryTagsUpdate,
} from '../../src/features/library/canonicalLibraryOperations.ts';
import { deletedContent, type DeletedContent } from '../../src/features/library/recovery/deletedContent.ts';
import { LibraryQuerySession, type LibraryCorpusPort, type LibraryQueryPreferencePort } from '../../src/features/library/query/LibraryQuerySession.ts';
import { createCanonicalLibraryCorpus } from '../../src/features/library/query/canonicalLibraryCorpus.ts';
import { assertLibraryEdit, inverseLibraryEdit, restoreLibraryHistory } from './libraryHistoryLegacy.ts';
import { reorderLibraryEntry, type LibraryTreeEntry, type LibraryTreePlacement } from '../../src/features/library/tree/canonicalLibraryReorder.ts';

export type LibraryCreateInput = { kind: 'markdown' | 'notebook'; title: string; folderId?: string | null; ownerId?: string | null; templateContent?: string };
export type LibraryCreateIdentity = { itemId: string; contentVersion: string; batchId: string };
export type LibraryRepository = EditIntentRepository & Pick<ContentRepository, 'publish'> & Partial<Pick<ContentRepository, 'storeResource' | 'readResource'>>;
export type LibraryAttachmentInput = { ownerId: string; name: string; mediaType: string } & ({ bytes: Uint8Array } | { read: () => Promise<Uint8Array> });
export type LibraryPdfInput = { name: string; folderId?: string | null } & ({ bytes: Uint8Array } | { read: () => Promise<Uint8Array> });
type AttachmentState = { filename: string; ownerId: string; pdf?: boolean; phase: 'reading' | 'resource' | 'failed' | 'publication'; error: string };
type AttachmentSource = { ownerId: string; name: string; mediaType: string; bytes?: Uint8Array; read?: () => Promise<Uint8Array>;
  itemId: string; resourceId: string; batchId: string; hash?: string;
  pdf?: { folderId: string | null; contentVersion: string; pages?: DocumentSnapshot['pages'] } };
export type LibrarySessionState = {
  ready: boolean; busy: boolean; items: readonly LibraryItem[]; templates: readonly LibraryItem[]; heads: readonly string[];
  selectedVersion: string | null; pendingId: string | null; createdId: string | null; error: string;
  folders: readonly Folder[]; createdFolderId: string | null;
  links: readonly ItemLink[]; deletions: readonly DeletionRecord[];
  deletedItems: readonly LibraryItem[]; deletedContent: readonly DeletedContent[];
  pendingKind: 'create' | 'edit' | 'undo' | 'redo' | null; canUndo: boolean; canRedo: boolean;
  attachment: Readonly<AttachmentState> | null;
};
type LibraryRequest = { publication: ContentPublication; history?: HistoryRecord } | { batch: LibraryEditBatch; history: HistoryRecord };
type PendingLibrary = { request: LibraryRequest; lifecycle: BatchCommitSession; kind: NonNullable<LibrarySessionState['pendingKind']>; createdFolderId?: string };
const requestBatch = (request: LibraryRequest) => 'publication' in request ? request.publication.libraryBatch : request.batch;

/** One scoped catalog authority; publication atomically creates the item and its initial body. */
export class LibrarySession {
  readonly query: LibraryQuerySession;
  private readonly repository: LibraryRepository;
  private readonly isActive: () => boolean;
  private readonly makeId: () => string;
  private readonly prepareDeleteTargets?: (targetIds: readonly string[]) => Promise<boolean>;
  private readonly canDeleteTargetsSync?: (targetIds: readonly string[]) => boolean;
  private readonly canResolve?: () => boolean;
  private readonly scopeKey: string;
  private readonly journal: EditIntentJournal;
  private readonly listeners = new Set<() => void>();
  private state: LibrarySessionState = Object.freeze({ ready: false, busy: false, items: Object.freeze([]), templates: Object.freeze([]), heads: Object.freeze([]),
    selectedVersion: null, pendingId: null, pendingKind: null, canUndo: false, canRedo: false, createdId: null,
    folders: Object.freeze([]), createdFolderId: null, links: Object.freeze([]), deletions: Object.freeze([]),
    deletedItems: Object.freeze([]), deletedContent: Object.freeze([]), error: '', attachment: null });
  private attachmentSource?: AttachmentSource;
  private pending?: PendingLibrary;
  private resolution?: { batch: ResolutionBatch; lifecycle: BatchCommitSession };
  private resolutionDiscarding = false;
  private conflictGraph?: EditGraph;
  private selectedSnapshot: LibrarySnapshot | null = null;
  getSelectedSnapshot = (): LibrarySnapshot | null => this.state.ready && this.selectedSnapshot?.version === this.state.selectedVersion
    ? structuredClone(this.selectedSnapshot) : null;
  private history: ReturnType<typeof restoreLibraryHistory> = { undo: [], redo: [] };
  private working = false;
  private generation = 0;
  private explicitRefresh?: Promise<boolean>;
  private recoveryBlocked = false;
  private lastCreatedId: string | null = null;
  private lastCreatedFolderId: string | null = null;
  constructor(options: {
    repository: LibraryRepository; isActive: () => boolean; makeId?: () => string;
    prepareDeleteTargets?: (targetIds: readonly string[]) => Promise<boolean>;
    canDeleteTargetsSync?: (targetIds: readonly string[]) => boolean;
    canResolve?: () => boolean;
    corpus?: LibraryCorpusPort;
    queryPreferences?: LibraryQueryPreferencePort;
  }) {
    this.repository = options.repository; this.isActive = options.isActive; this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.query = new LibraryQuerySession(options.corpus ?? createCanonicalLibraryCorpus(options.repository), () => this.active(), options.queryPreferences, options.repository.scope);
    this.prepareDeleteTargets = options.prepareDeleteTargets; this.canDeleteTargetsSync = options.canDeleteTargetsSync; this.canResolve = options.canResolve;
    this.scopeKey = canonicalJson(options.repository.scope);
    this.journal = new EditIntentJournal(options.repository, options.repository.scope.libraryId, this.makeId);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<LibrarySessionState>) {
    const next = { ...this.state, ...fields };
    const available = next.ready && !this.working && !this.pending && !this.resolution && !this.attachmentSource && !this.recoveryBlocked && next.heads.length === 1 && !next.error;
    this.state = Object.freeze({ ...next, canUndo: available && !!this.history.undo.length, canRedo: available && !!this.history.redo.length });
    this.listeners.forEach(listener => listener());
  }
  private active() { return this.isActive() && canonicalJson(this.repository.scope) === this.scopeKey; }
  canLeave = () => this.state.ready && !this.working && !this.pending && !this.resolution && !this.attachmentSource && !this.recoveryBlocked;
  hasPendingResolution = () => !!this.resolution;
  conflictVersions = (): readonly LibrarySnapshot[] => this.state.heads.map(head => {
    const snapshot = this.conflictGraph?.snapshot(head);
    if (snapshot?.kind !== 'library') throw new Error('library-conflict-head-missing');
    return structuredClone(snapshot);
  });
  canDiscardRejectedResolution = () => !!this.resolution && !this.resolutionDiscarding && this.resolution.lifecycle.getSnapshot().phase === 'aborted';
  private resolutionFlight(batch: ResolutionBatch, intent?: EditIntent) {
    if (batch.snapshot.kind !== 'library' || batch.snapshot.id !== this.repository.scope.libraryId || batch.snapshot.version !== batch.id
      || batch.targetId !== this.repository.scope.libraryId || batch.libraryId !== this.repository.scope.libraryId) throw new Error('library-resolution-invalid');
    return { batch: structuredClone(batch), lifecycle: new BatchCommitSession(this.repository, { batch }, () => { throw new Error('resolution-undo-unsupported'); },
      intent?.dispatched ? 'unknown' : 'new', { journal: this.journal, ...(intent ? { intent } : {}) }) };
  }
  resolveConflict = async (version: string, expectedHeads: readonly string[]): Promise<boolean> => {
    if (!this.active() || !this.canLeave() || (this.canResolve && !this.canResolve()) || expectedHeads.length < 2 || !expectedHeads.includes(version)
      || new Set(expectedHeads).size !== expectedHeads.length || canonicalJson([...expectedHeads].sort()) !== canonicalJson([...this.state.heads].sort())) return false;
    const selected = this.conflictGraph?.snapshot(version); if (selected?.kind !== 'library') return false;
    const id = this.makeId(), batch: ResolutionBatch = { kind: 'resolution', id, libraryId: this.repository.scope.libraryId,
      targetId: this.repository.scope.libraryId, parents: [...expectedHeads], snapshot: { ...selected, version: id } };
    this.generation++; this.resolution = this.resolutionFlight(batch);
    this.update({ pendingId: id, error: '', canUndo: false, canRedo: false }); return this.retry();
  };
  discardRejectedResolution = async (): Promise<boolean> => {
    const pending = this.resolution;
    if (!this.active() || !pending || this.working || this.resolutionDiscarding || pending.lifecycle.getSnapshot().phase !== 'aborted') return false;
    this.resolutionDiscarding = true;
    try { await this.journal.clear(); if (this.resolution !== pending || !this.active()) return false;
      const read = await this.catalog(); if (this.resolution !== pending || !this.active()) return false;
      this.resolution = undefined; this.display(read); this.update({ error: '' }); return true;
    } catch (error) { this.update({ error: String(error) }); return false; }
    finally { this.resolutionDiscarding = false; }
  };
  private async catalog(version?: string) {
    const read = await this.repository.read(this.repository.scope.libraryId);
    if (read.checkpoint.libraryId !== this.repository.scope.libraryId || read.checkpoint.root.kind !== 'library'
      || read.checkpoint.root.id !== this.repository.scope.libraryId) throw new Error('library-scope');
    const selected = version ?? (this.state.selectedVersion && read.heads.includes(this.state.selectedVersion)
      ? this.state.selectedVersion : read.heads.length === 1 ? read.heads[0] : undefined);
    if (selected && !read.heads.includes(selected)) throw new Error('library-head-unavailable');
    const value = selected ? new EditGraph(read.checkpoint).snapshot(selected) : undefined;
    if (selected && value?.kind !== 'library') throw new Error('library-required');
    const snapshot = value as LibrarySnapshot | undefined;
    const deletedGraphs = new Map<string, EditGraph>();
    if (snapshot) {
      const byId = new Map(snapshot.items.map(item => [item.id, item]));
      const deletedTargetIds = new Set(
        snapshot.deletions.filter(record => record.active).flatMap(record => record.itemIds)
          .filter(id => { const item = byId.get(id); return !!item && item.kind !== 'attachment'; })
      );
      // Historical creation Undo also needs its observed content versions after that deletion was restored.
      const publishedContent = new Set((read.publicationOrigins ?? []).filter(origin => origin.contentVersion).map(origin => origin.itemId));
      for (const batch of read.checkpoint.batches) if (batch.kind === 'library') for (const change of batch.changes) {
        if (change.type === 'put-deletion') for (const observation of change.deletion.observed) {
          if (publishedContent.has(observation.targetId)) deletedTargetIds.add(observation.targetId);
        }
      }
      for (const targetId of deletedTargetIds) {
        try {
          const targetRead = await this.repository.read(targetId);
          if (targetRead.checkpoint.libraryId === this.repository.scope.libraryId && targetRead.checkpoint.root.id === targetId) {
            deletedGraphs.set(targetId, new EditGraph(targetRead.checkpoint));
          }
        } catch {
          // A deleted target whose content graph has not arrived locally remains 'waiting' in deletedContent.
        }
      }
    }
    return { read, value: snapshot, deletedGraphs };
  }
  private display(read: Awaited<ReturnType<LibrarySession['catalog']>>, createdId = this.lastCreatedId) {
    this.conflictGraph = new EditGraph(read.read.checkpoint);
    this.history = read.value ? restoreLibraryHistory(this.versions(read), read.value.version, read.read.history) : { undo: [], redo: [] };
    this.selectedSnapshot = read.value ? structuredClone(read.value) : null;
    const deleted = new Set(read.value?.deletions.filter(value => value.active).flatMap(value => value.itemIds) ?? []);
    const activeItems = structuredClone(read.value?.items.filter(item => !deleted.has(item.id)) ?? []);
    const templates = activeItems.filter(isNoteTemplate).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const items = activeItems.filter(item => !isNoteTemplate(item)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const deletedItems = structuredClone(read.value?.items.filter(item => deleted.has(item.id) && !isNoteTemplate(item)) ?? []).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const folders = structuredClone(read.value?.folders ?? []).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const links = structuredClone(read.value?.links ?? []).sort((a, b) => a.pdfId.localeCompare(b.pdfId) || a.noteId.localeCompare(b.noteId));
    const deletions = structuredClone(read.value?.deletions.filter(value => value.active) ?? []);
    const visibleDeletedIds = new Set(deletedItems.map(item => item.id));
    const deletedStates = read.value ? deletedContent(read.value, read.deletedGraphs).filter(entry => visibleDeletedIds.has(entry.itemId)) : [];
    const undoPending = !!this.pending?.lifecycle.getSnapshot().undoRequested;
    // A receipt does not choose a winning branch. Only offer opening an item visible in this selected catalog.
    this.update({ ready: true, busy: this.working, items: Object.freeze(items), templates: Object.freeze(templates), heads: Object.freeze([...read.read.heads]), selectedVersion: read.value?.version ?? null,
      createdId: createdId && items.some(item => item.id === createdId) ? createdId : null,
      folders: Object.freeze(folders), createdFolderId: this.lastCreatedFolderId && folders.some(folder => folder.id === this.lastCreatedFolderId) ? this.lastCreatedFolderId : null,
      links: Object.freeze(links), deletions: Object.freeze(deletions),
      deletedItems: Object.freeze(deletedItems), deletedContent: Object.freeze(deletedStates),
      pendingId: this.pending ? (this.pending.lifecycle.getSnapshot().inverseId ?? requestBatch(this.pending.request).id) : this.resolution?.batch.id ?? null,
      pendingKind: this.pending ? (undoPending ? 'undo' : this.pending.kind) : null,
      error: !read.value ? 'library-head-selection-required' : '' });
    void this.query.setCatalog(items);
  }
  private versions(read: Awaited<ReturnType<LibrarySession['catalog']>>) {
    const graph = new EditGraph(read.read.checkpoint), batches = new Map(read.read.checkpoint.batches.map(batch => [batch.id, batch]));
    const origins = new Map((read.read.publicationOrigins ?? []).map(origin => [origin.batchId, origin]));
    return { publicationOrigin: (id: string) => origins.get(id), contentVersion: (itemId: string, head: string) => {
      const origin = [...origins.values()].find(value => value.itemId === itemId && value.contentVersion);
      const content = read.deletedGraphs.get(itemId);
      return !!origin?.contentVersion && !!content?.snapshot(head) && content.descendsFrom(head, origin.contentVersion);
    }, batch: (id: string) => batches.get(id), snapshot: (id: string) => {
      const snapshot = graph.snapshot(id); return snapshot?.kind === 'library' ? snapshot : undefined;
    } };
  }
  private makeCreateInverse(publication: ContentPublication, inverseId = this.makeId(), deletionId = this.makeId()) {
    const item = publicationItem(publication);
    const removeLinks: LibraryChange[] = publication.libraryBatch.changes
      .filter(change => change.type === 'add-link')
      .map(change => ({ type: 'remove-link' as const, link: structuredClone(change.link) }));
    const observed = publication.content ? [{ targetId: item.id, heads: [publication.content.version] }] : [];
    const batch: LibraryEditBatch = {
      kind: 'library', id: inverseId, libraryId: this.repository.scope.libraryId, targetId: this.repository.scope.libraryId,
      parents: [publication.libraryBatch.id],
      changes: [...removeLinks, { type: 'put-deletion', deletion: { id: deletionId, itemIds: [item.id], observed, active: true } }],
    };
    const history: HistoryRecord = { operationId: inverseId, beforeVersion: publication.libraryBatch.id, afterVersion: inverseId, undoRequested: false };
    return { batch, history };
  }
  private install(publication: ContentPublication, intent?: EditIntent) {
    const item = publicationItem(publication);
    if (!['markdown', 'notebook', 'attachment', 'pdf'].includes(item.kind) || publication.libraryBatch.targetId !== this.repository.scope.libraryId
      || publication.libraryBatch.libraryId !== this.repository.scope.libraryId)
      throw new Error('library-recovery-unsupported');
    if (item.kind === 'attachment' && (publication.content || publication.libraryBatch.changes.length !== 1
      || !item.ownerId || item.folderId !== null || !item.resourceId || item.tags.length || item.read || Object.keys(item.metadata).length))
      throw new Error('library-recovery-unsupported');
    if (item.kind === 'pdf' && (!publication.content || publication.content.kind !== 'document'
      || publication.content.id !== item.id || item.ownerId !== null || !item.resourceId
      || publication.content.pages.length === 0 || publication.content.pages.some(page => page.background.kind !== 'pdf'
        || page.background.resourceId !== item.resourceId))) throw new Error('library-recovery-unsupported');
    if (intent?.inverse) {
      if (intent.inverse.batch.kind !== 'library') throw new Error('library-recovery-unsupported');
      const delChange = intent.inverse.batch.changes.find(change => change.type === 'put-deletion');
      if (!delChange || delChange.type !== 'put-deletion') throw new Error('library-recovery-unsupported');
      const expected = this.makeCreateInverse(publication, intent.inverse.batch.id, delChange.deletion.id);
      if (canonicalJson(intent.inverse) !== canonicalJson(expected)) throw new Error('library-recovery-unsupported');
    }
    const stable = structuredClone(publication);
    const history: HistoryRecord = { operationId: stable.libraryBatch.id,
      beforeVersion: stable.libraryBatch.parents[0], afterVersion: stable.libraryBatch.id, undoRequested: false };
    if (item.kind === 'attachment' && intent && !intent.request.history) throw new Error('library-history-mismatch');
    if (intent?.request.history && canonicalJson(intent.request.history) !== canonicalJson(history)) throw new Error('library-history-mismatch');
    const request = intent?.request && 'publication' in intent.request ? intent.request : { publication: stable, ...(history ? { history } : {}) };
    const lifecycle = new BatchCommitSession(this.repository, request,
      () => this.makeCreateInverse(stable), 'new', { journal: this.journal, ...(intent ? { intent } : {}) });
    this.pending = { request, lifecycle, kind: 'create' };
    if (item.kind === 'attachment') this.update({ attachment: { filename: item.title, ownerId: item.ownerId!, phase: 'publication', error: '' } });
    if (item.kind === 'pdf') this.update({ attachment: { filename: item.title, ownerId: '', pdf: true, phase: 'publication', error: '' } });
  }
  private installEdit(batch: LibraryEditBatch, history: HistoryRecord, before: LibrarySnapshot,
    read: Awaited<ReturnType<LibrarySession['catalog']>>, intent?: EditIntent) {
    if (batch.targetId !== this.repository.scope.libraryId || batch.libraryId !== this.repository.scope.libraryId
      || intent?.undoRequested || intent?.inverse) throw new Error('library-recovery-unsupported');
    const after = applyBatch(before, batch) as LibrarySnapshot;
    if (history.operationId !== batch.id || history.afterVersion !== batch.id || history.beforeVersion !== batch.parents[0]) throw new Error('library-history-mismatch');
    const versions = this.versions(read), known = versions.batch(batch.id);
    if (known && canonicalJson(known) !== canonicalJson(batch)) throw new Error('library-history-payload-mismatch');
    const includingPending = { publicationOrigin: versions.publicationOrigin, contentVersion: versions.contentVersion, batch: (id: string) => id === batch.id ? batch : versions.batch(id),
      snapshot: (id: string) => id === batch.id ? after : versions.snapshot(id) };
    assertLibraryEdit(includingPending, batch.id, !!history.action);
    const restored = restoreLibraryHistory(includingPending, batch.id, [...read.read.history, history]);
    if (history.action) {
      const destination = restored[history.action.kind === 'undo' ? 'redo' : 'undo'];
      const entry = destination[destination.length - 1];
      if (entry?.operationId !== history.action.operationId || entry.executionId !== batch.id) throw new Error('library-history-action-unresolved');
    }
    const request = structuredClone({ batch, history });
    const lifecycle = new BatchCommitSession(this.repository, request, () => { throw new Error('library-pending-undo-unavailable'); }, 'new',
      { journal: this.journal, ...(intent ? { intent } : {}) });
    const first = batch.changes[0];
    const createdFolderId = !history.action && batch.changes.length === 1 && first.type === 'put-folder'
      && !before.folders.some(folder => folder.id === first.folder.id) ? first.folder.id : undefined;
    this.pending = { request, lifecycle, kind: history.action?.kind ?? 'edit', createdFolderId };
    this.lastCreatedId = null;
    this.lastCreatedFolderId = null;
  }
  /** Read-only startup recovery is allowed before the registry enables mutations. Never rewrites a pending payload. */
  refresh = (version?: string): Promise<boolean> => {
    if (version === undefined && this.explicitRefresh) return this.explicitRefresh;
    const flight = this.refreshCatalog(version);
    if (version !== undefined) {
      this.explicitRefresh = flight;
      const clear = () => { if (this.explicitRefresh === flight) this.explicitRefresh = undefined; };
      void flight.then(clear, clear);
    }
    return flight;
  };
  private async refreshCatalog(version?: string): Promise<boolean> {
    if (this.working || this.resolution) return false;
    const generation = ++this.generation;
    try {
      if (!this.pending) {
        const record = await this.journal.reload();
        if (generation !== this.generation) return false;
        if (record) {
          const request = record.intent.request;
          if ('publication' in request) {
            if (publicationItem(request.publication).kind === 'attachment') {
              const read = await this.catalog(); if (generation !== this.generation) return false;
              const batch = request.publication.libraryBatch, item = publicationItem(request.publication);
              const before = this.versions(read).snapshot(batch.parents[0]);
              if (!before || before.items.some(value => value.id === item.id)
                || item.position !== libraryOwnedAppendPosition(before, item.ownerId!)) throw new Error('library-recovery-unsupported');
              applyBatch(before, batch);
            }
            this.install(request.publication, record.intent);
          }
          else {
            if (request.batch.kind === 'resolution') {
              if (request.history || record.intent.undoRequested || record.intent.inverse) throw new Error('library-recovery-unsupported');
              this.resolution = this.resolutionFlight(request.batch, record.intent);
            } else {
            if (request.batch.kind !== 'library' || !request.history) throw new Error('library-recovery-unsupported');
            const read = await this.catalog(); if (generation !== this.generation) return false;
            for (const change of request.batch.changes) if (change.type === 'put-deletion') for (const observation of change.deletion.observed) {
              if (read.deletedGraphs.has(observation.targetId)) continue;
              const content = await this.repository.read(observation.targetId); if (generation !== this.generation) return false;
              if (content.checkpoint.libraryId !== this.repository.scope.libraryId || content.checkpoint.root.id !== observation.targetId)
                throw new Error('library-scope');
              read.deletedGraphs.set(observation.targetId, new EditGraph(content.checkpoint));
            }
            const before = this.versions(read).snapshot(request.batch.parents[0]);
            if (!before) throw new Error('library-history-base-missing');
            this.installEdit(request.batch, request.history, before, read, record.intent);
            }
          }
        }
      }
      const read = await this.catalog(version); if (generation !== this.generation) return false;
      this.recoveryBlocked = false; this.display(read);
      if (this.pending) this.update({ error: this.pending.lifecycle.getSnapshot().error || 'library-create-pending' });
      if (this.resolution) this.update({ error: 'library-resolution-unconfirmed' });
      return true;
    } catch (error) { if (generation === this.generation) { this.recoveryBlocked = true; this.update({ ready: false, error: String(error) }); } return false; }
  }
  createTemplate = (name: string, content: string, identity?: LibraryCreateIdentity): Promise<boolean> =>
    this.create({ kind: 'markdown', title: name, templateContent: content }, identity);
  create = async (input: LibraryCreateInput, suppliedIdentity?: LibraryCreateIdentity): Promise<boolean> => {
    const template = input.templateContent === undefined ? null : (() => { try { return validateTemplateInput(input.title, input.templateContent); } catch { return null; } })();
    if (input.templateContent !== undefined && (!template || input.kind !== 'markdown' || input.ownerId || input.folderId)) { this.update({ error: 'library-template-input' }); return false; }
    const images = template ? analyzeMarkdownImages(template.content) : null;
    if (images?.problems.length) { this.update({ error: 'library-template-images' }); return false; }
    const identity = suppliedIdentity && { ...suppliedIdentity };
    if (identity && (!Object.values(identity).every(value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value))
      || new Set(Object.values(identity)).size !== 3)) { this.update({ error: 'library-create-identity' }); return false; }
    if (identity && this.pending) {
      const request = this.pending.request;
      if (!('publication' in request) || request.publication.libraryBatch.id !== identity.batchId
        || request.publication.content?.id !== identity.itemId || request.publication.content.version !== identity.contentVersion) return false;
      const item = publicationItem(request.publication);
      if (item.kind !== input.kind || item.title !== input.title.trim() || item.ownerId !== (input.ownerId ?? null)
        || item.folderId !== (input.folderId ?? null) || isNoteTemplate(item) !== !!template
        || (template && (request.publication.content?.kind !== 'markdown' || request.publication.content.content !== template.content))) return false;
      return this.retry(); // Only this caller's immutable publication may be resumed.
    }
    if (!this.active() || this.working || this.pending || this.resolution || this.attachmentSource || !this.state.ready || this.recoveryBlocked) return false;
    const title = input.title.trim(), kind = input.kind, ownerId = input.ownerId ?? null, folderId = input.folderId ?? null;
    if (!title || !['markdown', 'notebook'].includes(kind) || (ownerId !== null && folderId !== null)) {
      this.update({ error: 'library-create-input' }); return false;
    }
    this.working = true; const generation = ++this.generation;
    this.update({ busy: true, createdId: null, error: '' });
    try {
      // Recheck local catalog and journal before preparing a new immutable operation.
      if (await this.journal.reload()) throw new Error('library-recovery-required');
      const catalog = await this.catalog();
      const { read, value } = catalog;
      if (!this.active() || generation !== this.generation) return false;
      if (read.heads.length !== 1 || !value) throw new Error('library-head-selection-required');
      if (identity) {
        const origin = read.publicationOrigins?.find(origin => origin.batchId === identity.batchId);
        if (origin) {
          const batch = read.checkpoint.batches.find(batch => batch.id === identity.batchId);
          const born = batch?.kind === 'library' && batch.changes.length === 1 && batch.changes[0].type === 'put-item' ? batch.changes[0].item : null;
          if (origin.itemId !== identity.itemId || origin.contentVersion !== identity.contentVersion || origin.kind !== kind
            || !born || born.id !== identity.itemId || born.kind !== kind || born.title !== title || born.ownerId !== ownerId || born.folderId !== folderId
            || isNoteTemplate(born) !== !!template)
            throw new Error('library-create-identity-mismatch');
          if (template) {
            const body = await this.repository.read(identity.itemId);
            const root = body.checkpoint.root;
            if (root.kind !== 'markdown' || root.version !== identity.contentVersion || root.content !== template.content
              || canonicalJson(root.imageResources) !== canonicalJson(images!.imageResources)) throw new Error('library-create-identity-mismatch');
          }
          if (!value.items.some(item => item.id === identity.itemId && item.kind === kind)
            || value.deletions.some(deletion => deletion.active && deletion.itemIds.includes(identity.itemId))) throw new Error('library-created-item-unavailable');
          this.lastCreatedId = identity.itemId; this.display(catalog, identity.itemId); return true;
        }
        if (value.items.some(item => item.id === identity.itemId) || read.checkpoint.batches.some(batch => batch.id === identity.batchId))
          throw new Error('library-create-identity-collision');
      }
      let position: number;
      if (ownerId !== null) position = libraryOwnedAppendPosition(value, ownerId);
      else {
        if (folderId !== null && !value.folders.some(folder => folder.id === folderId)) throw new Error('library-folder-missing');
        position = libraryAppendPosition(value, folderId);
      }
      const id = identity?.itemId ?? this.makeId(), version = identity?.contentVersion ?? this.makeId(), batchId = identity?.batchId ?? this.makeId();
      const item: LibraryItem = { id, kind, title, ownerId, folderId: ownerId ? null : folderId,
        position, tags: [], read: false, metadata: template ? noteTemplateMetadata() : {} };
      const publication: ContentPublication = { libraryBatch: { kind: 'library', id: batchId, libraryId: value.id, targetId: value.id,
        parents: [value.version], changes: [{ type: 'put-item', item }] },
      content: kind === 'markdown' ? { kind: 'markdown', id, version, content: template?.content ?? '', appendIds: [], imageResources: images?.imageResources ?? [] }
        : { kind: 'document', id, version, deletedPages: [], pages: [{ id: this.makeId(), backgroundRevision: this.makeId(), lifecycleVersion: this.makeId(), annotationVersion: this.makeId(),
          widthPt: 595.28, heightPt: 841.89, background: { kind: 'paper', spec: { template: 'blank', color: 'white' } }, annotations: [] }] } };
      this.install(publication); this.update({ pendingId: batchId, pendingKind: 'create' });
      return await this.flushPending(generation);
    } catch (error) { if (this.active() && generation === this.generation) this.update({ error: String(error) }); return false; }
    finally { this.working = false; if (this.active() && generation === this.generation) this.update({ busy: false }); }
  };
  importAttachment = (input: LibraryAttachmentInput): Promise<boolean> => {
    if (!this.active() || this.working || this.pending || this.resolution || this.attachmentSource || !this.state.ready || this.recoveryBlocked) return Promise.resolve(false);
    if (!input.name.trim() || !input.ownerId || ('bytes' in input && !input.bytes.length) || !input.mediaType.trim() || input.mediaType.length > 200
      || !this.repository.storeResource || !this.repository.readResource) {
      this.update({ error: 'library-attachment-input' }); return Promise.resolve(false);
    }
    this.attachmentSource = { ...input, ...('bytes' in input ? { bytes: Uint8Array.from(input.bytes) } : {}), itemId: this.makeId(), resourceId: this.makeId(), batchId: this.makeId() };
    return this.retryAttachment();
  };
  /** Resource metadata is inspected by the repository, then catalog and document publish atomically. */
  importPdf = (input: LibraryPdfInput): Promise<boolean> => {
    if (!this.active() || this.working || this.pending || this.resolution || this.attachmentSource || !this.state.ready || this.recoveryBlocked) return Promise.resolve(false);
    if (!input.name.trim() || ('bytes' in input && !input.bytes.length) || !this.repository.storeResource || !this.repository.readResource) {
      this.update({ error: 'library-pdf-input' }); return Promise.resolve(false);
    }
    this.attachmentSource = { ...input, name: input.name.trim(), ownerId: '', mediaType: 'application/pdf',
      ...('bytes' in input ? { bytes: Uint8Array.from(input.bytes) } : {}), itemId: this.makeId(), resourceId: this.makeId(), batchId: this.makeId(),
      pdf: { folderId: input.folderId ?? null, contentVersion: this.makeId() } };
    return this.retryAttachment();
  };
  retryAttachment = async (): Promise<boolean> => {
    if (this.pending) return this.retry();
    const source = this.attachmentSource;
    if (!source || !this.active() || this.working) return false;
    this.working = true; const generation = ++this.generation;
    const current = () => this.active() && generation === this.generation && this.attachmentSource === source;
    this.update({ busy: true, createdId: null, attachment: { filename: source.name, ownerId: source.ownerId, pdf: !!source.pdf, phase: source.bytes ? 'resource' : 'reading', error: '' }, error: '' });
    try {
      if (!source.bytes) {
        const bytes = await source.read!(); if (!current()) return false;
        source.bytes = Uint8Array.from(bytes);
      }
      if (!source.bytes.length) throw new Error('library-attachment-empty');
      this.update({ attachment: { filename: source.name, ownerId: source.ownerId, pdf: !!source.pdf, phase: 'resource', error: '' } });
      source.hash ??= await resourceHash(source.bytes);
      if (!current()) return false;
      await this.repository.storeResource!({ id: source.resourceId, sha256: source.hash, mediaType: source.mediaType, bytes: Uint8Array.from(source.bytes) });
      if (!current()) return false;
      const stored = await this.repository.readResource!(source.resourceId);
      if (!current()) return false;
      if (!stored || stored.metadata.id !== source.resourceId || stored.metadata.sha256 !== source.hash
        || stored.metadata.mediaType !== source.mediaType || stored.metadata.byteLength !== source.bytes.length
        || await resourceHash(stored.bytes) !== source.hash) throw new Error('library-attachment-resource');
      if (!current()) return false;
      if (source.pdf) {
        const descriptors = stored.metadata.pdfPages;
        if (!descriptors?.length || descriptors.length > 100000
          || descriptors.some(page => !Number.isFinite(page.widthPt) || !Number.isFinite(page.heightPt) || page.widthPt <= 0 || page.heightPt <= 0))
          throw new Error('library-pdf-resource');
        source.pdf.pages ??= descriptors.map((page, index) => ({ id: this.makeId(), backgroundRevision: this.makeId(), lifecycleVersion: this.makeId(), annotationVersion: this.makeId(),
          widthPt: page.widthPt, heightPt: page.heightPt, background: { kind: 'pdf', resourceId: source.resourceId, sourceRevision: source.hash!, pdfPage: index + 1 }, annotations: [] }));
        if (source.pdf.pages.length !== descriptors.length || source.pdf.pages.some((page, index) => page.widthPt !== descriptors[index].widthPt || page.heightPt !== descriptors[index].heightPt))
          throw new Error('library-pdf-resource-changed');
      }
      if (await this.journal.reload()) throw new Error('library-recovery-required');
      if (!current()) return false;
      const { read, value } = await this.catalog();
      if (!current()) return false;
      if (read.heads.length !== 1 || !value) throw new Error('library-head-selection-required');
      if (source.pdf?.folderId && !value.folders.some(folder => folder.id === source.pdf!.folderId)) throw new Error('library-folder-missing');
      if (!source.pdf && value.items.find(item => item.id === source.ownerId)?.kind === 'attachment') throw new Error('library-owner-invalid');
      const position = source.pdf ? libraryAppendPosition(value, source.pdf.folderId) : libraryOwnedAppendPosition(value, source.ownerId);
      const item: LibraryItem = { id: source.itemId, kind: source.pdf ? 'pdf' : 'attachment', title: source.name, ownerId: source.pdf ? null : source.ownerId,
        folderId: source.pdf?.folderId ?? null, resourceId: source.resourceId, position, tags: [], read: false, metadata: {} };
      this.install({ libraryBatch: { kind: 'library', id: source.batchId, libraryId: value.id, targetId: value.id,
        parents: [value.version], changes: [{ type: 'put-item', item }] },
        ...(source.pdf ? { content: { kind: 'document' as const, id: source.itemId, version: source.pdf.contentVersion, pages: source.pdf.pages!, deletedPages: [] } } : {}) });
      this.attachmentSource = undefined;
      this.update({ pendingId: source.batchId, pendingKind: 'create' });
      return await this.flushPending(generation);
    } catch (error) {
      if (this.active() && generation === this.generation) this.update({ error: String(error), attachment: {
        filename: source.name, ownerId: source.ownerId, pdf: !!source.pdf, phase: this.pending ? 'publication' : 'failed', error: String(error) } });
      return false;
    } finally {
      if (generation === this.generation) { this.working = false; this.update({ busy: false }); }
    }
  };
  cancelAttachment = (): Promise<boolean> => {
    if (!this.active()) return Promise.resolve(false);
    if (this.attachmentSource) {
      ++this.generation; this.attachmentSource = undefined; this.working = false;
      this.update({ attachment: null, busy: false, error: '' }); return Promise.resolve(true);
    }
    return this.cancelCreate();
  };
  private async flushPending(generation: number): Promise<boolean> {
    const pending = this.pending!;
    await pending.lifecycle.flush();
    if (!this.active() || generation !== this.generation) return false;
    if (!pending.lifecycle.canLeave()) {
      const error = pending.lifecycle.getSnapshot().error || 'library-create-pending';
      this.update({ error, ...(this.state.attachment ? { attachment: { ...this.state.attachment, error } } : {}) }); return false;
    }
    const phase = pending.lifecycle.getSnapshot().phase;
    const createdId = 'publication' in pending.request && phase === 'durable' ? publicationItem(pending.request.publication).id : null;
    // Keep the completed operation until the post-write catalog can be read; retry remains same-ID.
    const read = await this.catalog(); if (!this.active() || generation !== this.generation) return false;
    this.pending = undefined; this.recoveryBlocked = false; this.lastCreatedId = createdId;
    this.update({ attachment: null });
    this.lastCreatedFolderId = phase === 'durable' ? (pending.createdFolderId ?? null) : null; this.display(read, createdId); return true;
  }
  private edit = async (operation: (read: Awaited<ReturnType<LibrarySession['catalog']>>) => { batch: LibraryEditBatch; history: HistoryRecord } | null): Promise<boolean> => {
    if (!this.active() || this.working || this.pending || this.resolution || this.attachmentSource || !this.state.ready || this.recoveryBlocked) return false;
    this.working = true; const generation = ++this.generation; this.update({ busy: true, error: '' });
    try {
      if (await this.journal.reload()) throw new Error('library-recovery-required');
      const read = await this.catalog(); if (!this.active() || generation !== this.generation) return false;
      if (read.read.heads.length !== 1 || !read.value) throw new Error('library-head-selection-required');
      const command = operation(read);
      if (!command) { this.display(read); return true; }
      this.installEdit(command.batch, command.history, read.value, read);
      this.update({ pendingId: command.batch.id, pendingKind: this.pending!.kind, createdId: null, createdFolderId: null });
      return await this.flushPending(generation);
    } catch (error) { if (this.active() && generation === this.generation) this.update({ error: String(error) }); return false; }
    finally { this.working = false; if (this.active() && generation === this.generation) this.update({ busy: false }); }
  };
  private changeItems(operation: (snapshot: LibrarySnapshot) => LibraryChange[]): Promise<boolean> { return this.edit(read => {
    const before = read.value!, changes = operation(before); if (!changes.length) return null;
    const id = this.makeId();
    return { batch: { kind: 'library', id, libraryId: before.id, targetId: before.id, parents: [before.version], changes },
      history: { operationId: id, beforeVersion: before.version, afterVersion: id, undoRequested: false } };
  }); }
  reorderEntry = (source: LibraryTreeEntry, target: LibraryTreeEntry | null, placement: LibraryTreePlacement): Promise<boolean> => {
    const stableSource = structuredClone(source), stableTarget = structuredClone(target);
    return this.changeItems(snapshot => reorderLibraryEntry(snapshot, stableSource, stableTarget, placement));
  };
  rename = (itemId: string, title: string, expectedTitle?: string): Promise<boolean> =>
    this.changeItems(snapshot => renameLibraryItem(snapshot, itemId, title, expectedTitle));
  /** Capture the complete user intent before journal/catalog reads can yield. Retry uses the prepared batch. */
  updateTags = (ids: readonly string[], input: LibraryTagsUpdate): Promise<boolean> => {
    const stableIds = structuredClone(ids), stableInput = structuredClone(input);
    return this.changeItems(snapshot => updateLibraryTags(snapshot, stableIds, stableInput));
  };
  setRead = (ids: readonly string[], value: boolean): Promise<boolean> => {
    const stableIds = structuredClone(ids);
    return this.changeItems(snapshot => setLibraryItemsRead(snapshot, stableIds, value));
  };
  createFolder = (title: string, parentId: string | null): Promise<boolean> =>
    this.changeItems(snapshot => createLibraryFolder(snapshot, this.makeId(), title, parentId));
  renameFolder = (id: string, title: string, expectedTitle?: string): Promise<boolean> =>
    this.changeItems(snapshot => renameLibraryFolder(snapshot, id, title, expectedTitle));
  moveItems = (ids: readonly string[], destinationId: string | null): Promise<boolean> => {
    const stableIds = structuredClone(ids);
    return this.changeItems(snapshot => moveLibraryItems(snapshot, stableIds, destinationId));
  };
  moveFolder = (id: string, parentId: string | null): Promise<boolean> =>
    this.changeItems(snapshot => moveLibraryFolder(snapshot, id, parentId));
  removeFolder = (id: string): Promise<boolean> => this.changeItems(snapshot => removeLibraryFolder(snapshot, id));
  addLinks = (links: readonly ItemLink[]): Promise<boolean> => {
    const stableLinks = structuredClone(links);
    return this.changeItems(snapshot => addLibraryLinks(snapshot, stableLinks));
  };
  removeLinks = (links: readonly ItemLink[]): Promise<boolean> => {
    const stableLinks = structuredClone(links);
    return this.changeItems(snapshot => removeLibraryLinks(snapshot, stableLinks));
  };
  detachNotes = (ids: readonly string[]): Promise<boolean> => {
    const stableIds = structuredClone(ids);
    return this.changeItems(snapshot => detachLibraryNotes(snapshot, stableIds));
  };
  updateBibliography = (itemId: string, values: LibraryBibliographyValues,
    expectedMetadata?: Readonly<Partial<Record<LibraryBibliographyField, string>>>): Promise<boolean> => {
    const stableValues = structuredClone(values), stableExpected = expectedMetadata ? structuredClone(expectedMetadata) : undefined;
    return this.changeItems(snapshot => updateLibraryBibliography(snapshot, itemId, stableValues, stableExpected));
  };
  restoreDeleted = (deletionId: string): Promise<boolean> =>
    this.changeItems(snapshot => restoreDeletedLibraryItems(snapshot, deletionId));
  cancelCreate = async (): Promise<boolean> => {
    if (this.attachmentSource) return this.cancelAttachment();
    if (!this.active() || this.working) return false;
    if (!this.pending && !await this.refresh()) return false;
    if (!this.pending || this.pending.kind !== 'create') return false;
    this.working = true; const generation = ++this.generation;
    this.pending.lifecycle.requestUndo();
    this.update({ busy: true, pendingKind: 'undo', error: '' });
    try { return await this.flushPending(generation); }
    catch (error) { if (this.active() && generation === this.generation) this.update({ error: String(error) }); return false; }
    finally { this.working = false; if (this.active() && generation === this.generation) this.update({ busy: false }); }
  };
  deleteItems = async (ids: readonly string[], childNotes: LibraryDeleteMode = 'detach'): Promise<boolean> => {
    const stableIds = structuredClone(ids);
    if (!this.active() || this.working || this.pending || this.resolution || this.attachmentSource || !this.state.ready || this.recoveryBlocked) return false;
    this.working = true; const generation = ++this.generation; this.update({ busy: true, error: '' });
    try {
      if (await this.journal.reload()) throw new Error('library-recovery-required');
      let read = await this.catalog(); if (!this.active() || generation !== this.generation) return false;
      if (read.read.heads.length !== 1 || !read.value) throw new Error('library-head-selection-required');
      const initial = resolveLibraryDeleteTargets(read.value, stableIds, childNotes);
      if (this.prepareDeleteTargets) {
        if (!await this.prepareDeleteTargets(initial.deleteIds)) throw new Error('library-delete-target-busy');
        if (!this.active() || generation !== this.generation) return false;
        if (await this.journal.reload()) throw new Error('library-recovery-required');
        read = await this.catalog(); if (!this.active() || generation !== this.generation) return false;
        if (read.read.heads.length !== 1 || !read.value) throw new Error('library-head-selection-required');
      }
      const { deleteIds } = resolveLibraryDeleteTargets(read.value, stableIds, childNotes);
      if (this.prepareDeleteTargets && deleteIds.some(id => !initial.deleteIds.includes(id))) {
        if (!await this.prepareDeleteTargets(deleteIds)) throw new Error('library-delete-target-busy');
        if (!this.active() || generation !== this.generation) return false;
      }
      const byId = new Map(read.value.items.map(item => [item.id, item]));
      const observed: Record<string, string[]> = {};
      for (const targetId of deleteIds) {
        if (byId.get(targetId)?.kind === 'attachment') continue;
        const targetRead = await this.repository.read(targetId);
        if (!this.active() || generation !== this.generation) return false;
        observed[targetId] = [...targetRead.heads];
      }
      if (this.canDeleteTargetsSync && !this.canDeleteTargetsSync(deleteIds)) throw new Error('library-delete-target-busy');
      const before = read.value;
      const changes = deleteLibraryItems(before, { id: this.makeId(), itemIds: stableIds, childNotes, observed });
      const batchId = this.makeId();
      const batch: LibraryEditBatch = { kind: 'library', id: batchId, libraryId: before.id, targetId: before.id, parents: [before.version], changes };
      const history: HistoryRecord = { operationId: batchId, beforeVersion: before.version, afterVersion: batchId, undoRequested: false };
      this.installEdit(batch, history, before, read);
      this.update({ pendingId: batch.id, pendingKind: this.pending!.kind, createdId: null, createdFolderId: null });
      return await this.flushPending(generation);
    } catch (error) { if (this.active() && generation === this.generation) this.update({ error: String(error) }); return false; }
    finally { this.working = false; if (this.active() && generation === this.generation) this.update({ busy: false }); }
  };
  private historyEdit = async (kind: 'undo' | 'redo'): Promise<boolean> => {
    if (!this.active() || this.working || this.pending || this.resolution || this.attachmentSource || !this.state.ready || this.recoveryBlocked) return false;
    this.working = true; const generation = ++this.generation; this.update({ busy: true, error: '' });
    try {
      if (await this.journal.reload()) throw new Error('library-recovery-required');
      let read = await this.catalog(); if (!this.active() || generation !== this.generation) return false;
      if (read.read.heads.length !== 1 || !read.value) throw new Error('library-head-selection-required');
      const resolveCommand = async (currentRead: Awaited<ReturnType<LibrarySession['catalog']>>) => {
        const before = currentRead.value!, versions = this.versions(currentRead);
        const restored = restoreLibraryHistory(versions, before.version, currentRead.read.history);
        const entries = restored[kind], entry = entries[entries.length - 1];
        if (!entry) throw new Error('library-history-empty');
        const origin = versions.publicationOrigin(entry.executionId);
        const observed: DeletionRecord['observed'] = [];
        if (origin && origin.kind !== 'attachment') {
          const content = await this.repository.read(origin.itemId);
          if (!this.active() || generation !== this.generation) throw new Error('library-scope-inactive');
          if (content.checkpoint.libraryId !== this.repository.scope.libraryId || content.checkpoint.root.id !== origin.itemId
            || !content.heads.length || content.waiting.length) throw new Error('library-content-unavailable');
          currentRead.deletedGraphs.set(origin.itemId, new EditGraph(content.checkpoint));
          observed.push({ targetId: origin.itemId, heads: [...content.heads] });
        }
        const id = this.makeId(), batch = inverseLibraryEdit(versions, entry.executionId, before, id, { observed });
        const activeDeletion = batch.changes.find(change => change.type === 'put-deletion' && change.deletion.active);
        const deleteIds = activeDeletion && activeDeletion.type === 'put-deletion' ? activeDeletion.deletion.itemIds : [];
        return {
          before, batch, deleteIds,
          history: { operationId: id, beforeVersion: before.version, afterVersion: id, undoRequested: false, action: { kind, operationId: entry.operationId } } satisfies HistoryRecord,
        };
      };
      let command = await resolveCommand(read);
      if (!this.active() || generation !== this.generation) return false;
      if (command.deleteIds.length && this.prepareDeleteTargets) {
        if (!await this.prepareDeleteTargets(command.deleteIds)) throw new Error('library-delete-target-busy');
        if (!this.active() || generation !== this.generation) return false;
        if (await this.journal.reload()) throw new Error('library-recovery-required');
        read = await this.catalog(); if (!this.active() || generation !== this.generation) return false;
        if (read.read.heads.length !== 1 || !read.value) throw new Error('library-head-selection-required');
        const initialDeleteIds = command.deleteIds;
        command = await resolveCommand(read);
        if (!this.active() || generation !== this.generation) return false;
        if (command.deleteIds.some(id => !initialDeleteIds.includes(id))) {
          if (!await this.prepareDeleteTargets(command.deleteIds)) throw new Error('library-delete-target-busy');
          if (!this.active() || generation !== this.generation) return false;
        }
      }
      if (command.deleteIds.length && this.canDeleteTargetsSync && !this.canDeleteTargetsSync(command.deleteIds)) {
        throw new Error('library-delete-target-busy');
      }
      this.installEdit(command.batch, command.history, command.before, read);
      this.update({ pendingId: command.batch.id, pendingKind: this.pending!.kind, createdId: null, createdFolderId: null });
      return await this.flushPending(generation);
    } catch (error) { if (this.active() && generation === this.generation) this.update({ error: String(error) }); return false; }
    finally { this.working = false; if (this.active() && generation === this.generation) this.update({ busy: false }); }
  };
  undo = () => this.historyEdit('undo');
  redo = () => this.historyEdit('redo');
  retry = async (): Promise<boolean> => {
    if (this.resolution) {
      if (!this.active() || this.working || this.resolutionDiscarding) return false;
      const pending = this.resolution; this.working = true; const generation = ++this.generation; this.update({ busy: true, error: '' });
      try {
        await pending.lifecycle.flush();
        if (!this.active() || generation !== this.generation || this.resolution !== pending) return false;
        const result = pending.lifecycle.getSnapshot();
        if (result.phase !== 'durable') { this.update({ error: result.error || 'library-resolution-unconfirmed' }); return false; }
        const read = await this.catalog(pending.batch.id);
        if (!this.active() || generation !== this.generation || this.resolution !== pending) return false;
        this.resolution = undefined; this.display(read); return true;
      } catch (error) { this.update({ error: String(error) }); return false; }
      finally { this.working = false; if (this.active()) this.update({ busy: false }); }
    }
    if (this.attachmentSource) return this.retryAttachment();
    if (!this.active() || this.working) return false;
    if (!this.pending && !await this.refresh()) return false;
    if (!this.pending) return true;
    this.working = true; const generation = ++this.generation; this.update({ busy: true, error: '' });
    try { return await this.flushPending(generation); }
    catch (error) { if (this.active() && generation === this.generation) this.update({ error: String(error) }); return false; }
    finally { this.working = false; if (this.active() && generation === this.generation) this.update({ busy: false }); }
  };
}
