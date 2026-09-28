/**
 * Highlights of text selected in the PDF. A highlight is saved as a sticky note of kind "highlight"
 * (sidecar library_schema._highlights): its colour, the selected text as its quote, and the rectangles it
 * covers as fractions of the displayed page, [x, y, width, height] like the ink. So it keeps its place
 * at any zoom, and is listed, searched and exported to the memo with the sticky notes.
 * Kept apart from React so that the rules can be tested.
 */

/** The colours offered, as stored (storage.HIGHLIGHT_COLORS) and shown. */
export const HIGHLIGHT_COLORS = [
  { id: "yellow", label: "黄", rgb: "250 204 21" },
  { id: "green", label: "緑", rgb: "74 222 128" },
  { id: "blue", label: "青", rgb: "96 165 250" },
  { id: "pink", label: "ピンク", rgb: "244 114 182" },
  { id: "purple", label: "紫", rgb: "192 132 252" },
] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]["id"];
export type HighlightColorInfo = (typeof HIGHLIGHT_COLORS)[number];

/** A stored colour's entry; yellow for anything this version does not know. */
export function highlightColor(id: string | undefined): HighlightColorInfo {
  return HIGHLIGHT_COLORS.find((color) => color.id === id) ?? HIGHLIGHT_COLORS[0];
}

/** Painted over the page: translucent, and multiplied into it (see PageAppearance.highlightBlend). */
export function highlightFill(id: string | undefined): string {
  return `rgb(${highlightColor(id).rgb} / 0.45)`;
}

/** [x, y, width, height] as fractions of the displayed page. */
export type PageRect = [number, number, number, number];

/** A rectangle in CSS pixels, as getBoundingClientRect gives it. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** As many rectangles as the sidecar keeps for one highlight (storage.MAX_HIGHLIGHT_RECTS). */
export const MAX_HIGHLIGHT_RECTS = 400;

const round = (value: number) => Math.round(value * 100000) / 100000;

/**
 * The rectangles a highlight keeps for the client rectangles of a selection's text (`boxes`, in any
 * order; pdf.js text spans overlap and split words): clipped to `page`, joined into one rectangle per
 * run of text on a line, top to bottom, as fractions of the page. Empty when nothing is on the page.
 */
export function highlightRects(boxes: readonly Box[], page: Box): PageRect[] {
  if (!(page.width > 0) || !(page.height > 0)) return [];
  const pageRight = page.left + page.width;
  const pageBottom = page.top + page.height;
  const clipped = boxes
    .map((box) => ({
      left: Math.max(box.left, page.left), right: Math.min(box.left + box.width, pageRight),
      top: Math.max(box.top, page.top), bottom: Math.min(box.top + box.height, pageBottom),
    }))
    .filter((box) => box.right - box.left > 0.5 && box.bottom - box.top > 0.5)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: typeof clipped = [];
  for (const box of clipped) {
    const height = box.bottom - box.top;
    // The same line: overlapping by most of the lower one's height, and no further apart than a space.
    const line = lines.find((other) => {
      const overlap = Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top);
      const gap = Math.max(other.left, box.left) - Math.min(other.right, box.right);
      return overlap >= 0.5 * Math.min(height, other.bottom - other.top) && gap <= height * 0.6;
    });
    if (line) {
      line.left = Math.min(line.left, box.left);
      line.right = Math.max(line.right, box.right);
      line.top = Math.min(line.top, box.top);
      line.bottom = Math.max(line.bottom, box.bottom);
    } else {
      lines.push({ ...box });
    }
  }
  return lines
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .slice(0, MAX_HIGHLIGHT_RECTS)
    .map((line) => {
      // Rounded at the edges, so that x + width never passes the page's edge by a rounding error.
      const x = round((line.left - page.left) / page.width);
      const y = round((line.top - page.top) / page.height);
      return [x, y, round((line.right - page.left) / page.width) - x, round((line.bottom - page.top) / page.height) - y];
    });
}

/** The highlight under a point of the page (fractions), the one drawn last where they overlap. */
export function highlightAt<T extends { rects?: readonly PageRect[] }>(items: readonly T[], x: number, y: number): T | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].rects?.some(([left, top, width, height]) => x >= left && x <= left + width && y >= top && y <= top + height)) {
      return items[i];
    }
  }
  return null;
}

/** The smallest box around a highlight's rectangles, in the same fractions, or null without any. */
export function rectsBounds(rects: readonly PageRect[] | undefined): PageRect | null {
  if (!rects?.length) return null;
  const left = Math.min(...rects.map((r) => r[0]));
  const top = Math.min(...rects.map((r) => r[1]));
  const right = Math.max(...rects.map((r) => r[0] + r[2]));
  const bottom = Math.max(...rects.map((r) => r[1] + r[3]));
  return [left, top, right - left, bottom - top];
}

const GAP = 6;
const MARGIN = 4;

/**
 * Where the small toolbar over a selection or highlight goes within the pane (`bounds`, with `target`
 * in the same coordinates): centred above it, below it when there is no room above, kept inside the
 * pane. Null while the target is scrolled out of the pane.
 */
export function toolbarPlacement(target: Box, bounds: { width: number; height: number }, size: { width: number; height: number }):
  { left: number; top: number } | null {
  if (target.top + target.height < 0 || target.top > bounds.height) return null;
  let top = target.top - size.height - GAP;
  if (top < MARGIN) top = target.top + target.height + GAP;
  top = Math.max(MARGIN, Math.min(top, bounds.height - size.height - MARGIN));
  const centred = target.left + target.width / 2 - size.width / 2;
  const left = Math.max(MARGIN, Math.min(centred, bounds.width - size.width - MARGIN));
  return { left, top };
}

/**
 * Whether selecting text shows the toolbar: with some text selected in reading mode only. A writing
 * tool (pen, eraser, range selection…) or placing a sticky note uses the pointer for itself.
 */
export function selectionToolbarAllowed({ text, inkTool, placingNote }: { text: string; inkTool: boolean; placingNote: boolean }): boolean {
  return !!text.trim() && !inkTool && !placingNote;
}
