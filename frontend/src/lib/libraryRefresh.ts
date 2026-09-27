import type { PaperChangeEffects } from "./paperRows.ts";

/**
 * When the library is reloaded after the sidecar says it changed (the library.changed event, sent for
 * edits, moves, deletions and syncs; paper.changed for a change of one paper): not on each event, which
 * an action on several papers sends once per paper, each reload fetching the whole list again (or, for
 * paper.changed, the paper and the library's search), but once they stop coming for a moment, or, while
 * they keep coming, every few seconds (trailing debounce with a longest wait). The papers changed
 * meanwhile are reloaded together, row by row, or, when there are many, with the lists as a whole.
 *
 * While an action on several papers runs, it holds the reloads (holdLibraryRefresh): a reload halfway
 * would fetch the list, or each paper's row, once per paper, and show the papers moved so far where they
 * went, in a folder that may be closed, so that they would leave the selection the action works on. The
 * holder reloads the library itself once it is done, so the events it held are dropped when the last
 * hold is released (and paper.changed events coming while held are not kept at all).
 */

export type RefreshTimers = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

/** The papers changed since the last reload (RefreshGate.paperChanged). */
export type PaperChanges = {
  /** The papers whose rows to load again, or "all" when there are more than PAPER_ROWS_LIMIT: the lists are loaded again instead. */
  rows: string[] | "all";
  collections: boolean;
  tags: boolean;
};

export type RefreshGate = {
  /** The library changed: run `refresh` later, once, with the latest `refresh` asked for. */
  request: (refresh: () => void) => void;
  /**
   * One paper changed (`effects`, paperRows.paperChangeEffects): run `flush` later, once, with the latest
   * `flush` asked for and every paper changed until then. Not when a `refresh` is due as well, which
   * reloads all of it; nor while held.
   */
  paperChanged: (paperId: string, effects: PaperChangeEffects, flush: (changes: PaperChanges) => void) => void;
  /** Hold the reloads until the returned function is called (once; further calls do nothing). */
  hold: () => () => void;
};

export const REFRESH_DELAY_MS = 400;
export const REFRESH_MAX_WAIT_MS = 3000;
/** More changed papers than this are reloaded with the lists as a whole, rather than a request for each. */
export const PAPER_ROWS_LIMIT = 10;

export function createRefreshGate(timers: RefreshTimers, delay = REFRESH_DELAY_MS, maxWait = REFRESH_MAX_WAIT_MS,
  rowsLimit = PAPER_ROWS_LIMIT): RefreshGate {
  let holds = 0;
  let refresh: (() => void) | null = null;
  let flush: ((changes: PaperChanges) => void) | null = null;
  let rows = new Set<string>();
  let collections = false;
  let tags = false;
  let firstAt = 0;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const clear = () => {
    refresh = null;
    flush = null;
    rows = new Set();
    collections = false;
    tags = false;
  };
  const fire = () => {
    timer = null;
    const [runRefresh, runFlush] = [refresh, flush];
    const changes: PaperChanges = { rows: rows.size > rowsLimit ? "all" : [...rows], collections, tags };
    clear();
    // Reloading the whole library covers the papers changed too.
    if (runRefresh) runRefresh();
    else runFlush?.(changes);
  };
  const schedule = () => {
    cancel();
    const wait = Math.max(0, Math.min(delay, firstAt + maxWait - timers.now()));
    timer = timers.setTimeout(fire, wait);
  };
  const due = () => refresh !== null || flush !== null;
  return {
    request(next) {
      if (!due()) firstAt = timers.now();
      refresh = next;
      if (holds === 0) schedule();
    },
    paperChanged(paperId, effects, next) {
      // The holder's own reload covers it.
      if (holds > 0) return;
      if (!due()) firstAt = timers.now();
      flush = next;
      if (effects.row) rows.add(paperId);
      collections ||= effects.collections;
      tags ||= effects.tags;
      schedule();
    },
    hold() {
      holds++;
      cancel();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        // The holder reloads the library itself, which covers what was held.
        if (holds === 0) clear();
      };
    },
  };
}

const gate = createRefreshGate({
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

/** See RefreshGate.request; for the library.changed event (jobEvents.ts). */
export const requestLibraryRefresh = gate.request;

/** See RefreshGate.paperChanged; for the paper.changed event (jobs/paperRefresh.ts). */
export const requestPaperRefresh = gate.paperChanged;

/** See RefreshGate.hold; for actions on several papers (app/bulkState.ts), which reload the library themselves when done. */
export const holdLibraryRefresh = gate.hold;
