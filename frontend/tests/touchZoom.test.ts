import assert from "node:assert/strict";
import { test } from "node:test";
import { beginTouchPinch, moveTouchPinch } from "../src/features/reader/touchZoom.ts";
import { scrollDeltaForZoomAnchor } from "../src/features/reader/readingPlace.ts";

test("small finger movements at high zoom produce continuous scale instead of preset jumps", () => {
  const start = beginTouchPinch({ x: 700, y: 300 }, { x: 900, y: 300 },
    { left: -400, top: -1600, width: 1800, height: 2500 }, 3, 0.7);
  for (let distance = 201; distance < 240; distance++) {
    assert.equal(moveTouchPinch(start, { x: 800 - distance / 2, y: 300 }, { x: 800 + distance / 2, y: 300 }).zoom,
      3 * distance / 200);
  }
});

test("the original PDF point stays under a moving midpoint after many rounded scroll corrections", () => {
  const original = { left: -850, top: -2100, width: 2100, height: 3000 };
  const start = beginTouchPinch({ x: 700, y: 400 }, { x: 900, y: 400 }, original, 3, 0.6);
  let left = original.left, top = original.top;
  for (let i = 0; i < 100; i++) {
    const distance = 200 + Math.sin(i / 10) * 40;
    const next = moveTouchPinch(start, { x: 700 + i, y: 400 + i }, { x: 700 + i + distance, y: 400 + i });
    const page = { left, top, width: original.width * next.zoom / 3, height: original.height * next.zoom / 3 };
    const delta = scrollDeltaForZoomAnchor(next.anchor, page);
    left -= Math.round(delta.left); top -= Math.round(delta.top);
    assert.ok(Math.abs(left + start.x * page.width - next.anchor.atX) <= 0.5);
    assert.ok(Math.abs(top + start.y * page.height - next.anchor.atY) <= 0.5);
  }
});

test("fit-page pinch starts from the actual rendered size and crosses 100% continuously", () => {
  const start = beginTouchPinch({ x: 0, y: 0 }, { x: 100, y: 0 },
    { left: 0, top: 0, width: 400, height: 560 }, 0.5, 0.5);
  for (const [distance, zoom] of [[100, 0], [102, 0.51], [198, 0.99], [202, 1.01]]) {
    assert.equal(moveTouchPinch(start, { x: 0, y: 0 }, { x: distance, y: 0 }).zoom, zoom);
  }
});

test("two-finger panning still moves the anchor when the scale hits 400%", () => {
  const start = beginTouchPinch({ x: 300, y: 300 }, { x: 500, y: 300 },
    { left: -400, top: -600, width: 2400, height: 3300 }, 4, 0.7);
  const next = moveTouchPinch(start, { x: 350, y: 320 }, { x: 650, y: 320 });
  assert.equal(next.zoom, 4);
  assert.deepEqual(next.anchor, { x: start.x, y: start.y, atX: 500, atY: 320 });
});

test("switching to a narrower pane keeps a shared zoom below its fit-page size", () => {
  const start = beginTouchPinch({ x: 0, y: 0 }, { x: 100, y: 0 },
    { left: 0, top: 0, width: 360, height: 510 }, 0.8, 0.88);
  assert.equal(moveTouchPinch(start, { x: 0, y: 0 }, { x: 100, y: 0 }).zoom, 0.8);
  assert.equal(moveTouchPinch(start, { x: 0, y: 0 }, { x: 102, y: 0 }).zoom, 0.8 * 102 / 100);
  // Contracting must not enlarge the PDF by switching to this pane's larger fit-page size.
  assert.equal(moveTouchPinch(start, { x: 0, y: 0 }, { x: 98, y: 0 }).zoom, 0.8 * 98 / 100);
  assert.equal(moveTouchPinch(start, { x: 0, y: 0 }, { x: 112, y: 0 }).zoom, 0.8 * 112 / 100);
});
