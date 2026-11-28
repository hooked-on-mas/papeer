import type { Page, PageExpectation } from '../../../../runtime/edits/contracts.ts';
import type { ContentRepository } from '../../../../runtime/edits/ports.ts';
import { assertResourceMetadata, resourceHash } from '../../../../runtime/edits/contentPublication.ts';
import { canonicalJson } from '../../../../runtime/edits/editModel.ts';
import { pageExpectation } from '../../../../runtime/edits/documentPages.ts';
import { annotationPoints } from '../../../../runtime/edits/annotationGeometry.ts';
import type { DocumentCommandResult, DocumentEditSession } from '../../edit/DocumentEditSession.ts';

const MAX_BYTES = 128 * 1024 * 1024, MAX_PAGES = 10_000;
type Host = { repository: Pick<ContentRepository, 'scope' | 'read' | 'storeResource' | 'readResource'>; document: DocumentEditSession;
  active(): boolean; inputBlocked(): boolean; makeId(): string; allowInsert?: boolean };
type Draft = { generation: number; scope: string; version: string; heads: string; target: PageExpectation; resourceId: string; newPageIds: string[];
  read(): Promise<Uint8Array>; bytes?: Uint8Array; sha256?: string; metadata?: Awaited<ReturnType<ContentRepository['storeResource']>> };
type State = Readonly<{ phase: 'idle' | 'reading' | 'error' | 'ready' | 'submitting'; error: string; pages: readonly { widthPt: number; heightPt: number }[] }>;

