import type { ContentRepository } from '../../../runtime/edits/ports.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { isNoteTemplate } from '../../../runtime/markdown/noteTemplates.ts';
import { formatMarkdownCitationUri, parseMarkdownCitationUri, type CitationTarget } from '../../../runtime/markdown/markdownCitations.ts';
import { resolveCitationLocation } from './citationLocation.ts';
import { originalForTranslatedPage } from '../readerSurfaceModel.ts';
import { resolveAnnotationLocation, type AnnotationLocationRequest } from './annotationLocation.ts';

export type ContentCloseGuard = { prepareClose(): Promise<boolean>; canClose(): boolean };
type ContentRegistration = { documentId: string; guard: ContentCloseGuard; kind: 'loading' | 'error' | 'controller' };
export type ContentNavigationResult = { status: 'applied' | 'unchanged' | 'blocked'; reason?: string };
export type ContentNavigationLocation = Readonly<{ documentId: string; catalogVersion: string | null; target?: CitationTarget; annotation?: AnnotationLocationRequest }>;
export type ContentNavigationState = {
  documentId: string | null; catalogVersion: string | null; citation: { id: string; target: CitationTarget; annotation?: AnnotationLocationRequest } | null;
  back: readonly ContentNavigationLocation[]; forward: readonly ContentNavigationLocation[]; busy: boolean; error: string;
};
const HISTORY_LIMIT = 100;
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) && id.length === 36;
function freezeRequest<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeRequest); Object.freeze(value); }
  return value;
}

