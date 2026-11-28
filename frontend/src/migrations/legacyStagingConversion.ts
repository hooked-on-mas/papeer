import type { DocumentSnapshot, MarkdownSnapshot, LibrarySnapshot } from '../runtime/edits/contracts.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { assertConversionInputManifest, projectConversionInputNotebooks, type ConversionInputManifest, type NotebookExtraction } from './legacyConversionInput.ts';
import { migrationStableId } from './stableId.ts';
import { convertLegacyPdf } from './legacyPdfDocument.ts';
import { convertLegacyMarkdown } from './legacyMarkdown.ts';
import { buildLegacyLibrary, type ContentRef } from './legacyLibrary.ts';
import {
  assertIdTable, assertProvenanceTable, assertResourceDescriptors, assertStagingRows, count, resourceSource, stagingFail, STAGING_CONVERTER_VERSION, STAGING_PLAN_SCOPE,
  type IdEntry, type MarkdownImagePort, type NotConverted, type ProvenanceRow, type ResourceDescriptor, type ResourceUse, type StagingRows,
} from './legacyStagingInput.ts';

// The whole staging conversion (work B7-e, DESIGN-r161-b7-staging.md 7.3 item 5): Notebook (the existing converter, unchanged), PDF, Markdown and the
// Library structure, put together into ONE plan. Pure: no I/O, no clock, no random source. The writer (work B7-f) does not trust this plan: it checks
// every unit against its own independent counts, the ID table and the provenance, and reads the stored result back.
//
// The plan is the same whatever order the rows, resources and Notebooks arrive in: everything is sorted by ID, and every ID comes from
// migrationStableId (it does not depend on the run, the epoch or any random value).
export { STAGING_CONVERTER_VERSION, STAGING_PLAN_SCOPE };

export type PlanUnit = {
  seq: number; unitKind: 'document' | 'markdown' | 'library'; sourceKind: 'pdf' | 'notebook' | 'markdown' | 'library'; targetId: string;
  payload: DocumentSnapshot | MarkdownSnapshot | LibrarySnapshot; payloadSha256: string;
};
export type StagingPlan = {
  version: 1; scope: typeof STAGING_PLAN_SCOPE; converterVersion: typeof STAGING_CONVERTER_VERSION; libraryId: string; manifestSha256: string;
  units: PlanUnit[]; resources: ResourceUse[]; unusedResources: string[]; ids: IdEntry[]; provenance: ProvenanceRow[]; notConverted: NotConverted[];
  residualReasons: string[];
  coverage: { sourceKey: string[]; kind: 'pdf' | 'notebook' | 'markdown'; status: 'converted' | 'blocked' | 'not-in-library'; reason: string | null;
    pages: number; ink: number; sticky: number; highlight: number; images: number }[];
  counts: { items: number; folders: number; links: number; tags: number; documents: { pdf: number; notebook: number }; markdown: number; pages: number;
    ink: number; sticky: number; highlight: number; resources: number; images: number };
  derived: string[]; wholeLibrary: { status: 'refused'; reasons: readonly string[] };
  planSha256: string;
};
export type StagingConversionInput = { manifest: unknown; extractions: ReadonlyMap<string, NotebookExtraction>; rows: unknown; resources: unknown; webAnnotationOpsRows: unknown;
  /** The product's Markdown parser (see MarkdownImagePort): the converters themselves import no Markdown package. */
  markdownImages: MarkdownImagePort };

type Bundle = {
  paperId: string; kind: 'pdf' | 'notebook' | 'markdown'; contentId: string; unitKind: 'document' | 'markdown'; payload: DocumentSnapshot | MarkdownSnapshot;
  resources: ResourceDescriptor[]; resourceId?: string; ids: IdEntry[]; provenance: ProvenanceRow[]; notConverted: NotConverted[];
  stats: { pages: number; ink: number; sticky: number; highlight: number; images: number }; pageTextRows: number;
};
const UNIT_ORDER = { document: 0, markdown: 1, library: 2 } as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;       // IDs are ASCII (hex and dashes)
const MARKDOWN_MEDIA_RESIDUAL = /^markdown-media-/;

