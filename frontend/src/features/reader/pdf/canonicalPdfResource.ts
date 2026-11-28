import type { Page, ResourceMetadata } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository, EditScope, StoredResource } from '../../../runtime/edits/ports.ts';
import { assertResourceMetadata, resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';

export type CanonicalPdfResourceBinding = Readonly<{
  scope: Readonly<EditScope>; pageId: string; backgroundRevision: string;
  resourceId: string; sourceRevision: string; pdfPage: number; widthPt: number; heightPt: number;
}>;

export type CanonicalPdfResourceIdentity = Pick<CanonicalPdfResourceBinding, 'scope' | 'resourceId' | 'sourceRevision'>;

/** A page binding is published only against locally verified resource bytes. */
export type CanonicalPdfAsset = Readonly<{
  binding: CanonicalPdfResourceBinding; url: string; metadata: Readonly<ResourceMetadata>;
}>;

/** The schema and publication contract define sourceRevision as the immutable PDF bytes' SHA-256. */
export function canonicalPdfResourceBinding(scope: EditScope, page: Page): CanonicalPdfResourceBinding {
  if (page.background.kind !== 'pdf') throw new Error('pdf-resource-required');
  const { resourceId, sourceRevision, pdfPage } = page.background;
  if (!Number.isSafeInteger(pdfPage) || pdfPage < 1 || !/^[a-f0-9]{64}$/.test(sourceRevision)
    || ![page.widthPt, page.heightPt].every(value => Number.isFinite(value) && value > 0)) throw new Error('pdf-page-invalid');
  return Object.freeze({ scope: Object.freeze({ ...scope }), pageId: page.id, backgroundRevision: page.backgroundRevision,
    resourceId, sourceRevision, pdfPage, widthPt: page.widthPt, heightPt: page.heightPt });
}

/** Shared descriptor validation for captured and read-only PDF pages. No renderer or host APIs are acquired. */
function assertCanonicalPdfResourceIdentity(binding: CanonicalPdfResourceIdentity, metadata: ResourceMetadata, byteLength: number): void {
  assertResourceMetadata(metadata);
  if (!/^[a-f0-9]{64}$/.test(binding.sourceRevision)
    || metadata.id !== binding.resourceId || metadata.sha256 !== binding.sourceRevision || metadata.mediaType !== 'application/pdf'
    || metadata.byteLength !== byteLength) throw new Error('pdf-resource-mismatch');
}

export function assertCanonicalPdfResource(binding: CanonicalPdfResourceBinding, metadata: ResourceMetadata, byteLength: number): void {
  assertCanonicalPdfResourceIdentity(binding, metadata, byteLength);
  const physical = metadata.pdfPages?.[binding.pdfPage - 1];
  if (!Number.isSafeInteger(binding.pdfPage) || binding.pdfPage < 1 || !physical
    || ![binding.widthPt, binding.heightPt].every(value => Number.isFinite(value) && value > 0)
    || Math.abs(physical.widthPt - binding.widthPt) > .001 || Math.abs(physical.heightPt - binding.heightPt) > .001)
    throw new Error('pdf-page-mismatch');
}

/** Inspect the same PDF instance the caller is drawing; this never loads a PDF. */
export function assertCanonicalPdfDocument(binding: CanonicalPdfResourceBinding, metadata: ResourceMetadata, numPages: number): void {
  assertCanonicalPdfResource(binding, metadata, metadata.byteLength);
  if (!Number.isSafeInteger(numPages) || numPages < 1 || numPages !== metadata.pdfPages?.length
    || binding.pdfPage > numPages) throw new Error('pdf-document-inspection-mismatch');
}

export function assertCanonicalPdfPage(binding: CanonicalPdfResourceBinding, actual: {
  pageNumber: number; getViewport(options: { scale: number }): { width: number; height: number };
}): void {
  const natural = actual.getViewport({ scale: 1 });
  if (!Number.isSafeInteger(binding.pdfPage) || binding.pdfPage < 1 || actual.pageNumber !== binding.pdfPage
    || ![binding.widthPt, binding.heightPt, natural.width, natural.height].every(value => Number.isFinite(value) && value > 0)
    || Math.abs(natural.width - binding.widthPt) > .001 || Math.abs(natural.height - binding.heightPt) > .001)
    throw new Error('pdf-page-inspection-mismatch');
}

/** One resource read/hash policy, independent of the currently requested page.
 * A bad page descriptor must not poison otherwise verified immutable PDF bytes. */
export async function readCanonicalPdfResourceBytes(binding: CanonicalPdfResourceIdentity,
  resources: Pick<ContentRepository, 'scope' | 'readResource'>): Promise<StoredResource> {
  // Copy even a caller-supplied binding before yielding; a mutable page cannot redirect an in-flight read.
  const fixed = structuredClone(binding);
  const checkScope = () => {
    if (canonicalJson(resources.scope) !== canonicalJson(fixed.scope)) throw new Error('pdf-resource-scope');
  };
  checkScope();
  const resource = await resources.readResource(fixed.resourceId); checkScope();
  if (!resource) throw new Error('pdf-resource-missing');
  const bytes = Uint8Array.from(resource.bytes), metadata = structuredClone(resource.metadata);
  assertCanonicalPdfResourceIdentity(fixed, metadata, bytes.length);
  const hash = await resourceHash(bytes); checkScope();
  if (hash !== fixed.sourceRevision) throw new Error('pdf-resource-hash');
  return { bytes, metadata };
}

/** Read a fixed page binding, preserving full validation for capture and preview. */
export async function readCanonicalPdfResource(binding: CanonicalPdfResourceBinding,
  resources: Pick<ContentRepository, 'scope' | 'readResource'>): Promise<StoredResource> {
  const fixed = structuredClone(binding);
  const resource = await readCanonicalPdfResourceBytes(fixed, resources);
  assertCanonicalPdfResource(fixed, resource.metadata, resource.bytes.length);
  return resource;
}
