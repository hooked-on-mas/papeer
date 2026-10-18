import type { PaperData, ReadingData } from "@/api/hooks";
import { useStore, type PassageLocation } from "@/store";
import { QK } from "@/lib/queryKeys";
import { itemCapabilities, type ItemCapabilities } from "@/lib/itemKinds";
import { queryClient } from "@/lib/queryClient";
import { showReaderOf } from "@/features/documents/documentState";
import { edgePage, steppedPage } from "./pageTurn";
import { goBack, goForward, rememberPlace, type HistoryEntry } from "./readerHistory";
import { summaryPlacement } from "./sidePanel";
import { stepZoom, ZOOM_FIT_PAGE } from "./zoomLevels";

function reading(): ReadingData | null | undefined {
  const id = useStore.getState().activePaperId;
  return id ? queryClient.getQueryData<ReadingData>([QK.reading, id]) : null;
}

/**
 * Whether the 翻訳済みページのみ filter applies to the open item: not to one that is not translated
 * (a notebook), whose pages are all there is, and which leaves the filter as it is set for the papers.
 */
function translatedOnlyFilter(): boolean {
  const { translatedOnly, activePaperId } = useStore.getState();
  if (!translatedOnly || !activePaperId) return false;
  return activeItemCapabilities().translate;
}

/**
 * What the open item can do, read when called (not from a render): for an event handler that runs in
 * the tick the open item changed in, before any screen has rendered with the new one. An item whose
 * row is not loaded is taken to be a PDF, as in useItemCapabilities.
 */
export function activeItemCapabilities(): ItemCapabilities {
  const { activePaperId } = useStore.getState();
  return itemCapabilities(activePaperId ? queryClient.getQueryData<PaperData | null>([QK.papers, activePaperId]) : null);
}

export function pageCount(): number {
  return reading()?.page_count ?? 0;
}

function pageState() {
  const store = useStore.getState();
  const data = reading();
  return { current: store.currentPage, pageCount: data?.page_count ?? 0, translatedOnly: translatedOnlyFilter(), completed: data?.completed_pages ?? [] };
}

/**
 * Opens `page`, at its start, or at its end with `toEnd` (paging back from the page after it). Asking for
 * a page brings the reader back from the paper's enlarged document, also when the page is the one already
 * set (Home at the first page, → at the last): the request is to read the PDF there.
 */
function openPage(page: number, toEnd = false): void {
  const store = useStore.getState();
  if (!store.activePaperId || !Number.isFinite(page)) return;
  showReaderOf(store.activePaperId);
  if (page === store.currentPage) return;
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
  if (translatedOnlyFilter() && !(reading()?.completed_pages ?? []).includes(page)) store.setTranslatedOnly(false);
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
  if (translatedOnlyFilter()) store.setTranslatedOnly(false);
  showReaderOf(store.activePaperId);
  store.setCurrentPage(Math.max(1, Math.min(Math.round(page), count)));
  store.setActiveTab("reader");
}

/** Opens the reader at a passage attached to the chat, with the passage selected. */
export function showPassage(paperId: string, passage: PassageLocation): void {
  const store = useStore.getState();
  if (store.activePaperId !== paperId) return;
  if (translatedOnlyFilter() && !(reading()?.completed_pages ?? []).includes(passage.page)) store.setTranslatedOnly(false);
  store.setCurrentPage(passage.page);
  store.setReaderJump({ ...passage, paperId });
  store.setActiveTab("reader");
}

/** Shows the open paper's 解説, beside the PDF when the side panel is open there (see summaryPlacement). */
export function showSummary(): void {
  const store = useStore.getState();
  const place = summaryPlacement(store);
  if (place === "panel") store.openSidePanel("summary");
  else if (place === "tab") store.setActiveTab("summary");
}

/** Whose zoom is meant: the PDF's (both panes), or the notebook's paper, which has a zoom of its own. */
export type ZoomSubject = "pdf" | "notebook";

/** The zoom of the open item's kind: a notebook zooms apart from the PDFs. */
export function activeZoomSubject(): ZoomSubject {
  return activeItemCapabilities().notebook ? "notebook" : "pdf";
}

export function zoomOf(subject: ZoomSubject): number {
  const { zoom, notebookZoom } = useStore.getState();
  return subject === "notebook" ? notebookZoom : zoom;
}

export function setZoomOf(subject: ZoomSubject, level: number): void {
  const { setZoom, setNotebookZoom } = useStore.getState();
  (subject === "notebook" ? setNotebookZoom : setZoom)(level);
}

/** Steps through the zoom levels, 「ページ全体」 below 「幅に合わせる」. */
export function changeZoom(steps: number, subject: ZoomSubject = activeZoomSubject()): void {
  setZoomOf(subject, stepZoom(zoomOf(subject), steps));
}

/** Ctrl+0: the PDF's 「幅に合わせる」, or the notebook's own start, 「ページ全体」. */
export function resetZoom(subject: ZoomSubject = activeZoomSubject()): void {
  setZoomOf(subject, subject === "notebook" ? ZOOM_FIT_PAGE : 1);
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
