import type { Folder, ItemLink, LibraryItem } from '../../../runtime/edits/contracts.ts';

export type CanonicalLibraryRow = {
  key: string; id: string; kind: 'folder' | 'item' | 'link' | 'more'; depth: number; parentKey: string | null;
  label: string; expandable: boolean; expanded: boolean; link?: ItemLink;
  siblingIndex?: number; siblingCount?: number; remaining?: number;
};
export const canonicalFolderKey = (id: string) => `folder:${id}`;
export const canonicalItemKey = (id: string) => `item:${id}`;
export const canonicalLinkKey = (ownerId: string, targetId: string) => `link:${ownerId}:${targetId}`;

/** Catalog IDs determine identity; owned content appears only beneath its live owner, followed by bilateral links. */
export function canonicalLibraryRows({ items, folders, links = [], expanded, deletedIds = new Set<string>() }: {
  items: readonly LibraryItem[]; folders: readonly Folder[]; links?: readonly ItemLink[];
  expanded: ReadonlySet<string>; deletedIds?: ReadonlySet<string>;
}): CanonicalLibraryRow[] {
  type Node = { key: string; id: string; kind: 'folder' | 'item' | 'link'; label: string; position: number; link?: ItemLink };
  const groups = new Map<string | null, Node[]>(), seenNodes = new Set<string>();
  const byId = new Map(items.filter(item => !deletedIds.has(item.id)).map(item => [item.id, item]));
  const liveItems = new Set(byId.keys());
  const add = (parent: string | null, node: Node) => {
    if (seenNodes.has(node.key)) return;
    seenNodes.add(node.key);
    const group = groups.get(parent) ?? []; group.push(node); groups.set(parent, group);
  };
  for (const folder of folders) add(folder.parentId ? canonicalFolderKey(folder.parentId) : null,
    { key: canonicalFolderKey(folder.id), id: folder.id, kind: 'folder', label: folder.title, position: folder.position });
  for (const item of items) {
    if (!liveItems.has(item.id) || item.ownerId && !liveItems.has(item.ownerId)) continue;
    add(item.ownerId ? canonicalItemKey(item.ownerId) : item.folderId ? canonicalFolderKey(item.folderId) : null,
      { key: canonicalItemKey(item.id), id: item.id, kind: 'item', label: item.title, position: item.position });
  }
  for (const link of links) {
    const pdf = byId.get(link.pdfId), note = byId.get(link.noteId);
    if (!pdf || !note || pdf.kind !== 'pdf' || !['markdown', 'notebook'].includes(note.kind) || pdf.ownerId !== null || note.ownerId !== null) continue;
    const edge = { pdfId: link.pdfId, noteId: link.noteId };
    add(canonicalItemKey(pdf.id), { key: canonicalLinkKey(pdf.id, note.id), id: note.id, kind: 'link', label: `↗ ${note.title}`, position: 0, link: edge });
    add(canonicalItemKey(note.id), { key: canonicalLinkKey(note.id, pdf.id), id: pdf.id, kind: 'link', label: `↗ ${pdf.title}`, position: 0, link: edge });
  }
  for (const group of groups.values()) group.sort((a, b) => {
    if ((a.kind === 'link') !== (b.kind === 'link')) return a.kind === 'link' ? 1 : -1;
    if (a.kind === 'link' && b.kind === 'link') return a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return a.position - b.position || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const rows: CanonicalLibraryRow[] = [], seen = new Set<string>();
  const stack: { node: Node; parentKey: string | null; depth: number }[] = [];
  const pushChildren = (parentKey: string | null, depth: number) => {
    const children = groups.get(parentKey) ?? [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], parentKey, depth });
  };
  pushChildren(null, 0);
  while (stack.length) {
    const { node, parentKey, depth } = stack.pop()!;
    if (seen.has(node.key)) continue; seen.add(node.key);
    const expandable = node.kind !== 'link' && !!groups.get(node.key)?.length, open = expandable && expanded.has(node.key);
    rows.push({ key: node.key, id: node.id, kind: node.kind, label: node.label, depth, parentKey, expandable, expanded: open,
      ...(node.link ? { link: node.link } : {}) });
    if (open) pushChildren(node.key, depth + 1);
  }
  return rows;
}

