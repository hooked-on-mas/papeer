import assert from "node:assert/strict";
import { test } from "node:test";
import { toLibraryItems } from "../src/runtime/libraryItems.ts";
import type { ArtifactView } from "../src/runtime/contracts.ts";
import { buildWebLibraryTree } from "../src/web/librarySidebarTree.ts";

const items = toLibraryItems([
  { id: "paper", title: "制御の理論", first_author: "Smith", publication_year: "2024", collection_name: "理論/制御" },
  { id: "other", title: "別の論文", collection_name: "実験" },
  { id: "unfiled", title: "未整理" },
  { id: "independent", title: "独立ノート", kind: "notebook", collection_name: "理論\\制御" },
  { id: "owned", title: "専用ノート", kind: "notebook", parent_id: "paper", collection_name: "古い分類" },
  { id: "orphan", title: "持ち主のないノート", kind: "notebook", parent_id: "missing", collection_name: "実験" },
]);
const memo: ArtifactView = { id: "memo", itemId: "paper", role: "attachment", label: "実験条件のメモ", filename: "memo.md", mediaType: "text/markdown" };

test("Web tree normalizes desktop folder paths, keeps unfiled last and nests owned notebooks only once", () => {
  const tree = buildWebLibraryTree(items, [memo]);
  assert.equal(tree[tree.length - 1].name, "未分類");
  assert.equal(tree.length, 3);
  const theory = tree.find(folder => folder.path === "理論")!;
  assert.equal(theory.count, 2);
  const control = theory.children[0];
  assert.equal(control.path, "理論 / 制御");
  assert.deepEqual(control.entries.map(entry => entry.item.id), ["independent", "paper"]);
  assert.equal(control.entries[1].item.displayTitle, "制御の理論");
  assert.equal(control.entries[1].item.title, "Smith (2024) 制御の理論");
  assert.deepEqual(control.entries[1].children.map(child => child.kind), ["owned", "attachment"]);
  assert.equal(tree.some(folder => folder.path === "古い分類"), false);
  assert.equal(tree.find(folder => folder.path === "実験")?.entries[0].item.id, "orphan");
});

test("searching a held note or attachment retains its owner and ancestors, without unrelated siblings", () => {
  for (const query of ["専用", "実験条件"]) {
    const tree = buildWebLibraryTree(items, [memo], query);
    assert.equal(tree.length, 1);
    const entry = tree[0].children[0].entries[0];
    assert.equal(entry.item.id, "paper");
    assert.equal(entry.children.length, 1);
    assert.equal(entry.children[0].kind, query === "専用" ? "owned" : "attachment");
  }
  assert.equal(buildWebLibraryTree(items, [memo], "smith")[0].children[0].entries[0].item.id, "paper");
  assert.deepEqual(buildWebLibraryTree(items, [memo], "存在しない語"), []);
});
