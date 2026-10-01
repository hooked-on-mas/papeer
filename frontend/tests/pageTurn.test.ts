import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReaderWheelPager, createWheelPager, edgePage, keyTarget, paneEdges, paneHorizontalEdges, readerKeyAction, readerOwnsKey, steppedPage, touchSwipePage, TOUCHPAD_TURN_DISTANCE, WHEEL_GESTURE_GAP_MS,
  type WheelInput,
} from "../src/features/reader/pageTurn.ts";

const middle = { atStart: false, atEnd: false };
const bottom = { atStart: false, atEnd: true };
const top = { atStart: true, atEnd: false };
const fits = { atStart: true, atEnd: true };

function notch(time: number, edges: { atStart: boolean; atEnd: boolean }, dy = 100): WheelInput {
  return { dy, time, notch: true, ...edges };
}

test("pane edges allow a pixel of rounding", () => {
  assert.deepEqual(paneEdges({ scrollTop: 0.5, scrollHeight: 2000, clientHeight: 800 }), top);
  assert.deepEqual(paneEdges({ scrollTop: 1199.4, scrollHeight: 2000, clientHeight: 800 }), bottom);
  assert.deepEqual(paneEdges({ scrollTop: 600, scrollHeight: 2000, clientHeight: 800 }), middle);
  assert.deepEqual(paneEdges({ scrollTop: 0, scrollHeight: 800, clientHeight: 800 }), fits);
});

test("a tiny vertical lead-in does not block a short horizontal trackpad swipe", () => {
  const pager = createReaderWheelPager();
  const move = (dx: number, dy: number, time: number) => pager({ dx, dy, time, notch: false, horizontal: fits, vertical: middle });
  assert.equal(move(0, 2, 0).turn, 0);
  assert.equal(move(20, 1, 16).axis, "horizontal");
  assert.equal(move(20, 1, 32).turn, 0);
  assert.equal(move(20, 1, 48).turn, 0);
  assert.equal(move(20, 1, 64).turn, 1);
  assert.equal(move(0, 20, 80).swallow, true);
  assert.equal(move(0.1, 0, 100).swallow, true);
  // A long subpixel tail does not block the next intentional swipe.
  move(0.1, 0, 190);
  assert.equal(move(-80, 0, 310).turn, -1);
});

test("touch swipes use the start edge and reject short or vertical drags", () => {
  assert.equal(touchSwipePage(-80, 5, fits), 1);
  assert.equal(touchSwipePage(80, 5, fits), -1);
  assert.equal(touchSwipePage(-30, 0, fits), 0);
  assert.equal(touchSwipePage(-80, 70, fits), 0);
  assert.equal(touchSwipePage(-200, 0, middle), 0);
  assert.equal(touchSwipePage(-80, 0, bottom), 1);
  assert.equal(touchSwipePage(80, 0, bottom), 0);
});

test("another horizontal stroke can start before the previous inertia has stopped", () => {
  const pager = createReaderWheelPager();
  let time = 0;
  const move = (dx: number) => pager({ dx, dy: 0, time: time += 16, notch: false, horizontal: fits, vertical: middle }).turn;
  assert.equal([24, 24, 24].map(move).filter(Boolean).length, 1);
  assert.ok([40, 32, 24, 16, 8, 3, 1].map(move).every(turn => turn === 0), "decelerating inertia must not turn again");
  assert.equal([24, 24, 24].map(move).filter(Boolean).length, 1, "a new accelerating stroke must work without a 200ms pause");
});

test("an intentional reverse swipe works immediately after a turn, while jitter does not", () => {
  const pager = createReaderWheelPager();
  const move = (dx: number, time: number) => pager({ dx, dy: 0, time, notch: false, horizontal: fits, vertical: middle }).turn;
  assert.equal(move(80, 0), 1);
  assert.equal(move(-4, 40), 0);
  assert.equal(move(3, 60), 0);
  assert.equal(move(-24, 130), 0);
  assert.equal(move(-24, 146), 0);
  assert.equal(move(-24, 162), -1);
});

test("a new swipe can accelerate gradually out of the previous tail", () => {
  const pager = createReaderWheelPager();
  let time = 0;
  const move = (dx: number) => pager({ dx, dy: 0, time: time += 16, notch: false, horizontal: fits, vertical: middle }).turn;
  [24, 24, 24, 40, 32, 24, 16, 8, 3, 1].forEach(move);
  assert.equal([1, 2, 4, 8, 12, 20, 24, 24].map(move).filter(Boolean).length, 1);
});

