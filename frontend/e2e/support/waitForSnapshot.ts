import assert from 'node:assert/strict';

/** Poll awaited observations in Node; an unresolved Promise is never a successful predicate. */
export async function waitForSnapshot<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = new Error('snapshot read timed out');
  const startedAt = deadline - timeoutMs;
  let readsStarted = 0, successfulReads = 0, priorFalse = 0, lastReturnedAt: number | undefined;
  let lastReadMs: number | undefined, maxReadMs = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let value: T;
    const readStartedAt = Date.now(); readsStarted++;
    try {
      value = await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          const now = Date.now();
          Object.assign(timeoutError, { snapshotDiagnostics: { readsStarted, successfulReads, priorFalse,
            currentReadPendingMs: now - readStartedAt, lastReturnedReadAgeMs: lastReturnedAt === undefined ? null : now - lastReturnedAt,
            lastReadMs: lastReadMs ?? null, maxReadMs, totalElapsedMs: now - startedAt, budgetMs: timeoutMs } });
          reject(timeoutError);
        }, Math.max(0, deadline - Date.now())); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
    const returnedAt = Date.now(); successfulReads++; lastReadMs = returnedAt - readStartedAt;
    maxReadMs = Math.max(maxReadMs, lastReadMs); lastReturnedAt = returnedAt;
    if (accepts(value) === true) return value;
    priorFalse++;
    assert.ok(Date.now() < deadline, `snapshot did not settle: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
}
