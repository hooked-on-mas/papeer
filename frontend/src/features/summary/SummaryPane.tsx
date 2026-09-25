import { FileDown, Loader2, RefreshCw, ScrollText, Square } from "lucide-react";
import { isRunning, paperBusy, useStore } from "../../store";
import { useArticle } from "../../api/hooks";
import { apiRequest } from "../../api/client";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { exportMarkdown, generateArticle } from "@/app/actions";

export function SummaryPane() {
  const activePaperId = useStore((state) => state.activePaperId);
  const activeJobs = useStore((state) => state.activeJobs);
  const { data: article, isLoading, error } = useArticle(activePaperId);

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 h-full">
        <p className="text-[15px] font-medium mb-1 text-foreground">論文の理解を、もう一歩深く</p>
        <p className="text-[13px]">左のライブラリから論文を選んでください</p>
      </div>
    );
  }

  const job = activeJobs.find((j) => j.paper_id === activePaperId && isRunning(j) && j.kind === "article");
  const busy = paperBusy(activeJobs, activePaperId);
  const summaryText = (article as any)?.content || "";

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      <div className="min-h-12 flex flex-wrap items-center justify-between px-4 py-2 border-b shrink-0 bg-background/50 gap-2">
        <h2 className="text-[14px] font-semibold flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-muted-foreground" />
          サマリー
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => exportMarkdown(activePaperId)}
            disabled={!summaryText}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] border rounded hover:bg-muted disabled:opacity-50"
          >
            <FileDown className="w-3.5 h-3.5" /> サマリーをMarkdownで保存
          </button>
          <button
            onClick={() => generateArticle(activePaperId)}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${job ? "animate-spin" : ""}`} />
            {job ? "作成中…" : summaryText ? "サマリーを再作成" : "サマリーを作成"}
          </button>
        </div>
      </div>

      {job && (
        <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted/40 text-[13px]">
          <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
          <span className="truncate flex-1">{job.message || "サマリーを作成中…"}</span>
          <button
            onClick={() => apiRequest("POST", `/api/jobs/${job.job_id}/cancel`).catch(() => undefined)}
            className="flex items-center gap-1 px-2 py-1 rounded border text-[12px] hover:bg-muted"
          >
            <Square className="w-3 h-3" /> 中止
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto bg-muted/30">
        <div className="summary-page mx-auto w-full max-w-[900px] px-5 py-8 sm:px-10 sm:py-12">
          {isLoading && <div className="text-muted-foreground text-sm flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> サマリーを読み込み中...</div>}
          {error && <div className="text-destructive text-sm p-4 border rounded bg-destructive/10">サマリーを読み込めませんでした: {error.message}</div>}

          {!isLoading && !error && summaryText ? (
            <article aria-label="論文のサマリー">
              <MarkdownRenderer className="summary-prose" content={summaryText} paperId={activePaperId} />
            </article>
          ) : (
            !isLoading && !error && (
              <div className="text-center py-12 max-w-md mx-auto">
                <p className="text-[15px] font-medium mb-2">サマリーはまだありません</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed mb-5">
                  「サマリーを作成」で、イントロダクションから目的・手法・結果・限界まで、具体例を交えながら日本語で詳しく整理します。
                  数分かかります。AI接続の設定のモデルを使います。
                </p>
                <button
                  onClick={() => generateArticle(activePaperId)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  <ScrollText className="w-4 h-4" /> サマリーを作成
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
