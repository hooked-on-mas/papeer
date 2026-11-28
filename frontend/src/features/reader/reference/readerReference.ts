import type { Page, DocumentSnapshot } from '../../../runtime/edits/contracts.ts';
import type { ReaderSurface } from '../readerSurfaceModel.ts';
import type { ReaderPlace, ReaderViewport } from '../ReaderSession.ts';
import type { ReaderZoom } from '../zoomLevels.ts';

/** Identity excludes annotations: pin follows the current displayed annotations. */
export type ReaderReferenceTarget = Pick<Page, 'backgroundRevision' | 'lifecycleVersion' | 'widthPt' | 'heightPt' | 'background'> & {
  pool: ReaderSurface; pageId: string;
};
export type ReaderReferenceState = { mode: 'follow-active' | 'pinned'; target: ReaderReferenceTarget | null;
  targetGeneration: number; zoom: ReaderZoom; place: ReaderPlace | null; landingId: number };
export type ReferenceResolution = { status: 'ready'; target: ReaderReferenceTarget; page: Page }
  | { status: 'unavailable'; target: ReaderReferenceTarget | null; reason: string };
export type ReferenceCommandExpectation = { targetGeneration: number; target: ReaderReferenceTarget; paneInstance: object; pointerLease: object };
export type ReferenceViewportReport = { expected: ReferenceCommandExpectation; layoutMeasurementGeneration: number;
  paneWidth: number; paneHeight: number; requestedZoom: ReaderZoom; dpr: number; metrics: ReaderViewport };
export function referenceTarget(pool: ReaderSurface, page: Page): ReaderReferenceTarget {
  return { pool, pageId: page.id, backgroundRevision: page.backgroundRevision, lifecycleVersion: page.lifecycleVersion,
    widthPt: page.widthPt, heightPt: page.heightPt, background: structuredClone(page.background) };
}
export function sameReferenceTarget(a: ReaderReferenceTarget | null, b: ReaderReferenceTarget | null): boolean {
  if (!a || !b) return a === b;
  const x = a.background, y = b.background;
  const sameBackground = x.kind === 'pdf' && y.kind === 'pdf'
    ? x.resourceId === y.resourceId && x.sourceRevision === y.sourceRevision && x.pdfPage === y.pdfPage
    : x.kind === 'paper' && y.kind === 'paper' && x.spec.template === y.spec.template && x.spec.color === y.spec.color;
  return a.pool === b.pool && a.pageId === b.pageId && a.backgroundRevision === b.backgroundRevision
    && a.lifecycleVersion === b.lifecycleVersion && a.widthPt === b.widthPt && a.heightPt === b.heightPt && sameBackground;
}
export function resolveReferenceTarget(document: DocumentSnapshot | null, target: ReaderReferenceTarget | null): ReferenceResolution {
  if (!target || !document) return { status: 'unavailable', target, reason: 'reference-page-unavailable' };
  const page = (target.pool === 'original' ? document.pages : document.translation?.pages ?? []).find(p => p.id === target.pageId);
  return page && sameReferenceTarget(target, referenceTarget(target.pool, page))
    ? { status: 'ready', target, page } : { status: 'unavailable', target, reason: 'reference-target-changed' };
}
export function sameReferenceZoom(a: ReaderZoom, b: ReaderZoom): boolean {
  return a.kind === b.kind && (a.kind === 'fit-page' || b.kind === 'scale' && a.value === b.value);
}
/** Apply the same pending annotation projection as the main Connection; never adopt a pending background. */
export function projectReferenceAnnotations(accepted: Page, pendingDocument: DocumentSnapshot | null, pending: boolean, pool: ReaderSurface): Page {
  if (!pending || !pendingDocument) return accepted;
  const candidate = (pool === 'original' ? pendingDocument.pages : pendingDocument.translation?.pages ?? []).find(p => p.id === accepted.id);
  if (!candidate || !sameReferenceTarget(referenceTarget(pool, accepted), referenceTarget(pool, candidate))) return accepted;
  return { ...accepted, annotations: candidate.annotations, annotationVersion: candidate.annotationVersion };
}
