import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentSnapshot, LibrarySnapshot, MarkdownSnapshot, Snapshot } from '../src/runtime/edits/contracts.ts';
import { assertSnapshot } from '../src/runtime/edits/editModel.ts';
import { editContentHash } from '../src/runtime/edits/editContentHash.ts';
import { analyzeMarkdownImages } from '../src/runtime/markdown/markdownImages.ts';
import { migrationStableId } from '../src/migrations/stableId.ts';
import { projectConversionInputNotebooks } from '../src/migrations/legacyConversionInput.ts';
import { buildStagingPlan, STAGING_CONVERTER_VERSION, STAGING_PLAN_SCOPE, type StagingPlan } from '../src/migrations/legacyStagingConversion.ts';
import { assertIdTable, assertProvenanceTable, type MarkdownImagePort } from '../src/migrations/legacyStagingInput.ts';
import { markdownImagePort } from './support/stagingMarkdownPort.ts';
import { legacyTags } from '../src/migrations/legacyLibrary.ts';
import { A, B, IMAGE_SHA, LIBRARY_ID, M, MEDIA_NAME, P, PDF_PAGES, PDF_SHA, folderRow, hex, imageResource, linkRow, markdownRow, paperRow, pdfResource, pdfRows, scenario, seal,
  stroke, type Data } from './support/stagingFixture.ts';

// Work B7-e (DESIGN-r161-b7-staging.md 12.2 TX-1..TX-14). Synthetic data only; the converters are pure, so nothing here reads or writes a file
// (the only file read is the Python source that pins the converter version).
const run = (data: Data, markdownImages: MarkdownImagePort = markdownImagePort) => buildStagingPlan({ manifest: data.manifest, extractions: data.extractions, rows: data.rows,
  resources: data.resources, webAnnotationOpsRows: data.webAnnotationOpsRows, markdownImages });
const fresh = async (options?: Parameters<typeof scenario>[0]) => scenario(options);
const code = (name: string) => (error: unknown) => error instanceof Error && error.message === name;
const unitOf = (plan: StagingPlan, targetId: string) => plan.units.find(item => item.targetId === targetId)!;
const id = (kind: string, ...source: string[]) => migrationStableId(LIBRARY_ID, kind, source);
const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), message ?? `${actual} != ${expected}`);
const documents = async (plan: StagingPlan) => ({ P: unitOf(plan, await id('pdf-document', P)).payload as DocumentSnapshot, A: unitOf(plan, await id('notebook-document', A))?.payload as DocumentSnapshot | undefined });
const library = (plan: StagingPlan) => plan.units[plan.units.length - 1].payload as LibrarySnapshot;
const reasons = (plan: StagingPlan) => plan.notConverted.map(item => [item.kind, item.reason, item.residual]);

// TX-1 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-1: a PDF becomes pages in the PDF\'s own order, with the resource\'s dimensions and the sealed revision', async () => {
  const data = await fresh(), plan = await run(data), { P: doc } = await documents(plan);
  assert.equal(doc.kind, 'document'); assert.equal(doc.pages.length, 3); assert.deepEqual(doc.deletedPages, []);
  const resource = data.resources[0];
  doc.pages.forEach((page, index) => {
    assert.deepEqual(page.background, { kind: 'pdf', resourceId: resource.resourceId, sourceRevision: PDF_SHA, pdfPage: index + 1 });
    assert.equal(page.widthPt, PDF_PAGES[index].widthPt); assert.equal(page.heightPt, PDF_PAGES[index].heightPt);
  });
  assert.deepEqual(doc.pages.map(page => page.id), await Promise.all([1, 2, 3].map(n => id('pdf-page', P, String(n)))));
  assert.notEqual(doc.pages[1].widthPt, doc.pages[0].widthPt, 'a page keeps its own size');
  assert.deepEqual(plan.resources.map(item => [item.resourceId, item.sha256, item.mediaType, item.usedBy]), [[resource.resourceId, PDF_SHA, 'application/pdf', [doc.id]]]);
  assert.deepEqual(plan.unusedResources, []);
  assertSnapshot(doc);
});
test('TX-1: a PDF whose file, hash, resource or page rows cannot be verified is not converted (blocked, not guessed)', async () => {
  const cases: [string, (data: Data) => Promise<void> | void, string][] = [
    ['file missing', data => { data.rows.pdfs[0].file = null; data.rows.pdfs[0].fileMatchesRow = null; }, 'pdf-file-missing'],
    ['file differs from the row', data => { data.rows.pdfs[0].fileMatchesRow = false; }, 'pdf-file-hash-mismatch'],
    ['row hash differs from the file', data => { data.rows.items[2].columns.sha256 = hex('other'); }, 'pdf-file-hash-mismatch'],
    ['no resource descriptor', data => { data.resources = []; }, 'pdf-resource-missing'],
    ['papers.pages differs from the PDF', data => { data.rows.pdfs[0].pagesColumn = 4; }, 'pdf-page-count-mismatch'],
    ['the page rows differ from the PDF', data => { data.rows.pdfs[0].counts.pageRows = 2; }, 'pdf-page-count-mismatch'],
    ['page numbers not 1..n', data => { data.rows.pdfs[0].pageNumbers = [1, 2, 4]; }, 'pdf-page-rows-not-contiguous'],
    ['page numbers flagged', data => { data.rows.pdfs[0].counts.pageNumbersContiguous = false; }, 'pdf-page-rows-not-contiguous'],
  ];
  for (const [name, change, reason] of cases) {
    const data = await fresh(); await change(data);
    const plan = await run(data);
    assert.deepEqual(plan.notConverted.filter(item => item.kind === 'pdf').map(item => [item.reason, item.residual]), [[reason, 'pdf-conversion-blocked']], name);
    assert.ok(!plan.units.some(item => item.sourceKind === 'pdf'), name);
    assert.ok(library(plan).items.every(item => item.kind !== 'pdf') && library(plan).links.length === 0, name);   // no item, and the link that needed it is not converted
    assert.ok(plan.notConverted.some(item => item.kind === 'link' && item.reason === 'link-endpoint-not-converted'), name);
    assert.ok(plan.residualReasons.includes('pdf-conversion-blocked') && plan.residualReasons.includes('item-link-not-converted'), name);
    assert.deepEqual(plan.unusedResources, name === 'no resource descriptor' ? [] : [data.resources[0].resourceId], name);
  }
});

