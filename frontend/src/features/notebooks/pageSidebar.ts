/**
 * Where the notebook's page sidebar goes. The paper is drawn at 「ページ全体」 by default, which leaves
 * room on either side of it on a wide view; the sidebar sits in that room, over the view and never in the
 * paper's way, so showing it does not make the paper any smaller. Without the room it folds into a thin
 * tab at the view's left edge, which opens over the paper when it is pointed at or pressed.
 */

/** The sidebar's width: a column of thumbnails with their numbers. */
export const SIDEBAR_WIDTH = 112;
/** The space kept around the sidebar and the paper. */
export const SIDEBAR_GAP = 8;
/** The folded sidebar's width. */
export const TAB_WIDTH = 20;

export type SidebarPlacement = "margin" | "tab";

/**
 * Whether the sidebar fits the room left of the paper (`margin`) or folds into the tab. `viewWidth` is
 * the width the paper is centred in and `paperWidth` the paper's, both in CSS pixels; an unknown paper
 * (still loading, 0) leaves the sidebar folded until it is drawn.
 */
export function sidebarPlacement({ viewWidth, paperWidth, sidebarWidth }: { viewWidth: number; paperWidth: number; sidebarWidth: number }): SidebarPlacement {
  if (!(viewWidth > 0) || !(paperWidth > 0)) return "tab";
  const room = (viewWidth - paperWidth) / 2;
  return room >= sidebarWidth + SIDEBAR_GAP * 2 ? "margin" : "tab";
}

/** The room right of the paper that holds the next-page button, or else the button is laid over the paper. */
export function cornerPlacement({ viewWidth, paperWidth, buttonWidth }: { viewWidth: number; paperWidth: number; buttonWidth: number }): "margin" | "overlay" {
  if (!(viewWidth > 0) || !(paperWidth > 0)) return "overlay";
  return (viewWidth - paperWidth) / 2 >= buttonWidth + SIDEBAR_GAP * 2 ? "margin" : "overlay";
}

/** How far down the tab's track the current page is, 0 (the first page) to 1 (the last). */
export function tabPosition(page: number, count: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(1, (page - 1) / (count - 1)));
}

const THUMBNAIL_WIDTH = 72;
const THUMBNAIL_HEIGHT = 112;
const ROW_EXTRA = 28;

/** A thumbnail's box for a page `ratio` (height over width) tall: as large as fits 72 by 112 px. */
export function thumbnailSize(ratio: number): { width: number; height: number } {
  const shape = ratio > 0 && Number.isFinite(ratio) ? ratio : Math.SQRT2;
  const height = Math.min(THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH * shape);
  return { width: Math.round(height / shape), height: Math.round(height) };
}

/** A sidebar row's height: the thumbnail, its number and the space between rows. */
export function rowHeight(ratio: number): number {
  return thumbnailSize(ratio).height + ROW_EXTRA;
}

/** Whether a pen at `at` is within `reach` px of `box` (or over it). */
export function penNear(at: { x: number; y: number }, box: { left: number; top: number; right: number; bottom: number }, reach: number): boolean {
  return at.x >= box.left - reach && at.x <= box.right + reach && at.y >= box.top - reach && at.y <= box.bottom + reach;
}

/** A pointer that writes: the pen, or a mouse button held down (a drag on the paper); not a finger. */
export function writesWith(pointerType: string): boolean {
  return pointerType === "pen" || pointerType === "mouse";
}

/** The pointers pressed down that write, after `event`: the wheel does not turn the page while any is. */
export function contactAfter(down: ReadonlySet<number>, event: { kind: "down" | "up"; pointerId: number; pointerType: string }): ReadonlySet<number> {
  if (event.kind === "down") {
    if (!writesWith(event.pointerType) || down.has(event.pointerId)) return down;
    return new Set(down).add(event.pointerId);
  }
  if (!down.has(event.pointerId)) return down;
  const next = new Set(down);
  next.delete(event.pointerId);
  return next;
}
