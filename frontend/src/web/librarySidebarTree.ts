import type { ArtifactView, LibraryItemView } from "../runtime/contracts.ts";
import { folderAncestors, folderName, normalizeCollection, parentFolder } from "../lib/collectionPath.ts";

export type WebLibraryChild = { kind: "owned"; item: LibraryItemView } | { kind: "attachment"; artifact: ArtifactView };
export type WebLibraryEntry = { item: LibraryItemView; children: WebLibraryChild[] };
export type WebLibraryFolder = { path: string; name: string; children: WebLibraryFolder[]; entries: WebLibraryEntry[]; count: number };

/** Published metadata only: search never implies that un-downloaded PDF bodies were indexed. */
export function buildWebLibraryTree(items: readonly LibraryItemView[], artifacts: readonly ArtifactView[], query = ""): WebLibraryFolder[] {
  const term = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(term);
  const ids = new Set(items.map(item => item.id));
  const children = new Map<string, WebLibraryChild[]>();
  const append = (owner: string, child: WebLibraryChild) => {
    const rows = children.get(owner) ?? []; rows.push(child); children.set(owner, rows);
  };
  for (const item of items) if (item.parentId && ids.has(item.parentId) && item.parentId !== item.id) append(item.parentId, { kind: "owned", item });
  for (const artifact of artifacts) if (artifact.itemId && artifact.role === "attachment") append(artifact.itemId, { kind: "attachment", artifact });
  const nodes = new Map<string, WebLibraryFolder>();
  const ensure = (path: string) => {
    if (!nodes.has(path)) nodes.set(path, { path, name: folderName(path) || "未分類", children: [], entries: [], count: 0 });
    return nodes.get(path)!;
  };
  for (const item of items) {
    if (item.parentId && ids.has(item.parentId) && item.parentId !== item.id) continue;
    const owned = children.get(item.id) ?? [];
    const itemMatches = matches(`${item.title} ${item.collectionName}`);
    const shown = term && !itemMatches ? owned.filter(child => matches(child.kind === "owned" ? child.item.title : child.artifact.label)) : owned;
    if (term && !itemMatches && !shown.length) continue;
    const path = normalizeCollection(item.collectionName);
    for (const ancestor of folderAncestors(path)) ensure(ancestor);
    ensure(path).entries.push({ item, children: shown });
  }
  const roots: WebLibraryFolder[] = [];
  const compare = new Intl.Collator("ja", { sensitivity: "base" }).compare;
  for (const node of nodes.values()) {
    const parentPath = parentFolder(node.path);
    const parent = parentPath ? nodes.get(parentPath) : undefined;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const finish = (rows: WebLibraryFolder[]) => {
    rows.sort((a, b) => !a.path ? 1 : !b.path ? -1 : compare(a.name, b.name));
    for (const node of rows) {
      finish(node.children);
      node.entries.sort((a, b) => Number(b.item.kind === "notebook") - Number(a.item.kind === "notebook"));
      node.count = node.entries.length + node.children.reduce((sum, child) => sum + child.count, 0);
    }
  };
  finish(roots);
  return roots;
}
