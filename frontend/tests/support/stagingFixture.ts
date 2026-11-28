import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { editContentHash } from '../../src/runtime/edits/editContentHash.ts';
import type { ConversionInputManifest, NotebookExtraction } from '../../src/migrations/legacyConversionInput.ts';
import { migrationStableId } from '../../src/migrations/stableId.ts';
import { PAPER_COLUMNS } from '../../src/migrations/legacyStagingInput.ts';
import { legacyBookmarkFixture } from './legacyBookmarkFixture.ts';

// A synthetic staging-conversion input (work B7-e tests): the manifest and Notebook extractions of the B6 fixture, plus the rows work B7-d returns and
// the resource descriptors the writer hands over. Everything is built here by hand from the DESIGN (never from the code under test), as plain JSON data.
const shared = JSON.parse(readFileSync(new URL('../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
export const LIBRARY_ID: string = shared.libraryId;
export const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const A = 'a'.repeat(32), B = 'b'.repeat(32), P = 'c'.repeat(32), M = 'd'.repeat(32);
export const PDF_SHA = hex('pdf-bytes-of-P'), IMAGE_SHA = hex('png-bytes-1');
export const PDF_PAGES = [{ widthPt: 595.2756, heightPt: 841.8898 }, { widthPt: 612, heightPt: 792 }, { widthPt: 841.8898, heightPt: 595.2756 }];
export const stroke = (name: string, points: number[][] = [[.2, .3], [.4, .5]]) => ({ id: name, color: '#123456', width: .002, points });
export const MEDIA_NAME = 'ink-capture-1.png';

export type Data = {
  manifest: ConversionInputManifest; extractions: Map<string, NotebookExtraction>; rows: any; resources: any[]; webAnnotationOpsRows: number;
};

// ---- Notebook A (2 pages) and B (3 pages): the same shapes as the B6 fixture and the Python main fixture -----------------------------------------------
type Layout = { note: string; pages: number; ink: Record<number, number>; notes: Record<number, number>; highlights: Record<number, number> };
const layouts: Layout[] = [
  { note: A, pages: 2, ink: { 2: 2 }, notes: { 1: 1 }, highlights: { 2: 1 } },
  { note: B, pages: 3, ink: { 1: 1, 3: 2 }, notes: { 2: 2 }, highlights: {} },
];
const pageId = (note: string, number: number) => note[0].repeat(31) + String(number);
function extraction(layout: Layout): NotebookExtraction {
  const pages = Array.from({ length: layout.pages }, (_, index) => ({ id: pageId(layout.note, index + 1), size: 'A4', orientation: 'portrait',
    width_mm: 210, height_mm: 297, template: 'blank', color: 'white' }));
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, revision: 1, pages }));
  let nextId = 1;
  const marks = legacyBookmarkFixture(layout.note, 1);
  const note = marks.find(mark => mark.kind === 'note')!, highlight = marks.find(mark => mark.kind === 'highlight')!;
  return { libraryId: LIBRARY_ID, sourceDocumentId: layout.note, entry: { sha256: sha(bytes), byteLength: bytes.byteLength }, bytes,
    annotations: pages.map((page, index) => ({ pageId: page.id,
      ink: Array.from({ length: layout.ink[index + 1] ?? 0 }, (_, count) => stroke(`s${index}-${count}`)),
      bookmarks: [...Array.from({ length: layout.notes[index + 1] ?? 0 }, () => ({ ...note, id: nextId++, page: index + 1 })),
        ...Array.from({ length: layout.highlights[index + 1] ?? 0 }, () => ({ ...highlight, id: nextId++, page: index + 1 }))] })) };
}
function notebookEntry(layout: Layout, value: NotebookExtraction): ConversionInputManifest['notebooks'][number] {
  const ids = value.annotations.map(item => item.pageId);
  const ink = value.annotations.flatMap((item, index) => (item.ink as unknown[]).length
    ? [{ side: 'original', page: index + 1, pageId: item.pageId, strokeCount: (item.ink as unknown[]).length }] : []);
  const bookmarks = value.annotations.flatMap((item, index) => (item.bookmarks as { id: number; kind: string }[]).map(mark =>
    ({ id: String(mark.id), page: index + 1, side: 'original', kind: mark.kind, pageId: item.pageId })));
  return { sourceDocumentId: layout.note, notebookEntry: { ...value.entry }, pageIds: ids,
    rows: { pages: ids.map((id, index) => ({ number: index + 1, pageId: id })), ink, bookmarks },
    status: 'extracted', reason: null, coverage: { pageRows: ids.length, inkRows: ink.length, bookmarkRows: bookmarks.length }, incomplete: ['page-text-not-converted'] };
}
export async function seal(manifest: ConversionInputManifest): Promise<ConversionInputManifest> {
  const { manifestSha256: _old, ...body } = manifest;
  return { ...body, manifestSha256: await editContentHash(body) };
}

