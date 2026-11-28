/** Host-private, per-Library enrollment ownership. This is not an authorization source. */
export function createOfflineEnrollmentCoordinator() {
  type Job = { controller: AbortController; settled: Promise<void>; finish(): void };
  type Slot = { retiring: boolean; jobs: Set<Job> };
  const slots = new Map<string, Slot>();
  const slot = (key: string) => { let found = slots.get(key); if (!found) { found = { retiring: false, jobs: new Set() }; slots.set(key, found); } return found; };
  const prune = (key: string, value: Slot) => { if (!value.retiring && value.jobs.size === 0 && slots.get(key) === value) slots.delete(key); };
  return {
    async enroll<T>(key: string, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      signal.throwIfAborted(); const current = slot(key); if (current.retiring) throw new Error('offline-enrollment-retiring');
      const controller = new AbortController(); let finish!: () => void;
      const job: Job = { controller, settled: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
      current.jobs.add(job);
      const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) controller.abort();
      try { return await action(controller.signal); }
      finally { signal.removeEventListener('abort', cancel); current.jobs.delete(job); job.finish(); prune(key, current); }
    },
    async retire<T>(key: string, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const current = slot(key); if (current.retiring) throw new Error('offline-enrollment-retiring');
      current.retiring = true;
      const jobs = [...current.jobs]; for (const job of jobs) job.controller.abort();
      const controller = new AbortController(), cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      const work = (async () => { await Promise.all(jobs.map(job => job.settled)); controller.signal.throwIfAborted(); return action(controller.signal); })();
      // Timeout or caller cancellation returns control, but never frees the key while
      // an old job or the retirement transaction may still be running.
      void work.finally(() => { current.retiring = false; prune(key, current); }).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = new Promise<never>((_, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        timer = setTimeout(cancel, 5_000);
        return await Promise.race([work, stopped]);
      } finally { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    },
  };
}
