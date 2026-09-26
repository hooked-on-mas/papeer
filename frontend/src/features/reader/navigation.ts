import type { QueryClient } from "@tanstack/react-query";
import type { ReadingData } from "@/api/hooks";
import { useStore, ZOOM_PRESETS, type PassageLocation } from "@/store";
import { QK } from "@/lib/queryKeys";

let queryClient: QueryClient | null = null;

export function bindReaderQueryClient(client: QueryClient): void {
  queryClient = client;
}

function reading(): ReadingData | null | undefined {
  const id = useStore.getState().activePaperId;
  return id ? queryClient?.getQueryData<ReadingData>([QK.reading, id]) : null;
}

export function pageCount(): number {
  return reading()?.page_count ?? 0;
}

/** Step through all pages, or only translated ones when that filter is on. */
export function movePage(amount: number): void {
  const store = useStore.getState();
  if (!store.activePaperId) return;
  const data = reading();
  if (store.translatedOnly) {
    const pages = data?.completed_pages ?? [];
    if (!pages.length) return;
    const position = Math.max(0, pages.indexOf(store.currentPage));
    store.setCurrentPage(pages[Math.max(0, Math.min(position + amount, pages.length - 1))]);
  } else {
    const count = data?.page_count || store.currentPage;
    store.setCurrentPage(Math.max(1, Math.min(store.currentPage + amount, count)));
  }
}

/** Page input and Ctrl+G jump to any page, so they switch back to 全ページ. */
export function jumpToPage(page: number): void {
  const store = useStore.getState();
  if (!store.activePaperId || !Number.isFinite(page)) return;
  const count = pageCount() || page;
  store.setTranslatedOnly(false);
  store.setCurrentPage(Math.max(1, Math.min(Math.round(page), count)));
  store.setActiveTab("reader");
}

/** Opens the reader at a passage attached to the chat, with the passage selected. */
export function showPassage(paperId: string, passage: PassageLocation): void {
  const store = useStore.getState();
  if (store.activePaperId !== paperId) return;
  if (store.translatedOnly && !(reading()?.completed_pages ?? []).includes(passage.page)) store.setTranslatedOnly(false);
  store.setCurrentPage(passage.page);
  store.setReaderJump({ ...passage, paperId });
  store.setActiveTab("reader");
}

export function changeZoom(steps: number): void {
  const { zoom, setZoom } = useStore.getState();
  const index = ZOOM_PRESETS.reduce((best, value, i) =>
    Math.abs(value - zoom) < Math.abs(ZOOM_PRESETS[best] - zoom) ? i : best, 0);
  setZoom(ZOOM_PRESETS[Math.max(0, Math.min(index + steps, ZOOM_PRESETS.length - 1))]);
}

export function focusPageInput(): void {
  const store = useStore.getState();
  if (!store.activePaperId) return;
  store.setActiveTab("reader");
  setTimeout(() => {
    const input = document.getElementById("page-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }, 50);
}
