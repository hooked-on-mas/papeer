import type { ContentRepository } from '../../runtime/edits/ports.ts';
import { EditGraph } from '../../runtime/edits/editGraph.ts';

/** Resolve a catalog selection and its content together; one ordinary sync may supply either missing part. */
export async function resolveLibraryContentKind({ repository, documentId, catalogVersion, refresh, alive = () => true }: {
  repository: Pick<ContentRepository, 'scope' | 'read'>; documentId: string; catalogVersion?: string;
  refresh(): Promise<unknown>; alive?(): boolean;
}): Promise<'attachment' | 'document' | 'markdown'> {
  const check = () => { if (!alive()) throw new Error('content-load-stale'); };
  const resolve = async () => {
    check();
    const catalog = await repository.read(repository.scope.libraryId); check();
    const version = catalogVersion ?? (catalog.heads.length === 1 ? catalog.heads[0] : undefined);
    if (!version || !catalog.heads.includes(version)) throw new Error('catalog-head-unavailable');
    const library = new EditGraph(catalog.checkpoint).snapshot(version);
    if (catalog.checkpoint.libraryId !== repository.scope.libraryId || library?.kind !== 'library' || library.id !== repository.scope.libraryId)
      throw new Error('catalog-invalid');
    const item = library.items.find(item => item.id === documentId);
    if (!item) throw new Error('content-missing');
    if (item.kind === 'attachment') return 'attachment' as const;
    const content = await repository.read(documentId); check();
    const root = content.checkpoint.root;
    const expected = item.kind === 'markdown' ? 'markdown' : 'document';
    if (content.checkpoint.libraryId !== repository.scope.libraryId || root.id !== documentId || root.kind !== expected)
      throw new Error('unsupported-library-content');
    return expected;
  };
  try { return await resolve(); }
  catch { check(); await refresh(); check(); return resolve(); }
}
