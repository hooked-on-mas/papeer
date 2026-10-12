import type { PaperData, ReadingData } from "../api/hooks";
import type { components } from "../api/schema";
import { itemCapabilities } from "./itemKinds.ts";
import { wholeOcrPages } from "./translationIssues.ts";

export type PaperStatus = "untranslated" | "translating" | "partial" | "paused" | "translated" | "review" | "failed" | "ocr";

/** The translation state a paper's row keeps (PaperData.status, TranslationStatus in papeer/core/translation_status.py). */
export type StoredStatus = components["schemas"]["TranslationStatus"];

const storedLabels: Record<StoredStatus, string> = {
  not_translated: "未翻訳", translating: "翻訳中", partial: "一部翻訳済み",
  resumable: "翻訳途中・再開可", incomplete: "翻訳未完了", translated: "翻訳済み",
};

/** The label of a stored state; "" for none, and an unknown code (a newer Papeer's) as it is. */
export function storedStatusLabel(status: string | undefined): string {
  return status ? storedLabels[status as StoredStatus] ?? status : "";
}

/**
 * Counts are translated pages, never a job's paragraph-level progress counters. `rebuilding`: the job
 * running only makes the PDF again from saved translations (rebuildJobs.ts), which is said as such.
 * `applicable` is false for an item that is not translated at all (a notebook): there is no status to show
 * for it, and the rest of what is returned is that of an untranslated paper.
 */
export function paperTranslationStatus(paper: PaperData | null | undefined, translating: boolean, reading?: ReadingData | null,
  { rebuilding = false }: { rebuilding?: boolean } = {}) {
  const totalPages = reading?.page_count ?? paper?.pages ?? 0;
  const required = reading?.translation_required_pages;
  const pages = required?.length ?? (reading ? totalPages : paper?.translation_required_count ?? totalPages);
  const completed = Math.min(pages, required
    ? required.filter(page => reading!.completed_pages.includes(page)).length
    : reading?.completed_pages.length ?? paper?.translation_completed_required_count ?? paper?.translated_count ?? 0);
  const paused = reading?.in_progress ?? paper?.translation_in_progress;
  // Pages kept as the original because their text is garbled or they are scanned images.
  const ocrPages = reading?.ocr_pages ? wholeOcrPages(reading).length : paper?.translation_ocr_count ?? 0;
  const needsReview = reading?.report
    ? !!(reading.report.skipped_blocks?.length || reading.report.skipped_pages?.length)
    : paper?.translation_has_issues ?? (pages === totalPages && paper?.status === "partial");
  let status: PaperStatus;
  if (translating) status = "translating";
  else if (paused) status = "paused";
  else if (pages > 0 && completed >= pages) status = needsReview ? "review" : "translated";
  else if (completed > 0) status = "partial";
  else if (paper?.status === "incomplete") status = "failed";
  else if (pages === 0 && ocrPages > 0) status = "ocr";
  else status = "untranslated";
  const text = { untranslated: "未翻訳", translating: rebuilding ? "PDF作り直し中" : "翻訳中", partial: "一部翻訳", paused: "中断・再開可", translated: "翻訳完了", review: "訳文に未翻訳あり", failed: "翻訳未完了", ocr: "要OCR" }[status];
  const scope = pages !== totalPages ? "翻訳対象" : "全";
  const count = status === "ocr" ? `${ocrPages}/${totalPages}ページ` : pages > 0 ? `${completed}/${pages}ページ` : "ページ数不明";
  const ocrNote = status === "ocr" ? "文字化け・画像だけのページしかないため、このままでは翻訳できません。「翻訳の確認・修正」の OCR の欄から読めます"
    : ocrPages > 0 ? `${ocrPages}ページは要OCRのため原文のまま` : "";
  const description = `${text} · ${status === "ocr" ? `全${totalPages}ページ中${ocrPages}ページが要OCR` : pages > 0 ? `${scope}${pages}ページ中${completed}ページの訳文を保存済み` : count}${status === "review" ? "。未翻訳の段落は「翻訳の確認・修正」で確認できます" : ""}${ocrNote ? `。${ocrNote}` : ""}`;
  return { status, text, pages, completed, count, description, progress: pages > 0 ? completed / pages * 100 : 0,
    applicable: itemCapabilities(paper).translate };
}
