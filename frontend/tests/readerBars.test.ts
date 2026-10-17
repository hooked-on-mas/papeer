import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitBar, fitNotebookToolbar, fitReaderToolbar, INK_BAR_STARTS, inkBarStartOf, initialInkBarOpen, inkToolbarOpen, inkToolbarSide, MORE_BUTTON_WIDTH,
  readerToolbarItems, TOOLBAR_GAP, TOOLBAR_SLACK,
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
  const options = { focusMode: true, hasOutline: true };
  const fit = fitReaderToolbar(narrowFocus, options);
  const list = readerToolbarItems(options);
  assert.ok(usedWidth(list, fit) <= itemRoom(narrowFocus));
  // The side panel's buttons stay, as they are how the panel is switched and closed.
  assert.ok(fit.panels >= 0);
  for (const id of ["pages", "spacer", "search", "zoom", "focus"]) assert.ok(fit[id] >= 0, id);
});

test("the reading toolbar shows every item beside the library on a 1366px screen, and every label on a 1920px one", () => {
  const options = { focusMode: false, hasOutline: true };
  // 1366px minus the 280px library, its 4px handle and the row's padding.
  const width = 1366 - 280 - 4 - 24;
  const fit = fitReaderToolbar(width, options);
  for (const item of readerToolbarItems(options)) assert.ok(fit[item.id] >= 0, item.id);
  for (const id of ["search", "focus", "zoom", "outline"]) assert.equal(fit[id], 1, id);
  assert.ok(usedWidth(readerToolbarItems(options), fit) <= itemRoom(width));

  const wide = fitReaderToolbar(1920 - 280 - 4 - 24, options);
  for (const item of readerToolbarItems(options)) assert.equal(wide[item.id], item.widths.length - 1, item.id);
});

test("the side panel's buttons stay on the row beside the library and the open side panel on a 1366px screen", () => {
  // The panel at its default 420px, and its 4px handle.
  const width = 1366 - 280 - 4 - 420 - 4 - 24;
  const fit = fitReaderToolbar(width, { focusMode: false, hasOutline: true });
  assert.ok(fit.panels >= 0);
});

test("the reading toolbar fits focus mode's narrowest main area, 320px, with the zoom in the menu", () => {
  const width = 320 - 24;
  for (const focusMode of [true, false]) {
    const options = { focusMode, hasOutline: true };
    const fit = fitReaderToolbar(width, options);
    assert.ok(usedWidth(readerToolbarItems(options), fit) <= itemRoom(width), `focusMode ${focusMode}`);
    for (const id of ["pages", "spacer", "ink", "focus"]) assert.ok(fit[id] >= 0, id);
    assert.equal(fit.search, -1);
    assert.equal(fit.zoom, -1);
  }
});

test("the reading toolbar lists 付箋 only in focus mode, the side panel's buttons in both, and 目次 only with an outline", () => {
  const ids = (options: Parameters<typeof readerToolbarItems>[0]) => readerToolbarItems(options).map((item) => item.id);
  assert.ok(!ids({ focusMode: false, hasOutline: false }).some((id) => ["sticky", "outline"].includes(id)));
  assert.ok(ids({ focusMode: false, hasOutline: false }).includes("panels"));
  assert.ok(ids({ focusMode: true, hasOutline: true }).includes("panels"));
  assert.ok(ids({ focusMode: true, hasOutline: true }).includes("sticky"));
  assert.ok(ids({ focusMode: true, hasOutline: true }).includes("outline"));
});

test("widening the reading toolbar only hides an item to make room for a more important one", () => {
  for (const focusMode of [true, false]) {
    const options = { focusMode, hasOutline: true };
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

test("the writing toolbar's start setting: closed by default, open, or as it was left", () => {
  assert.deepEqual(INK_BAR_STARTS.map((item) => item.id), ["closed", "open", "last"]);
  assert.equal(inkBarStartOf(undefined), "closed");
  assert.equal(inkBarStartOf("later-version"), "closed");
  for (const { id } of INK_BAR_STARTS) assert.equal(inkBarStartOf(id), id);
  assert.equal(initialInkBarOpen("closed", true), false);
  assert.equal(initialInkBarOpen("open", false), true);
  assert.equal(initialInkBarOpen("open", undefined), true);
  assert.equal(initialInkBarOpen("last", true), true);
  assert.equal(initialInkBarOpen("last", false), false);
  // Anything but a saved true (nothing saved, or edited by hand) is closed.
  assert.equal(initialInkBarOpen("last", undefined), false);
  assert.equal(initialInkBarOpen("last", "true"), false);
});

test("the notebook toolbar keeps its tools and page field, and drops the colours, focus button, zoom, sidebar button and history in that order as the row narrows", () => {
  const wide = fitNotebookToolbar(1200, { focusMode: false });
  assert.ok(Object.values(wide).every(form => form >= 0), "everything fits in a wide row");
  const medium = fitNotebookToolbar(640, { focusMode: false });
  assert.equal(medium.style, -1);
  assert.ok(medium.zoom >= 0);
  // Narrowing drops the colours first, then the focus button, the zoom, the sidebar's button and last Undo
  // and Redo; no item comes back, and none stays once one that is more important has gone.
  const order = ["history", "sidebar", "zoom", "focus", "style"];
  let before = new Set<string>();
  for (let width = 1200; width >= 200; width -= 10) {
    const fit = fitNotebookToolbar(width, { focusMode: false });
    const gone = new Set(Object.keys(fit).filter(id => fit[id] < 0));
    for (const id of before) assert.ok(gone.has(id), `${id} stays out as the row narrows (${width})`);
    order.forEach((id, i) => { if (gone.has(id)) order.slice(i).forEach(later => assert.ok(gone.has(later), `${later} goes with or before ${id} (${width})`)); });
    before = gone;
  }
  const narrow = fitNotebookToolbar(300, { focusMode: false });
  assert.deepEqual([narrow.tools, narrow.pages], [0, 0]);
  assert.deepEqual([narrow.zoom, narrow.focus, narrow.style, narrow.history, narrow.sidebar], [-1, -1, -1, -1, -1]);
  // At 426px (a 640px window with the library open) the tools, the page field, Undo and Redo and the sidebar's button are all there.
  const window640 = fitNotebookToolbar(426 - 24, { focusMode: false });
  assert.deepEqual([window640.tools, window640.pages], [0, 0]);
  // In focus mode the focus button is the way out, so it stays.
  assert.equal(fitNotebookToolbar(300, { focusMode: true }).focus, 0);
});
