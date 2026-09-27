import type { QueryClient } from "@tanstack/react-query";
import type { ReadingData } from "@/api/hooks";
import { useStore, type PassageLocation } from "@/store";
import { QK } from "@/lib/queryKeys";
import { edgePage, steppedPage } from "./pageTurn";
import { goBack, goForward, rememberPlace, type HistoryEntry } from "./readerHistory";
import { stepZoom } from "./zoomLevels";

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

function pageState() {
  const store = useStore.getState();
  const data = reading();
  return { current: store.currentPage, pageCount: data?.page_count ?? 0, translatedOnly: store.translatedOnly, completed: data?.completed_pages ?? [] };
}

/** Opens `page`, at its start, or at its end with `toEnd` (paging back from the page after it). */
function openPage(page: number, toEnd = false): void {
  const store = useStore.getState();
  if (!store.activePaperId || page === store.currentPage) return;
  store.setCurrentPage(page);
  if (toEnd) store.setReaderJump({ paperId: store.activePaperId, page, side: "original", text: "", anchor_y: 1, toEnd: true });
}

/** Step through all pages, or only translated ones when that filter is on. */
export function movePage(amount: number, options: { toEnd?: boolean } = {}): void {
  if (!useStore.getState().activePaperId) return;
  openPage(steppedPage({ ...pageState(), amount }), options.toEnd);
}

/** Home and End: the first or last page, within the 翻訳済みページのみ filter when it is on. */
export function moveToEdgePage(edge: "first" | "last"): void {
  if (!useStore.getState().activePaperId) return;
  openPage(edgePage(edge, pageState()));
}

// Where the reader's view is on its page, read from the panes by the mounted reader.
let readViewport: (() => number | null) | null = null;

/** Lets the reader report where its view is, so that a jump can remember the place it leaves. */
export function bindReaderViewport(read: () => number | null): () => void {
  readViewport = read;
  return () => { if (readViewport === read) readViewport = null; };
}

function currentPlace(): HistoryEntry | null {
  const store = useStore.getState();
  if (!store.activePaperId) return null;
  return { paperId: store.activePaperId, page: store.currentPage, anchor_y: readViewport?.() ?? 0 };
}

/**
 * Opens a place in the paper from a link, the table of contents or a search result, remembering
 * the place it leaves so that Alt+← comes back. A jump within the page is not remembered.
 */
export function navigateTo(target: { page: number; anchor_y?: number; side?: "original" | "translated" }, remember = true): void {
  const store = useStore.getState();
  const paperId = store.activePaperId;
  if (!paperId || !Number.isFinite(target.page)) return;
  const count = pageCount() || target.page;
  const page = Math.max(1, Math.min(Math.round(target.page), count));
  if (remember && page !== store.currentPage) {
    const here = currentPlace();
    if (here) store.setReaderHistory(rememberPlace(store.readerHistory, here));
  }
  if (store.translatedOnly && !(reading()?.completed_pages ?? []).includes(page)) store.setTranslatedOnly(false);
  store.setCurrentPage(page);
  store.setReaderJump({ paperId, page, side: target.side ?? "original", text: "", anchor_y: target.anchor_y ?? 0 });
  store.setActiveTab("reader");
}

/** Alt+←: back to where the last link, contents or search jump left from. */
export function historyBack(): void {
  const store = useStore.getState();
  const result = goBack(store.readerHistory, currentPlace());
  if (!result) return;
  store.setReaderHistory(result.history);
  navigateTo(result.target, false);
}

/** Alt+→: undoes historyBack. */
export function historyForward(): void {
  const store = useStore.getState();
  const result = goForward(store.readerHistory, currentPlace());
  if (!result) return;
  store.setReaderHistory(result.history);
  navigateTo(result.target, false);
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

/** Steps through the zoom levels, 「ページ全体」 below 「幅に合わせる」. */
export function changeZoom(steps: number): void {
  const { zoom, setZoom } = useStore.getState();
  setZoom(stepZoom(zoom, steps));
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
