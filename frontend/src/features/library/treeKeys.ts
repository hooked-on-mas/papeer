/**
 * The library tree's keyboard: which rows are on screen, where the arrow keys move the focus, which row
 * takes the Tab key, and where a paper dragged with the keyboard goes. Pure, so that it can be tested;
 * the sidebar and its focus store (treeFocus.ts) apply the results.
 *
 * The rows are the tree's lines (treeLines.ts) without the PDFs being added: what the keys move over is
 * what is on screen, from the same walk. A row can open (`expandable`) to show the rows under it: a
 * folder's contents, or for a paper what it holds and links.
 *
 * The focus (the row the keys act on) is kept apart from the selection (the open paper or the chosen
 * folder): the arrow keys move the focus only, and Enter selects. Multiple selection builds on this.
 */
import type { PaperData } from "../../api/hooks.ts";
import type { FolderNode } from "./libraryTree.ts";
import { folderKey, paperKey, treeLines, type ChildKind, type PaperChildren, type TreeLine } from "./treeLines.ts";

// The rows' keys are defined with the lines (treeLines.ts); the selection and the sidebar import them from here.
export { attachmentKey, folderKey, linkKey, ownedKey, paperKey } from "./treeLines.ts";

/** A row of the tree as the keyboard sees it: a folder, a paper (an item listed in a folder), or a row under a paper. */
export type TreeRow = {
  /** Unique among the rows; see folderKey and paperKey. */
  key: string;
  kind: "folder" | "paper" | ChildKind;
  /** The folder's path ("" for 未分類), the paper's id, or the id of what the row under a paper stands for. */
  id: string;
  /** The folder's own path, or the folder the paper (or the paper the row is under) is in. */
  folder: string;
  /** 1 for the top folders, as aria-level. */
  level: number;
  /** The key of the row it is under: its folder's, or for a row under a paper that paper's; null for the top folders. */
  parent: string | null;
  /** Whether it can open to show rows under it: a folder always, a paper while it holds or links something. */
  expandable: boolean;
  /** Whether the rows under it are shown. */
  expanded: boolean;
  /** What typing the first letters finds it by. */
  label: string;
};

/** The row of what is selected in the app's store: the chosen folder, or else the open paper. */
export function selectedRowKey(state: { selectedFolder: string | null; activePaperId: string | null }): string | null {
  if (state.selectedFolder !== null) return folderKey(state.selectedFolder);
  return state.activePaperId ? paperKey(state.activePaperId) : null;
}

/**
 * The rows of the lines on screen, top to bottom: each folder, then if it is open its subfolders and
 * papers, and the rows under the papers that are open. PDFs still being added are left out, since there
 * is nothing to do with them. `label` is what a paper is found by when typing its name.
 */
export function treeRows(lines: readonly TreeLine[], label: (paper: PaperData) => string): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const line of lines) {
    if (line.kind === "pending") continue;
    const place = { key: line.key, level: line.level, folder: line.folder, parent: line.parent };
    if (line.kind === "folder") {
      rows.push({ ...place, kind: "folder", id: line.node.path, expandable: true, expanded: line.expanded, label: line.node.name });
    } else if (line.kind === "paper") {
      rows.push({ ...place, kind: "paper", id: line.paper.id, expandable: line.expandable, expanded: line.expanded, label: label(line.paper) });
    } else {
      rows.push({ ...place, kind: line.kind, id: line.child.id, expandable: false, expanded: false, label: line.child.title });
    }
  }
  return rows;
}

/** The rows of a tree on screen: its lines (treeLines) as the keyboard sees them (treeRows). */
export function visibleRows(tree: FolderNode[], isExpanded: (path: string) => boolean, label: (paper: PaperData) => string,
  children?: PaperChildren): TreeRow[] {
  return treeRows(treeLines(tree, isExpanded, children), label);
}

/**
 * The row that takes the Tab key (the only row with tabIndex 0): the focused row while it is on screen,
 * else the selected one, else the first.
 */
export function resolveTabStop(rows: TreeRow[], focused: string | null, selected: string | null): string | null {
  if (focused !== null && rows.some((row) => row.key === focused)) return focused;
  if (selected !== null && rows.some((row) => row.key === selected)) return selected;
  return rows[0]?.key ?? null;
}

export type TreeKeyAction =
  | { type: "focus"; key: string }
  /** Open or close the folder or paper `row`, which the caller does by its kind. */
  | { type: "expand"; row: TreeRow }
  | { type: "collapse"; row: TreeRow }
  /** Enter: open the paper, or choose the folder, as a click does. */
  | { type: "activate"; row: TreeRow }
  /** A key of the tree with nothing to do here, such as ↓ on the last row; still the tree's, not the page's. */
  | { type: "none" };

