import { create } from "zustand";

/** The app's single error dialog (rendered by AppDialogs); any part of the UI may open it. */
type ErrorDialogState = {
  error: { title: string; message: string } | null;
  show: (title: string, message: string) => void;
  close: () => void;
};

export const useErrorDialog = create<ErrorDialogState>((set) => ({
  error: null,
  show: (title, message) => set({ error: { title, message } }),
  close: () => set({ error: null }),
}));

export function showError(error: unknown, title = "処理を完了できませんでした"): void {
  const message = error instanceof Error ? error.message : String(error);
  useErrorDialog.getState().show(title, message);
}
