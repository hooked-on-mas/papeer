import assert from "node:assert/strict";
import { test } from "node:test";
import { paperChangeEffects, withPaperCollection, withPaperRow } from "../src/lib/paperRows.ts";
import type { PaperData } from "../src/api/hooks.ts";
import { paperData } from "./support/paperData.ts";

const rows: PaperData[] = [
  paperData({ id: "a", title: "Alpha", translated_count: 0 }),
  paperData({ id: "b", title: "Beta", translated_count: 0 }),
];

test("a changed paper replaces its row in place, without the memo", () => {
  const next = withPaperRow(rows, "b", paperData({ id: "b", title: "Beta", translated_count: 3, note: "memo" }), "", 0);
  assert.deepEqual(next, [rows[0], paperData({ id: "b", title: "Beta", translated_count: 3 })]);
  assert.equal(next?.[0], rows[0]);
});

test("the list is loaded again when the row cannot simply be replaced", () => {
  // New to the list, or filtered by the sidecar.
  assert.equal(withPaperRow(rows, "c", paperData({ id: "c", title: "Gamma" }), "", 0), null);
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha" }), "alp", 0), null);
  // A new title may move it in an order by name, but not in an order by date.
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Zeta" }), "", 2), null);
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Zeta" }), "", 3), null);
  assert.deepEqual(withPaperRow(rows, "a", paperData({ id: "a", title: "Zeta" }), "", 1)?.map((row) => row.title), ["Zeta", "Beta"]);
  assert.deepEqual(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha", tags: ["x"] }), "", 2)?.[0].tags, ["x"]);
  // Likewise a new year, author or time of opening in the orders that go by them.
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha", publication_year: "2020" }), "", 4), null);
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha", first_author: "Smith" }), "", 5), null);
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Zeta" }), "", 5), null);
  assert.equal(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha", last_opened_at: "2026-09-28T00:00:00.000Z" }), "", 6), null);
  assert.ok(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha", last_opened_at: "2026-09-28T00:00:00.000Z" }), "", 4));
  // A value missing from one and null in the other is the same.
  assert.ok(withPaperRow(rows, "a", paperData({ id: "a", title: "Alpha", last_opened_at: null }), "", 6));
});

test("a removed paper leaves the list", () => {
  assert.deepEqual(withPaperRow(rows, "a", null, "", 0), [rows[1]]);
  assert.equal(withPaperRow(rows, "c", null, "", 0), rows);
});

test("a memo saved as it is typed reloads no row", () => {
  assert.deepEqual(paperChangeEffects(["note"]), { row: false, collections: false, tags: false });
  assert.deepEqual(paperChangeEffects(["note", "tags"]), { row: true, collections: false, tags: true });
  assert.deepEqual(paperChangeEffects(["collection_name"]), { row: true, collections: true, tags: false });
  assert.deepEqual(paperChangeEffects(undefined), { row: true, collections: true, tags: true });
});

test("a paper just moved shows in its new folder in place, before paper.changed brings its row", () => {
  const next = withPaperCollection(rows, "b", "ML/Vision");
  assert.deepEqual(next, [rows[0], { ...rows[1], collection_name: "ML/Vision" }]);
  assert.equal(next[0], rows[0]);
  // The row paper.changed brings then replaces it as it would have.
  const changed = paperData({ id: "b", title: "Beta", translated_count: 0, collection_name: "ML/Vision" });
  assert.deepEqual(withPaperRow(next, "b", changed, "", 0), [rows[0], changed]);
  // Not in the list, or there already: the list as it is.
  assert.equal(withPaperCollection(rows, "c", "ML"), rows);
  assert.equal(withPaperCollection(rows, "a", ""), rows);
});