// TX-2 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-2: original-side ink, highlights and sticky notes are converted with the page fractions times the PDF page size', async () => {
  const plan = await run(await fresh()), { P: doc } = await documents(plan);
  assert.deepEqual(doc.pages.map(page => page.annotations.map(item => item.kind)), [['sticky'], ['ink', 'ink'], ['ink', 'highlight']]);
  const [w2, h2] = [PDF_PAGES[1].widthPt, PDF_PAGES[1].heightPt], [w3, h3] = [PDF_PAGES[2].widthPt, PDF_PAGES[2].heightPt], [w1, h1] = [PDF_PAGES[0].widthPt, PDF_PAGES[0].heightPt];
  const ink = doc.pages[1].annotations[0];
  assert.equal(ink.kind, 'ink');
  if (ink.kind === 'ink' && ink.geometry.kind === 'path') {                      // (.2,.3) and (.4,.5) of a 612 x 792 page
    near(ink.geometry.points[0].x, .2 * w2); near(ink.geometry.points[0].y, .3 * h2); near(ink.geometry.points[1].x, .4 * w2); near(ink.geometry.points[1].y, .5 * h2);
    near(ink.style.widthPt, .002 * w2);                                           // a stroke's width is a fraction of the page WIDTH (pdf_ink.py:49)
  } else assert.fail('path ink expected');
  const note = doc.pages[0].annotations[0];
  assert.ok(note.kind === 'sticky'); if (note.kind === 'sticky') { near(note.anchor.x, .12 * w1); near(note.anchor.y, .34 * h1); }
  const highlight = doc.pages[2].annotations[1];
  assert.ok(highlight.kind === 'highlight');
  if (highlight.kind === 'highlight') {
    assert.equal(highlight.quads.length, 2); near(highlight.quads[0][0].x, .2 * w3); near(highlight.quads[0][0].y, .3 * h3);
    near(highlight.quads[0][2].x, (.2 + .25) * w3); near(highlight.quads[0][2].y, (.3 + .025) * h3);
    assert.equal(highlight.backgroundRevision, doc.pages[2].backgroundRevision); assert.deepEqual(highlight.range, { kind: 'unindexed' });
  }
  assert.deepEqual(plan.coverage.find(item => item.kind === 'pdf'), { sourceKey: ['papers', P], kind: 'pdf', status: 'converted', reason: null, pages: 3, ink: 3, sticky: 1, highlight: 1, images: 0 });
  assert.deepEqual(reasons(plan), []);
  // provenance: every annotation points at its legacy row key, with the converter's own fingerprint
  const annotations = plan.provenance.filter(item => item.targetKind === 'annotation' && item.sourceKey[0] === P);
  assert.equal(annotations.length, 5); assert.ok(annotations.every(item => item.sourceKind === 'row' && /^[0-9a-f]{64}$/.test(item.sourceSha256) && item.sourceKey[1] === 'original'));
  const pages = plan.provenance.filter(item => item.targetKind === 'page' && doc.pages.some(page => page.id === item.targetId));
  assert.deepEqual(pages.map(item => item.sourceKind), ['rows', 'rows', 'rows']);           // every page of P has rows; the page set is hashed (rows_hash)
});
test('TX-2: a PDF without any annotation row converts to bare pages', async () => {
  const data = await fresh(); data.rows.pdfs[0] = await pdfRows({ ink: {}, marks: [] });
  const plan = await run(data), { P: doc } = await documents(plan);
  assert.ok(doc.pages.every(page => page.annotations.length === 0));
  assert.deepEqual(plan.provenance.filter(item => item.targetKind === 'page' && doc.pages.some(page => page.id === item.targetId)).map(item => item.sourceKind), ['file', 'file', 'file']);
  assert.deepEqual(reasons(plan), []);
});
test('TX-2: the rows of a page and the independent counts must agree, or the input is refused', async () => {
  const changes: [string, (data: Data) => void][] = [
    ['stroke total', data => { data.rows.pdfs[0].counts.strokes.original = 9; }], ['ink row count', data => { data.rows.pdfs[0].counts.ink.original = 1; }],
    ['bookmark count', data => { data.rows.pdfs[0].counts.bookmarks.note.original = 2; }],
    ['a stroke list shorter than its counted length', data => { data.rows.pdfs[0].inkRows[0].strokes.pop(); }],
    ['page rows hash', data => { data.rows.pdfs[0].annotationPages['2'].sourceSha256 = hex('forged'); }],
    ['page rows count', data => { data.rows.pdfs[0].annotationPages['2'].rowCount = 5; }],
    ['an annotation page that has no rows', data => { data.rows.pdfs[0].annotationPages['9'] = { rowCount: 1, sourceSha256: hex('x') }; }],
    ['two ink rows for one page', data => { data.rows.pdfs[0].inkRows[1].page = 2; data.rows.pdfs[0].annotationPages = {}; }],
  ];
  for (const [name, change] of changes) { const data = await fresh(); change(data); await assert.rejects(run(data), code('staging-conversion-input-mismatch'), name); }
});

// TX-3 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-3: the translated side is never converted; it is counted and keeps the residual reason', async () => {
  const plan = await run(await fresh({ translated: true })), { P: doc } = await documents(plan);
  assert.deepEqual(doc.pages.map(page => page.annotations.map(item => item.kind)), [['sticky'], ['ink', 'ink'], ['ink', 'highlight']], 'only the original side');
  assert.deepEqual(plan.notConverted.map(item => [item.kind, item.reason, item.residual, item.count]), [['pdf-annotation', 'pdf-annotation-translated-side', 'pdf-annotation-not-converted', 2]]);   // one translated ink row and one translated sticky note
  assert.ok(plan.residualReasons.includes('pdf-annotation-not-converted'));
  assert.ok(!JSON.stringify(plan.provenance).includes('translated') && !JSON.stringify(plan.ids).includes('translated'));
});
test('TX-3: anything that cannot be verified withholds ALL annotations of the PDF (never half), and the pages are still staged', async () => {
  const cases: [string, (data: Data) => Promise<void> | void, string][] = [
    ['a Web annotation ledger exists', data => { data.webAnnotationOpsRows = 1; }, 'pdf-annotation-web-ops-present'],
    ['a stroke on a page that is not in the PDF', data => { data.rows.pdfs[0].inkRows[0].page = 4; data.rows.pdfs[0].annotationPages = {}; }, 'pdf-annotation-unmapped'],
    ['a bookmark on page 0', data => { data.rows.pdfs[0].bookmarkRows[0].page = 0; data.rows.pdfs[0].bookmarkRows[0].record.page = 0; data.rows.pdfs[0].annotationPages = {}; }, 'pdf-annotation-unmapped'],
    ['an unreadable stroke list', data => { data.rows.pdfs[0].inkRows[0].strokes = null; data.rows.pdfs[0].inkRows[0].strokeCount = null; data.rows.pdfs[0].counts.strokes.original = 1; }, 'pdf-annotation-unreadable'],
    ['a stroke the converter refuses (colour)', data => { data.rows.pdfs[0].inkRows[0].strokes[0].color = 'red'; }, 'pdf-annotation-conversion-failed'],
    ['a bookmark the converter refuses (quote on a note)', data => { data.rows.pdfs[0].bookmarkRows[0].record.color = 'blue'; }, 'pdf-annotation-conversion-failed'],
    ['a highlight outside the page', data => { data.rows.pdfs[0].bookmarkRows[1].record.rects = '[[0.9,0.9,0.5,0.5]]'; }, 'pdf-annotation-conversion-failed'],
  ];
  for (const [name, change, reason] of cases) {
    const data = await fresh(); await change(data);
    const plan = await run(data), { P: doc } = await documents(plan);
    assert.equal(doc.pages.length, 3, name); assert.ok(doc.pages.every(page => page.annotations.length === 0), name);
    assert.deepEqual(plan.notConverted.filter(item => item.kind === 'pdf-annotation').map(item => [item.kind, item.reason, item.residual]), [['pdf-annotation', reason, 'pdf-annotation-not-converted']], name);
    assert.ok(plan.residualReasons.includes('pdf-annotation-not-converted'), name);
    assert.deepEqual(plan.provenance.filter(item => item.targetKind === 'annotation' && item.sourceKey[0] === P), [], name);
    const coverage = plan.coverage.find(item => item.kind === 'pdf')!; assert.equal(coverage.status, 'converted'); assert.equal(coverage.ink + coverage.sticky + coverage.highlight, 0, name);
    assertSnapshot(doc);
  }
});
test('TX-3: a Web annotation ledger only matters for ink: a PDF without stroke rows converts (sticky notes and highlights are not in the ledger)', async () => {
  const data = await fresh(); data.rows.pdfs[0] = await pdfRows({ ink: {}, marks: [[1, 'note'], [3, 'highlight']] }); data.webAnnotationOpsRows = 7;
  const plan = await run(data), { P: doc } = await documents(plan);
  assert.deepEqual(doc.pages.map(page => page.annotations.map(item => item.kind)), [['sticky'], [], ['highlight']]);
  assert.ok(!reasons(plan).some(item => item[0] === 'pdf-annotation'));
  const bare = await fresh(); bare.rows.pdfs[0] = await pdfRows({ ink: {}, marks: [] }); bare.webAnnotationOpsRows = 7;
  assert.ok(!reasons(await run(bare)).some(item => item[0] === 'pdf-annotation'));
});
test('TX-3: with a Web annotation ledger a Notebook that has ink rows is not converted (the B6 projection converts a Notebook as a whole)', async () => {
  const data = await fresh(); data.webAnnotationOpsRows = 1;
  const plan = await run(data);
  assert.deepEqual(plan.notConverted.filter(item => item.kind === 'notebook').map(item => [item.sourceKey[1], item.reason, item.residual]),
    [[A, 'notebook-annotation-web-ops-present', 'notebook-projection-blocked'], [B, 'notebook-annotation-web-ops-present', 'notebook-projection-blocked']]);
  assert.equal(plan.counts.documents.notebook, 0); assert.ok(library(plan).items.every(item => item.kind !== 'notebook'));
  assert.ok(plan.residualReasons.includes('notebook-projection-blocked') && plan.residualReasons.includes('pdf-annotation-not-converted'));
  // a Notebook without a stroke is unaffected: only the strokes are in the ledger
  const bookmarkOnly = await fresh(); bookmarkOnly.webAnnotationOpsRows = 1;
  for (const entry of bookmarkOnly.manifest.notebooks) { entry.rows.ink = []; entry.coverage!.inkRows = 0; }
  for (const extraction of bookmarkOnly.extractions.values()) for (const page of extraction.annotations) page.ink = [];
  bookmarkOnly.manifest = await seal(bookmarkOnly.manifest);
  assert.deepEqual((await run(bookmarkOnly)).notConverted.filter(item => item.kind === 'notebook'), []);
});
test('TX-3: the PDF\'s revision depends on whether its annotations were converted', async () => {
  const withInk = await run(await fresh()), data = await fresh(); data.webAnnotationOpsRows = 2;
  const without = await run(data);
  assert.notEqual((await documents(withInk)).P.version, (await documents(without)).P.version);
});

