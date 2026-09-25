import { Loader2, Square, Undo2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { PROVIDER_LABELS, useHealth, useSettings } from "@/api/hooks";
import { isRunning, useStore } from "@/store";
import { cancelVisibleJobs } from "@/features/jobs/jobEvents";
import { undoMove } from "./actions";

export function StatusBar() {
  const statusMessage = useStore((s) => s.statusMessage);
  const activeJobs = useStore((s) => s.activeJobs);
  const activePaperId = useStore((s) => s.activePaperId);
  const moveHistory = useStore((s) => s.moveHistory);
  const { data: settings } = useSettings();
  const { data: health } = useHealth();

  const running = activeJobs.filter(isRunning);
  // The paper on screen first, then library-wide jobs, as the old status line did.
  const job = running.find((j) => j.paper_id === activePaperId) ?? running.find((j) => !j.paper_id);
  const message = job ? (job.message || "処理中...")
    : running.length ? `バックグラウンドで ${running.length} 件のタスクが実行中です...` : statusMessage;
  const percent = job?.total ? ((job.done ?? 0) / job.total) * 100 : null;

  return (
    <footer className="h-[32px] border-t flex items-center px-3 gap-3 text-[12px] text-muted-foreground shrink-0 bg-background">
      {running.length > 0 && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />}
      <span className="flex-1 truncate min-w-0" title={message}>{message}</span>
      {running.length > 0 && (
        <>
          <Progress value={percent} className="w-32 shrink-0" />
          <button
            onClick={cancelVisibleJobs}
            className="flex items-center gap-1 h-6 px-2 rounded border hover:bg-muted hover:text-foreground shrink-0"
            title="表示中の論文の処理と、全体の処理を中止します"
          >
            <Square className="w-3 h-3" /> 中止
          </button>
        </>
      )}
      {moveHistory.length > 0 && (
        <button
          onClick={undoMove}
          className="flex items-center gap-1 h-6 px-2 rounded border hover:bg-muted hover:text-foreground shrink-0"
          title="今回の起動中に行った分類移動を、直前のものから取り消します。"
        >
          <Undo2 className="w-3 h-3" /> 移動を戻す
        </button>
      )}
      <span className="shrink-0 hidden md:inline" title="AI接続">
        {settings ? (PROVIDER_LABELS[settings.provider] ?? settings.provider) : ""}
      </span>
      {health?.version && (
        <span className="shrink-0 tabular-nums" title={health.version}>
          {health.version.startsWith("code-sha256-") ? `code ${health.version.slice(12, 19)}` : `v${health.version}`}
        </span>
      )}
    </footer>
  );
}
