import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedPixelRatio, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, snapshotSize, MAX_SNAPSHOT_PIXELS } from "../src/features/reader/canvasBudget.ts";

const A4 = Math.SQRT2;
const canvasPixels = (width: number, height: number, ratio: number) => Math.round(width * ratio) * Math.round(height * ratio);

test("pages within the budget are drawn at the display's own pixel ratio", () => {
  for (const ratio of [1, 1.25, 1.5, 2]) assert.equal(cappedPixelRatio(ratio, 800, 800 * A4), ratio);
  // 150% scale keeps full resolution at every zoom preset for an 800px page.
  assert.equal(cappedPixelRatio(1.5, 3200, 3200 * A4), 1.5);
});

test("zoomed-in pages on high-DPI displays stay within the pixel budget", () => {
  for (const [width, device] of [[3200, 2], [4400, 2], [4400, 1.5], [7200, 2]] as const) {
    const ratio = cappedPixelRatio(device, width, width * A4);
    assert(ratio < device);
    assert(canvasPixels(width, width * A4, ratio) <= MAX_CANVAS_PIXELS * 1.001);
  }
  // 400% of an 800px A4 page at 200% scale still gets about 1.5 canvas pixels per CSS pixel.
  const ratio = cappedPixelRatio(2, 3200, 3200 * A4);
  assert(ratio > 1.5 && ratio < 1.53, String(ratio));
});

test("zooming in never draws a page with fewer canvas pixels than before", () => {
  let previous = 0;
  for (const zoom of [1, 1.25, 1.5, 2, 2.5, 3, 4]) {
    const width = 1100 * zoom;
    const pixels = width * cappedPixelRatio(2, width, width * A4);
    assert(pixels >= previous - 1e-6, `${zoom}: ${pixels} < ${previous}`);
    previous = pixels;
  }
});

test("very long pages keep each side within the canvas limit", () => {
  const ratio = cappedPixelRatio(2, 1000, 40000, Infinity);
  assert.equal(ratio, MAX_CANVAS_SIDE / 40000);
});

test("unknown sizes or display ratios fall back safely", () => {
  assert.equal(cappedPixelRatio(2, 0, 0), 2);
  assert.equal(cappedPixelRatio(Number.NaN, 800, 1100), 1);
  assert.equal(cappedPixelRatio(0, 800, 1100), 1);
});

test("the redraw snapshot keeps small drawings whole and scales down large ones", () => {
  assert.deepEqual(snapshotSize(1600, 2263), { width: 1600, height: 2263 });
  const size = snapshotSize(4870, 6887);
  assert(size.width * size.height <= MAX_SNAPSHOT_PIXELS);
  assert(Math.abs(size.width / size.height - 4870 / 6887) < 0.001);
  assert.deepEqual(snapshotSize(1, 1, 0), { width: 1, height: 1 });
});
