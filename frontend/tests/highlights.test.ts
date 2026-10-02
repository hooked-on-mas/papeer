import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HIGHLIGHT_COLORS, MAX_HIGHLIGHT_RECTS, highlightAt, highlightColor, highlightFill, highlightRects, rectsBounds,
  sameHighlightRects, selectionToolbarAllowed, toolbarPlacement, type Box, type PageRect,
} from "../src/features/reader/highlights.ts";

const page: Box = { left: 100, top: 50, width: 400, height: 600 };
const box = (left: number, top: number, width: number, height = 12): Box => ({ left, top, width, height });
const near = (actual: PageRect[], expected: PageRect[]) => {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  actual.forEach((rect, i) => rect.forEach((value, k) => assert.ok(Math.abs(value - expected[i][k]) < 1e-4, JSON.stringify(actual))));
};

test("reselecting a highlight matches its range despite rounding, but not a partial or nearby selection", () => {
  const rects: PageRect[] = [[0.1, 0.2, 0.3, 0.02], [0.1, 0.23, 0.2, 0.02]];
  assert.equal(sameHighlightRects(rects, rects), true);
  assert.equal(sameHighlightRects(rects, [[0.10001, 0.2, 0.29999, 0.02], rects[1]]), true);
  assert.equal(sameHighlightRects(rects, [rects[0]]), false);
  assert.equal(sameHighlightRects(rects, [[0.1, 0.2, 0.15, 0.02], rects[1]]), false);
  assert.equal(sameHighlightRects(rects, [[0.1, 0.3, 0.3, 0.02], rects[1]]), false);
  assert.equal(sameHighlightRects(undefined, rects), false);
  assert.equal(sameHighlightRects([], []), false);
});

test("a selection's text boxes become one rectangle per run of text on a line, as fractions of the page", () => {
  // Two lines; pdf.js spans overlap, split words and come out of order.
  const boxes = [box(292, 110, 108), box(140, 80, 120), box(250, 81, 90, 11), box(140, 110, 150), box(255, 80, 20)];
  near(highlightRects(boxes, page), [
    [40 / 400, 30 / 600, 200 / 400, 12 / 600],
    [40 / 400, 60 / 600, 260 / 400, 12 / 600],
  ]);
});

test("runs far apart on a line, as in two columns, stay apart", () => {
  near(highlightRects([box(120, 80, 100), box(320, 80, 100)], page), [
    [20 / 400, 30 / 600, 100 / 400, 12 / 600],
    [220 / 400, 30 / 600, 100 / 400, 12 / 600],
  ]);
});

test("boxes are clipped to the page, and nothing off it or empty is kept", () => {
  const rects = highlightRects([box(450, 80, 100), box(600, 80, 50), box(150, 700, 50), box(150, 90, 0.2)], page);
  near(rects, [[350 / 400, 30 / 600, 50 / 400, 12 / 600]]);
  // Rounded at the edges: the rectangle ends exactly at the page's edge, as the sidecar requires.
  assert.ok(rects[0][0] + rects[0][2] <= 1);
  assert.deepEqual(highlightRects([box(150, 80, 50)], { ...page, width: 0 }), []);
  assert.deepEqual(highlightRects([], page), []);
});

test("a highlight keeps no more rectangles than the sidecar accepts", () => {
  const lines = Array.from({ length: MAX_HIGHLIGHT_RECTS + 20 }, (_, i) => box(150, 50 + i * 1.4, 50, 1));
  assert.equal(highlightRects(lines, { ...page, height: 2000 }).length, MAX_HIGHLIGHT_RECTS);
});

test("a click finds the highlight under it, the later one where two overlap", () => {
  const items = [{ id: 1, rects: [[0.1, 0.1, 0.5, 0.02]] as PageRect[] }, { id: 2, rects: [[0.3, 0.1, 0.5, 0.02], [0.1, 0.2, 0.2, 0.02]] as PageRect[] }, { id: 3 }];
  assert.equal(highlightAt(items, 0.2, 0.11)?.id, 1);
  assert.equal(highlightAt(items, 0.4, 0.11)?.id, 2);
  assert.equal(highlightAt(items, 0.15, 0.21)?.id, 2);
  assert.equal(highlightAt(items, 0.9, 0.5), null);
  near([rectsBounds(items[1].rects)!], [[0.1, 0.1, 0.7, 0.12]]);
  assert.equal(rectsBounds([]), null);
});

test("the toolbar sits above its target, below it when there is no room, and inside the pane", () => {
  const bounds = { width: 600, height: 400 };
  const size = { width: 260, height: 32 };
  assert.deepEqual(toolbarPlacement({ left: 200, top: 100, width: 100, height: 20 }, bounds, size), { left: 120, top: 62 });
  assert.deepEqual(toolbarPlacement({ left: 200, top: 10, width: 100, height: 20 }, bounds, size), { left: 120, top: 36 });
  assert.deepEqual(toolbarPlacement({ left: 0, top: 100, width: 40, height: 20 }, bounds, size), { left: 4, top: 62 });
  assert.deepEqual(toolbarPlacement({ left: 560, top: 100, width: 40, height: 20 }, bounds, size), { left: 336, top: 62 });
  // A target taller than the pane: kept on screen.
  assert.deepEqual(toolbarPlacement({ left: 200, top: -50, width: 100, height: 600 }, bounds, size), { left: 120, top: 364 });
  // Scrolled out of the pane.
  assert.equal(toolbarPlacement({ left: 200, top: -60, width: 100, height: 20 }, bounds, size), null);
  assert.equal(toolbarPlacement({ left: 200, top: 420, width: 100, height: 20 }, bounds, size), null);
});

test("selecting text shows the toolbar only in reading mode", () => {
  assert.equal(selectionToolbarAllowed({ text: "energy", inkTool: false, placingNote: false }), true);
  assert.equal(selectionToolbarAllowed({ text: " \n", inkTool: false, placingNote: false }), false);
  assert.equal(selectionToolbarAllowed({ text: "energy", inkTool: true, placingNote: false }), false);
  assert.equal(selectionToolbarAllowed({ text: "energy", inkTool: false, placingNote: true }), false);
});

test("colours are the sidecar's, with yellow for one this version does not know", () => {
  assert.deepEqual(HIGHLIGHT_COLORS.map((c) => c.id), ["yellow", "green", "blue", "pink", "purple"]);
  assert.equal(highlightColor("blue").label, "青");
  assert.equal(highlightColor("magenta").id, "yellow");
  assert.equal(highlightColor(undefined).id, "yellow");
  assert.equal(highlightFill("green"), "rgb(74 222 128 / 0.45)");
});