// TX-4 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-4: 501 pages is blocked (a document holds at most 500), 500 converts', async () => {
  for (const [pages, blocked] of [[501, true], [500, false]] as const) {
    const data = await fresh(), sizes = Array.from({ length: pages }, () => ({ widthPt: 600, heightPt: 800 }));
    data.resources = [await pdfResource(PDF_SHA, sizes)]; data.rows.pdfs[0] = await pdfRows({ pages, ink: {}, marks: [] }); data.rows.items[2].columns.pages = pages;
    const plan = await run(data);
    assert.equal(plan.notConverted.some(item => item.reason === 'pdf-page-limit'), blocked, String(pages));
    assert.equal(plan.units.some(item => item.sourceKind === 'pdf'), !blocked, String(pages));
  }
});

// TX-5 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-5: a Markdown note keeps its body exactly, and its revision names the stored revision and body hash', async () => {
  const content = '# memo\r\n日本語 😀 $x$\n\n```\ncode\n```\n';
  const data = await fresh({ content }), plan = await run(data);
  const snapshot = unitOf(plan, await id('markdown-document', M)).payload as MarkdownSnapshot;
  assert.equal(snapshot.content, content); assert.deepEqual(snapshot.appendIds, []); assert.deepEqual(snapshot.imageResources, []);
  assert.equal(snapshot.version, await id('markdown-revision', M, data.rows.markdown[0].revision, data.rows.markdown[0].contentSha256));
  assertSnapshot(snapshot);
  assert.deepEqual(plan.provenance.find(item => item.targetId === snapshot.id && item.targetKind === 'markdown'), { targetKind: 'markdown', targetId: snapshot.id, sourceKind: 'row', sourceKey: ['note_state', M], sourceSha256: hex('note-state-M') });
  assert.deepEqual(reasons(plan), []);
});
test('TX-5: a note that cannot be confirmed against its mirror or its stored body is not converted', async () => {
  const cases: [string, (data: Data) => void, string, string][] = [
    ['note.md differs', data => { data.rows.markdown[0].mirror = 'mismatch'; }, 'markdown-mirror-mismatch', 'markdown-conversion-blocked'],
    ['note.md is absent', data => { data.rows.markdown[0].mirror = 'missing'; }, 'markdown-mirror-mismatch', 'markdown-conversion-blocked'],
    ['note.md was not compared', data => { data.rows.markdown[0].mirror = 'unchecked'; }, 'markdown-mirror-unchecked', 'markdown-conversion-blocked'],
    ['no note_state row', data => { Object.assign(data.rows.markdown[0], { state: 'missing', revision: null, source: null, updatedAt: null, content: null, contentBytes: null, contentSha256: null, sourceSha256: null }); }, 'markdown-state-missing', 'markdown-conversion-blocked'],
    ['unreadable body', data => { data.rows.markdown[0].content = null; data.rows.markdown[0].contentBytes = null; data.rows.markdown[0].contentSha256 = null; }, 'markdown-content-unreadable', 'markdown-conversion-blocked'],
    ['empty revision', data => { data.rows.markdown[0].revision = ''; }, 'markdown-revision-invalid', 'markdown-conversion-blocked'],
  ];
  for (const [name, change, reason, residual] of cases) {
    const data = await fresh(); change(data); const plan = await run(data);
    assert.deepEqual(plan.notConverted.filter(item => item.kind === 'markdown').map(item => [item.reason, item.residual]), [[reason, residual]], name);
    assert.ok(!plan.units.some(item => item.sourceKind === 'markdown'), name);
    assert.ok(library(plan).items.every(item => item.kind !== 'markdown'), name);
  }
  const wrong = await fresh(); wrong.rows.markdown[0].contentSha256 = hex('forged');
  await assert.rejects(run(wrong), code('staging-conversion-input-mismatch'));
  const length = await fresh(); length.rows.markdown[0].contentBytes += 1;
  await assert.rejects(run(length), code('staging-conversion-input-mismatch'));
});

