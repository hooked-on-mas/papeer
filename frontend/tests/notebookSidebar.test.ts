import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contactAfter, cornerPlacement, penNear, rowHeight, SIDEBAR_GAP, SIDEBAR_WIDTH, sidebarPlacement, tabPosition, thumbnailSize,
} from "../src/features/notebooks/pageSidebar.ts";

const room = SIDEBAR_WIDTH + SIDEBAR_GAP * 2;

test("the sidebar sits in the room left of the paper only when it fits there with a gap on each side", () => {
  // A4 portrait at 「ページ全体」 in a 1000px view: 480px wide, 260px of room on each side.
  assert.equal(sidebarPlacement({ viewWidth: 1000, paperWidth: 480, sidebarWidth: SIDEBAR_WIDTH }), "margin");
  // Exactly the sidebar, a gap beside it and a gap before the paper.
  assert.equal(sidebarPlacement({ viewWidth: 2 * room + 400, paperWidth: 400, sidebarWidth: SIDEBAR_WIDTH }), "margin");
  assert.equal(sidebarPlacement({ viewWidth: 2 * room + 399, paperWidth: 400, sidebarWidth: SIDEBAR_WIDTH }), "tab");
  // A landscape paper that fills the width, or a zoomed one wider than the view, leaves no room.
  assert.equal(sidebarPlacement({ viewWidth: 1000, paperWidth: 968, sidebarWidth: SIDEBAR_WIDTH }), "tab");
  assert.equal(sidebarPlacement({ viewWidth: 1000, paperWidth: 1500, sidebarWidth: SIDEBAR_WIDTH }), "tab");
});

test("the sidebar stays folded until the view and the paper have a size", () => {
  assert.equal(sidebarPlacement({ viewWidth: 0, paperWidth: 400, sidebarWidth: SIDEBAR_WIDTH }), "tab");
  assert.equal(sidebarPlacement({ viewWidth: 1000, paperWidth: 0, sidebarWidth: SIDEBAR_WIDTH }), "tab");
  assert.equal(sidebarPlacement({ viewWidth: NaN, paperWidth: 400, sidebarWidth: SIDEBAR_WIDTH }), "tab");
});

test("a wider sidebar needs more room, and the placement follows the room as the window changes", () => {
  const paperWidth = 480;
  const placements = [1000, 800, 700, 600].map((viewWidth) => sidebarPlacement({ viewWidth, paperWidth, sidebarWidth: SIDEBAR_WIDTH }));
  assert.deepEqual(placements, ["margin", "margin", "tab", "tab"]);
  assert.equal(sidebarPlacement({ viewWidth: 800, paperWidth, sidebarWidth: 200 }), "tab");
});

test("the next-page button goes in the room right of the paper, or over the paper's corner", () => {
  assert.equal(cornerPlacement({ viewWidth: 1000, paperWidth: 480, buttonWidth: 100 }), "margin");
  assert.equal(cornerPlacement({ viewWidth: 640, paperWidth: 480, buttonWidth: 100 }), "overlay");
  assert.equal(cornerPlacement({ viewWidth: 1000, paperWidth: 0, buttonWidth: 100 }), "overlay");
});

test("the tab shows the page's place from the top to the bottom of its track", () => {
  assert.equal(tabPosition(1, 12), 0);
  assert.equal(tabPosition(12, 12), 1);
  assert.equal(tabPosition(6, 11), 0.5);
  assert.equal(tabPosition(1, 1), 0);
  assert.equal(tabPosition(0, 0), 0);
  assert.equal(tabPosition(99, 12), 1);
});

test("thumbnails fit 72 by 112 px whatever the paper's shape", () => {
  const a4 = thumbnailSize(Math.SQRT2);
  assert.deepEqual(a4, { width: 72, height: 102 });
  assert.deepEqual(thumbnailSize(9 / 16), { width: 72, height: 41 });
  const tall = thumbnailSize(3);
  assert.equal(tall.height, 112);
  assert.ok(tall.width <= 72 && tall.width > 0);
  assert.deepEqual(thumbnailSize(0), a4);
  assert.deepEqual(thumbnailSize(NaN), a4);
  assert.equal(rowHeight(Math.SQRT2), 102 + 28);
});

test("a pen is near a box within the reach of its edges", () => {
  const box = { left: 100, top: 100, right: 200, bottom: 130 };
  assert.equal(penNear({ x: 150, y: 115 }, box, 0), true);
  assert.equal(penNear({ x: 80, y: 115 }, box, 20), true);
  assert.equal(penNear({ x: 79, y: 115 }, box, 20), false);
  assert.equal(penNear({ x: 150, y: 151 }, box, 20), false);
});

test("the wheel waits while a pen or a mouse button is down, never for a finger", () => {
  let down: ReadonlySet<number> = new Set();
  down = contactAfter(down, { kind: "down", pointerId: 1, pointerType: "touch" });
  assert.equal(down.size, 0);
  down = contactAfter(down, { kind: "down", pointerId: 2, pointerType: "pen" });
  assert.equal(down.size, 1);
  down = contactAfter(down, { kind: "down", pointerId: 3, pointerType: "mouse" });
  assert.equal(down.size, 2);
  down = contactAfter(down, { kind: "up", pointerId: 2, pointerType: "pen" });
  assert.deepEqual([...down], [3]);
  // An up for a pointer that was never down changes nothing.
  assert.equal(contactAfter(down, { kind: "up", pointerId: 9, pointerType: "pen" }), down);
  down = contactAfter(down, { kind: "up", pointerId: 3, pointerType: "mouse" });
  assert.equal(down.size, 0);
});
