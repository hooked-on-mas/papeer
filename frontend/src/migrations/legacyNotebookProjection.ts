import type { DocumentSnapshot, Page, PaperSpec } from '../runtime/edits/contracts.ts';
import { assertSnapshot } from '../runtime/edits/editModel.ts';
import { resourceHash } from '../runtime/edits/contentPublication.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { migrationStableId } from './stableId.ts';
import { convertLegacyAnnotationsPage } from './legacyAnnotations.ts';
import type { MigrationIdMapping } from './legacyPage.ts';

// Pure projection only. Caller must independently obtain the entry and annotation
// rows from a verified immutable backup; this function does not issue that authority.
// JSON.parse intentionally matches the legacy Python json.loads last-key-wins behavior;
// raw bytes remain in the immutable backup. This projection is not a raw restore.
type SourcePage = {
  id: string; size: string; orientation: string; width_mm: number; height_mm: number;
  template: PaperSpec['template']; color: PaperSpec['color'];
};
type SourceNotebook = { version: 1; revision: number; pages: SourcePage[] };
type PageAnnotations = { pageId: string; ink: unknown; bookmarks: unknown };
const sizes: Record<string, readonly [number, number]> = {
  A4: [210, 297], B5: [182, 257], A5: [148, 210], Letter: [215.9, 279.4], '16:9': [180, 320],
};
const templates = new Set(['blank','ruled7','ruled6','ruled5','grid5','grid10','dot5','cornell']);
const colors = new Set(['white','cream','dark']);
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join('|') === [...expected].sort().join('|');
export async function projectLegacyNotebookEntry(input: {
  libraryId: string; sourceDocumentId: string;
  entry: { sha256: string; byteLength: number }; bytes: Uint8Array; annotations: PageAnnotations[];
}): Promise<{
  document: DocumentSnapshot; pageMappings: { sourcePageId: string; targetPageId: string }[];
  mappings: MigrationIdMapping[];
  provenance: { sourceDocumentId: string; notebookSha256: string; annotationDataSha256: string; revision: number };
  incomplete: readonly ['library-metadata', 'other-source-coverage', 'publication-and-activation'];
}> {
 const stable = structuredClone(input);
  if (!/^[0-9a-f]{32}$/.test(stable.sourceDocumentId) || !/^[0-9a-f]{64}$/.test(stable.entry.sha256)
    || stable.bytes.byteLength !== stable.entry.byteLength || await resourceHash(stable.bytes) !== stable.entry.sha256) {
    throw new Error('notebook-entry-mismatch');
  }
 let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stable.bytes)); } catch { throw new Error('notebook-json-invalid'); }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !keys(parsed, ['version','revision','pages'])) throw new Error('notebook-shape-unsupported');
 const notebook = parsed as SourceNotebook;
 if (notebook.version !== 1 || !Number.isSafeInteger(notebook.revision) || notebook.revision < 1 || !Array.isArray(notebook.pages) || !notebook.pages.length || !Array.isArray(stable.annotations) || stable.annotations.length !== notebook.pages.length) throw new Error('notebook-shape-unsupported');
  // Validate the exact records consumed by the converter before hashing them.
  // In particular, arrays can have enumerable named properties which the
  // canonical array hash does not include.
  for (const [index, annotation] of stable.annotations.entries()) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)
      || !keys(annotation, ['pageId', 'ink', 'bookmarks'])
      || annotation.pageId !== notebook.pages[index]?.id
      || !Array.isArray(annotation.ink) || !Array.isArray(annotation.bookmarks)) {
      throw new Error('notebook-annotation-coverage-unsupported');
    }
  }
 const documentId = await migrationStableId(stable.libraryId, 'notebook-document', [stable.sourceDocumentId]);
 const annotationDataSha256 = await editContentHash(stable.annotations);
 const version = await migrationStableId(stable.libraryId, 'notebook-revision', [stable.sourceDocumentId, String(notebook.revision), stable.entry.sha256, annotationDataSha256]);
 const ids = new Set<string>(), pages: Page[] = [], pageMappings: { sourcePageId: string; targetPageId: string }[] = [], mappings: MigrationIdMapping[] = [];
 for (const [index, value] of notebook.pages.entries()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !keys(value, ['id','size','orientation','width_mm','height_mm','template','color'])
    || !/^[0-9a-f]{32}$/.test(value.id) || ids.has(value.id) || !Object.prototype.hasOwnProperty.call(sizes, value.size)
    || !['portrait','landscape'].includes(value.orientation) || !templates.has(value.template) || !colors.has(value.color)) {
    throw new Error('notebook-page-unsupported');
  }
  ids.add(value.id); const dims = sizes[value.size], expected = value.orientation === 'portrait' ? dims : [dims[1],dims[0]];
  if (value.width_mm !== expected[0] || value.height_mm !== expected[1]) throw new Error('notebook-geometry-unsupported');
  const annotation = stable.annotations[index];
  const pageId = await migrationStableId(stable.libraryId, 'notebook-page', [stable.sourceDocumentId,value.id]);
  const page: Page = {
    id: pageId, backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
    widthPt: value.width_mm * 72 / 25.4, heightPt: value.height_mm * 72 / 25.4,
    background: { kind: 'paper', spec: { template: value.template, color: value.color } }, annotations: [],
  };
  const converted = await convertLegacyAnnotationsPage(page, annotation.ink, annotation.bookmarks, {
    libraryId: stable.libraryId, documentId, sourceDocumentId: stable.sourceDocumentId,
    side: 'original', sourcePageId: value.id, sourcePageNumber: index + 1, sourceRevision: null,
  });
  if (converted.status !== 'converted') throw new Error('notebook-annotation-unsupported');
  pages.push(converted.page); pageMappings.push({ sourcePageId: value.id, targetPageId: pageId }); mappings.push(...converted.mappings);
 }
 const document: DocumentSnapshot = { kind: 'document', id: documentId, version, pages, deletedPages: [] }; assertSnapshot(document);
 return { document, pageMappings, mappings, provenance: { sourceDocumentId: stable.sourceDocumentId, notebookSha256: stable.entry.sha256, annotationDataSha256, revision: notebook.revision }, incomplete: ['library-metadata','other-source-coverage','publication-and-activation'] };
}
