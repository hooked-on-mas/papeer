import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWheelPager, edgePage, keyTarget, paneEdges, readerKeyAction, readerOwnsKey, steppedPage, TOUCHPAD_TURN_DISTANCE, WHEEL_GESTURE_GAP_MS,
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

test("a mouse notch at the end of the page turns to the next one", () => {
  const pager = createWheelPager();
  assert.deepEqual(pager(notch(0, bottom)), { turn: 1, swallow: true });
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
