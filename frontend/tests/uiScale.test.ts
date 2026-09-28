import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_UI_SCALE, rootFontSize, UI_SCALES, uiScaleOf } from "../src/lib/uiScale.ts";

test("the UI sizes run from 90% to 150% with 100% as the default", () => {
  assert.deepEqual(UI_SCALES.map((scale) => scale.label), ["90%", "100%", "110%", "125%", "150%"]);
  assert.equal(DEFAULT_UI_SCALE, 1);
  assert.ok(UI_SCALES.some((scale) => scale.value === DEFAULT_UI_SCALE));
});

test("a saved size that is not one of the choices reads as 100%", () => {
  assert.equal(uiScaleOf(1.25), 1.25);
  assert.equal(uiScaleOf(0.9), 0.9);
  for (const value of [undefined, null, "1.25", 0, 1.3, 3, Number.NaN, {}]) assert.equal(uiScaleOf(value), 1);
});

test("the root font size is a percentage of the webview's default", () => {
  assert.equal(rootFontSize(1), "100%");
  assert.equal(rootFontSize(0.9), "90%");
  assert.equal(rootFontSize(1.1), "110%");
  assert.equal(rootFontSize(1.25), "125%");
  assert.equal(rootFontSize(1.5), "150%");
  assert.equal(rootFontSize(7), "100%");
});
