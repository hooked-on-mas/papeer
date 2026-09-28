import assert from "node:assert/strict";
import { test } from "node:test";
import { allFolderPaths, buildTree, countInFolder, filterPapers, isInsideFolder, normalizeCollection, type FolderNode } from "../src/features/library/libraryTree.ts";
import type { PaperData } from "../src/api/hooks.ts";
import { paperData } from "./support/paperData.ts";
import type { PendingImport } from "../src/app/pendingImports.ts";

const paper = (id: string, collection_name = "", extra: Partial<PaperData> = {}): PaperData => paperData({ id, collection_name, ...extra });

/** Each folder as "path(count): papers", depth first, to compare whole trees at a glance. */
function outline(nodes: FolderNode[], indent = ""): string[] {
  return nodes.flatMap((node) => [
    `${indent}${node.name}(${node.count})${node.papers.length ? ": " + node.papers.map((p) => p.id).join(",") : ""}`
      + (node.pending.length ? ` +${node.pending.map((p) => p.name).join(",")}` : ""),
    ...outline(node.children, indent + "  "),
  ]);
}

test("folders nest by path, sort by name within their parent, count their subfolders' papers, and end with 未分類", () => {
  const papers = [paper("a", "ML / Vision"), paper("b", "ML"), paper("c", ""), paper("d", "Bio"), paper("e", "ML\\Vision / 3D")];
  const tree = buildTree(["ML", "Empty"], papers, [], false);
  assert.deepEqual(outline(tree), [
    "Bio(1): d",
    "Empty(0)",
    "ML(3): b",
    "  Vision(2): a",
    "    3D(1): e",
    "未分類(1): c",
  ]);
  assert.deepEqual(allFolderPaths(tree), ["Bio", "Empty", "ML", "ML / Vision", "ML / Vision / 3D", ""]);
});

test("while filtering only folders with matches, and 未分類 only when it has some, are listed", () => {
  const tree = buildTree(["ML", "Empty"], [paper("a", "ML / Vision")], [], true);
  assert.deepEqual(outline(tree), ["ML(1)", "  Vision(1): a"]);
});

test("PDFs being added show in their folder, also while filtering", () => {
  const pending: PendingImport[] = [{ path: "C:/x.pdf", name: "x.pdf", collection: "New / Sub" }, { path: "C:/y.pdf", name: "y.pdf", collection: "" }];
  assert.deepEqual(outline(buildTree([], [], pending, true)), ["New(1)", "  Sub(1) +x.pdf", "未分類(1) +y.pdf"]);
});

test("the tree keeps the list's paper objects, in the list's order, so that unchanged rows are not rendered again", () => {
  const papers = [paper("z", "F"), paper("a", "F"), paper("m", "F")];
  const [folder] = buildTree([], papers, [], false);
  assert.deepEqual(folder.papers.map((p) => p.id), ["z", "a", "m"]);
  folder.papers.forEach((p, i) => assert.equal(p, papers[i]));
});

test("building the tree is linear in the papers, even with all of them in one folder", () => {
  // Copying each folder's list for every paper, as the tree once did, took seconds for this many.
  const papers = Array.from({ length: 40_000 }, (_, i) => paper(`p${i}`, i % 10 ? "Big" : `Many / F${(i / 10) % 500}`));
  const started = performance.now();
  const tree = buildTree([], papers, [], false);
  const elapsed = performance.now() - started;
  assert.equal(tree.find((n) => n.path === "Big")?.count, 36_000);
  assert.equal(tree.find((n) => n.path === "Many")?.children.length, 500);
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
});

test("filterPapers hands the list back as it is when nothing filters it, so that the memoized tree holds", () => {
  const papers = [paper("a"), paper("b")];
  assert.equal(filterPapers(papers, { tag: "", readStatus: "", matches: null }), papers);
});

test("filterPapers keeps the papers that every filter lets through", () => {
  const papers = [
    paper("a", "", { tags: ["ML"], read_status: "読了" }),
    paper("b", "", { tags: ["ML"], read_status: "未読" }),
    paper("c", "", { read_status: "読了" }),
  ];
  const ids = (filter: Parameters<typeof filterPapers>[1]) => filterPapers(papers, filter).map((p) => p.id);
  assert.deepEqual(ids({ tag: "ML", readStatus: "", matches: null }), ["a", "b"]);
  assert.deepEqual(ids({ tag: "ML", readStatus: "読了", matches: null }), ["a"]);
  assert.deepEqual(ids({ tag: "", readStatus: "", matches: new Set(["b", "c"]) }), ["b", "c"]);
  // A search whose results have not come yet shows nothing, rather than every paper for a moment.
  assert.deepEqual(ids({ tag: "", readStatus: "", matches: new Set() }), []);
});

test("folder paths are normalized from either slash, without empty parts", () => {
  assert.equal(normalizeCollection(" ML \\ Vision/ 3D /"), "ML / Vision / 3D");
  assert.equal(normalizeCollection(""), "");
});

test("a folder counts the papers in it and its subfolders, but not in folders whose names only start alike", () => {
  const papers = [paper("a", "ML"), paper("b", "ML\\Vision"), paper("c", "MLOps"), paper("d", "")];
  assert.equal(countInFolder(papers, "ML"), 2);
  assert.equal(countInFolder(papers, "ML / Vision"), 1);
  assert.equal(countInFolder(papers, "Bio"), 0);
  assert.equal(isInsideFolder("ML / Vision", "ML"), true);
  assert.equal(isInsideFolder("MLOps", "ML"), false);
});

test("a folder's papers are not counted while the paper list has not loaded, so that deleting it still asks", () => {
  assert.equal(countInFolder(null, "ML"), null);
  assert.equal(countInFolder([], "ML"), 0);
});
