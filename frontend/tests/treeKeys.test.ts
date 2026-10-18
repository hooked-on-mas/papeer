import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree } from "../src/features/library/libraryTree.ts";
import {
  dropRowAt, folderKey, nextDropRow, paperKey, resolveTabStop, rowAfterRemoval, selectedRowKey, treeKeyAction, typeaheadMatch,
  visibleRows,
  type TreeRow,
} from "../src/features/library/treeKeys.ts";
import type { PaperData } from "../src/api/hooks.ts";
import { paperData } from "./support/paperData.ts";

const paper = (id: string, collection_name = "", title = id): PaperData => paperData({ id, title, collection_name });

// ML (open) > Vision (closed) > v1; ML > m1, m2; Bio (closed) > b1; 未分類 (open) > u1.
const papers = [paper("m1", "ML", "Attention"), paper("m2", "ML", "Adam"), paper("v1", "ML / Vision"), paper("b1", "Bio"), paper("u1", "", "Unfiled")];
const tree = buildTree([], papers, [{ path: "C:/x.pdf", name: "x.pdf", collection: "ML" }], false);
const open = new Set(["ML", ""]);
const rows = visibleRows(tree, (path) => open.has(path), (p) => p.title ?? "");
const keys = (list: TreeRow[]) => list.map((row) => row.key);
const rowOf = (key: string): TreeRow => rows.find((row) => row.key === key)!;

test("the rows on screen are the folders and, in open folders, their subfolders then papers, without PDFs being added", () => {
  assert.deepEqual(keys(rows), [
    folderKey("Bio"), folderKey("ML"), folderKey("ML / Vision"), paperKey("m1"), paperKey("m2"), folderKey(""), paperKey("u1"),
  ]);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.deepEqual(byKey.get(folderKey("ML / Vision")), {
    key: folderKey("ML / Vision"), kind: "folder", id: "ML / Vision", folder: "ML / Vision", level: 2, parent: folderKey("ML"),
    expandable: true, expanded: false, label: "Vision",
  });
  assert.deepEqual(byKey.get(paperKey("m1")), {
    key: paperKey("m1"), kind: "paper", id: "m1", folder: "ML", level: 2, parent: folderKey("ML"), expandable: false, expanded: false,
    label: "Attention",
  });
  assert.equal(byKey.get(folderKey(""))?.level, 1);
  assert.equal(byKey.get(folderKey(""))?.parent, null);
});

test("the Tab key goes to the focused row while it is on screen, else to the selected one, else to the first", () => {
  assert.equal(resolveTabStop(rows, paperKey("m2"), paperKey("u1")), paperKey("m2"));
  // v1 is in the closed folder Vision.
  assert.equal(resolveTabStop(rows, paperKey("v1"), paperKey("u1")), paperKey("u1"));
  assert.equal(resolveTabStop(rows, null, folderKey("")), folderKey(""));
  assert.equal(resolveTabStop(rows, paperKey("gone"), paperKey("b1")), folderKey("Bio"));
  assert.equal(resolveTabStop([], paperKey("m1"), null), null);
});

test("the selected row is the chosen folder, or else the open paper", () => {
  assert.equal(selectedRowKey({ selectedFolder: "ML", activePaperId: "m1" }), folderKey("ML"));
  assert.equal(selectedRowKey({ selectedFolder: "", activePaperId: "m1" }), folderKey(""));
  assert.equal(selectedRowKey({ selectedFolder: null, activePaperId: "m1" }), paperKey("m1"));
  assert.equal(selectedRowKey({ selectedFolder: null, activePaperId: null }), null);
});

