import { useEffect } from "react";
import { Gauge, Loader2, Square, Undo2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { providerLabel, useHealth, useProviders, useSettings, useUsageLimits } from "@/api/hooks";
import { formatTokens, limitsDetails, limitsSummary, useLastUsage, usageDetails } from "@/lib/usage";
import { isRunning, useStore } from "@/store";
import { cancelVisibleJobs } from "@/features/jobs/jobEvents";
import { JobListPopover } from "@/features/jobs/JobListPopover";
import { undoMove } from "./actions";
import { holdStatus } from "./statusExpiry";

export function StatusBar() {
  const statusMessage = useStore((s) => s.statusMessage);
  const activeJobs = useStore((s) => s.activeJobs);
  const activePaperId = useStore((s) => s.activePaperId);
  const moveHistory = useStore((s) => s.moveHistory);
  const { data: settings } = useSettings();
  const { data: health } = useHealth();
  const { data: providers } = useProviders();
  const { data: limits } = useUsageLimits(settings?.provider);
  const lastUsage = useLastUsage((s) => s.usage);
  // Hidden while the pointer was on it (focus mode): the message must not stay held forever.
  useEffect(() => () => holdStatus(false), []);

  const running = activeJobs.filter(isRunning);
  // The paper on screen first, then library-wide jobs, as the old status line did.
  const job = running.find((j) => j.paper_id === activePaperId) ?? running.find((j) => !j.paper_id);
  const message = job ? (job.message || "処理中...")
    : running.length ? `バックグラウンドで ${running.length} 件のタスクが実行中です...` : statusMessage;
  const percent = job?.total ? ((job.done ?? 0) / job.total) * 100 : null;

  // Plan usage of the AI connection now selected; the last job's tokens when the service reports no plan.
  const shownLimits = limits && limits.provider === settings?.provider && limits.windows.length ? limits : null;
  const usageTitle = [
    shownLimits ? "利用枠\n" + limitsDetails(shownLimits) : "",
    lastUsage ? "直近のAI処理\n" + usageDetails(lastUsage) : "",
  ].filter(Boolean).join("\n\n");

  return (
    <footer
      className="h-8 border-t flex items-center px-3 gap-3 text-[0.75rem] text-muted-foreground shrink-0 bg-background"
      onPointerEnter={() => holdStatus(true)}
      onPointerLeave={() => holdStatus(false)}
    >
      {running.length > 0 && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />}
      {/* Screen readers hear the outcomes (statusMessage) here, not every step of a job's progress. */}
      <span role="status" className="sr-only">{statusMessage}</span>
      <span className="flex-1 truncate min-w-0 text-foreground/80" title={message} aria-hidden={message === statusMessage || undefined}>{message}</span>
      {running.length > 0 && (
        <>
          <Progress value={percent} className="w-32 shrink-0" />
          {job && (
            <button
              onClick={cancelVisibleJobs}
              className="flex items-center gap-1 h-6 px-2 rounded border hover:bg-muted hover:text-foreground shrink-0"
              title="表示中の論文の処理と、全体の処理を中止します（他の論文の処理は一覧から個別に中止できます）"
            >
              <Square className="w-3 h-3" /> 中止
            </button>
          )}
        </>
      )}
      <JobListPopover />
      {moveHistory.length > 0 && (
        <button
          onClick={undoMove}
          className="flex items-center gap-1 h-6 px-2 rounded border hover:bg-muted hover:text-foreground shrink-0"
          title="今回の起動中に行った論文の移動・フォルダー削除を、直前のものから取り消します。"
        >
          <Undo2 className="w-3 h-3" /> 元に戻す
        </button>
      )}
      {usageTitle && (
        <span
          className={`shrink-0 flex items-center gap-1 tabular-nums ${shownLimits?.windows.some((w) => w.used_percent >= 80) ? "text-destructive" : ""}`}
          title={usageTitle}
        >
          <Gauge className="w-3.5 h-3.5" />
          {shownLimits ? limitsSummary(shownLimits)
            : lastUsage && `直近 入力${formatTokens(lastUsage.input_tokens)} 出力${formatTokens(lastUsage.output_tokens)}`}
        </span>
      )}
      <span className="shrink-0 hidden md:inline" title="AI接続">
        {providerLabel(providers, settings?.provider)}
      </span>
      {health?.version && (
        <span className="shrink-0 tabular-nums" title={`Papeer ${health.version}\n翻訳コード ${health.code_version.slice(12, 24)}`}>
          v{health.version}
        </span>
      )}
    </footer>
  );
}