/** Presentation only: the complete canonical projection and catalog remain intact. Reveal admits every ancestor prefix. */
export function paginateCanonicalLibraryRows(rows: readonly CanonicalLibraryRow[], limits: ReadonlyMap<string | null, number>,
  revealKey: string | null, childPage = 6, rootPage = 100): CanonicalLibraryRow[] {
  const groups = new Map<string | null, CanonicalLibraryRow[]>(), byKey = new Map(rows.map(row => [row.key, row]));
  for (const row of rows) { const group = groups.get(row.parentKey) ?? []; group.push(row); groups.set(row.parentKey, group); }
  const required = new Map<string | null, number>();
  let target = revealKey ? byKey.get(revealKey) : undefined;
  const seen = new Set<string>();
  while (target && !seen.has(target.key)) {
    seen.add(target.key);
    required.set(target.parentKey, (groups.get(target.parentKey)?.findIndex(row => row.key === target!.key) ?? -1) + 1);
    target = target.parentKey ? byKey.get(target.parentKey) : undefined;
  }
  const result: CanonicalLibraryRow[] = [], pending: CanonicalLibraryRow[] = [];
  const push = (parentKey: string | null) => {
    const group = groups.get(parentKey) ?? [], count = Math.min(group.length,
      Math.max(limits.get(parentKey) ?? (parentKey === null ? rootPage : childPage), required.get(parentKey) ?? 0));
    if (count < group.length) {
      const parent = parentKey ? byKey.get(parentKey) : null;
      pending.push({ key: `more:${parentKey ?? 'root'}`, id: parent?.id ?? '', kind: 'more', depth: parent ? parent.depth + 1 : 0,
        parentKey, label: `さらに${group.length - count}件を表示`, expandable: false, expanded: false, remaining: group.length - count });
    }
    for (let index = count - 1; index >= 0; index--) pending.push({ ...group[index], siblingIndex: index + 1, siblingCount: group.length });
  };
  push(null);
  while (pending.length) { const row = pending.pop()!; result.push(row); if (row.kind !== 'more') push(row.key); }
  return result;
}

export type CanonicalTreeKeyAction = { type: 'focus' | 'expand' | 'collapse'; key: string };
export function canonicalTreeKey(rows: readonly CanonicalLibraryRow[], currentKey: string, key: string): CanonicalTreeKeyAction | null {
  const index = rows.findIndex(row => row.key === currentKey); if (index < 0) return null;
  const row = rows[index];
  const focus = (target: CanonicalLibraryRow | undefined): CanonicalTreeKeyAction | null => target && target.key !== currentKey ? { type: 'focus', key: target.key } : null;
  if (key === 'Home') return focus(rows[0]);
  if (key === 'End') return focus(rows[rows.length - 1]);
  if (key === 'ArrowUp') return focus(rows[index - 1]);
  if (key === 'ArrowDown') return focus(rows[index + 1]);
  if (key === 'ArrowRight') return row.expandable && !row.expanded ? { type: 'expand', key: row.key }
    : row.expanded ? focus(rows[index + 1]) : null;
  if (key === 'ArrowLeft') return row.expanded ? { type: 'collapse', key: row.key }
    : focus(rows.find(value => value.key === row.parentKey));
  return null;
}

/** Preserve logical focus; collapsing chooses an ancestor, deletion chooses the nearest surviving row. */
export function canonicalTreeFocus(rows: readonly CanonicalLibraryRow[], previousRows: readonly CanonicalLibraryRow[], focusedKey: string | null): string | null {
  const visible = new Set(rows.map(row => row.key));
  if (focusedKey && visible.has(focusedKey)) return focusedKey;
  const previousByKey = new Map(previousRows.map(row => [row.key, row]));
  let previous = focusedKey ? previousByKey.get(focusedKey) : undefined;
  const seen = new Set<string>();
  while (previous?.parentKey && !seen.has(previous.parentKey)) {
    if (visible.has(previous.parentKey)) return previous.parentKey;
    seen.add(previous.parentKey); previous = previousByKey.get(previous.parentKey);
  }
  const index = previousRows.findIndex(row => row.key === focusedKey);
  if (index >= 0) {
    const next = previousRows.slice(index + 1).find(row => visible.has(row.key))
      ?? previousRows.slice(0, index).reverse().find(row => visible.has(row.key));
    if (next) return next.key;
  }
  return rows[0]?.key ?? null;
}
