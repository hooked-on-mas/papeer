import { create } from "zustand";
import { enqueueReport, type ErrorReport } from "@/lib/errorReports";

/**
 * The app's error dialog (rendered by AppDialogs); any part of the UI may open it. Errors that come
 * while one is on screen wait their turn instead of replacing it, so none goes unseen.
 */
type ErrorDialogState = {
  /** The first is on screen. */
  queue: ErrorReport[];
  show: (title: string, message: string) => void;
  report: (report: Omit<ErrorReport, "id" | "at"> & Partial<Pick<ErrorReport, "id" | "at">>) => void;
  /** Close the error on screen; the next waiting one follows. */
  close: () => void;
};

let nextId = 0;

export const useErrorDialog = create<ErrorDialogState>((set, get) => ({
  queue: [],
  show: (title, message) => get().report({ title, message }),
  report: (report) => set((state) => ({
    queue: enqueueReport(state.queue, { ...report, id: report.id ?? `error-${++nextId}`, at: report.at ?? Date.now() }),
  })),
  close: () => set((state) => ({ queue: state.queue.slice(1) })),
}));

export function showError(error: unknown, title = "処理を完了できませんでした"): void {
  const message = error instanceof Error ? error.message : String(error);
  useErrorDialog.getState().show(title, message);
}