/**
 * What a key does on the row `current`, following the WAI-ARIA tree pattern: ↑↓ move to the row above
 * or below; → opens a closed folder (or a paper with rows under it), and on an open one moves to its
 * first row; ← closes an open one, and elsewhere moves to the row it is under; Home and End move to the
 * first and last rows; Enter activates. Null for other keys, which are left to the page. Keys with
 * Ctrl, Alt or Meta are left to the caller. While searching or filtering every folder is shown open and
 * cannot be closed (`canCollapse` false), so ← on a folder only moves up.
 */
export function treeKeyAction(rows: TreeRow[], current: string, key: string, { canCollapse = true } = {}): TreeKeyAction | null {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(key)) return null;
  const index = rows.findIndex((row) => row.key === current);
  if (index < 0) return rows.length && key !== "Enter" ? { type: "focus", key: rows[0].key } : { type: "none" };
  const row = rows[index];
  const focus = (target: TreeRow | undefined): TreeKeyAction =>
    target && target.key !== current ? { type: "focus", key: target.key } : { type: "none" };
  switch (key) {
    case "ArrowDown": return focus(rows[index + 1]);
    case "ArrowUp": return focus(rows[index - 1]);
    case "Home": return focus(rows[0]);
    case "End": return focus(rows[rows.length - 1]);
    case "Enter": return { type: "activate", row };
    case "ArrowRight":
      if (!row.expandable) return { type: "none" };
      if (!row.expanded) return { type: "expand", row };
      return rows[index + 1]?.parent === row.key ? focus(rows[index + 1]) : { type: "none" };
    default: // ArrowLeft
      if (row.expandable && row.expanded && (canCollapse || row.kind !== "folder")) return { type: "collapse", row };
      return row.parent === null ? { type: "none" } : focus(rows.find((r) => r.key === row.parent));
  }
}

/**
 * The row the keys go to once the row `key` is deleted, so that the focus does not fall out of the tree:
 * the next row, past the rows under it (a folder's subfolders and papers go with it, a paper's rows with
 * the paper); else the row above, which for a folder's last row is that folder or a row in it. Null when
 * it is not on screen or nothing is left.
 */
export function rowAfterRemoval(rows: TreeRow[], key: string): string | null {
  const index = rows.findIndex((row) => row.key === key);
  if (index < 0) return null;
  const row = rows[index];
  let next = index + 1;
  while (next < rows.length && rows[next].level > row.level) next++;
  return rows[next]?.key ?? rows[index - 1]?.key ?? null;
}

/**
 * The row that typing `text` (the letters typed in quick succession) moves to: the next row whose label
 * starts with it, going round from the top. A single letter, or the same letter typed again, looks from
 * the row below the current one, so that pressing it repeatedly steps through the rows it starts;
 * longer text looks from the current row, which may still match. Case is ignored.
 */
export function typeaheadMatch(rows: TreeRow[], current: string | null, text: string): string | null {
  const chars = Array.from(text.toLocaleLowerCase());
  if (!chars.length) return null;
  const repeated = chars.every((char) => char === chars[0]);
  const prefix = repeated ? chars[0] : chars.join("");
  const index = current === null ? -1 : rows.findIndex((row) => row.key === current);
  const start = repeated ? index + 1 : Math.max(index, 0);
  for (let offset = 0; offset < rows.length; offset++) {
    const row = rows[(start + offset) % rows.length];
    if (row.label.toLocaleLowerCase().startsWith(prefix)) return row.key;
  }
  return null;
}

/** A folder row that a paper can be dropped on, by its top and bottom on screen. */
export type DropRow = { id: string; top: number; bottom: number };

/** The folder row across the height `y`, where the middle of a paper dragged with the keyboard is. */
export function dropRowAt(rows: DropRow[], y: number): string | null {
  return rows.find((row) => row.top <= y && y < row.bottom)?.id ?? null;
}

/**
 * The folder row that ↓ (direction 1) or ↑ (-1) moves a paper dragged with the keyboard to, from where
 * its middle is (`y`): the nearest one whose middle is below, or above. The paper starts between
 * folders, over none of them, so that dropping it at once moves nothing.
 */
export function nextDropRow(rows: DropRow[], y: number, direction: 1 | -1): DropRow | null {
  let best: DropRow | null = null;
  for (const row of rows) {
    const middle = (row.top + row.bottom) / 2;
    if (direction > 0 ? middle <= y + 0.5 : middle >= y - 0.5) continue;
    if (!best || Math.abs(middle - y) < Math.abs((best.top + best.bottom) / 2 - y)) best = row;
  }
  return best;
}