// TX-6 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-6: an image of the note\'s own media folder becomes a canonical resource reference, and the body round-trips', async () => {
  const data = await fresh({ image: true }), plan = await run(data), resource = data.resources[1];
  const snapshot = unitOf(plan, await id('markdown-document', M)).payload as MarkdownSnapshot;
  const uri = `papeer://resource/${resource.resourceId}?sha256=${IMAGE_SHA}`;
  assert.equal(snapshot.content, `# memo\n![capture](${uri})\n\nSee [p.2](papeer://${P}/2).`);
  assert.deepEqual(snapshot.imageResources, [{ resourceId: resource.resourceId, sha256: IMAGE_SHA }]);
  assert.deepEqual(analyzeMarkdownImages(snapshot.content), { imageResources: snapshot.imageResources, problems: [] });
  assert.equal(snapshot.content.split(uri).join(`media/${MEDIA_NAME}`), data.rows.markdown[0].content);
  assertSnapshot(snapshot);
  assert.deepEqual(plan.resources.map(item => [item.resourceId, item.mediaType, item.usedBy]), [[data.resources[0].resourceId, 'application/pdf', [await id('pdf-document', P)]],
    [resource.resourceId, 'image/png', [snapshot.id]]].sort((a, b) => (a[0] as string) < (b[0] as string) ? -1 : 1));
  assert.equal(plan.counts.images, 1);
  // The citation link stays text (no canonical form for a legacy page-number URL) and is reported.
  assert.deepEqual(plan.notConverted.map(item => [item.kind, item.reason, item.residual, item.count]), [['markdown-link', 'markdown-legacy-links-retained', 'markdown-not-converted', 1]]);
  assert.ok(plan.residualReasons.includes('markdown-not-converted'));
  assert.deepEqual(plan.provenance.find(item => item.targetId === resource.resourceId), { targetKind: 'resource', targetId: resource.resourceId, sourceKind: 'file',
    sourceKey: ['papers', M, 'media', MEDIA_NAME], sourceSha256: IMAGE_SHA });
});
test('TX-6: the same image used twice is one resource; an unreferenced media file is reported and not stored', async () => {
  const data = await fresh({ content: `![a](media/${MEDIA_NAME} "first")\n\n![b](media/${MEDIA_NAME})` });
  data.rows.markdown[0] = markdownRow(data.rows.markdown[0].content, [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }, { name: 'unused.png', sha256: hex('unused'), byteLength: 9 }]);
  data.resources.push(await imageResource(), await imageResource('unused.png', hex('unused'), 'image/png', 9));
  const plan = await run(data), snapshot = unitOf(plan, await id('markdown-document', M)).payload as MarkdownSnapshot;
  assert.equal(snapshot.imageResources.length, 1); assert.equal(snapshot.content.match(/papeer:\/\/resource\//g)!.length, 2);
  assert.ok(snapshot.content.includes(' "first")'));
  assert.deepEqual(plan.notConverted.map(item => [item.kind, item.reason, item.count]), [['markdown-media', 'markdown-media-unreferenced', 1]]);
  assert.equal(plan.unusedResources.length, 1);
});
test('TX-6: an image reference that cannot be verified blocks the note (nothing is guessed)', async () => {
  const forms: [string, string][] = [
    ['an absolute path through the old API', `![x](/api/papers/${M}/media/${MEDIA_NAME})`], ['file URI', `![x](file:///C:/x/papers/${M}/media/${MEDIA_NAME})`],
    ['another relative path', '![x](images/a.png)'], ['data URI', '![x](data:image/png;base64,AAAA)'], ['a canonical URI that names no resource', `![x](papeer://resource/${LIBRARY_ID}?sha256=${'a'.repeat(64)})`],
    ['an angle-bracket URL', `![x](<media/${MEDIA_NAME}>)`], ['a reference definition', `![x][r]\n\n[r]: media/${MEDIA_NAME}`], ['a space inside the parentheses', `![x]( media/${MEDIA_NAME} )`],
    ['a media name that is not a PNG', '![x](media/a.jpg)'],
  ];
  for (const [name, content] of forms) {
    const data = await fresh({ content });
    data.rows.markdown[0] = markdownRow(content, [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }]); data.resources.push(await imageResource());   // the media exists, so only the form can refuse
    const plan = await run(data);
    assert.deepEqual(plan.notConverted.filter(item => item.kind === 'markdown').map(item => [item.reason, item.residual]), [['markdown-media-not-converted', 'markdown-not-converted']], name);
    assert.ok(!plan.units.some(item => item.sourceKind === 'markdown'), name);
  }
  // The same URL inside a code span is not an image: the textual replacement would touch code, so the count check refuses the note.
  const code2 = await fresh({ content: `![x](media/${MEDIA_NAME})\n\n\`![y](media/${MEDIA_NAME})\`` });
  code2.rows.markdown[0] = markdownRow(code2.rows.markdown[0].content, [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }]); code2.resources.push(await imageResource());
  assert.deepEqual(reasons(await run(code2)).filter(item => item[0] === 'markdown'), [['markdown', 'markdown-media-not-converted', 'markdown-not-converted']]);
  // External images stay as they are.
  const external = await fresh({ content: '![x](https://example.com/a.png)' }), snapshot = unitOf(await run(external), await id('markdown-document', M)).payload as MarkdownSnapshot;
  assert.equal(snapshot.content, '![x](https://example.com/a.png)'); assert.deepEqual(snapshot.imageResources, []);
});
test('TX-6: a match that is not an image node cannot cancel out an image that was not replaced (review medium 1): the note is refused, nothing is rewritten', async () => {
  const link = `[l](media/${MEDIA_NAME})`, own = `![b](media/${MEDIA_NAME})`, angle = `![a](<media/${MEDIA_NAME}>)`, definition = `![a][r]

[r]: media/${MEDIA_NAME}`;
  const codeSpan = '`![c](media/' + MEDIA_NAME + ')`';
  const cases: [string, string][] = [
    ['an angle-bracket image, a link and an inline image', `${angle}

${link}

${own}`],
    ['a reference-definition image, a link and an inline image', `${definition}

${link}

${own}`],
    ['a code span, an angle-bracket image and an inline image', `${codeSpan}

${angle}

${own}`],
    ['a code span, a reference-definition image and an inline image', `${codeSpan}

${definition}

${own}`],
  ];
  for (const [name, content] of cases) {
    const data = await fresh({ content }); data.rows.markdown[0] = markdownRow(content, [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }]); data.resources.push(await imageResource());
    const plan = await run(data);
    assert.deepEqual(plan.notConverted.filter(item => item.kind === 'markdown').map(item => [item.reason, item.residual]), [['markdown-media-not-converted', 'markdown-not-converted']], name);
    assert.ok(!plan.units.some(unit => unit.sourceKind === 'markdown'), name);          // refused: no staged body can hold a rewritten link or code span
  }
});
test('TX-6: a media reference that is not an image node (raw HTML, a link, prose) stays as text and is reported, never converted', async () => {
  const cases: [string, string, number][] = [[`<img src="media/${MEDIA_NAME}">`, 'raw HTML', 1], [`[file](media/${MEDIA_NAME})`, 'a link', 1], ['see media/a.png and media/b.png', 'prose', 2], ['no reference here', 'none', 0]];
  for (const [content, name, count] of cases) {
    const data = await fresh({ content }), plan = await run(data);
    const snapshot = unitOf(plan, await id('markdown-document', M)).payload as MarkdownSnapshot;
    assert.equal(snapshot.content, content, name); assert.deepEqual(snapshot.imageResources, [], name);
    assert.deepEqual(plan.notConverted.map(item => [item.reason, item.count]), count ? [['markdown-media-reference-retained', count]] : [], name);
  }
  // an image that IS converted does not count; one more reference in raw HTML does
  const mixed = await fresh({ content: `![x](media/${MEDIA_NAME})\n\n<img src="media/${MEDIA_NAME}">` });
  mixed.rows.markdown[0] = markdownRow(mixed.rows.markdown[0].content, [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }]); mixed.resources.push(await imageResource());
  const plan = await run(mixed);
  assert.deepEqual(plan.notConverted.map(item => [item.reason, item.count]), [['markdown-media-reference-retained', 1]]);
  assert.equal((unitOf(plan, await id('markdown-document', M)).payload as MarkdownSnapshot).imageResources.length, 1);
});
test('TX-6: a body that already holds the canonical URI of its own image as text cannot be proven to round-trip, so it is refused', async () => {
  const resource = await imageResource(), uri = `papeer://resource/${resource.resourceId}?sha256=${IMAGE_SHA}`;
  const content = `![x](media/${MEDIA_NAME})\n\n\`${uri}\``;
  const data = await fresh({ content }); data.rows.markdown[0] = markdownRow(content, [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }]); data.resources.push(resource);
  const plan = await run(data);
  assert.deepEqual(plan.notConverted.filter(item => item.kind === 'markdown').map(item => item.reason), ['markdown-media-not-converted']);
  assert.ok(!plan.units.some(unit => unit.sourceKind === 'markdown'));
});
test('TX-6: the Markdown parser port is checked, not trusted: a port that misreports the text blocks the note', async () => {
  const media = { name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 };
  const setup = async () => { const data = await fresh({ content: `![x](media/${MEDIA_NAME})` }); data.rows.markdown[0] = markdownRow(data.rows.markdown[0].content, [media]);
    data.resources.push(await imageResource()); return data; };
  const blockedWith = async (port: MarkdownImagePort) => (await run(await setup(), port)).notConverted.filter(item => item.kind === 'markdown').map(item => item.reason);
  assert.deepEqual(await blockedWith(markdownImagePort), [], 'control: the real port converts it');
  // the parser reports one more media image than the text has inline forms for
  assert.deepEqual(await blockedWith({ ...markdownImagePort, imageUrls: content => [...markdownImagePort.imageUrls(content), `media/${MEDIA_NAME}`] }), ['markdown-media-not-converted']);
  // the canonical analyzer does not see the new reference, sees another one, or reports a problem
  assert.deepEqual(await blockedWith({ ...markdownImagePort, analyze: () => ({ imageResources: [], problems: [] }) }), ['markdown-media-not-converted']);
  assert.deepEqual(await blockedWith({ ...markdownImagePort, analyze: () => ({ imageResources: [{ resourceId: LIBRARY_ID, sha256: 'a'.repeat(64) }], problems: [] }) }), ['markdown-media-not-converted']);
  assert.deepEqual(await blockedWith({ ...markdownImagePort, analyze: content => ({ ...markdownImagePort.analyze(content), problems: ['markdown-image-uri-invalid'] }) }), ['markdown-media-not-converted']);
});
test('TX-6: a media entry without a verified resource blocks the note', async () => {
  const cases: [string, (data: Data) => Promise<void> | void, string][] = [
    ['media entry missing', data => { data.rows.markdown[0].media = []; }, 'markdown-media-missing'],
    ['no resource descriptor', data => { data.resources = [data.resources[0]]; }, 'markdown-media-resource-missing'],
    ['not a PNG resource', async data => { data.resources[1] = await imageResource(MEDIA_NAME, IMAGE_SHA, 'image/jpeg'); }, 'markdown-media-type-unsupported'],
  ];
  for (const [name, change, reason] of cases) {
    const data = await fresh({ image: true }); await change(data); const plan = await run(data);
    assert.deepEqual(plan.notConverted.filter(item => item.kind === 'markdown').map(item => [item.reason, item.residual]), [[reason, 'markdown-not-converted']], name);
  }
  const wrongSha = await fresh({ image: true }); wrongSha.resources[1] = await imageResource(MEDIA_NAME, hex('other-png'));
  await assert.rejects(run(wrongSha), code('staging-conversion-resource-mismatch'));
  const wrongId = await fresh({ image: true }); wrongId.resources[1].resourceId = LIBRARY_ID;
  await assert.rejects(run(wrongId), code('staging-conversion-resource-mismatch'));
});

