/**
 * App-wide one-way notifications between parts of the UI that do not share a parent,
 * e.g. a hotkey in the shell opening the reader's search. Every event is listed here
 * with its payload, so senders and listeners cannot drift apart.
 */
export type AppEvents = {
  "open-translate-dialog": void;
  "open-glossary-dialog": void;
  "open-term-feedback": { side: "original" | "translated"; text: string };
  /** Edit a paper's information and organization without changing the open PDF or tab. */
  "open-paper-details": { paperId: string };
  "open-reader-search": void;
  /**
   * Opens the folder organizing dialog (features/library/OrganizeDialog.tsx) for the papers directly in the
   * folder `source` ("" is 未分類), or for `paperIds`; with neither, as it was left (its proposal or its running job).
   */
  "open-organize-dialog": { source?: string; paperIds?: string[] };
  /** Opens the translation editor on the page's paragraph containing the selected text (or on `unit`, a paragraph id). */
  "open-paragraph-editor": { page: number; side: "original" | "translated"; text: string; unit?: string };
  /** Opens 翻訳の確認・修正 on its list of pages to check. */
  "open-translation-review": void;
  "open-lightbox": { src: string; alt?: string };
  /** Show the paper in the library tree; focus moves the keyboard focus to its row. */
  "reveal-paper": { paperId: string; focus: boolean };
  /** Move the keyboard focus to the library tree: its focused row, or else the open paper (Ctrl+L). */
  "focus-library": void;
  "ink-changed": { paperId: string };
  /** Starts renaming the open item in place, in the header's title (a notebook's; F2). */
  "edit-item-title": void;
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
