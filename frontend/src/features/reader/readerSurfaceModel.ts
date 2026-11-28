import type { DocumentSnapshot, Page } from '../../runtime/edits/contracts.ts';

export type ReaderSurface = 'original' | 'translated';
export type ReaderDisplay = ReaderSurface | 'split';
export type TranslationStatus = 'available' | 'missing' | 'ambiguous';
export type ReaderSurfaceResult = { status: 'applied' | 'unchanged' } | { status: 'blocked'; reason: string };
export function readerTranslationPages(document: DocumentSnapshot): ReadonlyMap<string, { status: TranslationStatus; page: Page | null }> {
  const bindings = new Map(document.translation?.bindings.map(binding => [binding.original.pageId, binding]));
  const pool = new Map(document.translation?.pages.map(page => [page.id, page]));
  const counts = new Map<string, number>();
  const result = new Map<string, { status: TranslationStatus; page: Page | null }>();
  for (const original of document.pages) {
    const binding = bindings.get(original.id);
    let value: { status: TranslationStatus; page: Page | null } = { status: 'missing', page: null };
    if (binding?.original.backgroundRevision === original.backgroundRevision && binding.candidates.length) {
      if (binding.candidates.length !== 1) value = { status: 'ambiguous', page: null };
      else {
        const candidate = binding.candidates[0], page = pool.get(candidate.pageId);
        if (page?.backgroundRevision === candidate.backgroundRevision) {
          value = { status: 'available', page }; counts.set(page.id, (counts.get(page.id) ?? 0) + 1);
        }
      }
    }
    result.set(original.id, value);
  }
  for (const [id, value] of result) if (value.page && counts.get(value.page.id)! > 1) result.set(id, { status: 'ambiguous', page: null });
  return result;
}
export function translatedPage(document: DocumentSnapshot, originalPageId: string): { status: TranslationStatus; page: Page | null } {
  return readerTranslationPages(document).get(originalPageId) ?? { status: 'missing', page: null };
}
/** A citation names the translated pool page itself. Never invent an original route. */
export function originalForTranslatedPage(document: DocumentSnapshot, translatedPageId: string):
  { status: 'resolved'; originalPageId: string } | { status: 'unresolved'; reason: 'translation-unmapped' | 'translation-ambiguous' } {
  const index = readerTranslationPages(document), matches = document.pages.filter(page => index.get(page.id)?.page?.id === translatedPageId);
  if (matches.length === 1) return { status: 'resolved', originalPageId: matches[0].id };
  const ambiguous = document.translation?.bindings.some(binding => index.get(binding.original.pageId)?.status === 'ambiguous'
    && binding.candidates.some(candidate => candidate.pageId === translatedPageId));
  return { status: 'unresolved', reason: ambiguous ? 'translation-ambiguous' : 'translation-unmapped' };
}
export function readerSurfaceSignature(document: DocumentSnapshot): string {
  return JSON.stringify([document.pages.map(page => [page.id, page.backgroundRevision]),
    document.translation?.pages.map(page => [page.id, page.backgroundRevision]) ?? [], document.translation?.bindings ?? []]);
}
