import type { EditScope } from '../../runtime/edits/ports.ts';
import type { ReaderZoom } from './zoomLevels.ts';
import { referenceTarget, sameReferenceTarget, sameReferenceZoom, resolveReferenceTarget, type ReaderReferenceState, type ReaderReferenceTarget, type ReferenceCommandExpectation, type ReferenceViewportReport } from './reference/readerReference.ts';
import type { ReadingPlace } from './navigation/readingPlace.ts';
import type { SavedMarkdownReaderState } from './ReaderPlacementSession.ts';
import type { DocumentSnapshot, Page } from '../../runtime/edits/contracts.ts';
import { originalForTranslatedPage, readerSurfaceSignature, readerTranslationPages, type ReaderSurface, type ReaderDisplay,
  type ReaderSurfaceResult, type TranslationStatus } from './readerSurfaceModel.ts';
export type { ReaderSurface, ReaderDisplay, ReaderSurfaceResult, TranslationStatus } from './readerSurfaceModel.ts';

export type ReaderPlace = ReadingPlace & { backgroundRevision?: string };
export type ReaderLocation = { pageId: string; toEnd: boolean; place: ReadingPlace | null; backgroundRevision?: string;
  surface?: ReaderSurface; surfacePageId?: string };
export type SavedReaderState = { version: 1; pageId: string; zoom: ReaderZoom; placement: 'center' | 'right';
  positions: Record<string, ReaderPlace>; back: ReaderLocation[]; forward: ReaderLocation[];
  activeSurface?: ReaderSurface; display?: ReaderDisplay; translatedOnly?: boolean; surfacePageId?: string | null;
  /** Optional only when reading an earlier v1 record; new writes always preserve the current destination. */
  landing?: Omit<ReaderLocation, 'pageId'> };
export type SavedReaderPreference = SavedReaderState | SavedMarkdownReaderState;
export interface ReaderStatePort<T = SavedReaderState> {
  readonly scope: EditScope;
  read(documentId: string): unknown;
  write(documentId: string, state: T): void;
}
export type ReaderState = Omit<SavedReaderState, 'version' | 'landing'> & {
  activeSurface: ReaderSurface; display: ReaderDisplay; translatedOnly: boolean; surfacePageId: string | null; translationStatus: TranslationStatus;
  filterPending: boolean; filterCandidateCount: number;
  reference: ReaderReferenceState;
  landing: Omit<ReaderLocation, 'pageId'> & { id: number }; error: string;
};
export type ReaderViewport = { fitWidth: number; fitPageWidth: number; drawnWidth: number };
const HISTORY_LIMIT = 100, POSITION_LIMIT = 500;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validId(value: unknown): value is string { return typeof value === 'string' && idPattern.test(value); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function place(value: unknown): value is ReaderPlace {
  return object(value) && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y);
}
function zoom(value: unknown): value is ReaderZoom {
  return object(value) && (value.kind === 'fit-page' || value.kind === 'scale' && typeof value.value === 'number'
    && Number.isFinite(value.value) && value.value > 0 && value.value <= 4);
}
function location(value: unknown): value is ReaderLocation {
  return object(value) && validId(value.pageId) && typeof value.toEnd === 'boolean' && (value.place === null || place(value.place))
    && (value.backgroundRevision === undefined || validId(value.backgroundRevision)) && surfaceFields(value);
}
function surfaceFields(value: Record<string, unknown>) {
  return (value.surface === undefined || value.surface === 'original' || value.surface === 'translated')
    && (value.surfacePageId === undefined || validId(value.surfacePageId));
}
function readSaved(value: unknown): SavedReaderState | null {
  if (value === undefined || value === null) return null;
  if (!object(value) || value.version !== 1 || !validId(value.pageId) || !zoom(value.zoom)
    || !['center', 'right'].includes(String(value.placement)) || !object(value.positions)
    || Object.keys(value.positions).length > POSITION_LIMIT
    || !Object.entries(value.positions).every(([id, at]) => validId(id) && place(at) && (at.backgroundRevision === undefined || validId(at.backgroundRevision)))
    || !Array.isArray(value.back) || value.back.length > HISTORY_LIMIT || !value.back.every(location)
    || !Array.isArray(value.forward) || value.forward.length > HISTORY_LIMIT || !value.forward.every(location)
    || value.landing !== undefined && (!object(value.landing) || typeof value.landing.toEnd !== 'boolean'
      || value.landing.place !== null && !place(value.landing.place)
      || value.landing.backgroundRevision !== undefined && !validId(value.landing.backgroundRevision) || !surfaceFields(value.landing))
    || value.activeSurface !== undefined && !['original', 'translated'].includes(String(value.activeSurface))
    || value.display !== undefined && !['original', 'translated', 'split'].includes(String(value.display))
    || value.translatedOnly !== undefined && typeof value.translatedOnly !== 'boolean'
    || value.surfacePageId !== undefined && value.surfacePageId !== null && !validId(value.surfacePageId)) throw new Error('invalid-reader-state');
  return structuredClone(value) as SavedReaderState;
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable); Object.freeze(value);
  }
  return value;
}
function sameScope(a: EditScope, b: EditScope) { return a.accountId === b.accountId && a.libraryId === b.libraryId && a.epoch === b.epoch; }

