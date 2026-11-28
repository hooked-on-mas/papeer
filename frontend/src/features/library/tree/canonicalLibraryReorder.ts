import type { LibraryChange, LibrarySnapshot } from '../../../runtime/edits/contracts.ts';
import { EditRejected } from '../../../runtime/edits/editModel.ts';
import { isNoteTemplate } from '../../../runtime/markdown/noteTemplates.ts';
import { moveLibraryFolder, moveLibraryItems } from '../canonicalLibraryOperations.ts';

export type LibraryTreeEntry = { kind: 'folder' | 'item'; id: string };
export type LibraryTreePlacement = 'inside' | 'before' | 'after';

/** One catalog mutation: hierarchy and mixed sibling order share the existing journal/history. */
export function reorderLibraryEntry(snapshot: LibrarySnapshot, source: LibraryTreeEntry,
  target: LibraryTreeEntry | null, placement: LibraryTreePlacement): LibraryChange[] {
  if (!['inside', 'before', 'after'].includes(placement) || !['folder', 'item'].includes(source.kind)
    || target && !['folder', 'item'].includes(target.kind)) throw new EditRejected('library-tree-placement');
  const deleted = new Set(snapshot.deletions.filter(value => value.active).flatMap(value => value.itemIds));
  const get = (entry: LibraryTreeEntry) => {
    if (entry.kind === 'folder') {
      const folder = snapshot.folders.find(value => value.id === entry.id);
      if (!folder) throw new EditRejected('library-folder-missing');
      return { ...entry, parent: folder.parentId, position: folder.position };
    }
    const item = snapshot.items.find(value => value.id === entry.id);
    if (!item || deleted.has(item.id) || isNoteTemplate(item)) throw new EditRejected('library-item-unavailable');
    if (item.ownerId !== null) throw new EditRejected('library-owned-item-move');
    return { ...entry, parent: item.folderId, position: item.position };
  };
  const from = get(source), to = target ? get(target) : null;
  if (!to && placement !== 'inside' || to && placement === 'inside' && to.kind !== 'folder') throw new EditRejected('library-tree-placement');
  if (to && from.kind === to.kind && from.id === to.id && placement !== 'inside') return [];
  const parentId = placement === 'inside' ? to?.id ?? null : to!.parent;
  // Reuse the canonical availability and ancestor/cycle admission before constructing any changes.
  if (source.kind === 'folder') moveLibraryFolder(snapshot, source.id, parentId); else moveLibraryItems(snapshot, [source.id], parentId);
  const siblings = [
    ...snapshot.folders.filter(value => value.parentId === parentId).map(value => ({ kind: 'folder' as const, id: value.id, position: value.position })),
    ...snapshot.items.filter(value => value.ownerId === null && value.folderId === parentId && !deleted.has(value.id) && !isNoteTemplate(value))
      .map(value => ({ kind: 'item' as const, id: value.id, position: value.position })),
  ].filter(value => value.kind !== source.kind || value.id !== source.id)
    .sort((a, b) => a.position - b.position || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const targetIndex = placement === 'inside' ? siblings.length : siblings.findIndex(value => value.kind === to!.kind && value.id === to!.id);
  if (targetIndex < 0) throw new EditRejected('library-tree-target-changed');
  siblings.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, from);
  const changes: LibraryChange[] = [];
  for (const [position, entry] of siblings.entries()) {
    if (entry.kind === 'folder') {
      const folder = snapshot.folders.find(value => value.id === entry.id)!;
      if (folder.parentId !== parentId || folder.position !== position) changes.push({ type: 'put-folder', folder: { ...folder, parentId, position } });
    } else {
      const item = snapshot.items.find(value => value.id === entry.id)!;
      if (item.folderId !== parentId || item.position !== position) changes.push({ type: 'put-item', item: { ...structuredClone(item), folderId: parentId, position } });
    }
  }
  return changes;
}
