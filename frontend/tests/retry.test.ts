import assert from "node:assert/strict";
import { test } from "node:test";
import { retryUntil } from "../src/lib/retry.ts";

test("retries until the attempt succeeds, repeating the last delay", async () => {
  const slept: number[] = [];
  const failures: number[] = [];
  let calls = 0;
  const value = await retryUntil(async () => {
    calls += 1;
    if (calls < 5) throw new Error("sidecar not up yet");
    return "state";
  }, {
    delays: [10, 20, 30],
    sleep: async (ms) => { slept.push(ms); },
    onFailure: (_error, count) => failures.push(count),
  });
  assert.equal(value, "state");
  assert.deepEqual(slept, [10, 20, 30, 30]);
  assert.deepEqual(failures, [1, 2, 3, 4]);
});

test("stops without a value once stopped, and never calls again after that", async () => {
  let calls = 0;
  let stop = false;
  const value = await retryUntil(async () => {
    calls += 1;
    if (calls === 2) stop = true;
    throw new Error("still failing");
  }, { delays: [0], stopped: () => stop, sleep: async () => undefined });
  assert.equal(value, undefined);
  assert.equal(calls, 2);
});

test("does not try at all when already stopped", async () => {
  let calls = 0;
  const value = await retryUntil(async () => { calls += 1; return 1; }, { delays: [0], stopped: () => true });
  assert.equal(value, undefined);
  assert.equal(calls, 0);
});
