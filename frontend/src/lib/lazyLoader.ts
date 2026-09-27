/**
 * Loads something once, on first use or ahead of it. A failed load stays failed, so that rendering
 * again cannot start another attempt each time, until `reset` allows a new one.
 */
export interface Loader<T> {
  /** Starts the load, or returns the one already started. */
  load: () => Promise<T>;
  /** The value once loaded, so that it can be used without waiting. */
  loaded: () => T | undefined;
  /** Forgets a failed load; a load that succeeded or is still running is kept. */
  reset: () => void;
}

export function createLoader<T>(fetch: () => Promise<T>): Loader<T> {
  let pending: Promise<T> | null = null;
  let value: { current: T } | null = null;
  let failed = false;
  return {
    load: () => pending ??= fetch().then(
      (result) => { value = { current: result }; return result; },
      (error: unknown) => { failed = true; throw error; },
    ),
    loaded: () => value?.current,
    reset: () => {
      if (!failed) return;
      failed = false;
      pending = null;
    },
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