/** One staged resource and one existing document journal; no independent document writer. */
export class DocumentPdfImportSession {
  private readonly host: Host; private state: State = { phase: 'idle', error: '', pages: [] };
  private listeners = new Set<() => void>(); private generation = 0; private draft?: Draft; private flight?: Promise<boolean>; private disposed = false;
  constructor(host: Host) { this.host = host; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: Partial<State>) { this.state = Object.freeze({ ...this.state, ...next }); this.listeners.forEach(listener => listener()); }
  canLeave = () => this.state.phase === 'idle';
  private valid(d: Draft) { return !this.disposed && this.draft === d && d.generation === this.generation && this.host.active() && canonicalJson(this.host.repository.scope) === d.scope; }
  private current(d: Draft) {
    const state = this.host.document.getSnapshot();
    if (!this.valid(d) || !state.ready || !state.document || state.selectedVersion !== d.version || state.document.version !== d.version
      || canonicalJson([...state.heads].sort()) !== d.heads) throw new Error('notebook-pdf-stale');
    if (!this.host.document.canNavigate() || this.host.inputBlocked()) throw new Error('notebook-pdf-input-pending');
    const page = state.document.pages.find(p => p.id === d.target.pageId);
    if (!page || canonicalJson(pageExpectation(page)) !== canonicalJson(d.target)) throw new Error('notebook-pdf-stale-page');
    return { document: state.document, page };
  }
  async stage(page: Page, read: () => Promise<Uint8Array>): Promise<boolean> {
    if (this.disposed || this.state.phase !== 'idle' || !this.host.active()) return false;
    const state = this.host.document.getSnapshot();
    if (!state.ready || !state.document || !state.selectedVersion || state.selectedVersion !== state.document.version || !this.host.document.canNavigate() || this.host.inputBlocked()
      || !state.document.pages.some(p => canonicalJson(pageExpectation(p)) === canonicalJson(pageExpectation(page)))) { this.update({ error: 'notebook-pdf-input-pending' }); return false; }
    const d: Draft = { generation: ++this.generation, scope: canonicalJson(this.host.repository.scope), version: state.document.version,
      heads: canonicalJson([...state.heads].sort()), target: pageExpectation(page), resourceId: this.host.makeId(), newPageIds: [], read };
    this.draft = d; this.update({ phase: 'reading', error: '', pages: [] }); return this.prepare(d);
  }
  retry = () => this.draft && this.state.phase === 'error' ? this.prepare(this.draft) : Promise.resolve(false);
  private prepare(d: Draft): Promise<boolean> {
    if (this.flight) return this.flight;
    this.update({ phase: 'reading', error: '' });
    const work = (async () => { try {
      this.current(d);
      if (!d.bytes) { const bytes = await d.read(); this.current(d); if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('notebook-pdf-size'); d.bytes = Uint8Array.from(bytes); }
      d.sha256 ??= await resourceHash(d.bytes); this.current(d);
      const metadata = await this.host.repository.storeResource({ id: d.resourceId, sha256: d.sha256, mediaType: 'application/pdf', bytes: Uint8Array.from(d.bytes), ...(d.metadata ? { expected: d.metadata } : {}) });
      this.current(d); assertResourceMetadata(metadata);
      if (metadata.id !== d.resourceId || metadata.sha256 !== d.sha256 || metadata.mediaType !== 'application/pdf' || metadata.byteLength !== d.bytes.length || !metadata.pdfPages?.length || metadata.pdfPages.length > MAX_PAGES) throw new Error('notebook-pdf-metadata');
      if (d.metadata && canonicalJson(d.metadata) !== canonicalJson(metadata)) throw new Error('notebook-pdf-metadata');
      d.metadata = structuredClone(metadata);
      const stored = await this.host.repository.readResource(d.resourceId); this.current(d);
      if (!stored || canonicalJson(stored.metadata) !== canonicalJson(metadata) || stored.bytes.length !== d.bytes.length || await resourceHash(stored.bytes) !== d.sha256) throw new Error('notebook-pdf-readback');
      this.current(d); this.update({ phase: 'ready', pages: metadata.pdfPages.map(p => ({ widthPt: p.widthPt, heightPt: p.heightPt })) }); return true;
    } catch (error) { if (this.valid(d)) this.update({ phase: 'error', error: error instanceof Error ? error.message : 'notebook-pdf-failed' }); return false; } })();
    this.flight = work; void work.finally(() => { if (this.flight === work) this.flight = undefined; }); return work;
  }
  async submit(mode: 'insert' | 'insert-all' | 'replace', physical: number): Promise<DocumentCommandResult> {
    const d = this.draft; if (!d || this.state.phase !== 'ready') return { status: 'refused', reason: 'notebook-pdf-not-ready' };
    try {
      if ((mode !== 'insert' && mode !== 'insert-all' && mode !== 'replace') || !Number.isInteger(physical) || physical < 1 || physical > this.state.pages.length) throw new Error('notebook-pdf-page');
      if (mode !== 'replace' && this.host.allowInsert === false) throw new Error('document-pdf-insert-not-allowed');
      const count = mode === 'insert-all' ? this.state.pages.length : 1;
      while (d.newPageIds.length < count) d.newPageIds.push(this.host.makeId());
      this.current(d); this.update({ phase: 'submitting', error: '' });
      const read = await this.host.repository.read(this.host.document.documentId); this.current(d);
      if (canonicalJson([...read.heads].sort()) !== d.heads || !read.heads.includes(d.version)) throw new Error('notebook-pdf-stale-head');
      const result = await this.host.document.buildDocumentEdit((document, batchId) => {
        if (!this.valid(d) || document.version !== d.version || this.host.inputBlocked()) throw new Error('notebook-pdf-stale');
        const index = document.pages.findIndex(p => p.id === d.target.pageId), source = document.pages[index];
        if (!source || canonicalJson(pageExpectation(source)) !== canonicalJson(d.target)) throw new Error('notebook-pdf-stale-page');
        if (mode !== 'replace' && document.pages.length + count > 500) throw new Error('notebook-page-limit');
        const size = d.metadata!.pdfPages![physical - 1];
        if (mode === 'replace' && source.annotations.some(a => a.kind === 'highlight')) throw new Error('notebook-pdf-highlight');
        if (mode === 'replace' && source.annotations.some(a => annotationPoints(a).some(p => p.x < 0 || p.y < 0 || p.x > size.widthPt || p.y > size.heightPt))) throw new Error('notebook-pdf-overflow');
        const makePage = (number: number, id: string): Page => { const dimensions = d.metadata!.pdfPages![number - 1]; return {
          id, backgroundRevision: batchId, lifecycleVersion: batchId, annotationVersion: batchId,
          widthPt: dimensions.widthPt, heightPt: dimensions.heightPt, background: { kind: 'pdf', resourceId: d.resourceId, sourceRevision: d.sha256!, pdfPage: number }, annotations: mode === 'replace' ? structuredClone(source.annotations) : [] }; };
        if (mode === 'replace') return [{ type: 'replace', expected: d.target, page: makePage(physical, source.id) }];
        return Array.from({ length: count }, (_, offset) => ({ type: 'insert' as const, index: index + 1 + offset,
          page: makePage(mode === 'insert-all' ? offset + 1 : physical, d.newPageIds[offset]) }));
      });
      if (result.status === 'applied') { if (this.draft === d) { this.draft = undefined; this.update({ phase: 'idle', error: '', pages: [] }); } }
      else if (this.valid(d)) this.update({ phase: 'ready', error: result.status === 'refused' ? result.reason : 'notebook-pdf-unchanged' });
      return result;
    } catch (error) { const reason = error instanceof Error ? error.message : 'notebook-pdf-failed'; if (this.valid(d)) this.update({ phase: 'ready', error: reason }); return { status: 'refused', reason }; }
  }
  cancel() { if (this.state.phase === 'submitting') return false; this.generation++; this.draft = undefined; this.flight = undefined; this.update({ phase: 'idle', error: '', pages: [] }); return true; }
  activate() { if (this.disposed) { this.disposed = false; this.generation++; } }
  dispose() { this.disposed = true; this.generation++; this.draft = undefined; this.flight = undefined; this.update({ phase: 'idle', error: '', pages: [] }); }
}
