/**
 * Turning pages from the wheel and the keyboard. The reader shows one page at a time, so scrolling
 * on past the end of a page goes on to the next, and past its start back to the end of the previous.
 */

/** Where a scrolling pane sits against its top and bottom. */
export interface PaneEdges {
  atStart: boolean;
  atEnd: boolean;
}

type ScrollMetrics = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/** Within a pixel, since zoomed pages scroll to fractional positions. */
export function paneEdges(pane: ScrollMetrics): PaneEdges {
  return {
    atStart: pane.scrollTop <= 1,
    atEnd: pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1,
  };
}

/** The page `amount` pages on, among all pages or only the translated ones. */
export function steppedPage({ current, amount, pageCount, translatedOnly, completed }: {
  current: number; amount: number; pageCount: number; translatedOnly: boolean; completed: readonly number[];
}): number {
  if (translatedOnly) {
    if (!completed.length) return current;
    // The reader keeps the page within the filter; one outside it steps from the first.
    const position = Math.max(0, completed.indexOf(current));
    return completed[Math.max(0, Math.min(position + amount, completed.length - 1))];
  }
  const count = pageCount || current;
  return Math.max(1, Math.min(current + amount, count));
}

/** The first or last page, among all pages or only the translated ones. */
export function edgePage(edge: "first" | "last", { current, pageCount, translatedOnly, completed }: {
  current: number; pageCount: number; translatedOnly: boolean; completed: readonly number[];
}): number {
  if (translatedOnly) return completed.length ? completed[edge === "first" ? 0 : completed.length - 1] : current;
  return edge === "first" ? 1 : pageCount || current;
}

export interface WheelInput extends PaneEdges {
  /** Vertical movement in pixels; positive scrolls down. */
  dy: number;
  /** Event time in milliseconds. */
  time: number;
  /** A mouse notch rather than a touchpad's stream of small steps. */
  notch: boolean;
}

export interface WheelDecision {
  /** 1 for the next page, -1 for the previous one, 0 to stay. */
  turn: -1 | 0 | 1;
  /** Keep the page still: the rest of a gesture that has just turned the page. */
  swallow: boolean;
}

/** Wheel events closer together than this belong to one gesture, including a touchpad's inertia. */
export const WHEEL_GESTURE_GAP_MS = 200;
/** How far a touchpad must scroll on at the edge to turn the page. */
export const TOUCHPAD_TURN_DISTANCE = 120;

/**
 * Decides, event by event, when the wheel turns the page. Only a gesture that starts at the edge
 * counts: a scroll that merely reaches the end, and the inertia that carries it on, stop there, and
 * one more notch or swipe after a pause turns the page. A gesture turns at most one page, and its
 * remaining events are swallowed so that the new page stays at its start.
 */
export function createWheelPager(): (input: WheelInput) => WheelDecision {
  let lastTime = -Infinity;
  let direction = 0;
  let eligible = false;
  let spent = false;
  let distance = 0;
  return ({ dy, time, notch, atStart, atEnd }) => {
    const dir = Math.sign(dy);
    const gap = time - lastTime;
    lastTime = time;
    if (!dir) return { turn: 0, swallow: spent };
    const edge = dir > 0 ? atEnd : atStart;
    if (gap > WHEEL_GESTURE_GAP_MS || dir !== direction) {
      // A reversal within a turned gesture is still inertia or jitter: keep it swallowed.
      if (gap <= WHEEL_GESTURE_GAP_MS && spent) return { turn: 0, swallow: true };
      direction = dir;
      eligible = edge;
      spent = false;
      distance = 0;
    }
    if (spent) return { turn: 0, swallow: true };
    if (!edge) eligible = false;
    if (!eligible) return { turn: 0, swallow: false };
    distance += Math.abs(dy);
    if (!notch && distance < TOUCHPAD_TURN_DISTANCE) return { turn: 0, swallow: false };
    spent = true;
    return { turn: dir > 0 ? 1 : -1, swallow: true };
  };
}

/**
 * What a key press lands on: text fields and widgets with their own arrow, Home and End keys (menus,
 * tabs, the pane divider…) keep every key; buttons keep Space and Enter.
 */
export type KeyTarget = "editable" | "button" | "other";

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox], [role=listbox], [role=slider], [role=spinbutton], [role=menu], [role=menuitem], [role=tab], [role=tablist], [role=option], [role=grid], [role=tree], [role=treeitem], [role=radiogroup], [role=separator]";
const BUTTON = "button, a[href], summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch]";

export function keyTarget(target: { closest?: (selector: string) => unknown } | null): KeyTarget {
  if (!target || typeof target.closest !== "function") return "other";
  if (target.closest(EDITABLE)) return "editable";
  if (target.closest(BUTTON)) return "button";
  return "other";
}

/**
 * Where a key press lands relative to the reader: inside it, on the page body or an element that
 * holds the reader (the tab panel, focused by clicking the page), or elsewhere.
 */
export type KeyPlace = "inside" | "around" | "elsewhere";

/**
 * Whether a key press is the reader's. Only while the reader is shown; and when the press lands on
 * the body or around the reader, only if the last click was in the reader, since clicking an empty
 * spot of the side panel or the library also leaves the focus on the body.
 */
export function readerOwnsKey({ place, pointerInReader, readerVisible }: {
  place: KeyPlace; pointerInReader: boolean; readerVisible: boolean;
}): boolean {
  if (!readerVisible) return false;
  if (place === "inside") return true;
  return place === "around" && pointerInReader;
}

export type ReaderKeyAction =
  | { type: "scroll"; direction: 1 | -1 }
  | { type: "turn"; amount: 1 | -1; toEnd: boolean }
  | { type: "edge"; edge: "first" | "last" }
  | { type: "history"; direction: "back" | "forward" };

/**
 * The reader's paging keys. PageDown and Space scroll by a screen and, at the end of the page, go on
 * to the next; PageUp and Shift+Space go back likewise, to the end of the previous page. Home and End
 * open the first and last pages, and Alt+←/→ go back and forward through link, contents and search jumps.
 */
export function readerKeyAction({ key, shiftKey, ctrlKey, altKey, metaKey, target, atStart, atEnd }: {
  key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; target: KeyTarget;
} & PaneEdges): ReaderKeyAction | null {
  if (target === "editable" || ctrlKey || metaKey) return null;
  if (altKey) {
    if (shiftKey) return null;
    if (key === "ArrowLeft") return { type: "history", direction: "back" };
    if (key === "ArrowRight") return { type: "history", direction: "forward" };
    return null;
  }
  let direction: 1 | -1;
  if (key === "PageDown") direction = 1;
  else if (key === "PageUp") direction = -1;
  else if (key === " " && target !== "button") direction = shiftKey ? -1 : 1;
  else if ((key === "Home" || key === "End") && !shiftKey) return { type: "edge", edge: key === "Home" ? "first" : "last" };
  else return null;
  if (direction > 0 ? atEnd : atStart) return { type: "turn", amount: direction, toEnd: direction < 0 };
  return { type: "scroll", direction };
}
