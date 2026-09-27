import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DELAY_MS, PublishSchedule } from "../src/features/settings/autoSyncSchedule.ts";

const MINUTE = 60_000;

test("changes are published once the library stops changing between two checks", () => {
  const schedule = new PublishSchedule();
  assert.equal(schedule.due({ action: "none", local_version: "a" }, 0), false);
  assert.equal(schedule.due({ action: "quiet", local_version: "b" }, MINUTE), false); // still being edited
  assert.equal(schedule.due({ action: "quiet", local_version: "b" }, 2 * MINUTE), true);
  schedule.synced();
  assert.equal(schedule.due({ action: "none", local_version: "b" }, 3 * MINUTE), false);
});

test("while edits go on, changes wait at most MAX_DELAY_MS", () => {
  const schedule = new PublishSchedule();
  schedule.due({ action: "none", local_version: "0" }, 0);
  let now = 0;
  let hash = 0;
  const due: number[] = [];
  while (now < MAX_DELAY_MS + 2 * MINUTE) {
    now += MINUTE;
    if (schedule.due({ action: "quiet", local_version: String(++hash) }, now)) { due.push(now); schedule.synced(); }
  }
  assert.deepEqual(due, [MAX_DELAY_MS + MINUTE]);
});

test("the first check after launch, another PC's library and a conflict do not wait", () => {
  assert.equal(new PublishSchedule().due({ action: "quiet", local_version: "a" }, 0), true);
  const schedule = new PublishSchedule();
  schedule.due({ action: "none", local_version: "a" }, 0);
  assert.equal(schedule.due({ action: "pull", local_version: "a" }, MINUTE), true);
  assert.equal(schedule.due({ action: "quiet", local_version: "a" }, 2 * MINUTE), true); // nothing changing here
  assert.equal(schedule.due({ action: "quiet", local_version: null }, 3 * MINUTE), false); // the check failed
  assert.equal(schedule.due({ action: "quiet", local_version: null }, 4 * MINUTE), true);
});

test("the first sync after launch has the waiting screen, so another PC's newer library is taken in before editing", () => {
  const schedule = new PublishSchedule();
  // Until the sidecar has hashed the library, the check cannot tell a take-in from a publication.
  const unverified = { action: "quiet", local_version: null } as const;
  assert.equal(schedule.next(unverified, 5_000, true), null); // waits while a draft is open
  assert.equal(schedule.next(unverified, MINUTE, false), "screen");
  schedule.synced();
  // From then on, this PC's changes go in the background; taking in keeps the waiting screen.
  schedule.next({ action: "none", local_version: "a" }, 2 * MINUTE, false);
  assert.equal(schedule.next({ action: "quiet", local_version: "b" }, 3 * MINUTE, false), null); // still editing
  assert.equal(schedule.next({ action: "quiet", local_version: "b" }, 4 * MINUTE, false), "background");
  schedule.synced();
  assert.equal(schedule.next({ action: "pull", local_version: "b" }, 5 * MINUTE, true), null);
  assert.equal(schedule.next({ action: "pull", local_version: "b" }, 6 * MINUTE, false), "screen");
});

test("with nothing to take in at launch, later changes need no waiting screen", () => {
  const schedule = new PublishSchedule();
  assert.equal(schedule.next({ action: "none", local_version: null }, 0, false), null);
  assert.equal(schedule.next({ action: "quiet", local_version: null }, MINUTE, false), "background");
});

test("a take-in a background sync deferred runs at once with the waiting screen, unless a draft is open", () => {
  const schedule = new PublishSchedule();
  assert.equal(schedule.afterBackground("deferred", false), "screen");
  assert.equal(schedule.afterBackground("deferred", true), null); // the next check offers it again ("pull")
  assert.equal(schedule.afterBackground("synced", false), null);
  assert.equal(schedule.afterBackground(undefined, false), null);
});
