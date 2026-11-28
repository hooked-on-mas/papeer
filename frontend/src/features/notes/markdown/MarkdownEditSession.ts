import type { EditorState } from '@codemirror/state';
import type { EditIntent, HistoryRecord, MarkdownEditBatch, MarkdownSnapshot, MarkdownImageResource, ResolutionBatch } from '../../../runtime/edits/contracts.ts';
import type { EditIntentRepository, ContentRepository } from '../../../runtime/edits/ports.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';
import { applyBatch, assertBatch, assertSnapshot, canonicalJson } from '../../../runtime/edits/editModel.ts';
import { assertResourceBindings, isImageMediaType, resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { analyzeMarkdownImages, markdownImageMarkup } from '../../../runtime/markdown/markdownImages.ts';
import { assertEditIntent } from '../../../runtime/edits/editIntent.ts';
import { BatchCommitSession } from '../../../runtime/edits/batchCommitSession.ts';
import { EditIntentJournal } from '../../../runtime/edits/intentJournal.ts';
import type { MarkdownDraft, MarkdownDraftPort } from './MarkdownDraftPort.ts';

export type MarkdownEditState = {
  ready: boolean; content: string; accepted: MarkdownSnapshot | null; pendingRemote: MarkdownSnapshot | null;
  imageResources: MarkdownImageResource[]; imageProblem: string; imagePending: boolean; imageSaving: boolean;
  heads: string[]; dirty: boolean; durable: boolean; saving: boolean; error: string; editingBlocked: boolean;
  generation: number; textGeneration: number; editorOwner: symbol | null; canUndo: boolean; canRedo: boolean;
};
type Entry = { operationId: string; executionId: string };
type Flight = NonNullable<MarkdownDraft['flight']> & { lifecycle: BatchCommitSession };
export type MarkdownImagePort = Pick<ContentRepository, 'scope' | 'storeResource' | 'readResource' | 'resourceMetadata'>;
export type MarkdownImageInput = { bytes: Promise<Uint8Array> | Uint8Array | (() => Promise<Uint8Array>); mediaType: string; alt?: string; appendId?: string; suffix?: string };
type PendingImage = { resourceId: string; appendId: string; input: MarkdownImageInput; bytes?: Uint8Array; sha256?: string };
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sameScope = (a: MarkdownDraftPort['scope'], b: MarkdownDraftPort['scope']) =>
  a.accountId === b.accountId && a.libraryId === b.libraryId && a.epoch === b.epoch;
// Manifest ordering has no meaning. Sort copies for comparison; immutable retry payloads stay untouched.
const imageManifestKey = (images: MarkdownImageResource[]) => canonicalJson([...images].sort((a, b) =>
  a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));

/** Canonical Markdown owns the edit-start version, not the last remote notification. */
export class MarkdownEditSession {
  private state: MarkdownEditState = { ready: false, content: '', accepted: null, pendingRemote: null, heads: [],
    imageResources: [], imageProblem: '', imagePending: false, imageSaving: false,
    dirty: false, durable: true, saving: false, error: '', editingBlocked: false, generation: 0, textGeneration: 0,
    editorOwner: null, canUndo: false, canRedo: false };
  private readonly listeners = new Set<() => void>();
  private readonly journal: EditIntentJournal;
  private graph?: EditGraph;
  private records: HistoryRecord[] = [];
  private batches = new Map<string, MarkdownEditBatch>();
  private undoEntries: Entry[] = [];
  private redoEntries: Entry[] = [];
  private appendIds: string[] = [];
  private appendSnapshots: NonNullable<MarkdownDraft['appendSnapshots']> = [];
  private pending?: Flight;
  private resolution?: { batch: ResolutionBatch; lifecycle: BatchCommitSession };
  private resolutionDiscarding = false;
  private flight?: Promise<void>;
  private loaded = false;
  private readGeneration = 0;
  private editorState?: EditorState;
  private scratchFailed = false;
  private pendingImage?: PendingImage;
  private imageFlight?: Promise<boolean>;
  private readonly repository: EditIntentRepository;
  readonly documentId: string;
  private readonly drafts: MarkdownDraftPort;
  private readonly makeId: () => string;
  private readonly enabled: () => boolean;
  private readonly images?: MarkdownImagePort;
  constructor(repository: EditIntentRepository, documentId: string,
    drafts: MarkdownDraftPort, makeId: () => string = () => crypto.randomUUID(), enabled: () => boolean = () => true, images?: MarkdownImagePort) {
    if (!sameScope(repository.scope, drafts.scope)) throw new Error('markdown-draft-scope');
    if (images && !sameScope(repository.scope, images.scope)) throw new Error('markdown-image-scope');
    this.repository = repository; this.documentId = documentId; this.drafts = drafts; this.makeId = makeId; this.enabled = enabled;
    this.journal = new EditIntentJournal(repository, documentId, makeId); this.images = images;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getEditorState = () => this.editorState;
  setEditorState = (state: EditorState) => { this.editorState = state; };
  private update(fields: Partial<MarkdownEditState>) {
    this.state = { ...this.state, ...fields };
    const available = this.state.ready && !this.state.dirty && !this.pending && !this.resolution && !this.state.editingBlocked && !this.state.saving && !this.scratchFailed && !this.pendingImage && !this.imageFlight;
    this.state.canUndo = available && this.undoEntries.length > 0;
    this.state.canRedo = available && this.redoEntries.length > 0;
    this.listeners.forEach(listener => listener());
  }
  reportError = (error: unknown) => this.update({ error: String(error) });
  acquireEditor = (owner: symbol): boolean => {
    if (this.state.editorOwner && this.state.editorOwner !== owner) return false;
    this.update({ editorOwner: owner }); return true;
  };
  releaseEditor = (owner: symbol) => { if (this.state.editorOwner === owner) this.update({ editorOwner: null }); };
  canLeave = () => this.state.ready && !this.state.editingBlocked && !this.state.dirty && !this.pending && !this.resolution && !this.flight && !this.scratchFailed && !this.pendingImage && !this.imageFlight;
  conflictVersions = (): readonly MarkdownSnapshot[] => this.state.heads.map(head => structuredClone(this.snapshot(head)));
  canDiscardRejectedResolution = () => !!this.resolution && !this.resolutionDiscarding && this.resolution.lifecycle.getSnapshot().phase === 'aborted';
  private resolutionFlight(batch: ResolutionBatch, intent?: EditIntent) {
    if (batch.snapshot.kind !== 'markdown' || batch.snapshot.id !== this.documentId || batch.targetId !== this.documentId
      || batch.libraryId !== this.repository.scope.libraryId || batch.snapshot.version !== batch.id) throw new Error('markdown-resolution-invalid');
    this.assertImagePair(batch.snapshot.content, batch.snapshot.imageResources, true);
    return { batch: structuredClone(batch), lifecycle: new BatchCommitSession(this.repository, { batch }, () => { throw new Error('resolution-undo-unsupported'); },
      intent?.dispatched ? 'unknown' : 'new', { journal: this.journal, ...(intent ? { intent } : {}) }) };
  }
  resolveConflict = async (version: string, expectedHeads: readonly string[]): Promise<boolean> => {
    if (!this.enabled() || !this.canLeave() || expectedHeads.length < 2 || !expectedHeads.includes(version)
      || canonicalJson([...expectedHeads].sort()) !== canonicalJson([...this.state.heads].sort()) || new Set(expectedHeads).size !== expectedHeads.length) return false;
    const selected = this.snapshot(version), id = this.makeId();
    const batch: ResolutionBatch = { kind: 'resolution', id, libraryId: this.repository.scope.libraryId, targetId: this.documentId,
      parents: [...expectedHeads], snapshot: { ...selected, version: id } };
    this.readGeneration++; this.resolution = this.resolutionFlight(batch); this.update({ saving: true, durable: false, error: '' });
    await this.retryResolution(); return !this.resolution;
  };
  discardRejectedResolution = async (): Promise<boolean> => {
    const pending = this.resolution;
    if (!this.enabled() || !pending || this.resolutionDiscarding || pending.lifecycle.getSnapshot().phase !== 'aborted') return false;
    this.resolutionDiscarding = true;
    try {
      await this.journal.clear();
      if (this.resolution !== pending) return false;
      this.resolution = undefined; this.update({ durable: true, error: '' });
      return await this.refresh();
    } catch (error) { this.reportError(error); return false; }
    finally { this.resolutionDiscarding = false; }
  };
  private async retryResolution(): Promise<void> {
    const pending = this.resolution; if (!pending || this.resolutionDiscarding || !this.enabled()) return;
    this.update({ saving: true, error: '' }); await pending.lifecycle.flush();
    if (this.resolution !== pending) return;
    const status = pending.lifecycle.getSnapshot();
    if (status.phase !== 'durable') { this.update({ saving: false, durable: false, error: status.error || 'markdown-resolution-unconfirmed' }); return; }
    this.resolution = undefined; this.update({ saving: false, durable: true });
    await this.refresh(pending.batch.id);
  }
  canAppendImage = () => !!this.images;
  appendStatus = (id: string): 'unseen' | 'pending' | 'accepted' => this.state.accepted?.appendIds.includes(id) ? 'accepted'
    : this.appendIds.includes(id) || this.pendingImage?.appendId === id || this.pending?.batch.appendId === id ? 'pending' : 'unseen';
  appendImage = (input: MarkdownImageInput, owner?: symbol): Promise<boolean> => {
    if (input.appendId !== undefined && (!idPattern.test(input.appendId) || input.appendId.length !== 36)) return Promise.resolve(false);
    if (!this.enabled() || !this.state.ready || this.state.editingBlocked || this.resolution || !this.images
      || (owner && this.state.editorOwner !== owner) || this.state.imageProblem) return Promise.resolve(false);
    if (input.appendId && this.pendingImage?.appendId === input.appendId) return this.prepareImage();
    if (input.appendId && this.appendStatus(input.appendId) !== 'unseen') return Promise.resolve(true);
    if (this.pendingImage || this.imageFlight) return Promise.resolve(false);
    this.readGeneration++;
    this.pendingImage = { resourceId: this.makeId(), appendId: input.appendId ?? this.makeId(),
      input: { ...input, bytes: input.bytes instanceof Uint8Array ? Uint8Array.from(input.bytes) : input.bytes } };
    this.update({ imagePending: true, durable: false });
    return this.prepareImage();
  };
  cancelImage = (owner?: symbol): boolean => {
    if (!this.enabled() || !this.pendingImage || (owner && owner !== this.state.editorOwner)) return false;
    this.pendingImage = undefined;
    this.update({ imagePending: false, error: this.pending || this.scratchFailed ? this.state.error : '',
      durable: !this.state.dirty && !this.pending && !this.scratchFailed });
    return true;
  };
  /** Trusted append authority may cancel only its own image preparation, never an appended batch. */
  canCancelImageAppend = (id: string): boolean => this.enabled() && this.pendingImage?.appendId === id;
  cancelImageAppend = (id: string): boolean => this.canCancelImageAppend(id) && this.cancelImage();
  private prepareImage(): Promise<boolean> {
    if (this.imageFlight) return this.imageFlight;
    const entry = this.pendingImage, resources = this.images;
    if (!entry || !resources || !this.enabled()) return Promise.resolve(false);
    this.update({ imageSaving: true, error: '' });
    this.imageFlight = Promise.resolve().then(async () => {
      if (this.pendingImage !== entry || !this.enabled()) return false;
      if (!isImageMediaType(entry.input.mediaType)) throw new Error('markdown-image-media-type');
      if (!sameScope(this.repository.scope, resources.scope)) throw new Error('markdown-image-scope');
      entry.bytes ??= Uint8Array.from(await (typeof entry.input.bytes === 'function' ? entry.input.bytes() : entry.input.bytes));
      if (this.pendingImage !== entry) return false;
      entry.sha256 ??= await resourceHash(entry.bytes);
      if (this.pendingImage !== entry) return false;
      if (!sameScope(this.repository.scope, resources.scope) || !this.enabled()) throw new Error('markdown-image-scope');
      const metadata = await resources.storeResource({ id: entry.resourceId, sha256: entry.sha256,
        mediaType: entry.input.mediaType, bytes: entry.bytes });
      if (this.pendingImage !== entry) return false;
      if (metadata.id !== entry.resourceId || metadata.sha256 !== entry.sha256 || metadata.mediaType !== entry.input.mediaType
        || metadata.byteLength !== entry.bytes.byteLength) throw new Error('markdown-image-resource-mismatch');
      const stored = await resources.readResource(entry.resourceId);
      if (this.pendingImage !== entry) return false;
      if (!stored || canonicalJson(stored.metadata) !== canonicalJson(metadata) || await resourceHash(stored.bytes) !== entry.sha256)
        throw new Error('markdown-image-resource-unconfirmed');
      if (this.pendingImage !== entry || !this.enabled()) return false;
      const alt = Array.from(entry.input.alt ?? '画像').slice(0, 200).join('');
      if (!this.appendText(entry.appendId, `\n\n${markdownImageMarkup({ resourceId: entry.resourceId, sha256: entry.sha256 }, alt)}\n${entry.input.suffix ?? ''}`)) return false;
      this.pendingImage = undefined;
      return true;
    }).catch(error => { if (this.pendingImage === entry) this.reportError(error); return false; }).finally(() => {
      this.imageFlight = undefined;
      this.update({ imageSaving: false, imagePending: !!this.pendingImage,
        durable: !this.state.dirty && !this.pending && !this.pendingImage && !this.scratchFailed });
    });
    return this.imageFlight;
  }
  private snapshot(version: string): MarkdownSnapshot {
    const value = this.graph?.snapshot(version);
    if (value?.kind !== 'markdown' || value.id !== this.documentId) throw new Error('markdown-base-missing');
    return value;
  }
  private assertImagePair(content: string, imageResources: MarkdownImageResource[], immutable = false) {
    const analysis = analyzeMarkdownImages(content);
    if ((immutable && analysis.problems.length) || imageManifestKey(analysis.imageResources) !== imageManifestKey(imageResources))
      throw new Error('markdown-draft-image-mismatch');
  }
  private validateDraft(raw: unknown): MarkdownDraft {
    if (!raw || typeof raw !== 'object') throw new Error('markdown-draft-invalid');
    const value = raw as MarkdownDraft;
    if (Object.keys(value).some(key => !['version', 'documentId', 'baseVersion', 'content', 'imageResources', 'generation', 'appendIds', 'appendSnapshots', 'flight'].includes(key))
      || value.version !== 1 || value.documentId !== this.documentId || !idPattern.test(value.baseVersion)
      || typeof value.content !== 'string' || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !Array.isArray(value.appendIds) || value.appendIds.some(id => typeof id !== 'string' || !idPattern.test(id))
      || new Set(value.appendIds).size !== value.appendIds.length) throw new Error('markdown-draft-invalid');
    const base = this.snapshot(value.baseVersion);
    assertSnapshot({ ...base, imageResources: value.imageResources });
    this.assertImagePair(value.content, value.imageResources);
    if (value.appendSnapshots !== undefined && (!Array.isArray(value.appendSnapshots)
      || value.appendSnapshots.length !== value.appendIds.length || value.appendSnapshots.some((entry, index) => !entry
        || entry.id !== value.appendIds[index] || typeof entry.content !== 'string'
        || !Number.isSafeInteger(entry.generation) || entry.generation < 0 || entry.generation > value.generation)))
      throw new Error('markdown-draft-appends');
    for (const entry of value.appendSnapshots ?? []) {
      assertSnapshot({ ...base, imageResources: entry.imageResources });
      this.assertImagePair(entry.content, entry.imageResources, true);
    }
    if (value.appendIds.some(id => base.appendIds.includes(id))) throw new Error('markdown-draft-append-already-applied');
    if (value.flight !== undefined && (!value.flight || typeof value.flight !== 'object'
      || Object.keys(value.flight).some(key => !['batch', 'history', 'generation'].includes(key)))) throw new Error('markdown-draft-flight');
    if (value.flight) {
      const { batch, history, generation } = value.flight;
      assertBatch(batch);
      if (batch.kind === 'markdown') this.assertImagePair(batch.content, batch.imageResources, true);
      if (batch.kind !== 'markdown' || batch.targetId !== this.documentId || batch.libraryId !== this.repository.scope.libraryId
        || batch.parents.length !== 1 || batch.parents[0] !== base.version
        || !Number.isSafeInteger(generation) || generation < 0 || generation > value.generation
        || (batch.appendId && !value.appendIds.includes(batch.appendId))) throw new Error('markdown-draft-flight');
      assertEditIntent({ id: batch.id, intent: { request: { batch, history }, dispatched: true, undoRequested: false } },
        this.repository.scope.libraryId, this.documentId);
      const known = this.batches.get(batch.id);
      if (known && canonicalJson(known) !== canonicalJson(batch)) throw new Error('markdown-draft-flight-mismatch');
      applyBatch(base, batch);
    }
    return structuredClone(value);
  }
  private scratch(): boolean {
    if (this.state.editingBlocked || !this.state.accepted) return false;
    try {
      if (!sameScope(this.repository.scope, this.drafts.scope)) throw new Error('markdown-draft-scope');
      if (!this.state.dirty && !this.pending) this.drafts.remove(this.documentId);
      else this.drafts.write(this.documentId, { version: 1, documentId: this.documentId, baseVersion: this.state.accepted.version,
        content: this.state.content, imageResources: this.state.imageResources, generation: this.state.generation, appendIds: [...this.appendIds], appendSnapshots: this.appendSnapshots,
        ...(this.pending ? { flight: { batch: this.pending.batch, history: this.pending.history, generation: this.pending.generation } } : {}) });
      const recovered = this.scratchFailed;
      this.scratchFailed = false; this.update({ durable: !this.state.dirty && !this.pending && !this.pendingImage, ...(recovered ? { error: '' } : {}) }); return true;
    } catch (error) { this.scratchFailed = true; this.update({ durable: false, error: String(error) }); return false; }
  }
  private restoreHistory(version: string) {
    const path: MarkdownEditBatch[] = [], seen = new Set<string>();
    let next = version;
    while (!seen.has(next)) {
      seen.add(next); const batch = this.batches.get(next); if (!batch || batch.parents.length !== 1) break;
      path.push(batch); next = batch.parents[0];
    }
    this.undoEntries = []; this.redoEntries = [];
    const records = new Map(this.records.map(record => [record.operationId, record]));
    for (const batch of path.reverse()) {
      const record = records.get(batch.id);
      if (!record) { this.undoEntries = []; this.redoEntries = []; continue; }
      if (record.beforeVersion !== batch.parents[0] || record.afterVersion !== batch.id) throw new Error('markdown-history-mismatch');
      if (!record.action) { this.undoEntries.push({ operationId: batch.id, executionId: batch.id }); this.redoEntries = []; }
      else {
        const source = record.action.kind === 'undo' ? this.undoEntries : this.redoEntries;
        const target = record.action.kind === 'undo' ? this.redoEntries : this.undoEntries;
        const entry = source[source.length - 1];
        if (entry?.operationId !== record.action.operationId) { this.undoEntries = []; this.redoEntries = []; continue; }
        source.pop(); target.push({ operationId: entry.operationId, executionId: batch.id });
      }
      if (this.undoEntries.length > 50) this.undoEntries.shift();
    }
  }
  private createFlight(value: NonNullable<MarkdownDraft['flight']>, intent?: EditIntent): Flight {
    this.assertImagePair(value.batch.content, value.batch.imageResources, true);
    const before = this.snapshot(value.batch.parents[0]);
    applyBatch(before, value.batch);
    const lifecycle = new BatchCommitSession(this.repository, { batch: value.batch, history: value.history }, () => {
      const id = this.makeId();
      return { batch: { kind: 'markdown', id, libraryId: value.batch.libraryId, targetId: this.documentId,
        parents: [value.batch.id], content: before.content, imageResources: before.imageResources }, history: { operationId: id, beforeVersion: value.batch.id,
        afterVersion: id, undoRequested: false, action: { kind: 'undo', operationId: value.batch.id } } };
    }, intent?.dispatched ? 'unknown' : 'new', { journal: this.journal, ...(intent ? { intent } : {}) });
    return { ...structuredClone(value), lifecycle };
  }
  async refresh(preferred?: string): Promise<boolean> {
    if (this.flight || this.imageFlight || this.pendingImage) return false;
    const request = ++this.readGeneration;
    try {
      const read = await this.repository.read(this.documentId);
      if (request !== this.readGeneration || this.flight) return false;
      const graph = new EditGraph(read.checkpoint);
      if (graph.root.kind !== 'markdown') throw new Error('markdown-required');
      this.graph = graph; this.records = read.history;
      this.batches = new Map(read.checkpoint.batches.filter((batch): batch is MarkdownEditBatch => batch.kind === 'markdown').map(batch => [batch.id, batch]));
      // First opening may require an explicit branch choice; expose choices before recovery can refuse adoption.
      this.update({ heads: read.heads });
      if (!this.loaded) {
        const raw = this.drafts.read(this.documentId);
        const draft = raw === undefined ? undefined : this.validateDraft(raw);
        const recovered = await this.journal.reload();
        if (request !== this.readGeneration) return false;
        let savedFlight = draft?.flight;
        if (recovered) {
          const { intent } = recovered;
          if ('batch' in intent.request && intent.request.batch.kind === 'resolution') {
            if (draft || intent.request.history || intent.undoRequested) throw new Error('unsupported-markdown-resolution-intent');
            this.resolution = this.resolutionFlight(intent.request.batch, intent);
          } else if (!('batch' in intent.request) || intent.request.batch.kind !== 'markdown' || !intent.request.history || intent.undoRequested)
            throw new Error('unsupported-markdown-intent');
          else {
            const { batch, history } = intent.request;
            if (savedFlight && canonicalJson({ batch: savedFlight.batch, history: savedFlight.history }) !== canonicalJson(intent.request))
              throw new Error('markdown-draft-intent-mismatch');
            if (draft && !savedFlight) throw new Error('markdown-draft-intent-mismatch');
            savedFlight = { batch, history, generation: savedFlight?.generation ?? draft?.generation ?? 1 };
          }
        }
        const selected = draft?.baseVersion ?? savedFlight?.batch.parents[0] ?? this.resolution?.batch.parents[0] ?? preferred ?? (read.heads.length === 1 ? read.heads[0] : undefined);
        if (!selected) throw new Error('markdown-head-selection-required');
        const accepted = this.snapshot(selected);
        this.appendIds = draft?.appendIds ?? (savedFlight?.batch.appendId ? [savedFlight.batch.appendId] : []);
        this.appendSnapshots = draft?.appendSnapshots ?? this.appendIds.map(id => ({ id,
          content: draft?.content ?? savedFlight!.batch.content, imageResources: draft?.imageResources ?? savedFlight!.batch.imageResources, generation: draft?.generation ?? savedFlight!.generation }));
        if (savedFlight) this.pending = this.createFlight(savedFlight, recovered?.intent ?? {
          request: { batch: savedFlight.batch, history: savedFlight.history }, dispatched: true, undoRequested: false });
        this.loaded = true; this.editorState = undefined;
        this.update({ ready: true, accepted, content: draft?.content ?? savedFlight?.batch.content ?? accepted.content,
          imageResources: draft?.imageResources ?? savedFlight?.batch.imageResources ?? accepted.imageResources,
          imageProblem: analyzeMarkdownImages(draft?.content ?? savedFlight?.batch.content ?? accepted.content).problems.join(', '),
          generation: draft?.generation ?? savedFlight?.generation ?? 0, textGeneration: this.state.textGeneration + 1,
          dirty: !!draft || !!savedFlight, durable: !draft && !savedFlight && !this.resolution, editingBlocked: false,
          error: this.resolution ? 'markdown-resolution-unconfirmed' : '' });
      }
      const remote = read.heads.length === 1 ? this.snapshot(read.heads[0]) : null;
      if (!this.state.dirty && !this.pending && !this.resolution) {
        const accepted = preferred ? this.snapshot(preferred) : remote ?? this.state.accepted!;
        if (accepted.version !== this.state.accepted?.version) {
          this.editorState = undefined;
          this.update({ accepted, content: accepted.content, imageResources: accepted.imageResources,
            imageProblem: analyzeMarkdownImages(accepted.content).problems.join(', '), textGeneration: this.state.textGeneration + 1 });
        }
      }
      this.restoreHistory(this.state.accepted!.version);
      this.update({ heads: read.heads, pendingRemote: remote?.version !== this.state.accepted?.version ? remote : null });
      return true;
    } catch (error) {
      this.update({ error: String(error), ...(!this.loaded ? { editingBlocked: true, durable: false } : {}) }); return false;
    }
  }
  editText = (content: string, owner?: symbol): boolean => {
    if (!this.enabled() || !this.state.ready || this.state.editingBlocked || this.resolution || (owner && owner !== this.state.editorOwner)
      || content === this.state.content) return false;
    this.readGeneration++;
    const analysis = analyzeMarkdownImages(content);
    this.update({ content, imageResources: analysis.imageResources, imageProblem: analysis.problems.join(', '),
      generation: this.state.generation + 1, dirty: true, durable: false }); this.scratch(); return true;
  };
  appendText = (appendId: string, text: string): boolean => {
    if (!idPattern.test(appendId)) throw new Error('markdown-append-id');
    if (!this.enabled() || !this.state.ready || this.state.editingBlocked || this.resolution || this.appendIds.includes(appendId)
      || this.state.accepted?.appendIds.includes(appendId) || this.state.imageProblem) return false;
    const analysis = analyzeMarkdownImages(this.state.content + text);
    if (analysis.problems.length) { this.update({ error: analysis.problems.join(', ') }); return false; }
    this.readGeneration++;
    this.appendIds.push(appendId);
    this.appendSnapshots.push({ id: appendId, content: this.state.content + text, imageResources: analysis.imageResources, generation: this.state.generation + 1 });
    this.update({ content: this.state.content + text, imageResources: analysis.imageResources, imageProblem: '', generation: this.state.generation + 1, dirty: true, durable: false });
    this.scratch(); return true;
  };
  flush = (): Promise<void> => {
    if (this.flight) return this.flight;
    if (!this.enabled() || !this.state.ready || this.state.editingBlocked || this.resolution) return Promise.resolve();
    if (!this.state.dirty && !this.pending && !this.scratchFailed) return Promise.resolve();
    // A read started before this write must not adopt its old head after the write becomes clean.
    this.readGeneration++;
    this.flight = Promise.resolve().then(async () => {
      while (this.state.dirty || this.pending) {
        if (this.state.imageProblem) { this.update({ error: this.state.imageProblem }); return; }
        if (!this.pending) {
          const generation = this.state.generation, version = this.state.accepted!.version;
          const targetImages = this.appendSnapshots[0]?.imageResources ?? this.state.imageResources;
          if (targetImages.length) {
            if (!this.images || !sameScope(this.repository.scope, this.images.scope)) throw new Error('markdown-image-service-unavailable');
            await assertResourceBindings({ ...this.state.accepted!, imageResources: targetImages }, id => this.images!.resourceMetadata(id));
            if (generation !== this.state.generation || version !== this.state.accepted!.version) continue;
          }
          const before = this.state.accepted!, id = this.makeId();
          const batch: MarkdownEditBatch = { kind: 'markdown', id, libraryId: this.repository.scope.libraryId,
            targetId: this.documentId, parents: [before.version], content: this.appendSnapshots[0]?.content ?? this.state.content,
            imageResources: this.appendSnapshots[0]?.imageResources ?? this.state.imageResources,
            ...(this.appendIds.length ? { appendId: this.appendIds[0] } : {}) };
          applyBatch(before, batch);
          this.pending = this.createFlight({ batch, generation: this.appendSnapshots[0]?.generation ?? this.state.generation,
            history: { operationId: id, beforeVersion: before.version, afterVersion: id, undoRequested: false } });
        }
        if (!this.scratch()) return;
        const pending = this.pending;
        this.update({ saving: true, error: '' }); await pending.lifecycle.flush();
        const status = pending.lifecycle.getSnapshot();
        if (status.phase !== 'durable') { this.update({ error: status.error || 'markdown-save-unconfirmed', durable: false }); return; }
        const accepted = applyBatch(this.state.accepted!, pending.batch) as MarkdownSnapshot;
        this.graph!.receive([pending.batch]); this.batches.set(pending.batch.id, pending.batch); this.records.push(pending.history);
        if (pending.batch.appendId) this.appendIds = this.appendIds.filter(id => id !== pending.batch.appendId);
        if (pending.batch.appendId) this.appendSnapshots = this.appendSnapshots.filter(value => value.id !== pending.batch.appendId);
        this.pending = undefined;
        this.restoreHistory(accepted.version);
        this.update({ accepted, dirty: this.state.content !== accepted.content || imageManifestKey(this.state.imageResources) !== imageManifestKey(accepted.imageResources) || this.appendIds.length > 0,
          heads: this.graph!.getView().heads, pendingRemote: null });
        // The old flight stays in scratch until the new base AND all later input are written together.
        if (!this.scratch()) return;
      }
      if (this.scratchFailed) this.scratch();
    }).catch(error => this.reportError(error)).finally(() => { this.flight = undefined; this.update({ saving: false }); });
    return this.flight;
  };
  retry = async () => { if (this.resolution) { await this.retryResolution(); return; } if (this.pendingImage && !await this.prepareImage()) return; await this.flush(); };
  private async history(kind: 'undo' | 'redo'): Promise<boolean> {
    if (!this.enabled() || !this.canLeave()) return false;
    const source = kind === 'undo' ? this.undoEntries : this.redoEntries, entry = source[source.length - 1];
    if (!entry) return false;
    const execution = this.batches.get(entry.executionId), current = this.state.accepted!;
    if (!execution || this.snapshot(execution.id).content !== current.content
      || imageManifestKey(this.snapshot(execution.id).imageResources) !== imageManifestKey(current.imageResources)) return false;
    const before = this.snapshot(execution.parents[0]), id = this.makeId();
    const batch: MarkdownEditBatch = { kind: 'markdown', id, libraryId: this.repository.scope.libraryId,
      targetId: this.documentId, parents: [current.version], content: before.content, imageResources: before.imageResources };
    const history: HistoryRecord = { operationId: id, beforeVersion: current.version, afterVersion: id, undoRequested: false,
      action: { kind, operationId: entry.operationId } };
    this.readGeneration++;
    this.pending = this.createFlight({ batch, history, generation: this.state.generation + 1 });
    this.editorState = undefined;
    this.update({ content: before.content, imageResources: before.imageResources, imageProblem: analyzeMarkdownImages(before.content).problems.join(', '), generation: this.state.generation + 1, textGeneration: this.state.textGeneration + 1,
      dirty: true, durable: false });
    this.scratch(); await this.flush(); return !this.pending && !this.state.dirty;
  }
  undo = () => this.history('undo');
  redo = () => this.history('redo');
}
