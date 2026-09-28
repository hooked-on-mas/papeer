import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTagChange, createTagQueue } from "../src/lib/tagQueue.ts";

/** A sidecar holding one paper's tags, whose writes take until `release` is called (a sync holding them). */
function slowSidecar(initial: string[]) {
  let tags = [...initial];
  const held: (() => void)[] = [];
  return {
    tags: () => tags,
    release: () => { while (held.length) held.shift()!(); },
    deps: {
      read: async () => [...tags],
      write: (_id: string, next: string[]) => new Promise<void>((resolve) => held.push(() => { tags = next; resolve(); })),
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("tags clicked one after another while the first save waits all stay on", async () => {
  const sidecar = slowSidecar(["old"]);
  const queue = createTagQueue(sidecar.deps);
  // The screen showed ["old"] for both clicks (its query loaded again, stale, in between): as whole lists,
  // the second would have been ["old", "b"] and taken "a" off again.
  const first = queue.change("p", { name: "a", add: true });
  const second = queue.change("p", { name: "b", add: true });
  const third = queue.change("p", { name: "old", add: false });
  assert.deepEqual(queue.shown("p", ["old"]), ["a", "b"]);
  for (let i = 0; i < 3; i++) {
    await settle();
    sidecar.release();
  }
  assert.deepEqual(await Promise.all([first, second, third]), ["done", "done", "done"]);
  assert.deepEqual(sidecar.tags(), ["a", "b"]);
  assert.deepEqual(queue.shown("p", sidecar.tags()), ["a", "b"]);
});

test("a change the tags already have is not sent, and a failed one does not stop the next", async () => {
  let tags = ["a"];
  let fail = true;
  const writes: string[][] = [];
  const queue = createTagQueue({
    read: async () => [...tags],
    write: async (_id, next) => {
      if (fail) { fail = false; throw new Error("通信エラー"); }
      writes.push(next);
      tags = next;
    },
  });
  assert.equal(await queue.change("p", { name: "a", add: true }), "unchanged");
  await assert.rejects(queue.change("p", { name: "b", add: true }), /通信エラー/);
  assert.equal(await queue.change("p", { name: "c", add: true }), "done");
  assert.deepEqual(writes, [["a", "c"]]);
  assert.deepEqual(queue.shown("p", tags), ["a", "c"]);
});

test("a change is applied as a difference", () => {
  assert.deepEqual(applyTagChange(["a", "b"], { name: "a", add: false }), ["b"]);
  assert.deepEqual(applyTagChange(["a"], { name: "b", add: true }), ["a", "b"]);
  assert.deepEqual(applyTagChange(["a"], { name: "a", add: true }), ["a"]);
});

test("an action on several papers and the memo pane changing the same paper keep both tags", async () => {
  let tags = ["x"];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const queue = createTagQueue({
    read: async () => { await tick(); return [...tags]; },
    write: async (_id, next) => { await tick(); tags = next; },
  });
  // bulkActions.tagPapers runs each paper's step through the paper's turn, as the tag field does.
  const bulk = queue.change("p", { name: "bulk", add: true });
  const single = queue.change("p", { name: "mine", add: true });
  assert.deepEqual(await Promise.all([bulk, single]), ["done", "done"]);
  assert.deepEqual(tags, ["x", "bulk", "mine"]);
});
