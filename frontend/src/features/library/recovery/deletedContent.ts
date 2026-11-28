import type { LibrarySnapshot } from '../../../runtime/edits/contracts.ts';
import type { EditGraph } from '../../../runtime/edits/editGraph.ts';

export type DeletedContent = { deletionId: string; itemId: string; state: 'waiting' | 'observed' | 'unobserved'; heads: string[] };
/** Deleted catalog items remain independent query targets, including notes hidden with their owner. */
export function deletedContent(snapshot: LibrarySnapshot, graphs: ReadonlyMap<string, EditGraph>): DeletedContent[] {
  return snapshot.deletions.filter(record => record.active).flatMap(record => record.itemIds.flatMap<DeletedContent>(itemId => {
    const item = snapshot.items.find(item => item.id === itemId);
    if (!item || item.kind === 'attachment') return [];
    const observed = record.observed.find(observation => observation.targetId === itemId)!.heads;
    const graph = graphs.get(itemId), view = graph?.getView();
    if (!graph || !view || view.waiting.length || observed.some(head => !graph.snapshot(head)))
      return [{ deletionId: record.id, itemId, state: 'waiting' as const, heads: view?.heads ?? [] }];
    // A head covered by an observation is safe; a descendant or independent branch is new content.
    const unseen = view.heads.some(head => !observed.some(known => graph.descendsFrom(known, head)));
    return [{ deletionId: record.id, itemId, state: unseen ? 'unobserved' as const : 'observed' as const, heads: view.heads }];
  }));
}
