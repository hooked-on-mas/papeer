/**
 * The library tree's keyboard focus, apart from the selection in the app's store: the rows on screen,
 * the row the keys act on, and the one row that takes the Tab key (roving tabindex). Each row selects
 * whether it is that row, so that moving the focus renders the two rows it leaves and enters only.
 */
import { create } from "zustand";
import { useStore } from "@/store";
import { resolveTabStop, selectedRowKey, type TreeRow } from "./treeKeys";

/** A row to focus once it is on screen: after its folder opens, or after the paper moved to `folder`. */
type PendingFocus = { key: string; folder?: string; until: number };

type TreeFocusState = {
  rows: TreeRow[];
  /** The row last focused, which keeps the Tab key while it is on screen. */
  focused: string | null;
  /** The selected row: the chosen folder, or else the open paper. */
  selected: string | null;
  /** The row with tabIndex 0; see resolveTabStop. */
  tabStop: string | null;
  pending: PendingFocus | null;
};

export const useTreeFocus = create<TreeFocusState>(() => ({
  rows: [], focused: null, selected: selectedRowKey(useStore.getState()), tabStop: null, pending: null,
}));

export function updateTreeFocus(change: Partial<Pick<TreeFocusState, "rows" | "focused" | "selected">>): void {
  const next = { ...useTreeFocus.getState(), ...change };
  const tabStop = resolveTabStop(next.rows, next.focused, next.selected);
  useTreeFocus.setState({ ...change, tabStop });
}

/**
 * Focus the row `key` when it is on screen, now or within a few seconds (a folder opening, the library
 * reloading after a move); with `folder`, only where it shows in that folder.
 */
export function requestTreeFocus(key: string, folder?: string): void {
  useTreeFocus.setState({ pending: { key, folder, until: Date.now() + 3000 } });
}

/** Called by the row a focus was requested for, once it is on screen: whether it should take it. */
export function takeTreeFocus(): boolean {
  const { pending } = useTreeFocus.getState();
  useTreeFocus.setState({ pending: null });
  return !!pending && Date.now() <= pending.until;
}


// The focus follows the selection when it changes, from the tree or elsewhere (a search result, a
// citation, a paper just added), so that Ctrl+L and Tab come back to it; moving the focus with the
// keys leaves the selection as it is. Kept while the sidebar is hidden, too.
useStore.subscribe((state, previous) => {
  const key = selectedRowKey(state);
  if (key !== selectedRowKey(previous)) updateTreeFocus({ selected: key, focused: key });
});
