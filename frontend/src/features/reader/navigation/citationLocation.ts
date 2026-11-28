import type { CitationTarget } from '../../../runtime/markdown/markdownCitations.ts';
import type { DocumentSnapshot, Page } from '../../../runtime/edits/contracts.ts';
import type { ReadingPlace } from './readingPlace.ts';

export type CitationLocationResult = { status: 'resolved'; page: Page; place: ReadingPlace | null }
  | { status: 'unresolved'; reason: 'library-mismatch' | 'document-mismatch' | 'missing' | 'deleted'
    | 'wrong-surface' | 'background-changed' | 'anchor-outside' };

/** Resolve against the currently selected canonical version, never a page number or translation mapping. */
export function resolveCitationLocation(target: CitationTarget, { libraryId, document }: {
  libraryId: string; document: DocumentSnapshot;
}): CitationLocationResult {
  if (target.libraryId !== libraryId) return { status: 'unresolved', reason: 'library-mismatch' };
  if (target.documentId !== document.id) return { status: 'unresolved', reason: 'document-mismatch' };
  if (target.surface !== 'original' && target.surface !== 'translated') return { status: 'unresolved', reason: 'wrong-surface' };
  const original = document.pages, translated = document.translation?.pages ?? [];
  const collection = target.surface === 'original' ? original : translated;
  const page = collection.find(value => value.id === target.pageId);
  if (!page) {
    if ([...original, ...translated].some(value => value.id === target.pageId)) return { status: 'unresolved', reason: 'wrong-surface' };
    return { status: 'unresolved', reason: document.deletedPages.some(value => value.id === target.pageId) ? 'deleted' : 'missing' };
  }
  if (page.backgroundRevision !== target.backgroundRevision) return { status: 'unresolved', reason: 'background-changed' };
  const anchor = target.anchor;
  if (!anchor) return { status: 'resolved', page, place: null };
  if (![anchor.xPt, anchor.yPt, page.widthPt, page.heightPt].every(Number.isFinite)
    || page.widthPt <= 0 || page.heightPt <= 0 || anchor.xPt < 0 || anchor.xPt > page.widthPt
    || anchor.yPt < 0 || anchor.yPt > page.heightPt) return { status: 'unresolved', reason: 'anchor-outside' };
  return { status: 'resolved', page, place: { x: anchor.xPt / page.widthPt, y: anchor.yPt / page.heightPt } };
}
