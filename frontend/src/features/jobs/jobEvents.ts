import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, apiRequest, authToken, backendPort, unwrap } from "@/api/client";
import { invalidate } from "@/api/mutations";
import { getPaper, paperDisplayName, type PaperData } from "@/api/hooks";
import type { JobInfo, JobStarted, ServerEvent } from "@/api/jobTypes";
import { isRunning, useStore, type Job } from "@/store";
import { notifyIfAway, shell } from "@/shell";
import { removePendingImports, setPendingPages } from "@/app/pendingImports";
import { useErrorDialog } from "@/components/errorDialog";
import { showToast } from "@/components/toast";
import { errorAdvice, type ErrorReport } from "@/lib/errorReports";
import { QK } from "@/lib/queryKeys";
import { requestLibraryRefresh } from "@/lib/libraryRefresh";
import { useLastUsage, usageSummary, type Usage } from "@/lib/usage";
import { readingTime } from "@/lib/statusLifetime";
import { markConnected, markDisconnected, useConnection } from "./connection";
import { handlePaperChanged, refreshPaper } from "./paperRefresh";
import { addJobFailure, clearJobFailure, showJobFailure } from "./jobFailures";
import { jobHandler, type JobContext, type JobFinished, type JobSucceeded } from "./jobHandlers";
import { AI_PLAN_JOBS, isJobKind, type JobKind } from "./jobKinds";
import { backgroundFailureTitle, doneTitle, failureTitle, jobKindLabel, QUICK_RECONNECT_MS, statusWhenCancelEnds } from "./jobList";
import { endedWhileAway, lostJob, settledJob, shownJob, stillRunning } from "./jobReconnect";

export type { JobFinished } from "./jobHandlers";

type Watcher<K extends JobKind = JobKind> = (event: JobFinished<K>) => void;
type JobMeta = { kind: JobKind; paperId: string | null };

/** Shown from a cancel request until the job ends, which replaces it (see markCancelling). */
const CANCELLING_STATUS = "中止しています… API通信中の場合は応答またはタイムアウトまで待ちます。";

// Jobs asked to stop that have not ended yet; while any is left, the status says CANCELLING_STATUS.
const cancelRequested = new Set<string>();

// With the job's kind and paper, to tell its watchers how it ended should the sidecar have forgotten it.
const watchers = new Map<string, JobMeta & { callbacks: Watcher[] }>();
// A fast job can finish before its starter registers a watcher; also keeps an end from being handled twice.
const recentlyFinished = new Map<string, JobFinished>();

/** Run `watcher` once when the job ends (immediately if it already has). */
function watchJob<K extends JobKind>(jobId: string, meta: { kind: K; paperId: string | null }, watcher: Watcher<K>): void {
  // A job's end is of the kind it was started as, the only events this watcher is given.
  const callback = watcher as unknown as Watcher;
  const finished = recentlyFinished.get(jobId);
  if (finished) {
    callback(finished);
    return;
  }
  const entry = watchers.get(jobId) ?? { ...meta, callbacks: [] };
  watchers.set(jobId, { ...entry, callbacks: [...entry.callbacks, callback] });
}

/**
 * Show a just-started job as running, unless its finished event already arrived, or its job.started or
 * a progress event did (they often come before the answer to the request that started it): its message,
 * such as 「… 1/2」, is not put back to 準備中.
 */
export function showStartedJob(jobId: string, meta: { kind: JobKind; paperId: string | null }): void {
  if (recentlyFinished.has(jobId) || useStore.getState().activeJobs.some((job) => job.job_id === jobId)) return;
  useStore.getState().addJob({
    job_id: jobId,
    paper_id: meta.paperId,
    kind: meta.kind,
    message: "準備中...",
    status: "running",
  });
}

/** POST /api/jobs/{id}/cancel: asks the job to stop (it ends with job.finished, cancelled); 404 when it has ended already. */
export function requestCancel(jobId: string): Promise<unknown> {
  return unwrap(api.POST("/api/jobs/{job_id}/cancel", { params: { path: { job_id: jobId } } }));
}

/**
 * Start a sidecar job and show it as running before the first progress event. `path` is any of the
 * sidecar's job routes (answering JobStarted), which is why this one request stays untyped (apiRequest).
 */
