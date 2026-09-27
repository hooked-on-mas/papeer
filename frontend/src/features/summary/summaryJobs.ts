import { notifyIfAway } from "@/shell";
import { useStore } from "@/store";
import type { JobHandlers } from "@/features/jobs/jobHandlers";

export const summaryJobHandlers: JobHandlers = {
  article: {
    succeeded: (event, { status }) => {
      status("解説を保存しました。ページ参照をクリックすると原文へ移動します。");
      notifyIfAway("解説ができました", "「サマリー」タブで確認できます。");
      const store = useStore.getState();
      if (event.paper_id && event.paper_id === store.activePaperId) store.setActiveTab("summary");
    },
    // Only shows the paper's サマリー tab: asking the AI again is the pane's own button (with its confirmation).
    resume: {
      label: "サマリーを開く",
      run: (event) => {
        if (!event.paper_id) return;
        const store = useStore.getState();
        store.setSelectedFolder(null);
        store.setActivePaperId(event.paper_id);
        store.setActiveTab("summary");
      },
    },
  },
};
