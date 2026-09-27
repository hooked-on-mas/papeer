/**
 * App-wide one-way notifications between parts of the UI that do not share a parent,
 * e.g. a hotkey in the shell opening the reader's search. Every event is listed here
 * with its payload, so senders and listeners cannot drift apart.
 */
export type AppEvents = {
  "open-translate-dialog": void;
  "open-reader-search": void;
  /** Opens the translation editor on the page's paragraph containing the selected text. */
  "open-paragraph-editor": { page: number; side: "original" | "translated"; text: string };
  "open-lightbox": { src: string; alt?: string };
  /** Show the paper in the library tree; focus moves the keyboard focus to its row. */
  "reveal-paper": { paperId: string; focus: boolean };
  "ink-changed": { paperId: string };
};

type Payload<K extends keyof AppEvents> = AppEvents[K] extends void ? [] : [AppEvents[K]];

export function emitAppEvent<K extends keyof AppEvents>(name: K, ...detail: Payload<K>): void {
  window.dispatchEvent(new CustomEvent(name, { detail: detail[0] }));
}

/** Listen until the returned function is called; suits `useEffect(() => onAppEvent(...), [])`. */
export function onAppEvent<K extends keyof AppEvents>(name: K, handler: (detail: AppEvents[K]) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent).detail as AppEvents[K]);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
