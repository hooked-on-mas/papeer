import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader } from "../src/lib/lazyLoader.ts";

test("loads once, however often it is asked for", async () => {
  let calls = 0;
  const loader = createLoader(async () => { calls++; return "pane"; });
  assert.equal(loader.loaded(), undefined);
  const first = loader.load();
  assert.equal(loader.load(), first);
  assert.equal(await first, "pane");
  assert.equal(loader.loaded(), "pane");
  loader.reset();
  assert.equal(await loader.load(), "pane");
  assert.equal(calls, 1);
});

test("a failed load stays failed until reset, then tries again", async () => {
  let calls = 0;
  const loader = createLoader(async () => {
    calls++;
    if (calls === 1) throw new Error("chunk missing");
    return "pane";
  });
  await assert.rejects(loader.load(), /chunk missing/);
  // Rendering again must not start another attempt by itself.
  await assert.rejects(loader.load(), /chunk missing/);
  assert.equal(calls, 1);
  assert.equal(loader.loaded(), undefined);
  loader.reset();
  assert.equal(await loader.load(), "pane");
  assert.equal(calls, 2);
});

test("reset leaves a load still running alone", async () => {
  let calls = 0;
  let finish: (value: string) => void = () => undefined;
  const loader = createLoader(() => { calls++; return new Promise<string>((resolve) => { finish = resolve; }); });
  const pending = loader.load();
  loader.reset();
  assert.equal(loader.load(), pending);
  finish("pane");
  assert.equal(await pending, "pane");
  assert.equal(calls, 1);
});

test("a preload that failed before anyone asked is tried once more on first use", async () => {
  let calls = 0;
  const loader = createLoader(async () => {
    calls++;
    if (calls <= 2) throw new Error("offline");
    return "pane";
  });
  loader.preload();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  // Shown for the first time: the idle-time failure is forgotten, once.
  await assert.rejects(loader.load(), /offline/);
  assert.equal(calls, 2);
  // This failure was seen, so it stays until reset (the pane's 再試行).
  await assert.rejects(loader.load(), /offline/);
  assert.equal(calls, 2);
  loader.reset();
  assert.equal(await loader.load(), "pane");
  assert.equal(calls, 3);
});

test("a preload still running when first used is not started again", async () => {
  let calls = 0;
  let fail: (error: Error) => void = () => undefined;
  const loader = createLoader(() => { calls++; return new Promise<string>((_resolve, reject) => { fail = reject; }); });
  loader.preload();
  const pending = loader.load();
  fail(new Error("chunk missing"));
  await assert.rejects(pending, /chunk missing/);
  // The user waited for it and saw it fail, so it is not retried by itself.
  await assert.rejects(loader.load(), /chunk missing/);
  assert.equal(calls, 1);
});

test("preloading after a load has started or finished changes nothing", async () => {
  let calls = 0;
  const loader = createLoader(async () => { calls++; return "pane"; });
  assert.equal(await loader.load(), "pane");
  loader.preload();
  assert.equal(await loader.load(), "pane");
  assert.equal(calls, 1);
});
