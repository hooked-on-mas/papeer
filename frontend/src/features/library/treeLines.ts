/**
 * The library tree laid out as the sidebar renders it: one line per row, top to bottom, each with its
 * place in the tree for assistive technology (aria-level, aria-setsize, aria-posinset). A long library
 * renders only the lines in view (@tanstack/react-virtual); the rest of this module is how the sidebar
 * sizes the lines before they are measured and which lines it keeps rendered out of view. Pure, so that
 * it can be tested; LibrarySidebar applies it.
 *
 * The lines are flat, not nested in groups, since a line out of view is not in the page: each row says
 * its level and its place among its siblings itself, as the WAI-ARIA tree pattern allows.
 *
 * This is the one walk of the tree: the keyboard's rows (treeKeys.ts) are made from these lines, so that
 * what the keys move over is what is on screen. A new kind of row is a new member of TreeLine, and the
 * walk below is the one place that puts it in the order of the tree.
 */
import type { Range } from "@tanstack/react-virtual";
import type { PaperData } from "../../api/hooks.ts";
import type { PendingImport } from "../../app/pendingImports.ts";
import type { FolderNode } from "./libraryTree.ts";
import { normalizeCollection } from "../../lib/collectionPath.ts";

// The rows' keys, unique among the lines. Each kind has its own prefix, and the rows under a paper are
// told apart by the paper they are under: the same item may be linked from several papers (and is listed
// in its own folder too), so its id alone would not do. Ids hold no ":" (hashes, UUIDs).
export const folderKey = (path: string) => `folder:${path}`;
export const paperKey = (id: string) => `paper:${id}`;
/** The line of a PDF still being added, which has no row for the keyboard (see treeRows). */
export const pendingKey = (path: string) => `pending:${path}`;
/** A memo or document the paper `owner` holds. */
export const attachmentKey = (owner: string, id: string) => `attachment:${owner}:${id}`;
/** A notebook the paper `owner` holds. */
export const ownedKey = (owner: string, id: string) => `owned:${owner}:${id}`;
/** An item linked to the paper `owner`, listed under it besides its own place. */
export const linkKey = (owner: string, id: string) => `link:${owner}:${id}`;

/**
 * A row under a paper, shown while the paper is open: what it holds (a memo, a document, a notebook of
 * its own) or what is linked to it. They are given by PaperChildren; no paper has any yet.
 */
export type PaperChild =
  | { kind: "attachment"; id: string; title: string }
  | { kind: "owned"; id: string; title: string }
  | { kind: "link"; id: string; title: string };

/** The kinds of the rows under a paper. */
export type ChildKind = PaperChild["kind"];

/** What the tree shows under its papers: the rows of each, and which papers are open. */
export type PaperChildren = {
  /** The rows under `paper`, in order; none for a paper that holds and links nothing. */
  of(paper: PaperData): readonly PaperChild[];
  /** Whether the paper's row is open, showing them. */
  isOpen(paperId: string): boolean;
};

/** No paper has rows under it: the library as it is listed while papers hold nothing. */
export const NO_CHILDREN: PaperChildren = { of: () => [], isOpen: () => false };

type Place = {
  /** Unique among the lines: the row's key (see folderKey and the other key functions). */
  key: string;
  /** 1 for the top folders, as aria-level. */
  level: number;
  /** The rows in its folder (subfolders, PDFs being added and papers), or the top folders, or the rows under its paper; aria-setsize. */
  setSize: number;
  /** Its place among them, from 1; aria-posinset. */
  posInSet: number;
  /** The folder it is in: a folder's own path, "" for 未分類. */
  folder: string;
  /** The key of the line it is under: its folder's, or for a row under a paper that paper's; null for the top folders. */
  parent: string | null;
};

type ChildLineOf<C extends PaperChild> = C extends unknown ? Place & { kind: C["kind"]; owner: PaperData; child: C } : never;

/** A row under the paper `owner`. */
export type ChildLine = ChildLineOf<PaperChild>;

export type TreeLine =
  | Place & { kind: "folder"; node: FolderNode; expanded: boolean }
  | Place & { kind: "pending"; item: PendingImport }
  /** `expandable`: rows can be shown under it; `expanded`: they are. */
  | Place & { kind: "paper"; paper: PaperData; expandable: boolean; expanded: boolean }
  | ChildLine;

