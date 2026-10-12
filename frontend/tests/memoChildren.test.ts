import assert from "node:assert/strict";
import { test } from "node:test";
import { memoChildren } from "../src/features/library/memoChildren.ts";
import { treeLines } from "../src/features/library/treeLines.ts";
import { treeKeyAction, treeRows } from "../src/features/library/treeKeys.ts";
import { buildTree } from "../src/features/library/libraryTree.ts";
import { paperData } from "./support/paperData.ts";

test("memo children show five in order and a uniquely keyed remainder, with tree keyboard navigation", () => {
  const paper = paperData({ id: "p", title: "Paper", attachment_count: 7 });
  const memos = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, title: `メモ${i}.md` }));
  const tree = buildTree([], [paper], [], false);
  const children = { of: () => memoChildren(memos), isOpen: () => true };
  const lines = treeLines(tree, () => true, children);
  assert.equal(lines.length, 8);
  assert.equal(new Set(lines.map(line => line.key)).size, lines.length);
  assert.equal(lines[7].kind, "more");
  assert.equal(lines[7].kind === "more" && lines[7].child.title, "ほか 2件");
  assert.deepEqual(lines.slice(2).map(line => [line.level, line.setSize, line.posInSet]),
    Array.from({ length: 6 }, (_, i) => [3, 6, i + 1]));
  const rows = treeRows(lines, paper => paper.title);
  assert.deepEqual(treeKeyAction(rows, "paper:p", "ArrowRight"), { type: "focus", key: "attachment:p:m0" });
  assert.deepEqual(treeKeyAction(rows, "attachment:p:m0", "ArrowLeft"), { type: "focus", key: "paper:p" });
  const closed = treeLines(tree, () => true, { ...children, isOpen: () => false });
  assert.equal(closed.length, 2);
  assert.equal(closed[1].kind === "paper" && closed[1].expandable, true);
  assert.equal(memoChildren([]).length, 0);
});


test("notebooks and memos share the five-row limit and owned rows activate separately", () => {
  const memos = [{ id: "m", title: "memo" }];
  const notebooks = Array.from({ length: 6 }, (_, index) => ({ id: `n${index}`, title: `notebook${index}` }));
  const children = memoChildren(memos, notebooks);
  assert.equal(children.filter(row => row.kind === "owned").length, 5);
  assert.deepEqual(children[5], { kind: "more", id: "more", title: "ほか 2件" });
});
