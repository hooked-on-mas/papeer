import { validateId, validatePage, type DocumentSnapshot, type Page, type PageChange, type PaperSpec } from '../../runtime/edits/contracts.ts';
import { allDocumentPages, pageExpectation } from '../../runtime/edits/documentPages.ts';
import { assertPage, canonicalJson, EditRejected } from '../../runtime/edits/editModel.ts';
import { resizePaper } from '../../runtime/edits/pageCoordinates.ts';

function sourcePage(document: DocumentSnapshot, pageId: string): { page: Page; index: number } {
  const index = document.pages.findIndex(page => page.id === pageId);
  if (index < 0) throw new EditRejected('missing-notebook-page');
  return { page: document.pages[index], index };
}

function insertedPage(document: DocumentSnapshot, newPageId: string, batchId: string) {
  validateId(newPageId); validateId(batchId);
  if (document.pages.length >= 500) throw new EditRejected('notebook-page-limit');
  if (allDocumentPages(document).some(page => page.id === newPageId)) throw new EditRejected('notebook-page-id-reused');
}

/** Add blank paper at the neighbour's physical dimensions; PDF neighbours require an explicit paper spec. */
export function notebookInsert(document: DocumentSnapshot, pageId: string, side: 'before' | 'after', newPageId: string, batchId: string, paper?: PaperSpec): PageChange[] {
  const { page, index } = sourcePage(document, pageId);
  insertedPage(document, newPageId, batchId);
  if (page.background.kind !== 'paper' && !paper) throw new EditRejected('paper-seed-required');
  if (side !== 'before' && side !== 'after') throw new EditRejected('notebook-insert-side');
  const inserted: Page = { id: newPageId, backgroundRevision: batchId, lifecycleVersion: batchId, annotationVersion: batchId,
    widthPt: page.widthPt, heightPt: page.heightPt,
    background: page.background.kind === 'paper' ? structuredClone(page.background) : { kind: 'paper', spec: structuredClone(paper!) }, annotations: [] };
  validatePage(inserted); assertPage(inserted);
  return [{ type: 'insert', index: index + (side === 'after' ? 1 : 0), page: inserted }];
}

/** Clone all annotation kinds and their stacking order, assigning externally supplied fresh IDs. */
export function notebookDuplicate(document: DocumentSnapshot, pageId: string, newPageId: string, annotationIds: string[], batchId: string): PageChange[] {
  const { page, index } = sourcePage(document, pageId);
  insertedPage(document, newPageId, batchId);
  if (annotationIds.length !== page.annotations.length || new Set(annotationIds).size !== annotationIds.length)
    throw new EditRejected('notebook-copy-annotation-ids');
  const existingIds = new Set(allDocumentPages(document).flatMap(page => page.annotations.map(annotation => annotation.id)));
  for (const id of annotationIds) {
    validateId(id);
    if (existingIds.has(id)) throw new EditRejected('notebook-annotation-id-reused');
  }
  const copied: Page = { ...structuredClone(page), id: newPageId,
    backgroundRevision: batchId, lifecycleVersion: batchId, annotationVersion: batchId,
    annotations: page.annotations.map((annotation, i) => ({ ...structuredClone(annotation), id: annotationIds[i],
      ...(annotation.kind === 'highlight' ? { backgroundRevision: batchId } : {}) })) };
  validatePage(copied); assertPage(copied);
  return [{ type: 'insert', index: index + 1, page: copied }];
}

/** targetIndex is the final zero-based position in the primary collection. */
export function notebookMove(document: DocumentSnapshot, pageId: string, targetIndex: number): PageChange[] {
  const { page, index } = sourcePage(document, pageId);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= document.pages.length) throw new EditRejected('notebook-move-index');
  return index === targetIndex ? [] : [{ type: 'move', expected: pageExpectation(page), index: targetIndex }];
}

export function notebookRemove(document: DocumentSnapshot, pageId: string): PageChange[] {
  const { page } = sourcePage(document, pageId);
  if (document.pages.length <= 1) throw new EditRejected('notebook-last-page');
  return [{ type: 'remove', expected: pageExpectation(page) }];
}

/** Default keeps physical geometry. Uniform fit is an explicit user choice. */
export function notebookApplyPaper(document: DocumentSnapshot, pageId: string, widthPt: number, heightPt: number, spec: PaperSpec, batchId: string, fit = false): PageChange[] {
  const { page } = sourcePage(document, pageId);
  validateId(batchId);
  if (page.background.kind !== 'paper') throw new EditRejected('paper-background-required');
  const background = { kind: 'paper' as const, spec: structuredClone(spec) };
  const changed = page.widthPt !== widthPt || page.heightPt !== heightPt || canonicalJson(page.background) !== canonicalJson(background);
  const resized = resizePaper(page, widthPt, heightPt, changed ? batchId : page.backgroundRevision, fit);
  const next = { ...resized, background };
  validatePage(next); assertPage(next);
  return [{ type: 'replace', expected: pageExpectation(page), page: next }];
}
