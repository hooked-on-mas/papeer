/**
 * The action on several papers that is running (app/bulkActions.ts, and undoing papers moved together
 * in actions.ts): one at a time, since a second started meanwhile (a double click, a drop during a
 * move) would interleave its requests and its report with the first's. While it runs it holds the
 * library's reloads (lib/libraryRefresh.ts) and shows its progress, with a button that stops it, below
 * the library (useBulkProgress).
 */
import { create } from "zustand";
import { holdLibraryRefresh } from "@/lib/libraryRefresh";

export type BulkProgress = {
  /** What it is doing, as "「ML」へ移動中". */
  label: string;
  /** Papers done so far, of `total`. */
  ran: number;
  total: number;
  /** Stop was pressed: the paper being sent finishes, and no other starts. */
  stopping: boolean;
};

export const useBulkProgress = create<{ progress: BulkProgress | null }>(() => ({ progress: null }));

export const BULK_BUSY_MESSAGE = "前の一括操作が終わるまでお待ちください。";

export type BulkRun = {
  signal: AbortSignal;
  progress: (ran: number, total: number) => void;
  /** Ends it, releasing the reloads: after the holder has reloaded the library itself. */
  end: () => void;
};

let running: AbortController | null = null;

export function isBulkRunning(): boolean {
  return running !== null;
}

/** Starts an action on `total` papers; null while another is running. */
export function beginBulk(label: string, total: number): BulkRun | null {
  if (running) return null;
  const controller = new AbortController();
  running = controller;
  const release = holdLibraryRefresh();
  useBulkProgress.setState({ progress: { label, ran: 0, total, stopping: false } });
  return {
    signal: controller.signal,
    progress: (ran, all) => useBulkProgress.setState((s) => ({ progress: s.progress && { ...s.progress, ran, total: all } })),
    end: () => {
      if (running !== controller) return;
      running = null;
      release();
      useBulkProgress.setState({ progress: null });
    },
  };
}

/** The stop button: the paper being sent finishes, and the rest are reported as not done. */
export function stopBulk(): void {
  if (!running) return;
  running.abort();
  useBulkProgress.setState((s) => ({ progress: s.progress && { ...s.progress, stopping: true } }));
}
