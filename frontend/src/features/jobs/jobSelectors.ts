/**
 * What the screen needs to know about the running jobs, picked out of the store's activeJobs.
 *
 * Progress events replace activeJobs many times a second while a job runs, so a component that
 * selects the whole array renders again on every event, whichever job it is about. Components
 * select through these instead: a boolean, a count or one job, which zustand compares with
 * Object.is (statusJob, with two values, through useShallow). upsertJob keeps the objects of the
 * jobs it doesn't change, so a selected job stays the same object until its own event comes.
 * Kept apart from the store so that they can be tested.
 */
import type { Job } from "../../store/index.ts";
import { isJobKind, type JobKind } from "./jobKinds.ts";

export function isRunning(job: Job): boolean {
  return (job.status ?? "running") === "running";
}

/** activeJobs with `job` added, or merged into the entry of the same job_id; the other entries are kept as they are. */
export function upsertJob(jobs: Job[], job: Job): Job[] {
  return jobs.some((j) => j.job_id === job.job_id)
    ? jobs.map((j) => j.job_id === job.job_id ? { ...j, ...job } : j)
    : [...jobs, job];
}

export function anyJobRunning(jobs: Job[]): boolean {
  return jobs.some(isRunning);
}

/** Whether a job of `paperId` runs, leaving out the kinds in `ignore`. */
export function paperBusy(jobs: Job[], paperId: string | null, ignore: readonly JobKind[] = []): boolean {
  return !!paperId && jobs.some((j) => isRunning(j) && j.paper_id === paperId && !isJobKind(j.kind, ignore));
}

/** How far a job has got, as 「1/2」, or "" before it has counted anything. */
export function jobCount(job: Job | undefined): string {
  return job && typeof job.done === "number" && typeof job.total === "number" && job.total > 0 ? `${job.done}/${job.total}` : "";
}

/** The running job of `paperId`, of one of `kinds` when given; none without a paper. */
export function runningPaperJob(jobs: Job[], paperId: string | null, kinds?: readonly JobKind[]): Job | undefined {
  if (!paperId) return undefined;
  return jobs.find((j) => j.paper_id === paperId && isRunning(j) && (!kinds || isJobKind(j.kind, kinds)));
}

/** What a library row shows: nothing, 「AI処理中」, or the translation's progress bar. */
export type PaperJobState = "idle" | "busy" | "translating";

export function paperJobState(jobs: Job[], paperId: string, translationKinds: readonly JobKind[]): PaperJobState {
  let state: PaperJobState = "idle";
  for (const job of jobs) {
    if (job.paper_id !== paperId || !isRunning(job)) continue;
    if (isJobKind(job.kind, translationKinds)) return "translating";
    state = "busy";
  }
  return state;
}

/**
 * The job the status bar shows, the paper on screen first, then library-wide jobs, as the old status
 * line did; and how many jobs are running. Select it with useShallow: the object is new each time.
 */
export function statusJob(jobs: Job[], activePaperId: string | null): { job: Job | undefined; running: number } {
  const running = jobs.filter(isRunning);
  const job = running.find((j) => j.paper_id === activePaperId) ?? running.find((j) => !j.paper_id);
  return { job, running: running.length };
}
