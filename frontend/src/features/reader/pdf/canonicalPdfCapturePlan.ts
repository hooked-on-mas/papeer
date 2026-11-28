import type { Page } from '../../../runtime/edits/contracts.ts';
export type CaptureBounds = { x: number; y: number; width: number; height: number };
/** 144 dpi, reduced when necessary. Only the selected area allocates a canvas. */
export function canonicalPdfCapturePlan(page: Page, bounds: CaptureBounds, maxPixels = 4_000_000) {
  if (page.background.kind !== 'pdf' || ![page.widthPt, page.heightPt].every(n => Number.isFinite(n) && n > 0)
    || !Object.values(bounds).every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
    || bounds.x + bounds.width > 1 || bounds.y + bounds.height > 1
    || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 4_000_000) throw new Error('capture-bounds-invalid');
  const widthPt = page.widthPt * bounds.width, heightPt = page.heightPt * bounds.height;
  const scale = Math.min(2, Math.sqrt(maxPixels / widthPt / heightPt), 16384 / widthPt, 16384 / heightPt);
  const width = Math.max(1, Math.floor(widthPt * scale)), height = Math.max(1, Math.floor(heightPt * scale));
  if (!Number.isFinite(scale) || scale <= 0 || width * height > maxPixels) throw new Error('capture-size-invalid');
  return { width, height, scale, xPt: page.widthPt * bounds.x, yPt: page.heightPt * bounds.y, widthPt, heightPt };
}
