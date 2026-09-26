import assert from "node:assert/strict";
import { test } from "node:test";
import { createScrollSync } from "../src/features/reader/scrollSync.ts";

function pane(height = 1000, width = 500) {
  return { scrollTop: 0, scrollLeft: 0, scrollHeight: height, scrollWidth: width,
    clientHeight: 200, clientWidth: 200 };
}

test("a delayed follower event does not rewind an ongoing native wheel animation", () => {
  const sync = createScrollSync();
  const source = pane();
  const follower = pane(1800);
  source.scrollTop = 80;
  sync(source, follower);
  assert.equal(follower.scrollTop, 160);
  source.scrollTop = 120; // Native scrolling advances before the follower event arrives.
  sync(follower, source);
  assert.equal(source.scrollTop, 120);
  sync(source, follower);
  assert.equal(follower.scrollTop, 240);
});

test("consecutive source events all synchronize and either pane can take over", () => {
  const sync = createScrollSync();
  const left = pane();
  const right = pane(1800, 800);
  for (const top of [10, 20, 40]) {
    left.scrollTop = top;
    left.scrollLeft = top;
    sync(left, right);
    assert.equal(right.scrollTop, top * 2);
    assert.equal(right.scrollLeft, top * 2);
  }
  right.scrollTop = 200;
  right.scrollLeft = 120;
  sync(right, left);
  assert.equal(left.scrollTop, 100);
  assert.equal(left.scrollLeft, 60);
});

test("rounded follower positions are ignored without redundant source writes", () => {
  const sync = createScrollSync();
  const source = pane();
  let top = 0;
  const follower = { ...pane(1001), get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.round(value); } };
  source.scrollTop = 123;
  sync(source, follower);
  source.scrollTop = 150;
  sync(follower, source);
  assert.equal(source.scrollTop, 150);
});

test("missing and non-scrollable panes are supported", () => {
  const sync = createScrollSync();
  const source = pane();
  source.scrollTop = 100;
  sync(source, null);
  const target = pane(200, 200);
  sync(source, target);
  assert.equal(target.scrollTop, 0);
  assert.equal(target.scrollLeft, 0);
});
