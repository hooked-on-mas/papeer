import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree } from "../src/features/library/libraryTree.ts";
import { folderKey, paperKey, visibleRows } from "../src/features/library/treeKeys.ts";
import {
  NO_SELECTION, papersActedOn, pruneSelection, rowAfterRemovingRows, selectAllPapers, selectedPapers, selectionInOrder,
  selectRange, toggleSelection, type PaperSelection,
} from "../src/features/library/paperSelection.ts";
import type { PaperData } from "../src/api/hooks.ts";
import { paperData } from "./support/paperData.ts";

const paper = (id: string, collection_name = ""): PaperData => paperData({ id, collection_name });

// Bio (closed) > b1; ML > Vision > v1; ML > m1, m2; 未分類 > u1, u2.
const papers = [paper("m1", "ML"), paper("m2", "ML"), paper("v1", "ML / Vision"), paper("b1", "Bio"), paper("u1"), paper("u2")];
const tree = buildTree([], papers, [], false);
const rowsWith = (open: string[]) => visibleRows(tree, (path) => open.includes(path), (p) => p.title);
const rows = rowsWith(["ML", "ML / Vision", ""]);
const ids = (selection: PaperSelection) => selection.ids === null ? null : [...selection.ids].sort();

test("the rows are, in order, the folders and the papers of open folders", () => {
  assert.deepEqual(rows.map((row) => row.key), [
    folderKey("Bio"), folderKey("ML"), folderKey("ML / Vision"), paperKey("v1"), paperKey("m1"), paperKey("m2"),
    folderKey(""), paperKey("u1"), paperKey("u2"),
  ]);
});

test("until several are selected, what is selected is the open paper while it is on screen", () => {
  assert.deepEqual([...selectedPapers(NO_SELECTION, rows, "m1")], ["m1"]);
  assert.deepEqual([...selectedPapers(NO_SELECTION, rows, null)], []);
  // b1 is in the closed folder Bio.
  assert.deepEqual([...selectedPapers(NO_SELECTION, rows, "b1")], []);
  // Once there is a set, it is the selection, even empty, whatever is open.
  assert.deepEqual([...selectedPapers({ ids: new Set(), anchor: null }, rows, "m1")], []);
});

test("Ctrl toggles a paper, starting from the open paper, and makes it the anchor", () => {
  const first = toggleSelection(NO_SELECTION, rows, paperKey("u1"), "m1");
  assert.deepEqual(ids(first), ["m1", "u1"]);
  assert.equal(first.anchor, paperKey("u1"));
  const second = toggleSelection(first, rows, paperKey("m1"), "m1");
  assert.deepEqual(ids(second), ["u1"]);
  assert.equal(second.anchor, paperKey("m1"));
  // Every paper toggled off leaves an empty selection, not the open paper again.
  assert.deepEqual(ids(toggleSelection(second, rows, paperKey("u1"), "m1")), []);
  // With a folder chosen (no open paper passed), it starts from nothing.
  assert.deepEqual(ids(toggleSelection(NO_SELECTION, rows, paperKey("u1"), null)), ["u1"]);
  // Folders are not selected with papers, nor rows off screen.
  assert.equal(toggleSelection(first, rows, folderKey("ML"), "m1"), first);
  assert.equal(toggleSelection(first, rows, paperKey("b1"), "m1"), first);
});

test("Shift selects the papers from the anchor to the row, both included, past the folder rows between", () => {
  const anchored: PaperSelection = { ids: null, anchor: paperKey("m1") };
  const down = selectRange(anchored, rows, paperKey("u1"), null);
  assert.deepEqual(ids(down), ["m1", "m2", "u1"]);
  assert.equal(down.anchor, paperKey("m1"));
  // The range grows and shrinks from the anchor, and goes up as well as down.
  assert.deepEqual(ids(selectRange(down, rows, paperKey("m2"), null)), ["m1", "m2"]);
  assert.deepEqual(ids(selectRange(down, rows, paperKey("v1"), null)), ["m1", "v1"]);
  assert.deepEqual(ids(selectRange(down, rows, paperKey("m1"), null)), ["m1"]);
  // To a folder row: the papers up to it.
  assert.deepEqual(ids(selectRange(anchored, rows, folderKey(""), null)), ["m1", "m2"]);
  // From a folder row (the one last chosen).
  assert.deepEqual(ids(selectRange({ ids: null, anchor: folderKey("ML") }, rows, paperKey("m1"), null)), ["m1", "v1"]);
});

