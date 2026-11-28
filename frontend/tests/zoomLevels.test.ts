import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampZoom, continuousZoom, fitWidthFor, MIN_FIT_WIDTH, pageWidthFor, scrollsSideways, pinchLevel, pinchStart, stepZoom, ZOOM_FIT_PAGE, ZOOM_LEVELS, ZOOM_PRESETS, zoomLabel,
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

test("zooms allow continuous values between fit page and fit width, up to 400%", () => {
  assert.equal(clampZoom(ZOOM_FIT_PAGE), ZOOM_FIT_PAGE);
  assert.equal(clampZoom(0.5), 0.5);
  assert.equal(clampZoom(0.01), 0.01);
  assert.equal(clampZoom(3.173), 3.173);
  assert.equal(clampZoom(9), 4);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(-1), 1);
  assert.equal(clampZoom(2), 2);
});

test('canonical wheel and Safari pinch start at the measured fit scale, including long pages below 10 percent', () => {
  const width = 1000, height = 500, ratio = 20;
  const minimum = pageWidthFor(0, width, height, ratio) / width;
  assert.equal(minimum, .025);
  const wheel = continuousZoom(minimum, Math.exp(10 / 100), minimum);
  assert.ok(wheel > .025 && wheel < .03, 'a small pinch must not jump to 85% or 100%');
  assert.equal(clampZoom(wheel), wheel);
  assert.equal(pageWidthFor(wheel, width, height, ratio), Math.round(wheel * width));
  const secondWheel = continuousZoom(wheel, Math.exp(10 / 100), minimum);
  const safari = continuousZoom(minimum, Math.exp(20 / 100), minimum);
  assert.ok(Math.abs(secondWheel - safari) < 1e-12);
  assert.equal(continuousZoom(minimum, .5, minimum), minimum);
  assert.equal(continuousZoom(3.9, 2, minimum), 4);
  assert.equal(pageWidthFor(.001, width, height, ratio), 25, 'the surface guards its own minimum');
});

test('canonical continuous zoom respects a new fit minimum after a page or viewport change', () => {
  assert.equal(continuousZoom(.1, 1.02, .6), .6);
  assert.equal(continuousZoom(.6, .5, .2), .3);
  assert.equal(continuousZoom(.025, 1.1, .02), .027500000000000004);
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

test("「幅に合わせる」 fits the page to a narrow pane rather than cutting it off", () => {
  // The reader beside a 420px side panel in a small window: panes 162px wide, 130px for the page.
  assert.equal(fitWidthFor(130), 130);
  assert.equal(pageWidthFor(1, fitWidthFor(130), 800, Math.SQRT2), 130);
  assert.equal(scrollsSideways(1, 130, 130), false);
  // Narrower than the least a page is drawn at: it scrolls sideways instead.
  assert.equal(fitWidthFor(10), MIN_FIT_WIDTH);
  assert.equal(scrollsSideways(1, MIN_FIT_WIDTH, 10), true);
  // Zoomed in, always.
  assert.equal(scrollsSideways(2, 260, 130), true);
  // Rounding up by less than a pixel brings no scrollbar.
  assert.equal(scrollsSideways(1, 131, 130.6), false);
  assert.equal(scrollsSideways(ZOOM_FIT_PAGE, 100, 130), false);
});
