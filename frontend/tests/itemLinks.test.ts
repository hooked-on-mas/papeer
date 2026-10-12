import assert from "node:assert/strict";
import { test } from "node:test";
import { canLinkItems } from "../src/lib/itemKinds.ts";
import { canDropLink, linkedItemsByOwner } from "../src/features/library/itemLinks.ts";
import { memoChildren } from "../src/features/library/memoChildren.ts";
import { buildTree } from "../src/features/library/libraryTree.ts";
import { pinnedLines, treeLines } from "../src/features/library/treeLines.ts";
import { treeKeyAction, treeRows } from "../src/features/library/treeKeys.ts";
import { paperData } from "./support/paperData.ts";

const paper = paperData({ id: "p", kind: "pdf", title: "Paper", collection_name: "papers" });
const otherPaper = paperData({ id: "q", kind: "pdf", title: "Other paper" });
const notebook = paperData({ id: "n", kind: "notebook", title: "Notebook", collection_name: "notes" });
const held = paperData({ id: "h", kind: "notebook", parent_id: "p" });

test("links accept independent paper/notebook pairs and a paper-only multi-drag", () => {
  assert.equal(canLinkItems(paper, notebook), true);
  assert.equal(canLinkItems(notebook, paper), true);
  for (const [a, b] of [[paper, otherPaper], [notebook, notebook], [paper, held], [held, notebook], [undefined, notebook]]) {
    assert.equal(canLinkItems(a, b), false);
  }
  const items = [paper, otherPaper, notebook, held];
  assert.equal(canDropLink(["p", "q"], notebook, items), true);
  for (const ids of [[], ["p", "n"], ["p", "h"], ["missing"], ["n"]]) assert.equal(canDropLink(ids, notebook, items), false);
  assert.equal(canDropLink(["p"], held, items), false);
  assert.equal(canDropLink(["n"], paper, items), false);
});

test("bilateral link rows preserve original placement, deduplicate and ignore unavailable targets", () => {
  const byOwner = linkedItemsByOwner([{ a: "n", b: "p" }, { a: "p", b: "n" }, { a: "n", b: "gone" }], [paper, notebook]);
  assert.deepEqual(byOwner.get("p"), [notebook]);
  assert.deepEqual(byOwner.get("n"), [paper]);
  assert.equal(paper.collection_name, "papers");
  assert.equal(notebook.collection_name, "notes");
});

test("holdings precede links under the shared five-row limit; hiding links removes their remainder too", () => {
  const memos = Array.from({ length: 4 }, (_, index) => ({ id: `m${index}`, title: `Memo${index}` }));
  const children = memoChildren(memos, [held], [notebook, otherPaper]);
  assert.deepEqual(children.map(row => row.kind), ["owned", "attachment", "attachment", "attachment", "attachment", "more"]);
  assert.equal(children[5].title, "ほか 2件");
  assert.equal(memoChildren(memos, [held], []).length, 5);
});

test("links cannot expand, have unique owner keys and leave original counts unchanged", () => {
  const tree = buildTree(["papers", "notes"], [paper, notebook], [], false);
  const byOwner = linkedItemsByOwner([{ a: "n", b: "p" }], [paper, notebook]);
  const lines = treeLines(tree, () => true, { of: item => memoChildren([], [], byOwner.get(item.id)), isOpen: () => true });
  assert.equal(lines.filter(row => row.kind === "paper").length, 2);
  assert.equal(lines.filter(row => row.kind === "link").length, 2);
  assert.equal(new Set(lines.map(row => row.key)).size, lines.length);
  const rows = treeRows(lines, row => row.title);
  assert.deepEqual(treeKeyAction(rows, "link:n:p", "ArrowRight"), { type: "none" });
  assert.deepEqual(treeKeyAction(rows, "link:n:p", "ArrowLeft"), { type: "focus", key: "paper:n" });
  assert.deepEqual(treeKeyAction(rows, "link:n:p", "Enter"), { type: "activate", row: rows.find(row => row.key === "link:n:p") });
  const index = new Map(lines.map((line, at) => [line.key, at]));
  const pinned = pinnedLines(lines, index, [], true);
  assert.ok(pinned.includes(index.get("paper:n")!));
  assert.ok(!pinned.includes(index.get("paper:p")!));
  assert.ok(!pinned.includes(index.get("link:n:p")!));
});
