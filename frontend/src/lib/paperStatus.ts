import type { PaperData, ReadingData } from "../api/hooks";

export type PaperStatus = "untranslated" | "translating" | "partial" | "paused" | "translated" | "review" | "failed";

/** Counts are translated pages, never a job's paragraph-level progress counters. */
export function paperTranslationStatus(paper: PaperData | null | undefined, translating: boolean, reading?: ReadingData | null) {
  const totalPages = reading?.page_count ?? paper?.pages ?? 0;
  const required = reading?.translation_required_pages;
  const pages = required?.length ?? (reading ? totalPages : paper?.translation_required_count ?? totalPages);
  const completed = Math.min(pages, required
    ? required.filter(page => reading!.completed_pages.includes(page)).length
    : reading?.completed_pages.length ?? paper?.translation_completed_required_count ?? paper?.translated_count ?? 0);
  const paused = reading?.in_progress ?? paper?.translation_in_progress;
  const needsReview = reading?.report
    ? !!(reading.report.skipped_blocks?.length || reading.report.skipped_pages?.length)
    : paper?.translation_has_issues ?? (pages === totalPages && paper?.status === "一部翻訳済み");
  let status: PaperStatus;
  if (translating) status = "translating";
  else if (paused) status = "paused";
  else if (pages > 0 && completed >= pages) status = needsReview ? "review" : "translated";
  else if (completed > 0) status = "partial";
  else if (paper?.status === "翻訳未完了") status = "failed";
  else status = "untranslated";
  const text = { untranslated: "未翻訳", translating: "翻訳中", partial: "一部翻訳", paused: "中断・再開可", translated: "翻訳完了", review: "訳文に未翻訳あり", failed: "翻訳未完了" }[status];
  const scope = pages !== totalPages ? "翻訳対象" : "全";
  const count = pages > 0 ? `${completed}/${pages}ページ` : "ページ数不明";
  const description = `${text} · ${pages > 0 ? `${scope}${pages}ページ中${completed}ページの訳文を保存済み` : count}${status === "review" ? "。未翻訳の段落は「翻訳の確認・修正」で確認できます" : ""}`;
  return { status, text, pages, completed, count, description, progress: pages > 0 ? completed / pages * 100 : 0 };
}
