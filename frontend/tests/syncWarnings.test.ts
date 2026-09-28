import assert from "node:assert/strict";
import { test } from "node:test";
import { clearsOnReconnect, isAutoSyncFailure, nextSyncWarning, SYNC_WARNINGS } from "../src/features/settings/syncWarnings.ts";

test("a sync state to act on is told when it begins, not at every automatic sync", () => {
  let shown = null as ReturnType<typeof nextSyncWarning>["shown"];
  const run = (outcome: Parameters<typeof nextSyncWarning>[1]) => {
    const next = nextSyncWarning(shown, outcome);
    shown = next.shown;
    return next.tell;
  };
  assert.equal(run("conflict"), true);
  assert.equal(run("conflict"), false);
  assert.equal(run("conflict"), false);
  assert.equal(run("review"), true, "another state is told");
  assert.equal(run(null), false, "a sync that went through tells nothing here");
  assert.equal(run("conflict"), true, "a conflict after a good sync is new");
  assert.equal(run("failed"), true);
  assert.equal(run("failed"), false);
});

test("each warning names where to act", () => {
  for (const warning of Object.values(SYNC_WARNINGS)) assert.match(warning.description, /設定 → 保存先・同期/);
});

test("an unreachable sidecar or a library without a sync is not a failed sync", () => {
  // The state could not be read: the sidecar down (ApiError status 0), which the connection banner tells.
  assert.equal(isAutoSyncFailure({ syncOn: false, status: 0 }), false);
  assert.equal(isAutoSyncFailure({ syncOn: true, status: 0 }), false);
  // No sync set up, or not known to be on yet: nothing to fail.
  assert.equal(isAutoSyncFailure({ syncOn: false, status: 500 }), false);
  assert.equal(isAutoSyncFailure({ syncOn: false }), false);
  // The sync ran and went wrong.
  assert.equal(isAutoSyncFailure({ syncOn: true, status: 500 }), true);
  assert.equal(isAutoSyncFailure({ syncOn: true }), true);
});

test("once reconnected, only a failure told while the sidecar was out of reach goes", () => {
  assert.equal(clearsOnReconnect("failed", true), true);
  assert.equal(clearsOnReconnect("failed", false), false);
  assert.equal(clearsOnReconnect("conflict", true), false, "a conflict waits for the user's answer");
  assert.equal(clearsOnReconnect(null, true), false);
});
