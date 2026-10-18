import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_HISTORY, goBack, goForward, rememberPlace, type HistoryEntry } from "../src/features/reader/readerHistory.ts";

const at = (page: number, anchor_y = 0, paperId = "p1"): HistoryEntry => ({ paperId, page, anchor_y });

test("back returns to where each jump left from, newest first, and forward undoes it", () => {
  // Read page 3, followed a link to 12, then a contents entry to 20.
  let history = rememberPlace(EMPTY_HISTORY, at(3, 0.4));
  history = rememberPlace(history, at(12, 0.1));
  const first = goBack(history, at(20, 0.7))!;
  assert.deepEqual(first.target, at(12, 0.1));
  const second = goBack(first.history, at(12, 0.3))!;
  assert.deepEqual(second.target, at(3, 0.4));
  assert.equal(goBack(second.history, at(3, 0.4)), null);
  const forward = goForward(second.history, at(3, 0.5))!;
  // Forward comes back to where back was pressed, at the view it had then.
  assert.deepEqual(forward.target, at(12, 0.3));
  assert.deepEqual(goForward(forward.history, at(12, 0))!.target, at(20, 0.7));
});

test("a new jump after going back drops what could be gone forward to", () => {
  let history = rememberPlace(EMPTY_HISTORY, at(3));
  const back = goBack(history, at(12))!;
  history = rememberPlace(back.history, at(3));
  assert.deepEqual(history.forward, []);
  assert.equal(goForward(history, at(7)), null);
});

test("jumps made from the same page keep only the latest place on it", () => {
  // Stepping through search results on page 5 without leaving it.
  let history = rememberPlace(EMPTY_HISTORY, at(2));
  history = rememberPlace(history, at(5, 0.2));
  history = rememberPlace(history, at(5, 0.6));
  assert.deepEqual(history.back, [at(2), at(5, 0.6)]);
});

test("history is kept to a limit, dropping the oldest", () => {
  let history = EMPTY_HISTORY;
  for (let page = 1; page <= 10; page++) history = rememberPlace(history, at(page), 4);
  assert.deepEqual(history.back.map((entry) => entry.page), [7, 8, 9, 10]);
});

test("places in another paper are skipped", () => {
  let history = rememberPlace(EMPTY_HISTORY, at(3, 0, "p1"));
  history = rememberPlace(history, at(8, 0, "p2"));
  const back = goBack(history, at(1, 0, "p1"))!;
  assert.deepEqual(back.target, at(3, 0, "p1"));
  assert.equal(goBack(history, at(1, 0, "p3")), null);
});
