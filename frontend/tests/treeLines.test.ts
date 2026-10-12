import assert from "node:assert/strict";
import { test } from "node:test";
import { Virtualizer, type Range } from "@tanstack/react-virtual";
import { buildTree } from "../src/features/library/libraryTree.ts";
import { folderKey, paperKey, rowAfterRemoval, treeKeyAction, typeaheadMatch, visibleRows } from "../src/features/library/treeKeys.ts";
import {
  createLineSizes, estimateLineSize, isRequestedLine, LINE_REM, lineKind, linesToRender, OVERSCAN, pendingKey, pinnedLines,
  shouldVirtualize, treeLines, viewAnchors, VIRTUALIZE_FROM, type PaperChild, type PaperChildren, type TreeLine,
} from "../src/features/library/treeLines.ts";
import type { PaperData } from "../src/api/hooks.ts";
import { paperData } from "./support/paperData.ts";

const paper = (id: string, collection_name = "", tags: string[] = []): PaperData => paperData({ id, collection_name, tags });

// ML (open) > Vision (closed) > v1; ML > m1, m2 and x.pdf being added; Bio (closed) > b1; 未分類 (open) > u1.
const papers = [paper("m1", "ML"), paper("m2", "ML", ["重要"]), paper("v1", "ML / Vision"), paper("b1", "Bio"), paper("u1", "")];
const tree = buildTree([], papers, [{ path: "C:/x.pdf", name: "x.pdf", collection: "ML" }], false);
const open = new Set(["ML", ""]);
const lines = treeLines(tree, (path) => open.has(path));

/** Each line as "key level posInSet/setSize". */
const outline = (list: TreeLine[]) => list.map((line) => `${line.key} ${line.level} ${line.posInSet}/${line.setSize}`);

test("the lines are the rows as the tree lays them out, each with its level and place among its siblings", () => {
  assert.deepEqual(outline(lines), [
    "folder:Bio 1 1/3",
    "folder:ML 1 2/3",
    // A folder's subfolders, then the PDFs being added to it, then its papers.
    "folder:ML / Vision 2 1/4",
    "pending:C:/x.pdf 2 2/4",
    "paper:m1 2 3/4",
    "paper:m2 2 4/4",
    "folder: 1 3/3",
    "paper:u1 2 1/1",
  ]);
  // The rows for the keyboard are the same, without the PDFs being added.
  const rows = visibleRows(tree, (path) => open.has(path), (p) => p.title);
  assert.deepEqual(rows.map((row) => row.key), lines.filter((line) => line.kind !== "pending").map((line) => line.key));
  assert.deepEqual(rows.map((row) => row.level), lines.filter((line) => line.kind !== "pending").map((line) => line.level));
});

test("a closed folder's contents have no lines, and every folder open shows them all", () => {
  const all = treeLines(tree, () => true);
  assert.deepEqual(all.map((line) => line.key), [
    "folder:Bio", "paper:b1", "folder:ML", "folder:ML / Vision", "paper:v1", pendingKey("C:/x.pdf"), "paper:m1", "paper:m2", "folder:", "paper:u1",
  ]);
  assert.equal(outline(all).find((line) => line.startsWith("paper:v1")), "paper:v1 3 1/1");
  assert.deepEqual(outline(treeLines(tree, () => false)), ["folder:Bio 1 1/3", "folder:ML 1 2/3", "folder: 1 3/3"]);
});

test("only a long tree renders the lines in view", () => {
  assert.equal(shouldVirtualize(VIRTUALIZE_FROM - 1), false);
  assert.equal(shouldVirtualize(VIRTUALIZE_FROM), true);
});

test("a line's estimated height follows the root font size, and a paper with tags is taller", () => {
  const [folder, , , pending, m1, m2] = lines;
  assert.equal(estimateLineSize(folder, 16), 30);
  assert.equal(estimateLineSize(m1, 16), 46);
  assert.equal(estimateLineSize(pending, 16), 46);
  assert.equal(estimateLineSize(m2, 16), Math.round((LINE_REM.paper + LINE_REM.tags) * 16));
  // 設定「文字の大きさ」150%.
  assert.equal(estimateLineSize(folder, 24), 45);
  assert.equal(estimateLineSize(m1, 24), 69);
});

