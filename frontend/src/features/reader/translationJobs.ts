import { notifyIfAway } from "@/shell";
import { useStore } from "@/store";
import { emitAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";
import type { JobFinished, JobHandlers } from "@/features/jobs/jobHandlers";
import { finishGlossaryDraft, isGlossaryDialogOpen } from "./glossaryDraft";

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
    [QK.librarySearch], [QK.translationPlan, event.paper_id]];
}

/**
 * 再開 after a failure: open the paper and its translation dialog, which resumes the interrupted run
 * (and shows what it will send) instead of calling the AI straight from the error dialog.
 */
function openTranslationDialog(event: JobFinished): void {
  if (!event.paper_id) return;
  const store = useStore.getState();
  store.setSelectedFolder(null);
  store.setActivePaperId(event.paper_id);
  store.setActiveTab("reader");
  emitAppEvent("reveal-paper", { paperId: event.paper_id, focus: false });
  emitAppEvent("open-translate-dialog");
}

export const translationJobHandlers: JobHandlers = {
  translate: {
    succeeded: (event, { status }) => {
      const message = translateMessage(event.result ?? {});
      status(message);
      notifyIfAway("翻訳処理が終了しました", message);
    },
    refresh: translationQueries,
    resume: { label: "翻訳を再開…", run: openTranslationDialog },
  },
  revision: { refresh: translationQueries },
  "glossary-draft": {
    // The translation dialog shows the candidates itself; closed, it may be long forgotten.
    succeeded: (event, { status }) => {
      // Only a check whose candidates now wait for the dialog (not a stale or superseded job).
      if (!finishGlossaryDraft(event) || isGlossaryDialogOpen(event.paper_id)) return;
      const count = (event.result?.terms ?? []).length;
      const message = (count ? `未登録の専門用語を${count}件抽出しました。` : "未登録の専門用語の確認が終わりました（候補はありません）。")
        + "翻訳の設定を開くと、確認して翻訳を開始できます。";
      status(message);
      notifyIfAway("用語の確認が終わりました", message);
    },
    resume: { label: "翻訳の設定を開く…", run: openTranslationDialog },
  },
};