test("turning direction before the first page turn does not count its remaining inertia as another swipe", () => {
  const pager = createReaderWheelPager();
  const events = [[20, 0], [-24, 16], [-24, 32], [-24, 48],
    ...Array.from({ length: 12 }, (_, i) => [-24, 64 + i * 16])];
  const turns = events.map(([dx, time]) => pager({ dx, dy: 0, time, notch: false, horizontal: fits, vertical: middle }).turn).filter(Boolean);
  assert.deepEqual(turns, [-1]);
});

test("a weak swipe after the tail is recognized from its cumulative distance", () => {
  const pager = createReaderWheelPager();
  let time = 0;
  const events = [24, 24, 24, 40, 32, 24, 16, 8, 3, 1, ...Array<number>(30).fill(4)];
  const turns = events.map(dx => pager({ dx, dy: 0, time: time += 16, notch: false, horizontal: fits, vertical: middle }).turn).filter(Boolean);
  assert.deepEqual(turns, [1, 1]);
});

test("a larger wheel delta covering a longer interval is still the same decelerating gesture", () => {
  const pager = createReaderWheelPager();
  // Velocity decreases from 3px/ms to 0.5px/ms. The final event covers 144ms at that same speed.
  const events = [[24, 8], [24, 16], [24, 24], [24, 32], [16, 48], [8, 56], [4, 64], [72, 208]];
  const turns = events.map(([dx, time]) => pager({ dx, dy: 0, time, notch: false, horizontal: fits, vertical: middle }).turn).filter(Boolean);
  assert.deepEqual(turns, [1]);
});

test("a horizontal stroke can follow a vertical scroll without waiting for its tail", () => {
  const pager = createReaderWheelPager();
  const move = (dx: number, dy: number, time: number) => pager({ dx, dy, time, notch: false, horizontal: fits, vertical: middle }).turn;
  move(0, 30, 0); move(0, 12, 16); move(0, 3, 32);
  assert.equal(move(24, 1, 64), 0);
  assert.equal(move(24, 1, 80), 0);
  assert.equal(move(24, 1, 96), 1);
});

test("a long continuous swipe turns once, including pauses while the page redraws", () => {
  const pager = createReaderWheelPager();
  let time = 0;
  const move = (dx: number, elapsed = 16) => pager({ dx, dy: 0, time: time += elapsed, notch: false,
    horizontal: fits, vertical: middle }).turn;
  assert.equal(Array.from({ length: 40 }, () => move(24)).filter(Boolean).length, 1);
  assert.equal(move(24, 120), 0);
  assert.equal(move(24), 0);
  assert.equal(move(24), 0);
  move(8); move(3); move(1);
  assert.equal(move(24, 120), 0);
  assert.equal(move(24), 0);
  assert.equal(move(24), 1);
});

test("a mouse notch at the end of the page turns to the next one", () => {
  const pager = createWheelPager();
  assert.deepEqual(pager(notch(0, bottom)), { turn: 1, swallow: true });
});

test("horizontal swipes turn forward and back when the page fits across the pane", () => {
  assert.deepEqual(paneHorizontalEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 600 }), fits);
  // Fit-width hides border/padding rounding overflow rather than allowing sideways scrolling.
  assert.deepEqual(paneHorizontalEdges({ scrollLeft: 0, scrollWidth: 602, clientWidth: 600 }, false), fits);
  assert.deepEqual(paneHorizontalEdges({ scrollLeft: 1089, scrollWidth: 1687, clientWidth: 583 }, true, 15), bottom);
  const pager = createWheelPager();
  const swipe = (dy: number, time: number) => pager({ dy, time, axis: "horizontal", notch: false, ...fits });
  assert.deepEqual(swipe(40, 0), { turn: 0, swallow: false });
  assert.equal(swipe(40, 16).turn, 0);
  assert.deepEqual(swipe(40, 32), { turn: 1, swallow: true });
  assert.deepEqual(swipe(100, 60), { turn: 0, swallow: true });
  assert.deepEqual(swipe(-20, 90), { turn: 0, swallow: true });
  assert.deepEqual(swipe(-120, 90 + WHEEL_GESTURE_GAP_MS + 1), { turn: -1, swallow: true });
});

test("horizontal panning must finish before a fresh swipe can turn an enlarged page", () => {
  const pager = createWheelPager();
  const swipe = (left: number, time: number) => pager({ dy: 120, time, axis: "horizontal", notch: false,
    ...paneHorizontalEdges({ scrollLeft: left, scrollWidth: 1800, clientWidth: 600 }) });
  assert.deepEqual(swipe(600, 0), { turn: 0, swallow: false });
  assert.deepEqual(swipe(1200, 16), { turn: 0, swallow: false });
  assert.equal(swipe(1200, 16 + WHEEL_GESTURE_GAP_MS + 1).turn, 1);
});

