import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allFolderPaths, buildTree, countInFolder, filterPapers, isHeld, revealOpenings, type FolderNode,
} from "../src/features/library/libraryTree.ts";
import { isInsideFolder, normalizeCollection } from "../src/lib/collectionPath.ts";
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

test("notebooks are listed ahead of the papers of their folder, each group in the list's order", () => {
  const papers = [
    paper("p1", "F"), paper("n1", "F", { kind: "notebook" }), paper("p2", "F"), paper("n2", "F", { kind: "notebook" }),
    paper("p3", ""), paper("n3", "", { kind: "notebook" }),
  ];
  const tree = buildTree([], papers, [], false);
  assert.deepEqual(outline(tree), ["F(4): n1,n2,p1,p2", "未分類(2): n3,p3"]);
  // The papers are the list's own objects.
  assert.equal(tree[0].papers[0], papers[1]);
});

test("a folder without notebooks keeps the list's array, and one of only notebooks does too", () => {
  const onlyPapers = [paper("a", "F"), paper("b", "F")];
  assert.deepEqual(buildTree([], onlyPapers, [], false)[0].papers, onlyPapers);
  const onlyNotebooks = [paper("a", "F", { kind: "notebook" }), paper("b", "F", { kind: "notebook" })];
  assert.deepEqual(buildTree([], onlyNotebooks, [], false)[0].papers.map((p) => p.id), ["a", "b"]);
});

test("a row another item holds (parent_id) is not a row of a folder, nor counted in it", () => {
  const papers = [paper("host", "F"), paper("held", "", { kind: "notebook", parent_id: "host" }), paper("other", "")];
  const tree = buildTree([], papers, [], false);
  assert.deepEqual(outline(tree), ["F(1): host", "未分類(1): other"]);
  assert.equal(isHeld(papers[1]), true);
  assert.equal(isHeld(papers[0]), false);
  assert.equal(countInFolder(papers, ""), 1);
  assert.equal(countInFolder(papers, "F"), 1);
});

test("an item of a kind this app does not know is listed with the papers", () => {
  const tree = buildTree([], [paper("a", "F"), paper("x", "F", { kind: "whiteboard" as PaperData["kind"] })], [], false);
  assert.deepEqual(outline(tree), ["F(2): a,x", "未分類(0)"]);
});

test("revealing an item opens the folders along its path, 未分類 when it has none, and the paper that holds it", () => {
  const host = paper("host", "ML / Vision");
  const held = paper("held", "", { kind: "notebook", parent_id: "host" });
  const find = (id: string) => [host, held].find((p) => p.id === id);
  assert.deepEqual(revealOpenings(host, find), { folders: ["ML", "ML / Vision"], papers: [] });
  assert.deepEqual(revealOpenings(paper("u", ""), find), { folders: [""], papers: [] });
  // Its own folder is '': the holder's is the one to open.
  assert.deepEqual(revealOpenings(held, find), { folders: ["ML", "ML / Vision"], papers: ["host"] });
  // A holder that is not known: where the item says it is.
  assert.deepEqual(revealOpenings(held, () => undefined), { folders: [""], papers: [] });
});
