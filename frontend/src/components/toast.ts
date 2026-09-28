import { Toast } from "@base-ui/react/toast";

/**
 * Non-modal notices in the corner of the window (rendered by <Toaster />, which AppDialogs mounts).
 * For news that must not interrupt the work on screen: a background job that failed or finished.
 * Screen readers hear them through the viewport's live region (polite; "high" priority is urgent).
 */
export const toastManager = Toast.createToastManager();

export type ToastTone = "info" | "success" | "error";

export type ToastOptions = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** One button in the toast; it closes the toast after running. */
  action?: { label: string; run: () => void };
  /** ms before it closes by itself (0: stays until closed). Default: 6 s, errors 12 s. */
  timeout?: number;
  /** Adding a toast with the id of one on screen replaces it. */
  id?: string;
};

export function showToast({ title, description, tone = "info", action, timeout, id }: ToastOptions): string {
  const toastId: string = toastManager.add({
    id,
    title,
    description,
    type: tone,
    timeout: timeout ?? (tone === "error" ? 12_000 : 6_000),
    priority: tone === "error" ? "high" : "low",
    actionProps: action ? {
      children: action.label,
      onClick: () => {
        toastManager.close(toastId);
        action.run();
      },
    } : undefined,
  });
  return toastId;
}

export function closeToast(id: string): void {
  toastManager.close(id);
}