// TX-7 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-7: the Library holds the items, folders, links and tags of the converted contents', async () => {
  const plan = await run(await fresh()), lib = library(plan), ids = { A: await id('notebook-document', A), B: await id('notebook-document', B), P: await id('pdf-document', P), M: await id('markdown-document', M) };
  assert.equal(lib.id, LIBRARY_ID); assert.deepEqual(lib.deletions, []);
  assert.deepEqual(lib.items.map(item => item.id), Object.values(ids).sort(), 'items are in id order; an item id IS its content id');
  const item = (key: keyof typeof ids) => lib.items.find(entry => entry.id === ids[key])!;
  const folder = (title: string) => lib.folders.find(entry => entry.title === title)!;
  assert.deepEqual(item('A'), { id: ids.A, kind: 'notebook', title: 'Notebook A', ownerId: null, folderId: null, position: 0, tags: ['idea', '研究'], read: false, metadata: {} });
  assert.deepEqual(item('P'), { id: ids.P, kind: 'pdf', title: 'Paper P', ownerId: null, folderId: folder('Folder').id, position: 0, tags: ['read-later'], read: false,
    resourceId: (await documents(plan)).P.pages[0].background.kind === 'pdf' ? ((await documents(plan)).P.pages[0].background as { resourceId: string }).resourceId : '', metadata: {} });
  assert.equal(item('B').folderId, folder('Sub').id); assert.equal(item('M').ownerId, ids.P); assert.equal(item('M').folderId, null); assert.equal(item('M').resourceId, undefined);
  assert.deepEqual(lib.folders.map(entry => [entry.title, entry.parentId === null ? null : lib.folders.find(other => other.id === entry.parentId)!.title, entry.position]).sort(),
    [['Folder', null, 0], ['Sub', 'Folder', 0]]);
  assert.equal(folder('Folder').id, await id('library-folder', 'Folder')); assert.equal(folder('Sub').id, await id('library-folder', 'Folder / Sub'));
  assert.deepEqual(lib.links, [{ pdfId: ids.P, noteId: ids.A }]);
  assert.deepEqual(plan.counts, { items: 4, folders: 2, links: 1, tags: 3, documents: { pdf: 1, notebook: 2 }, markdown: 1, pages: 8, ink: 8, sticky: 4, highlight: 2, resources: 1, images: 0 });
  assert.deepEqual(plan.residualReasons, ['library-metadata-not-converted', 'page-text-not-converted']);
  assert.deepEqual(plan.derived, ['library.items[].position', 'library.folders[].position', 'library.version']);
  assert.deepEqual(plan.wholeLibrary, { status: 'refused', reasons: ['messages-not-converted', 'uncollected-source'] });
  assertSnapshot(lib);
});
test('TX-7: positions are ordinals made from the order the items were added (owned notes by note_position first), folders by name', async () => {
  const data = await fresh();
  data.rows.items.push(paperRow('e'.repeat(32), 'markdown', { title: 'second note', parent: P, created: '2026-01-01 00:00:00', position: 1 }),
    paperRow('f'.repeat(32), 'markdown', { title: 'first note', parent: P, created: '2026-01-09 00:00:00', position: 0 }),
    paperRow('1'.repeat(32), 'markdown', { title: 'newer in Folder', collection: 'Folder', created: '2026-02-01 00:00:00' }),
    paperRow('2'.repeat(32), 'markdown', { title: 'older in Folder', collection: 'Folder', created: '2025-02-01 00:00:00', position: 5 }));   // a standalone note's note_position is not used
  for (const key of ['e', 'f', '1', '2']) { const note = markdownRow('x'); Object.assign(note, { id: key.repeat(32), sourceSha256: hex('ns-' + key) }); data.rows.markdown.push(note); }
  data.rows.folders.push(folderRow('Zeta'), folderRow('Alpha'), folderRow('Folder / A'));
  const plan = await run(data), lib = library(plan);
  const byTitle = (title: string) => lib.items.find(entry => entry.title === title)!;
  // owner P: first note (position 0, created 01-09), Memo M (position 0, created 01-01 04) -> position then created_at then id
  const owned = lib.items.filter(item => item.ownerId === byTitle('Paper P').id).sort((a, b) => a.position - b.position).map(item => item.title);
  assert.deepEqual(owned, ['Memo M', 'first note', 'second note']);
  // Folder: Paper P (2026-01-01 00:00:03), older (2025), newer (2026-02) -> older, P, newer
  const inFolder = lib.items.filter(item => item.folderId === lib.folders.find(folder => folder.title === 'Folder')!.id).sort((a, b) => a.position - b.position).map(item => item.title);
  assert.deepEqual(inFolder, ['older in Folder', 'Paper P', 'newer in Folder']);
  assert.deepEqual(lib.folders.filter(folder => folder.parentId === null).sort((a, b) => a.position - b.position).map(folder => folder.title), ['Alpha', 'Folder', 'Zeta']);
  const parent = lib.folders.find(folder => folder.title === 'Folder')!.id;
  assert.deepEqual(lib.folders.filter(folder => folder.parentId === parent).sort((a, b) => a.position - b.position).map(folder => folder.title), ['A', 'Sub']);
});
test('TX-7: links need a resolved pair whose ends were both converted', async () => {
  const data = await fresh();
  data.rows.links.push({ a: 'e'.repeat(32), b: 'f'.repeat(32), status: 'unresolved', reason: 'link-endpoint-missing', pdfId: null, noteId: null, noteKind: null, sourceSha256: hex('link-x') },
    linkRow(P, M, 'markdown'));
  const plan = await run(data);
  assert.deepEqual(library(plan).links.length, 1);
  assert.deepEqual(plan.notConverted.filter(item => item.kind === 'link').map(item => [item.sourceKey.join('/'), item.reason, item.residual]),
    [[['item_links', 'e'.repeat(32), 'f'.repeat(32)].join('/'), 'link-endpoint-missing', 'item-link-not-converted'], [['item_links', P, M].join('/'), 'link-endpoint-not-converted', 'item-link-not-converted']].sort());
  const link = plan.provenance.find(item => item.targetKind === 'link')!;
  assert.deepEqual(JSON.parse(link.targetId), [library(plan).links[0].pdfId, library(plan).links[0].noteId]);
  assert.deepEqual(link.sourceKey, ['item_links', A, P]);
});
test('TX-7: ownership, folders and ordering rules refuse what the canonical Library would refuse, item by item', async () => {
  const cases: [string, (data: Data) => void, string][] = [
    ['an owned item in a folder of its own', data => { data.rows.items[1] = paperRow(B, 'notebook', { title: 'B', collection: 'Folder / Sub', parent: P }); }, 'owned-item-folder-conflict'],
    ['an item owned by something that is not there', data => { data.rows.items[1] = paperRow(B, 'notebook', { title: 'B', parent: '9'.repeat(32) }); }, 'owner-not-converted'],
    ['a PDF that is owned', data => { data.rows.items[2] = paperRow(P, 'pdf', { title: 'P', parent: A, sha: PDF_SHA, pages: 3 }); }, 'owned-kind-unsupported'],
    ['an owner that is itself owned', data => { data.rows.items[0] = paperRow(A, 'notebook', { title: 'A', parent: P }); data.rows.items[3] = paperRow(M, 'markdown', { title: 'M', parent: A }); }, 'owner-not-converted'],
    ['an owned item whose note_position is not an integer', data => { data.rows.items[3].columns.note_position = 'x'; }, 'position-unrepresentable'],
  ];
  for (const [name, change, reason] of cases) {
    const data = await fresh(); change(data); const plan = await run(data);
    assert.ok(plan.notConverted.some(item => item.kind === 'item' && item.reason === reason), name + ' ' + JSON.stringify(reasons(plan)));
    for (const entry of library(plan).items) if (entry.ownerId) assert.ok(library(plan).items.some(owner => owner.id === entry.ownerId && !owner.ownerId), name);
    assertSnapshot(library(plan));
  }
  // an owned note that sits in the same folder as its owner is accepted (the legacy app stores the owner's folder for an owned note, notes.py:113-123)
  const same = await fresh(); same.rows.items[3] = paperRow(M, 'markdown', { title: 'M', parent: P, collection: 'Folder' });
  const lib = library(await run(same)); assert.equal(lib.items.find(item => item.title === 'M')!.folderId, null);
});