export async function startJob<K extends JobKind>(
  path: string,
  body: unknown,
  meta: { kind: K; paperId: string | null },
  watcher?: Watcher<K>,
): Promise<string> {
  const response = await apiRequest<JobStarted>("POST", path, body ?? {});
  showStartedJob(response.job_id, meta);
  if (watcher) watchJob(response.job_id, meta, watcher);
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
  await Promise.all(targets.map((j) => requestCancel(j.job_id).catch(() => undefined)));
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
    await requestCancel(jobId);
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
      queryFn: () => getPaper(paperId),
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

/** The AI usage a succeeded job reports, if its kind reports one. */
function resultUsage(event: JobSucceeded): Usage | null {
  switch (event.kind) {
    case "translate": case "revision": case "article": case "ask":
      return event.result.usage ?? null;
    default:
      return null;
  }
}

function handleSuccess(event: JobSucceeded, visible: boolean, queryClient: QueryClient): void {
  const usage = resultUsage(event);
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
  // Once only: after a reconnect, a job asked about may also send its job.finished.
  if (recentlyFinished.has(event.job_id)) return;
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
  // (also after a failure, which may have hit the plan limit). A job of one paper changes only its row.
  const stale = [...(event.paper_id ? [] : [[QK.papers], [QK.collections]]), ...(jobHandler(event.kind)?.refresh?.(event) ?? [])];
  if (isJobKind(event.kind, AI_PLAN_JOBS)) stale.push([QK.usageLimits]);
  if (event.paper_id) stale.push([QK.article, event.paper_id], [QK.messages, event.paper_id], [QK.reading, event.paper_id]);
  stale.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
  if (event.paper_id) void refreshPaper(queryClient, event.paper_id);

  recentlyFinished.set(event.job_id, event);
  setTimeout(() => recentlyFinished.delete(event.job_id), 60_000);
  const pending = watchers.get(event.job_id)?.callbacks ?? [];
  watchers.delete(event.job_id);
  pending.forEach((watcher) => watcher(event));
}

/**
 * A job that ended while the event stream was down: handled as its job.finished would have been, from
 * how the sidecar says it ended. One the sidecar no longer knows ends as a failure (lostJob), so that
 * what waits on it is released; while the sidecar cannot be reached, it stays for the next reconnect.
 * One still running (started after the job list was read) is shown in the list again.
 */
async function settleEndedJob(jobId: string, meta: JobMeta | null, queryClient: QueryClient): Promise<void> {
  const handled = (id: string) => recentlyFinished.has(id);
  let event: JobFinished | null;
  try {
    const settled = settledJob(await unwrap(api.GET("/api/jobs/{job_id}", { params: { path: { job_id: jobId } } })) as JobInfo, handled);
    if (settled && "running" in settled) useStore.getState().addJob(settled.running);
    event = settled && "finished" in settled ? settled.finished : null;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) return;
    event = meta && lostJob(jobId, meta);
  }
  if (event) handleFinished(event, queryClient);
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
        const serverJobs = await unwrap(api.GET("/api/jobs")) as JobInfo[];
        // Not those whose job.finished came first on the new stream.
        const running = stillRunning(serverJobs, (id) => recentlyFinished.has(id));
        const runningIds = running.map((j) => j.job_id);
        // Those waited on, and those shown as running, that have ended meanwhile.
        const shown = useStore.getState().activeJobs;
        const metaOf = (jobId: string): JobMeta | null => {
          const watched = watchers.get(jobId);
          if (watched) return { kind: watched.kind, paperId: watched.paperId };
          const job = shown.find((j) => j.job_id === jobId);
          return job?.kind ? { kind: job.kind, paperId: job.paper_id ?? null } : null;
        };
        const ended = endedWhileAway(runningIds, [...watchers.keys(), ...shown.map((j) => j.job_id)], (id) => recentlyFinished.has(id));
        forgetEndedCancels(runningIds);
        useStore.setState({ activeJobs: running.map(shownJob) });
        for (const jobId of ended) void settleEndedJob(jobId, metaOf(jobId), queryClient);
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
        // Events sent while the stream was down are lost: the running jobs are read again (and those that
        // ended meanwhile asked about), and what a missed library.changed would have refreshed is refreshed now.
        if (useConnection.getState().everConnected) void invalidate({ kind: "reconnected" }, queryClient);
        wasOpen = true;
        markConnected();
        void refreshJobs();
      };
      ws.onmessage = (message) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(message.data) as ServerEvent;
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
          if (data.paper_id) void invalidate({ kind: "pageTranslated", paperId: data.paper_id }, queryClient);
        } else if (data.type === "job.finished") {
          store.removeJob(data.job_id);
          handleFinished(data, queryClient);
        } else if (data.type === "paper.changed") {
          handlePaperChanged(queryClient, data.paper_id, data.fields ?? undefined);
        } else if (data.type === "library.changed") {
          // Once the events stop coming, and not while an action on several papers runs (libraryRefresh.ts).
          requestLibraryRefresh(() => void invalidate({ kind: "library" }, queryClient));
        } else if (data.type === "import.pages") {
          setPendingPages(data.pages);
        } else if (data.type === "import.item") {
          // Keep the placeholder until the real row is in the list, so nothing flickers.
          void invalidate({ kind: "folders" }, queryClient).finally(() => removePendingImports([data.path]));
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
