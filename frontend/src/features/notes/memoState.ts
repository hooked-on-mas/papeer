import { create, useStore as useZustandStore } from "zustand";
import { api, unwrap } from "@/api/client";
import { memoPath, type MemoContent } from "@/api/attachments";
import { registerHeldDrafts, registerPendingSaves } from "@/lib/pendingSaves";
import { useStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { QK } from "@/lib/queryKeys";
import { createMemoDrafts } from "./memoDrafts";
import { showMemos } from "@/features/documents/documentState";

const drafts = createMemoDrafts({
  patch: async (owner, id, content) => {
    const memo = await unwrap(api.PATCH("/api/papers/{paper_id}/attachments/{attachment_id}", {
      params: { path: memoPath(owner, id) }, body: { content } }));
    if (!("content" in memo)) throw new Error("メモの保存結果を読み込めませんでした。");
    return memo;
  },
  saved: memo => queryClient.setQueryData([QK.memo, memo.owner_id, memo.id], memo),
});
/** The drafts as a hook (`useMemoDrafts(s => s.drafts[id])`), with `getState` for code outside React. */
export const useMemoDrafts = Object.assign(
  <T,>(select: (state: ReturnType<typeof drafts.store.getState>) => T) => useZustandStore(drafts.store, select),
  { getState: drafts.store.getState });
export const useMemoSelection = create<{ selected: Record<string, string>; expanded: string[] }>(() => ({ selected: {}, expanded: [] }));
export const selectMemo = (owner: string, id: string) => useMemoSelection.setState(s => ({ selected: { ...s.selected, [owner]: id } }));
export const expandMemoOwner = (owner: string, open: boolean) => useMemoSelection.setState(s => ({ expanded: open
  ? [...new Set([...s.expanded, owner])] : s.expanded.filter(id => id !== owner) }));
export function openMemo(owner: string, id?: string) {
  showMemos(owner);
  if (id) selectMemo(owner, id);
  const state = useStore.getState();
  state.setActivePaperId(owner);
  state.setSelectedFolder(null);
  state.setActiveTab("reader");
  state.setSidePanel("notes");
}

export const hydrateMemo = (memo: MemoContent) => drafts.hydrate(memo);
export const changeMemo = (id: string, text: string) => drafts.change(id, text);
export const forgetMemo = (id: string) => drafts.forget(id);
/** Serialized per attachment. Unmounted dirty drafts stay registered and retryable. */
export const saveMemo = (id: string) => drafts.save(id);

registerPendingSaves(async () => {
  const results = await Promise.allSettled(Object.keys(drafts.store.getState().drafts).map(saveMemo));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}, "メモを保存できませんでした。内容を確認してください。");
registerHeldDrafts({
  describe: () => [],
  discard: () => { for (const id of Object.keys(drafts.store.getState().drafts)) forgetMemo(id); },
  forget: owners => {
    const removed = new Set(owners);
    for (const [id, draft] of Object.entries(drafts.store.getState().drafts)) if (removed.has(draft.owner)) forgetMemo(id);
  },
});
