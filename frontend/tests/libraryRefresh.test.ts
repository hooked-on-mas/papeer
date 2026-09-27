import assert from "node:assert/strict";
import { test } from "node:test";
import { createRefreshGate, type RefreshTimers } from "../src/lib/libraryRefresh.ts";

/** Timers run by hand: `advance(ms)` moves the clock and runs what is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: RefreshTimers = {
    now: () => now,
    setTimeout: (run, ms) => { const id = next++; due.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id) => { due.delete(id as number); },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const [id, timer] = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !timer) break;
      due.delete(id);
      now = timer.at;
      timer.run();
    }
    now = until;
  };
  return { timers, advance, pending: () => due.size };
}

test("changes in quick succession reload the library once, after they stop", () => {
  const { timers, advance } = fakeTimers();
  const gate = createRefreshGate(timers, 400, 3000);
  const runs: string[] = [];
  gate.request(() => runs.push("a"));
  advance(100);
  gate.request(() => runs.push("b"));
  advance(399);
  assert.deepEqual(runs, []);
  advance(1);
  // Once, with the latest reload asked for.
  assert.deepEqual(runs, ["b"]);
  advance(1000);
  assert.deepEqual(runs, ["b"]);
});

test("changes that keep coming still reload the library every few seconds", () => {
  const { timers, advance } = fakeTimers();
  const gate = createRefreshGate(timers, 400, 1000);
  let runs = 0;
  for (let i = 0; i < 12; i++) {
    gate.request(() => runs++);
    advance(300);
  }
  // Changes 0.3 s apart from 0 to 3.3 s: reloaded at most 1 s after the first change not yet reloaded
  // (at 1 s, 2.2 s and 3.4 s), rather than never while they keep coming.
  assert.equal(runs, 3);
  advance(1000);
  assert.equal(runs, 3);
});

test("while held, changes do not reload the library, and the holder's own reload covers them", () => {
  const { timers, advance, pending } = fakeTimers();
  const gate = createRefreshGate(timers, 400, 3000);
  let runs = 0;
  // A change just before the hold is held too.
  gate.request(() => runs++);
  const release = gate.hold();
  assert.equal(pending(), 0);
  for (let i = 0; i < 10; i++) {
    gate.request(() => runs++);
    advance(500);
  }
  assert.equal(runs, 0);
  release();
  advance(5000);
  assert.equal(runs, 0);
  // Released twice by mistake, it does not release another holder's hold.
  release();
  const other = gate.hold();
  release();
  gate.request(() => runs++);
  advance(5000);
  assert.equal(runs, 0);
  other();
  // After every hold is released, changes reload the library again.
  gate.request(() => runs++);
  advance(400);
  assert.equal(runs, 1);
});

test("changes during nested holds wait for the last release", () => {
  const { timers, advance } = fakeTimers();
  const gate = createRefreshGate(timers, 400, 3000);
  let runs = 0;
  const first = gate.hold();
  const second = gate.hold();
  gate.request(() => runs++);
  first();
  advance(1000);
  assert.equal(runs, 0);
  second();
  advance(1000);
  assert.equal(runs, 0);
});
