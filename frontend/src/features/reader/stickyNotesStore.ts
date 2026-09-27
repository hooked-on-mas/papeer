import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { askConfirm } from "@/components/AppDialogs";
import { QK } from "@/lib/queryKeys";
import type { StickyDraft, StickyFilters, StickyNote } from "./stickyNotes";
import type { HighlightColor, PageRect } from "./highlights";

type State = {
  draft: StickyDraft | null; dirty: boolean; busy: boolean; selectedId: number | null;
  filters: StickyFilters; scrollTop: number; deleted: StickyNote[];
  /** The colour last used to highlight, offered first next time (this session). */
  highlightColor: HighlightColor;
};
// Session state survives paper/page/tab changes, including an unfinished note.
export const useStickyNotes = create<State>(() => ({
  draft: null, dirty: false, busy: false, selectedId: null,
  filters: { scope: "paper", query: "", label: "", side: "", sort: "page", kind: "" }, scrollTop: 0, deleted: [],
  highlightColor: "yellow",
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
export const refreshStickyNotes = (client: QueryClient) => Promise.all([
  client.invalidateQueries({ queryKey: [QK.stickyNotes] }), client.invalidateQueries({ queryKey: [QK.librarySearch] }),
]);
/** Deletes a note and keeps it for undo. Resolves false when another save or delete is running. */
export async function deleteStickyNote(item: StickyNote, client: QueryClient): Promise<boolean> {
  if (useStickyNotes.getState().busy) return false;
  useStickyNotes.setState({ busy: true });
  try {
    await apiRequest("DELETE", `/api/papers/${item.paper_id}/sticky-notes/${item.id}`);
    useStickyNotes.setState(s => ({ deleted: [...s.deleted, item], selectedId: s.selectedId === item.id ? null : s.selectedId,
      ...(s.draft?.id === item.id ? { draft: null, dirty: false } : {}) }));
    await refreshStickyNotes(client);
    return true;
  } finally { useStickyNotes.setState({ busy: false }); }
}

/** A passage highlighted from a selection; see highlights.ts. */
export interface HighlightPassage {
  paperId: string; page: number; side: "original" | "translated"; text: string; rects: PageRect[];
}
/** Saves a highlight right away, without a dialog (it can be given a memo later). */
export async function addHighlight(passage: HighlightPassage, color: HighlightColor, client: QueryClient): Promise<StickyNote> {
  const [x, y] = passage.rects[0];
  const saved = await apiRequest<StickyNote>("POST", `/api/papers/${passage.paperId}/sticky-notes`, {
    page: passage.page, side: passage.side, quote: passage.text, label: "", note: "",
    kind: "highlight", color, rects: passage.rects, anchor_x: x, anchor_y: y,
  });
  useStickyNotes.setState({ highlightColor: color, selectedId: saved.id });
  await refreshStickyNotes(client);
  return saved;
}
export async function recolorHighlight(item: StickyNote, color: HighlightColor, client: QueryClient): Promise<void> {
  // The colour alone: the label and memo stay as they are on the sidecar.
  const saved = await apiRequest<StickyNote>("PATCH", `/api/papers/${item.paper_id}/sticky-notes/${item.id}`, { color });
  useStickyNotes.setState({ highlightColor: color });
  client.setQueriesData<StickyNote[]>({ queryKey: [QK.stickyNotes] }, notes => notes?.map(note => note.id === saved.id ? { ...note, ...saved } : note));
  await refreshStickyNotes(client);
}