// TX-8 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-8: title boundaries (nothing is truncated or defaulted)', async () => {
  const wide = 'あ'.repeat(200);
  for (const [title, kept] of [['x', true], [wide, true], ['😀'.repeat(200), true], [wide + 'い', false], ['😀'.repeat(201), false], ['', false], ['  \u3000\n ', false],
    [' padded ', true], [7, false], [null, false]] as [unknown, boolean][]) {
    const data = await fresh(), rootA = await id('notebook-document', A); data.rows.items[0].columns.title = title;       // items[0] is Notebook A
    const plan = await run(data), titles = library(plan).items.map(entry => entry.title);
    if (kept) { assert.ok(titles.includes(title as string), String(title)); assert.deepEqual(plan.notConverted, [], String(title)); continue; }
    assert.ok(!titles.includes(title as string), String(title));
    assert.deepEqual(plan.notConverted.filter(entry => entry.kind === 'item').map(entry => [entry.sourceKey[1], entry.reason, entry.residual]), [[A, 'title-unrepresentable', 'library-item-not-converted']], String(title));
    // the content root of an item that is not in the Library is not staged either (no root without an item), and the link that needed it is not converted
    assert.ok(!plan.units.some(unit => unit.targetId === rootA) && !plan.provenance.some(row => row.targetId === rootA), String(title));
    assert.equal(plan.units.filter(unit => unit.unitKind === 'document').length, 2, String(title));
    assert.equal(library(plan).links.length, 0, String(title));
    assert.ok(plan.notConverted.some(entry => entry.kind === 'link' && entry.reason === 'link-endpoint-not-converted'), String(title));
  }
});
test('TX-8: a folder whose title cannot be represented takes its sub-folders and items with it', async () => {
  const data = await fresh(), long = 'x'.repeat(201);
  data.rows.folders = [folderRow(long), folderRow(`${long} / Inner`), folderRow('Folder'), folderRow('Folder / Sub')];
  data.rows.items[1] = paperRow(B, 'notebook', { title: 'B', collection: `${long} / Inner` });
  const plan = await run(data), lib = library(plan);
  assert.deepEqual(lib.folders.map(folder => folder.title).sort(), ['Folder', 'Sub']);
  assert.deepEqual(plan.notConverted.filter(item => item.kind === 'folder').map(item => [item.sourceKey[1], item.residual]).sort(), [[long, 'folder-not-converted'], [`${long} / Inner`, 'folder-not-converted']].sort());
  assert.deepEqual(plan.notConverted.filter(item => item.kind === 'item').map(item => [item.reason, item.residual]), [['folder-unrepresentable', 'library-item-not-converted']]);
  assert.ok(!lib.items.some(item => item.title === 'B'));
});
test('TX-8: tags are used exactly or the item is not converted', async () => {
  for (const [column, expected] of [['[]', []], ['["a","b"]', ['a', 'b']], ['["日本語"]', ['日本語']], [`["${'t'.repeat(200)}"]`, ['t'.repeat(200)]]] as [string, string[]][]) assert.deepEqual(legacyTags(column), expected, column);
  for (const column of ['', 'not json', '{}', '"a"', '[1]', '["a","a"]', '[""]', '[" a"]', '["a "]', '["\\u3000"]', `["${'t'.repeat(201)}"]`, '["\\ud800"]', null as unknown as string, '[null]', '["a",["b"]]'])
    assert.equal(legacyTags(column), null, String(column));
  const data = await fresh(); data.rows.items[0].columns.tags = '["a","a"]';
  const plan = await run(data);
  assert.deepEqual(plan.notConverted.filter(item => item.kind === 'item').map(item => [item.sourceKey[1], item.reason]), [[A, 'tags-unrepresentable']]);
  assert.ok(!library(plan).items.some(item => item.title === 'Notebook A'));
});

// TX-9 -----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-9: the same input gives the same plan, in any order, with no clock or random source', async (t) => {
  // two bookmarks on one page (ids 1 and 2) and one on page 1: the order of the rows must not matter
  const prepare = async () => { const value = await fresh(); value.rows.pdfs[0] = await pdfRows({ marks: [[3, 'note'], [3, 'highlight'], [1, 'note']] }); return value; };
  const first = await run(await prepare()), second = await run(await prepare());
  // The fixtures differ in run, peer and backup IDs (and so in manifestSha256, which the plan header carries); nothing else may differ.
  const content = (plan: StagingPlan) => { const { manifestSha256: _m, planSha256: _p, ...rest } = plan; return rest; };
  assert.deepEqual(content(first), content(second));
  const same = await prepare(); assert.equal((await run(same)).planSha256, (await run(same)).planSha256);
  const data = await prepare();
  const flipped: Data = { ...structuredClone({ manifest: data.manifest, rows: data.rows, resources: data.resources }), webAnnotationOpsRows: 0,
    extractions: new Map([...data.extractions].reverse().map(([key, value]) => [key, structuredClone(value)])) };
  for (const key of ['items', 'folders', 'links', 'markdown', 'pdfs', 'notebooks']) flipped.rows[key].reverse();
  flipped.rows.pdfs[0].inkRows.reverse(); flipped.rows.pdfs[0].bookmarkRows.reverse(); flipped.resources.reverse();
  flipped.manifest = await seal({ ...flipped.manifest, notebooks: [...flipped.manifest.notebooks].reverse() });
  t.mock.method(Math, 'random', () => { throw new Error('random used'); });
  t.mock.method(Date, 'now', () => { throw new Error('clock used'); });
  t.mock.method(globalThis.crypto, 'randomUUID', () => { throw new Error('uuid used'); });
  const other = await run(flipped);
  assert.deepEqual(content(other), content(first));
});

