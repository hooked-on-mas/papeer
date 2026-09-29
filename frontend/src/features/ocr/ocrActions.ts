/**
 * Starting OCR from the screen (papeer/core/ocr.py, sidecar/routes/ocr.py): downloading the language data
 * after asking, reading a paper's pages that need OCR, reading one page again with the AI, and offering to
 * read the papers just added. Each asks first with the words of lib/ocrText.ts.
 */
import { api, unwrap } from "@/api/client";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { startJob } from "@/features/jobs/jobEvents";
import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { queryClient } from "@/lib/queryClient";
import { QK } from "@/lib/queryKeys";
import {
  aiConfirmText, downloadConfirmText, neededLanguageData, ocrResultMessage, readConfirmText,
  type LanguageData, type OcrStatus,
} from "@/lib/ocrText";

export async function fetchOcrStatus(): Promise<OcrStatus> {
  return await queryClient.fetchQuery({ queryKey: [QK.ocr], staleTime: 0, queryFn: async () => await unwrap(api.GET("/api/ocr")) });
}

/** How a download ended: done, not agreed to, or failed or stopped with the job's reason. */
export type DownloadOutcome = { ok: true } | { ok: false; error: string | null };

/** Download language data after the user agrees (the job's failure is also shown as any job's). */
export async function downloadLanguageData(entries: LanguageData[], directory: string, reason?: string): Promise<DownloadOutcome> {
  if (!entries.length) return { ok: true };
  if (!await askConfirm("OCR の言語データをダウンロード", downloadConfirmText(entries, directory, reason), "ダウンロード"))
    return { ok: false, error: null };
  return await new Promise<DownloadOutcome>((resolve) => {
    startJob("/api/ocr/language-data", { langs: entries.map(entry => entry.lang) }, { kind: "ocr-data", paperId: null },
      event => resolve(event.status === "succeeded" ? { ok: true }
        : { ok: false, error: event.error || (event.status === "cancelled" ? "中止しました。" : "ダウンロードできませんでした。") }))
      .catch((error: unknown) => {
        showError(error, "言語データをダウンロードできませんでした");
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
  });
}

/**
 * Whether this PC can read the languages the settings may need, downloading their data first after asking
 * (the language data is fetched the first time it is needed, never without asking).
 */
export async function ensureLanguageData(): Promise<boolean> {
  const status = await fetchOcrStatus();
  const needed = neededLanguageData(status);
  if (!needed.length) return true;
  return (await downloadLanguageData(needed, status.directory, "OCR で読むには、先に言語データが必要です。")).ok;
}

/** Read the pages of a paper that need OCR (after asking), and write its extraction again. */
export async function readPaperByOcr(paperId: string, pages: number[], translated: boolean): Promise<void> {
  if (!pages.length) return;
  if (!await askConfirm("OCR で読む", readConfirmText(pages, translated), "読む")) return;
  await startPaperOcr(paperId, null);
}

async function startPaperOcr(paperId: string, pages: number[] | null): Promise<void> {
  try {
    if (!await ensureLanguageData()) return;
    await startJob(`/api/papers/${paperId}/ocr`, { engine: "local", pages }, { kind: "ocr", paperId });
  } catch (error) {
    showError(error, "OCR を始められませんでした");
  }
}

// The OCR jobs that ask the AI: when they end, the plan's usage is read again (its limits changed).
const aiJobs = new Set<string>();

/** Read one page again with the AI connection, after telling that its images go to that service. */
export async function readPageByAi(paperId: string, page: number, provider: string, translated: boolean): Promise<void> {
  if (!await askConfirm("このページを AI で読み直す", aiConfirmText(page, provider, translated), "画像を送って読む")) return;
  try {
    aiJobs.add(await startJob(`/api/papers/${paperId}/ocr`, { engine: "ai", pages: [page] }, { kind: "ocr", paperId }));
  } catch (error) {
    showError(error, "AI で読み直せませんでした");
  }
}

/**
 * After adding PDFs: papers with pages still needing OCR are offered to be read, unless this PC's setting
 * is 使わない. With 追加するときに読む they were read already; what is left could not be (no language data).
 */
export async function offerOcrAfterImport(paperIds: string[]): Promise<void> {
  if (!paperIds.length) return;
  let status: OcrStatus;
  try {
    status = await fetchOcrStatus();
  } catch {
    return; // The offer is a help only; the translation review still lists the pages.
  }
  if (status.settings.mode === "off") return;
  const count = paperIds.length;
  const message = `追加した論文${count > 1 ? `のうち${count}件` : ""}に、スキャンなどで文字を読み取れない「要OCR」のページがあります。`
    + "このPCの OCR で読みますか？（1 ページに数秒かかります。あとから「翻訳の確認・修正」でも読めます）";
  if (!await askConfirm("要OCRのページがあります", message, "OCR で読む", false, { cancelLabel: "今は読まない" })) return;
  if (!await ensureLanguageData()) return;
  for (const paperId of paperIds) {
    try {
      await startJob(`/api/papers/${paperId}/ocr`, { engine: "local", pages: null }, { kind: "ocr", paperId });
    } catch (error) {
      showError(error, "OCR を始められませんでした");
    }
  }
}

export const ocrJobHandlers: JobHandlers = {
  ocr: {
    succeeded: (event, { done }) => done(ocrResultMessage(event.result), {
      title: event.result.read_pages.length ? "OCR で読みました" : "OCR で読めませんでした",
      tone: Object.keys(event.result.failed_pages).length || event.result.retranslate_pages.length ? "info" : "success",
    }),
    // The paper's text changed: its reading state, paragraphs, search and what translating it would send.
    refresh: event => [
      ...(event.paper_id ? [[QK.reading, event.paper_id], [QK.paragraphs, event.paper_id], [QK.paperSearch, event.paper_id],
        [QK.librarySearch], [QK.translationPlan, event.paper_id]] : []),
      // Also after a failure, which may have hit the plan's limit.
      ...(aiJobs.delete(event.job_id) ? [[QK.usageLimits]] : []),
    ],
  },
  "ocr-data": {
    succeeded: (_event, { status }) => status("OCR の言語データをダウンロードしました。"),
    refresh: () => [[QK.ocr]],
  },
};
