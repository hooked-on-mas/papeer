import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlaceKeeper, readingPlace, scrollForPlace, scrollDeltaForZoomAnchor, type PaneView } from "../src/features/reader/readingPlace.ts";

test("pinch keeps the point under the fingers regardless of the pane's position on screen", () => {
  // Include the right pane, a toolbar above the page, and an already scrolled page.
  for (const [left, top] of [[16, 16], [816, 156], [-184, -284]]) {
    const before = { left, top, width: 600, height: 900 };
    const atX = left + 240, atY = top + 540;
    const anchor = { x: (atX - before.left) / before.width, y: (atY - before.top) / before.height, atX, atY };
    for (const scale of [1, 1.5, 0.75]) {
      const after = { ...before, width: before.width * scale, height: before.height * scale };
      const delta = scrollDeltaForZoomAnchor(anchor, after);
      assert.equal(delta.left, 240 * (scale - 1));
      assert.equal(delta.top, 540 * (scale - 1));
      // Applying the scroll correction returns the same PDF point to the finger midpoint.
      assert.equal(after.left - delta.left + anchor.x * after.width, atX);
      assert.equal(after.top - delta.top + anchor.y * after.height, atY);
    }
  }
});

/** A pane 400px wide and 800px tall showing a page `width` wide (A4-ish) below 16px of padding. */
function view(width: number, scrollTop: number, scrollLeft = 0): PaneView {
  return { scrollTop, scrollLeft, clientWidth: 400, clientHeight: 800,
    page: { top: 16, left: 16, width, height: Math.round(width * 1.414) } };
}

test("the place read on the page comes back when the page is drawn at another size", () => {
  // A third of the way down a page 900px wide (1273px tall), when the side panel takes half the width.
  const before = view(900, 16 + 424);
  const place = readingPlace(before)!;
  assert.ok(Math.abs(place.y - 424 / 1273) < 1e-9);
  const after = view(450, 440);
  const { top } = scrollForPlace(place, after);
  assert.equal(top, 16 + Math.round((424 / 1273) * 636));
  // Not the pixel position kept, which would land two thirds down the smaller page.
  assert.notEqual(top, before.scrollTop);
});

test("the top of the page, padding included, stays the top", () => {
  assert.equal(readingPlace(view(900, 0))!.y, 0);
  assert.equal(readingPlace(view(900, 10))!.y, 0);
  assert.equal(scrollForPlace({ y: 0, x: 0.5 }, view(450, 0)).top, 0);
});

test("zoomed in, the middle of the view stays over the same part of the page", () => {
  // A page 1600px wide, the view's middle 984px from the page's left edge.
  const place = readingPlace(view(1600, 100, 800))!;
  assert.equal(place.x, (800 + 200 - 16) / 1600);
  const { left } = scrollForPlace(place, { ...view(2000, 100), clientWidth: 300 });
  assert.equal(left, Math.round(16 + place.x * 2000 - 150));
  // Never to the left of the start.
  assert.equal(scrollForPlace({ y: 0, x: 0 }, view(450, 0)).left, 0);
});

test("no place without a page drawn", () => {
  assert.equal(readingPlace({ ...view(900, 100), page: { top: 16, left: 16, width: 0, height: 0 } }), null);
});

test("a pane that does not scroll sideways stays at its left edge", () => {
  // 「幅に合わせる」: the page's 1px border overflows the room by 2px, which must not scroll the border away.
  for (const [before, after] of [[1000, 100], [500, 300], [1200, 60], [800, 41]]) {
    const fit = (room: number): PaneView => ({ scrollTop: 0, scrollLeft: 0, clientWidth: room + 32, clientHeight: 800,
      page: { top: 16, left: 16, width: room + 2, height: 1000 } });
    assert.equal(scrollForPlace(readingPlace(fit(before))!, fit(after)).left, 0);
  }
  // Wider than the pane, but the pane does not scroll sideways.
  assert.equal(scrollForPlace({ y: 0.2, x: 0.8 }, view(1600, 100), { sideways: false }).left, 0);
  assert.ok(scrollForPlace({ y: 0.2, x: 0.8 }, view(1600, 100), { sideways: true }).left > 0);
});

test("a run of size changes keeps the place from before the first while the view stays put", () => {
  const keeper = createPlaceKeeper();
  // Two thirds down a long page.
  const first = keeper.measure("p:3", view(900, 16 + 849), 900)!;
  // The page shrinks so much that the view can only go a little way down: the scroll is clamped.
  const clamped = view(200, 18);
  keeper.restored("p:3", first, clamped, 200);
  // Growing back, the place is the one from before, not where the clamped view was; also once the page
  // has been drawn again at its width, when its box no longer carries the scaled border.
  assert.deepEqual(keeper.measure("p:3", view(200, 18), 200), first);
  assert.deepEqual(keeper.measure("p:3", { ...clamped, page: { ...clamped.page, width: 204 } }, 200), first);
  // Moved since, or another page, or at another width: measured afresh.
  assert.notDeepEqual(keeper.measure("p:3", view(200, 5), 200), first);
  keeper.restored("p:3", first, clamped, 200);
  assert.notDeepEqual(keeper.measure("p:4", view(200, 18), 200), first);
  keeper.restored("p:3", first, clamped, 200);
  assert.notDeepEqual(keeper.measure("p:3", view(260, 18), 260), first);
});

test("turning the page forgets the place kept for the one before", () => {
  const keeper = createPlaceKeeper();
  const first = keeper.measure("p:3", view(900, 16 + 849), 900)!;
  const clamped = view(200, 18);
  keeper.restored("p:3", first, clamped, 200);
  // Page 4 is shown, then page 3 again, its view at the same scroll position by chance.
  keeper.reset();
  assert.notDeepEqual(keeper.measure("p:3", clamped, 200), first);
});
