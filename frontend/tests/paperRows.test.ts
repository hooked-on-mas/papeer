import assert from "node:assert/strict";
import { test } from "node:test";
import { paperChangeEffects, withPaperRow } from "../src/lib/paperRows.ts";
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
