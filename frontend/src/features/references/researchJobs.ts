import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { QK } from "@/lib/queryKeys";
import { openReferencePaper } from "./researchNavigation";
import { useAutoResearch } from "./autoResearch";

const refresh = () => [[QK.research], [QK.citations], [QK.papers], [QK.collections], [QK.reading], [QK.article]];

export const researchJobHandlers: JobHandlers = {
  "reference-research": {
    refresh,
    succeeded: (event, { done, status }) => {
      const active = useAutoResearch.getState().active;
      if (active.some(item => item.source === event.paper_id && item.key === event.result.key)) {
        status("参考文献の情報を取得しました。");
        return;
      }
      done("参考文献の詳細で概要・出典・PDFの入手先を確認できます。", { title: "参考文献を調べました" });
    },
  },
  "reference-import": {
    refresh,
    succeeded: (event, { done }) => {
      const record = event.result.record;
      done(record.summary_error || (record.has_summary ? "PDFとサマリーを保存しました。" : "PDFを保存しました。"), {
        title: record.summary_error ? "PDF取り込み済み・サマリーは未作成" : "参考文献を取り込みました",
        tone: record.summary_error ? "info" : "success",
        action: event.paper_id && record.paper_id ? { label: record.has_summary ? "サマリーを見る" : "PDFを読む",
          run: () => openReferencePaper(event.paper_id!, record.paper_id!, record.has_summary) } : undefined,
      });
    },
  },
};