test("a line is taken to be as tall as it was measured, and one not measured yet as the lines of its kind so far", () => {
  const [folder, , , pending, m1, m2] = lines;
  // A paper without tags not measured yet.
  const other = { ...m1, key: paperKey("other") } as TreeLine;
  const sizes = createLineSizes();
  // Until one of its kind is measured, a line is estimated from its classes.
  assert.equal(sizes.estimate(other, 16), estimateLineSize(other, 16));
  // Papers without tags measured at 64 and 68 px (a status line wrapping in a narrow sidebar).
  sizes.record(m1, 64);
  sizes.record(lines[7], 68);
  assert.equal(sizes.estimate(other, 16), 66);
  // A line measured keeps its own height.
  assert.equal(sizes.estimate(m1, 16), 64);
  // Each kind apart: papers with tags, folders and PDFs being added keep their own estimate.
  assert.equal(sizes.estimate(m2, 16), estimateLineSize(m2, 16));
  assert.equal(sizes.estimate(folder, 16), 30);
  assert.equal(sizes.estimate(pending, 16), 46);
  // A line measured again counts with its last height only.
  sizes.record(m1, 46);
  assert.equal(sizes.estimate(other, 16), 57);
  assert.equal(sizes.estimate(m1, 16), 46);
  // A paper that gets tags counts as one with tags from then on; its height without tags no longer applies.
  const tagged = { ...m1, paper: { ...papers[0], tags: ["重要"] } } as TreeLine;
  sizes.record(tagged, 90);
  assert.equal(sizes.estimate(m2, 16), 90);
  assert.equal(sizes.estimate(other, 16), 68);
  assert.equal(sizes.estimate(m1, 16), 68);
  sizes.reset();
  assert.equal(sizes.estimate(m2, 16), estimateLineSize(m2, 16));
  assert.equal(sizes.estimate(tagged, 16), estimateLineSize(tagged, 16));
});

test("the view's place is the rows showing in it, top first, each with its offset from the view's top", () => {
  const boxes = [
    { key: "c", top: 160, bottom: 206 }, { key: "a", top: 60, bottom: 106 }, { key: "b", top: 106, bottom: 160 }, { key: "far", top: 5000, bottom: 5046 },
  ];
  // The view starts at 100: a is half above it, and still shows.
  assert.deepEqual(viewAnchors(boxes, 100), [
    { key: "a", offset: -40 }, { key: "b", offset: 6 }, { key: "c", offset: 60 }, { key: "far", offset: 4900 },
  ]);
  // A row that ends where the view starts does not show.
  assert.deepEqual(viewAnchors(boxes, 106).map((anchor) => anchor.key), ["b", "c", "far"]);
  assert.deepEqual(viewAnchors([], 0), []);
});

test("a paper asked to take the focus in a folder (after a move) is scrolled to only once it shows there", () => {
  const [folder, , , , m1] = lines;
  assert.equal(isRequestedLine(undefined, undefined), false);
  assert.equal(isRequestedLine(m1, undefined), true);
  assert.equal(isRequestedLine(m1, "ML"), true);
  assert.equal(isRequestedLine(m1, "Bio"), false);
  assert.equal(isRequestedLine(folder, "Bio"), true);
});

test("the pinned lines are the ones named that are on screen, and every folder while a paper is dragged", () => {
  const index = new Map(lines.map((line, at) => [line.key, at]));
  assert.deepEqual(pinnedLines(lines, index, [paperKey("u1"), null, undefined, paperKey("gone"), paperKey("u1")], false), [7]);
  assert.deepEqual(pinnedLines(lines, index, [paperKey("m2")], true).sort((a, b) => a - b), [0, 1, 2, 5, 6]);
});

