import { openEditLabels } from "@/lib/pendingSaves";
import { useQuery } from "@tanstack/react-query";
import { api, apiRequest, unwrap } from "@/api/client";
import type { components } from "@/api/schema";
import { QK } from "@/lib/queryKeys";
import { queryClient } from "@/lib/queryClient";
import { loadDesktopNotebookSession } from '../../adapters/desktop/notebookSessions';
import type { NoteDocument } from '../../runtime/noteDocuments';
import { changeNotebookPaper } from '../notes/notebookPaper';
import { useStore } from "@/store";
import { create } from "zustand";

export type NotebookDocument = components["schemas"]["NotebookDocument"];
export type NotebookPage = components["schemas"]["NotebookPage"];
export type NotebookChange = components["schemas"]["NotebookChange"];
export { DEFAULT_PAPER, PAPER_SIZES, PAPER_TEMPLATES, type NotebookPaper } from "./paperSpec.ts";

export const useNotebookBusy = create<{ ids: string[] }>(() => ({ ids: [] }));
export function useNotebooks() {
  return useQuery({ queryKey: [QK.notebooks], queryFn: () => unwrap(api.GET("/api/notebooks")) });
}
export async function fetchNotebook(id: string, signal?: AbortSignal) {
  const document = await unwrap(api.GET("/api/notebooks/{notebook_id}", { params: { path: { notebook_id: id } }, signal }));
  return document;
}
export function useNotebook(id: string | null, enabled: boolean) {
  return useQuery({ queryKey: [QK.notebook, id], enabled: !!id && enabled, queryFn: ({ signal }) => fetchNotebook(id!, signal) });
}

export async function changeNotebook(id: string, document: NotebookDocument, change: Omit<NotebookChange, "revision">, fitPaper = false) {
  if (useNotebookBusy.getState().ids.includes(id)) return;
  if (openEditLabels().length) throw new Error("編集中の付箋などを保存またはキャンセルしてからページを操作してください。");
  useNotebookBusy.setState(s => ({ ids: [...s.ids, id] }));
  const selected = document.pages[useStore.getState().currentPage - 1]?.id;
  try {
    const session = await loadDesktopNotebookSession(id);
    if (change.action === 'paper') {
      session.editDocument(current => changeNotebookPaper(current, change.page_id!, change.spec!, fitPaper));
      await session.flush();
    } else await session.changeDocument(async current => {
      try {
        await unwrap(api.POST("/api/notebooks/{notebook_id}/pages", {
          params: { path: { notebook_id: id } }, body: { ...change, revision: current.document!.revision },
        }));
      } catch (error) {
        // Reconcile a committed operation whose reply was lost before allowing either view to edit.
        session.receive(await apiRequest<NoteDocument>('GET', `/api/notes/${id}/document`)); throw error;
      }
      return apiRequest<NoteDocument>('GET', `/api/notes/${id}/document`);
    });
    const after = session.getSnapshot().note.document!;
    await queryClient.cancelQueries({ queryKey: [QK.notebook, id] });
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
      queryClient.setQueryData([QK.notebook, id], current);
      if (useStore.getState().activePaperId === id) {
        const number = current.pages.findIndex(page => page.id === selected) + 1;
        useStore.getState().setCurrentPage(number || Math.min(useStore.getState().currentPage, current.pages.length));
      }
      await queryClient.invalidateQueries({ queryKey: [QK.reading, id] });
    } catch { /* Keep drafts and the last known document when the server is unavailable. */ }
    throw error;
  } finally {
    useNotebookBusy.setState(s => ({ ids: s.ids.filter(value => value !== id) }));
  }
}
