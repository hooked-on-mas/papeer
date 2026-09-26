import { create } from "zustand";
import { askConfirm } from "@/components/AppDialogs";
import type { StickyDraft, StickyFilters, StickyNote } from "./stickyNotes";

type State = {
  draft: StickyDraft | null; dirty: boolean; busy: boolean; selectedId: number | null;
  filters: StickyFilters; scrollTop: number; deleted: StickyNote[];
};
// Session state survives paper/page/tab changes, including an unfinished note.
export const useStickyNotes = create<State>(() => ({
  draft: null, dirty: false, busy: false, selectedId: null,
  filters: { scope: "paper", query: "", label: "", side: "", sort: "page" }, scrollTop: 0, deleted: [],
}));
let switching = false;
export async function openStickyNote(draft: StickyDraft | null): Promise<void> {
  const state = useStickyNotes.getState();
  if (state.busy || switching) return;
  if (draft?.id && draft.id === state.draft?.id) return;
  switching = true;
  try {
    if (state.dirty && !await askConfirm("編集中の付箋", "保存していない変更を破棄しますか？", "破棄する", true)) return;
    useStickyNotes.setState({ draft, dirty: false, ...(draft ? { selectedId: draft.id ?? null } : {}) });
  } finally { switching = false; }
}
