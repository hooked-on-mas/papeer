/**
 * Layout decisions for the reader's bars, kept apart from React so that they can be tested:
 * which of the reading toolbar's items fit on its single row, and which pane the one writing
 * toolbar serves.
 */

export interface BarItem {
  id: string;
  /** Widths in px of the item's forms, smallest first (e.g. its icon alone, then with its label). */
  widths: readonly number[];
  /** Always shown, in its smallest form at least. */
  required?: boolean;
}

/** The form each item is shown in, as an index into its widths; -1 puts it in the 「…」 menu. */
export type BarFit = Record<string, number>;

/**
 * Fits `items`, most important first, into a row `available` px wide with `gap` px between them.
 * The required ones come first, in their smallest form; then the others in order, each left out if it
 * doesn't fit (a smaller one further down may still fit); then, in the same order, each item shown
 * grows to the largest form that fits.
 */
export function fitBar(items: readonly BarItem[], available: number, gap: number): BarFit {
  const fit: BarFit = {};
  // Every item pays for the gap before it; the first has none, which the extra gap here makes up for.
  let room = available + gap;
  for (const item of items) {
    if (!item.required) continue;
    fit[item.id] = 0;
    room -= item.widths[0] + gap;
  }
  for (const item of items) {
    if (item.required) continue;
    const need = item.widths[0] + gap;
    fit[item.id] = need <= room ? 0 : -1;
    if (fit[item.id] === 0) room -= need;
  }
  for (const item of items) {
    let form = fit[item.id];
    if (form < 0) continue;
    while (form + 1 < item.widths.length && item.widths[form + 1] - item.widths[form] <= room) {
      room -= item.widths[form + 1] - item.widths[form];
      form++;
    }
    fit[item.id] = form;
  }
  return fit;
}

/** Space between the reading toolbar's items (gap-1). */
export const TOOLBAR_GAP = 4;
/** Kept free at the row's end, as the widths below are estimates of rendered text. */
export const TOOLBAR_SLACK = 8;

/**
 * The reading toolbar's items, most important first, with the widths their markup in
 * ReaderToolbar.tsx takes: 12px text, where a Japanese character is 12px wide; a 16px icon button
 * is 24px; a 14px icon with a label is padded by 12px (6px each side) and 4px apart from the label.
 * Items that start a group carry the 6px margin that sets them apart.
 */
export function readerToolbarItems({ focusMode, hasOutline }: {
  focusMode: boolean;
  hasOutline: boolean;
}): BarItem[] {
  const items: BarItem[] = [
    // ‹ [page] ›
    { id: "pages", widths: [24 + 44 + 24 + 2 * TOOLBAR_GAP], required: true },
    // Always there, as it pushes the groups after it to the row's end; the page count shows in it.
    { id: "spacer", widths: [6], required: true },
    // Writing always keeps its icon and label, including in narrow windows.
    { id: "ink", widths: [100], required: true },
    // 集中表示 / 集中表示を終了, bordered; it stands outside the clipped area, by the 「…」 button.
    { id: "focus", widths: [6 + 32, 6 + 32 + 4 + (focusMode ? 84 : 48)], required: true },
    { id: "search", widths: [26, 26 + 4 + 24] },
    // The zoom select alone (its widest option is ページ全体), then with the − and + buttons; in the
    // narrowest focus mode it goes into the menu as a list of zoom levels.
    { id: "zoom", widths: [6 + 90, 6 + 24 + 90 + 24 + 2 * TOOLBAR_GAP] },
  ];
  // Normal view uses one dropdown, focus mode keeps the three direct buttons.
  items.push({ id: "panels", widths: focusMode
    ? [6 + 3 * 32 + 2 * TOOLBAR_GAP, 6 + 84 + 84 + 60 + 2 * TOOLBAR_GAP]
    : [6 + 100] });
  // The page count beside the page number; it takes whatever room is left, and this much at least.
  items.push({ id: "label", widths: [56] });
  if (hasOutline) items.push({ id: "outline", widths: [26, 26 + 4 + 24] });
  items.push({ id: "back", widths: [24] });
  if (focusMode) items.push({ id: "sticky", widths: [6 + 24] });
  // 移動 only repeats Enter in the page field, so it is the first to go and has no menu entry.
  items.push({ id: "go", widths: [42] });
  return items;
}

/** The 「…」 button, which stands outside the items' clipped area and so is always reachable. */
export const MORE_BUTTON_WIDTH = 24;

/**
 * Fits the reading toolbar into a row whose content box is `width` px wide, the 「…」 button at its
 * end included.
 */
export function fitReaderToolbar(width: number, options: Parameters<typeof readerToolbarItems>[0]): BarFit {
  return fitBar(readerToolbarItems(options), Math.max(0, width - MORE_BUTTON_WIDTH - TOOLBAR_GAP - TOOLBAR_SLACK), TOOLBAR_GAP);
}

/**
 * The pane whose writing toolbar is shown: the one last used, unless it has no page to write on
 * (a translation still pending, say) and the other one has.
 */
export function inkToolbarSide(
  active: "original" | "translated", hosts: Readonly<Record<"original" | "translated", boolean>>,
): "original" | "translated" | null {
  if (hosts[active]) return active;
  const other = active === "original" ? "translated" : "original";
  return hosts[other] ? other : null;
}

/**
 * Whether the writing toolbar is shown. While reading it is hidden unless opened; picking a writing
 * tool, or leaving the page list open, keeps it on screen, so that no tool is ever active unseen.
 */
export function inkToolbarOpen({ open, tool, listOpen }: { open: boolean; tool: string; listOpen: boolean }): boolean {
  return open || tool !== "select" || listOpen;
}

/**
 * How the writing toolbar starts when the app opens (設定「表示」の「書き込みバー」). Opening and closing
 * it with the 書き込み button works as always afterwards; "last" brings back how it was left.
 */
export type InkBarStart = "closed" | "open" | "last";

export const INK_BAR_STARTS: readonly { id: InkBarStart; label: string }[] = [
  { id: "closed", label: "閉じた状態で始める" },
  { id: "open", label: "開いた状態で始める" },
  { id: "last", label: "前回の状態を引き継ぐ" },
];

/** A saved choice, falling back to 閉じた状態 for anything this version does not know. */
export function inkBarStartOf(value: unknown): InkBarStart {
  return INK_BAR_STARTS.some((item) => item.id === value) ? value as InkBarStart : "closed";
}

/** Whether the writing toolbar is open at launch, given the choice and whether it was open when last saved. */
export function initialInkBarOpen(start: InkBarStart, savedOpen: unknown): boolean {
  return start === "open" || (start === "last" && savedOpen === true);
}
