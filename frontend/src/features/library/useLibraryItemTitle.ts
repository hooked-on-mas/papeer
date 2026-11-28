import { useMemo, useSyncExternalStore } from 'react';
import type { DocumentLibraryBinding } from '../reader/DocumentLibraryBinding';

/** Metadata may change while an editor holds a draft; updating the title must not reload that editor. */
export function useLibraryItemTitle(binding: DocumentLibraryBinding, fallback: string): string {
  const library = useMemo(() => binding.sessions.getLibrary(), [binding.sessions]);
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const current = binding.catalogVersion ? state.selectedVersion === binding.catalogVersion : state.heads.length === 1;
  return current ? state.items.find(item => item.id === binding.documentId)?.title ?? fallback : fallback;
}

export function useLibraryItemDeleted(binding: DocumentLibraryBinding, fallback = false): boolean {
  const library = useMemo(() => binding.sessions.getLibrary(), [binding.sessions]);
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const current = state.ready && (binding.catalogVersion ? state.selectedVersion === binding.catalogVersion : state.heads.length === 1);
  return current ? state.deletions.some(record => record.active && record.itemIds.includes(binding.documentId)) : fallback;
}