/** Same-scope selection only. Hidden recovery authorities remain owned by the registry. */
export class ContentNavigationSession {
  private state: ContentNavigationState;
  private readonly listeners = new Set<() => void>();
  private readonly repository: Pick<ContentRepository, 'scope' | 'read'>;
  readonly scope: Readonly<ContentRepository['scope']>;
  private readonly isActive: () => boolean;
  private readonly makeId: () => string;
  private available = false;
  private generation = 0;
  private everRegistered = false;
  private restoring = false;
  private availabilityRevision = 0;
  getAvailabilityRevision = () => this.availabilityRevision;
  isAvailable = () => this.available;
  isRestoring = () => this.restoring;
  private selectionObserver?: (id: string) => void;
  private interactionObserver?: () => void;
  observeSelection(observer: (id: string) => void, interaction: () => void) { this.selectionObserver = observer; this.interactionObserver = interaction; return () => { if (this.selectionObserver === observer) { this.selectionObserver = undefined; this.interactionObserver = undefined; } }; }
  restoreDocument(id: string, current: () => boolean): Promise<ContentNavigationResult> {
    if (this.state.documentId !== null || this.state.busy || !current()) return Promise.resolve({ status: 'blocked', reason: 'stale' });
    this.restoring = true;
    return this.navigate(id, null, false, undefined, false, undefined, false, current).finally(() => { this.restoring = false; });
  }
  private currentRoute?: ContentNavigationLocation;
  private current?: ContentRegistration;
  private requestRevision = 0;
  private lastLoader?: { identity: object; generation: number; registration: ContentRegistration };
  constructor(options: { repository: Pick<ContentRepository, 'scope' | 'read'>; documentId: string | null; isActive: () => boolean; makeId?: () => string }) {
    if (options.documentId !== null && !validId(options.documentId)) throw new Error('navigation-document-invalid');
    this.repository = options.repository; this.scope = Object.freeze(structuredClone(options.repository.scope)); this.isActive = options.isActive;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.state = Object.freeze({ documentId: options.documentId, catalogVersion: null, citation: null, back: Object.freeze([]), forward: Object.freeze([]), busy: false, error: '' });
  }
  assertScope(scope: ContentRepository['scope']): void { if (canonicalJson(this.scope) !== canonicalJson(scope)) throw new Error('navigation-scope'); }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<ContentNavigationState>) {
    this.state = Object.freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener());
  }
  setAvailable(available: boolean) {
    if (this.available === available) return;
    this.available = available; this.generation++; this.availabilityRevision++; this.lastLoader = undefined;
    this.update(available ? {} : { busy: false });
  }
  registerCurrent(documentId: string, guard: ContentCloseGuard, kind: 'loading' | 'error' | 'controller' = 'controller', identity?: object): () => void {
    if (documentId !== this.state.documentId || this.current) return () => {};
    // StrictMode may immediately release and re-register the same mounted, read-only loader.
    // Preserve only that exact loader's registration; a new component, phase or lifecycle never inherits it.
    const reused = kind === 'loading' && identity && this.lastLoader?.identity === identity
      && this.lastLoader.generation === this.generation && this.lastLoader.registration.documentId === documentId
      ? this.lastLoader.registration : undefined;
    const registration = reused ?? { documentId, guard, kind };
    this.current = registration; this.everRegistered = true;
    this.lastLoader = kind === 'loading' && identity ? { identity, generation: this.generation, registration } : undefined;
    return () => { if (this.current === registration) this.current = undefined; };
  }
  /** The same currently registered view must remain the owner through close preparation. */
  async prepareScopeLeave(): Promise<boolean> {
    const source = this.state.documentId, owner = this.current, generation = this.generation;
    if (source === null) return !this.current && this.available && this.isActive();
    if (!owner || owner.documentId !== source || !this.available || !this.isActive()) return false;
    const allowed = await owner.guard.prepareClose();
    return allowed && this.available && this.isActive() && this.generation === generation && this.current === owner
      && this.state.documentId === source && owner.guard.canClose();
  }
  private blocked(reason: string): ContentNavigationResult { this.update({ error: reason }); return { status: 'blocked', reason }; }
  /** An explicit current catalog head also selects the controller's metadata version, even for the same document. */
  openDocument = (id: string, catalogVersion?: string) => this.navigate(id, null, false, catalogVersion, false);
  /** Read-only inspection of a logically deleted item from the recovery list. */
  openDeletedDocument = (id: string, catalogVersion?: string) => this.navigate(id, null, false, catalogVersion, true);
  openCitation = (value: CitationTarget): Promise<ContentNavigationResult> => {
    let target: CitationTarget;
    try { target = parseMarkdownCitationUri(formatMarkdownCitationUri(value))!; }
    catch { return Promise.resolve(this.blocked('citation-invalid')); }
    if (!target) return Promise.resolve(this.blocked('citation-invalid'));
    if (target.libraryId !== this.repository.scope.libraryId) return Promise.resolve(this.blocked('library-mismatch'));
    return this.navigate(target.documentId, target, false, this.state.catalogVersion ?? undefined);
  };
  openAnnotation = (value: AnnotationLocationRequest, catalogVersion?: string | null): Promise<ContentNavigationResult> => {
    let request: AnnotationLocationRequest;
    try {
      request = freezeRequest(structuredClone(value));
      if (!validId(request.version) || !parseMarkdownCitationUri(formatMarkdownCitationUri(request.target))) throw new Error('invalid');
    } catch { return Promise.resolve(this.blocked('annotation-invalid')); }
    if (request.target.libraryId !== this.repository.scope.libraryId) return Promise.resolve(this.blocked('library-mismatch'));
    const selectedCatalog = catalogVersion === undefined ? this.state.catalogVersion : catalogVersion;
    return this.navigate(request.target.documentId, request.target, false, selectedCatalog ?? undefined, false, request);
  };
  back = (): Promise<ContentNavigationResult> => {
    const location = this.state.back[this.state.back.length - 1];
    return location ? this.navigate(location.documentId, location.target ?? null, true, location.catalogVersion ?? undefined, false, location.annotation) : Promise.resolve({ status: 'unchanged' });
  };
  forward = (): Promise<ContentNavigationResult> => {
    const location = this.state.forward[this.state.forward.length - 1];
    return location ? this.navigate(location.documentId, location.target ?? null, false, location.catalogVersion ?? undefined, false, location.annotation, true) : Promise.resolve({ status: 'unchanged' });
  };
  completeCitation(id: string, error = '') {
    if (this.state.citation?.id === id) {
      if (error && this.currentRoute?.documentId === this.state.documentId) this.currentRoute = Object.freeze({ documentId: this.currentRoute.documentId, catalogVersion: this.currentRoute.catalogVersion });
      this.update({ citation: null, error });
    }
  }
  private async navigate(id: string, target: CitationTarget | null, backward: boolean, catalogVersion?: string, allowDeleted = false, annotation?: AnnotationLocationRequest, forward = false, restoreCurrent?: () => boolean): Promise<ContentNavigationResult> {
    const request = ++this.requestRevision;
    const initial = this.current, source = this.state.documentId, generation = this.generation;
    const result = await this.navigateOnce(id, target, backward, catalogVersion, allowDeleted, annotation, forward, restoreCurrent);
    if (restoreCurrent || result.reason !== 'stale' || initial?.kind !== 'loading' || source === null) return result;
    // Re-admit exactly once only across a completed loader-to-controller/error handoff.
    // The replacement guard performs prepareClose/canClose and all catalog/content reads again.
    const successor = this.current;
    if (request !== this.requestRevision || generation !== this.generation || !this.available || !this.isActive()
      || this.state.documentId !== source || !successor || successor === initial || successor.documentId !== source
      || successor.kind === 'loading') return result;
    return this.navigateOnce(id, target, backward, catalogVersion, allowDeleted, annotation, forward);
  }
  private async navigateOnce(id: string, target: CitationTarget | null, backward: boolean, catalogVersion?: string, allowDeleted = false, annotation?: AnnotationLocationRequest, forward = false, restoreCurrent?: () => boolean): Promise<ContentNavigationResult> {
    if (!restoreCurrent) this.interactionObserver?.();
    if (!restoreCurrent && this.restoring) { this.generation++; this.restoring = false; this.update({ busy: false }); }
    if (!validId(id)) return this.blocked('document-invalid');
    if (!this.available || !this.isActive()) return this.blocked('unavailable');
    if (this.state.busy) return { status: 'blocked', reason: 'busy' };
    if (!target && id === this.state.documentId && (catalogVersion ?? null) === this.state.catalogVersion) return { status: 'unchanged' };
    const source = this.state.documentId, generation = this.generation;
    // A selected target whose controller never mounted has no editing surface to close.
    // This escape is back-only; releasing a previously mounted owner never grants it.
    const fallback = (source === null || backward) && !this.current && !this.everRegistered;
    const registration = this.current ?? (fallback ? { documentId: source,
      guard: { prepareClose: async () => true, canClose: () => true } } : undefined);
    if (!registration || registration.documentId !== source) return this.blocked('current-unavailable');
    const alive = () => this.available && this.isActive() && this.generation === generation
      && (fallback ? !this.current && !this.everRegistered : this.current === registration) && this.state.documentId === source && (!restoreCurrent || restoreCurrent());
    this.update({ busy: true, error: '' });
    try {
      if (!await registration.guard.prepareClose()) return alive() ? this.blocked('current-blocked') : { status: 'blocked', reason: 'stale' };
      if (!alive()) return { status: 'blocked', reason: 'stale' };
      const catalog = await this.repository.read(this.repository.scope.libraryId);
      if (!alive()) return { status: 'blocked', reason: 'stale' };
      if (catalog.checkpoint.libraryId !== this.repository.scope.libraryId) return this.blocked('catalog-invalid');
      if (catalogVersion !== undefined && !catalog.heads.includes(catalogVersion)) return this.blocked('catalog-head-unavailable');
      if (catalogVersion === undefined && catalog.heads.length !== 1) return this.blocked('catalog-head-selection-required');
      const library = new EditGraph(catalog.checkpoint).snapshot(catalogVersion ?? catalog.heads[0]);
      if (library?.kind !== 'library' || library.id !== this.repository.scope.libraryId) return this.blocked('catalog-invalid');
      const isDeleted = library.deletions.some(value => value.active && value.itemIds.includes(id));
      if (allowDeleted ? !isDeleted : isDeleted) return this.blocked(allowDeleted ? 'not-deleted' : 'deleted');
      const item = library.items.find(value => value.id === id);
      if (!item) return this.blocked('missing');
      if (restoreCurrent && isNoteTemplate(item)) return this.blocked('template');
      if (item.kind === 'attachment') {
        if (!item.resourceId) return this.blocked('content-invalid');
        if (target) return this.blocked('citation-content-invalid');
      } else {
      const content = await this.repository.read(id);
      if (!alive()) return { status: 'blocked', reason: 'stale' };
      if (restoreCurrent && content.heads.length !== 1) return this.blocked('content-head-selection-required');
      const root = content.checkpoint.root;
      const expected = item.kind === 'markdown' ? 'markdown' : 'document';
      if (content.checkpoint.libraryId !== this.repository.scope.libraryId || root.id !== id || root.kind !== expected || !content.heads.length)
        return this.blocked('content-invalid');
      const graph = new EditGraph(content.checkpoint);
      if (content.heads.some(head => !graph.snapshot(head))) return this.blocked('content-invalid');
      if (target) {
        if (root.kind !== 'document') return this.blocked('citation-content-invalid');
        if (annotation) {
          if (!content.heads.includes(annotation.version)) return this.blocked('annotation-head-changed');
          const document = graph.snapshot(annotation.version);
          if (document?.kind !== 'document') return this.blocked('citation-content-invalid');
          const location = resolveAnnotationLocation(annotation, { libraryId: this.repository.scope.libraryId, document });
          if (location.status === 'unresolved') return this.blocked(location.reason);
        } else if (content.heads.length === 1) {
          const document = graph.snapshot(content.heads[0]);
          if (document?.kind !== 'document') return this.blocked('citation-content-invalid');
          const location = resolveCitationLocation(target, { libraryId: this.repository.scope.libraryId, document });
          if (location.status === 'unresolved') return this.blocked(location.reason);
          if (target.surface === 'translated') {
            const route = originalForTranslatedPage(document, target.pageId);
            if (route.status === 'unresolved') return this.blocked(route.reason);
          }
        }
      }
      }
      if (!alive() || !registration.guard.canClose()) return this.blocked('current-blocked');
      const citation = target ? { id: this.makeId(), target, ...(annotation ? { annotation } : {}) } : null;
      if (citation) { if (citation.target.anchor) Object.freeze(citation.target.anchor); Object.freeze(citation.target); Object.freeze(citation); }
      const sourceLibrary = this.state.catalogVersion && this.state.catalogVersion !== (catalogVersion ?? catalog.heads[0])
        ? new EditGraph(catalog.checkpoint).snapshot(this.state.catalogVersion)
        : library;
      const sourceDeleted = source !== null && (library.deletions.some(value => value.active && value.itemIds.includes(source))
        || (sourceLibrary?.kind === 'library' && sourceLibrary.deletions.some(value => value.active && value.itemIds.includes(source))));
      const lastBack = this.state.back[this.state.back.length - 1];
      const sourceRoute = source === null ? null : this.currentRoute?.documentId === source && this.currentRoute.catalogVersion === this.state.catalogVersion
        ? this.currentRoute : Object.freeze({ documentId: source, catalogVersion: this.state.catalogVersion });
      const back = backward ? this.state.back.slice(0, -1)
        : source === null || id === source ? [...this.state.back]
        : sourceDeleted ? (lastBack?.documentId === id && lastBack.catalogVersion === (catalogVersion ?? null)
          ? this.state.back.slice(0, -1) : [...this.state.back])
        : [...this.state.back, sourceRoute!].slice(-HISTORY_LIMIT);
      const nextForward = backward ? sourceRoute && !sourceDeleted ? [...this.state.forward, sourceRoute].slice(-HISTORY_LIMIT) : [...this.state.forward]
        : forward ? this.state.forward.slice(0, -1) : id !== source ? [] : [...this.state.forward];
      if (id !== source) { this.current = undefined; this.everRegistered = false; }
      this.currentRoute = freezeRequest({ documentId: id, catalogVersion: catalogVersion ?? null,
        ...(target ? { target: structuredClone(target) } : {}), ...(annotation ? { annotation: structuredClone(annotation) } : {}) });
      this.update({ documentId: id, catalogVersion: catalogVersion ?? null, citation, back: Object.freeze(back), forward: Object.freeze(nextForward), error: '' });
      if (!restoreCurrent && !allowDeleted) this.selectionObserver?.(id);
      return { status: 'applied' };
    } catch (error) { return alive() ? this.blocked(String(error)) : { status: 'blocked', reason: 'stale' }; }
    finally { if (this.generation === generation) this.update({ busy: false }); }
  }
}
