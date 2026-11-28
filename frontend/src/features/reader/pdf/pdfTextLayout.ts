import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

type NativeTextLayout = { layer: HTMLElement; spans: HTMLElement[]; minimum: number };
export type PdfTextLayoutState = { native: NativeTextLayout | null };
export const createPdfTextLayoutState = (): PdfTextLayoutState => ({ native: null });

/** PDF.js's text dimensions use raw PDF units. React-PDF's inherited scale omits
 * UserUnit, whereas its canvas viewport includes it. Set the exact same effective
 * scale on this layer before fitting or publishing any geometry proof. */
export function fitCanonicalPdfTextLayer(state: PdfTextLayoutState, layer: HTMLElement, content: TextContent,
  drawnWidth: number, viewport: { width: number; userUnit: number }): void {
  if (![drawnWidth, viewport.width, viewport.userUnit].every(value => Number.isFinite(value) && value > 0)) return;
  const scale = drawnWidth / viewport.width * viewport.userUnit;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const value = String(scale);
  if (layer.style.getPropertyValue('--total-scale-factor') !== value) layer.style.setProperty('--total-scale-factor', value);
  fitPdfTextLayer(state, layer, content, scale);
}

/** Each drawing retains PDF.js native values, never values produced by a prior refit. */
export function fitPdfTextLayer(state: PdfTextLayoutState, layer: HTMLElement, content: TextContent, scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) return;
  const spans = Array.from(layer.querySelectorAll<HTMLElement>('span[role="presentation"]'));
  const items = content.items.filter((item): item is TextItem => 'str' in item && item.str !== '');
  if (spans.length !== items.length) return;
  if (state.native?.layer === layer && (state.native.spans.length !== spans.length
    || state.native.spans.some((span, index) => span !== spans[index]))) return;
  if (!state.native || state.native.layer !== layer) {
    const rawMinimum = layer.style.getPropertyValue('--min-font-size');
    const minimum = rawMinimum ? Number(rawMinimum) : 1;
    if (!Number.isFinite(minimum) || minimum <= 0) return;
    state.native = { layer, spans, minimum };
  }
  const native = state.native, effective = Math.max(native.minimum, 1 / scale);
  if (!Number.isFinite(effective)) return;
  const value = String(effective);
  if (layer.style.getPropertyValue('--min-font-size') !== value) layer.style.setProperty('--min-font-size', value);
  // The raw inline font heights are PDF.js values and remain untouched. The
  // inherited CSS multiplies them by scale * effective and inversely scales.
  const widths = spans.map(span => span.offsetWidth);
  spans.forEach((span, index) => {
    if (!span.style.getPropertyValue('--scale-x') || !widths[index]) return;
    const item = items[index], width = content.styles[item.fontName]?.vertical ? item.height : item.width;
    const fit = width * scale * effective / widths[index];
    if (!Number.isFinite(fit) || fit <= 0) return;
    const next = String(fit);
    if (span.style.getPropertyValue('--scale-x') !== next) span.style.setProperty('--scale-x', next);
  });
}
