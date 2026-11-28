import type { ContentRepository } from '../../runtime/edits/ports.ts';
import { validateResourceMetadata } from '../../runtime/edits/contracts.ts';
import { EditGraph } from '../../runtime/edits/editGraph.ts';
import { resourceHash } from '../../runtime/edits/contentPublication.ts';

/** An attachment has a catalog/resource identity, never a document or Markdown DAG. */
export async function readAttachmentResource(repository: Pick<ContentRepository, 'scope' | 'read' | 'readResource'>,
  id: string, catalogVersion?: string) {
  const catalog = await repository.read(repository.scope.libraryId);
  const version = catalogVersion ?? (catalog.heads.length === 1 ? catalog.heads[0] : undefined);
  if (!version || !catalog.heads.includes(version)) throw new Error('catalog-head-unavailable');
  const library = new EditGraph(catalog.checkpoint).snapshot(version);
  if (catalog.checkpoint.libraryId !== repository.scope.libraryId || library?.kind !== 'library' || library.id !== repository.scope.libraryId)
    throw new Error('attachment-catalog-invalid');
  const item = library.items.find(value => value.id === id);
  if (item?.kind !== 'attachment' || !item.resourceId) throw new Error('attachment-missing');
  const resource = await repository.readResource(item.resourceId);
  if (!resource) throw new Error('attachment-resource-missing');
  validateResourceMetadata(resource.metadata);
  if (resource.metadata.id !== item.resourceId || resource.metadata.byteLength !== resource.bytes.byteLength
    || resource.metadata.sha256 !== await resourceHash(resource.bytes)) throw new Error('attachment-resource-invalid');
  return { item: structuredClone(item), resource, deleted: library.deletions.some(record => record.active && record.itemIds.includes(id)) };
}

export function attachmentText(mediaType: string, title: string, bytes: Uint8Array): string | null {
  const mime = mediaType.split(';')[0].trim().toLowerCase();
  return mime.startsWith('text/') || ['application/json', 'application/xml', 'application/xhtml+xml', 'application/javascript'].includes(mime)
    || /\.(md|markdown|txt|html?|css|csv|json|xml|log)$/i.test(title)
    ? new TextDecoder().decode(bytes) : null;
}