test("↑↓ move to the row above and below, Home and End to the first and last, and stop at the ends", () => {
  assert.deepEqual(treeKeyAction(rows, paperKey("m1"), "ArrowDown"), { type: "focus", key: paperKey("m2") });
  assert.deepEqual(treeKeyAction(rows, paperKey("m1"), "ArrowUp"), { type: "focus", key: folderKey("ML / Vision") });
  assert.deepEqual(treeKeyAction(rows, paperKey("m2"), "ArrowDown"), { type: "focus", key: folderKey("") });
  assert.deepEqual(treeKeyAction(rows, paperKey("m1"), "Home"), { type: "focus", key: folderKey("Bio") });
  assert.deepEqual(treeKeyAction(rows, paperKey("m1"), "End"), { type: "focus", key: paperKey("u1") });
  // Nothing to do, but still the tree's key rather than the page's (← and → would turn the PDF's page).
  assert.deepEqual(treeKeyAction(rows, folderKey("Bio"), "ArrowUp"), { type: "none" });
  assert.deepEqual(treeKeyAction(rows, paperKey("u1"), "ArrowDown"), { type: "none" });
  assert.deepEqual(treeKeyAction(rows, paperKey("u1"), "End"), { type: "none" });
});

test("→ opens a closed folder, then moves to its first row; on an open folder with nothing shown, or on a paper, it stays", () => {
  assert.deepEqual(treeKeyAction(rows, folderKey("Bio"), "ArrowRight"), { type: "expand", row: rowOf(folderKey("Bio")) });
  assert.deepEqual(treeKeyAction(rows, folderKey("ML"), "ArrowRight"), { type: "focus", key: folderKey("ML / Vision") });
  assert.deepEqual(treeKeyAction(rows, folderKey(""), "ArrowRight"), { type: "focus", key: paperKey("u1") });
  assert.deepEqual(treeKeyAction(rows, paperKey("m1"), "ArrowRight"), { type: "none" });
  const empty = visibleRows(buildTree(["Empty"], [], [], false), () => true, () => "");
  assert.deepEqual(treeKeyAction(empty, folderKey("Empty"), "ArrowRight"), { type: "none" });
});

test("← closes an open folder, and otherwise moves to the folder the row is in", () => {
  assert.deepEqual(treeKeyAction(rows, folderKey("ML"), "ArrowLeft"), { type: "collapse", row: rowOf(folderKey("ML")) });
  assert.deepEqual(treeKeyAction(rows, paperKey("m2"), "ArrowLeft"), { type: "focus", key: folderKey("ML") });
  assert.deepEqual(treeKeyAction(rows, folderKey("ML / Vision"), "ArrowLeft"), { type: "focus", key: folderKey("ML") });
  assert.deepEqual(treeKeyAction(rows, folderKey("Bio"), "ArrowLeft"), { type: "none" });
  // While searching or filtering the folders cannot be closed, so ← only moves up.
  assert.deepEqual(treeKeyAction(rows, folderKey("ML"), "ArrowLeft", { canCollapse: false }), { type: "none" });
  assert.deepEqual(treeKeyAction(rows, folderKey("ML / Vision"), "ArrowLeft", { canCollapse: false }), { type: "focus", key: folderKey("ML") });
});

test("Enter activates the row; other keys are left to the page", () => {
  assert.deepEqual(treeKeyAction(rows, paperKey("m1"), "Enter"), { type: "activate", row: rows[3] });
  assert.deepEqual(treeKeyAction(rows, folderKey("Bio"), "Enter"), { type: "activate", row: rows[0] });
  for (const key of ["Delete", "F2", " ", "a", "Tab", "PageDown"]) assert.equal(treeKeyAction(rows, paperKey("m1"), key), null);
});

test("from a row no longer on screen, the arrows go to the first row", () => {
  assert.deepEqual(treeKeyAction(rows, paperKey("v1"), "ArrowDown"), { type: "focus", key: folderKey("Bio") });
  assert.deepEqual(treeKeyAction(rows, paperKey("v1"), "Enter"), { type: "none" });
  assert.deepEqual(treeKeyAction([], paperKey("v1"), "ArrowDown"), { type: "none" });
});

