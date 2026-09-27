/**
 * When the library is reloaded after the sidecar says it changed (the library.changed event, sent for
 * every edit, move, deletion or sync): not on each event, which an action on several papers sends once
 * per paper, each reload fetching the whole list again, but once they stop coming for a moment, or,
 * while they keep coming, every few seconds (trailing debounce with a longest wait).
 *
 * While an action on several papers runs, it holds the reloads (holdLibraryRefresh): a reload halfway
 * would fetch the list once per paper, and show the papers moved so far where they went, in a folder
 * that may be closed, so that they would leave the selection the action works on. The holder reloads
 * the library itself once it is done, so the events it held are dropped when the last hold is released.
 */

export type RefreshTimers = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

export type RefreshGate = {
  /** The library changed: run `refresh` later, once, with the latest `refresh` asked for. */
  request: (refresh: () => void) => void;
  /** Hold the reloads until the returned function is called (once; further calls do nothing). */
  hold: () => () => void;
};

export const REFRESH_DELAY_MS = 400;
export const REFRESH_MAX_WAIT_MS = 3000;

export function createRefreshGate(timers: RefreshTimers, delay = REFRESH_DELAY_MS, maxWait = REFRESH_MAX_WAIT_MS): RefreshGate {
  let holds = 0;
  let pending: (() => void) | null = null;
  let firstAt = 0;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    timer = null;
    const refresh = pending;
    pending = null;
    refresh?.();
  };
  const schedule = () => {
    cancel();
    const wait = Math.max(0, Math.min(delay, firstAt + maxWait - timers.now()));
    timer = timers.setTimeout(fire, wait);
  };
  return {
    request(refresh) {
      if (!pending) firstAt = timers.now();
      pending = refresh;
      if (holds === 0) schedule();
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
        if (holds === 0) pending = null;
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

/** See RefreshGate.hold; for actions on several papers (app/bulkState.ts), which reload the library themselves when done. */
export const holdLibraryRefresh = gate.hold;