/** Whether the line is a row under a paper. */
export const isChildLine = (line: TreeLine): line is ChildLine =>
  line.kind !== "folder" && line.kind !== "pending" && line.kind !== "paper";

const childKey = (owner: string, child: PaperChild): string =>
  child.kind === "attachment" ? attachmentKey(owner, child.id) : child.kind === "owned" ? ownedKey(owner, child.id) : linkKey(owner, child.id);

/**
 * Every line on screen, top to bottom: each folder, then if it is open its subfolders, the PDFs being
 * added to it and its papers, each followed, while it is open, by the rows under it.
 */
export function treeLines(tree: FolderNode[], isExpanded: (path: string) => boolean, children: PaperChildren = NO_CHILDREN): TreeLine[] {
  const lines: TreeLine[] = [];
  // `setSize`: the folders' siblings, which for subfolders include the PDFs being added and papers after them.
  const walk = (nodes: FolderNode[], level: number, setSize: number, parent: string | null) => {
    nodes.forEach((node, index) => {
      const key = folderKey(node.path);
      const expanded = isExpanded(node.path);
      lines.push({ kind: "folder", key, node, level, setSize, posInSet: index + 1, folder: node.path, parent, expanded });
      if (!expanded) return;
      const contents = node.children.length + node.pending.length + node.papers.length;
      walk(node.children, level + 1, contents, key);
      let posInSet = node.children.length;
      for (const item of node.pending) {
        lines.push({ kind: "pending", key: pendingKey(item.path), item, level: level + 1, setSize: contents, posInSet: ++posInSet,
          folder: node.path, parent: key });
      }
      for (const paper of node.papers) {
        const rows = children.of(paper);
        const open = rows.length > 0 && children.isOpen(paper.id);
        const paperLineKey = paperKey(paper.id);
        lines.push({ kind: "paper", key: paperLineKey, paper, level: level + 1, setSize: contents, posInSet: ++posInSet,
          folder: node.path, parent: key, expandable: rows.length > 0, expanded: open });
        if (!open) continue;
        rows.forEach((child, at) => {
          // The kind and the child of a line go together; TypeScript does not follow that through the union.
          lines.push({ kind: child.kind, key: childKey(paper.id, child), owner: paper, child, level: level + 2, setSize: rows.length,
            posInSet: at + 1, folder: node.path, parent: paperLineKey } as ChildLine);
        });
      }
    });
  };
  walk(tree, 1, tree.length, null);
  return lines;
}

/**
 * From how many lines the tree renders only those in view. A shorter tree renders every line, which
 * costs little and keeps all of it in the page: for a screen reader's browse mode, and for finding
 * a row without scrolling to it.
 */
export const VIRTUALIZE_FROM = 200;

export const shouldVirtualize = (count: number) => count >= VIRTUALIZE_FROM;

/** Lines rendered beyond each end of the view, so that scrolling a little shows rows already there. */
export const OVERSCAN = 10;

/**
 * A line's height in rem, from the rows' classes in LibrarySidebar: a folder is h-[1.875rem]; a paper
 * py-1 around its title (leading-5) and its status line (mt-0.5, leading-4), and its tags' line (mt-1,
 * chips of leading-4 with a border) when it has tags; a PDF being added is laid out as a paper without
 * tags; a row under a paper is one line (py-1 around leading-5). Only an estimate for a line not yet
 * measured (a status line can wrap in a narrow sidebar): the rows are measured once rendered.
 */
export const LINE_REM = { folder: 1.875, paper: 2.875, tags: 1.375, child: 1.75 } as const;

/** The estimated height in px of a line, with the root font size `remPx` (設定「文字の大きさ」). */
export function estimateLineSize(line: TreeLine, remPx: number): number {
  if (line.kind === "folder") return Math.round(LINE_REM.folder * remPx);
  if (isChildLine(line)) return Math.round(LINE_REM.child * remPx);
  const tags = line.kind === "paper" && !!line.paper.tags?.length;
  return Math.round((LINE_REM.paper + (tags ? LINE_REM.tags : 0)) * remPx);
}

/** The kinds of line that are about as tall as each other: folders, papers with and without tags, PDFs being added, rows under a paper. */
export type LineKind = "folder" | "paper" | "tags" | "pending" | "child";

