import type { DeletionRecord, DocumentSnapshot, LibrarySnapshot, MarkdownSnapshot, Page } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository, EditScope } from '../../../runtime/edits/ports.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';

export type DeletedContentComparisonSide = 'observed' | 'current';
export type ComparisonScroll = { top: number; left: number };
export type ComparisonContentSnapshot = MarkdownSnapshot | DocumentSnapshot;
export type ComparisonPageKey = { collection: 'original' | 'translated' | 'deleted'; pageId: string };
export type ComparisonPageState = { key: ComparisonPageKey | null; page: Page | null; missing: boolean };
/** Enumerate the actual pools; comparison never guesses a translation mapping or a deleted page's former pool. */
export function comparisonPages(snapshot: ComparisonContentSnapshot | null): { key: ComparisonPageKey; page: Page }[] {
  if (snapshot?.kind !== 'document') return [];
  return (['original', 'translated', 'deleted'] as const).flatMap(collection => {
    const pages = collection === 'original' ? snapshot.pages : collection === 'translated' ? snapshot.translation?.pages ?? [] : snapshot.deletedPages;
    return pages.map(page => ({ key: { collection, pageId: page.id }, page }));
  });
}
export function comparisonPage(snapshot: ComparisonContentSnapshot | null, key: ComparisonPageKey | null): Page | null {
  if (!key || snapshot?.kind !== 'document') return null;
  return comparisonPages(snapshot).find(value => value.key.collection === key.collection && value.key.pageId === key.pageId)?.page ?? null;
}
export type DeletedContentComparisonState = {
  selection: { catalogVersion: string; deletionId: string; itemId: string } | null;
  targets: readonly { id: string; title: string }[];
  observedHeads: readonly string[]; currentHeads: readonly string[];
  observed: ComparisonContentSnapshot | null; current: ComparisonContentSnapshot | null;
  page: { observed: ComparisonPageState; current: ComparisonPageState };
  scroll: { observed: ComparisonScroll; current: ComparisonScroll };
  loading: boolean; stale: boolean; observedStale: boolean; currentStale: boolean; error: string;
  waiting: readonly string[]; missingVersions: readonly string[]; newHeads: readonly string[];
};
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const initial = (): DeletedContentComparisonState => frozen({ selection: null, targets: [], observedHeads: [], currentHeads: [],
  page: { observed: { key: null, page: null, missing: false }, current: { key: null, page: null, missing: false } },
  observed: null, current: null, scroll: { observed: { top: 0, left: 0 }, current: { top: 0, left: 0 } },
  loading: false, stale: false, observedStale: false, currentStale: false, error: '', waiting: [], missingVersions: [], newHeads: [] });

