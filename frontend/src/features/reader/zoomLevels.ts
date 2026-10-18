/**
 * Reader zoom levels. A zoom is a multiplier over the width that fits the pane, as in the old reader,
 * or ZOOM_FIT_PAGE, which shrinks the page until the whole of it fits the pane.
 */

/** Zoom relative to the fitted page width. */
export const ZOOM_PRESETS = [1, 1.25, 1.5, 2, 2.5, 3, 4];

/** 「ページ全体」: the whole page fits the pane. Never wider than at 「幅に合わせる」, so it sits below 1. */
export const ZOOM_FIT_PAGE = 0;

/** Every level Ctrl+wheel and the zoom buttons step through, smallest first. */
export const ZOOM_LEVELS = [ZOOM_FIT_PAGE, ...ZOOM_PRESETS];

/** Continuous touch zoom can pass between fitting the page and fitting its width. */
export const MIN_ZOOM = 0.1;

/** A valid zoom: ZOOM_FIT_PAGE, or a continuous multiplier up to the largest preset. */
export function clampZoom(zoom: number): number {
  if (zoom === ZOOM_FIT_PAGE) return ZOOM_FIT_PAGE;
  if (!Number.isFinite(zoom)) return ZOOM_PRESETS[0];
  return Math.max(MIN_ZOOM, Math.min(ZOOM_PRESETS[ZOOM_PRESETS.length - 1], zoom));
}

/** The level `steps` away from the one nearest `zoom`. */
export function stepZoom(zoom: number, steps: number): number {
  const index = zoom === ZOOM_FIT_PAGE ? 0 : ZOOM_LEVELS.reduce((best, value, i) =>
    i > 0 && Math.abs(value - zoom) < Math.abs(ZOOM_LEVELS[best] - zoom) ? i : best, 1);
  return ZOOM_LEVELS[Math.max(0, Math.min(index + steps, ZOOM_LEVELS.length - 1))];
}

/**
 * Where a pinch starts from, as a scale: 「ページ全体」 counts as a little below 「幅に合わせる」, so that
 * pinching out from it reaches 1 and pinching in below 1 reaches it.
 */
export const PINCH_FIT_PAGE_SCALE = 0.85;
const PINCH_FIT_PAGE_BELOW = 0.92;

export function pinchStart(zoom: number): number {
  return zoom === ZOOM_FIT_PAGE ? PINCH_FIT_PAGE_SCALE : zoom;
}

/** The pinch's scale clamped to where it can go, and the level it snaps to. */
export function pinchLevel(scale: number): { scale: number; level: number } {
  const clamped = Math.max(PINCH_FIT_PAGE_SCALE, Math.min(scale, ZOOM_PRESETS[ZOOM_PRESETS.length - 1]));
  if (clamped < PINCH_FIT_PAGE_BELOW) return { scale: clamped, level: ZOOM_FIT_PAGE };
  const level = ZOOM_PRESETS.reduce((best, value) =>
    Math.abs(Math.log(value / clamped)) < Math.abs(Math.log(best / clamped)) ? value : best);
  return { scale: clamped, level };
}

/**
 * The narrowest a page is drawn at 「幅に合わせる」, however narrow its pane (as when the side panel
 * leaves the reader little room): below this, the pane scrolls sideways rather than cutting the page off.
 */
export const MIN_FIT_WIDTH = 40;

/** The width that fits a page in `room` CSS pixels, the pane's width less its padding. */
export function fitWidthFor(room: number): number {
  return Math.max(MIN_FIT_WIDTH, room);
}

/**
 * Whether a pane scrolls sideways: when zoomed in, or when the page is wider than the room for it. At
 * 「幅に合わせる」 the page's 1px border is let overflow, so that it never brings a scrollbar.
 */
export function scrollsSideways(zoom: number, pageWidth: number, room: number): boolean {
  return zoom > 1 || pageWidth > Math.round(room);
}

/**
 * The page width, in CSS pixels, for `zoom` in a pane that fits pages `fitWidth` wide and `fitHeight`
 * tall. `ratio` is the page's height over its width.
 */
export function pageWidthFor(zoom: number, fitWidth: number, fitHeight: number, ratio: number): number {
  if (zoom !== ZOOM_FIT_PAGE) return Math.round(fitWidth * zoom);
  if (!(fitHeight > 0) || !(ratio > 0)) return Math.round(fitWidth);
  // Floored, so that rounding never leaves the page a pixel taller than the pane.
  return Math.max(1, Math.min(Math.round(fitWidth), Math.floor(fitHeight / ratio)));
}

/** The label the zoom menu shows for a level. */
export function zoomLabel(zoom: number): string {
  if (zoom === ZOOM_FIT_PAGE) return "ページ全体";
  if (zoom === 1) return "幅に合わせる";
  return `${Math.round(zoom * 100)}%`;
}
