import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createOpenTracker, openedAgo, recentlyOpened } from "../src/lib/recentPapers.ts";
import type { PaperData } from "../src/api/hooks.ts";

test("a paper counts as opened once it has stayed open, and once only", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sent: string[] = [];
    const track = createOpenTracker((id) => sent.push(id), 1000);
    track("a");
    mock.timers.tick(500);
    track("b"); // Passed on the way: not opened.
    mock.timers.tick(999);
    assert.deepEqual(sent, []);
    track("b"); // The same paper again (a page turn): the wait goes on.
    mock.timers.tick(1);
    assert.deepEqual(sent, ["b"]);
    track("b");
    mock.timers.tick(5000);
    assert.deepEqual(sent, ["b"]);
    track(null); // Closed, then opened again: counts again.
    track("b");
    mock.timers.tick(1000);
    assert.deepEqual(sent, ["b", "b"]);
    track("c");
    track(null);
    mock.timers.tick(5000);
    assert.deepEqual(sent, ["b", "b"]);
  } finally {
    mock.timers.reset();
  }
});

test("the recently opened papers are those opened on this PC, the last opened first", () => {
  const papers: PaperData[] = [
    { id: "a", title: "A", last_opened_at: "2026-09-01T00:00:00.000Z" },
    { id: "b", title: "B", last_opened_at: null },
    { id: "c", title: "C" },
    { id: "d", title: "D", last_opened_at: "2026-09-03T00:00:00.000Z" },
    { id: "e", title: "E", last_opened_at: "2026-09-02T00:00:00.000Z" },
  ];
  assert.deepEqual(recentlyOpened(papers, 5).map((paper) => paper.id), ["d", "e", "a"]);
  assert.deepEqual(recentlyOpened(papers, 2).map((paper) => paper.id), ["d", "e"]);
  assert.equal(papers[0].id, "a"); // Not sorted in place.
});

test("how long ago a paper was opened", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  assert.equal(openedAgo("2026-09-28T11:59:30.000Z", now), "たった今");
  assert.equal(openedAgo("2026-09-28T11:55:00.000Z", now), "5分前");
  assert.equal(openedAgo("2026-09-28T09:00:00.000Z", now), "3時間前");
  assert.equal(openedAgo("2026-09-26T11:00:00.000Z", now), "2日前");
  assert.match(openedAgo("2026-09-01T12:00:00.000Z", now), /^2026\/9\/1$/);
  assert.equal(openedAgo("x", now), "");
});
