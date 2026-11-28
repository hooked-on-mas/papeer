import { EDIT_LIMITS, type DocumentSnapshot, type Page, type PageAnnotation } from '../runtime/edits/contracts.ts';
import { assertSnapshot } from '../runtime/edits/editModel.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { migrationStableId } from './stableId.ts';
import { convertLegacyAnnotationsPage } from './legacyAnnotations.ts';
import type { MigrationIdMapping } from './legacyPage.ts';
import { resourceSource, stagingFail, type IdEntry, type NotConverted, type PaperRow, type PdfRow, type ProvenanceRow, type ResourceDescriptor } from './legacyStagingInput.ts';

// One legacy PDF item -> one DocumentSnapshot (work B7-e, DESIGN-r161-b7-staging.md 7.3 item 1).
//
// What is converted, and the evidence for it (IMPL-r161-b7e.md section 1):
//  - The PDF itself is NOT copied here: the page background names the resource (`resourceId`, `sourceRevision` = the PDF's sha256,
//    `pdfPage` = n). The writer stores the verified original.pdf bytes as that resource.
//  - Page n of the document is page n of original.pdf, with the width and height of the resource's `pdfPages[n-1]`
//    (PyMuPDF `page.rect`, i.e. the DISPLAYED page: papeer/core/edit_repository.py:431). The legacy ink, highlight and sticky-note
//    coordinates are fractions of that same displayed page (papeer/pdf/pdf_ink.py:35-49,68-77; papeer/core/ink.py:23), and the existing
//    converters (legacyInk.ts, legacyBookmarks.ts) multiply them by the page's widthPt/heightPt.
//  - Only the ORIGINAL side's ink and bookmarks are converted. A translated side (`side != 'original'`) has no binding in the canonical model,
//    so those rows are counted and left as a residual reason (`pdf-annotation-not-converted`), never converted.
//  - Annotations are all-or-nothing for one PDF. When anything about them cannot be verified (a Web annotation ledger exists, a page is out of
//    range, a stroke list is unreadable, a page does not convert) NO annotation of this PDF is converted: the document is still staged with its pages,
//    and the reason is reported. A half-annotated document is never produced.
//  - `web_annotation_ops` (REVIEW-r161-b7a low 8-(c)): papeer/core/cloud_drive.py:186-202 keeps a Web stroke off a replaced PDF by comparing the
//    stroke's source_sha256 with the PDF's sha256; the PC and the extractor use pdf_ink as it is. This converter is told how many ledger rows
//    the Library has (`webAnnotationOpsRows`). If it is not 0 it cannot tell a PC stroke from a Web stroke, so a PDF that has ink rows gets none of
//    its annotations converted (`pdf-annotation-web-ops-present`). The ledger only ever holds strokes (cloud_drive.py:186 reads op["stroke"]), so a
//    PDF with sticky notes and highlights only is unaffected. Zero rows means the Web filter is a no-op in the legacy code, so converting is exact.
export const PDF_PAGE_LIMIT = EDIT_LIMITS.pages;

/** Reasons a whole PDF is not converted (closed set). */
export const PDF_BLOCKED = ['pdf-file-missing', 'pdf-file-hash-mismatch', 'pdf-resource-missing', 'pdf-page-count-mismatch', 'pdf-page-rows-not-contiguous',
  'pdf-page-limit'] as const;
/** Reasons the annotations of an otherwise converted PDF are not converted (closed set). */
export const PDF_ANNOTATION_WITHHELD = ['pdf-annotation-web-ops-present', 'pdf-annotation-unmapped', 'pdf-annotation-unreadable', 'pdf-annotation-conversion-failed'] as const;

export type PdfAnnotations = { status: 'converted'; ink: number; sticky: number; highlight: number; inkRows: number; bookmarkRows: number }
  | { status: 'not-converted'; reason: (typeof PDF_ANNOTATION_WITHHELD)[number]; inkRows: number; bookmarkRows: number };