export async function buildStagingPlan(input: StagingConversionInput): Promise<StagingPlan> {
  // Everything is captured before the first await: later changes by the caller cannot enter the conversion.
  let manifestValue: unknown, rowsValue: unknown, resourcesValue: unknown, opsValue: unknown, extractions: Map<string, NotebookExtraction>;
  try {
    manifestValue = structuredClone(input.manifest); rowsValue = structuredClone(input.rows); resourcesValue = structuredClone(input.resources);
    opsValue = structuredClone(input.webAnnotationOpsRows); extractions = new Map(structuredClone([...input.extractions]));
  } catch { return stagingFail('staging-conversion-input-invalid'); }
  const projected = await projectConversionInputNotebooks(manifestValue, extractions);        // manifest, seal, entries and counts (B6, unchanged)
  assertConversionInputManifest(manifestValue);
  const manifest: ConversionInputManifest = manifestValue;
  const libraryId = manifest.libraryId;
  const rows: StagingRows = assertStagingRows(rowsValue);
  const resources = assertResourceDescriptors(resourcesValue);
  const webOps = count(opsValue);
  if ([...manifest.notebooks.map(item => item.sourceDocumentId)].sort().join('|') !== rows.notebooks.map(item => item.id).sort().join('|')) stagingFail('staging-conversion-input-mismatch');

  const bundles = new Map<string, Bundle>(), notConverted: NotConverted[] = [];
  const projectedOf = new Map(projected.notebooks.map(item => [item.sourceDocumentId, item]));
  const pdfOf = new Map(rows.pdfs.map(pdf => [pdf.id, pdf])), noteOf = new Map(rows.markdown.map(note => [note.id, note]));
  const manifestOf = new Map(manifest.notebooks.map(entry => [entry.sourceDocumentId, entry]));
  const descriptorOf = new Map(resources.map(resource => [resource.resourceId, resource]));
  for (const item of [...rows.items].sort((a, b) => compare(a.id, b.id))) {
    const key = ['papers', item.id];
    if (item.kind === 'pdf') {
      const result = await convertLegacyPdf({ libraryId, item, pdf: pdfOf.get(item.id)!, resources, webAnnotationOpsRows: webOps });
      if (result.status === 'blocked') { notConverted.push({ sourceKey: key, kind: 'pdf', reason: result.reason, residual: 'pdf-conversion-blocked', count: 1 }); continue; }
      const annotations = result.annotations.status === 'converted' ? result.annotations : { ink: 0, sticky: 0, highlight: 0 };
      bundles.set(item.id, { paperId: item.id, kind: 'pdf', contentId: result.document.id, unitKind: 'document', payload: result.document, resources: [result.resource],
        resourceId: result.resource.resourceId, ids: result.ids, provenance: result.provenance, notConverted: result.notConverted, pageTextRows: result.pageTextRows,
        stats: { pages: result.document.pages.length, ink: annotations.ink, sticky: annotations.sticky, highlight: annotations.highlight, images: 0 } });
    } else if (item.kind === 'markdown') {
      const result = await convertLegacyMarkdown({ libraryId, item, note: noteOf.get(item.id)!, resources, port: input.markdownImages });
      if (result.status === 'blocked') {
        notConverted.push({ sourceKey: key, kind: 'markdown', reason: result.reason, residual: MARKDOWN_MEDIA_RESIDUAL.test(result.reason) ? 'markdown-not-converted' : 'markdown-conversion-blocked', count: 1 });
        continue;
      }
      bundles.set(item.id, { paperId: item.id, kind: 'markdown', contentId: result.snapshot.id, unitKind: 'markdown', payload: result.snapshot, resources: result.resources,
        ids: result.ids, provenance: result.provenance, notConverted: result.notConverted, pageTextRows: 0,
        stats: { pages: 0, ink: 0, sticky: 0, highlight: 0, images: result.imageCount } });
    } else if (item.kind === 'notebook') {
      const result = projectedOf.get(item.id);
      if (!result) return stagingFail('staging-conversion-input-mismatch');
      if (result.status === 'blocked') { notConverted.push({ sourceKey: key, kind: 'notebook', reason: result.reason, residual: 'notebook-projection-blocked', count: 1 }); continue; }
      // A Web annotation ledger (web_annotation_ops) means a stroke may come from the browser, and the legacy Web export keeps such a stroke off a
      // replaced PDF by its source_sha256 (cloud_drive.py:186-202, IMPL-r161-b7e.md 1.6). The Notebook projection (B6, unchanged) converts a Notebook as a
      // whole, so a Notebook that has ink rows is not converted at all while the ledger exists. Sticky notes and highlights are not in the ledger.
      if (webOps > 0 && manifestOf.get(item.id)!.rows.ink.length > 0) {
        notConverted.push({ sourceKey: key, kind: 'notebook', reason: 'notebook-annotation-web-ops-present', residual: 'notebook-projection-blocked', count: 1 }); continue; }
      const document = result.document, source = result.provenance;
      const ids: IdEntry[] = [], check = async (kind: string, sourceKey: string[], expected: string) => {
        const targetId = await migrationStableId(libraryId, kind, sourceKey); if (targetId !== expected) stagingFail('staging-conversion-invalid-result'); ids.push({ kind, source: sourceKey, targetId }); };
      await check('notebook-document', [item.id], document.id);
      await check('notebook-revision', [item.id, String(source.revision), source.notebookSha256, source.annotationDataSha256], document.version);
      const notebookKey = ['papers', item.id, 'notebook.json'], provenance: ProvenanceRow[] = [
        { targetKind: 'document', targetId: document.id, sourceKind: 'file', sourceKey: notebookKey, sourceSha256: source.notebookSha256 }];
      for (const mapping of result.pageMappings) {
        await check('notebook-page', [item.id, mapping.sourcePageId], mapping.targetPageId);
        provenance.push({ targetKind: 'page', targetId: mapping.targetPageId, sourceKind: 'file', sourceKey: notebookKey, sourceSha256: source.notebookSha256 });
      }
      for (const mapping of result.mappings) {
        ids.push({ kind: mapping.kind, source: mapping.source, targetId: mapping.targetId });
        provenance.push({ targetKind: 'annotation', targetId: mapping.targetId, sourceKind: 'row', sourceKey: mapping.source, sourceSha256: mapping.sourceFingerprint });
      }
      bundles.set(item.id, { paperId: item.id, kind: 'notebook', contentId: document.id, unitKind: 'document', payload: document, resources: [], ids, provenance, notConverted: [],
        pageTextRows: manifestOf.get(item.id)!.incomplete.includes('page-text-not-converted') ? 1 : 0,
        stats: { pages: result.counts.pages, ink: result.counts.ink, sticky: result.counts.sticky, highlight: result.counts.highlight, images: 0 } });
    } else notConverted.push({ sourceKey: key, kind: 'item', reason: 'item-kind-unsupported', residual: 'library-item-not-converted', count: 1 });
  }

  // ---- the Library structure decides which converted contents are staged -----------------------------------------------------
  const contents = new Map<string, ContentRef>([...bundles].map(([paperId, bundle]) => [paperId,
    { kind: bundle.kind, contentId: bundle.contentId, ...(bundle.resourceId ? { resourceId: bundle.resourceId } : {}) }]));
  const library = await buildLegacyLibrary({ libraryId, rows, contents });
  const staged = [...bundles.values()].filter(bundle => library.kept.has(bundle.paperId)).sort((a, b) => compare(a.contentId, b.contentId));
  // The Library records its own drops; an item that never got a content was already reported by its converter (the Library does not report it again).
  notConverted.push(...library.notConverted);
  const coverage: StagingPlan['coverage'] = [];
  for (const item of [...rows.items].sort((a, b) => compare(a.id, b.id))) {
    if (item.kind !== 'pdf' && item.kind !== 'markdown' && item.kind !== 'notebook') continue;
    const bundle = bundles.get(item.id), inLibrary = library.kept.has(item.id);
    const blocked = notConverted.find(entry => entry.sourceKey.length === 2 && entry.sourceKey[1] === item.id && ['pdf', 'markdown', 'notebook'].includes(entry.kind));
    const dropped = library.dropped.get(item.id);
    coverage.push({ sourceKey: ['papers', item.id], kind: item.kind, status: bundle ? (inLibrary ? 'converted' : 'not-in-library') : 'blocked',
      reason: bundle ? (inLibrary ? null : dropped ?? null) : blocked?.reason ?? null,
      pages: bundle && inLibrary ? bundle.stats.pages : 0, ink: bundle && inLibrary ? bundle.stats.ink : 0, sticky: bundle && inLibrary ? bundle.stats.sticky : 0,
      highlight: bundle && inLibrary ? bundle.stats.highlight : 0, images: bundle && inLibrary ? bundle.stats.images : 0 });
  }
  for (const bundle of staged) notConverted.push(...bundle.notConverted);

  // ---- resources ----------------------------------------------------------------------------------------------------------------
  const used = new Map<string, ResourceUse>();
  for (const bundle of staged) for (const resource of bundle.resources) {
    const entry = used.get(resource.resourceId) ?? { resourceId: resource.resourceId, sha256: resource.sha256, byteLength: resource.byteLength, mediaType: resource.mediaType,
      sourceKey: resource.sourceKey, usedBy: [] };
    entry.usedBy = [...entry.usedBy, bundle.contentId].sort(compare); used.set(resource.resourceId, entry);
  }
  const resourceUses = [...used.values()].sort((a, b) => compare(a.resourceId, b.resourceId));
  const unusedResources = resources.filter(resource => !used.has(resource.resourceId)).map(resource => resource.resourceId).sort(compare);

  // ---- units, ids, provenance ---------------------------------------------------------------------------------------------------
  const ids: IdEntry[] = [...library.ids], provenance: ProvenanceRow[] = [...library.provenance];
  for (const bundle of staged) { ids.push(...bundle.ids); provenance.push(...bundle.provenance); }
  for (const use of resourceUses) {
    const descriptor = descriptorOf.get(use.resourceId)!;
    ids.push({ kind: 'resource', source: resourceSource(descriptor), targetId: use.resourceId });
    provenance.push({ targetKind: 'resource', targetId: use.resourceId, sourceKind: 'file', sourceKey: use.sourceKey, sourceSha256: use.sha256 });
  }
  ids.sort((a, b) => compare(a.kind, b.kind) || compare(JSON.stringify(a.source), JSON.stringify(b.source)));
  provenance.sort((a, b) => compare(a.targetKind, b.targetKind) || compare(a.targetId, b.targetId));
  assertIdTable(ids); assertProvenanceTable(provenance);
  const ordered = [...staged.map(bundle => ({ unitKind: bundle.unitKind, sourceKind: bundle.kind, targetId: bundle.contentId, payload: bundle.payload })),
    { unitKind: 'library' as const, sourceKind: 'library' as const, targetId: libraryId, payload: library.snapshot }]
    .sort((a, b) => UNIT_ORDER[a.unitKind] - UNIT_ORDER[b.unitKind] || compare(a.targetId, b.targetId));
  const units: PlanUnit[] = [];
  for (const [seq, unit] of ordered.entries()) units.push({ seq, ...unit, payloadSha256: await editContentHash(unit.payload) });

  // ---- residual reasons this converter itself keeps alive -----------------------------------------------------------------
  const residual = new Set(notConverted.map(entry => entry.residual));
  if (library.snapshot.items.length || rows.items.length) residual.add('library-metadata-not-converted');                 // J3 (a): read / bibliography / status are not converted
  if (staged.some(bundle => bundle.pageTextRows > 0)) residual.add('page-text-not-converted');
  const sum = (pick: (bundle: Bundle) => number) => staged.reduce((total, bundle) => total + pick(bundle), 0);
  const body = {
    version: 1 as const, scope: STAGING_PLAN_SCOPE as typeof STAGING_PLAN_SCOPE, converterVersion: STAGING_CONVERTER_VERSION as typeof STAGING_CONVERTER_VERSION, libraryId, manifestSha256: manifest.manifestSha256,
    units, resources: resourceUses, unusedResources, ids, provenance, notConverted: notConverted.sort((a, b) =>
      compare(a.sourceKey.join('\0'), b.sourceKey.join('\0')) || compare(a.reason, b.reason)), residualReasons: [...residual].sort(compare), coverage,
    counts: { ...library.counts, documents: { pdf: staged.filter(bundle => bundle.kind === 'pdf').length, notebook: staged.filter(bundle => bundle.kind === 'notebook').length },
      markdown: staged.filter(bundle => bundle.kind === 'markdown').length, pages: sum(bundle => bundle.stats.pages), ink: sum(bundle => bundle.stats.ink),
      sticky: sum(bundle => bundle.stats.sticky), highlight: sum(bundle => bundle.stats.highlight), resources: resourceUses.length, images: sum(bundle => bundle.stats.images) },
    derived: ['library.items[].position', 'library.folders[].position', 'library.version'], wholeLibrary: projected.wholeLibrary,
  };
  return { ...body, planSha256: await editContentHash(body) };
}
