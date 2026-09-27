import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSyncWarning, SYNC_WARNINGS } from "../src/features/settings/syncWarnings.ts";

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
