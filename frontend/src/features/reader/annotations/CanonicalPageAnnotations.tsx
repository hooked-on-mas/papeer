import type { Page } from '../../../runtime/edits/contracts';
import { CanonicalInkDrawing } from '../ink/CanonicalInkDrawing';

/** Read-only annotations remain visible while an edit is being saved or another view owns input. */
export function CanonicalPageAnnotations({ page, includeInk, omitAnnotationId }: { page: Page; includeInk: boolean; omitAnnotationId?: string }) {
  const scale = 1000 / page.widthPt;
  return <svg className="pointer-events-none absolute inset-px z-10 h-full w-full" viewBox={`0 0 1000 ${1000 * page.heightPt / page.widthPt}`} aria-label="保存された注釈">
    {page.annotations.filter(annotation => annotation.id !== omitAnnotationId).map(annotation => annotation.kind === 'ink' ? includeInk && <g key={annotation.id} data-ink-id={annotation.id}>
      <CanonicalInkDrawing annotation={annotation} page={page} />
    </g> : annotation.kind === 'highlight' ? <g key={annotation.id} data-highlight-id={annotation.id}>
      {annotation.quads.map((quad, index) => <polygon key={index} points={quad.map(point => `${point.x * scale},${point.y * scale}`).join(' ')} fill={annotation.color} opacity={.3} />)}
    </g> : <g key={annotation.id} data-sticky-id={annotation.id}>
      <title>{annotation.text}</title><circle cx={annotation.anchor.x * scale} cy={annotation.anchor.y * scale} r={6} fill={annotation.color ?? '#f59e0b'} />
    </g>)}
  </svg>;
}
