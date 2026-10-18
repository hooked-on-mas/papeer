import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultNotebookTitle, savedNotebookPaper } from "../src/features/notebooks/paperSpec.ts";

test("a new notebook is named 「ノート M/D」 from today's date, with a number when that name is taken in the folder", () => {
  const today = new Date(2026, 9, 18);
  assert.equal(defaultNotebookTitle(today, []), "ノート 10/18");
  assert.equal(defaultNotebookTitle(new Date(2026, 0, 5), ["ノート 10/18"]), "ノート 1/5");
  assert.equal(defaultNotebookTitle(today, ["ノート 10/18", "別のノート"]), "ノート 10/18 (2)");
  assert.equal(defaultNotebookTitle(today, ["ノート 10/18", "ノート 10/18 (2)"]), "ノート 10/18 (3)");
  // A gap is filled first.
  assert.equal(defaultNotebookTitle(today, ["ノート 10/18", "ノート 10/18 (3)"]), "ノート 10/18 (2)");
  assert.equal(defaultNotebookTitle(today, new Set(["ノート 10/18"])), "ノート 10/18 (2)");
});

test("the paper of the last notebook is read back whole, and anything broken gives none", () => {
  const paper = { size: "B5", orientation: "landscape", template: "grid10", color: "cream" };
  assert.deepEqual(savedNotebookPaper(paper), paper);
  // Only the four choices are kept.
  assert.deepEqual(savedNotebookPaper({ ...paper, extra: 1 }), paper);
  for (const broken of [null, undefined, "A4", 3, [], {}, { ...paper, size: "A0" }, { ...paper, orientation: "diagonal" },
    { ...paper, template: "ruled99" }, { ...paper, color: "red" }, { ...paper, color: undefined }, { size: "A4" }]) {
    assert.equal(savedNotebookPaper(broken), null, JSON.stringify(broken));
  }
});