// ---- rows (work B7-d) ---------------------------------------------------------------------------------------------------------------------------------
type RowOptions = { title?: unknown; collection?: string; parent?: string | null; tags?: unknown; created?: string; position?: number; sha?: string; pages?: number };
export function paperRow(id: string, kind: string, options: RowOptions = {}) {
  const collection = options.collection ?? '';
  const path = collection.split(/[\\/]/).map(part => part.trim()).filter(Boolean).join(' / ');
  const columns: Record<string, unknown> = {
    id, sha256: options.sha ?? hex('sha-' + id), title: options.title ?? `Title ${kind} ${id[0]}`, original_name: 'x', pages: options.pages ?? 0, status: 'imported',
    collection_name: collection, note: '', created_at: options.created ?? `2026-01-01 00:00:0${'abcdefgh'.indexOf(id[0])}`,
    tags: typeof options.tags === 'string' ? options.tags : JSON.stringify(options.tags ?? []), read_status: '未読', first_author: '', publication_year: '',
    bibliography_version: 0, doi: '', arxiv_id: '', venue: '', kind, parent_id: options.parent ?? null, note_position: options.position ?? 0 };
  if (!Object.keys(columns).every(key => (PAPER_COLUMNS as readonly string[]).includes(key))) throw new Error('fixture columns differ from PAPER_COLUMNS');
  return { id, kind, columns, collectionPath: path, collectionParts: path ? path.split(' / ') : [], sourceSha256: hex('row-' + id) };
}
const mark = (page: number, kind: 'note' | 'highlight', id: number, side = 'original') => {
  const base = legacyBookmarkFixture(P, page, side as 'original').find(item => item.kind === kind)!;
  return { ...base, id: String(id), page };
};
export async function pdfRows(options: { pages?: number; sizes?: typeof PDF_PAGES; translated?: boolean; ink?: Record<number, number>; marks?: [number, 'note' | 'highlight'][] } = {}) {
  const pages = options.pages ?? 3, ink = options.ink ?? { 2: 2, 3: 1 }, marks = options.marks ?? [[1, 'note'], [3, 'highlight']];
  const inkRows = Object.entries(ink).map(([page, count]) => ({ side: 'original', page: Number(page), strokeCount: count,
    strokes: Array.from({ length: count }, (_, index) => stroke(`p${page}-${index}`)), sourceSha256: hex(`ink-${page}`) }));
  const bookmarkRows = marks.map(([page, kind], index) => { const record = mark(page, kind, index + 1);
    return { id: record.id as string, side: 'original', page, kind, record, sourceSha256: hex(`mark-${index + 1}`) }; });
  const annotationPages: Record<string, { rowCount: number; sourceSha256: string }> = {};
  for (let page = 1; page <= pages; page++) {
    const hashes = [...inkRows.filter(row => row.page === page), ...bookmarkRows.filter(row => row.page === page)].map(row => row.sourceSha256);
    if (hashes.length) annotationPages[String(page)] = { rowCount: hashes.length, sourceSha256: await editContentHash([...hashes].sort()) };
  }
  const other: unknown[] = [], otherMarks: unknown[] = [];
  if (options.translated) { other.push({ side: 'translated', page: 1, strokeCount: 2 }); otherMarks.push({ id: '90', side: 'translated', page: 1, kind: 'note' }); }
  const noteRows = marks.filter(item => item[1] === 'note').length, highlightRows = marks.length - noteRows;
  return { id: P, pagesColumn: pages, file: { sha256: PDF_SHA, byteLength: 4321 }, fileMatchesRow: true,
    counts: { pageRows: pages, pageTextRows: pages, pageNumbersContiguous: true,
      ink: { original: inkRows.length, other: other.length }, strokes: { original: Object.values(ink).reduce((sum, count) => sum + count, 0), other: other.length ? 2 : 0 },
      bookmarks: { note: { original: noteRows, other: otherMarks.length }, highlight: { original: highlightRows, other: 0 }, other: { original: 0, other: 0 } } },
    pageNumbers: Array.from({ length: pages }, (_, index) => index + 1), inkRows: [...inkRows, ...other], bookmarkRows: [...bookmarkRows, ...otherMarks], annotationPages, problems: [] };
}
export const markdownRow = (content: string | null, media: { name: string; sha256: string; byteLength: number }[] = [], mirror = 'match') => {
  const bytes = content === null ? null : new TextEncoder().encode(content);
  return { id: M, state: 'present', revision: hex('revision-M').slice(0, 32), source: 'user', updatedAt: '2026-01-02 03:04:05', legacyNoteId: null, content,
    contentBytes: bytes === null ? null : bytes.byteLength, contentSha256: bytes === null ? null : sha(bytes), mirror, media, sourceSha256: hex('note-state-M'), legacySourceSha256: null };
};
export const folderRow = (path: string) => { const parts = path.split(' / ');
  return { path, parts, parent: parts.length > 1 ? parts.slice(0, -1).join(' / ') : null, rowCount: 1, sourceSha256: hex('folder-' + path) }; };
