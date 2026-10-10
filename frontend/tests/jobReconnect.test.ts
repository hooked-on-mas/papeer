import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobInfo } from "../src/api/jobTypes.ts";
import { endedWhileAway, hasFailed, LOST_JOB_ERROR, lostJob, settledJob, shownJob, stillRunning } from "../src/features/jobs/jobReconnect.ts";
import { errorAdvice, errorCause } from "../src/lib/errorReports.ts";

const base = { paper_id: null, message: "", done: null, total: null, cancelled: false } as const;

function running(jobId: string): JobInfo {
  return { ...base, job_id: jobId, kind: "drive-sync", status: "running", running: true, result: null, error: null };
}

test("after a reconnect, the awaited jobs that no longer run are asked about once", () => {
  const handled = new Set(["seen"]);
  // "sync" waited on (DriveSection's Promise) and shown in the job list: asked once.
  const ended = endedWhileAway(["running"], ["sync", "running", "seen", "sync", "shown"], (id) => handled.has(id));
  assert.deepEqual(ended, ["sync", "shown"]);
  assert.deepEqual(endedWhileAway(["a"], [], () => false), []);
});

test("a job whose job.finished came before the list's answer is not shown as running again", () => {
  // Otherwise it would stay 「実行中」 and hold up the automatic sync and backups.
  const handled = new Set(["finished-first"]);
  const jobs = stillRunning([running("finished-first"), running("still")], (id) => handled.has(id));
  assert.deepEqual(jobs.map((job) => job.job_id), ["still"]);
  assert.deepEqual(shownJob(jobs[0]), {
    job_id: "still", paper_id: null, kind: "drive-sync", message: "", done: null, total: null, status: "running",
  });
});

test("a job asked about is handled as its job.finished, or shown again while it still runs", () => {
  const synced: JobInfo = {
    ...base, job_id: "a", kind: "drive-sync", status: "succeeded", running: false, result: { status: "synced", reloaded: false }, error: null,
  };
  assert.deepEqual(settledJob(synced, () => false), { finished: synced });
  // It started after the list was read, so it had left the list: back in it.
  assert.deepEqual(settledJob(running("b"), () => false), { running: shownJob(running("b")) });
  // Its job.finished came meanwhile: nothing more to do.
  assert.equal(settledJob(synced, () => true), null);
  assert.equal(settledJob(running("b"), () => true), null);
});

test("a job the sidecar no longer knows ends as a failure, so that its watchers are released", () => {
  const event = lostJob("gone", { kind: "drive-sync", paperId: null });
  assert.equal(event.status, "failed");
  assert.equal(event.error, LOST_JOB_ERROR);
  assert.equal(event.kind, "drive-sync");
  assert.equal(event.running, false);
  assert.equal(event.result, null);
  assert.deepEqual(lostJob("x", { kind: "translate", paperId: "p" }).paper_id, "p");
  // Told in its own words, never as an AI or connection problem, whatever the job.
  for (const kind of ["translate", "ask", "check", "drive-sync", "import"]) assert.equal(errorCause(LOST_JOB_ERROR, kind), "other");
  assert.equal(errorAdvice(LOST_JOB_ERROR, { kind: "translate" }).summary, LOST_JOB_ERROR);
});

test("on the first connection, the queries that gave up are loaded again, those loading or loaded are not", () => {
  const state = (status: string, fetchStatus: string) => ({ state: { status, fetchStatus } });
  assert.equal(hasFailed(state("error", "idle")), true);
  assert.equal(hasFailed(state("error", "fetching")), false);
  assert.equal(hasFailed(state("success", "idle")), false);
  assert.equal(hasFailed(state("pending", "fetching")), false);
});
