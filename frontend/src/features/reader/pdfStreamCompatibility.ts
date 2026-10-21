/**
 * PDF.js uses `for await` to read text, including in its legacy build.
 * Some Safari versions have ReadableStream/getReader but no async iterator.
 */
export function installPdfStreamCompatibility(Stream: { prototype: object } | undefined = globalThis.ReadableStream) {
  if (!Stream || typeof Reflect.get(Stream.prototype, Symbol.asyncIterator) === "function") return;
  Object.defineProperty(Stream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function*<T>(this: ReadableStream<T>, { preventCancel = false }: { preventCancel?: boolean } = {}) {
      const reader = this.getReader();
      let finished = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { finished = true; return; }
          yield value;
        }
      } catch (error) {
        finished = true;
        throw error;
      } finally {
        try {
          if (!finished && !preventCancel) await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    },
  });
}

installPdfStreamCompatibility();