export const linkRow = (pdf: string, note: string, noteKind = 'notebook') => ({ a: [pdf, note].sort()[0], b: [pdf, note].sort()[1], status: 'resolved', reason: null,
  pdfId: pdf, noteId: note, noteKind, sourceSha256: hex(`link-${pdf}-${note}`) });
export async function pdfResource(sha256 = PDF_SHA, pages = PDF_PAGES, byteLength = 4321) {
  const sourceKey = ['papers', P, 'original.pdf'];
  return { kind: 'pdf', resourceId: await migrationStableId(LIBRARY_ID, 'resource', ['pdf-original', ...sourceKey, sha256]), sourceKey, sha256, byteLength,
    mediaType: 'application/pdf', pdfPages: structuredClone(pages) };
}
export async function imageResource(name = MEDIA_NAME, sha256 = IMAGE_SHA, mediaType = 'image/png', byteLength = 4) {
  const sourceKey = ['papers', M, 'media', name];
  return { kind: 'image', resourceId: await migrationStableId(LIBRARY_ID, 'resource', ['markdown-image', ...sourceKey, sha256]), sourceKey, sha256, byteLength, mediaType, pdfPages: null };
}

/** The main fixture: A (root), B (Folder / Sub), P (Folder), M owned by P; link P-A; folders Folder and Folder / Sub. */
export async function scenario(options: { image?: boolean; translated?: boolean; content?: string } = {}): Promise<Data> {
  const extractions = new Map(layouts.map(layout => [layout.note, extraction(layout)]));
  const manifest = await seal({
    version: 1, scope: 'native-legacy-conversion-input-v1', runId: randomUUID(), peerId: randomUUID(), libraryId: LIBRARY_ID,
    journalRecordSha256: hex('record'), selectionSha256: hex('selection'), inputSetSha256: hex('inputs'),
    sources: (['desktop-library', 'canonical', 'device'] as const).map(kind => ({ kind, sourceId: hex('source-' + kind), backupId: randomUUID(),
      planSha256: hex('plan-' + kind), observationSha256: hex('observation-' + kind), inventorySha256: hex('inventory-' + kind), entryCount: 12, totalBytes: 3456 })),
    inventory: { reportSha256: hex('report'), summary: { supported: 40, retainedBlocking: 6, unknown: 0, blockingReasons: ['messages-not-converted'] } },
    sqlite: { journalMode: 'rollback', walEntries: [], walComplete: true, userVersion: 9, quickCheck: 'ok', notebooksListable: true },
    notebooks: layouts.map(layout => notebookEntry(layout, extractions.get(layout.note)!)),
    wholeLibrary: { status: 'refused', reasons: ['messages-not-converted', 'uncollected-source'] }, manifestSha256: '0'.repeat(64),
  });
  const content = options.content ?? (options.image ? `# memo\n![capture](media/${MEDIA_NAME})\n\nSee [p.2](papeer://${P}/2).` : '# memo\nbody');
  const media = options.image ? [{ name: MEDIA_NAME, sha256: IMAGE_SHA, byteLength: 4 }] : [];
  const rows = {
    items: [paperRow(A, 'notebook', { title: 'Notebook A', tags: ['idea', '研究'], created: '2026-01-01 00:00:01' }),
      paperRow(B, 'notebook', { title: 'Notebook B', collection: 'Folder / Sub', created: '2026-01-01 00:00:02' }),
      paperRow(P, 'pdf', { title: 'Paper P', collection: 'Folder', sha: PDF_SHA, pages: 3, tags: ['read-later'], created: '2026-01-01 00:00:03' }),
      paperRow(M, 'markdown', { title: 'Memo M', parent: P, created: '2026-01-01 00:00:04', position: 0 })],
    folders: [folderRow('Folder'), folderRow('Folder / Sub')], links: [linkRow(P, A)],
    markdown: [markdownRow(content, media)], pdfs: [await pdfRows({ translated: options.translated })],
    notebooks: layouts.map(layout => ({ id: layout.note, pageRows: layout.pages, pageTextRows: 0, pageNumbersContiguous: true, ink: {}, strokes: {}, bookmarks: {} })),
  };
  return { manifest, extractions, rows, resources: [await pdfResource(), ...(options.image ? [await imageResource()] : [])], webAnnotationOpsRows: 0 };
}
