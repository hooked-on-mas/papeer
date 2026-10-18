import { create } from "zustand";

/** A dropped or chosen PDF shown in the library while its import job is still running. */
export type PendingImport = {
  /** The path as sent to the sidecar, which echoes it back in import events. */
  path: string;
  name: string;
  collection: string;
  /** Filled in by the sidecar's import.pages event; null when the PDF cannot be opened. */
  pages?: number | null;
};

export const usePendingImports = create<{ items: PendingImport[] }>(() => ({ items: [] }));

/** `collection` must already be normalized, as the library tree groups by that form. */
export function addPendingImports(paths: string[], collection: string): void {
  const items = paths.map((path) => ({
    path,
    name: path.split(/[\\/]/).pop() || path,
    collection,
  }));
  usePendingImports.setState((s) => ({ items: [...items, ...s.items.filter((i) => !paths.includes(i.path))] }));
}

export function setPendingPages(pages: Record<string, number | null>): void {
  usePendingImports.setState((s) => ({
    items: s.items.map((i) => (i.path in pages ? { ...i, pages: pages[i.path] } : i)),
  }));
}

export function removePendingImports(paths: string[]): void {
  usePendingImports.setState((s) => ({ items: s.items.filter((i) => !paths.includes(i.path)) }));
}
