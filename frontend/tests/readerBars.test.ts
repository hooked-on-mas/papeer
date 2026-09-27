import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitBar, fitReaderToolbar, inkToolbarOpen, inkToolbarSide, MORE_BUTTON_WIDTH, readerToolbarItems, TOOLBAR_GAP, TOOLBAR_SLACK,
  type BarFit, type BarItem,
} from "../src/features/reader/readerBars.ts";

/** Width the shown items take, with the gaps between them. */
function usedWidth(items: BarItem[], fit: BarFit, gap = TOOLBAR_GAP): number {
  const shown = items.filter((item) => fit[item.id] >= 0);
  return shown.reduce((sum, item) => sum + item.widths[fit[item.id]], 0) + gap * Math.max(0, shown.length - 1);
}

const items: BarItem[] = [
  { id: "a", widths: [20, 60], required: true },
  { id: "b", widths: [30, 80] },
  { id: "c", widths: [50] },
  { id: "d", widths: [10] },
];

test("required items always show, even when they overflow", () => {
  assert.deepEqual(fitBar(items, 0, 4), { a: 0, b: -1, c: -1, d: -1 });
});

test("items join in order of importance, and a small one can take the room a large one left", () => {
  // a 20 + b 30 + gap = 54; c needs 54 more, d only 14.
  assert.deepEqual(fitBar(items, 70, 4), { a: 0, b: 0, c: -1, d: 0 });
});

test("labels are added once every item that fits is shown", () => {
  // Everything small: 20+30+50+10 + 3 gaps = 122. Then a grows by 40, b by 50.
  assert.deepEqual(fitBar(items, 122, 4), { a: 0, b: 0, c: 0, d: 0 });
  assert.deepEqual(fitBar(items, 162, 4), { a: 1, b: 0, c: 0, d: 0 });
  assert.deepEqual(fitBar(items, 212, 4), { a: 1, b: 1, c: 0, d: 0 });
});

test("the fitted items never take more than the width they are given", () => {
  for (let width = 0; width <= 300; width += 3) {
    const fit = fitBar(items, width, 4);
    const required = items.filter((item) => item.required).reduce((sum, item) => sum + item.widths[0], 0);
    if (width >= required) assert.ok(usedWidth(items, fit, 4) <= width, `width ${width}`);
  }
});

/** Room the items have in a row `width` px wide, beside the 「…」 button and the slack kept free. */
const itemRoom = (width: number) => width - MORE_BUTTON_WIDTH - TOOLBAR_GAP - TOOLBAR_SLACK;

// A 900px window in focus mode with the side panel open: the panel keeps 320px, the handle 4px,
// and the toolbar pads its row by 12px on each side.
const narrowFocus = 900 - 320 - 4 - 24;

test("the reading toolbar fits a narrow focus-mode window with the side panel open", () => {
  const options = { focusMode: true, hasOutline: true, reviewCount: 12 };
  const fit = fitReaderToolbar(narrowFocus, options);
  const list = readerToolbarItems(options);
  assert.ok(usedWidth(list, fit) <= itemRoom(narrowFocus));
  // The side panel's buttons stay, as they are how the panel is switched and closed.
  assert.ok(fit.panels >= 0);
  for (const id of ["pages", "spacer", "search", "zoom", "focus"]) assert.ok(fit[id] >= 0, id);
  // The page filter, the widest optional item, is the one folded into the menu.
  assert.equal(fit.filter, -1);
});

test("the reading toolbar shows every item beside the library on a 1366px screen, and every label on a 1920px one", () => {
  const options = { focusMode: false, hasOutline: true, reviewCount: 3 };
  // 1366px minus the 280px library, its 4px handle and the row's padding.
  const width = 1366 - 280 - 4 - 24;
  const fit = fitReaderToolbar(width, options);
  for (const item of readerToolbarItems(options)) assert.ok(fit[item.id] >= 0, item.id);
  for (const id of ["search", "focus", "zoom", "outline", "ink"]) assert.equal(fit[id], 1, id);
  assert.ok(usedWidth(readerToolbarItems(options), fit) <= itemRoom(width));

  const wide = fitReaderToolbar(1920 - 280 - 4 - 24, options);
  for (const item of readerToolbarItems(options)) assert.equal(wide[item.id], item.widths.length - 1, item.id);
});

