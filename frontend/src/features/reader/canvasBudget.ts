/**
 * Memory limits for the reader's page canvases. A canvas holds 4 bytes per device pixel, and its
 * pixels grow with the square of the zoom and of the display's scale: an A4 page 800px wide, zoomed
 * to 400% on a 200% display, needs 57.9M pixels (221 MB), and the pane kept a same-sized copy for redraws.
 */

/**
 * At most 2^25 pixels (128 MB) for a page, the limit pdf.js's own viewer uses (maxCanvasPixels).
 * Below it the page is drawn at the display's full resolution: an A4 page 800px wide up to 300% zoom
 * at 200% scale, and at every zoom (up to 400%) at 150%. Beyond that the page is drawn softer rather
 * than larger, but never with less detail than at the zoom where the limit was reached: at 400% on a
 * 200% display it still gets 1.52 canvas pixels per CSS pixel (1.11 for a page 1100px wide), where
 * body text is drawn with three times the pixels it gets fitted to the pane.
 */
export const MAX_CANVAS_PIXELS = 2 ** 25;

/** Chromium draws nothing on a wider or taller canvas; pdf.js's viewer keeps the same limit (maxCanvasDim). */
export const MAX_CANVAS_SIDE = 32767;

/**
 * The copy that covers the page while it is redrawn at a new size is shown for a moment and
 * stretched anyway, so it keeps at most 2^22 pixels (16 MB): the whole drawing of an A4 page 800px wide
 * at 200% scale, and a scaled-down one when zoomed in.
 */
export const MAX_SNAPSHOT_PIXELS = 2 ** 22;

/**
 * The pixel ratio to draw a page of `width` x `height` CSS pixels at: the display's own, unless the
 * canvas would then exceed `maxPixels` or `maxSide`.
 */
export function cappedPixelRatio(deviceRatio: number, width: number, height: number,
  maxPixels = MAX_CANVAS_PIXELS, maxSide = MAX_CANVAS_SIDE): number {
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  if (!(width > 0) || !(height > 0)) return ratio;
  return Math.min(ratio, Math.sqrt(maxPixels / (width * height)), maxSide / Math.max(width, height));
}

/** The size to copy a `width` x `height` canvas at, keeping its shape, within `maxPixels`. */
export function snapshotSize(width: number, height: number, maxPixels = MAX_SNAPSHOT_PIXELS): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
