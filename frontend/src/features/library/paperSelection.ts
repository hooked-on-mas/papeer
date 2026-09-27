/**
 * Selecting several papers in the library tree, apart from the open paper (the store's activePaperId)
 * and from the keyboard focus (treeFocus.ts). Pure, so that it can be tested; the sidebar keeps the
 * result in its selection store (selectionStore.ts).
 *
 * Until Ctrl, Shift or Ctrl+A selects papers, the tree has one selected row, as before: the chosen folder,
 * or else the open paper. From then on the selection is a set of papers (folders are not selected
 * with them), which may be empty, until a click or Enter opens a paper or chooses a folder, or Esc
 * clears it. Ctrl and Shift start from what was selected: the open paper, when it is on screen.
 *
 * Only papers on screen stay selected (see pruneSelection): what is done to the selection is done to
 * the papers the user sees highlighted, never to one hidden in a closed folder or by a filter.
 */
import { paperKey, type TreeRow } from "./treeKeys.ts";

export type PaperSelection = {
  /** The papers selected, by id; null while the tree has its one selected row instead. */
  ids: ReadonlySet<string> | null;
  /** The row a Shift range starts from (a row key, a folder's or a paper's); the row last clicked or toggled. */
  anchor: string | null;
};

export const NO_SELECTION: PaperSelection = { ids: null, anchor: null };

const paperRows = (rows: readonly TreeRow[]) => rows.filter((row) => row.kind === "paper");

/**
 * The papers selected, where the selection starts from: the set, or else the open paper `open` while
 * it is on screen (and no folder is chosen, which the caller passes as null).
 */
export function selectedPapers(selection: PaperSelection, rows: readonly TreeRow[], open: string | null): Set<string> {
  if (selection.ids) return new Set(selection.ids);
  return new Set(open !== null && rows.some((row) => row.kind === "paper" && row.id === open) ? [open] : []);
}

/** Ctrl+click and Ctrl+Space: the paper row `key` joins the selection, or leaves it; it becomes the anchor. */
export function toggleSelection(selection: PaperSelection, rows: readonly TreeRow[], key: string, open: string | null): PaperSelection {
  const row = rows.find((r) => r.key === key);
  if (!row || row.kind !== "paper") return selection;
  const ids = selectedPapers(selection, rows, open);
  if (ids.has(row.id)) ids.delete(row.id);
  else ids.add(row.id);
  return { ids, anchor: key };
}

/**
 * Shift+click, Shift+↑↓ and Shift+Space: the papers from the anchor to the row `key`, both included,
 * in the order on screen; folder rows between them are passed over. The anchor stays, so that the
 * range grows and shrinks from it. Until several papers are selected, Shift+↑↓ start from the row the
 * keys were on (`from`), since the arrows move the keys without selecting; otherwise, and for a click,
 * the anchor is the row last clicked or toggled, else the open paper, else `key` itself (each while it
 * is on screen). With `add` (Ctrl+Shift+click) the range is added to what was selected.
 */
export function selectRange(selection: PaperSelection, rows: readonly TreeRow[], key: string, open: string | null,
  { add = false, from }: { add?: boolean; from?: string } = {}): PaperSelection {
  const target = rows.findIndex((row) => row.key === key);
  if (target < 0) return selection;
  const onScreen = (candidate: string | null | undefined): candidate is string =>
    !!candidate && rows.some((row) => row.key === candidate);
  const openKey = open === null ? null : rows.find((row) => row.kind === "paper" && row.id === open)?.key ?? null;
  const candidates = selection.ids === null ? [from, selection.anchor, openKey] : [selection.anchor, from, openKey];
  const anchor = candidates.find(onScreen) ?? key;
  const start = rows.findIndex((row) => row.key === anchor);
  const [first, last] = start <= target ? [start, target] : [target, start];
  const ids = add ? selectedPapers(selection, rows, open) : new Set<string>();
  for (const row of paperRows(rows.slice(first, last + 1))) ids.add(row.id);
  return { ids, anchor };
}

/** Ctrl+A: every paper on screen. The anchor stays. */
export function selectAllPapers(selection: PaperSelection, rows: readonly TreeRow[]): PaperSelection {
  return { ids: new Set(paperRows(rows).map((row) => row.id)), anchor: selection.anchor };
}

/**
 * The selection once the rows on screen change: papers no longer on screen (deleted, in a folder just
 * closed, filtered out, or the search's results shown instead) leave it, and so does an anchor that
 * left; when none is left, the tree goes back to its one selected row. The same object when nothing
 * left, so that the rows, which select from it, do not render again.
 */
export function pruneSelection(selection: PaperSelection, rows: readonly TreeRow[]): PaperSelection {
  const keys = new Set(rows.map((row) => row.key));
  const anchor = selection.anchor !== null && !keys.has(selection.anchor) ? null : selection.anchor;
  let ids = selection.ids;
  if (ids && [...ids].some((id) => !keys.has(paperKey(id)))) {
    const left = [...ids].filter((id) => keys.has(paperKey(id)));
    ids = left.length ? new Set(left) : null;
  }
  return anchor === selection.anchor && ids === selection.ids ? selection : { ids, anchor };
}

/**
 * The row the keys go to once the rows `removed` (papers deleted together) are gone, so that the focus
 * does not fall out of the tree: the first row after `current` that stays, else the nearest above it.
 * As rowAfterRemoval (treeKeys.ts) for a single paper.
 */
export function rowAfterRemovingRows(rows: readonly TreeRow[], current: string, removed: ReadonlySet<string>): string | null {
  const index = rows.findIndex((row) => row.key === current);
  if (index < 0) return null;
  const after = rows.slice(index + 1).find((row) => !removed.has(row.key));
  const before = rows.slice(0, index).reverse().find((row) => !removed.has(row.key));
  return (after ?? before)?.key ?? null;
}

/** The selected papers in the order on screen, which is the order they are moved, tagged or deleted in. */
export function selectionInOrder(rows: readonly TreeRow[], ids: ReadonlySet<string>): string[] {
  return paperRows(rows).filter((row) => ids.has(row.id)).map((row) => row.id);
}

/**
 * The papers an action on the paper `id` applies to (its context menu, dragging it, Delete on it):
 * the whole selection when `id` is in a selection of several, else that paper alone.
 */
export function papersActedOn(selection: PaperSelection, rows: readonly TreeRow[], id: string): string[] {
  if (!selection.ids || selection.ids.size < 2 || !selection.ids.has(id)) return [id];
  return selectionInOrder(rows, selection.ids);
}