test("the side panel's buttons stay on the row beside the library and the open side panel on a 1366px screen", () => {
  // The panel at its default 420px, and its 4px handle.
  const width = 1366 - 280 - 4 - 420 - 4 - 24;
  const fit = fitReaderToolbar(width, { focusMode: false, hasOutline: true, reviewCount: 3 });
  assert.ok(fit.panels >= 0);
});

test("the reading toolbar fits focus mode's narrowest main area, 320px, with the zoom in the menu", () => {
  const width = 320 - 24;
  for (const focusMode of [true, false]) {
    const options = { focusMode, hasOutline: true, reviewCount: 12 };
    const fit = fitReaderToolbar(width, options);
    assert.ok(usedWidth(readerToolbarItems(options), fit) <= itemRoom(width), `focusMode ${focusMode}`);
    for (const id of ["pages", "spacer", "search", "focus"]) assert.equal(fit[id], 0, id);
    assert.equal(fit.zoom, -1);
  }
});

test("the reading toolbar lists 付箋 only in focus mode, the side panel's buttons in both, and 目次 only with an outline", () => {
  const ids = (options: Parameters<typeof readerToolbarItems>[0]) => readerToolbarItems(options).map((item) => item.id);
  assert.ok(!ids({ focusMode: false, hasOutline: false, reviewCount: 0 }).some((id) => ["sticky", "outline"].includes(id)));
  assert.ok(ids({ focusMode: false, hasOutline: false, reviewCount: 0 }).includes("panels"));
  assert.ok(ids({ focusMode: true, hasOutline: true, reviewCount: 0 }).includes("panels"));
  assert.ok(ids({ focusMode: true, hasOutline: true, reviewCount: 0 }).includes("sticky"));
  assert.ok(ids({ focusMode: true, hasOutline: true, reviewCount: 0 }).includes("outline"));
});

test("widening the reading toolbar only hides an item to make room for a more important one", () => {
  for (const focusMode of [true, false]) {
    const options = { focusMode, hasOutline: true, reviewCount: 3 };
    const order = readerToolbarItems(options).map((item) => item.id);
    for (let width = 250; width <= 1200; width += 2) {
      const narrow = fitReaderToolbar(width, options);
      const wide = fitReaderToolbar(width + 2, options);
      order.forEach((id, index) => {
        if (narrow[id] < 0 || wide[id] >= 0) return;
        const joined = order.slice(0, index).some((earlier) => narrow[earlier] < 0 && wide[earlier] >= 0);
        assert.ok(joined, `${id} at ${width + 2}px`);
      });
    }
  }
});

test("the writing toolbar serves the pane last used, or the other one when that has no page", () => {
  assert.equal(inkToolbarSide("original", { original: true, translated: true }), "original");
  assert.equal(inkToolbarSide("translated", { original: true, translated: true }), "translated");
  // The translation is still pending.
  assert.equal(inkToolbarSide("translated", { original: true, translated: false }), "original");
  assert.equal(inkToolbarSide("original", { original: false, translated: true }), "translated");
  assert.equal(inkToolbarSide("original", { original: false, translated: false }), null);
});

test("the writing toolbar stays on screen while a writing tool or the page list is in use", () => {
  assert.equal(inkToolbarOpen({ open: false, tool: "select", listOpen: false }), false);
  assert.equal(inkToolbarOpen({ open: true, tool: "select", listOpen: false }), true);
  assert.equal(inkToolbarOpen({ open: false, tool: "pen", listOpen: false }), true);
  assert.equal(inkToolbarOpen({ open: false, tool: "capture", listOpen: false }), true);
  assert.equal(inkToolbarOpen({ open: false, tool: "select", listOpen: true }), true);
});
