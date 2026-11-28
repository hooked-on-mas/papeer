/** Retry only a failed native startup transport, within the admission signal's deadline. */
export async function fetchStartupWithRetry(input: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  const { signal } = init;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await fetch(input, init);
    } catch (error) {
      signal.throwIfAborted();
      // Fetch rejects on network failure. HTTP responses and body parsing are handled by the caller.
      if (!(error instanceof TypeError)) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 200);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