/** Reading state outlives pane placement. Editing and persistence remain separate authorities. */
export class ReaderSession {
  readonly scope: EditScope;
  readonly documentId: string;
  private readonly persistence: ReaderStatePort;
  private readonly canNavigate: () => boolean;
  private readonly canReposition: () => boolean;
  private state: ReaderState;
  private pages: string[] = [];
  private previousOrder: string[] = [];
  private backgroundRevisions?: Record<string, string>;
  private viewports = new Map<string, ReaderViewport>();
  private model: DocumentSnapshot | null = null;
  private pendingFilterDocument: DocumentSnapshot | null = null;
  private translations: ReturnType<typeof readerTranslationPages> = new Map();
  private referencePane: { paneInstance: object; pointerLease: object; layoutMeasurementGeneration: number; paneWidth: number; paneHeight: number; dpr: number; zoom: ReaderZoom } | null = null;
  private referenceViewport: ReaderViewport | null = null;
  private referenceWasAvailable = false;
  private referenceUnavailableReason: string | null = null;
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private protectFailedRead = false;

  constructor({ scope, documentId, persistence, canNavigate, canReposition }: {
    scope: EditScope; documentId: string; persistence: ReaderStatePort; canNavigate: () => boolean; canReposition?: () => boolean;
  }) {
    if (!sameScope(scope, persistence.scope)) throw new Error('reader-state-scope');
    if (!validId(documentId)) throw new Error('reader-document-id');
    this.scope = Object.freeze({ ...scope }); this.documentId = documentId;
    this.persistence = persistence; this.canNavigate = canNavigate; this.canReposition = canReposition ?? canNavigate;
    let saved: SavedReaderState | null = null, error = '';
    try { saved = readSaved(persistence.read(documentId)); }
    catch (cause) { error = String(cause); this.protectFailedRead = true; }
    this.state = immutable({ pageId: saved?.pageId ?? '', zoom: saved?.zoom ?? { kind: 'fit-page' }, placement: saved?.placement ?? 'center',
      activeSurface: saved?.activeSurface ?? 'original', display: saved?.display ?? 'original', translatedOnly: saved?.translatedOnly ?? false,
      surfacePageId: saved?.surfacePageId ?? saved?.pageId ?? null, translationStatus: 'missing',
      filterPending: false, filterCandidateCount: 0,
      reference: { mode: 'follow-active', target: null, targetGeneration: 0, zoom: { kind: 'fit-page' }, place: null, landingId: 0 },
      positions: saved?.positions ?? {}, back: saved?.back ?? [], forward: saved?.forward ?? [],
      landing: { id: 0, toEnd: saved?.landing?.toEnd ?? false,
        ...(saved?.landing?.surface ? { surface: saved.landing.surface } : {}),
        ...(saved?.landing?.surfacePageId ? { surfacePageId: saved.landing.surfacePageId } : {}),
        place: saved?.landing ? saved.landing.place : (saved ? saved.positions[saved.pageId] : null) ?? null,
        ...this.revision(saved?.landing ? saved.landing.backgroundRevision : (saved ? saved.positions[saved.pageId]?.backgroundRevision : undefined)) }, error });
  }
  getSnapshot = () => this.state;
  get documentModel() { return this.model; }
  resolvePage(surface: ReaderSurface, originalPageId = this.state.pageId): Page | null {
    if (!this.model) return null;
    return surface === 'original' ? this.model.pages.find(page => page.id === originalPageId) ?? null : this.translations.get(originalPageId)?.page ?? null;
  }
  get navigationPageIds(): readonly string[] {
    return this.state.translatedOnly ? this.pages.filter(id => !!this.resolvePage('translated', id)) : [...this.pages];
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get minimumZoom() { const value = this.state.surfacePageId ? this.viewports.get(this.state.surfacePageId) : undefined;
    return value ? Math.min(4, value.fitPageWidth / value.fitWidth) : 0; }
  get numericZoom() { return this.state.zoom.kind === 'fit-page' ? 0 : this.state.zoom.value; }
  get actualZoom() { return this.state.zoom.kind === 'fit-page' ? this.minimumZoom : Math.max(this.minimumZoom, this.state.zoom.value); }
  private update(fields: Partial<ReaderState>, save = false, user = false) {
    let next = { ...this.state, ...fields };
    if (next.reference.mode === 'follow-active') {
      const page = this.resolvePage(next.activeSurface, next.pageId);
      const target = page ? referenceTarget(next.activeSurface, page) : null;
      if (!sameReferenceTarget(target, next.reference.target)) {
        next = { ...next, reference: { ...next.reference, target, targetGeneration: next.reference.targetGeneration + 1,
          zoom: { kind: 'fit-page' }, place: null, landingId: next.reference.landingId + 1 } };
        this.referencePane = null; this.referenceViewport = null;
      }
    }
    const available = resolveReferenceTarget(this.model, next.reference.target).status === 'ready';
    if (next.reference.mode === 'pinned' && this.referenceWasAvailable && !available) {
      next = { ...next, reference: { ...next.reference, targetGeneration: next.reference.targetGeneration + 1 } };
      this.referencePane = null; this.referenceViewport = null;
    }
    this.referenceWasAvailable = available;
    this.state = immutable(next);
    if (user) this.protectFailedRead = false;
    if (save && !this.protectFailedRead && this.state.pageId && this.pages.length) {
      this.dirty = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 150);
    }
    this.listeners.forEach(listener => listener());
  }
  private currentLocation(): ReaderLocation {
    const remembered = this.state.surfacePageId ? this.state.positions[this.state.surfacePageId] : undefined;
    return { pageId: this.state.pageId, toEnd: this.state.landing.toEnd,
      ...this.surfaceFields(this.state.activeSurface, this.state.surfacePageId),
      place: remembered ? { x: remembered.x, y: remembered.y } : this.state.landing.place,
      ...this.revision(remembered ? remembered.backgroundRevision : this.state.landing.backgroundRevision) };
  }
  private revision(backgroundRevision?: string): { backgroundRevision?: string } { return backgroundRevision === undefined ? {} : { backgroundRevision }; }
  private surfaceFields(surface: ReaderSurface, actualId: string | null): Pick<ReaderLocation, 'surface' | 'surfacePageId'> {
    return surface === 'original' ? {} : { surface, ...(actualId ? { surfacePageId: actualId } : {}) };
  }
  private actualId(pageId: string, surface: ReaderSurface): string | null {
    return surface === 'original' ? pageId : this.resolvePage(surface, pageId)?.id ?? null;
  }
  private target(pageId: string, surface = this.state.activeSurface, toEnd = false, at: ReadingPlace | null = null, revision?: string): ReaderLocation {
    const actualId = this.actualId(pageId, surface);
    return { pageId, toEnd, place: at, ...this.surfaceFields(surface, actualId),
      ...this.revision(revision ?? (actualId ? this.backgroundRevisions?.[actualId] : undefined)) };
  }
  private matches(target: ReaderLocation): boolean {
    const actualId = this.actualId(target.pageId, target.surface ?? 'original');
    if (target.surface === 'translated' && (target.surfacePageId ?? null) !== actualId) return false;
    if (!actualId) return target.place === null && !target.backgroundRevision;
    if (!this.backgroundRevisions) return true;
    return target.backgroundRevision ? target.backgroundRevision === this.backgroundRevisions[actualId] : target.place === null;
  }
  private land(target: ReaderLocation, fields: Partial<ReaderState> = {}, user = true) {
    const activeSurface = target.surface ?? 'original', surfacePageId = this.actualId(target.pageId, activeSurface);
    const viewport = surfacePageId ? this.viewports.get(surfacePageId) : undefined;
    const below = viewport && this.state.zoom.kind === 'scale' && this.state.zoom.value <= Math.min(4, viewport.fitPageWidth / viewport.fitWidth);
    this.update({ ...fields, pageId: target.pageId,
      ...(below ? { zoom: { kind: 'fit-page' } as const } : {}),
      activeSurface, surfacePageId, translationStatus: this.translations.get(target.pageId)?.status ?? 'missing',
      landing: { id: this.state.landing.id + 1, toEnd: target.toEnd, place: target.place,
        ...this.surfaceFields(activeSurface, surfacePageId), ...this.revision(target.backgroundRevision) } }, true, user);
  }