test("diagonal inertia cannot turn again on the other axis", () => {
  const pager = createWheelPager();
  assert.equal(pager({ dy: 120, time: 0, axis: "horizontal", notch: false, ...fits }).turn, 1);
  assert.deepEqual(pager({ dy: 120, time: 16, notch: false, ...fits }), { turn: 0, swallow: true });
  assert.deepEqual(pager({ dy: -120, time: 32, notch: false, ...fits }), { turn: 0, swallow: true });
  assert.equal(pager({ dy: 120, time: 32 + WHEEL_GESTURE_GAP_MS + 1, notch: false, ...fits }).turn, 1);
});

test("a vertical scroll cannot become a page swipe through sideways jitter", () => {
  const pager = createWheelPager();
  assert.equal(pager({ dy: 12, time: 0, notch: false, ...middle }).turn, 0);
  assert.deepEqual(pager({ dy: 120, time: 16, axis: "horizontal", notch: false, ...fits }), { turn: 0, swallow: false });
});

test("a notch at the start of the page turns back", () => {
  const pager = createWheelPager();
  assert.deepEqual(pager(notch(0, top, -100)), { turn: -1, swallow: true });
});

test("scrolling that reaches the end stops there; a notch after a pause turns the page", () => {
  const pager = createWheelPager();
  assert.equal(pager(notch(0, middle)).turn, 0);
  // Reached the end within the same quick run of notches: no turn.
  assert.equal(pager(notch(50, bottom)).turn, 0);
  assert.equal(pager(notch(100, bottom)).turn, 0);
  // A pause, then one more notch.
  assert.equal(pager(notch(100 + WHEEL_GESTURE_GAP_MS + 1, bottom)).turn, 1);
});

test("a gesture turns at most one page and swallows the rest of it", () => {
  const pager = createWheelPager();
  assert.equal(pager(notch(0, bottom)).turn, 1);
  // The new page's content may not be laid out yet and look like it fits.
  assert.deepEqual(pager(notch(40, fits)), { turn: 0, swallow: true });
  assert.deepEqual(pager(notch(80, top)), { turn: 0, swallow: true });
  // Even reversed jitter within the gesture stays swallowed.
  assert.deepEqual(pager(notch(120, fits, -5)), { turn: 0, swallow: true });
  // After a pause the wheel scrolls the new page normally.
  assert.deepEqual(pager(notch(120 + WHEEL_GESTURE_GAP_MS + 1, top)), { turn: 0, swallow: false });
});

test("a touchpad must swipe on past the edge before the page turns", () => {
  const pager = createWheelPager();
  let time = 0;
  let turned = 0;
  let travelled = 0;
  while (!turned && travelled < 1000) {
    time += 16;
    travelled += 8;
    turned = pager({ dy: 8, time, notch: false, ...bottom }).turn;
  }
  assert.equal(turned, 1);
  assert.equal(travelled, TOUCHPAD_TURN_DISTANCE);
});

test("touchpad inertia that carries a scroll to the end does not turn the page", () => {
  const pager = createWheelPager();
  let time = 0;
  for (let dy = 60; dy > 0; dy -= 2) {
    time += 16;
    const decision = pager({ dy, time, notch: false, ...(time > 100 ? bottom : middle) });
    assert.deepEqual(decision, { turn: 0, swallow: false });
  }
});

test("reversing direction starts over from the edge it now heads for", () => {
  const pager = createWheelPager();
  assert.equal(pager(notch(0, bottom, -100)).turn, 0);
  assert.equal(pager(notch(30, bottom, 100)).turn, 1);
});

test("stepping pages stays within the paper or the translated pages", () => {
  const all = { pageCount: 10, translatedOnly: false, completed: [2, 5, 9] };
  assert.equal(steppedPage({ ...all, current: 3, amount: 1 }), 4);
  assert.equal(steppedPage({ ...all, current: 10, amount: 1 }), 10);
  assert.equal(steppedPage({ ...all, current: 1, amount: -1 }), 1);
  // Page count not known yet: stay put rather than jump.
  assert.equal(steppedPage({ ...all, pageCount: 0, current: 3, amount: 1 }), 3);
  const only = { ...all, translatedOnly: true };
  assert.equal(steppedPage({ ...only, current: 2, amount: 1 }), 5);
  assert.equal(steppedPage({ ...only, current: 9, amount: 1 }), 9);
  assert.equal(steppedPage({ ...only, current: 5, amount: -1 }), 2);
  assert.equal(steppedPage({ ...only, completed: [], current: 4, amount: 1 }), 4);
});

