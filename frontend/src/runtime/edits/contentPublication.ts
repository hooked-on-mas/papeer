import { validateContentPublication, validateResourceMetadata, type ContentPublication, type EditBatch, type LibraryItem, type ResourceMetadata, type Snapshot } from './contracts.ts';
import { assertBatch, assertSnapshot, EditRejected } from './editModel.ts';
import { allDocumentPages } from './documentPages.ts';

const reject = (reason: string): never => { throw new EditRejected(reason); };
export function publicationItem(value: ContentPublication): LibraryItem {
  validateContentPublication(value); assertBatch(value.libraryBatch);
  const items = value.libraryBatch.changes.filter(change => change.type === 'put-item');
  if (items.length !== 1 || value.libraryBatch.changes.some(change => change.type !== 'put-item' && change.type !== 'add-link')) reject('publication-changes');
  const item = items[0].item;
  if (value.content) {
    assertSnapshot(value.content);
    if (value.content.id !== item.id || (item.kind === 'markdown' ? value.content.kind !== 'markdown'
      : !['pdf', 'notebook'].includes(item.kind) || value.content.kind !== 'document')) reject('publication-content-kind');
  } else if (item.kind !== 'attachment') reject('publication-content-required');
  if ((item.kind === 'pdf' || item.kind === 'attachment') && !item.resourceId) reject('publication-resource-required');
  return item;
}

export function assertResourceMetadata(value: unknown): asserts value is ResourceMetadata {
  validateResourceMetadata(value);
  if ((value.mediaType === 'application/pdf') !== !!value.pdfPages) reject('resource-pdf-metadata');
}

export async function resourceHash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Preserve the publisher's canonical numbers after independently inspecting the same bytes.
 * PDF.js/PyMuPDF can differ below a millipoint; this never trusts unverified dimensions. */
export function inspectedResource(computed: ResourceMetadata, expected?: ResourceMetadata): ResourceMetadata {
  assertResourceMetadata(computed);
  if (!expected) return computed;
  assertResourceMetadata(expected);
  if (computed.id !== expected.id || computed.sha256 !== expected.sha256 || computed.mediaType !== expected.mediaType
    || computed.byteLength !== expected.byteLength || computed.pdfPages?.length !== expected.pdfPages?.length
    || computed.pdfPages?.some((page, index) => Math.abs(page.widthPt - expected.pdfPages![index].widthPt) > .001
      || Math.abs(page.heightPt - expected.pdfPages![index].heightPt) > .001)) reject('resource-inspection-mismatch');
  return structuredClone(expected);
}

export function snapshotResourceIds(snapshot: Snapshot): string[] {
  return [...new Set(snapshot.kind === 'document'
    ? allDocumentPages(snapshot).flatMap(page => page.background.kind === 'pdf' ? [page.background.resourceId] : [])
    : snapshot.kind === 'library' ? snapshot.items.flatMap(item => item.resourceId ? [item.resourceId] : [])
      : snapshot.imageResources.map(image => image.resourceId))];
}
export function publicationResourceIds(publication: ContentPublication): string[] {
  const item = publicationItem(publication);
  return [...new Set([...(item.resourceId ? [item.resourceId] : []), ...(publication.content ? snapshotResourceIds(publication.content) : [])])];
}
export function batchResourceIds(batch: EditBatch): string[] {
  if (batch.kind === 'markdown') return [...new Set(batch.imageResources.map(image => image.resourceId))];
  if (batch.kind === 'resolution') return snapshotResourceIds(batch.snapshot);
  if (batch.kind === 'document') return [...new Set(batch.changes.flatMap(change => change.type === 'translation'
    ? change.translation?.pages.flatMap(page => page.background.kind === 'pdf' ? [page.background.resourceId] : []) ?? []
    : (change.type === 'insert' || change.type === 'replace') && change.page.background.kind === 'pdf' ? [change.page.background.resourceId] : []))];
  if (batch.kind === 'library') return [...new Set(batch.changes.flatMap(change => change.type === 'put-item' && change.item.resourceId ? [change.item.resourceId] : []))];
  return [];
}

/** A concrete MIME subtype, without wildcard or parameters. */
export function isImageMediaType(value: string): boolean {
  return /^image\/[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(value) && value === value.trim() && value.toLowerCase() !== 'image/*';
}

/** Stored PDF dimensions are inspected from bytes, never supplied by the publishing client. */
export async function assertResourceBindings(snapshot: Snapshot, resource: (id: string) => Promise<ResourceMetadata | undefined>): Promise<void> {
  const metadataById = new Map<string, ResourceMetadata | undefined>();
  const lookup = async (id: string) => {
    if (!metadataById.has(id)) metadataById.set(id, await resource(id));
    return metadataById.get(id);
  };
  if (snapshot.kind === 'document') for (const page of allDocumentPages(snapshot)) {
    if (page.background.kind !== 'pdf') continue;
    const background = page.background, metadata = await lookup(background.resourceId);
    const physical = metadata?.pdfPages?.[background.pdfPage - 1];
    if (!metadata || metadata.mediaType !== 'application/pdf' || metadata.sha256 !== background.sourceRevision || !physical) reject('missing-or-stale-resource');
    if (Math.abs(physical!.widthPt - page.widthPt) > .001 || Math.abs(physical!.heightPt - page.heightPt) > .001) reject('resource-page-dimensions');
  }
  if (snapshot.kind === 'library') for (const item of snapshot.items) {
    if (item.resourceId && !await lookup(item.resourceId)) reject('missing-resource');
  }
  if (snapshot.kind === 'markdown') for (const image of snapshot.imageResources) {
    const metadata = await lookup(image.resourceId);
    if (!metadata || metadata.id !== image.resourceId || metadata.sha256 !== image.sha256 || !isImageMediaType(metadata.mediaType))
      reject('missing-or-stale-image-resource');
  }
}
