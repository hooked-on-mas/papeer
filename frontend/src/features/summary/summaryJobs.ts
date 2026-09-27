import { notifyIfAway } from "@/shell";
import { useStore } from "@/store";
import type { JobFinished, JobHandlers } from "@/features/jobs/jobHandlers";
import { showSummary } from "@/features/reader/navigation";

/** Open the job's paper and show its 解説 (beside the PDF when the side panel is open there). */
function openSummary(event: JobFinished): void {
  if (!event.paper_id) return;
  const store = useStore.getState();
  store.setSelectedFolder(null);
  store.setActivePaperId(event.paper_id);
  showSummary();
}

export const summaryJobHandlers: JobHandlers = {
  article: {
    succeeded: (event, { visible, done }) => {
      done("「サマリー」タブで確認できます。ページ参照をクリックすると原文へ移動します。", {
        title: "解説ができました",
        action: visible ? undefined : { label: "開く", run: () => openSummary(event) },
      });
      notifyIfAway("解説ができました", "「サマリー」タブで確認できます。");
      const store = useStore.getState();
      if (event.paper_id && event.paper_id === store.activePaperId) showSummary();
    },
    // Only shows the paper's サマリー: asking the AI again is the pane's own button (with its confirmation).
    resume: { label: "サマリーを開く", run: openSummary },
  },
};
