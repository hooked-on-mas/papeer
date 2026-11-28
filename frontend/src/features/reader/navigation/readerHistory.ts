/**
 * Places to go back to with Alt+←: where the reader was before following a link, the table of
 * contents or a search result, as a browser keeps them. Plain page turns are not kept.
 */

export interface HistoryEntry {
  paperId: string;
  page: number;
  /** Where the view was on the page, as JumpTarget.anchor_y takes it. */
  anchor_y: number;
}

export interface ReaderHistory {
  back: HistoryEntry[];
  forward: HistoryEntry[];
}

export const EMPTY_HISTORY: ReaderHistory = { back: [], forward: [] };

export const HISTORY_LIMIT = 100;

/**
 * Remembers `here` before a jump. A jump opens a new branch, so what could be gone forward to is
 * dropped. The latest entry is replaced rather than repeated when it is on the same page.
 */
export function rememberPlace(history: ReaderHistory, here: HistoryEntry, limit = HISTORY_LIMIT): ReaderHistory {
  const last = history.back[history.back.length - 1];
  const back = last && last.paperId === here.paperId && last.page === here.page ? history.back.slice(0, -1) : history.back;
  return { back: [...back, here].slice(-limit), forward: [] };
}

function step(from: HistoryEntry[], to: HistoryEntry[], here: HistoryEntry | null, limit: number) {
  // Entries from another paper cannot be shown; the reader clears them when the paper changes.
  const usable = here ? from.filter((entry) => entry.paperId === here.paperId) : from;
  const target = usable[usable.length - 1];
  if (!target) return null;
  return { target, from: usable.slice(0, -1), to: here ? [...to, here].slice(-limit) : to };
}

/** Goes back to the latest remembered place, keeping `here` to go forward to again. */
export function goBack(history: ReaderHistory, here: HistoryEntry | null, limit = HISTORY_LIMIT): { history: ReaderHistory; target: HistoryEntry } | null {
  const result = step(history.back, history.forward, here, limit);
  return result && { target: result.target, history: { back: result.from, forward: result.to } };
}

/** Undoes goBack. */
export function goForward(history: ReaderHistory, here: HistoryEntry | null, limit = HISTORY_LIMIT): { history: ReaderHistory; target: HistoryEntry } | null {
  const result = step(history.forward, history.back, here, limit);
  return result && { target: result.target, history: { back: result.to, forward: result.from } };
}
