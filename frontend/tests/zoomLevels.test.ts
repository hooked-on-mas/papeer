import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampZoom, pageWidthFor, pinchLevel, pinchStart, stepZoom, ZOOM_FIT_PAGE, ZOOM_LEVELS, ZOOM_PRESETS, zoomLabel,
} from "../src/features/reader/zoomLevels.ts";

test("「ページ全体」 sits below 「幅に合わせる」 in the zoom steps", () => {
  assert.equal(stepZoom(1, -1), ZOOM_FIT_PAGE);
  assert.equal(stepZoom(ZOOM_FIT_PAGE, 1), 1);
  assert.equal(stepZoom(ZOOM_FIT_PAGE, -1), ZOOM_FIT_PAGE);
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(4, 1), 4);
  // Off-preset zooms step from the nearest preset, never from 「ページ全体」.
  assert.equal(stepZoom(1.1, 1), 1.25);
  assert.equal(stepZoom(1.1, -1), ZOOM_FIT_PAGE);
  assert.deepEqual(ZOOM_LEVELS, [ZOOM_FIT_PAGE, ...ZOOM_PRESETS]);
});

test("zooms are kept to 「ページ全体」 or the presets' range", () => {
  assert.equal(clampZoom(ZOOM_FIT_PAGE), ZOOM_FIT_PAGE);
  assert.equal(clampZoom(0.5), 1);
  assert.equal(clampZoom(9), 4);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(2), 2);
});

test("pinching goes between 「ページ全体」 and the presets", () => {
  // Pinching in from 「ページ全体」 reaches 「幅に合わせる」.
  assert.equal(pinchLevel(pinchStart(ZOOM_FIT_PAGE) * 1.15).level, 1);
  assert.equal(pinchLevel(pinchStart(ZOOM_FIT_PAGE) * 1.02).level, ZOOM_FIT_PAGE);
  // Pinching out below 1 reaches it, and no further.
  assert.equal(pinchLevel(0.95).level, 1);
  assert.equal(pinchLevel(0.9).level, ZOOM_FIT_PAGE);
  assert.equal(pinchLevel(0.1).scale, pinchStart(ZOOM_FIT_PAGE));
  assert.equal(pinchLevel(1.4).level, 1.5);
  assert.deepEqual(pinchLevel(10), { scale: 4, level: 4 });
  assert.equal(pinchStart(2), 2);
});

test("「ページ全体」 fits the page's height, and never grows past the pane's width", () => {
  const A4 = Math.SQRT2;
  // A wide, short pane: the height decides.
  assert.equal(pageWidthFor(ZOOM_FIT_PAGE, 1200, 800, A4), Math.floor(800 / A4));
  assert(pageWidthFor(ZOOM_FIT_PAGE, 1200, 800, A4) * A4 <= 800);
  // A narrow, tall pane: the width decides, as at 「幅に合わせる」.
  assert.equal(pageWidthFor(ZOOM_FIT_PAGE, 500, 2000, A4), 500);
  // Before the pane's height is known.
  assert.equal(pageWidthFor(ZOOM_FIT_PAGE, 500, 0, A4), 500);
  assert.equal(pageWidthFor(1.5, 500, 800, A4), 750);
});

test("zoom labels", () => {
  assert.equal(zoomLabel(ZOOM_FIT_PAGE), "ページ全体");
  assert.equal(zoomLabel(1), "幅に合わせる");
  assert.equal(zoomLabel(1.25), "125%");
});