test("Home and End open the first and last pages, within the filter", () => {
  const state = { current: 4, pageCount: 10, translatedOnly: false, completed: [2, 5, 9] };
  assert.equal(edgePage("first", state), 1);
  assert.equal(edgePage("last", state), 10);
  assert.equal(edgePage("first", { ...state, translatedOnly: true }), 2);
  assert.equal(edgePage("last", { ...state, translatedOnly: true }), 9);
  assert.equal(edgePage("last", { ...state, translatedOnly: true, completed: [] }), 4);
});

const press = (key: string, extra: Partial<Parameters<typeof readerKeyAction>[0]> = {}) => readerKeyAction({
  key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target: "other", ...middle, ...extra,
});

test("PageDown and Space scroll by a screen, then turn to the next page at the end", () => {
  assert.deepEqual(press("PageDown"), { type: "scroll", direction: 1 });
  assert.deepEqual(press(" "), { type: "scroll", direction: 1 });
  assert.deepEqual(press("PageDown", bottom), { type: "turn", amount: 1, toEnd: false });
  assert.deepEqual(press(" ", fits), { type: "turn", amount: 1, toEnd: false });
});

test("PageUp and Shift+Space go back to the end of the previous page from the start", () => {
  assert.deepEqual(press("PageUp"), { type: "scroll", direction: -1 });
  assert.deepEqual(press(" ", { shiftKey: true }), { type: "scroll", direction: -1 });
  assert.deepEqual(press("PageUp", top), { type: "turn", amount: -1, toEnd: true });
  assert.deepEqual(press(" ", { shiftKey: true, ...top }), { type: "turn", amount: -1, toEnd: true });
});

test("Home, End and Alt+arrows", () => {
  assert.deepEqual(press("Home"), { type: "edge", edge: "first" });
  assert.deepEqual(press("End"), { type: "edge", edge: "last" });
  assert.deepEqual(press("ArrowLeft", { altKey: true }), { type: "history", direction: "back" });
  assert.deepEqual(press("ArrowRight", { altKey: true }), { type: "history", direction: "forward" });
  // Plain arrows stay with the existing page shortcuts; Shift+Home extends a text selection.
  assert.equal(press("ArrowLeft"), null);
  assert.equal(press("Home", { shiftKey: true }), null);
  assert.equal(press("PageDown", { ctrlKey: true }), null);
  assert.equal(press("Home", { altKey: true }), null);
});

test("⌘[ and ⌘] go back and forward as on the Mac, not with other modifiers nor in text fields", () => {
  assert.deepEqual(press("[", { metaKey: true }), { type: "history", direction: "back" });
  assert.deepEqual(press("]", { metaKey: true }), { type: "history", direction: "forward" });
  assert.equal(press("[", { ctrlKey: true }), null);
  assert.equal(press("[", { metaKey: true, shiftKey: true }), null);
  assert.equal(press("[", { metaKey: true, target: "editable" }), null);
  assert.equal(press("["), null);
});

test("keys are never taken from text fields, and Space is left to buttons", () => {
  for (const key of ["PageDown", "PageUp", " ", "Home", "End"]) assert.equal(press(key, { target: "editable" }), null);
  assert.equal(press("ArrowLeft", { altKey: true, target: "editable" }), null);
  assert.equal(press(" ", { target: "button" }), null);
  assert.deepEqual(press("PageDown", { target: "button" }), { type: "scroll", direction: 1 });
});

test("key targets are told apart by the element or its ancestors", () => {
  const element = (matches: string[]) => ({ closest: (selector: string) => matches.some((m) => selector.split(", ").includes(m)) ? {} : null });
  assert.equal(keyTarget(element(["input"])), "editable");
  assert.equal(keyTarget(element(["[role=menuitem]"])), "editable");
  assert.equal(keyTarget(element(["button"])), "button");
  assert.equal(keyTarget(element([])), "other");
  assert.equal(keyTarget(null), "other");
});

test("keys on the body belong to the reader only after a click in it", () => {
  // Focus in the reader, e.g. on a sticky note marker or the toolbar.
  assert.equal(readerOwnsKey({ place: "inside", pointerInReader: false, readerVisible: true }), true);
  // Clicked the page: the focus sits on the body or the tab panel around the reader.
  assert.equal(readerOwnsKey({ place: "around", pointerInReader: true, readerVisible: true }), true);
  // Clicked an empty spot of the side panel or the library: the focus is on the body too.
  assert.equal(readerOwnsKey({ place: "around", pointerInReader: false, readerVisible: true }), false);
  // Focus in the chat, the notes or the library.
  assert.equal(readerOwnsKey({ place: "elsewhere", pointerInReader: true, readerVisible: true }), false);
  // A reader kept mounted behind another tab takes nothing.
  assert.equal(readerOwnsKey({ place: "inside", pointerInReader: true, readerVisible: false }), false);
  assert.equal(readerOwnsKey({ place: "around", pointerInReader: true, readerVisible: false }), false);
});