  /** Keep the accepted binding intact while a held gesture/draft prevents navigation. */
  reconcileDocument(document: DocumentSnapshot, forcedDraftId?: string): boolean {
    if (document.id !== this.documentId) throw new Error('reader-document-id');
    let forced = forcedDraftId, forcedSurface: ReaderSurface | undefined;
    if (forced && document.pages.some(page => page.id === forced)) forcedSurface = 'original';
    else if (forced) {
      const reverse = originalForTranslatedPage(document, forced);
      forced = reverse.status === 'resolved' ? reverse.originalPageId : undefined;
      if (forced) forcedSurface = 'translated';
    }
    const translations = readerTranslationPages(document);
    const candidates = document.pages.filter(page => !!translations.get(page.id)?.page).map(page => page.id);
    const filterMove = !forced && this.state.translatedOnly && candidates.length > 0 && !candidates.includes(this.state.pageId);
    const deferInitialFilter = !this.model && filterMove && !this.canNavigate();
    if (filterMove && (this.pendingFilterDocument || !this.canNavigate())) {
      this.pendingFilterDocument = immutable(structuredClone(document));
      if (!this.state.filterPending || this.state.filterCandidateCount !== candidates.length)
        this.update({ filterPending: true, filterCandidateCount: candidates.length });
      if (!deferInitialFilter) return false;
    }
    const changed = !this.model || readerSurfaceSignature(document) !== readerSurfaceSignature(this.model);
    if (changed && this.model && !this.canNavigate()) return false;
    if (!deferInitialFilter) this.pendingFilterDocument = null;
    this.model = immutable(structuredClone(document));
    this.translations = readerTranslationPages(this.model);
    if (changed) this.viewports.clear();
    this.reconcile(document.pages.map(page => page.id), filterMove && !deferInitialFilter ? candidates[0] : forced,
      Object.fromEntries([...document.pages, ...(document.translation?.pages ?? [])].map(page => [page.id, page.backgroundRevision])));
    if (forced && forcedSurface && (this.state.activeSurface !== forcedSurface
      || this.state.display !== 'split' && this.state.display !== forcedSurface)) {
      const actual = this.actualId(forced, forcedSurface), at = actual ? this.state.positions[actual] : undefined;
      this.land(this.target(forced, forcedSurface, false, at ? { x: at.x, y: at.y } : null),
        { display: this.state.display === 'split' ? 'split' : forcedSurface }, false);
    }
    if (filterMove && !deferInitialFilter) this.navigate(this.target(candidates[0]), false);
    const actual = this.actualId(this.state.pageId, this.state.activeSurface);
    const status = this.translations.get(this.state.pageId)?.status ?? 'missing';
    if (actual !== this.state.surfacePageId) {
      const at = actual ? this.state.positions[actual] : undefined;
      this.land(this.target(this.state.pageId, this.state.activeSurface, false, at ? { x: at.x, y: at.y } : null), {}, false);
    } else this.update({ translationStatus: status }); // accepted annotation edits must also reach rendering consumers
    if (!deferInitialFilter && (this.state.filterPending || this.state.filterCandidateCount !== candidates.length))
      this.update({ filterPending: false, filterCandidateCount: candidates.length });
    return true;
  }
  retryFilteredNavigation = (): ReaderSurfaceResult => {
    const candidate = this.pendingFilterDocument;
    if (!candidate) return { status: 'unchanged' };
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    this.pendingFilterDocument = null;
    return this.reconcileDocument(candidate) ? { status: 'applied' } : { status: 'blocked', reason: 'reader-input-active' };
  };

