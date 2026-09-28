// Components select what they show of the running jobs through these selectors, and zustand renders
// a component again only when its selected value changes (Object.is, or shallow with useShallow).
// No DOM here to count real renders, so `renders` counts those changes over a store updated the way
// the job events update the app's store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore, type StoreApi } from "zustand/vanilla";
import { shallow } from "zustand/shallow";
import {
  anyJobRunning, jobCount, paperBusy, paperJobState, runningPaperJob, statusJob, upsertJob,
} from "../src/features/jobs/jobSelectors.ts";
import { TRANSLATION_JOBS } from "../src/features/jobs/jobKinds.ts";
import type { Job } from "../src/store/index.ts";

type State = { activeJobs: Job[]; activePaperId: string | null };

function jobStore(activePaperId: string | null = "a") {
  const store = createStore<State>(() => ({ activeJobs: [], activePaperId }));
  // As the store's addJob and removeJob do.
  const add = (job: Job) => store.setState((s) => ({ activeJobs: upsertJob(s.activeJobs, job) }));
  const remove = (id: string) => store.setState((s) => ({ activeJobs: s.activeJobs.filter((j) => j.job_id !== id) }));
  return { store, add, remove };
}

/** How many times a component selecting `selector` would render again, from now on. */
function renders<T>(store: StoreApi<State>, selector: (s: State) => T, equal: (a: T, b: T) => boolean = Object.is) {
  let value = selector(store.getState());
  let count = 0;
  store.subscribe((s) => {
    const next = selector(s);
    if (!equal(value, next)) {
      count += 1;
      value = next;
    }
  });
  return () => count;
}

const progress = (add: (job: Job) => void, job: Job, events: number) => {
  for (let done = 1; done <= events; done++) add({ ...job, done, total: events, message: `翻訳中 ${done}/${events}` });
};

test("another paper's progress leaves a library row as it is; its own row changes when its job starts and ends", () => {
  const { store, add, remove } = jobStore();
  const rowA = renders(store, (s) => paperJobState(s.activeJobs, "a", TRANSLATION_JOBS));
  const rowB = renders(store, (s) => paperJobState(s.activeJobs, "b", TRANSLATION_JOBS));
  const job = { job_id: "t1", paper_id: "a", kind: "translate" as const, status: "running" as const };
  add(job);
  progress(add, job, 50);
  remove("t1");
  assert.equal(rowA(), 2);
  assert.equal(rowB(), 0);
});

test("a row shows 「AI処理中」 for other jobs and the translation above them", () => {
  const jobs: Job[] = [{ job_id: "1", paper_id: "a", kind: "article" }, { job_id: "2", paper_id: "b", kind: "revision" }];
  assert.equal(paperJobState(jobs, "a", TRANSLATION_JOBS), "busy");
  assert.equal(paperJobState([...jobs, { job_id: "3", paper_id: "a", kind: "translate" }], "a", TRANSLATION_JOBS), "translating");
  assert.equal(paperJobState(jobs, "b", TRANSLATION_JOBS), "translating");
  assert.equal(paperJobState([{ job_id: "4", paper_id: "c", kind: "translate", status: "succeeded" }], "c", TRANSLATION_JOBS), "idle");
});

test("booleans for the app and the header change only when the answer does", () => {
  const { store, add, remove } = jobStore();
  const shell = renders(store, (s) => anyJobRunning(s.activeJobs));
  const busy = renders(store, (s) => paperBusy(s.activeJobs, s.activePaperId));
  const job = { job_id: "t1", paper_id: "b", kind: "translate" as const, status: "running" as const };
  add(job);
  progress(add, job, 20);
  remove("t1");
  assert.equal(shell(), 2);
  assert.equal(busy(), 0);
});

test("a selected job stays the same object until its own event, so the chat and the summary skip other jobs' events", () => {
  const { store, add } = jobStore();
  const chat = renders(store, (s) => runningPaperJob(s.activeJobs, s.activePaperId, ["ask"]));
  add({ job_id: "q1", paper_id: "a", kind: "ask", status: "running", message: "回答を作成中…" });
  const asked = runningPaperJob(store.getState().activeJobs, "a", ["ask"]);
  progress(add, { job_id: "t1", paper_id: "a", kind: "translate", status: "running" }, 30);
  assert.equal(runningPaperJob(store.getState().activeJobs, "a", ["ask"]), asked);
  assert.equal(chat(), 1);
  add({ job_id: "q1", message: "参照ページを読んでいます…" });
  assert.equal(chat(), 2);
  assert.equal(runningPaperJob(store.getState().activeJobs, "a", ["ask"])?.message, "参照ページを読んでいます…");
  // Merged into the entry, which keeps what the event left out.
  assert.equal(runningPaperJob(store.getState().activeJobs, "a", ["ask"])?.kind, "ask");
});

test("no paper, no paper job", () => {
  assert.equal(runningPaperJob([{ job_id: "1", paper_id: null, kind: "backup" }], null), undefined);
  assert.equal(paperBusy([{ job_id: "1", paper_id: null }], null), false);
});

test("the status bar follows the paper on screen, and background jobs only by their count", () => {
  const { store, add, remove } = jobStore("a");
  const bar = renders(store, (s) => statusJob(s.activeJobs, s.activePaperId), shallow);
  add({ job_id: "t1", paper_id: "a", kind: "translate", status: "running" });
  progress(add, { job_id: "t2", paper_id: "b", kind: "translate", status: "running" }, 25);
  // t1 started (job and count), then t2 started (count); t2's 25 events change neither.
  assert.equal(bar(), 2);
  assert.equal(statusJob(store.getState().activeJobs, "a").running, 2);
  progress(add, { job_id: "t1", paper_id: "a", kind: "translate", status: "running" }, 3);
  assert.equal(bar(), 5);
  remove("t1");
  // Nothing of the paper on screen: a library-wide job, else only the count.
  assert.deepEqual(statusJob(store.getState().activeJobs, "a"), { job: undefined, running: 1 });
  add({ job_id: "s1", paper_id: null, kind: "drive-sync", status: "running" });
  assert.equal(statusJob(store.getState().activeJobs, "a").job?.job_id, "s1");
});

test("the translation dialog opens while the paper's terms are checked, not while another job runs", () => {
  const checking = [{ job_id: "1", paper_id: "a", kind: "glossary-draft" as const, status: "running" as const }];
  assert.equal(paperBusy(checking, "a"), true);
  assert.equal(paperBusy(checking, "a", ["glossary-draft"]), false);
  assert.equal(paperBusy([...checking, { job_id: "2", paper_id: "a", kind: "article" as const, status: "running" as const }], "a", ["glossary-draft"]), true);
});

test("a job's progress reads as done/total once it has counted", () => {
  assert.equal(jobCount({ job_id: "1", done: 1, total: 2 }), "1/2");
  assert.equal(jobCount({ job_id: "1", done: 0, total: 2 }), "0/2");
  assert.equal(jobCount({ job_id: "1", message: "準備中..." }), "");
  assert.equal(jobCount({ job_id: "1", done: null, total: null }), "");
  assert.equal(jobCount(undefined), "");
});