export const lineKind = (line: TreeLine): LineKind =>
  line.kind === "paper" ? (line.paper.tags?.length ? "tags" : "paper")
    : line.kind === "folder" || line.kind === "pending" ? line.kind : "child";

/**
 * The heights of the lines measured so far, by kind, for the lines not measured yet: in a narrow sidebar
 * or at 150% a paper's status line wraps, and every paper is then taller than its classes say
 * (estimateLineSize, the estimate until a line of its kind is measured). A line measured before and
 * still of the same kind is taken to be as tall as it was. Each line counts with its last height;
 * `reset` starts again, when the root font size changes.
 */
export function createLineSizes() {
  const measured = new Map<string, { kind: LineKind; size: number }>();
  const totals = new Map<LineKind, { sum: number; count: number }>();
  const add = (kind: LineKind, size: number, count: 1 | -1) => {
    const total = totals.get(kind) ?? { sum: 0, count: 0 };
    totals.set(kind, { sum: total.sum + count * size, count: total.count + count });
  };
  return {
    record(line: TreeLine, size: number): void {
      const before = measured.get(line.key);
      if (before) add(before.kind, before.size, -1);
      const kind = lineKind(line);
      measured.set(line.key, { kind, size });
      add(kind, size, 1);
    },
    estimate(line: TreeLine, remPx: number): number {
      const own = measured.get(line.key);
      if (own && own.kind === lineKind(line)) return own.size;
      const total = totals.get(lineKind(line));
      return total?.count ? Math.round(total.sum / total.count) : estimateLineSize(line, remPx);
    },
    reset(): void {
      measured.clear();
      totals.clear();
    },
  };
}

/** A line rendered, by its top and bottom on screen. */
export type LineBox = { key: string; top: number; bottom: number };

/**
 * Where the view is: the lines rendered that show in it (their bottom below the view's top `viewTop`),
 * top first, each with how far its top is from the view's top. The view keeps the first of them that is
 * still there where it was when lines above it are added, removed or moved.
 */
export function viewAnchors(boxes: LineBox[], viewTop: number): { key: string; offset: number }[] {
  return boxes.filter((box) => box.bottom > viewTop + 0.5).sort((a, b) => a.top - b.top)
    .map((box) => ({ key: box.key, offset: box.top - viewTop }));
}

/**
 * Whether the line asked to take the focus is the one to scroll to: a paper asked for in `folder` (after a
 * move) only once the library shows it there, so that the list does not scroll to where it was.
 */
export function isRequestedLine(line: TreeLine | undefined, folder: string | undefined): boolean {
  if (!line) return false;
  if (folder === undefined || line.kind !== "paper") return true;
  return normalizeCollection(line.paper.collection_name || "") === folder;
}

/**
 * The lines kept rendered out of view, by index: the row that takes the Tab key, the row the keys are
 * on and the one asked to take them, the row with the focus in it (on a button of the row), the row
 * whose context menu is open, the paper dragged — so that
 * the focus, a menu or a drag is not lost when its row scrolls away — and, while a paper is dragged,
 * every folder, which the keyboard drag moves between (dnd-kit knows only the folders rendered).
 */
export function pinnedLines(lines: TreeLine[], index: ReadonlyMap<string, number>, keys: (string | null | undefined)[],
  allFolders: boolean): number[] {
  const pinned = new Set<number>();
  for (const key of keys) {
    const at = key == null ? undefined : index.get(key);
    if (at !== undefined) pinned.add(at);
  }
  if (allFolders) lines.forEach((line, at) => { if (line.kind === "folder") pinned.add(at); });
  return [...pinned];
}

/**
 * The lines to render (the virtualizer's rangeExtractor): those in view with the overscan on each
 * side, and the pinned ones, in order, so that the rows are in the page in the order of the tree.
 */
export function linesToRender(range: Range, pinned: readonly number[]): number[] {
  const start = Math.max(range.startIndex - range.overscan, 0);
  const end = Math.min(range.endIndex + range.overscan, range.count - 1);
  const indexes = new Set<number>();
  for (let i = start; i <= end; i++) indexes.add(i);
  for (const i of pinned) if (i >= 0 && i < range.count) indexes.add(i);
  return [...indexes].sort((a, b) => a - b);
}
