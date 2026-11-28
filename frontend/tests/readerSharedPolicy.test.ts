import assert from "node:assert/strict";
import { test } from "node:test";
import { createTouchSwipe } from "../src/features/reader/input/touchSwipe.ts";
import { pageWidthFor, zoomAtMinimum } from "../src/features/reader/zoomLevels.ts";

test("every pane clamps restored and requested scales to its own fit-page geometry", () => {
  for (const [width, height, ratio] of [[800, 600, 1.414], [400, 700, .7], [300, 500, 2], [900, 400, .5]]) {
    const fitted = pageWidthFor(0, width, height, ratio);
    for (const scale of [.1, .3, .5, .75, 1, 2, 4]) {
      assert.ok(pageWidthFor(scale, width, height, ratio) >= fitted);
    }
    assert.equal(zoomAtMinimum(fitted / width * .9, fitted / width), 0);
    assert.equal(pageWidthFor(0, width, height, ratio), Math.min(width, Math.floor(height / ratio)));
  }
});

test("both event adapters share one-shot swipe cancellation and start-edge decisions", () => {
  const swipe = createTouchSwipe();
  swipe.start(200, 100, { atStart: true, atEnd: true });
  assert.equal(swipe.finish(100, 110), 1);
  assert.equal(swipe.finish(50, 110), 0);
  swipe.start(200, 100, { atStart: false, atEnd: false });
  assert.equal(swipe.finish(100, 100), 0);
  swipe.start(200, 100, { atStart: true, atEnd: true });
  swipe.move(200);
  assert.equal(swipe.finish(100, 100), 0);
  swipe.start(200, 100, { atStart: true, atEnd: true });
  swipe.cancel(); // second contact, cancel, lost capture, or blur
  assert.equal(swipe.finish(100, 100), 0);
});