test("the lines rendered are those in view with the overscan, and the pinned ones, in order", () => {
  const range: Range = { startIndex: 100, endIndex: 110, overscan: 5, count: 1000 };
  const rendered = linesToRender(range, [990, 3, 104]);
  assert.deepEqual(rendered, [3, ...Array.from({ length: 21 }, (_, i) => 95 + i), 990]);
  // Clamped at the ends; pinned lines no longer there are left out.
  assert.deepEqual(linesToRender({ startIndex: 0, endIndex: 2, overscan: 3, count: 4 }, [7, -1]), [0, 1, 2, 3]);
});

const last = <T>(list: T[]): T => list[list.length - 1];

/** A library of `folders` folders of `each` papers, every folder open. */
function library(folders: number, each: number): TreeLine[] {
  const list = Array.from({ length: folders * each }, (_, i) => paper(`p${i}`, `F${String(Math.floor(i / each)).padStart(3, "0")}`));
  return treeLines(buildTree([], list, [], false), () => true);
}

/**
 * The virtualizer as the sidebar sets it up (TreeList in LibrarySidebar), over a list `height` px tall
 * scrolled to `offset`, with the root font size of 16px; scrolling moves the list at once.
 */
function virtualize(list: TreeLine[], { height, offset = 0, pinned = [] }: { height: number; offset?: number; pinned?: number[] }) {
  const scrolls: number[] = [];
  let setOffset: (offset: number, isScrolling: boolean) => void = () => {};
  const frames: (() => void)[] = [];
  const view = { requestAnimationFrame: (cb: () => void) => frames.push(cb), cancelAnimationFrame: () => {}, performance };
  // As tall as the rows, as the list is (the virtualizer scrolls no further than its end).
  const element = {
    ownerDocument: { defaultView: view },
    get scrollHeight() { return virtualizer.getTotalSize(); },
    clientHeight: height,
  } as unknown as HTMLDivElement;
  const virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement> = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: list.length,
    getScrollElement: () => element,
    estimateSize: (at) => estimateLineSize(list[at], 16),
    getItemKey: (at) => list[at].key,
    rangeExtractor: (range) => linesToRender(range, pinned),
    overscan: OVERSCAN,
    paddingStart: 4,
    paddingEnd: 4,
    scrollPaddingStart: 4,
    scrollPaddingEnd: 4,
    observeElementRect: (_, cb) => cb({ width: 300, height }),
    observeElementOffset: (_, cb) => {
      setOffset = cb;
      cb(offset, false);
    },
    scrollToFn: (to) => {
      scrolls.push(to);
      setOffset(to, false);
    },
  });
  virtualizer._willUpdate();
  const shown = () => virtualizer.getVirtualItems().map((item) => item.index);
  const flush = () => { while (frames.length) frames.shift()!(); };
  return { virtualizer, scrolls, shown, flush };
}

test("a long library renders the lines in view with the overscan, wherever it is scrolled", () => {
  const list = library(50, 100); // 5050 lines: a folder of 30px, then 100 papers of 46px, and 未分類
  const { shown } = virtualize(list, { height: 460 });
  // 4 px of padding, the folder, then papers: lines 0 to 10 are in view, and 10 more below.
  assert.deepEqual(shown(), Array.from({ length: 21 }, (_, i) => i));

  // Scrolled to the 50th paper of the second folder, line 151: after the first folder and its 100 papers,
  // and the second folder.
  const middle = 4 + 30 + 100 * 46 + 30 + 49 * 46;
  const at = virtualize(list, { height: 460, offset: middle }).shown();
  const first = 151;
  assert.deepEqual(at, Array.from({ length: 30 }, (_, i) => first - OVERSCAN + i));
  assert.ok(at.length < 40);
});

test("the pinned lines are rendered out of view at their place", () => {
  const list = library(50, 100);
  const { virtualizer, shown } = virtualize(list, { height: 460, pinned: [5000] });
  assert.deepEqual(shown().slice(-2), [20, 5000]);
  const items = virtualizer.getVirtualItems();
  const item = items[items.length - 1];
  assert.equal(item.key, list[5000].key);
  assert.equal(item.start, 4 + 50 * 30 + 4950 * 46);
});

