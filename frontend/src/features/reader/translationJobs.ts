import { notifyIfAway } from "@/shell";
import { QK } from "@/lib/queryKeys";
import type { JobFinished, JobHandlers } from "@/features/jobs/jobHandlers";

function translateMessage(report: any): string {
  let message = `指定した${report.selected_pages?.length ?? 0}ページの翻訳処理が終了しました。`
    + `全${report.pages}ページ中${report.translated_pages?.length ?? 0}ページ翻訳済み。`;
  if (report.skipped_pages?.length) {
    message += " PDF生成に失敗したページは原文のままです：p." + report.skipped_pages.join(", ");
  }
  return message;
}

/** A new translation changes what search, the paragraph editor and its history see. */
function translationQueries(event: JobFinished) {
  if (!event.paper_id) return [];
  return [[QK.paperSearch, event.paper_id], [QK.paragraphs, event.paper_id], [QK.revisions, event.paper_id],
    [QK.librarySearch]];
}

export const translationJobHandlers: JobHandlers = {
  translate: {
    succeeded: (event, { status }) => {
      const message = translateMessage(event.result ?? {});
      status(message);
      notifyIfAway("翻訳処理が終了しました", message);
    },
    refresh: translationQueries,
  },
  revision: { refresh: translationQueries },
};
