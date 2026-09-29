import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import type { ReadingData } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { requestCancel } from "@/features/jobs/jobEvents";
import { runningPaperJob } from "@/features/jobs/jobSelectors";
import { readPageByAi, readPaperByOcr } from "@/features/ocr/ocrActions";
import { useStore } from "@/store";
import { describeApplied, pageList, type OcrApplied } from "@/lib/ocrText";
import { QK } from "@/lib/queryKeys";
import { wholeOcrPages } from "@/lib/translationIssues";

/**
 * The OCR part of 翻訳の確認・修正: the pages that need OCR, read them with this PC's OCR, what each page
 * read by OCR was read with, and reading one page again with the AI (disabled, with the reason, when the
 * connection cannot take images).
 */
export function OcrPanel({ paperId, reading, busy, onJump }: {
  paperId: string; reading: Pick<ReadingData, "ocr_pages" | "ocr_applied" | "completed_pages">; busy: boolean;
  onJump: (page: number) => void;
}) {
  const status = useQuery({ queryKey: [QK.ocr], queryFn: async () => await unwrap(api.GET("/api/ocr")) });
  const job = useStore(s => runningPaperJob(s.activeJobs, paperId, ["ocr"]));
  const reasonId = useId();
  const whole = wholeOcrPages(reading);
  const applied: OcrApplied[] = reading.ocr_applied ?? [];
  if (!whole.length && !applied.length) return null;
  const translated = reading.completed_pages.length > 0;
  const ai = status.data?.ai;
  const aiBlocked = !ai?.available;
  const byPage = new Map(applied.map(entry => [entry.page, entry]));
  const pages = [...new Set([...whole, ...applied.map(entry => entry.page)])].sort((a, b) => a - b);
  return <section aria-label="OCR" className="space-y-2 rounded border p-3">
    <h3 className="font-medium">OCR（画像から読み取る文字）</h3>
    {!!whole.length && <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1">要OCRのページ（{pageList(whole)}）は原文のまま表示しています。OCR で読むと翻訳できます。</p>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void readPaperByOcr(paperId, whole, translated)}>
        要OCRのページを OCR で読む…</Button>
    </div>}
    <ul className="space-y-1" aria-label="OCR の対象のページ">
      {pages.map(page => {
        const entry = byPage.get(page);
        const label = entry ? describeApplied(entry) : `p.${page}：要OCR（まだ読んでいません）`;
        return <li key={page} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">{label}</span>
          <Button variant="ghost" size="sm" aria-label={`p.${page} を表示`} onClick={() => onJump(page)}>表示</Button>
          <Button variant="outline" size="sm" disabled={busy || aiBlocked} aria-describedby={aiBlocked ? reasonId : undefined}
            aria-label={`p.${page} を AI で読み直す`}
            onClick={() => ai && void readPageByAi(paperId, page, ai.label, translated)}>AI で読み直す…</Button>
        </li>;
      })}
    </ul>
    {aiBlocked && <p id={reasonId} className="text-muted-foreground text-xs">
      {ai?.reason ? `AI で読み直せません：${ai.reason}` : status.error ? "AI 接続の状態を確かめられませんでした。" : "AI 接続の状態を確かめています…"}</p>}
    {job && <div role="status" className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1">{job.message}</span>
      <Button variant="outline" size="sm" onClick={() => void requestCancel(job.job_id).catch(() => undefined)}>中止</Button>
    </div>}
  </section>;
}
