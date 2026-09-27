/**
 * Loads something once, on first use or ahead of it. A failed load stays failed, so that rendering
 * again cannot start another attempt each time, until `reset` allows a new one.
 */
export interface Loader<T> {
  /**
   * Starts the load, or returns the one already started. A load that failed while only preloading,
   * before anything asked for it, is tried once more: the user never saw it fail.
   */
  load: () => Promise<T>;
  /** Starts the load ahead of use, without waiting for it or reporting a failure. */
  preload: () => void;
  /** The value once loaded, so that it can be used without waiting. */
  loaded: () => T | undefined;
  /** Forgets a failed load; a load that succeeded or is still running is kept. */
  reset: () => void;
}

export function createLoader<T>(fetch: () => Promise<T>): Loader<T> {
  let pending: Promise<T> | null = null;
  let value: { current: T } | null = null;
  let failed = false;
  // Whether the current attempt was started by preload and nothing has asked for it since.
  let preloadOnly = false;
  const start = () => pending ??= fetch().then(
    (result) => { value = { current: result }; return result; },
    (error: unknown) => { failed = true; throw error; },
  );
  const reset = () => {
    if (!failed) return;
    failed = false;
    pending = null;
  };
  return {
    load: () => {
      if (preloadOnly) {
        preloadOnly = false;
        reset();
      }
      return start();
    },
    preload: () => {
      if (!pending) preloadOnly = true;
      start().catch(() => undefined);
    },
    loaded: () => value?.current,
    reset,
  };
}

/** Runs `task` once the app is idle after starting, or after `timeoutMs` at the latest. */
export function whenIdle(task: () => void, timeoutMs = 3000): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(task, { timeout: timeoutMs });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(task, 1000);
  return () => clearTimeout(handle);
}