test("after a row is deleted the keys go to the row below it, past a folder's own rows, or else to the row above", () => {
  // Rows: Bio, ML, ML / Vision, m1, m2, 未分類, u1.
  assert.equal(rowAfterRemoval(rows, paperKey("m1")), paperKey("m2"));
  assert.equal(rowAfterRemoval(rows, paperKey("m2")), folderKey(""));
  assert.equal(rowAfterRemoval(rows, folderKey("Bio")), folderKey("ML"));
  // ML goes with its subfolder and papers (its papers go to 未分類).
  assert.equal(rowAfterRemoval(rows, folderKey("ML")), folderKey(""));
  assert.equal(rowAfterRemoval(rows, folderKey("ML / Vision")), paperKey("m1"));
  // The last row: the one above.
  assert.equal(rowAfterRemoval(rows, paperKey("u1")), folderKey(""));
  const open = visibleRows(tree, () => true, (p) => p.title ?? "");
  // An open folder with a subfolder: past both, to its own papers' row after them.
  assert.deepEqual(keys(open).slice(2, 6), [folderKey("ML"), folderKey("ML / Vision"), paperKey("v1"), paperKey("m1")]);
  assert.equal(rowAfterRemoval(open, folderKey("ML / Vision")), paperKey("m1"));
  // Nothing left, or not on screen.
  assert.equal(rowAfterRemoval([rows[6]], paperKey("u1")), null);
  assert.equal(rowAfterRemoval(rows, paperKey("v1")), null);
});

test("typing moves to the next row starting with the letters typed, going round, and repeating a letter steps through its rows", () => {
  // From m1 (Attention): "a" goes to the next row starting with it, Adam, then round to Attention.
  assert.equal(typeaheadMatch(rows, paperKey("m1"), "a"), paperKey("m2"));
  assert.equal(typeaheadMatch(rows, paperKey("m2"), "a"), paperKey("m1"));
  assert.equal(typeaheadMatch(rows, paperKey("m2"), "aa"), paperKey("m1"));
  // Longer text looks from the current row, which may still match; case is ignored.
  assert.equal(typeaheadMatch(rows, paperKey("m1"), "AT"), paperKey("m1"));
  assert.equal(typeaheadMatch(rows, paperKey("m2"), "at"), paperKey("m1"));
  assert.equal(typeaheadMatch(rows, null, "u"), paperKey("u1"));
  assert.equal(typeaheadMatch(rows, paperKey("m1"), "未"), folderKey(""));
  assert.equal(typeaheadMatch(rows, paperKey("m1"), "zz"), null);
  assert.equal(typeaheadMatch(rows, paperKey("m1"), ""), null);
});

const folders = [
  { id: "folder:A", top: 0, bottom: 30 },
  { id: "folder:B", top: 30, bottom: 60 },
  // Papers of B between 60 and 150.
  { id: "folder:C", top: 150, bottom: 180 },
];

test("a paper dragged with the keyboard is over the folder row across its middle, or none", () => {
  assert.equal(dropRowAt(folders, 45), "folder:B");
  assert.equal(dropRowAt(folders, 30), "folder:B");
  assert.equal(dropRowAt(folders, 100), null);
  assert.equal(dropRowAt([], 10), null);
});

test("↑↓ move a paper dragged with the keyboard to the nearest folder row above or below its middle", () => {
  // It starts over its own row, between folders: ↓ goes to the next folder, ↑ to the one above.
  assert.equal(nextDropRow(folders, 100, 1)?.id, "folder:C");
  assert.equal(nextDropRow(folders, 100, -1)?.id, "folder:B");
  // Over a folder, its own middle is not a step.
  assert.equal(nextDropRow(folders, 45, 1)?.id, "folder:C");
  assert.equal(nextDropRow(folders, 45, -1)?.id, "folder:A");
  assert.equal(nextDropRow(folders, 165, 1), null);
  assert.equal(nextDropRow(folders, 15, -1), null);
  // The rows need not be in order.
  assert.equal(nextDropRow([...folders].reverse(), 45, 1)?.id, "folder:C");
});
