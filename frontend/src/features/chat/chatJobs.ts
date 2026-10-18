import { notifyIfAway } from "@/shell";
import type { JobHandlers } from "@/features/jobs/jobHandlers";

export const chatJobHandlers: JobHandlers = {
  ask: {
    succeeded: (_event, { status }) => {
      status("回答を保存しました。参照リンクから原文を確認できます。");
      notifyIfAway("回答ができました", "「チャット」タブで確認できます。");
    },
  },
};
