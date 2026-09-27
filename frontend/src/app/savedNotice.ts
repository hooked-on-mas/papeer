import { showToast } from "@/components/toast";
import { readingTime } from "@/lib/statusLifetime";

/**
 * A file written where the user chose (a PDF or Markdown export, a backup): told in a toast rather
 * than the status bar, which clears itself, with the path. No button opens it: the app may open
 * files only inside its data folder (src-tauri/src/lib.rs), and exports usually go elsewhere.
 */
export function showSaved(title: string, path?: string | null): void {
  showToast({ id: `saved-${title}`, title, description: path || undefined, tone: "success", timeout: readingTime(title + (path ?? ""), 6_000, 15_000) });
}
