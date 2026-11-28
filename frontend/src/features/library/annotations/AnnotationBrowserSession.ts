import type { LibraryItem, LibrarySnapshot } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository, EditScope } from '../../../runtime/edits/ports.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { createCanonicalAnnotationCorpus, type AnnotationCorpusPort, type AnnotationCorpusEntry, type ExistingConfirmedAnnotationModel } from './canonicalAnnotationCorpus.ts';
import { projectCanonicalAnnotations, filterCanonicalAnnotations, freezeAnnotationExport,
  type AnnotationBrowserRow, type AnnotationBrowserFilter, type AnnotationBrowserExport } from './canonicalAnnotationBrowser.ts';

export type AnnotationBrowserQuery = AnnotationBrowserFilter & { scope: 'current' | 'all' };
export type AnnotationBrowserState = {
  query: Readonly<AnnotationBrowserQuery>; rows: readonly AnnotationBrowserRow[]; loading: boolean;
  missingIds: readonly string[]; partialIds: readonly string[]; conflictedIds: readonly string[]; staleIds: readonly string[];
  selectedKey: string | null; scroll: Readonly<{ rowKey: string; offset: number }> | null;
  error: string; exportError: string;
};
export type AnnotationLocationValidation = { status: 'valid'; version: string; row: AnnotationBrowserRow; target: AnnotationBrowserRow['target'] }
  | { status: 'refused'; reason: string };
