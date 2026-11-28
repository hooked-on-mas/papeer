import type { LibraryItem, LibrarySnapshot } from '../../../runtime/edits/contracts';
import { isNoteTemplate } from '../../../runtime/markdown/noteTemplates.ts';

export type RelatedContent = { status: 'unavailable' } | { status: 'ready'; ownerId: string; items: ReadonlyArray<Pick<LibraryItem, 'id' | 'kind' | 'title'>> };
/** Read only the explicitly accepted catalog; never infer a relation from titles. */
export function projectRelatedContent(snapshot: LibrarySnapshot | null | undefined, currentId: string | null): RelatedContent {
  if (!snapshot || !currentId) return { status: 'unavailable' };
  const deleted = new Set(snapshot.deletions.filter(item => item.active).flatMap(item => item.itemIds));
  const available = snapshot.items.filter(item => !deleted.has(item.id) && !isNoteTemplate(item));
  const current = available.filter(item => item.id === currentId);
  if (current.length !== 1) return { status: 'unavailable' };
  const ownerId = current[0].ownerId ?? currentId;
  if (available.filter(item => item.id === ownerId && item.ownerId === null).length !== 1) return { status: 'unavailable' };
  const rows = available.filter(item => item.ownerId === ownerId && ['markdown', 'notebook', 'attachment'].includes(item.kind));
  if (new Set(rows.map(item => item.id)).size !== rows.length) return { status: 'unavailable' };
  return { status: 'ready', ownerId, items: rows.map(({ id, kind, title }) => ({ id, kind, title })) };
}