test("End moves the keys to the last row out of view, and the list scrolls to show it at the bottom", () => {
  const list = library(50, 100);
  const rows = visibleRows(buildTree([], Array.from({ length: 5000 }, (_, i) => paper(`p${i}`, `F${String(Math.floor(i / 100)).padStart(3, "0")}`)), [], false),
    () => true, (p) => p.title);
  const action = treeKeyAction(rows, folderKey("F000"), "End");
  assert.deepEqual(action, { type: "focus", key: list[list.length - 1].key });
  const index = new Map(list.map((line, at) => [line.key, at]));
  const target = index.get(list[list.length - 1].key)!;
  // As TreeList: the row asked to take the focus is pinned, and scrolled to.
  const { virtualizer, scrolls, shown, flush } = virtualize(list, { height: 460, pinned: [target] });
  virtualizer.scrollToIndex(target, { align: "auto" });
  flush();
  const bottom = virtualizer.getTotalSize() - 460;
  assert.equal(last(scrolls), bottom);
  assert.ok(shown().includes(target));
  assert.ok(shown().includes(target - 8), "the rows above it in view are rendered too");
  // ↑ from there to a row in view does not scroll; Home scrolls back to the top.
  virtualizer.scrollToIndex(target - 3, { align: "auto" });
  flush();
  assert.equal(last(scrolls), bottom);
  virtualizer.scrollToIndex(0, { align: "auto" });
  flush();
  assert.equal(last(scrolls), 0);
});

// What a paper holds and links to: lines for these exist only once something gives them (PaperChildren).
const held: Record<string, PaperChild[]> = {
  m1: [
    { kind: "attachment", id: "a1", title: "要約メモ" },
    { kind: "owned", id: "n9", title: "手書きノート" },
    { kind: "link", id: "u1", title: "輪読ノート" },
  ],
  u1: [{ kind: "link", id: "u1", title: "同じ id の紐づけ" }],
};
const childrenOf = (openPapers: string[]): PaperChildren => ({
  of: (p) => held[p.id] ?? [],
  isOpen: (id) => openPapers.includes(id),
});

test("rows under an open paper follow it, one level in, with their own place among them and a key of their paper", () => {
  const withChildren = treeLines(tree, (path) => open.has(path), childrenOf(["m1", "u1"]));
  assert.deepEqual(outline(withChildren), [
    "folder:Bio 1 1/3",
    "folder:ML 1 2/3",
    "folder:ML / Vision 2 1/4",
    "pending:C:/x.pdf 2 2/4",
    // The paper keeps its place among its siblings; what is under it is counted among those.
    "paper:m1 2 3/4",
    "attachment:m1:a1 3 1/3",
    "owned:m1:n9 3 2/3",
    "link:m1:u1 3 3/3",
    "paper:m2 2 4/4",
    "folder: 1 3/3",
    "paper:u1 2 1/1",
    // The item linked under m1 is also the paper u1 in 未分類: told apart by the paper it is under.
    "link:u1:u1 3 1/1",
  ]);
  const keys = withChildren.map((line) => line.key);
  assert.equal(new Set(keys).size, keys.length);
  const m1 = withChildren.find((line) => line.key === "paper:m1")!;
  assert.equal(m1.kind === "paper" && m1.expandable && m1.expanded, true);
  const link = withChildren.find((line) => line.key === "link:m1:u1")!;
  assert.equal(link.kind, "link");
  assert.equal(link.kind === "link" && link.child.title, "輪読ノート");
  assert.equal(link.parent, "paper:m1");
  assert.equal(link.folder, "ML");
});

test("a paper that holds something has a row for it only while it is open", () => {
  const closed = treeLines(tree, (path) => open.has(path), childrenOf([]));
  assert.deepEqual(closed.map((line) => line.key), lines.map((line) => line.key));
  const m1 = closed.find((line) => line.key === "paper:m1")!;
  assert.equal(m1.kind === "paper" && m1.expandable, true);
  assert.equal(m1.kind === "paper" && m1.expanded, false);
  // A paper holding nothing is not expandable, open or not.
  const m2 = closed.find((line) => line.key === "paper:m2")!;
  assert.equal(m2.kind === "paper" && m2.expandable, false);
  assert.equal(outline(treeLines(tree, (path) => open.has(path), childrenOf(["m2"]))).length, outline(lines).length);
});

