/** Each view schedules the next periodic pass after its own pass settles. */
export function startReplicationPolling(isRunning: () => boolean, synchronize: () => Promise<unknown>): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (!stopped) timer = setTimeout(tick, 3000); };
  const tick = () => {
    timer = undefined;
    if (stopped) return;
    void Promise.resolve().then(() => { if (!stopped && !isRunning()) return synchronize(); })
      .catch(() => { /* The owning replication exposes its own errors. */ }).finally(schedule);
  };
  schedule();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
