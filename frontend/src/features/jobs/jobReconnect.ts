/**
 * After the event stream reconnects: the jobs that ended while it was down sent a job.finished nobody
 * received, so what waited on them (a watcher, such as the sync's Promise, or the job list) would wait
 * for ever. They are asked about through GET /api/jobs/{job_id} (the sidecar keeps the last finished
 * jobs, FINISHED_JOBS_KEPT in sidecar/jobs.py). Kept free of React and the stores for tests/jobReconnect.test.ts.
 */
import type { JobFinished, JobInfo, JobKind } from "@/api/jobTypes";
import type { Job } from "@/store";

/**
 * A job the sidecar no longer knows: it restarted meanwhile (the job was cut off), or has forgotten it
 * (many jobs ended since). Either way its outcome is unknown.
 */
export const LOST_JOB_ERROR = "接続が切れている間に処理の状態が分からなくなりました（中断された可能性があります）。結果を確かめ、必要ならやり直してください。";

/**
 * The jobs to show as running, from GET /api/jobs: not those whose job.finished has already come in
 * `handled` (it may arrive on the new stream before the list's answer), which would stay shown as
 * running and hold up the automatic sync and backups.
 */
export function stillRunning(jobs: readonly JobInfo[], handled: (jobId: string) => boolean): JobInfo[] {
  return jobs.filter((job) => job.running && !handled(job.job_id));
}

/** A running job as the job list shows it. */
export function shownJob(job: JobInfo): Job {
  return { job_id: job.job_id, paper_id: job.paper_id, kind: job.kind, message: job.message,
    done: job.done, total: job.total, status: "running" };
}

/** The jobs to ask about: awaited ones that no longer run and whose end has not been handled. */
export function endedWhileAway(running: readonly string[], awaited: Iterable<string>, handled: (jobId: string) => boolean): string[] {
  const ended = new Set<string>();
  for (const jobId of awaited) if (!running.includes(jobId) && !handled(jobId)) ended.add(jobId);
  return [...ended];
}

/**
 * What to do with a job asked about: handle its end as its job.finished would have been, or show it
 * as running again (it had left the list, having started after that was read); null when its end has
 * been handled meanwhile.
 */
export function settledJob(job: JobInfo, handled: (jobId: string) => boolean):
    { finished: JobFinished } | { running: Job } | null {
  if (handled(job.job_id)) return null;
  return job.running ? { running: shownJob(job) } : { finished: job };
}

/** The end of a job the sidecar answers 404 for, told as a failure so that what waits on it is released. */
export function lostJob(jobId: string, meta: { kind: JobKind; paperId: string | null }): JobFinished {
  return {
    job_id: jobId, paper_id: meta.paperId, kind: meta.kind, message: "", done: null, total: null, cancelled: false,
    status: "failed", running: false, result: null, error: LOST_JOB_ERROR,
  };
}

/**
 * Whether a query's last attempt failed and nothing is fetching it now. On the first connection of the
 * event stream these are loaded again: the sidecar may have taken a long while to answer (a handover from
 * the CLI's sidecar takes up to some 30 seconds), and a query's retries are over long before.
 */
export function hasFailed(query: { state: { status: string; fetchStatus: string } }): boolean {
  return query.state.status === "error" && query.state.fetchStatus === "idle";
}