test("without an anchor on screen, Shift starts from the open paper, else from the row itself", () => {
  assert.deepEqual(ids(selectRange(NO_SELECTION, rows, paperKey("u2"), "m2")), ["m2", "u1", "u2"]);
  assert.equal(selectRange(NO_SELECTION, rows, paperKey("u2"), "m2").anchor, paperKey("m2"));
  const gone: PaperSelection = { ids: null, anchor: paperKey("b1") };
  assert.deepEqual(ids(selectRange(gone, rows, paperKey("u2"), null)), ["u2"]);
  assert.equal(selectRange(gone, rows, paperKey("u2"), null).anchor, paperKey("u2"));
  // A row that is not on screen changes nothing.
  assert.equal(selectRange(gone, rows, paperKey("b1"), null), gone);
});

test("Ctrl+Shift adds the range to what was selected", () => {
  const some: PaperSelection = { ids: new Set(["u2"]), anchor: paperKey("v1") };
  assert.deepEqual(ids(selectRange(some, rows, paperKey("m1"), null, { add: true })), ["m1", "u2", "v1"]);
  assert.deepEqual(ids(selectRange(some, rows, paperKey("m1"), null)), ["m1", "v1"]);
  // Starting from the open paper, which is kept.
  assert.deepEqual(ids(selectRange({ ids: null, anchor: paperKey("u1") }, rows, paperKey("u2"), "m1", { add: true })), ["m1", "u1", "u2"]);
});

test("Ctrl+A selects every paper on screen and keeps the anchor", () => {
  const all = selectAllPapers({ ids: null, anchor: paperKey("u1") }, rows);
  assert.deepEqual(ids(all), ["m1", "m2", "u1", "u2", "v1"]);
  assert.equal(all.anchor, paperKey("u1"));
  assert.deepEqual(ids(selectAllPapers(NO_SELECTION, [])), []);
});

test("papers leave the selection when they leave the screen, and the tree gets its one selected row back when none is left", () => {
  const some: PaperSelection = { ids: new Set(["v1", "m1", "u1"]), anchor: paperKey("v1") };
  // Nothing left: the same object, so that the rows do not render again.
  assert.equal(pruneSelection(some, rows), some);
  assert.equal(pruneSelection(NO_SELECTION, rows), NO_SELECTION);
  // Vision closed: v1 leaves, and so does the anchor.
  const closed = pruneSelection(some, rowsWith(["ML", ""]));
  assert.deepEqual(ids(closed), ["m1", "u1"]);
  assert.equal(closed.anchor, null);
  // The search's results replace the tree, which has no rows then.
  assert.deepEqual(pruneSelection(some, []), NO_SELECTION);
  // An empty selection the user made stays empty.
  const empty: PaperSelection = { ids: new Set(), anchor: null };
  assert.equal(pruneSelection(empty, rows), empty);
});

test("what is done to a paper in a selection of several is done to them all, in the order on screen", () => {
  const some: PaperSelection = { ids: new Set(["u1", "m2", "v1"]), anchor: null };
  assert.deepEqual(selectionInOrder(rows, some.ids!), ["v1", "m2", "u1"]);
  assert.deepEqual(papersActedOn(some, rows, "m2"), ["v1", "m2", "u1"]);
  // A paper outside it, a selection of one, or none: that paper alone.
  assert.deepEqual(papersActedOn(some, rows, "m1"), ["m1"]);
  assert.deepEqual(papersActedOn({ ids: new Set(["m2"]), anchor: null }, rows, "m2"), ["m2"]);
  assert.deepEqual(papersActedOn(NO_SELECTION, rows, "m2"), ["m2"]);
});

