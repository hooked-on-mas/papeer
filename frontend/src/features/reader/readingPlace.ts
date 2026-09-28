/**
 * Keeps the place being read when a reader pane changes size, e.g. as the side panel opens or closes:
 * the page is redrawn at a new width, and the same scroll position in pixels would land elsewhere on it.
 * Kept apart from React so that the rules can be tested.
 */

/** A pane's view and the page in it. */
export interface PaneView {
  scrollTop: number;
  scrollLeft: number;
  clientWidth: number;
  clientHeight: number;
  /** The page's box, in the pane's scrolled content (as scrollTop and scrollLeft count). */
  page: { top: number; left: number; width: number; height: number };
}

/**
 * Where the view is on the page, as fractions of the page's size: `y` for the view's top edge, `x` for
 * its middle (which is what stays in view when the page is wider than the pane).
 */
export interface ReadingPlace {
  y: number;
  x: number;
}

/** Where the view is on the page, or null while there is no page to measure. */
export function readingPlace(view: PaneView): ReadingPlace | null {
  const { page } = view;
  if (!(page.width > 0) || !(page.height > 0)) return null;
  return {
    // Above the page (in the padding over it) counts as its top.
    y: Math.max(0, (view.scrollTop - page.top) / page.height),
    x: (view.scrollLeft + view.clientWidth / 2 - page.left) / page.width,
  };
}

/**
 * The scroll position that brings `place` back into view on the page as `view` now lays it out.
 * `sideways`: whether the pane scrolls sideways (zoomlevels.ts, scrollsSideways). When it does not, or
 * the page is no wider than the pane, the view stays at the left edge: the page's 1px border, let
 * overflow at 「幅に合わせる」, would otherwise be scrolled out of sight.
 */
export function scrollForPlace(place: ReadingPlace, view: PaneView, { sideways = true }: { sideways?: boolean } = {}): { top: number; left: number } {
  const { page } = view;
  return {
    // At the top of the page, the view goes back to the very top, padding and all.
    top: place.y > 0 ? Math.max(0, Math.round(page.top + place.y * page.height)) : 0,
    left: !sideways || page.width <= view.clientWidth ? 0 : Math.max(0, Math.round(page.left + place.x * page.width - view.clientWidth / 2)),
  };
}

/**
 * Remembers the place across a run of size changes (a drag of the panel's edge, or the panel opening
 * and closing again), so that a view pushed to the end of a page that grew shorter goes back to where it
 * was once the page grows again. The place is measured afresh once the view has moved since it was put
 * back, or the page is another one or at another width. `pageWidth` is the width the page is laid out
 * at (PdfPane's pageWidth), not its box as drawn, which differs by the border while the drawing is
 * scaled before the page is drawn again.
 */
export function createPlaceKeeper() {
  let held: { key: string; place: ReadingPlace; top: number; left: number; pageWidth: number } | null = null;
  return {
    /** Before the pane changes size: the place to keep for the page `key`, laid out `pageWidth` wide. */
    measure(key: string, view: PaneView, pageWidth: number): ReadingPlace | null {
      if (held && held.key === key && held.top === view.scrollTop && held.left === view.scrollLeft
        && held.pageWidth === pageWidth) return held.place;
      held = null;
      return readingPlace(view);
    },
    /** After the view has been put back at `place`: `view` as it is now, the scroll position read back. */
    restored(key: string, place: ReadingPlace, view: PaneView, pageWidth: number) {
      held = { key, place, top: view.scrollTop, left: view.scrollLeft, pageWidth };
    },
    /** Another page is shown: a place kept for the one before is not come back to. */
    reset() {
      held = null;
    },
  };
}
