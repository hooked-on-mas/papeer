/**
 * The orders of the library list, by their number in GET /api/papers?sort= (LibrarySort in
 * papeer/core/library_list.py, which refuses any other number).
 */
export const SORT_LABELS = ["追加が新しい順", "追加が古い順", "名前順（昇順）", "名前順（降順）"];

/** The orders by name (LibrarySort.TITLE and TITLE_DESCENDING). */
export const TITLE_ORDERS: ReadonlySet<number> = new Set([2, 3]);

/**
 * A saved order (ui-state.json's sort) as one the library offers; anything else is the default (0).
 * The file comes along with backups and syncs, perhaps from another version of Papeer, and an order the
 * sidecar refuses would leave the library looking empty.
 */
export function librarySortOrder(value: unknown): number {
  const order = Number(value);
  return Number.isInteger(order) && SORT_LABELS[order] !== undefined ? order : 0;
}
