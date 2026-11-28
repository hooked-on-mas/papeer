import type { PaperData } from "@/api/hooks";

/**
 * The orders of the library list, by their number in GET /api/papers?sort= (LibrarySort in
 * papeer/core/library_list.py, which refuses any other number). Only ever appended to: the number is
 * saved in ui-state.json, and a version that does not know it shows the newest first (librarySortOrder).
 */
export const SORT_LABELS = [
  "追加が新しい順", "追加が古い順", "名前順（昇順）", "名前順（降順）", "出版年が新しい順", "筆頭著者順", "最近開いた順",
];

/** The orders by name (LibrarySort.TITLE and TITLE_DESCENDING). */
export const TITLE_ORDERS: ReadonlySet<number> = new Set([2, 3]);

/** Last opened on this PC first (LibrarySort.RECENT). */
export const RECENT_ORDER = 6;

/**
 * The row values each order places a paper by, besides when it was added (which never changes): a
 * change of one of them may move the paper's row in that order (paperRows.ts, withPaperRow).
 */
const ORDER_FIELDS: ReadonlyMap<number, readonly (keyof PaperData)[]> = new Map([
  [2, ["title"]],
  [3, ["title"]],
  [4, ["publication_year"]],
  [5, ["first_author", "title"]],
  [RECENT_ORDER, ["last_opened_at"]],
]);

export function orderFields(order: number): readonly (keyof PaperData)[] {
  return ORDER_FIELDS.get(order) ?? [];
}

/**
 * A saved order (ui-state.json's sort) as one the library offers; anything else is the default (0).
 * The file comes along with backups and syncs, perhaps from another version of Papeer, and an order the
 * sidecar refuses would leave the library looking empty.
 */
export function librarySortOrder(value: unknown): number {
  const order = Number(value);
  return Number.isInteger(order) && SORT_LABELS[order] !== undefined ? order : 0;
}
