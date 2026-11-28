import type { DocumentSnapshot, Page } from './contracts.ts';

/** Reading order is the primary collection; translated surfaces are separate edit targets. */
export function activeDocumentPages(document: DocumentSnapshot): Page[] {
  return [...document.pages, ...(document.translation?.pages ?? [])];
}
export function allDocumentPages(document: DocumentSnapshot): Page[] {
  return [...activeDocumentPages(document), ...document.deletedPages];
}
export function pageExpectation(page: Page) {
  return { pageId: page.id, backgroundRevision: page.backgroundRevision,
    lifecycleVersion: page.lifecycleVersion, annotationVersion: page.annotationVersion };
}

/** Version stamps alone do not turn an unchanged edit into a new user operation. */
export function documentContent(document: DocumentSnapshot) {
  const known = new Map(allDocumentPages(document).map(page => [page.id, page]));
  const pageContent = (page: Page) => ({ ...page, backgroundRevision: '', lifecycleVersion: '', annotationVersion: '',
    annotations: page.annotations.map(annotation => annotation.kind === 'highlight' ? { ...annotation, backgroundRevision: '' } : annotation) });
  const reference = (ref: { pageId: string; backgroundRevision: string }) => ({ ...ref,
    backgroundRevision: known.get(ref.pageId)?.backgroundRevision === ref.backgroundRevision ? '' : ref.backgroundRevision });
  return { ...document, version: '', pages: document.pages.map(pageContent), deletedPages: document.deletedPages.map(pageContent),
    ...(document.translation ? { translation: { revision: '', pages: document.translation.pages.map(pageContent),
      bindings: document.translation.bindings.map(binding => ({ original: reference(binding.original), candidates: binding.candidates.map(reference) })) } } : {}) };
}
