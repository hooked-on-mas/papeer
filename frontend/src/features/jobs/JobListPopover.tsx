import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CircleAlert, ListTodo, Square } from "lucide-react";
import { ApiError } from "@/api/client";
import { paperDisplayName, usePaper } from "@/api/hooks";
import { Progress } from "@/components/ui/progress";
import { emitAppEvent } from "@/lib/appEvents";
import { isRunning, useStore, type Job } from "@/store";
import { cancelSync } from "@/features/settings/driveSync";
import { cancelJob } from "./jobEvents";
import { clearJobFailure, showJobFailure, useJobFailures } from "./jobFailures";
import type { ErrorReport } from "@/lib/errorReports";
import { jobCountText, jobKindLabel, jobPercent, orderJobs } from "./jobList";

function openPaper(paperId: string): void {
  const store = useStore.getState();
  store.setSelectedFolder(null);
  store.setActivePaperId(paperId);
  emitAppEvent("reveal-paper", { paperId, focus: false });
}

function PaperName({ paperId }: { paperId: string }) {
  const { data: paper } = usePaper(paperId);
  const name = paper ? paperDisplayName(paper) : "";
  return (
    <button type="button" className="block max-w-full truncate text-left hover:underline" title={name ? `${name}\nこの論文を開く` : undefined}
      onClick={() => openPaper(paperId)}>
      {name || "（論文）"}
    </button>
  );
}

function JobRow({ job, active }: { job: Job; active: boolean }) {
  const [cancelling, setCancelling] = useState(false);
  const percent = jobPercent(job);
  const count = jobCountText(job);
  const label = jobKindLabel(job.kind);

  const cancel = async () => {
    setCancelling(true);
    // A sync keeps its own 中止 state (the waiting screen shows it too).
    if (job.kind === "drive-sync") await cancelSync();
    else if (!await cancelJob(job.job_id)) setCancelling(false);
  };

  return (
    <li className="grid gap-1 px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1 text-[0.8125rem] leading-5">
          <div className="font-medium">
            {label}
            {active && <span className="ml-1.5 rounded bg-primary/10 px-1 text-[0.75rem] font-normal text-primary">表示中</span>}
            {!job.paper_id && <span className="ml-1.5 text-[0.75rem] font-normal text-muted-foreground">ライブラリ全体</span>}
          </div>
          {job.paper_id && <div className="text-[0.75rem] text-muted-foreground min-w-0"><PaperName paperId={job.paper_id} /></div>}
        </div>
        <button
          type="button"
          onClick={cancel}
          disabled={cancelling}
          className="flex h-7 shrink-0 items-center gap-1 rounded border px-2 text-[0.75rem] hover:bg-muted disabled:opacity-60"
          aria-label={`${label}を中止`}
        >
          <Square className="size-3" aria-hidden="true" /> {cancelling ? "中止中…" : "中止"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Progress value={percent} aria-label={`${label}の進み具合`} className="flex-1" />
        {count && <span className="shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">{count}</span>}
      </div>
      {job.message && <div className="truncate text-[0.75rem] text-muted-foreground" title={job.message}>{job.message}</div>}
    </li>
  );
}

function FailureRow({ report }: { report: ErrorReport }) {
  const paperId = report.paperId ?? null;
  const { error } = usePaper(paperId);
  // A paper deleted since has nothing left to look into.
  const removed = error instanceof ApiError && error.status === 404;
  useEffect(() => {
    if (removed && paperId) clearJobFailure(paperId);
  }, [removed, paperId]);
  if (removed) return null;
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-[0.75rem]">
      <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{report.title}</div>
        {report.paperTitle && <div className="truncate text-muted-foreground">{report.paperTitle}</div>}
      </div>
      <button type="button" className="h-7 shrink-0 rounded border px-2 hover:bg-muted"
        onClick={() => paperId && showJobFailure(paperId)}>
        詳細
      </button>
    </li>
  );
}

/**
 * The status bar's list of every running job, whichever paper it belongs to, with a 中止 for each,
 * and the failures of papers not on screen that the user has not looked at yet.
 */
export function JobListPopover() {
  const activeJobs = useStore((s) => s.activeJobs);
  const activePaperId = useStore((s) => s.activePaperId);
  const failures = useJobFailures((s) => s.failures);
  const running = orderJobs(activeJobs.filter(isRunning), activePaperId);
  const failed = Object.values(failures).sort((a, b) => b.at - a.at);
  if (!running.length && !failed.length) return null;

  const summary = [running.length ? `処理 ${running.length} 件` : "", failed.length ? `エラー ${failed.length} 件` : ""].filter(Boolean).join("・");

  return (
    <Popover.Root>
      <Popover.Trigger
        className={`flex h-6 shrink-0 items-center gap-1 rounded border px-2 hover:bg-muted hover:text-foreground ${failed.length ? "border-destructive/50 text-destructive" : ""}`}
        title="実行中の処理と、表示していない論文のエラーを一覧します"
      >
        {failed.length ? <CircleAlert className="size-3.5" aria-hidden="true" /> : <ListTodo className="size-3.5" aria-hidden="true" />}
        {summary}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className="w-[min(26rem,calc(100vw-2rem))] max-h-[min(28rem,70vh)] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none origin-(--transform-origin) transition-[opacity,transform] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0">
            {running.length > 0 && (
              <section aria-label="実行中の処理">
                <Popover.Title className="border-b px-3 py-2 text-[0.75rem] font-medium text-muted-foreground">実行中の処理</Popover.Title>
                <ul className="divide-y">
                  {running.map((job) => <JobRow key={job.job_id} job={job} active={!!job.paper_id && job.paper_id === activePaperId} />)}
                </ul>
              </section>
            )}
            {failed.length > 0 && (
              <section aria-label="未確認のエラー">
                <h3 className="border-y px-3 py-2 text-[0.75rem] font-medium text-muted-foreground">未確認のエラー</h3>
                <ul className="divide-y">
                  {failed.map((report) => <FailureRow key={report.id} report={report} />)}
                </ul>
              </section>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
