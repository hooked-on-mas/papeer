import { notifyIfAway } from "@/shell";
import { useStore } from "@/store";
import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { showSummary } from "@/features/reader/navigation";

export const summaryJobHandlers: JobHandlers = {
  article: {
    succeeded: (event, { status }) => {
      status("解説を保存しました。ページ参照をクリックすると原文へ移動します。");
      notifyIfAway("解説ができました", "「サマリー」タブで確認できます。");
      const store = useStore.getState();
      if (event.paper_id && event.paper_id === store.activePaperId) showSummary();
    },
  },
};