const defaults = (): AnnotationBrowserQuery => ({ scope: 'current', query: '', sort: 'document' });
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** Scope-owned read model. It never creates editing sessions or owns a durable writer. */
export class AnnotationBrowserSession {
  readonly scope: EditScope;
  private readonly corpus: AnnotationCorpusPort;
  private readonly isActive: () => boolean;
  private available = true;
  private items: readonly LibraryItem[] = [];
  private currentDocumentId: string | null = null;
  private catalogKey = '';
  private generation = 0;
  private controller?: AbortController;
  private locationGeneration = 0;
  private locationController?: AbortController;
  private flight?: Promise<void>;
  private entries = new Map<string, AnnotationCorpusEntry>();
  private allRows: readonly AnnotationBrowserRow[] = [];
  private readonly listeners = new Set<() => void>();
  private state: AnnotationBrowserState = freeze({ query: defaults(), rows: [], loading: false,
    missingIds: [], partialIds: [], conflictedIds: [], staleIds: [], selectedKey: null, scroll: null, error: '', exportError: '' });
  constructor(options: { repository: Pick<ContentRepository, 'scope' | 'read'>; isActive: () => boolean;
    readExistingConfirmed?: ExistingConfirmedAnnotationModel; corpus?: AnnotationCorpusPort }) {
    this.scope = freeze({ ...options.repository.scope }); this.isActive = options.isActive;
    this.corpus = options.corpus ?? createCanonicalAnnotationCorpus(options.repository, options.readExistingConfirmed);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private active() { return this.available && this.isActive(); }
  private update(fields: Partial<AnnotationBrowserState>) {
    this.state = freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener());
  }
  setAvailable(value: boolean) { this.available = value; if (!value) this.cancel(); }
  private invalidateLocation() { this.locationGeneration++; this.locationController?.abort(); }
  cancel = () => { this.invalidateLocation(); this.generation++; this.controller?.abort(); this.flight = undefined; this.update({ loading: false }); };
  setCatalog(catalog: LibrarySnapshot | null, currentDocumentId: string | null): Promise<void> {
    if (catalog && catalog.id !== this.scope.libraryId) throw new Error('annotation-catalog-scope');
    const deleted = new Set(catalog?.deletions.filter(value => value.active).flatMap(value => value.itemIds) ?? []);
    const items = catalog?.items.filter(item => !deleted.has(item.id) && (item.kind === 'pdf' || item.kind === 'notebook')) ?? [];
    const key = canonicalJson([catalog?.version ?? null, items]);
    const changed = key !== this.catalogKey;
    if (this.currentDocumentId !== currentDocumentId) this.invalidateLocation();
    this.currentDocumentId = currentDocumentId;
    if (!changed) { this.refilter(); return this.refresh(); }
    this.cancel(); this.catalogKey = key;
    const previousItems = new Map(this.items.map(item => [item.id, item]));
    this.items = freeze(structuredClone(items));
    const retained = new Map<string, AnnotationCorpusEntry>();
    for (const item of this.items) {
      const previous = this.entries.get(item.id);
      if (previous && previousItems.get(item.id)?.kind === item.kind) retained.set(item.id, {
        ...previous, sources: previous.sources.map(source => ({ ...source, title: item.title })),
      });
    }
    // Catalog metadata is not a content replacement. Keep known rows for surviving IDs so a failed
    // read can label them stale; remove deleted/retyped sources immediately and never append old heads.
    if (canonicalJson([...retained]) !== canonicalJson([...this.entries]))
      this.allRows = projectCanonicalAnnotations([...retained.values()].flatMap(entry => entry.sources));
    this.entries = retained;
    const live = new Set(this.items.map(item => item.id));
    this.update({ missingIds: this.state.missingIds.filter(id => live.has(id)), partialIds: this.state.partialIds.filter(id => live.has(id)),
      staleIds: this.state.staleIds.filter(id => live.has(id)), conflictedIds: this.state.conflictedIds.filter(id => live.has(id)),
      error: '', exportError: '' });
    this.refilter();
    return this.refresh();
  }
  setQuery = (change: Partial<AnnotationBrowserQuery>) => {
    this.invalidateLocation();
    this.update({ query: { ...this.state.query, ...structuredClone(change) }, exportError: '' }); this.refilter();
  };
  clear = () => { this.invalidateLocation(); this.update({ query: defaults(), exportError: '' }); this.refilter(); };
  private refilter() {
    const query = this.state.query;
    const rows = query.scope === 'current' && !this.currentDocumentId ? [] : filterCanonicalAnnotations(this.allRows,
      { ...query, documentId: query.scope === 'current' ? this.currentDocumentId! : query.documentId });
    if (rows.length === this.state.rows.length && rows.every((row, index) => row === this.state.rows[index])) return;
    // Hidden selection/scroll are retained by stable row identity, never rebound to a new ordinal.
    this.update({ rows });
  }
  refresh = (): Promise<void> => this.run(false);
  retry = (): Promise<void> => this.run(true);
  private run(force: boolean): Promise<void> {
    if (!this.active()) return Promise.resolve();
    if (this.flight && !force) return this.flight;
    if (force) this.invalidateLocation();
    const generation = ++this.generation; this.controller?.abort();
    const controller = new AbortController(); this.controller = controller;
    const items = this.items, alive = () => this.generation === generation && !controller.signal.aborted && this.active();
    this.update({ loading: true, error: '', exportError: '' });
    const work = Promise.resolve().then(async () => {
      try {
        const acquired = await this.corpus.read(items, controller.signal);
        if (!alive()) return;
        const byId = new Map(structuredClone(acquired).map(entry => [entry.documentId, entry]));
        const next = new Map<string, AnnotationCorpusEntry>(), stale: string[] = [];
        for (const item of items) {
          const entry = byId.get(item.id) ?? { documentId: item.id, heads: [], sources: [], status: 'missing' as const, conflicted: false, error: 'annotation-source-missing' };
          const previous = this.entries.get(item.id);
          if (entry.status === 'missing' && previous?.sources.length) {
            next.set(item.id, { ...entry, heads: previous.heads, sources: previous.sources, conflicted: previous.conflicted }); stale.push(item.id);
          } else next.set(item.id, entry);
        }
        const unchanged = canonicalJson([...next]) === canonicalJson([...this.entries]);
        if (!unchanged || canonicalJson(stale) !== canonicalJson(this.state.staleIds)) this.invalidateLocation();
        this.entries = next;
        if (!unchanged) this.allRows = projectCanonicalAnnotations([...next.values()].flatMap(entry => entry.sources));
        const ids = (status: AnnotationCorpusEntry['status']) => [...next.values()].filter(entry => entry.status === status).map(entry => entry.documentId);
        this.update({ loading: false, missingIds: ids('missing'), partialIds: ids('partial'), staleIds: stale,
          conflictedIds: [...next.values()].filter(entry => entry.conflicted).map(entry => entry.documentId),
          error: [...next.values()].some(entry => entry.error) ? 'annotation-source-unavailable' : '',
          exportError: stale.length ? 'annotation-export-stale' : '' });
        this.refilter();
      } catch (cause) {
        if (!alive()) return;
        this.invalidateLocation();
        this.update({ loading: false, error: String(cause), staleIds: [...new Set(this.allRows.map(row => row.documentId))],
          missingIds: items.map(item => item.id), exportError: 'annotation-export-stale' });
      }
    }).finally(() => { if (this.flight === work) this.flight = undefined; });
    this.flight = work; return work;
  }
  select(key: string | null): boolean {
    if (key !== null && !this.state.rows.some(row => row.key === key)) return false;
    this.update({ selectedKey: key }); return true;
  }
  rememberScroll(rowKey: string, offset: number): boolean {
    if (!Number.isFinite(offset) || !this.state.rows.some(row => row.key === rowKey)) return false;
    this.update({ scroll: { rowKey, offset } }); return true;
  }
  captureExport(): AnnotationBrowserExport | null {
    const error = !this.active() ? 'annotation-browser-inactive' : this.state.loading ? 'annotation-export-loading'
      : this.state.rows.some(row => this.state.staleIds.includes(row.documentId)) ? 'annotation-export-stale' : '';
    this.update({ exportError: error });
    if (error) return null;
    try { return freezeAnnotationExport(this.state.rows); }
    catch { this.update({ exportError: 'annotation-export-location-invalid' }); return null; }
  }
  async validateLocation(rowKey: string, sourceVersion?: string): Promise<AnnotationLocationValidation> {
    const refused = (reason: string): AnnotationLocationValidation => ({ status: 'refused', reason });
    if (!this.active()) return refused('annotation-browser-inactive');
    const row = this.state.rows.find(value => value.key === rowKey), item = row && this.items.find(value => value.id === row.documentId);
    if (!row || !item) return refused('annotation-row-unavailable');
    if (this.state.staleIds.includes(row.documentId)) return refused('annotation-source-stale');
    this.invalidateLocation();
    const generation = this.locationGeneration, controller = new AbortController();
    this.locationController = controller;
    const alive = () => this.active() && generation === this.locationGeneration && !controller.signal.aborted;
    try {
      const result = await this.corpus.read([item], controller.signal);
      if (!alive() || !this.state.rows.some(value => value.key === rowKey)) return refused('annotation-request-stale');
      const entry = result.find(value => value.documentId === item.id);
      if (!entry || entry.status !== 'complete') return refused('annotation-source-unavailable');
      const version = sourceVersion ?? (entry.heads.length === 1 ? entry.heads[0] : undefined);
      if (!version) return refused('annotation-head-selection-required');
      if (!entry.heads.includes(version) || !row.sourceVersions.includes(version)) return refused('annotation-head-changed');
      const current = projectCanonicalAnnotations(entry.sources).find(value => value.key === rowKey && value.sourceVersions.includes(version));
      if (!current) return refused('annotation-changed');
      return { status: 'valid', version, row: current, target: current.target };
    } catch { return refused(alive() ? 'annotation-source-unavailable' : 'annotation-request-stale'); }
    finally { if (this.locationController === controller) this.locationController = undefined; }
  }
}
