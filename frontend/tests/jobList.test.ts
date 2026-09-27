import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundFailureTitle, connectionBanner, connectionBannerDelay, failureTitle, FIRST_CONNECT_GRACE_MS, jobCountText,
  jobKindLabel, jobPercent, orderJobs, QUICK_RECONNECT_MS, RECONNECT_GRACE_MS,
} from "../src/features/jobs/jobList.ts";

test("job kinds are named in Japanese, unknown ones as 処理", () => {
  assert.equal(jobKindLabel("translate"), "翻訳");
  assert.equal(jobKindLabel("drive-sync"), "同期");
  assert.equal(jobKindLabel("something-new"), "処理");
  assert.equal(jobKindLabel(undefined), "処理");
});

test("a failure is titled with the paper when there is one", () => {
  assert.equal(failureTitle("translate", "Smith (2020) Paper"), "『Smith (2020) Paper』の翻訳を完了できませんでした");
  assert.equal(failureTitle("drive-sync"), "同期を完了できませんでした");
  assert.equal(failureTitle("article", null), "解説の作成を完了できませんでした");
  assert.equal(backgroundFailureTitle("translate", "Paper"), "『Paper』の翻訳を完了できませんでした");
  assert.equal(backgroundFailureTitle("translate", null), "別の論文の翻訳を完了できませんでした");
});

test("the job list shows the paper on screen, then library-wide jobs, then other papers, each in order", () => {
  const jobs = [
    { job_id: "1", paper_id: "b" },
    { job_id: "2", paper_id: null },
    { job_id: "3", paper_id: "a" },
    { job_id: "4", paper_id: "c" },
    { job_id: "5", paper_id: "a" },
  ];
  assert.deepEqual(orderJobs(jobs, "a").map((j) => j.job_id), ["3", "5", "2", "1", "4"]);
  assert.deepEqual(orderJobs(jobs, null).map((j) => j.job_id), ["2", "1", "3", "4", "5"]);
});

test("progress is known only with a total", () => {
  assert.equal(jobPercent({ done: 3, total: 12 }), 25);
  assert.equal(jobPercent({ done: 20, total: 12 }), 100);
  assert.equal(jobPercent({ done: null, total: 12 }), null);
  assert.equal(jobPercent({ done: 0, total: 0 }), null);
  assert.equal(jobCountText({ done: 3, total: 12 }), "3 / 12");
  assert.equal(jobCountText({ done: 3 }), "");
});

test("the banner shows once a drop has lasted a moment, and goes when reconnected", () => {
  const down = { connected: false, everConnected: true, downSince: 1_000 };
  assert.equal(connectionBanner(down, 1_000 + RECONNECT_GRACE_MS - 1), null);
  assert.match(connectionBanner(down, 1_000 + RECONNECT_GRACE_MS) ?? "", /再接続しています/);
  assert.equal(connectionBanner({ connected: true, everConnected: true, downSince: null }, 99_999), null);
  assert.equal(connectionBannerDelay(down, 1_500), RECONNECT_GRACE_MS - 500);
  assert.equal(connectionBannerDelay(down, 1_000 + RECONNECT_GRACE_MS), null);
  // The first retry comes well before the banner, so a brief drop never shows it.
  assert.ok(QUICK_RECONNECT_MS * 2 < RECONNECT_GRACE_MS);
});

test("while the sidecar starts, the banner waits longer and says so", () => {
  const starting = { connected: false, everConnected: false, downSince: 0 };
  assert.equal(connectionBanner(starting, FIRST_CONNECT_GRACE_MS - 1), null);
  assert.match(connectionBanner(starting, FIRST_CONNECT_GRACE_MS) ?? "", /起動を待っています/);
});

test("no banner while the app is closing (the sidecar stops on purpose)", () => {
  assert.equal(connectionBanner({ connected: false, everConnected: true, downSince: 0 }, 60_000, true), null);
});
