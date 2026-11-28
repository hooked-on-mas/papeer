import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Page } from '../../../runtime/edits/contracts';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { CanonicalInkDrawing } from '../ink/CanonicalInkDrawing';
import { pdfjs, pdfRenderingOptions } from './pdfRendering';
import { canonicalPdfCapturePlan, type CaptureBounds } from './canonicalPdfCapturePlan';
import { assertCanonicalPdfDocument, assertCanonicalPdfPage, canonicalPdfResourceBinding, readCanonicalPdfResource } from './canonicalPdfResource';
import { captureFontStyles, type OutputFont } from '../output/outputFonts';

/** includeInk paints ink only; includeAnnotations also includes highlights and sticky markers.
 * Embedded fonts are verified instead of depending on the current machine's font installation.
 * PDF-native annotations use PDF.js defaults.
 * The caller must retain/revalidate the captured page identity before publishing its result. */
export async function captureCanonicalPdf({ page: source, resources, bounds, includeInk = false, includeAnnotations = false, fonts = [], maxPixels, signal = new AbortController().signal }: {
  page: Page; resources: Pick<ContentRepository, 'scope' | 'readResource'>; bounds: CaptureBounds; includeInk?: boolean; includeAnnotations?: boolean; fonts?: readonly OutputFont[]; maxPixels?: number; signal?: AbortSignal;
}): Promise<{ bytes: Uint8Array; mediaType: 'image/png'; width: number; height: number }> {
  const page = structuredClone(source), plan = canonicalPdfCapturePlan(page, { ...bounds }, maxPixels);
  signal.throwIfAborted();
  if (page.background.kind !== 'pdf') throw new Error('capture-pdf-required');
  const binding = canonicalPdfResourceBinding(resources.scope, page);
  const resource = await readCanonicalPdfResource(binding, resources);
  signal.throwIfAborted();
  const bytes = resource.bytes;
  const loading = pdfjs.getDocument({ ...pdfRenderingOptions, data: bytes });
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const canvas = document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height;
  try {
    const pdf = await loading.promise, physical = await pdf.getPage(page.background.pdfPage);
    assertCanonicalPdfDocument(binding, resource.metadata, pdf.numPages);
    assertCanonicalPdfPage(binding, physical);
    const context = canvas.getContext('2d'); if (!context) throw new Error('capture-canvas-unavailable');
    await physical.render({ canvas, canvasContext: context, viewport: physical.getViewport({ scale: plan.scale }),
      transform: [1, 0, 0, 1, -plan.xPt * plan.scale, -plan.yPt * plan.scale], background: 'white' }).promise;
    signal.throwIfAborted();
    if ((includeInk || includeAnnotations) && page.annotations.length) {
      const annotated = { ...page, annotations: page.annotations.filter(annotation => includeAnnotations || annotation.kind === 'ink') };
      const styled = captureFontStyles([annotated], fonts);
      signal.throwIfAborted();
      const unit = 1000 / page.widthPt;
      const markup = renderToStaticMarkup(createElement('svg', { xmlns: 'http://www.w3.org/2000/svg', width: plan.width, height: plan.height,
        viewBox: `${plan.xPt * unit} ${plan.yPt * unit} ${plan.width / plan.scale * unit} ${plan.height / plan.scale * unit}` },
      createElement('style', {}, styled.css),
      styled.pages[0].annotations.map(annotation => annotation.kind === 'ink'
        ? createElement(CanonicalInkDrawing, { key: annotation.id, annotation, page })
        : annotation.kind === 'highlight' ? createElement('g', { key: annotation.id, fill: annotation.color, opacity: .3 },
          annotation.quads.map((quad, i) => createElement('polygon', { key: i, points: quad.map(p => `${p.x * unit},${p.y * unit}`).join(' ') })))
          : createElement('g', { key: annotation.id }, createElement('title', {}, annotation.text),
            createElement('circle', { cx: annotation.anchor.x * unit, cy: annotation.anchor.y * unit, r: 6, fill: annotation.color ?? '#f59e0b' })))));
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted(); context.drawImage(image, 0, 0);
      } finally { URL.revokeObjectURL(url); }
    }
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('capture-png-failed')), 'image/png'));
    signal.throwIfAborted();
    return { bytes: new Uint8Array(await png.arrayBuffer()), mediaType: 'image/png', width: plan.width, height: plan.height };
  } finally { signal.removeEventListener('abort', abort); await loading.destroy(); canvas.width = 0; canvas.height = 0; }
}
