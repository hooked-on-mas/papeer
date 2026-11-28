import type { DocumentSnapshot, Page } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository, EditScope, StoredResource } from '../../../runtime/edits/ports.ts';
import { resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import type { DocumentEditState } from '../edit/DocumentEditSession.ts';
import { readerTranslationPages } from '../readerSurfaceModel.ts';

export type CapturedDocument = Readonly<{
  scope: EditScope; snapshot: DocumentSnapshot; pool: 'original' | 'translated';
  sourceVersion: string; heads: readonly string[]; persistence: DocumentEditState['phase'];
}>;
type SnapshotHost = {
  repository: Pick<ContentRepository, 'scope' | 'readResource'> & Partial<Pick<ContentRepository, 'resourceMetadata'>>;
  state(): DocumentEditState; active(): boolean; inputBlocked(): boolean;
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Captures confirmed local content synchronously; output never marks edits as durably saved. */
export class SnapshotSession {
  private readonly host: SnapshotHost;
  constructor(host: SnapshotHost) { this.host = host; }
  capture({ pool = 'original', translatedOnly = false, includeAnnotations = true }: {
    pool?: 'original' | 'translated'; translatedOnly?: boolean; includeAnnotations?: boolean;
  } = {}): CapturedDocument {
    const state = this.host.state();
    if (!this.host.active() || !state.ready || !state.document || !state.selectedVersion || state.inputActive || this.host.inputBlocked()
      || Object.values(state.surfaces).some(surface => surface.textDraft || surface.annotationDraft)) throw new Error('output-input-pending');
    if (state.selectedVersion !== state.document.version) throw new Error('output-version-unavailable');
    if (state.document.pages.length > 10_000) throw new Error('output-page-limit');
    const snapshot = structuredClone(state.document);
    if (pool === 'translated') {
      const translations = readerTranslationPages(snapshot), pages: Page[] = [];
      for (const original of snapshot.pages) {
        const target = translations.get(original.id);
        if (target?.status === 'ambiguous') throw new Error('output-translation-ambiguous');
        if (!target?.page) { if (translatedOnly) continue; throw new Error('output-translation-missing'); }
        pages.push(target.page);
      }
      snapshot.pages = pages;
    }
    if (!snapshot.pages.length) throw new Error('output-empty-document');
    // The chosen pool is an explicit output document, never a reinterpreted translation mapping.
    delete snapshot.translation;
    snapshot.deletedPages = [];
    if (!includeAnnotations) for (const page of snapshot.pages) page.annotations = [];
    return freeze({ scope: structuredClone(this.host.repository.scope), snapshot, pool,
      sourceVersion: state.document.version, heads: [...state.heads], persistence: state.phase });
  }
  assertActive(captured: CapturedDocument, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.host.active() || canonicalJson(this.host.repository.scope) !== canonicalJson(captured.scope)) throw new Error('output-scope-changed');
  }
  async resources(captured: CapturedDocument, signal: AbortSignal): Promise<StoredResource[]> {
    const resources: StoredResource[] = [];
    let totalBytes = 0;
    for (const id of new Set(captured.snapshot.pages.flatMap(page => page.background.kind === 'pdf' ? [page.background.resourceId] : []))) {
      this.assertActive(captured, signal);
      const metadata = await this.host.repository.resourceMetadata?.(id);
      this.assertActive(captured, signal);
      if (metadata && (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0 || totalBytes + metadata.byteLength > 128 * 1024 * 1024))
        throw new Error('output-resource-limit');
      const stored = await this.host.repository.readResource(id);
      this.assertActive(captured, signal);
      if (stored && totalBytes + stored.bytes.length > 128 * 1024 * 1024) throw new Error('output-resource-limit');
      if (!stored || stored.metadata.id !== id || stored.metadata.mediaType !== 'application/pdf'
        || stored.metadata.byteLength !== stored.bytes.length || await resourceHash(stored.bytes) !== stored.metadata.sha256) throw new Error(`output-resource-missing:${id}`);
      this.assertActive(captured, signal);
      for (const page of captured.snapshot.pages) if (page.background.kind === 'pdf' && page.background.resourceId === id) {
        const physical = stored.metadata.pdfPages?.[page.background.pdfPage - 1];
        if (stored.metadata.sha256 !== page.background.sourceRevision || !physical
          || Math.abs(physical.widthPt - page.widthPt) > .001 || Math.abs(physical.heightPt - page.heightPt) > .001) throw new Error(`output-resource-stale:${id}`);
      }
      resources.push({ metadata: structuredClone(stored.metadata), bytes: Uint8Array.from(stored.bytes) });
      totalBytes += stored.bytes.length;
    }
    return resources;
  }
}
