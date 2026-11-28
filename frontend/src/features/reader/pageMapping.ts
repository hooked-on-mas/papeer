import type { DocumentSnapshot, Page, TranslationBinding } from '../../runtime/edits/contracts.ts';

/** Mapping identity is independent of URL, PDF ordinal, rendering instance and host. */
export type PdfPageBinding = { pageId: string; resourceId: string; sourceRevision: string; pdfPage: number; backgroundRevision: string };
export type MappingResult = { status: 'resolved'; binding: PdfPageBinding } | { status: 'unresolved';
  reason: 'source-missing' | 'source-deleted' | 'source-changed' | 'missing' | 'ambiguous' | 'target-changed' | 'target-deleted' };

export function pdfBinding(page: Page): PdfPageBinding | null {
  return page.background.kind === 'pdf' ? { pageId: page.id, backgroundRevision: page.backgroundRevision,
    resourceId: page.background.resourceId, sourceRevision: page.background.sourceRevision, pdfPage: page.background.pdfPage } : null;
}
function currentCandidate(document: DocumentSnapshot, entry: TranslationBinding) {
  const original = document.pages.find(page => page.id === entry.original.pageId);
  if (!original || original.backgroundRevision !== entry.original.backgroundRevision || entry.candidates.length !== 1) return null;
  const candidate = entry.candidates[0], page = document.translation?.pages.find(page => page.id === candidate.pageId);
  return page && page.backgroundRevision === candidate.backgroundRevision ? page : null;
}
export function translatedBinding(document: DocumentSnapshot, originalPageId: string): MappingResult {
  const original = document.pages.find(page => page.id === originalPageId);
  if (!original) return { status: 'unresolved', reason: document.deletedPages.some(page => page.id === originalPageId) ? 'source-deleted' : 'source-missing' };
  const entry = document.translation?.bindings.find(binding => binding.original.pageId === originalPageId);
  if (!entry || !entry.candidates.length) return { status: 'unresolved', reason: 'missing' };
  if (entry.original.backgroundRevision !== original.backgroundRevision) return { status: 'unresolved', reason: 'source-changed' };
  if (entry.candidates.length !== 1) return { status: 'unresolved', reason: 'ambiguous' };
  const candidate = entry.candidates[0], page = document.translation?.pages.find(page => page.id === candidate.pageId);
  if (!page) return { status: 'unresolved', reason: document.deletedPages.some(page => page.id === candidate.pageId) ? 'target-deleted' : 'missing' };
  if (page.backgroundRevision !== candidate.backgroundRevision) return { status: 'unresolved', reason: 'target-changed' };
  const matches = document.translation!.bindings.filter(binding => currentCandidate(document, binding)?.id === page.id);
  if (matches.length !== 1) return { status: 'unresolved', reason: 'ambiguous' };
  const binding = pdfBinding(page);
  return binding ? { status: 'resolved', binding } : { status: 'unresolved', reason: 'missing' };
}
export function originalForBinding(document: DocumentSnapshot, binding: PdfPageBinding): string | null {
  const candidates = document.translation?.bindings.filter(entry => currentCandidate(document, entry)?.id === binding.pageId) ?? [];
  if (candidates.length !== 1) return null;
  const result = translatedBinding(document, candidates[0].original.pageId);
  if (result.status !== 'resolved') return null;
  const keys: (keyof PdfPageBinding)[] = ['pageId', 'backgroundRevision', 'resourceId', 'sourceRevision', 'pdfPage'];
  return keys.every(key => result.binding[key] === binding[key]) ? candidates[0].original.pageId : null;
}
