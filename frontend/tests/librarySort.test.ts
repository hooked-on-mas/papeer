import assert from "node:assert/strict";
import { test } from "node:test";
import { librarySortOrder, orderFields, RECENT_ORDER, SORT_LABELS, TITLE_ORDERS } from "../src/lib/librarySort.ts";

test("a saved order the library offers is kept", () => {
  SORT_LABELS.forEach((_, order) => assert.equal(librarySortOrder(order), order));
  assert.equal(librarySortOrder("3"), 3);
  assert.equal(librarySortOrder(RECENT_ORDER), RECENT_ORDER);
});

test("any other saved order falls back to the newest first, which the sidecar accepts", () => {
  // An order a later version added (7…), or anything that is not one.
  for (const value of [SORT_LABELS.length, 99, -1, 1.5, "x", null, undefined, NaN, {}, [2, 3]]) assert.equal(librarySortOrder(value), 0);
});

test("the orders by date go by nothing a paper's row can change; the others name what they go by", () => {
  for (const order of [0, 1]) assert.deepEqual(orderFields(order), []);
  for (const order of TITLE_ORDERS) assert.deepEqual(orderFields(order), ["title"]);
  assert.deepEqual(orderFields(4), ["publication_year"]);
  assert.deepEqual(orderFields(5), ["first_author", "title"]);
  assert.deepEqual(orderFields(RECENT_ORDER), ["last_opened_at"]);
  assert.equal(SORT_LABELS[RECENT_ORDER], "最近開いた順");
});