test("after deleting papers together, the keys go to the next row that stays, else the one above", () => {
  const removed = new Set([paperKey("m1"), paperKey("m2")]);
  assert.equal(rowAfterRemovingRows(rows, paperKey("m1"), removed), folderKey(""));
  assert.equal(rowAfterRemovingRows(rows, paperKey("m2"), removed), folderKey(""));
  assert.equal(rowAfterRemovingRows(rows, paperKey("u2"), new Set([paperKey("u1"), paperKey("u2")])), folderKey(""));
  assert.equal(rowAfterRemovingRows(rows, paperKey("b1"), removed), null);
  // A single paper, as rowAfterRemoval.
  assert.equal(rowAfterRemovingRows(rows, paperKey("m2"), new Set([paperKey("m2")])), folderKey(""));
  assert.equal(rowAfterRemovingRows(rows, paperKey("u2"), new Set([paperKey("u2")])), paperKey("u1"));
});

test("until several are selected, Shift+↑↓ start from the row the keys were on, not from the row last clicked", () => {
  // m1 was opened by a click (its row is the anchor); the keys then moved to u1, and Shift+↓ goes to u2.
  const clicked: PaperSelection = { ids: null, anchor: paperKey("m1") };
  const first = selectRange(clicked, rows, paperKey("u2"), "m1", { from: paperKey("u1") });
  assert.deepEqual(ids(first), ["u1", "u2"]);
  assert.equal(first.anchor, paperKey("u1"));
  // Once there is a selection, its anchor comes first, and the range grows from it.
  assert.deepEqual(ids(selectRange(first, rows, folderKey(""), "m1", { from: paperKey("u2") })), ["u1"]);
  assert.deepEqual(ids(selectRange({ ids: new Set(["u2"]), anchor: paperKey("m2") }, rows, paperKey("u1"), null, { from: paperKey("u2") })),
    ["m2", "u1"]);
  // A row the keys were on that has left the screen is passed over.
  assert.deepEqual(ids(selectRange(clicked, rows, paperKey("m2"), null, { from: paperKey("b1") })), ["m1", "m2"]);
});

test("rows under a paper are not papers to select, and go with the paper that is deleted", () => {
  const held = { m1: [{ kind: "attachment" as const, id: "a1", title: "メモ" }, { kind: "link" as const, id: "u1", title: "紐づけ" }] };
  const withRows = visibleRows(tree, (path) => ["ML", "ML / Vision", ""].includes(path), (p) => p.title,
    { of: (p) => held[p.id as "m1"] ?? [], isOpen: (id) => id === "m1" });
  assert.deepEqual(withRows.slice(4, 8).map((row) => row.key), [paperKey("m1"), "attachment:m1:a1", "link:m1:u1", paperKey("m2")]);
  // Ctrl+A and a range take the papers only.
  assert.deepEqual(ids(selectAllPapers(NO_SELECTION, withRows)), ["m1", "m2", "u1", "u2", "v1"]);
  assert.deepEqual(ids(selectRange(NO_SELECTION, withRows, paperKey("m2"), "m1")), ["m1", "m2"]);
  // Clicking one of them is no paper selected.
  assert.equal(toggleSelection(NO_SELECTION, withRows, "attachment:m1:a1", null), NO_SELECTION);
  // m1 deleted: its rows go too, so the keys go to m2, not to one of them.
  assert.equal(rowAfterRemovingRows(withRows, paperKey("m1"), new Set([paperKey("m1")])), paperKey("m2"));
  // From one of its rows, as well: past the paper and what is under it.
  assert.equal(rowAfterRemovingRows(withRows, "attachment:m1:a1", new Set([paperKey("m1")])), paperKey("m2"));
  // Both papers deleted: the folder row is the first one left below.
  assert.equal(rowAfterRemovingRows(withRows, paperKey("m1"), new Set([paperKey("m1"), paperKey("m2")])), folderKey(""));
});
