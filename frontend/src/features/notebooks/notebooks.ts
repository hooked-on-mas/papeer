import { openEditLabels } from "@/lib/pendingSaves";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import type { components } from "@/api/schema";
import { QK } from "@/lib/queryKeys";
import { queryClient } from "@/lib/queryClient";
import { blockNotebookInk, flushNotebookInk, reconcileNotebookInk } from "@/features/reader/inkStore";
import { useStore } from "@/store";
import { create } from "zustand";

export type NotebookPaper = components["schemas"]["NotebookPaper"];
export type NotebookDocument = components["schemas"]["NotebookDocument"];
export type NotebookPage = components["schemas"]["NotebookPage"];
export type NotebookChange = components["schemas"]["NotebookChange"];
export const DEFAULT_PAPER = { size: "A4", orientation: "portrait", template: "ruled7", color: "white" } satisfies NotebookPaper;
export const PAPER_SIZES = ["A4", "B5", "A5", "Letter", "16:9"] as const;
export const PAPER_TEMPLATES = [
  ["blank", "無地"], ["ruled7", "横罫 7mm"], ["ruled6", "横罫 6mm"], ["ruled5", "横罫 5mm"],
  ["grid5", "方眼 5mm"], ["grid10", "方眼 10mm"], ["dot5", "ドット 5mm"], ["cornell", "コーネル"],
] as const;

export const useNotebookBusy = create<{ ids: string[] }>(() => ({ ids: [] }));
export function useNotebooks() {
  return useQuery({ queryKey: [QK.notebooks], queryFn: () => unwrap(api.GET("/api/notebooks")) });
}
/** Every document read is matched to the ink entries, so that a deletion whose reply was lost still settles them. */
export async function fetchNotebook(id: string, signal?: AbortSignal) {
  const document = await unwrap(api.GET("/api/notebooks/{notebook_id}", { params: { path: { notebook_id: id } }, signal }));
  reconcileNotebookInk(id, document);
  return document;
}
export function useNotebook(id: string | null, enabled: boolean) {
  return useQuery({ queryKey: [QK.notebook, id], enabled: !!id && enabled, queryFn: ({ signal }) => fetchNotebook(id!, signal) });
}

export async function changeNotebook(id: string, document: NotebookDocument, change: Omit<NotebookChange, "revision">) {
  if (useNotebookBusy.getState().ids.includes(id)) return;
  if (openEditLabels().length) throw new Error("編集中の付箋などを保存またはキャンセルしてからページを操作してください。");
  useNotebookBusy.setState(s => ({ ids: [...s.ids, id] }));
  blockNotebookInk(id, true);
  const selected = document.pages[useStore.getState().currentPage - 1]?.id;
  try {
    await flushNotebookInk(id, document);
    const after = await unwrap(api.POST("/api/notebooks/{notebook_id}/pages", {
      params: { path: { notebook_id: id } }, body: { ...change, revision: document.revision },
    }));
    await queryClient.cancelQueries({ queryKey: [QK.notebook, id] });
    reconcileNotebookInk(id, after);
    queryClient.setQueryData([QK.notebook, id], after);
    const added = after.pages.find(page => !document.pages.some(previous => previous.id === page.id));
    const target = added?.id ?? selected;
    const number = after.pages.findIndex(page => page.id === target) + 1;
    if (useStore.getState().activePaperId === id) useStore.getState().setCurrentPage(number || Math.min(useStore.getState().currentPage, after.pages.length));
    await Promise.all([QK.papers, QK.notebooks, QK.reading, QK.stickyNotes, QK.inkPages].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
  } catch (error) {
    // A lost reply can follow a committed operation. Confirm the server state before re-enabling ink.
    try {
      const current = await unwrap(api.GET("/api/notebooks/{notebook_id}", { params: { path: { notebook_id: id } } }));
      await queryClient.cancelQueries({ queryKey: [QK.notebook, id] });
      reconcileNotebookInk(id, current);
      queryClient.setQueryData([QK.notebook, id], current);
      if (useStore.getState().activePaperId === id) {
        const number = current.pages.findIndex(page => page.id === selected) + 1;
        useStore.getState().setCurrentPage(number || Math.min(useStore.getState().currentPage, current.pages.length));
      }
      await queryClient.invalidateQueries({ queryKey: [QK.reading, id] });
    } catch { /* Keep drafts and the last known document when the server is unavailable. */ }
    throw error;
  } finally {
    blockNotebookInk(id, false);
    useNotebookBusy.setState(s => ({ ids: s.ids.filter(value => value !== id) }));
  }
}