// TX-10 ----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-10: every ID follows the kind/source table, none depends on the run, and each unit hash is the content hash of its payload', async () => {
  const data = await fresh({ image: true }), plan = await run(data), pdfDoc = (await documents(plan)).P;
  const stored = JSON.parse(JSON.stringify(data.rows.pdfs[0]));
  const sources = new Map(plan.ids.map(entry => [JSON.stringify([entry.kind, entry.source]), entry.targetId]));
  const rule = async (kind: string, ...source: string[]) => assert.equal(sources.get(JSON.stringify([kind, source])), await id(kind, ...source), `${kind} ${source.join(',')}`);
  await rule('pdf-document', P); await rule('pdf-page', P, '1'); await rule('pdf-page', P, '3');
  const annotationData = await editContentHash({ ink: [[2, stored.inkRows[0].strokes], [3, stored.inkRows[1].strokes]], bookmarks: stored.bookmarkRows.map((row: { record: unknown }) => row.record) });
  await rule('pdf-revision', P, PDF_SHA, annotationData);
  await rule('resource', 'pdf-original', 'papers', P, 'original.pdf', PDF_SHA); await rule('resource', 'markdown-image', 'papers', M, 'media', MEDIA_NAME, IMAGE_SHA);
  await rule('markdown-document', M); await rule('markdown-revision', M, data.rows.markdown[0].revision, data.rows.markdown[0].contentSha256);
  await rule('notebook-document', A); await rule('notebook-page', A, 'a'.repeat(31) + '1'); await rule('library-folder', 'Folder'); await rule('library-folder', 'Folder / Sub');
  await rule('ink', P, 'original', '2', 'p2-0'); await rule('bookmark', P, 'original', '1', '1'); await rule('bookmark', P, 'original', '3', '2');
  const lib = library(plan), contentSha = await editContentHash({ items: lib.items, folders: lib.folders, links: lib.links });
  await rule('library-revision', contentSha); assert.equal(lib.version, await id('library-revision', contentSha));
  for (const entry of plan.ids) assert.equal(entry.targetId, await migrationStableId(LIBRARY_ID, entry.kind, entry.source), entry.kind);
  assert.ok(!plan.ids.some(entry => entry.kind === 'library-item'), 'an item id is its content id (the canonical store requires a root of the same id), so no separate item ids exist');
  assert.ok(!JSON.stringify(plan).includes(data.manifest.runId) && !JSON.stringify(plan).includes(data.manifest.peerId), 'no run or peer ID in the plan');
  assert.equal(JSON.stringify(plan.ids.map(entry => entry.targetId)), JSON.stringify([...new Set(plan.ids.map(entry => entry.targetId))]), 'ids are distinct');
  for (const unit of plan.units) assert.equal(unit.payloadSha256, await editContentHash(unit.payload));
  assert.equal(pdfDoc.version, plan.ids.find(entry => entry.kind === 'pdf-revision')!.targetId);
  // seq runs 0..n-1 in the order document, markdown, library, then by id
  assert.deepEqual(plan.units.map(unit => unit.seq), plan.units.map((_, index) => index));
  assert.deepEqual(plan.units.map(unit => unit.unitKind), ['document', 'document', 'document', 'markdown', 'library']);
  const documentsInOrder = plan.units.filter(unit => unit.unitKind === 'document').map(unit => unit.targetId); assert.deepEqual(documentsInOrder, [...documentsInOrder].sort());
  // a different run (and therefore peer and backup IDs) changes nothing
  const again = await run(await fresh({ image: true })); assert.deepEqual([again.units, again.ids, again.provenance], [plan.units, plan.ids, plan.provenance]);
});

// TX-11 ----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-11: every target of the plan has exactly one provenance row, and no row names a target that is not staged', async () => {
  for (const options of [{}, { image: true }, { translated: true }] as Parameters<typeof scenario>[0][]) {
    const plan = await run(await fresh(options));
    const targets = new Map<string, string>();
    const add = (kind: string, targetId: string) => { const key = `${kind}|${targetId}`; assert.ok(!targets.has(key), key); targets.set(key, kind); };
    for (const unit of plan.units) {
      const payload = unit.payload as Snapshot;
      if (payload.kind === 'document') { add('document', payload.id); for (const page of payload.pages) { add('page', page.id); for (const annotation of page.annotations) add('annotation', annotation.id); } }
      else if (payload.kind === 'markdown') add('markdown', payload.id);
      else { add('library', payload.id); payload.items.forEach(item => add('library-item', item.id)); payload.folders.forEach(folder => add('folder', folder.id));
        payload.links.forEach(link => add('link', JSON.stringify([link.pdfId, link.noteId]))); }
    }
    for (const resource of plan.resources) add('resource', resource.resourceId);
    const rows = new Map(plan.provenance.map(row => [`${row.targetKind}|${row.targetId}`, row]));
    assert.equal(rows.size, plan.provenance.length, 'one row per target');
    assert.deepEqual([...rows.keys()].sort(), [...targets.keys()].sort(), JSON.stringify(options));
    for (const row of plan.provenance) {
      assert.ok(/^[0-9a-f]{64}$/.test(row.sourceSha256) && row.sourceKey.length > 0, row.targetKind);
      assert.equal(row.sourceKind === 'derived', row.targetKind === 'library');
    }
  }
});
test('TX-11: the Library root is derived from the other library rows (so a changed row changes it)', async () => {
  const one = await run(await fresh()), data = await fresh(); data.rows.items[1].sourceSha256 = hex('another row');
  const two = await run(data);
  const root = (plan: StagingPlan) => plan.provenance.find(row => row.targetKind === 'library')!.sourceSha256;
  assert.notEqual(root(one), root(two)); assert.notEqual(one.planSha256, two.planSha256);
});

// TX-12 ----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-12: the converters never change their input', async () => {
  const data = await fresh({ image: true, translated: true });
  const before = structuredClone({ manifest: data.manifest, extractions: [...data.extractions], rows: data.rows, resources: data.resources, ops: data.webAnnotationOpsRows });
  const plan = await run(data);
  assert.deepEqual(structuredClone({ manifest: data.manifest, extractions: [...data.extractions], rows: data.rows, resources: data.resources, ops: data.webAnnotationOpsRows }), before);
  // and the plan shares nothing with the input: editing the plan does not reach it
  (plan.units[0].payload as DocumentSnapshot).pages.length = 0; plan.ids.length = 0;
  assert.deepEqual(structuredClone({ manifest: data.manifest, extractions: [...data.extractions], rows: data.rows, resources: data.resources, ops: data.webAnnotationOpsRows }), before);
  // an input changed WHILE the plan is built cannot enter it
  const pending = run(data); data.rows.items[0].columns.title = 'changed after the call'; data.rows.markdown[0].content = 'changed';
  const result = await pending; assert.ok(library(result).items.some(item => item.title === 'Notebook A'));
});

// TX-13 ----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-13: the converter version and plan scope, and the same version string in the Python store', async () => {
  const plan = await run(await fresh());
  assert.equal(STAGING_CONVERTER_VERSION, 'b7-v1'); assert.equal(plan.converterVersion, STAGING_CONVERTER_VERSION); assert.equal(plan.scope, STAGING_PLAN_SCOPE); assert.equal(plan.version, 1);
  const python = readFileSync(new URL('../../papeer/core/migrations/legacy_staging_store.py', import.meta.url), 'utf8');
  assert.equal(/^CONVERTER_VERSION = '([^']+)'/m.exec(python)?.[1], STAGING_CONVERTER_VERSION);
  const { planSha256, ...body } = plan; assert.equal(planSha256, await editContentHash(body));
});

// TX-14 ----------------------------------------------------------------------------------------------------------------------------------------------
test('TX-14: a Notebook is exactly what the B6 projection gives (document, mappings and counts)', async () => {
  const data = await fresh(), plan = await run(data), b6 = await projectConversionInputNotebooks(data.manifest, data.extractions);
  for (const notebook of b6.notebooks) {
    assert.equal(notebook.status, 'converted'); if (notebook.status !== 'converted') continue;
    assert.deepEqual(unitOf(plan, notebook.document.id).payload, notebook.document);
    const annotations = plan.provenance.filter(row => row.targetKind === 'annotation' && row.sourceKey[0] === notebook.sourceDocumentId);
    assert.deepEqual(annotations.map(row => [row.targetId, row.sourceSha256]).sort(), notebook.mappings.map(mapping => [mapping.targetId, mapping.sourceFingerprint]).sort());
    assert.equal(annotations.length, notebook.counts.ink + notebook.counts.sticky + notebook.counts.highlight);
    assert.deepEqual(plan.provenance.filter(row => row.targetKind === 'page' && notebook.pageMappings.some(page => page.targetPageId === row.targetId)).length, notebook.counts.pages);
    assert.deepEqual(plan.provenance.find(row => row.targetId === notebook.document.id), { targetKind: 'document', targetId: notebook.document.id, sourceKind: 'file',
      sourceKey: ['papers', notebook.sourceDocumentId, 'notebook.json'], sourceSha256: data.extractions.get(notebook.sourceDocumentId)!.entry.sha256 });
  }
  // a Notebook the manifest calls blocked is not converted and keeps its residual reason
  const blocked = await fresh(), entry = blocked.manifest.notebooks[1];
  Object.assign(entry, { status: 'blocked', reason: 'legacy-notebook-recovery-pending', notebookEntry: null, pageIds: [], rows: { pages: [], ink: [], bookmarks: [] }, coverage: null, incomplete: [] });
  blocked.manifest = await seal({ ...blocked.manifest, wholeLibrary: { status: 'refused', reasons: ['messages-not-converted', 'notebook-extraction-blocked', 'uncollected-source'] } });
  blocked.extractions.delete(B);
  const result = await run(blocked);
  assert.deepEqual(result.notConverted.map(item => [item.kind, item.reason, item.residual]), [['notebook', 'legacy-notebook-recovery-pending', 'notebook-projection-blocked']]);
  assert.ok(!library(result).items.some(item => item.title === 'Notebook B')); assert.ok(result.residualReasons.includes('notebook-projection-blocked'));
  assert.deepEqual(result.wholeLibrary.reasons, ['messages-not-converted', 'notebook-extraction-blocked', 'uncollected-source']);
});

