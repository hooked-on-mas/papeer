import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest, authToken, backendPort } from "@/api/client";
import { paperDisplayName, type PaperData } from "@/api/hooks";
import { isRunning, useStore, type Job } from "@/store";
import { notifyIfAway, shell } from "@/shell";
import { removePendingImports, setPendingPages } from "@/app/pendingImports";
import { useErrorDialog } from "@/components/errorDialog";
import { showToast } from "@/components/toast";
import { errorAdvice, type ErrorReport } from "@/lib/errorReports";
import { QK } from "@/lib/queryKeys";
import { useLastUsage, usageSummary, type Usage } from "@/lib/usage";
import { readingTime } from "@/lib/statusLifetime";
import { markConnected, markDisconnected, useConnection } from "./connection";
import { addJobFailure, clearJobFailure, showJobFailure } from "./jobFailures";
import { jobHandler, type JobContext, type JobFinished } from "./jobHandlers";
import { AI_PLAN_JOBS, isJobKind, type JobKind } from "./jobKinds";
import { backgroundFailureTitle, doneTitle, failureTitle, jobKindLabel, QUICK_RECONNECT_MS, statusWhenCancelEnds } from "./jobList";

export type { JobFinished } from "./jobHandlers";

type Watcher = (event: JobFinished) => void;

/** Shown from a cancel request until the job ends, which replaces it (see markCancelling). */
const CANCELLING_STATUS = "中止しています… API通信中の場合は応答またはタイムアウトまで待ちます。";

// Jobs asked to stop that have not ended yet; while any is left, the status says CANCELLING_STATUS.
const cancelRequested = new Set<string>();

const watchers = new Map<string, Watcher[]>();
// A fast job can finish before its starter registers a watcher.
const recentlyFinished = new Map<string, JobFinished>();

/** Run `watcher` once when the job ends (immediately if it already has). */
export function watchJob(jobId: string, watcher: Watcher): void {
  const finished = recentlyFinished.get(jobId);
  if (finished) {
    watcher(finished);
    return;
  }
  watchers.set(jobId, [...(watchers.get(jobId) ?? []), watcher]);
}

/** Show a just-started job as running, unless its finished event already arrived. */
export function showStartedJob(jobId: string, meta: { kind: JobKind; paperId: string | null }): void {
  if (recentlyFinished.has(jobId)) return;
  useStore.getState().addJob({
    job_id: jobId,
    paper_id: meta.paperId,
    kind: meta.kind,
    message: "準備中...",
    status: "running",
  });
}

/** Start a sidecar job and show it as running before the first progress event. */
export async function startJob(
  path: string,
  body: unknown,
  meta: { kind: JobKind; paperId: string | null },
  watcher?: Watcher,
): Promise<string> {
  const response = await apiRequest<{ job_id: string }>("POST", path, body ?? {});
  showStartedJob(response.job_id, meta);
  if (watcher) watchJob(response.job_id, watcher);
  return response.job_id;
}

/** Cancel the jobs of the paper on screen and library-wide jobs, like the old 中止 button. */
export async function cancelVisibleJobs(): Promise<boolean> {
  const { activeJobs, activePaperId, setStatus } = useStore.getState();
  const targets = activeJobs.filter((j) => isRunning(j) && (j.paper_id === activePaperId || !j.paper_id));
  if (!targets.length) {
    setStatus("現在表示中の論文で実行中の処理はありません。他の論文の処理は、ステータスバーの処理一覧から個別に中止できます。");
    return false;
  }
  await Promise.all(targets.map((j) => apiRequest("POST", `/api/jobs/${j.job_id}/cancel`).catch(() => undefined)));
  markCancelling(targets.map((j) => j.job_id));
  return true;
}

/**
 * Say 「中止しています…」 until these jobs end, whatever way they end (handleFinished). Not for jobs
 * whose finished event came before the answer to the cancel request: their outcome is already shown.
 */
function markCancelling(jobIds: string[]): void {
  const pending = jobIds.filter((id) => !recentlyFinished.has(id));
  if (!pending.length) return;
  pending.forEach((id) => cancelRequested.add(id));
  useStore.getState().setStatus(CANCELLING_STATUS);
}

/** A job asked to stop has ended: true if it was one. */
function endCancelling(event: JobFinished): boolean {
  if (!cancelRequested.delete(event.job_id)) return false;
  const next = statusWhenCancelEnds(event.status, cancelRequested.size > 0, event.error);
  const store = useStore.getState();
  if (next !== null && store.statusMessage === CANCELLING_STATUS) store.setStatus(next);
  return true;
}

/** After reconnecting: jobs that ended while the event stream was down will send no finished event. */
function forgetEndedCancels(running: string[]): void {
  for (const id of [...cancelRequested]) if (!running.includes(id)) cancelRequested.delete(id);
  const store = useStore.getState();
  if (!cancelRequested.size && store.statusMessage === CANCELLING_STATUS) store.setStatus("");
}

