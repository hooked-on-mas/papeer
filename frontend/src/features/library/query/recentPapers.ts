import type { PaperData } from "@/api/hooks";

/**
 * Papers opened on this PC, for 続きから読む and the library's 最近開いた順 (the sidecar keeps the times:
 * papeer/core/opened_papers.py). A paper counts as opened once it has stayed open for OPENED_AFTER_MS,
 * so that clicking through the library does not mark every paper passed on the way as 読書中.
 */
export const OPENED_AFTER_MS = 1000;

/**
 * Calls `send` with a paper once it has been the open one for `delay` ms; returns the function to call
 * with the open paper (null for none) whenever it may have changed. Calling it with the same paper again
 * changes nothing, so page turns and other changes of the store do not count as opening it again.
 */
export function createOpenTracker(send: (paperId: string) => void, delay = OPENED_AFTER_MS): (paperId: string | null) => void {
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (paperId) => {
    if (paperId === current) return;
    current = paperId;
    clearTimeout(timer);
    if (paperId) timer = setTimeout(() => send(paperId), delay);
  };
}

/** The papers opened on this PC, the last opened first, at most `limit`. */
export function recentlyOpened(papers: readonly PaperData[], limit: number): PaperData[] {
  return papers.filter((paper) => !!paper.last_opened_at)
    .sort((a, b) => (a.last_opened_at! < b.last_opened_at! ? 1 : a.last_opened_at! > b.last_opened_at! ? -1 : 0))
    .slice(0, limit);
}

/** When a paper was opened, as the list says it: たった今, 5分前, 3時間前, 2日前, or the date after a week. */
export function openedAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}時間前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}日前`;
  const date = new Date(at);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
