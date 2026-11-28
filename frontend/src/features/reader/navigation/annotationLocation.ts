import type { DocumentSnapshot } from '../../../runtime/edits/contracts.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import type { AnnotationBrowserRow } from '../../library/annotations/canonicalAnnotationBrowser.ts';
import type { CitationTarget } from '../../../runtime/markdown/markdownCitations.ts';
import { resolveCitationLocation, type CitationLocationResult } from './citationLocation.ts';
import { originalForTranslatedPage } from '../readerSurfaceModel.ts';

export type AnnotationLocationRequest = { version: string; row: AnnotationBrowserRow; target: CitationTarget };
export type AnnotationLocationResult = Extract<CitationLocationResult, { status: 'resolved' }>
  | { status: 'unresolved'; reason: string };

/** Validate an exact selected annotation against the specified canonical snapshot. */
export function resolveAnnotationLocation(request: AnnotationLocationRequest, context: {
  libraryId: string; document: DocumentSnapshot;
}): AnnotationLocationResult {
  const { row, target, version } = request;
  const refuse = (reason: string): AnnotationLocationResult => ({ status: 'unresolved', reason });
  if (context.document.version !== version || !row.sourceVersions.includes(version)) return refuse('annotation-head-changed');
  if (row.libraryId !== target.libraryId || row.documentId !== target.documentId || row.surface !== target.surface
    || row.pageId !== target.pageId || row.backgroundRevision !== target.backgroundRevision
    || row.annotationId !== row.annotation.id || canonicalJson(row.target) !== canonicalJson(target)
    || !target.anchor || target.anchor.xPt !== row.annotation.anchor.x || target.anchor.yPt !== row.annotation.anchor.y)
    return refuse('annotation-target-mismatch');
  const location = resolveCitationLocation(target, context);
  if (location.status === 'unresolved') return location;
  const annotation = location.page.annotations.find(value => value.id === row.annotationId);
  if (!annotation || annotation.kind === 'ink' || canonicalJson(annotation) !== canonicalJson(row.annotation))
    return refuse('annotation-changed');
  if (target.surface === 'translated') {
    const route = originalForTranslatedPage(context.document, target.pageId);
    if (route.status === 'unresolved') return route;
  }
  return location;
}
