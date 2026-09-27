/**
 * The library tree's folders, built from the paper list, and the filters over that list. Kept apart
 * from the sidebar so that they can be tested.
 *
 * The sidebar memoizes the filtered list and the tree, and its rows are memoized too: a row renders
 * again only when its paper or folder changes. So filterPapers hands the list back as it is when
 * nothing filters it, and the tree keeps the paper objects of the list, which TanStack Query keeps
 * for the papers a refetch did not change.
 */
import type { PaperData } from "../../api/hooks.ts";
import type { PendingImport } from "../../app/pendingImports.ts";

export type FolderNode = {
  path: string;
  name: string;
  children: FolderNode[];
  papers: PaperData[];
  pending: PendingImport[];
  count: number;
};

/** A folder path as the library shows it: "親 / 子", from either slash. */
export function normalizeCollection(value: string): string {
  return value.split(/[\\/]/).map((part) => part.trim()).filter(Boolean).join(" / ");
}

/** Whether the folder `value` is `path` or one of its subfolders. */
export function isInsideFolder(value: string, path: string): boolean {
  const name = normalizeCollection(value);
  return name === path || name.startsWith(path + " / ");
}

/**
 * The papers in the folder `path` and its subfolders, which deleting it moves to 未分類; null while the
 * paper list is not known (still loading, or it failed to load), so that deleting asks all the same.
 */
export function countInFolder(papers: PaperData[] | null, path: string): number | null {
  return papers && papers.filter((p) => isInsideFolder(p.collection_name || "", path)).length;
}

export type PaperFilter = {
  tag: string;
  readStatus: string;
  /** The papers the library search found; null while not searching. */
  matches: ReadonlySet<string> | null;
};

/** The papers the tag, reading status and search keep; `papers` itself when nothing filters. */
export function filterPapers(papers: PaperData[], { tag, readStatus, matches }: PaperFilter): PaperData[] {
  if (!tag && !readStatus && !matches) return papers;
  return papers.filter((p) => (!tag || !!p.tags?.includes(tag)) && (!readStatus || p.read_status === readStatus)
    && (!matches || matches.has(p.id)));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

const collator = new Intl.Collator("ja", { sensitivity: "base" });

/** Folders by depth, then by name; 未分類 last. Linear in the papers, so that a large library stays quick. */
export function buildTree(collections: string[], papers: PaperData[], pending: PendingImport[], filtered: boolean): FolderNode[] {
  const grouped = groupBy(papers, (paper) => normalizeCollection(paper.collection_name || ""));
  const pendingGroups = groupBy(pending, (item) => item.collection);
  // While searching only folders with matches are listed, as in the old tree.
  // PDFs being added are always shown, so a drop never seems to have been ignored.
  const paths = new Set<string>([...grouped.keys(), ...pendingGroups.keys()].filter(Boolean));
  if (!filtered) collections.forEach((c) => paths.add(c));
  for (const path of [...paths]) {
    const parts = path.split(" / ");
    for (let depth = 1; depth < parts.length; depth++) paths.add(parts.slice(0, depth).join(" / "));
  }
  const depths = new Map([...paths].map((path) => [path, path.split(" / ").length]));
  const nodes = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  const ordered = [...paths].sort((a, b) => depths.get(a)! - depths.get(b)! || collator.compare(a, b));
  for (const path of ordered) {
    const parts = path.split(" / ");
    const node: FolderNode = {
      path, name: parts[parts.length - 1], children: [], papers: grouped.get(path) ?? [],
      pending: pendingGroups.get(path) ?? [], count: 0,
    };
    nodes.set(path, node);
    const parent = nodes.get(parts.slice(0, -1).join(" / "));
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
