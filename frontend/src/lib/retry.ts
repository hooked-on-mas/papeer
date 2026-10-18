export type RetryOptions = {
  /** Wait after the 1st, 2nd, … failure in milliseconds; the last value repeats. */
  delays: readonly number[];
  /** Give up (resolve to undefined) once this returns true; checked before every attempt. */
  stopped?: () => boolean;
  /** Called after each failure with the error and the number of failures so far. */
  onFailure?: (error: unknown, failures: number) => void;
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Call `attempt` until it succeeds; undefined only when `stopped` ended the retries first. */
export async function retryUntil<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T | undefined> {
  const { delays, stopped = () => false, onFailure, sleep = wait } = options;
  for (let failures = 0; !stopped(); ) {
    try {
      return await attempt();
    } catch (error) {
      failures += 1;
      onFailure?.(error, failures);
      await sleep(delays[Math.min(failures, delays.length) - 1] ?? 0);
    }
  }
  return undefined;
}
