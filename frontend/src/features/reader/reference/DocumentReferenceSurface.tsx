import type { RefObject } from 'react';
import type { Page } from '../../../runtime/edits/contracts';
import type { CanonicalPdfAsset } from '../pdf/canonicalPdfResource';
import type { CanonicalManagedInputBundle } from '../input/canonicalManagedInput';
import type { ReferenceMeasurement } from './referenceMeasurement';
import { CanonicalPageAnnotations } from '../annotations/CanonicalPageAnnotations';
import { PdfSurface } from '../pdf/PdfSurface';
import { ReferencePaperPane } from '../DocumentPaperPane';

/** Deliberately contains no editing, selection, capture or annotation writer callbacks. */
export type DocumentReferenceView = {
  page: Page; asset: CanonicalPdfAsset | null; assetError: string; retryAsset(): void;
  inputBundle: CanonicalManagedInputBundle; paneRef: RefObject<HTMLDivElement | null>; scopeRef: RefObject<HTMLDivElement | null>;
  pointerLease: object; zoom: number; setZoom(value: number): void; allowTouch(): boolean; allowContinuation(): boolean;
  reportMeasurement(measurement: ReferenceMeasurement): void;
};
const noInk = Object.freeze({ owns: (_id: number) => false });
const noActivation = () => {};
export function DocumentReferenceSurface({ view }: { view: DocumentReferenceView }) {
  if (view.page.background.kind === 'paper') return <ReferencePaperPane view={view} />;
  const p = view.page, a = view.asset;
  if (p.background.kind !== 'pdf') return null;
  const matches = !!a && a.binding.pageId === p.id && a.binding.backgroundRevision === p.backgroundRevision
    && a.binding.resourceId === p.background.resourceId && a.binding.sourceRevision === p.background.sourceRevision
    && a.binding.pdfPage === p.background.pdfPage && a.binding.widthPt === p.widthPt && a.binding.heightPt === p.heightPt;
  return <div className="h-full min-h-0 min-w-0" data-canonical-page={p.id} data-background-revision={p.backgroundRevision}>
    <PdfSurface asset={matches ? a : null} assetError={view.assetError || (a && !matches ? 'pdf-page-mismatch' : '')}
      retryAsset={view.retryAsset} zoom={view.zoom} paneRef={view.paneRef} scopeRef={view.scopeRef} inputBundle={view.inputBundle}
      pointer={{ zoom: { get: () => view.zoom, set: view.setZoom }, allowTouch: view.allowTouch, allowContinuation: view.allowContinuation, inkGesture: noInk,
        lifetimeKey: view.pointerLease, activate: noActivation }} onMetrics={noActivation} onReferenceMeasurement={view.reportMeasurement}
      renderOverlay={() => <CanonicalPageAnnotations page={p} includeInk />} />
  </div>;
}
