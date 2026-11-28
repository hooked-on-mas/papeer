import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import type { Page } from '../../runtime/edits/contracts';
import type { ContentRepository } from '../../runtime/edits/ports';
import { CanonicalPaperBackground } from '../notebooks/CanonicalPaperBackground';
import { CanonicalPageAnnotations } from './annotations/CanonicalPageAnnotations';

const PdfBackground = lazy(() => import('./pdf/CanonicalPdfPagePreview').then(module => ({ default: module.CanonicalPdfPagePreview })));
export type ComparisonResources = Pick<ContentRepository, 'scope' | 'readResource'>;

/** A fixed page, without a Reader controller, input overlay, text selection or navigation authority. */
export function CanonicalDocumentPagePreview({ page, resources, snapshotVersion }: {
  page: Page; resources: ComparisonResources; snapshotVersion: string;
}) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0);
  const identity = JSON.stringify([resources.scope, snapshotVersion, page.id, page.backgroundRevision, page.background, page.widthPt, page.heightPt]);
  useLayoutEffect(() => {
    const element = container.current; if (!element) return;
    const measure = () => setWidth(Math.max(0, element.clientWidth - 16));
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  if (![page.widthPt, page.heightPt].every(value => Number.isFinite(value) && value > 0))
    return <p role="alert">ページの寸法を確認できません。</p>;
  const drawnWidth = Math.min(page.widthPt, width), drawnHeight = drawnWidth * page.heightPt / page.widthPt;
  return <div ref={container} className="min-w-0 p-2" aria-label="ページの比較表示">
    <p className="break-all text-xs">{page.widthPt} × {page.heightPt} pt / ページID: {page.id}</p>
    {width > 0 && <div key={identity} data-comparison-page={page.id} data-background-revision={page.backgroundRevision}
      data-snapshot-version={snapshotVersion} data-width-pt={page.widthPt} data-height-pt={page.heightPt}
      className="relative mx-auto select-none bg-white" style={{ width: drawnWidth, height: drawnHeight }}>
      {page.background.kind === 'paper' ? <CanonicalPaperBackground page={page} />
        : <Suspense fallback={<p role="status">PDF背景を準備しています…</p>}>
          <PdfBackground page={page} resources={resources} width={drawnWidth} />
        </Suspense>}
      <div className="pointer-events-none absolute inset-0 [&>svg]:inset-0"><CanonicalPageAnnotations page={page} includeInk /></div>
    </div>}
  </div>;
}
