import { apiRequest } from "@/api/client";
import { useStore } from "@/store";
import { createOpenTracker } from "@/lib/recentPapers";

/**
 * Tells the sidecar which paper was opened (POST /api/papers/{id}/opened): it remembers when on this PC
 * (最近開いた順, 続きから読む) and makes an unread paper 読書中, then announces the change as paper.changed,
 * which updates the paper's row. Nothing to report when it fails: the paper is simply not listed as opened.
 * Returns the cleanup.
 */
export function initPaperOpenedTracking(): () => void {
  const track = createOpenTracker((paperId) => {
    void apiRequest("POST", `/api/papers/${paperId}/opened`).catch(() => undefined);
  });
  track(useStore.getState().activePaperId);
  const unsubscribe = useStore.subscribe((state) => track(state.activePaperId));
  return () => {
    unsubscribe();
    track(null);
  };
}