  /** Remote order/deletion and a held draft are derived reconciliation, not user navigation. */
  reconcile(pageIds: string[], forcedDraftId?: string, backgroundRevisions?: Record<string, string>): void {
    if (new Set(pageIds).size !== pageIds.length || pageIds.some(id => !validId(id))) throw new Error('reader-page-ids');
    if (backgroundRevisions && Object.entries(backgroundRevisions).some(([id, revision]) => !validId(id) || !validId(revision))) throw new Error('reader-background-revisions');
    this.backgroundRevisions = backgroundRevisions ? { ...backgroundRevisions } : undefined;
    this.pages = [...pageIds];
    if (!pageIds.length) return; // Loading/unmount must not erase the last durable place.
    const oldIndex = Math.max(0, this.previousOrder.indexOf(this.state.pageId));
    const next = forcedDraftId && pageIds.includes(forcedDraftId) ? forcedDraftId
      : pageIds.includes(this.state.pageId) ? this.state.pageId : pageIds[Math.min(oldIndex, pageIds.length - 1)];
    this.previousOrder = [...pageIds];
    const positions = { ...this.state.positions };
    let invalid = false;
    if (this.backgroundRevisions) for (const [id, at] of Object.entries(positions)) {
      if (!at.backgroundRevision || at.backgroundRevision !== this.backgroundRevisions[id]) { delete positions[id]; invalid = true; }
    }
    const back = this.state.back.filter(at => pageIds.includes(at.pageId)), forward = this.state.forward.filter(at => pageIds.includes(at.pageId));
    const current = this.currentLocation(), stale = !this.matches(current);
    const actual = this.actualId(next, this.state.activeSurface), revision = actual ? this.backgroundRevisions?.[actual] : undefined;
    if (next !== this.state.pageId || stale) {
      const at = stale && next === this.state.pageId ? undefined : actual ? positions[actual] : undefined;
      this.viewports.clear();
      this.land(this.target(next, this.state.activeSurface, false, at ? { x: at.x, y: at.y } : null, revision ?? at?.backgroundRevision),
        { back, forward, positions, ...(invalid || stale ? { error: 'reader-background-changed' } : {}) }, false);
    } else if (invalid || revision !== this.state.landing.backgroundRevision && this.backgroundRevisions) {
      this.land({ ...current, ...this.revision(revision) }, { back, forward, positions, ...(invalid ? { error: 'reader-background-changed' } : {}) }, false);
    } else if (back.length !== this.state.back.length || forward.length !== this.state.forward.length) this.update({ back, forward }, true);
  }
  jump(pageId: string, toEnd = false, backgroundRevision?: string): boolean {
    const target = this.target(pageId, this.state.activeSurface, toEnd, null, backgroundRevision);
    if (!this.admit(target)) return false;
    if (pageId === this.state.pageId && this.state.landing.toEnd === toEnd && this.state.landing.place === null && !(this.state.surfacePageId && this.state.positions[this.state.surfacePageId])
      && target.backgroundRevision === this.state.landing.backgroundRevision && (!this.state.translatedOnly || this.navigationPageIds.includes(pageId))) return false;
    return this.navigate(target);
  }
  /** Numeric page input always returns to the full original route, unlike citations and history. */
  jumpLogicalPage(pageNumber: number, toEnd = false): ReaderSurfaceResult {
    if (!Number.isInteger(pageNumber) || !this.pages.length) return { status: 'blocked', reason: 'reader-page-number' };
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    const pageId = this.pages[Math.max(0, Math.min(this.pages.length - 1, pageNumber - 1))];
    const target = this.target(pageId, this.state.activeSurface, toEnd);
    if (!this.admit(target)) return { status: 'blocked', reason: this.state.error || 'reader-location' };
    const same = pageId === this.state.pageId && this.state.landing.toEnd === toEnd && this.state.landing.place === null
      && !(this.state.surfacePageId && this.state.positions[this.state.surfacePageId])
      && target.backgroundRevision === this.state.landing.backgroundRevision;
    if (same) {
      if (!this.state.translatedOnly) return { status: 'unchanged' };
      this.update({ translatedOnly: false, error: '' }, true, true);
    } else this.navigate(target, true, true, true);
    if (this.pendingFilterDocument) {
      const candidate = this.pendingFilterDocument; this.pendingFilterDocument = null; this.reconcileDocument(candidate);
    }
    return { status: 'applied' };
  }
  /** Explicit anchors use the same guard and history as top/end jumps. */
  jumpTo(pageId: string, at: ReadingPlace, backgroundRevision?: string): boolean {
    if (!place(at)) return false;
    const target = this.target(pageId, this.state.activeSurface, false, { x: at.x, y: at.y }, backgroundRevision), current = this.currentLocation();
    if (!this.admit(target)) return false;
    if (pageId === current.pageId && !current.toEnd && current.place?.x === at.x && current.place.y === at.y
      && target.backgroundRevision === current.backgroundRevision && (!this.state.translatedOnly || this.navigationPageIds.includes(pageId))) return false;
    return this.navigate(target);
  }
  private admit(target: ReaderLocation): boolean {
    if (!this.canNavigate() || !this.pages.includes(target.pageId)) return false;
    if (target.backgroundRevision !== undefined && !validId(target.backgroundRevision) || !this.matches(target)) {
      this.update({ error: 'reader-background-changed' }); return false;
    }
    return true;
  }
  private navigate(target: ReaderLocation, recordHistory = true, clearBoth = true, clearFilter = false): boolean {
    const back = recordHistory && this.state.pageId ? [...this.state.back, this.currentLocation()].slice(-HISTORY_LIMIT) : this.state.back;
    // Explicit destinations must win over the page's previously remembered position.
    const positions = { ...this.state.positions }, actual = this.actualId(target.pageId, target.surface ?? 'original');
    if (actual) delete positions[actual];
    if (clearBoth) {
      delete positions[target.pageId];
      const translated = this.actualId(target.pageId, 'translated'); if (translated) delete positions[translated];
    }
    const translatedOnly = !clearFilter && this.state.translatedOnly && this.navigationPageIds.includes(target.pageId);
    this.land(target, { back, forward: [], positions, translatedOnly, error: '' }); return true;
  }
  step(amount: -1 | 1, toEnd = false): boolean {
    if (this.pendingFilterDocument) return this.retryFilteredNavigation().status === 'applied';
    const route = this.navigationPageIds, index = route.indexOf(this.state.pageId);
    const originalIndex = this.pages.indexOf(this.state.pageId);
    const pageId = index >= 0 ? route[index + amount] : amount > 0 ? route.find(id => this.pages.indexOf(id) > originalIndex)
      : [...route].reverse().find(id => this.pages.indexOf(id) < originalIndex);
    if (!pageId) return false;
    const target = this.target(pageId, this.state.activeSurface, toEnd);
    if (!this.admit(target)) return false;
    // Ordinary paging starts a new route, but does not create a history entry.
    return this.navigate(target, false);
  }
  first(): boolean { if (this.pendingFilterDocument) return this.retryFilteredNavigation().status === 'applied';
    const pageId = this.navigationPageIds[0]; return pageId ? this.jump(pageId) : false; }
  last(): boolean { if (this.pendingFilterDocument) return this.retryFilteredNavigation().status === 'applied';
    const route = this.navigationPageIds, pageId = route[route.length - 1]; return pageId ? this.jump(pageId, false) : false; }
  setSurface(surface: ReaderSurface): ReaderSurfaceResult {
    if (surface !== 'original' && surface !== 'translated') return { status: 'blocked', reason: 'reader-surface' };
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    if (surface === this.state.activeSurface) return { status: 'unchanged' };
    const actual = this.actualId(this.state.pageId, surface), at = actual ? this.state.positions[actual] : undefined;
    const target = this.target(this.state.pageId, surface, false, at ? { x: at.x, y: at.y } : null);
    this.land(target, { display: this.state.display === 'split' ? 'split' : surface, error: '' });
    return { status: 'applied' };
  }
  setDisplay(display: ReaderDisplay): ReaderSurfaceResult {
    if (!['original', 'translated', 'split'].includes(display)) return { status: 'blocked', reason: 'reader-display' };
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    if (display === this.state.display) return { status: 'unchanged' };
    if (display !== 'split' && display !== this.state.activeSurface) this.setSurface(display);
    this.land(this.currentLocation(), { display, error: '' }); return { status: 'applied' };
  }
  setTranslatedOnly(translatedOnly: boolean): ReaderSurfaceResult {
    if (typeof translatedOnly !== 'boolean') return { status: 'blocked', reason: 'reader-filter' };
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    if (translatedOnly === this.state.translatedOnly) return { status: 'unchanged' };
    const candidates = this.pages.filter(id => !!this.resolvePage('translated', id));
    if (translatedOnly && candidates.length && !candidates.includes(this.state.pageId)) this.navigate(this.target(candidates[0]));
    // Only an empty translated set retains an out-of-filter original route.
    this.update({ translatedOnly, error: '' }, true, true);
    if (!translatedOnly && this.pendingFilterDocument) {
      const candidate = this.pendingFilterDocument; this.pendingFilterDocument = null; this.reconcileDocument(candidate);
    }
    return { status: 'applied' };
  }
  jumpSurface(surface: ReaderSurface, actualPageId: string, at?: ReadingPlace, backgroundRevision?: string): ReaderSurfaceResult {
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    if (!['original', 'translated'].includes(surface) || !validId(actualPageId) || at !== undefined && !place(at))
      return { status: 'blocked', reason: 'reader-location' };
    let pageId = actualPageId;
    if (surface === 'translated') {
      if (!this.model) return { status: 'blocked', reason: 'translation-unmapped' };
      const reverse = originalForTranslatedPage(this.model, actualPageId);
      if (reverse.status !== 'resolved') return { status: 'blocked', reason: reverse.reason };
      pageId = reverse.originalPageId;
    }
    const target = this.target(pageId, surface, false, at ? { x: at.x, y: at.y } : null, backgroundRevision);
    if (!this.admit(target)) return { status: 'blocked', reason: this.state.error || 'reader-location' };
    const current = this.currentLocation();
    if (current.pageId === pageId && this.state.activeSurface === surface && !current.toEnd
      && current.backgroundRevision === target.backgroundRevision && JSON.stringify(current.place) === JSON.stringify(target.place)
      && (!this.state.translatedOnly || this.navigationPageIds.includes(pageId))) return { status: 'unchanged' };
    this.navigate(target);
    if (this.state.display !== 'split' && this.state.display !== surface) this.update({ display: surface }, true, true);
    return { status: 'applied' };
  }
  history(direction: 'back' | 'forward'): boolean {
    if (!this.canNavigate()) return false;
    const source = this.state[direction]; if (!source.length) return false;
    const target = source[source.length - 1]; if (!this.pages.includes(target.pageId)) return false;
    if (!this.admit(target)) return false;
    const opposite = direction === 'back' ? 'forward' : 'back';
    const positions = { ...this.state.positions }, actual = this.actualId(target.pageId, target.surface ?? 'original');
    if (actual) { if (target.place) positions[actual] = { ...target.place, ...this.revision(target.backgroundRevision) }; else delete positions[actual]; }
    this.land({ ...target, ...this.revision(target.backgroundRevision ?? (actual ? this.backgroundRevisions?.[actual] : undefined)) },
      { [direction]: source.slice(0, -1), [opposite]: [...this.state[opposite], this.currentLocation()].slice(-HISTORY_LIMIT), positions,
        translatedOnly: this.state.translatedOnly && this.navigationPageIds.includes(target.pageId),
        display: this.state.display === 'split' ? 'split' : target.surface ?? 'original', error: '' }); return true;
  }
  setZoom(value: ReaderZoom): boolean {
    if (!this.canNavigate()) return false;
    if (value.kind !== 'fit-page' && (value.kind !== 'scale' || !Number.isFinite(value.value) || value.value <= 0)) return false;
    const next: ReaderZoom = value.kind === 'fit-page' || value.value <= this.minimumZoom
      ? { kind: 'fit-page' } : { kind: 'scale', value: Math.min(4, value.value) };
    if (next.kind === this.state.zoom.kind && (next.kind === 'fit-page' || this.state.zoom.kind === 'scale' && next.value === this.state.zoom.value)) return false;
    this.update({ zoom: next }, true, true); return true;
  }
  zoomBy(amount: -1 | 1): boolean {
    const current = this.actualZoom;
    return current > 0 ? this.setZoom({ kind: 'scale', value: current * (amount > 0 ? 1.25 : 1 / 1.25) }) : false;
  }
  setViewport(pageId: string, value: ReaderViewport): void {
    if (pageId !== this.state.pageId && pageId !== this.actualId(this.state.pageId, 'translated')) return;
    if (![value.fitWidth, value.fitPageWidth, value.drawnWidth].every(n => Number.isFinite(n) && n > 0)) return;
    const old = this.viewports.get(pageId);
    const same = old?.fitWidth === value.fitWidth && old.fitPageWidth === value.fitPageWidth && old.drawnWidth === value.drawnWidth;
    if (same && !(pageId === this.state.surfacePageId && this.state.zoom.kind === 'scale'
      && this.state.zoom.value <= Math.min(4, value.fitPageWidth / value.fitWidth))) return;
    this.viewports.set(pageId, { ...value });
    if (pageId !== this.state.surfacePageId) return;
    const below = this.state.zoom.kind === 'scale' && this.state.zoom.value <= this.minimumZoom;
    this.update(below ? { zoom: { kind: 'fit-page' } } : {}, below);
  }
  setPlacement(placement: 'center' | 'right'): boolean {
    if (!this.canReposition() || !['center', 'right'].includes(placement) || placement === this.state.placement) return false;
    this.land(this.currentLocation(), { placement }); return true;
  }
  remember(pageId: string, at: ReaderPlace): void {
    if (pageId !== this.state.surfacePageId) return;
    this.rememberSurface(pageId, at);
  }
  rememberSurface(pageId: string, at: ReaderPlace): void {
    const surface: ReaderSurface = pageId === this.state.pageId ? 'original' : 'translated';
    if (pageId !== this.actualId(this.state.pageId, surface) || !place(at)) return;
    const backgroundRevision = at.backgroundRevision ?? this.backgroundRevisions?.[pageId];
    if (backgroundRevision !== undefined && !validId(backgroundRevision)
      || !this.matches({ pageId: this.state.pageId, toEnd: false, place: at,
        ...this.surfaceFields(surface, pageId), ...this.revision(backgroundRevision) })) return;
    const old = this.state.positions[pageId]; if (old?.x === at.x && old.y === at.y && old.backgroundRevision === backgroundRevision) return;
    const positions = { ...this.state.positions, [pageId]: { x: at.x, y: at.y, ...this.revision(backgroundRevision) } };
    const ids = Object.keys(positions).filter(id => id !== pageId);
    while (Object.keys(positions).length > POSITION_LIMIT) delete positions[ids.shift()!];
    this.update({ positions }, true, true);
  }
  /** The caller must additionally enforce scope, raw-contact and append guards synchronously. */
  pinCurrentReference(expected: ReaderReferenceTarget): ReaderSurfaceResult {
    if (!this.canNavigate() || !this.canReposition()) return { status: 'blocked', reason: 'reader-input-active' };
    const page = this.resolvePage(this.state.activeSurface);
    const target = page ? referenceTarget(this.state.activeSurface, page) : null;
    if (!target || !sameReferenceTarget(target, expected)) return { status: 'blocked', reason: 'reference-target-changed' };
    const old = this.state.reference;
    if (!this.referenceUnavailableReason && old.mode === 'pinned' && sameReferenceTarget(old.target, target)) return { status: 'unchanged' };
    this.referenceUnavailableReason = null;
    this.referencePane = null; this.referenceViewport = null;
    this.update({ placement: 'right', reference: { mode: 'pinned', target, targetGeneration: old.targetGeneration + 1,
      zoom: { kind: 'fit-page' }, place: null, landingId: old.landingId + 1 } }, true, true);
    return { status: 'applied' };
  }
  clearReference(): ReaderSurfaceResult {
    if (!this.canNavigate()) return { status: 'blocked', reason: 'reader-input-active' };
    const old = this.state.reference;
    if (old.mode === 'follow-active' && !this.referenceUnavailableReason) return { status: 'unchanged' };
    this.referenceUnavailableReason = null; this.referencePane = null; this.referenceViewport = null;
    const page = this.resolvePage(this.state.activeSurface);
    this.update({ reference: { mode: 'follow-active', target: page ? referenceTarget(this.state.activeSurface, page) : null,
      targetGeneration: old.targetGeneration + 1, zoom: { kind: 'fit-page' }, place: null, landingId: old.landingId + 1 } });
    return { status: 'applied' };
  }
  resolveReference() {
    return this.referenceUnavailableReason ? { status: 'unavailable' as const, target: this.state.reference.target, reason: this.referenceUnavailableReason }
      : resolveReferenceTarget(this.model, this.state.reference.target);
  }
  /** Call only for definitive document lifecycle invalidation, never synchronization busy. */
  invalidateReference(reason: string): void {
    if (this.referenceUnavailableReason === reason) return;
    this.referenceUnavailableReason = reason; this.referencePane = null; this.referenceViewport = null;
    this.update({ reference: { ...this.state.reference, targetGeneration: this.state.reference.targetGeneration + 1 } });
  }
  /** Layout registrations are owned by the mounted view, never by a draw/font ticket. */
  registerReferenceLayout(expected: ReferenceCommandExpectation, request: { layoutMeasurementGeneration: number; paneWidth: number; paneHeight: number; dpr: number; zoom: ReaderZoom }): boolean {
    if (expected.targetGeneration !== this.state.reference.targetGeneration || !sameReferenceTarget(expected.target, this.state.reference.target)
      || this.resolveReference().status !== 'ready') return false;
    if (![request.paneWidth, request.paneHeight, request.dpr].every(n => Number.isFinite(n) && n > 0)
      || !Number.isSafeInteger(request.layoutMeasurementGeneration) || request.layoutMeasurementGeneration < 0
      || !sameReferenceZoom(request.zoom, this.state.reference.zoom)) return false;
    if (this.referencePane && (this.referencePane.paneInstance !== expected.paneInstance || this.referencePane.pointerLease !== expected.pointerLease)) return false;
    if (this.referencePane && request.layoutMeasurementGeneration <= this.referencePane.layoutMeasurementGeneration) return false;
    this.referencePane = { paneInstance: expected.paneInstance, pointerLease: expected.pointerLease, ...request };
    // Retain the last finite fit geometry for an already admitted gesture while
    // the replacement report is pending; new admission requires settled proof.
    return true;
  }
  releaseReferencePane(expected: ReferenceCommandExpectation): void {
    if (this.referenceMatches(expected)) { this.referencePane = null; this.referenceViewport = null; }
  }
  referenceMatches(expected: ReferenceCommandExpectation): boolean {
    return expected.targetGeneration === this.state.reference.targetGeneration && sameReferenceTarget(expected.target, this.state.reference.target)
      && this.resolveReference().status === 'ready' && this.referencePane?.paneInstance === expected.paneInstance
      && this.referencePane.pointerLease === expected.pointerLease;
  }
  get referenceMinimumZoom() { return this.referenceViewport ? Math.min(4, this.referenceViewport.fitPageWidth / this.referenceViewport.fitWidth) : 0; }
  get referenceActualZoom() { const zoom = this.state.reference.zoom; return zoom.kind === 'fit-page' ? this.referenceMinimumZoom : Math.max(this.referenceMinimumZoom, zoom.value); }
  setReferenceViewport(report: ReferenceViewportReport): boolean {
    const p = this.referencePane;
    if (!p || !this.referenceMatches(report.expected) || p.layoutMeasurementGeneration !== report.layoutMeasurementGeneration
      || p.paneWidth !== report.paneWidth || p.paneHeight !== report.paneHeight || p.dpr !== report.dpr
      || !sameReferenceZoom(p.zoom, report.requestedZoom) || !sameReferenceZoom(this.state.reference.zoom, report.requestedZoom)
      || ![report.metrics.fitWidth, report.metrics.fitPageWidth, report.metrics.drawnWidth].every(n => Number.isFinite(n) && n > 0)) return false;
    this.referenceViewport = { ...report.metrics };
    const minimum = Math.min(4, report.metrics.fitPageWidth / report.metrics.fitWidth);
    if (this.state.reference.zoom.kind === 'scale' && this.state.reference.zoom.value <= minimum)
      this.update({ reference: { ...this.state.reference, zoom: { kind: 'fit-page' } } });
    return true;
  }
  setReferenceZoom(expected: ReferenceCommandExpectation, value: ReaderZoom, _admittedGesture = false): boolean {
    if ((!this.canNavigate()) || !this.referenceMatches(expected) || !this.referenceViewport || (value.kind !== 'fit-page' && (value.kind !== 'scale' || !Number.isFinite(value.value) || value.value <= 0))) return false;
    const minimum = Math.min(4, this.referenceViewport.fitPageWidth / this.referenceViewport.fitWidth);
    const next: ReaderZoom = value.kind === 'fit-page' || value.value <= minimum ? { kind: 'fit-page' } : { kind: 'scale', value: Math.min(4, value.value) };
    if (sameReferenceZoom(next, this.state.reference.zoom)) return false;
    // Retain finite fit geometry for an admitted gesture until its next layout report.
    // New commands are separately gated on current settled producer proof.
    this.update({ reference: { ...this.state.reference, zoom: next } }); return true;
  }
  rememberReference(expected: ReferenceCommandExpectation, at: ReaderPlace): boolean {
    if (!this.referenceMatches(expected) || !place(at)) return false;
    this.update({ reference: { ...this.state.reference, place: { x: at.x, y: at.y, backgroundRevision: expected.target.backgroundRevision } } }); return true;
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty || !this.state.pageId) return;
    const { pageId, zoom, placement, positions, back, forward } = this.state;
    try {
      if (!sameScope(this.scope, this.persistence.scope)) throw new Error('reader-state-scope');
      const current = this.currentLocation();
      const saved: SavedReaderState = { version: 1, pageId, zoom, placement, positions, back, forward,
        activeSurface: this.state.activeSurface, display: this.state.display, translatedOnly: this.state.translatedOnly, surfacePageId: this.state.surfacePageId,
        landing: { toEnd: current.toEnd, place: current.place, ...this.surfaceFields(this.state.activeSurface, this.state.surfacePageId), ...this.revision(current.backgroundRevision) } };
      this.persistence.write(this.documentId, structuredClone(saved));
      this.dirty = false; if (this.state.error) this.update({ error: '' });
    } catch (cause) { this.update({ error: String(cause) }); }
  }
}
