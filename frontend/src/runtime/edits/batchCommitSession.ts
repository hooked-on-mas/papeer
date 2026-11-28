import type { ContentPublication, EditBatch, EditIntent } from './contracts.ts';
import type { CommitResult, ContentRepository, EditRepository, HistoryRecord } from './ports.ts';
import type { BatchIntentJournal } from './intentJournal.ts';
import { canonicalJson } from './editModel.ts';

export type BatchCommitState = { phase: 'idle' | 'saving' | 'aborted' | 'unknown' | 'durable' | 'cancelled' | 'undone'; undoRequested: boolean; error: string; inverseId?: string };
type EditRequest = { batch: EditBatch; history?: HistoryRecord };
type PublicationRequest = { publication: ContentPublication; history?: HistoryRecord };
type CommitPort = Pick<EditRepository, 'commit'> & Partial<Pick<ContentRepository, 'publish'>>;
export type CommitSessionRecovery = { journal: BatchIntentJournal; intent?: EditIntent };

/** One history operation's durable lifecycle. A timeout never means a successful cancellation. */
export class BatchCommitSession {
  private readonly repository: CommitPort;
  private readonly original: EditRequest | PublicationRequest;
  private readonly makeInverse: () => EditRequest;
  private inverse?: EditRequest;
  private originalDurable = false;
  private originalUncertain = false;
  private dispatched = false;
  private cancelRequested = false;
  private readonly journal?: BatchIntentJournal;
  private flight?: Promise<void>;
  private state: BatchCommitState = { phase: 'idle', undoRequested: false, error: '' };
  private listeners = new Set<() => void>();
  constructor(repository: Pick<ContentRepository, 'commit' | 'publish'>, original: PublicationRequest, makeInverse: () => EditRequest, initial?: 'new' | 'unknown' | 'durable', recovery?: CommitSessionRecovery);
  constructor(repository: Pick<EditRepository, 'commit'>, original: EditRequest, makeInverse: () => EditRequest, initial?: 'new' | 'unknown' | 'durable', recovery?: CommitSessionRecovery);
  constructor(repository: CommitPort, original: EditRequest | PublicationRequest, makeInverse: () => EditRequest,
    initial: 'new' | 'unknown' | 'durable' = 'new', recovery?: CommitSessionRecovery) {
    if ('publication' in original && !repository.publish) throw new Error('publication-repository-required');
    this.repository = repository; this.original = structuredClone(original); this.makeInverse = makeInverse;
    if (recovery?.intent && canonicalJson(recovery.intent.request) !== canonicalJson(original)) throw new Error('intent-request-mismatch');
    if (recovery?.intent?.dispatched && initial === 'new') initial = 'unknown';
    this.journal = recovery?.journal;
    this.dispatched = recovery?.intent?.dispatched ?? initial !== 'new';
    this.inverse = recovery?.intent?.inverse ? structuredClone(recovery.intent.inverse) : undefined;
    this.cancelRequested = !!recovery?.intent?.undoRequested && !this.dispatched;
    // Recovered durable/unknown operations must never be treated as an unstarted, cancellable edit.
    this.originalDurable = initial === 'durable'; this.originalUncertain = initial === 'unknown';
    this.state = { ...this.state, phase: initial === 'new' ? 'idle' : initial,
      undoRequested: recovery?.intent?.undoRequested ?? false, ...(this.inverse ? { inverseId: this.inverse.batch.id } : {}) };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<BatchCommitState>) { this.state = { ...this.state, ...fields }; this.listeners.forEach(listener => listener()); }
  canLeave = () => ['cancelled', 'undone'].includes(this.state.phase) || (this.state.phase === 'durable' && !this.state.undoRequested);
  requestUndo = () => {
    if (this.state.undoRequested || this.state.phase === 'undone' || this.state.phase === 'cancelled') return;
    if (!this.flight && !this.originalDurable && !this.originalUncertain && (this.state.phase === 'idle' || this.state.phase === 'aborted')) {
      if (!this.journal) { this.update({ phase: 'cancelled', undoRequested: true, error: '' }); return; }
      this.cancelRequested = true;
    }
    this.update({ undoRequested: true });
    // Persist immediately even while the original HTTP response is still pending.
    if (this.journal) void this.persist().catch(() => undefined);
    if (!this.flight) void this.flush();
  };
  private persist(): Promise<void> {
    return this.journal?.save({ request: this.original, dispatched: this.dispatched, undoRequested: this.state.undoRequested,
      ...(this.inverse ? { inverse: this.inverse } : {}) }) ?? Promise.resolve();
  }
  private async write(request: EditRequest | PublicationRequest): Promise<CommitResult> {
    try {
      return 'publication' in request ? await this.repository.publish!(request.publication, request.history)
        : await this.repository.commit(request.batch, request.history);
    }
    catch (error) { return { status: 'unknown', reason: String(error) }; }
  }
  flush = (): Promise<void> => {
    if (this.flight) return this.flight;
    if (['cancelled', 'undone'].includes(this.state.phase) || (this.state.phase === 'durable' && !this.state.undoRequested)) return Promise.resolve();
    // Before yielding, mark in flight so Undo cannot declare an unstarted cancellation after dispatch.
    this.state = { ...this.state, phase: 'saving', error: '' };
    this.flight = Promise.resolve().then(async () => {
      if (this.journal) await this.persist();
      if (this.cancelRequested && !this.originalDurable && !this.originalUncertain) {
        await this.journal?.clear(); this.update({ phase: 'cancelled', error: '' }); return;
      }
      if (!this.originalDurable) {
        this.dispatched = true;
        if (this.journal) await this.persist();
        const result = await this.write(this.original);
        if (result.status !== 'durable') {
          this.originalUncertain ||= result.status === 'unknown';
          this.update({ phase: this.originalUncertain ? 'unknown' : 'aborted', error: result.reason }); return;
        }
        this.originalDurable = true;
      }
      if (!this.state.undoRequested) {
        await this.journal?.clear();
        if (!this.state.undoRequested) { this.update({ phase: 'durable', error: '' }); return; }
      }
      // A missing receipt is deliberately not used to infer that the earlier request aborted.
      // Same-ID resend above confirms acceptance before a new inverse batch is allowed.
      try { this.inverse ??= structuredClone(this.makeInverse()); }
      catch (error) { this.update({ phase: 'aborted', error: String(error) }); return; }
      this.update({ phase: 'saving', inverseId: this.inverse.batch.id });
      if (this.journal) await this.persist();
      const result = await this.write(this.inverse);
      if (result.status === 'durable') { await this.journal?.clear(); this.update({ phase: 'undone', error: '' }); }
      else this.update({ phase: result.status, error: result.reason });
    }).catch(error => {
      this.update({ phase: this.originalUncertain ? 'unknown' : 'aborted', error: String(error) });
    }).finally(() => {
      this.flight = undefined;
      // A subscriber may request Undo synchronously while the durable notification
      // is being delivered, after the main loop's last Undo check.
      if (this.state.phase === 'durable' && this.state.undoRequested) return this.flush();
    });
    this.update({});
    return this.flight;
  };
}
