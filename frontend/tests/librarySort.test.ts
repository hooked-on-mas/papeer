import assert from "node:assert/strict";
import { test } from "node:test";
import { librarySortOrder, SORT_LABELS } from "../src/lib/librarySort.ts";

test("a saved order the library offers is kept", () => {
  SORT_LABELS.forEach((_, order) => assert.equal(librarySortOrder(order), order));
  assert.equal(librarySortOrder("3"), 3);
});

test("any other saved order falls back to the newest first, which the sidecar accepts", () => {
  for (const value of [4, -1, 1.5, "x", null, undefined, NaN, {}, [2, 3]]) assert.equal(librarySortOrder(value), 0);
});
