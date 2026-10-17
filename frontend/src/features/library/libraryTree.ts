/**
 * The library tree's folders, built from the paper list, and the filters over that list. Kept apart
 * from the sidebar so that they can be tested.
 *
 * The sidebar memoizes the filtered list and the tree, and its rows are memoized too: a row renders
 * again only when its paper or folder changes. So filterPapers hands the list back as it is when
 * nothing filters it, and the tree keeps the paper objects of the list, which TanStack Query keeps
 * for the papers a refetch did not change.
 *
 * The folders list the items that no other item holds. An item with a parent_id (a notebook of a paper)
 * is shown under its parent, once that is built (treeLines.ts), and never as a row of a folder.
 */
import type { PaperData } from "../../api/hooks.ts";
import type { PendingImport } from "../../app/pendingImports.ts";
import { folderAncestors, folderName, folderParts, isInsideFolder, normalizeCollection, parentFolder } from "../../lib/collectionPath.ts";
import { itemCapabilities } from "../../lib/itemKinds.ts";

export type FolderNode = {
  path: string;
  name: string;
  children: FolderNode[];
  papers: PaperData[];
  pending: PendingImport[];
  count: number;
};

/** Whether another item holds it (its parent_id): it is not an item of a folder. */
export const isHeld = (item: PaperData): boolean => !!item.parent_id;

/**
 * The papers in the folder `path` and its subfolders, which deleting it moves to 未分類; null while the
 * paper list is not known (still loading, or it failed to load), so that deleting asks all the same.
 */
export function countInFolder(papers: PaperData[] | null, path: string): number | null {
  return papers && papers.filter((p) => !isHeld(p) && isInsideFolder(p.collection_name || "", path)).length;
}

export type PaperFilter = {
  tag: string;
  readStatus: string;
  /** The papers the library search found; null while not searching. */
  matches: ReadonlySet<string> | null;
};

/**
 * The papers the tag, reading status and search keep; `papers` itself when nothing filters. An item with no
 * reading status (a notebook) is not kept by one, whatever its row says.
 */
export function filterPapers(papers: PaperData[], { tag, readStatus, matches }: PaperFilter): PaperData[] {
  if (!tag && !readStatus && !matches) return papers;
  return papers.filter((p) => (!tag || !!p.tags?.includes(tag)) && (!readStatus || (itemCapabilities(p).readStatus && p.read_status === readStatus))
    && (!matches || matches.has(p.id)));
}

function groupBy<T>(items: T[], key: (item: T) => string, skip?: (item: T) => boolean): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (skip?.(item)) continue;
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

const collator = new Intl.Collator("ja", { sensitivity: "base" });

/**
 * A folder's items with those that are listed first (a notebook, see itemKinds) ahead of the rest, each
 * group in the order the list gave. The same array when none is.
 */
function listedFirstOrder(items: PaperData[]): PaperData[] {
  const first = items.filter((item) => itemCapabilities(item).listedFirst);
  return first.length === 0 || first.length === items.length ? items
    : [...first, ...items.filter((item) => !itemCapabilities(item).listedFirst)];
}

/**
 * What has to be open for the row of `item` to be on screen, which a reveal (a citation, Ctrl+L) opens:
 * the folders along the path of its folder (未分類 when it has none), and for an item another holds, that
 * paper, whose row shows it. `find` looks an item up by id; a holder not found is left out, and the item
 * is taken to be in the folder its own collection_name says.
 */
export function revealOpenings(item: PaperData, find: (id: string) => PaperData | undefined): { folders: string[]; papers: string[] } {
  const holder = item.parent_id ? find(item.parent_id) : undefined;
  const ancestors = folderAncestors((holder ?? item).collection_name || "");
  return { folders: ancestors.length ? ancestors : [""], papers: holder ? [holder.id] : [] };
}

/** Folders by depth, then by name; 未分類 last. Linear in the papers, so that a large library stays quick. */
export function buildTree(collections: string[], papers: PaperData[], pending: PendingImport[], filtered: boolean): FolderNode[] {
  const grouped = groupBy(papers, (paper) => normalizeCollection(paper.collection_name || ""), isHeld);
  for (const [path, group] of grouped) {
    const ordered = listedFirstOrder(group);
    if (ordered !== group) grouped.set(path, ordered);
  }
  const pendingGroups = groupBy(pending, (item) => item.collection);
  // While searching only folders with matches are listed, as in the old tree.
  // PDFs being added are always shown, so a drop never seems to have been ignored.
  const paths = new Set<string>([...grouped.keys(), ...pendingGroups.keys()].filter(Boolean));
  if (!filtered) collections.forEach((c) => paths.add(c));
  for (const path of [...paths]) folderAncestors(path).forEach((ancestor) => paths.add(ancestor));
  const depths = new Map([...paths].map((path) => [path, folderParts(path).length]));
  const nodes = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  const ordered = [...paths].sort((a, b) => depths.get(a)! - depths.get(b)! || collator.compare(a, b));
  for (const path of ordered) {
    const node: FolderNode = {
      path, name: folderName(path), children: [], papers: grouped.get(path) ?? [],
      pending: pendingGroups.get(path) ?? [], count: 0,
    };
    nodes.set(path, node);
    const parent = nodes.get(parentFolder(path));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const count = (node: FolderNode): number =>
    (node.count = node.papers.length + node.pending.length + node.children.reduce((sum, child) => sum + count(child), 0));
  roots.forEach(count);
  if (!filtered || grouped.has("") || pendingGroups.has("")) {
    const unfiled: FolderNode = {
      path: "", name: "未分類", children: [], papers: grouped.get("") ?? [], pending: pendingGroups.get("") ?? [], count: 0,
    };
    unfiled.count = unfiled.papers.length + unfiled.pending.length;
    roots.push(unfiled);
  }
  return roots;
}

export function allFolderPaths(nodes: FolderNode[]): string[] {
  return nodes.flatMap((n) => [n.path, ...allFolderPaths(n.children)]);
}
