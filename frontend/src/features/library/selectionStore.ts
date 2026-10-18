/**
 * The papers selected in the library tree (see paperSelection.ts), kept apart from the app's store: it
 * is not saved, and each row selects whether it is selected, so that a change renders the rows it
 * changes only.
 */
import { create } from "zustand";
import { useStore } from "@/store";
import { NO_SELECTION, type PaperSelection } from "./paperSelection";
import { useTreeFocus } from "./treeFocus";
import { paperKey, type TreeRow } from "./treeKeys";

export const usePaperSelection = create<PaperSelection>(() => NO_SELECTION);

/** The open paper, which Ctrl and Shift start the selection from; none while a folder is chosen. */
export function openPaperId(): string | null {
  const { activePaperId, selectedFolder } = useStore.getState();
  return selectedFolder === null ? activePaperId : null;
}

/** Applies `change` to the selection, with the rows on screen and the open paper. */
export function changeSelection(change: (selection: PaperSelection, rows: TreeRow[], open: string | null) => PaperSelection): void {
  const next = change(usePaperSelection.getState(), useTreeFocus.getState().rows, openPaperId());
  if (next !== usePaperSelection.getState()) usePaperSelection.setState(next, true);
}

/** Back to the tree's one selected row, with `anchor` (the row just clicked) to start a Shift range from. */
export function clearSelection(anchor: string | null = null): void {
  const current = usePaperSelection.getState();
  if (current.ids !== null || current.anchor !== anchor) usePaperSelection.setState({ ids: null, anchor }, true);
}

/**
 * Opens a paper as choosing its row in the library does (a click, Enter, 続きから読む): that ends
 * selecting several papers, and the folder it is in becomes the one new PDFs go into.
 */
export function openPaper(paperId: string, collection: string): void {
  clearSelection(paperKey(paperId));
  const store = useStore.getState();
  store.setSelectedFolder(null);
  store.setCurrentCollection(collection);
  if (store.activePaperId !== paperId) store.setActivePaperId(paperId);
}