export type PdfConversion =
  | { status: 'converted'; sourceId: string; document: DocumentSnapshot; resource: ResourceDescriptor; annotations: PdfAnnotations;
      translatedRows: number; pageTextRows: number; ids: IdEntry[]; provenance: ProvenanceRow[]; notConverted: NotConverted[] }
  | { status: 'blocked'; sourceId: string; reason: (typeof PDF_BLOCKED)[number] };

const blocked = (sourceId: string, reason: (typeof PDF_BLOCKED)[number]): PdfConversion => ({ status: 'blocked', sourceId, reason });
const idCompare = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** Check that the descriptor the writer handed over is exactly the resource of this PDF (never trusts the writer's ID). */
export async function checkResource(libraryId: string, descriptor: ResourceDescriptor): Promise<void> {
  const expected = await migrationStableId(libraryId, 'resource', resourceSource(descriptor));
  if (descriptor.resourceId !== expected) stagingFail('staging-conversion-resource-mismatch');
}

type PdfInput = { libraryId: string; item: PaperRow; pdf: PdfRow; resources: readonly ResourceDescriptor[]; webAnnotationOpsRows: number };

export async function convertLegacyPdf(input: PdfInput): Promise<PdfConversion> {
  const first = await build(input, null);
  // A page that does not convert (an invalid stroke, a bookmark the converter refuses) withholds the annotations of the WHOLE PDF.
  return first === 'annotation-failed' ? await build(input, 'pdf-annotation-conversion-failed') as PdfConversion : first;
}

async function build(input: PdfInput, forced: 'pdf-annotation-conversion-failed' | null): Promise<PdfConversion | 'annotation-failed'> {
  const { libraryId, item, pdf } = input, paperId = pdf.id;
  if (item.id !== paperId || item.kind !== 'pdf') stagingFail('staging-conversion-input-mismatch');
  const file = pdf.file;
  if (file === null) return blocked(paperId, 'pdf-file-missing');
  if (pdf.fileMatchesRow !== true || item.columns.sha256 !== file.sha256) return blocked(paperId, 'pdf-file-hash-mismatch');
  const key = ['papers', paperId, 'original.pdf'];
  const resource = input.resources.find(entry => entry.kind === 'pdf' && entry.sourceKey.join('\0') === key.join('\0'));
  if (!resource || !resource.pdfPages) return blocked(paperId, 'pdf-resource-missing');
  // The descriptor must be this very file: a mismatch is a writer/manifest inconsistency, not a property of the PDF.
  if (resource.sha256 !== file.sha256 || resource.byteLength !== file.byteLength || resource.mediaType !== 'application/pdf') stagingFail('staging-conversion-resource-mismatch');
  await checkResource(libraryId, resource);
  const sizes = resource.pdfPages, total = sizes.length;
  if (pdf.pagesColumn !== total || pdf.counts.pageRows !== total || pdf.problems.includes('pdf-page-count-mismatch')) return blocked(paperId, 'pdf-page-count-mismatch');
  if (!pdf.counts.pageNumbersContiguous || pdf.problems.includes('pdf-page-rows-not-contiguous')
    || pdf.pageNumbers.length !== total || pdf.pageNumbers.some((number, index) => number !== index + 1)) return blocked(paperId, 'pdf-page-rows-not-contiguous');
  if (total > PDF_PAGE_LIMIT) return blocked(paperId, 'pdf-page-limit');

  // ---- the rows, checked against the independent counts of work B7-d ---------------------------------------------------
  const inkOriginal = pdf.inkRows.filter(row => row.side === 'original'), inkOther = pdf.inkRows.filter(row => row.side !== 'original');
  const marksOriginal = pdf.bookmarkRows.filter(row => row.side === 'original');
  const kindOf = (kind: string): 'note' | 'highlight' | 'other' => kind === 'note' || kind === 'highlight' ? kind : 'other';
  const sideOf = (side: string): 'original' | 'other' => side === 'original' ? 'original' : 'other';
  // A stroke list that is shorter or longer than its own SQL-counted length is an inconsistent input, not a PDF problem.
  if (inkOriginal.some(row => Array.isArray(row.strokes) && row.strokes.length !== row.strokeCount)) stagingFail('staging-conversion-input-mismatch');
  const inkStrokes = inkOriginal.reduce((sum, row) => sum + (row.strokeCount ?? 0), 0);
  const otherStrokes = inkOther.reduce((sum, row) => sum + (row.strokeCount ?? 0), 0);
  const marks = { note: { original: 0, other: 0 }, highlight: { original: 0, other: 0 }, other: { original: 0, other: 0 } };
  for (const row of pdf.bookmarkRows) marks[kindOf(row.kind)][sideOf(row.side)]++;
  const counts = pdf.counts;
  if (inkOriginal.length !== counts.ink.original || inkOther.length !== counts.ink.other || inkStrokes !== counts.strokes.original
    || otherStrokes !== counts.strokes.other || JSON.stringify(marks) !== JSON.stringify(counts.bookmarks)) stagingFail('staging-conversion-input-mismatch');
  const translatedRows = counts.ink.other + counts.bookmarks.note.other + counts.bookmarks.highlight.other + counts.bookmarks.other.other;

  // ---- decide whether the annotations can be converted at all --------------------------------------------------------------
  const inkRows = inkOriginal.length, bookmarkRows = marksOriginal.length;
  const inRange = (page: number | null) => page !== null && page >= 1 && page <= total;
  let withheld: (typeof PDF_ANNOTATION_WITHHELD)[number] | null = forced;
  if (forced === null && inkRows + bookmarkRows) {
    if (inkOriginal.some(row => !inRange(row.page)) || marksOriginal.some(row => !inRange(row.page)) || pdf.problems.includes('pdf-annotation-unmapped')) withheld = 'pdf-annotation-unmapped';
    else if (inkOriginal.some(row => !Array.isArray(row.strokes) || row.strokeCount === null) || pdf.problems.includes('pdf-annotation-unreadable')) withheld = 'pdf-annotation-unreadable';
    else if (input.webAnnotationOpsRows > 0 && inkRows > 0) withheld = 'pdf-annotation-web-ops-present';
  }
  const strokesOf = (page: number) => (inkOriginal.find(row => row.page === page)?.strokes ?? []) as unknown[];
  const marksOf = (page: number) => marksOriginal.filter(row => row.page === page).map(row => row.record!).sort((a, b) => idCompare(String(a.id), String(b.id)));
  if (new Set(inkOriginal.map(row => row.page)).size !== inkOriginal.length) stagingFail('staging-conversion-input-mismatch');   // PRIMARY KEY (paper_id, side, page)

  // ---- ids ---------------------------------------------------------------------------------------------------------------------
  const ids: IdEntry[] = [];
  const stable = async (kind: string, source: string[]) => { const targetId = await migrationStableId(libraryId, kind, source); ids.push({ kind, source, targetId }); return targetId; };
  const documentId = await stable('pdf-document', [paperId]);
  const annotationData = withheld === null
    ? { ink: inkOriginal.map(row => [row.page, row.strokes]).sort((a, b) => (a[0] as number) - (b[0] as number)), bookmarks: marksOriginal.map(row => row.record!).sort((a, b) => idCompare(String(a.id), String(b.id))) }
    : { withheld };
  const annotationDataSha256 = await editContentHash(annotationData);
  const version = await stable('pdf-revision', [paperId, file.sha256, annotationDataSha256]);

  // ---- pages --------------------------------------------------------------------------------------------------------------------
  const pages: Page[] = [], provenance: ProvenanceRow[] = [], mappings: MigrationIdMapping[] = [];
  const totals = { ink: 0, sticky: 0, highlight: 0 };
  for (let number = 1; number <= total; number++) {
    const pageId = await stable('pdf-page', [paperId, String(number)]);
    const page: Page = { id: pageId, backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
      widthPt: sizes[number - 1].widthPt, heightPt: sizes[number - 1].heightPt,
      background: { kind: 'pdf', resourceId: resource.resourceId, sourceRevision: file.sha256, pdfPage: number }, annotations: [] };
    let converted = page;
    if (withheld === null && (strokesOf(number).length || marksOf(number).length || inkOriginal.some(row => row.page === number))) {
      const result = await convertLegacyAnnotationsPage(page, strokesOf(number), marksOf(number), {
        libraryId, documentId, sourceDocumentId: paperId, side: 'original', sourcePageId: String(number), sourcePageNumber: number, sourceRevision: file.sha256 });
      if (result.status !== 'converted') return 'annotation-failed';
      converted = result.page; mappings.push(...result.mappings);
      const byKind = (kind: PageAnnotation['kind']) => converted.annotations.filter(annotation => annotation.kind === kind).length;
      const strokes = strokesOf(number).length, notes = marksOf(number).filter(row => row.kind === 'note').length, highlights = marksOf(number).filter(row => row.kind === 'highlight').length;
      if (byKind('ink') !== strokes || byKind('sticky') !== notes || byKind('highlight') !== highlights || converted.annotations.length !== strokes + notes + highlights) stagingFail('staging-conversion-count-mismatch');
      totals.ink += strokes; totals.sticky += notes; totals.highlight += highlights;
    }
    pages.push(converted);
  }
  const document: DocumentSnapshot = { kind: 'document', id: documentId, version, pages, deletedPages: [] };
  assertSnapshot(document);

  // ---- provenance --------------------------------------------------------------------------------------------------------------
  provenance.push({ targetKind: 'document', targetId: documentId, sourceKind: 'file', sourceKey: key, sourceSha256: file.sha256 });
  if (withheld === null && Object.keys(pdf.annotationPages).length !== new Set([...inkOriginal, ...marksOriginal].map(row => row.page)).size) stagingFail('staging-conversion-input-mismatch');
  for (let number = 1; number <= total; number++) {
    const rowsOfPage = [...inkOriginal.filter(row => row.page === number), ...marksOriginal.filter(row => row.page === number)];
    if (withheld === null && rowsOfPage.length) {
      const sourceSha256 = await editContentHash(rowsOfPage.map(row => row.sourceSha256!).sort());
      const reported = pdf.annotationPages[String(number)];
      if (!reported || reported.rowCount !== rowsOfPage.length || reported.sourceSha256 !== sourceSha256) stagingFail('staging-conversion-input-mismatch');
      provenance.push({ targetKind: 'page', targetId: pages[number - 1].id, sourceKind: 'rows', sourceKey: ['rows', paperId, 'original', String(number)], sourceSha256 });
    } else provenance.push({ targetKind: 'page', targetId: pages[number - 1].id, sourceKind: 'file', sourceKey: key, sourceSha256: file.sha256 });
  }
  for (const mapping of mappings) {
    ids.push({ kind: mapping.kind, source: mapping.source, targetId: mapping.targetId });
    provenance.push({ targetKind: 'annotation', targetId: mapping.targetId, sourceKind: 'row', sourceKey: mapping.source, sourceSha256: mapping.sourceFingerprint });
  }

  const notConverted: NotConverted[] = [];
  if (withheld !== null) notConverted.push({ sourceKey: ['papers', paperId], kind: 'pdf-annotation', reason: withheld, residual: 'pdf-annotation-not-converted', count: inkRows + bookmarkRows });
  if (translatedRows) notConverted.push({ sourceKey: ['papers', paperId], kind: 'pdf-annotation', reason: 'pdf-annotation-translated-side', residual: 'pdf-annotation-not-converted', count: translatedRows });
  return { status: 'converted', sourceId: paperId, document, resource, translatedRows, pageTextRows: counts.pageTextRows, ids, provenance, notConverted,
    annotations: withheld === null ? { status: 'converted', ...totals, inkRows, bookmarkRows } : { status: 'not-converted', reason: withheld, inkRows, bookmarkRows } };
}
