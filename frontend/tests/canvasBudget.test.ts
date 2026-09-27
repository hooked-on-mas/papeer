import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedPixelRatio, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, snapshotSize, MAX_SNAPSHOT_PIXELS, PIXEL_RATIO_STEPS } from "../src/features/reader/canvasBudget.ts";

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
  assert.equal(ratio, 1.5);
});

test("zooming in never draws a page with fewer canvas pixels than before, beyond the rounding", () => {
  let previous = 0;
  for (const zoom of [1, 1.25, 1.5, 2, 2.5, 3, 4]) {
    const width = 1100 * zoom;
    const pixels = width * cappedPixelRatio(2, width, width * A4);
    // Rounding the ratio down to a step of 0.05 costs at most 0.05 canvas pixels per CSS pixel.
    assert(pixels >= previous - width / PIXEL_RATIO_STEPS - 1e-6, `${zoom}: ${pixels} < ${previous}`);
    previous = pixels;
  }
});

test("a capped ratio is rounded down to a step of 0.05, so that a similar page shape keeps it", () => {
  const a4 = cappedPixelRatio(2, 3200, 3200 * A4);
  const letter = cappedPixelRatio(2, 3200, 3200 * 1.294);
  const tallerA4 = cappedPixelRatio(2, 3200, 3200 * 1.4);
  for (const ratio of [a4, letter, tallerA4]) assert.equal(Math.round(ratio * PIXEL_RATIO_STEPS), ratio * PIXEL_RATIO_STEPS);
  assert.equal(a4, tallerA4);
  // Uncapped ratios are the display's own, however they fall.
  assert.equal(cappedPixelRatio(1.33, 800, 800 * A4), 1.33);
  // A page so large that one step would be too much still gets a ratio above 0.
  const huge = cappedPixelRatio(2, 1_000_000, 1_000_000);
  assert(huge > 0 && huge < 1 / PIXEL_RATIO_STEPS);
});

test("very long pages keep each side within the canvas limit", () => {
  const ratio = cappedPixelRatio(2, 1000, 40000, Infinity);
  assert(ratio <= MAX_CANVAS_SIDE / 40000 && ratio > MAX_CANVAS_SIDE / 40000 - 1 / PIXEL_RATIO_STEPS, String(ratio));
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