/** Cancel one job, whichever paper it belongs to (the status bar's job list); false if the request failed. */
export async function cancelJob(jobId: string): Promise<boolean> {
  try {
    await apiRequest("POST", `/api/jobs/${jobId}/cancel`);
    markCancelling([jobId]);
    return true;
  } catch (error) {
    // 404: the job has just finished by itself.
    if (error instanceof ApiError && error.status === 404) return true;
    useStore.getState().setStatus(`中止できませんでした：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** The paper's name as the library shows it, from the loaded lists when possible; null if unknown. */
async function paperTitle(queryClient: QueryClient, paperId: string): Promise<string | null> {
  for (const [, data] of queryClient.getQueriesData<PaperData | PaperData[] | null>({ queryKey: [QK.papers] })) {
    const paper = Array.isArray(data) ? data.find((p) => p?.id === paperId) : data?.id === paperId ? data : null;
    if (paper) return paperDisplayName(paper) || null;
  }
  try {
    const paper = await queryClient.fetchQuery({
      queryKey: [QK.papers, paperId],
      queryFn: () => apiRequest<PaperData>("GET", `/api/papers/${paperId}`),
    });
    return paper ? paperDisplayName(paper) || null : null;
  } catch {
    return null; // Removed meanwhile.
  }
}

/**
 * A failed job: in the error dialog when its paper is on screen (or it is library-wide), else as a
 * notice in the corner and a mark on the paper's library row, so reading another paper goes on.
 */
async function reportFailure(event: JobFinished, visible: boolean, queryClient: QueryClient): Promise<void> {
  const message = event.error || "不明なエラー";
  const handler = jobHandler(event.kind);
  const advice = errorAdvice(message, { kind: event.kind, canResume: !!handler?.resume });
  if (visible) useStore.getState().setStatus(`${jobKindLabel(event.kind)}を完了できませんでした：${advice.summary}`);
  shell.setProgress("error").catch(() => undefined);
  const title = event.paper_id ? await paperTitle(queryClient, event.paper_id) : null;
  notifyIfAway(failureTitle(event.kind, title), advice.summary);
  const report: ErrorReport = {
    id: `job-${event.job_id}`,
    title: failureTitle(event.kind),
    message,
    paperId: event.paper_id,
    paperTitle: title,
    kind: event.kind,
    jobId: event.job_id,
    resume: handler?.resume && { label: handler.resume.label, run: () => handler.resume?.run(event) },
    at: Date.now(),
  };
  if (visible || !event.paper_id) {
    useErrorDialog.getState().report(report);
    return;
  }
  const paperId = event.paper_id;
  addJobFailure(report);
  showToast({
    id: `job-failure-${paperId}`,
    title: backgroundFailureTitle(event.kind, title),
    description: advice.summary,
    tone: "error",
    action: { label: "詳細", run: () => showJobFailure(paperId) },
  });
}

function handleSuccess(event: JobFinished, visible: boolean, queryClient: QueryClient): void {
  const usage: Usage | null = event.result?.usage ?? null;
  if (usage) useLastUsage.setState({ usage, kind: event.kind });
  const withUsage = (message: string) => usage ? `${message}（${usageSummary(usage)}）` : message;
  const status = (message: string) => {
    if (visible) useStore.getState().setStatus(withUsage(message));
  };
  const done: JobContext["done"] = async (message, options = {}) => {
    // Named only when another paper is on screen; the paper may have been removed meanwhile.
    const paper = !visible && event.paper_id ? await paperTitle(queryClient, event.paper_id) : null;
    const title = options.title && !paper ? options.title : doneTitle(event.kind, paper);
    const description = withUsage(message);
    const tone = options.tone ?? "success";
    showToast({
      id: `job-done-${event.kind}-${event.paper_id ?? "library"}`,
      title,
      description: description || undefined,
      tone,
      timeout: readingTime(title + description, 6_000, tone === "info" ? 30_000 : 15_000),
      // Another paper that could not be found has been removed: nothing to open.
      action: !visible && event.paper_id && !paper ? undefined : options.action,
    });
  };
  jobHandler(event.kind)?.succeeded?.(event, { visible, status, done });
  if (event.paper_id) clearJobFailure(event.paper_id, event.kind);
}

function handleFinished(event: JobFinished, queryClient: QueryClient): void {
  const store = useStore.getState();
  const visible = !event.paper_id || event.paper_id === store.activePaperId;
  // First, so that a status set below (a job's own outcome) is not cleared.
  const cancelAsked = endCancelling(event);
  if (event.status === "succeeded") {
    handleSuccess(event, visible, queryClient);
  } else if (event.status === "cancelled") {
    if (visible && !cancelAsked) store.setStatus(event.error || "中止しました。");
  } else {
    void reportFailure(event, visible, queryClient);
  }

  // Any job may change the list and the paper's state; the job's feature names what else is stale
  // (also after a failure, which may have hit the plan limit).
  const stale = [[QK.papers], [QK.collections], ...(jobHandler(event.kind)?.refresh?.(event) ?? [])];
  if (isJobKind(event.kind, AI_PLAN_JOBS)) stale.push([QK.usageLimits]);
  if (event.paper_id) stale.push([QK.article, event.paper_id], [QK.messages, event.paper_id], [QK.reading, event.paper_id]);
  stale.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));

  recentlyFinished.set(event.job_id, event);
  setTimeout(() => recentlyFinished.delete(event.job_id), 60_000);
  const pending = watchers.get(event.job_id) ?? [];
  watchers.delete(event.job_id);
  pending.forEach((watcher) => watcher(event));
}

function syncTaskbar(jobs: Job[]): void {
  const running = jobs.filter(isRunning);
  if (!running.length) {
    shell.setProgress("none").catch(() => undefined);
    return;
  }
  // Show the paper on screen first, like the old status line.
  const { activePaperId } = useStore.getState();
  const job = running.find((j) => j.paper_id === activePaperId) ?? running.find((j) => !j.paper_id) ?? running[0];
  if (job.total && job.total > 0 && job.done != null) shell.setProgress("normal", job.done, job.total).catch(() => undefined);
  else shell.setProgress("indeterminate").catch(() => undefined);
}

/** One WebSocket for the whole app; mounted at the root so focus mode keeps it alive. */
export function useJobEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Set while the stream is open: the first retry after a drop comes at once, sooner than the
    // banner's grace (RECONNECT_GRACE_MS), so a brief drop passes unnoticed; later ones every 3 s.
    let wasOpen = false;

    const refreshJobs = async () => {
      try {
        const serverJobs = await apiRequest<any[]>("GET", "/api/jobs");
        const running = serverJobs.filter((j) => j.running);
        forgetEndedCancels(running.map((j) => j.job_id));
        useStore.setState({
          activeJobs: running.map((j) => ({
            job_id: j.job_id, paper_id: j.paper_id, kind: j.kind, message: j.message,
            done: j.done, total: j.total, status: "running" as const,
          })),
        });
      } catch {
        // The sidecar may still be starting; the next reconnect retries.
      }
    };

    const connect = () => {
      const url = new URL(`ws://127.0.0.1:${backendPort()}/ws/events`);
      const token = authToken();
      if (token) url.searchParams.set("token", token);
      ws = new WebSocket(url);
      ws.onopen = () => {
        // Events sent while the stream was down are lost: the running jobs are read again, and what
        // a missed library.changed or job.finished would have refreshed is refreshed now.
        if (useConnection.getState().everConnected) {
          for (const root of [QK.papers, QK.collections, QK.librarySearch, QK.tags, QK.reading]) {
            queryClient.invalidateQueries({ queryKey: [root] });
          }
        }
        wasOpen = true;
        markConnected();
        void refreshJobs();
      };
      ws.onmessage = (message) => {
        let data: any;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        const store = useStore.getState();
        if (data.type === "job.started") {
          store.addJob({ job_id: data.job_id, paper_id: data.paper_id, kind: data.kind, message: data.message, status: "running" });
        } else if (data.type === "job.progress") {
          store.addJob({
            job_id: data.job_id, paper_id: data.paper_id, kind: data.kind,
            message: data.message, done: data.done, total: data.total, status: "running",
          });
        } else if (data.type === "job.page_ready") {
          if (data.paper_id) {
            queryClient.invalidateQueries({ queryKey: [QK.reading, data.paper_id] });
            queryClient.invalidateQueries({ queryKey: [QK.paperSearch, data.paper_id] });
          }
        } else if (data.type === "job.finished") {
          store.removeJob(data.job_id);
          handleFinished(data as JobFinished, queryClient);
        } else if (data.type === "library.changed") {
          for (const root of [QK.papers, QK.collections, QK.librarySearch, QK.tags]) {
            queryClient.invalidateQueries({ queryKey: [root] });
          }
        } else if (data.type === "import.pages") {
          setPendingPages(data.pages ?? {});
        } else if (data.type === "import.item") {
          // Keep the placeholder until the real row is in the list, so nothing flickers.
          queryClient.invalidateQueries({ queryKey: [QK.collections] });
          queryClient.invalidateQueries({ queryKey: [QK.papers] }).finally(() => removePendingImports([data.path]));
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        markDisconnected();
        reconnect = setTimeout(connect, wasOpen ? QUICK_RECONNECT_MS : 3000);
        wasOpen = false;
      };
    };

    connect();
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.activeJobs !== prev.activeJobs || s.activePaperId !== prev.activePaperId) syncTaskbar(s.activeJobs);
    });
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      unsubscribe();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [queryClient]);
}