test("the rows under a paper are in a closed folder's contents no more than the paper is", () => {
  const closedFolder = treeLines(tree, (path) => path === "", childrenOf(["m1"]));
  assert.deepEqual(closedFolder.map((line) => line.key), ["folder:Bio", "folder:ML", "folder:", "paper:u1"]);
});

test("the keyboard's rows include them: → opens a paper that holds something, then goes in; ← goes back out, or closes", () => {
  const label = (p: PaperData) => p.title ?? "";
  const closedRows = visibleRows(tree, (path) => open.has(path), label, childrenOf([]));
  const openRows = visibleRows(tree, (path) => open.has(path), label, childrenOf(["m1"]));
  const m1 = closedRows.find((row) => row.key === "paper:m1")!;
  assert.deepEqual(treeKeyAction(closedRows, "paper:m1", "ArrowRight"), { type: "expand", row: m1 });
  // A paper holding nothing stays, as before.
  assert.deepEqual(treeKeyAction(closedRows, "paper:m2", "ArrowRight"), { type: "none" });
  assert.deepEqual(treeKeyAction(openRows, "paper:m1", "ArrowRight"), { type: "focus", key: "attachment:m1:a1" });
  assert.deepEqual(treeKeyAction(openRows, "attachment:m1:a1", "ArrowLeft"), { type: "focus", key: "paper:m1" });
  assert.deepEqual(treeKeyAction(openRows, "link:m1:u1", "ArrowLeft"), { type: "focus", key: "paper:m1" });
  assert.equal(treeKeyAction(openRows, "paper:m1", "ArrowLeft")?.type, "collapse");
  // A row under a paper does not open further; the paper after the last of them is below it.
  assert.deepEqual(treeKeyAction(openRows, "attachment:m1:a1", "ArrowRight"), { type: "none" });
  assert.deepEqual(treeKeyAction(openRows, "link:m1:u1", "ArrowDown"), { type: "focus", key: "paper:m2" });
  const action = treeKeyAction(openRows, "owned:m1:n9", "Enter");
  assert.equal(action?.type === "activate" && action.row.kind, "owned");
  assert.equal(action?.type === "activate" && action.row.id, "n9");
  // Their label is what typing finds them by; none is a paper to select.
  assert.equal(typeaheadMatch(openRows, "paper:m1", "手書"), "owned:m1:n9");
  // Deleting the paper takes its rows with it: the keys go on to the paper after them.
  assert.equal(rowAfterRemoval(openRows, "paper:m1"), "paper:m2");
  assert.deepEqual(openRows.filter((row) => row.kind === "paper").map((row) => row.id), ["m1", "m2", "u1"]);
});

test("a row under a paper is as tall as one line, and is its own kind for the heights measured", () => {
  const withChildren = treeLines(tree, (path) => open.has(path), childrenOf(["m1"]));
  const attachment = withChildren.find((line) => line.key === "attachment:m1:a1")!;
  assert.equal(estimateLineSize(attachment, 16), Math.round(LINE_REM.child * 16));
  assert.equal(lineKind(attachment), "child");
  const sizes = createLineSizes();
  sizes.record(attachment, 30);
  const other = withChildren.find((line) => line.key === "owned:m1:n9")!;
  assert.equal(sizes.estimate(other, 16), 30);
  // Papers are not estimated by it.
  assert.equal(sizes.estimate(withChildren.find((line) => line.key === "paper:m2")!, 16), estimateLineSize(withChildren.find((line) => line.key === "paper:m2")!, 16));
  assert.equal(isRequestedLine(attachment, "ML"), true);
});

test("a notebook listed in a folder is a row of the folder like a paper, ahead of the folder's papers", () => {
  const items = [paper("p1", "F"), paperData({ id: "n1", collection_name: "F", kind: "notebook" }), paper("p2", "F")];
  const nested = treeLines(buildTree([], items, [], false), () => true);
  assert.deepEqual(outline(nested), ["folder:F 1 1/2", "paper:n1 2 1/3", "paper:p1 2 2/3", "paper:p2 2 3/3", "folder: 1 2/2"]);
});