test('the ID table and the provenance table refuse a collision (two sources, one target; one source, two targets; one target twice)', () => {
  const entry = (kind: string, source: string[], targetId: string) => ({ kind, source, targetId });
  assertIdTable([entry('a', ['x'], 'T1'), entry('a', ['x'], 'T1'), entry('b', ['y'], 'T2')]);          // the same entry twice is fine
  assert.throws(() => assertIdTable([entry('a', ['x'], 'T1'), entry('b', ['y'], 'T1')]), code('staging-conversion-id-collision'));
  assert.throws(() => assertIdTable([entry('a', ['x'], 'T1'), entry('a', ['x'], 'T2')]), code('staging-conversion-id-collision'));
  assert.throws(() => assertIdTable([entry('a', ['x', 'y'], 'T1'), entry('a', ['x'], 'T1')]), code('staging-conversion-id-collision'));
  const row = (targetKind: 'page' | 'document', targetId: string) => ({ targetKind, targetId, sourceKind: 'file' as const, sourceKey: ['k'], sourceSha256: 'a'.repeat(64) });
  assertProvenanceTable([row('page', 'T1'), row('document', 'T1')]);                                      // one row per (kind, id)
  assert.throws(() => assertProvenanceTable([row('page', 'T1'), row('page', 'T1')]), code('staging-conversion-id-collision'));
});

// input strictness and integrity ---------------------------------------------------------------------------------------------------------------------
test('the rows and resource descriptors are validated with an exact shape', async () => {
  const bad: [string, (data: Data) => void, string][] = [
    ['unknown key in rows', data => { data.rows.extra = []; }, 'staging-conversion-input-invalid'],
    ['missing key in rows', data => { delete data.rows.links; }, 'staging-conversion-input-invalid'],
    ['unknown key in an item', data => { data.rows.items[0].extra = 1; }, 'staging-conversion-input-invalid'],
    ['a paper row with a missing column', data => { delete data.rows.items[0].columns.tags; }, 'staging-conversion-input-invalid'],
    ['a boolean in a column', data => { data.rows.items[0].columns.pages = true; }, 'staging-conversion-input-invalid'],
    ['an id that is not 32 hex', data => { data.rows.items[0].id = 'x'; }, 'staging-conversion-input-invalid'],
    ['the column id differs from the row id', data => { data.rows.items[0].columns.id = 'f'.repeat(32); }, 'staging-conversion-input-invalid'],
    ['folder parts that do not join to the path', data => { data.rows.folders[1].path = 'Folder / Other'; }, 'staging-conversion-input-invalid'],
    ['a resolved link with a reason', data => { data.rows.links[0].reason = 'x'; }, 'staging-conversion-input-invalid'],
    ['an unresolved link without a reason', data => { data.rows.links[0].status = 'unresolved'; data.rows.links[0].reason = null; }, 'staging-conversion-input-invalid'],
    ['an invalid mirror state', data => { data.rows.markdown[0].mirror = 'maybe'; }, 'staging-conversion-input-invalid'],
    ['an ink row of another side with extra keys', data => { data.rows.pdfs[0].inkRows.push({ side: 'translated', page: 1, strokeCount: 0, strokes: [] }); }, 'staging-conversion-input-invalid'],
    ['a bookmark record with a missing field', data => { delete data.rows.pdfs[0].bookmarkRows[0].record.quote; }, 'staging-conversion-input-invalid'],
    ['a duplicate item', data => { data.rows.items.push(structuredClone(data.rows.items[0])); }, 'staging-conversion-input-invalid'],
    ['a kind list that differs from the items', data => { data.rows.markdown = []; }, 'staging-conversion-input-mismatch'],
    ['a notebook list that differs from the manifest', data => { data.rows.notebooks.pop(); data.rows.items.splice(1, 1); }, 'staging-conversion-input-mismatch'],
    ['resources: unknown key', data => { data.resources[0].extra = 1; }, 'staging-conversion-input-invalid'],
    ['resources: pdf kind without pages', data => { data.resources[0].pdfPages = null; }, 'staging-conversion-input-invalid'],
    ['resources: a page with a zero size', data => { data.resources[0].pdfPages[0].widthPt = 0; }, 'staging-conversion-input-invalid'],
    ['resources: no pages', data => { data.resources[0].pdfPages = []; }, 'staging-conversion-input-invalid'],
    ['resources: an ID that is not a canonical Id', data => { data.resources[0].resourceId = 'x'; }, 'staging-conversion-input-invalid'],
    ['resources: the same ID twice', data => { data.resources.push(structuredClone(data.resources[0])); }, 'staging-conversion-input-invalid'],
    ['webAnnotationOpsRows: negative', data => { data.webAnnotationOpsRows = -1; }, 'staging-conversion-input-invalid'],
    ['webAnnotationOpsRows: a string', data => { (data as { webAnnotationOpsRows: unknown }).webAnnotationOpsRows = '0'; }, 'staging-conversion-input-invalid'],
    ['a resource whose ID is not the stable ID of its source', data => { data.resources[0].resourceId = LIBRARY_ID; }, 'staging-conversion-resource-mismatch'],
    ['a resource that is not the manifest file (hash)', data => { data.resources[0].sha256 = hex('x'); }, 'staging-conversion-resource-mismatch'],
    ['a resource that is not the manifest file (size)', data => { data.resources[0].byteLength = 1; }, 'staging-conversion-resource-mismatch'],
  ];
  for (const [name, change, expected] of bad) { const data = await fresh(); change(data); await assert.rejects(run(data), code(expected), name); }
  // the manifest and the extractions keep their own closed codes
  const tampered = await fresh(); tampered.manifest.notebooks[0].pageIds[0] = 'e'.repeat(32);
  await assert.rejects(run(tampered), code('conversion-input-manifest-invalid'));
  const missing = await fresh(); missing.extractions.delete(A);
  await assert.rejects(run(missing), code('conversion-input-extraction-missing'));
  await assert.rejects(run({ ...(await fresh()), rows: () => 1 } as unknown as Data), code('staging-conversion-input-invalid'));
});
test('the unit payloads are always canonical snapshots', async () => {
  for (const options of [{}, { image: true }, { translated: true }] as Parameters<typeof scenario>[0][]) {
    const plan = await run(await fresh(options));
    for (const unit of plan.units) assertSnapshot(unit.payload);
    assert.ok(plan.units.every(unit => unit.payload.id === unit.targetId));
    // every PDF page names a staged resource whose dimensions it carries
    for (const unit of plan.units) if (unit.payload.kind === 'document') for (const page of unit.payload.pages) if (page.background.kind === 'pdf') {
      const background = page.background;
      assert.ok(plan.resources.some(resource => resource.resourceId === background.resourceId && resource.sha256 === background.sourceRevision));
    }
    // every library item has a content root of its own id, and every resource of a Markdown note is staged
    const lib = library(plan);
    for (const item of lib.items) assert.ok(plan.units.some(unit => unit.targetId === item.id && unit.unitKind === (item.kind === 'markdown' ? 'markdown' : 'document')));
    for (const unit of plan.units) if (unit.payload.kind === 'markdown') for (const image of unit.payload.imageResources) assert.ok(plan.resources.some(resource => resource.resourceId === image.resourceId));
  }
  void pdfRows; void stroke;
});
