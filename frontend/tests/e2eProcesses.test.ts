import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { killTree, PYTHON, sweepLeftovers } from "../e2e/lib/processes.ts";

test("E2E cleanup stops its marked processes and leaves a parallel pytest sidecar alone", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async (t) => {
  const since = new Date();
  const runDir = path.join(os.tmpdir(), `papeer-e2e-cleanup-test-${process.pid}`);
  // Both are harmless Node processes; the unrelated one's arguments reproduce the old Python match.
  const start = (args: string[]) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
    stdio: "ignore", windowsHide: true,
  });
  const ours = start(["--papeer-e2e-run", runDir]);
  const unrelated = start([PYTHON, "-m", "sidecar"]);
  t.after(async () => { await killTree(ours); await killTree(unrelated); });
  await Promise.all([once(ours, "spawn"), once(unrelated, "spawn")]);
  const exited = once(ours, "exit");
  assert.ok(sweepLeftovers(since, runDir) >= 1); // Windows may also start a console host below it.
  await exited;
  assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});