/** A fixed comparison of canonical snapshots. No editing authority or restoration writer is acquired. */
export class DeletedContentComparisonSession {
  readonly scope: EditScope;
  private readonly repository: Pick<ContentRepository, 'scope' | 'read'>;
  private readonly isActive: () => boolean;
  private available = true;
  private generation = 0;
  private record: DeletionRecord | null = null;
  private contentKind: 'markdown' | 'document' | null = null;
  private snapshots = new Map<string, ComparisonContentSnapshot>();
  private baseline: Set<string> | null = null;
  private chosen = { observed: null as string | null, current: null as string | null };
  private currentInitialized = false;
  private inflight?: { generation: number; promise: Promise<boolean> };
  private readonly scrollPositions = new Map<string, ComparisonScroll>();
  private state = initial();
  private readonly listeners = new Set<() => void>();
  constructor(options: { repository: Pick<ContentRepository, 'scope' | 'read'>; isActive: () => boolean }) {
    this.repository = options.repository; this.scope = frozen({ ...options.repository.scope }); this.isActive = options.isActive;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<DeletedContentComparisonState>) {
    this.state = frozen({ ...this.state, ...fields }); this.listeners.forEach(listener => listener());
  }
  private active() { return this.available && this.isActive() && canonicalJson(this.repository.scope) === canonicalJson(this.scope); }
  setAvailable(value: boolean) { this.available = value; if (!value) this.cancel(); }
  cancel = () => { this.generation++; this.inflight = undefined; this.update({ loading: false }); };
  close = () => {
    this.generation++; this.inflight = undefined; this.record = null; this.contentKind = null;
    this.snapshots.clear(); this.baseline = null; this.scrollPositions.clear();
    this.chosen = { observed: null, current: null }; this.currentInitialized = false;
    this.state = initial(); this.listeners.forEach(listener => listener());
  };
  private resolve(catalog: LibrarySnapshot | null, deletionId: string, itemId: string) {
    if (!catalog || catalog.kind !== 'library' || catalog.id !== this.scope.libraryId) return null;
    const record = catalog.deletions.find(value => value.id === deletionId && value.active && value.itemIds.includes(itemId));
    if (!record || !['markdown', 'pdf', 'notebook'].includes(catalog.items.find(value => value.id === itemId)?.kind ?? '')
      || !record.observed.some(value => value.targetId === itemId && value.heads.length)) return null;
    return record;
  }
  open = async (catalog: LibrarySnapshot, deletionId: string, itemId: string): Promise<boolean> => {
    if (!this.active()) { this.cancel(); return false; }
    const record = this.resolve(catalog, deletionId, itemId);
    if (!record) { this.cancel(); this.update({ stale: true, error: 'comparison-catalog-invalid' }); return false; }
    this.close(); this.record = frozen(structuredClone(record));
    this.contentKind = catalog.items.find(item => item.id === itemId)!.kind === 'markdown' ? 'markdown' : 'document';
    const observedHeads = [...record.observed.find(value => value.targetId === itemId)!.heads].sort();
    this.chosen.observed = observedHeads.length === 1 ? observedHeads[0] : null;
    this.update({ selection: { catalogVersion: catalog.version, deletionId, itemId },
      targets: record.itemIds.map(id => ({ id, title: catalog.items.find(item => item.id === id)?.title ?? id })),
      observedHeads });
    return this.refresh();
  };
  /** A selected catalog is supplied by the catalog authority; never infer a winning catalog head. */
  setCatalog(catalog: LibrarySnapshot | null): void {
    const selection = this.state.selection; if (!selection) return;
    const record = this.resolve(catalog, selection.deletionId, selection.itemId);
    const expected = catalog?.items.find(item => item.id === selection.itemId)?.kind === 'markdown' ? 'markdown' : 'document';
    const matches = !!record && expected === this.contentKind && canonicalJson(record) === canonicalJson(this.record);
    if (catalog?.version === selection.catalogVersion && matches && !this.state.stale) return;
    this.cancel();
    this.update({ selection: catalog ? { ...selection, catalogVersion: catalog.version } : selection,
      ...(matches ? { targets: record!.itemIds.map(id => ({ id, title: catalog!.items.find(item => item.id === id)?.title ?? id })) } : {}),
      stale: !matches, error: matches ? '' : 'comparison-catalog-changed' });
  }
  refresh = (): Promise<boolean> => {
    const selection = this.state.selection;
    if (!this.active()) { this.cancel(); return Promise.resolve(false); }
    if (!selection || this.state.stale) return Promise.resolve(false);
    if (this.inflight?.generation === this.generation) return this.inflight.promise;
    const generation = ++this.generation;
    // Install the shared flight before emitting loading, including reentrant subscribers.
    const promise = Promise.resolve().then(() => this.read(selection, generation));
    this.inflight = { generation, promise };
    this.update({ loading: true, error: '' });
    return promise;
  };
  private async read(selection: NonNullable<DeletedContentComparisonState['selection']>, generation: number): Promise<boolean> {
    const alive = () => this.active() && generation === this.generation && !this.state.stale;
    try {
      if (!alive()) return false;
      const read = await this.repository.read(selection.itemId);
      if (!alive()) return false;
      if (read.checkpoint.libraryId !== this.scope.libraryId || read.checkpoint.root.id !== selection.itemId
        || read.checkpoint.root.kind !== this.contentKind) throw new Error('comparison-content-scope');
      const graph = new EditGraph(read.checkpoint), snapshots = new Map<string, ComparisonContentSnapshot>(), missing: string[] = [];
      const heads = [...new Set(read.heads)].sort();
      if (!this.currentInitialized) {
        this.currentInitialized = true;
        this.chosen.current = heads.length === 1 ? heads[0] : null;
      }
      for (const version of new Set([...this.state.observedHeads, ...heads, ...Object.values(this.chosen).filter((id): id is string => id !== null)])) {
        const snapshot = graph.snapshot(version);
        if (!snapshot || snapshot.kind === 'library' || snapshot.kind !== this.contentKind || snapshot.id !== selection.itemId) { missing.push(version); continue; }
        snapshots.set(version, frozen(structuredClone(snapshot)));
      }
      this.snapshots = snapshots;
      this.baseline ??= new Set(heads);
      // Existing selections are intentionally not replaced, even after a selected current head retires.
      const observed = this.state.observed ?? (this.chosen.observed ? snapshots.get(this.chosen.observed) ?? null : null);
      const current = this.state.current ?? (this.chosen.current ? snapshots.get(this.chosen.current) ?? null : null);
      const page = { observed: this.pageState('observed', observed), current: this.pageState('current', current) };
      this.update({ observed, current, page, currentHeads: heads, missingVersions: missing.sort(), waiting: [...read.waiting],
        observedStale: !!this.chosen.observed && !snapshots.has(this.chosen.observed),
        currentStale: !!this.chosen.current && (!heads.includes(this.chosen.current) || !snapshots.has(this.chosen.current)),
        newHeads: heads.filter(head => !this.baseline!.has(head)), loading: false });
      return true;
    } catch (error) {
      if (alive()) this.update({ loading: false, observedStale: !!this.chosen.observed, currentStale: !!this.chosen.current, error: String(error) });
      return false;
    } finally {
      if (this.inflight?.generation === generation) {
        this.inflight = undefined;
        if (this.state.loading) this.update({ loading: false });
      }
    }
  }
  private pageState(side: DeletedContentComparisonSide, snapshot: ComparisonContentSnapshot | null): ComparisonPageState {
    if (snapshot?.kind !== 'document') return { key: null, page: null, missing: false };
    const previous = this.state.page[side].key;
    const key = previous ?? (snapshot.pages[0] ? { collection: 'original' as const, pageId: snapshot.pages[0].id } : null);
    const page = comparisonPage(snapshot, key);
    return { key, page, missing: !!key && !page };
  }
  private scrollKey(side: DeletedContentComparisonSide, snapshot = this.state[side], key = this.state.page[side].key): string {
    return canonicalJson([side, snapshot?.version ?? null, key?.collection ?? null, key?.pageId ?? null]);
  }
  select(side: DeletedContentComparisonSide, version: string): boolean {
    if (!this.active() || this.state.stale || this.state.loading || this.state.error) return false;
    const candidates = side === 'observed' ? this.state.observedHeads : this.state.currentHeads;
    const snapshot = this.snapshots.get(version);
    if (!candidates.includes(version) || !snapshot) return false;
    this.chosen[side] = version;
    if (side === 'current') this.baseline = new Set(this.state.currentHeads);
    const page = this.pageState(side, snapshot);
    const scroll = this.scrollPositions.get(this.scrollKey(side, snapshot, page.key)) ?? { top: 0, left: 0 };
    this.update({ [side]: snapshot, [side === 'observed' ? 'observedStale' : 'currentStale']: false,
      page: { ...this.state.page, [side]: page }, scroll: { ...this.state.scroll, [side]: scroll },
      ...(side === 'current' ? { newHeads: [] } : {}) }); return true;
  }
  selectPage(side: DeletedContentComparisonSide, key: ComparisonPageKey): boolean {
    if (!this.active() || this.state.stale || this.state.loading || this.state.error) return false;
    const snapshot = this.state[side], page = comparisonPage(snapshot, key);
    if (!page) return false;
    const stableKey = { collection: key.collection, pageId: key.pageId };
    const scroll = this.scrollPositions.get(this.scrollKey(side, snapshot, stableKey)) ?? { top: 0, left: 0 };
    this.update({ page: { ...this.state.page, [side]: { key: stableKey, page, missing: false } },
      scroll: { ...this.state.scroll, [side]: scroll } });
    return true;
  }
  rememberScroll(side: DeletedContentComparisonSide, scroll: ComparisonScroll): boolean {
    if (!this.active() || !this.state.selection || ![scroll.top, scroll.left].every(value => Number.isFinite(value) && value >= 0)) return false;
    this.scrollPositions.set(this.scrollKey(side), { ...scroll });
    this.update({ scroll: { ...this.state.scroll, [side]: { ...scroll } } }); return true;
  }
}
