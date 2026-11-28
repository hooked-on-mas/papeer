import { editSchema } from '../runtime/edits/contracts.ts';
import { validateStructure } from '../runtime/edits/schemaValidator.ts';

// Input contract and shared result types of the staging converters (work B7-e, DESIGN-r161-b7-staging.md 7.3).
// The input is exactly what work B7-d (papeer/core/migrations/legacy_staging_rows.py `extract_staging_rows(...)['rows']`)
// returns, serialized as JSON, plus the resource descriptors the Python side made from verified backup objects.
// Everything is validated with an exact key set (unknown and missing keys are both refused). Nothing here reads a file,
// the clock or a random source, and nothing is stored.
//
// Every failure is an Error whose message is one closed code (no path, text or cause is carried).
export const STAGING_CONVERTER_VERSION = 'b7-v1';
export const STAGING_PLAN_SCOPE = 'native-legacy-staging-plan-v1';
export const STAGING_ERRORS = ['staging-conversion-input-invalid', 'staging-conversion-input-mismatch', 'staging-conversion-resource-mismatch',
  'staging-conversion-count-mismatch', 'staging-conversion-id-collision', 'staging-conversion-invalid-result'] as const;
export type StagingError = (typeof STAGING_ERRORS)[number];
export const stagingFail = (code: StagingError): never => { throw new Error(code); };

// ---- result types shared by the converters ---------------------------------------------------------------
/** One old->new ID (DESIGN 3.4). `kind`/`source` are the arguments of migrationStableId. */
export type IdEntry = { kind: string; source: string[]; targetId: string };
/** One provenance row (DESIGN 3.5). The run, manifest and converter version are added by the writer / the plan header. */
export type ProvenanceRow = {
  targetKind: 'resource' | 'document' | 'markdown' | 'library' | 'library-item' | 'folder' | 'link' | 'page' | 'annotation';
  targetId: string; sourceKind: 'file' | 'row' | 'rows' | 'derived'; sourceKey: string[]; sourceSha256: string;
};
/** Something that was NOT converted, and the residual reason (a DESIGN 6.2 / B6 reason code) it keeps alive. */
export type NotConverted = { sourceKey: string[]; kind: 'pdf' | 'markdown' | 'notebook' | 'item' | 'link' | 'folder' | 'pdf-annotation' | 'markdown-media' | 'markdown-link';
  reason: string; residual: string; count: number };
/**
 * The Markdown parser the image check needs, injected by the caller. The one-time converters are the domain layer: they may not import the Markdown
 * packages (tests/sharedEntries.test.mjs "one-time converters depend on the common model..."), so the parse is a port, like the PDF inspection port of
 * the edit runtime. `imageUrls` is the URL of every image the Markdown dialect of the product (runtime/markdown/markdownImages.ts) sees, in document order
 * (an image through a reference definition counts with the definition's URL); `analyze` is that module's `analyzeMarkdownImages`. The converter never
 * trusts the port blindly: it checks the parser's answers against the text it rewrote (legacyMarkdown.ts).
 */
export type MarkdownImagePort = {
  imageUrls(content: string): string[];
  analyze(content: string): { imageResources: { resourceId: string; sha256: string }[]; problems: string[] };
};
export type ResourceUse = { resourceId: string; sha256: string; byteLength: number; mediaType: string; sourceKey: string[]; usedBy: string[] };

// ---- strict validators ------------------------------------------------------------------------------------
const bad = (): never => stagingFail('staging-conversion-input-invalid');
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function record(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) return bad();
  return value;
}
export const array = (value: unknown): unknown[] => Array.isArray(value) && Object.keys(value).length === value.length ? value : bad();
export const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : bad();
/** A raw integer column (a page number may be negative in a damaged Library; the converters decide what that means). */
export const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) ? value : bad();
export const hex64 = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : bad();
export const hex32 = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : bad();
export const text = (value: unknown): string => typeof value === 'string' ? value : bad();
export const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : bad();
export const orNull = <T>(value: unknown, read: (item: unknown) => T): T | null => value === null ? null : read(value);
export function id(value: unknown): string {
  try { validateStructure(editSchema, 'Id', value); } catch { return bad(); }
  return value as string;
}
const code = (value: unknown): string => typeof value === 'string' && /^[a-z0-9-]{1,96}$/.test(value) ? value : bad();
/** A raw SQLite value as the rows carry it: text, a number or NULL (a BLOB never reaches the converters). */
const scalar = (value: unknown): string | number | null =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : bad();

export const PAPER_COLUMNS = ['id', 'sha256', 'title', 'original_name', 'pages', 'status', 'collection_name', 'note', 'created_at', 'tags',
  'read_status', 'first_author', 'publication_year', 'bibliography_version', 'doi', 'arxiv_id', 'venue', 'kind', 'parent_id', 'note_position'] as const;
export const BOOKMARK_KEYS = ['id', 'paper_id', 'page', 'side', 'quote', 'label', 'note', 'anchor_y', 'created_at', 'anchor_x', 'kind', 'color', 'rects'] as const;

export type PaperRow = { id: string; kind: string; columns: Record<(typeof PAPER_COLUMNS)[number], string | number | null>;
  collectionPath: string | null; collectionParts: string[]; sourceSha256: string };
export type FolderRow = { path: string; parts: string[]; parent: string | null; rowCount: number; sourceSha256: string };
export type LinkRow = { a: string; b: string; status: 'resolved' | 'unresolved'; reason: string | null; pdfId: string | null; noteId: string | null;
  noteKind: string | null; sourceSha256: string };
export type MediaEntry = { name: string; sha256: string; byteLength: number };
export type MarkdownRow = { id: string; state: 'present' | 'missing'; revision: string | null; source: string | null; updatedAt: string | null;
  legacyNoteId: string | null; content: string | null; contentBytes: number | null; contentSha256: string | null;
  mirror: 'match' | 'mismatch' | 'missing' | 'unchecked'; media: MediaEntry[]; sourceSha256: string | null; legacySourceSha256: string | null };
type Sided<T> = { original: T; other: T };
export type PdfCounts = { pageRows: number; pageTextRows: number; pageNumbersContiguous: boolean; ink: Sided<number>; strokes: Sided<number>;
  bookmarks: { note: Sided<number>; highlight: Sided<number>; other: Sided<number> } };
export type PdfInkRow = { side: string; page: number | null; strokeCount: number | null; strokes?: unknown[] | null; sourceSha256?: string };
export type PdfBookmarkRow = { id: string; side: string; page: number | null; kind: string; record?: Record<string, unknown>; sourceSha256?: string };
export type PdfRow = { id: string; pagesColumn: number | null; file: { sha256: string; byteLength: number } | null; fileMatchesRow: boolean | null;
  counts: PdfCounts; pageNumbers: number[]; inkRows: PdfInkRow[]; bookmarkRows: PdfBookmarkRow[];
  annotationPages: Record<string, { rowCount: number; sourceSha256: string }>; problems: string[] };
export type StagingRows = { items: PaperRow[]; folders: FolderRow[]; links: LinkRow[]; markdown: MarkdownRow[]; pdfs: PdfRow[]; notebooks: { id: string }[] };
export type ResourceDescriptor = { kind: 'pdf' | 'image'; resourceId: string; sourceKey: string[]; sha256: string; byteLength: number; mediaType: string;
  pdfPages: { widthPt: number; heightPt: number }[] | null };

const sided = (value: unknown): Sided<number> => { const item = record(value, ['original', 'other']); return { original: count(item.original), other: count(item.other) }; };
function pdfCounts(value: unknown): PdfCounts {
  const item = record(value, ['pageRows', 'pageTextRows', 'pageNumbersContiguous', 'ink', 'strokes', 'bookmarks']);
  const marks = record(item.bookmarks, ['note', 'highlight', 'other']);
  return { pageRows: count(item.pageRows), pageTextRows: count(item.pageTextRows), pageNumbersContiguous: bool(item.pageNumbersContiguous),
    ink: sided(item.ink), strokes: sided(item.strokes), bookmarks: { note: sided(marks.note), highlight: sided(marks.highlight), other: sided(marks.other) } };
}
function paperRow(value: unknown): PaperRow {
  const item = record(value, ['id', 'kind', 'columns', 'collectionPath', 'collectionParts', 'sourceSha256']);
  const columns = record(item.columns, PAPER_COLUMNS);
  const read: Record<string, string | number | null> = {};
  for (const name of PAPER_COLUMNS) read[name] = scalar(columns[name]);
  const result: PaperRow = { id: hex32(item.id), kind: text(item.kind), columns: read as PaperRow['columns'],
    collectionPath: orNull(item.collectionPath, text), collectionParts: array(item.collectionParts).map(text), sourceSha256: hex64(item.sourceSha256) };
  if (result.columns.id !== result.id || result.columns.kind !== result.kind) bad();
  const path = result.collectionPath;
  if ((path === null || path === '' ? result.collectionParts.length !== 0 : result.collectionParts.join(' / ') !== path)) bad();
  return result;
}
function folderRow(value: unknown): FolderRow {
  const item = record(value, ['path', 'parts', 'parent', 'rowCount', 'sourceSha256']);
  const parts = array(item.parts).map(text), path = text(item.path), parent = orNull(item.parent, text);
  if (!parts.length || parts.join(' / ') !== path || (parts.length === 1 ? parent !== null : parent !== parts.slice(0, -1).join(' / '))) bad();
  return { path, parts, parent, rowCount: count(item.rowCount), sourceSha256: hex64(item.sourceSha256) };
}
function linkRow(value: unknown): LinkRow {
  const item = record(value, ['a', 'b', 'status', 'reason', 'pdfId', 'noteId', 'noteKind', 'sourceSha256']);
  const status = item.status === 'resolved' || item.status === 'unresolved' ? item.status : bad();
  const result: LinkRow = { a: hex32(item.a), b: hex32(item.b), status, reason: orNull(item.reason, code), pdfId: orNull(item.pdfId, hex32),
    noteId: orNull(item.noteId, hex32), noteKind: orNull(item.noteKind, text), sourceSha256: hex64(item.sourceSha256) };
  const resolved = status === 'resolved';
  if (resolved ? result.reason !== null || result.pdfId === null || result.noteId === null || result.noteKind === null
    || [result.pdfId, result.noteId].sort().join('|') !== [result.a, result.b].sort().join('|')
    : result.reason === null || result.pdfId !== null || result.noteId !== null || result.noteKind !== null) bad();
  return result;
}
function markdownRow(value: unknown): MarkdownRow {
  const item = record(value, ['id', 'state', 'revision', 'source', 'updatedAt', 'legacyNoteId', 'content', 'contentBytes', 'contentSha256', 'mirror',
    'media', 'sourceSha256', 'legacySourceSha256']);
  const state = item.state === 'present' || item.state === 'missing' ? item.state : bad();
  const mirror = item.mirror === 'match' || item.mirror === 'mismatch' || item.mirror === 'missing' || item.mirror === 'unchecked' ? item.mirror : bad();
  const result: MarkdownRow = { id: hex32(item.id), state, revision: orNull(item.revision, text), source: orNull(item.source, text),
    updatedAt: orNull(item.updatedAt, text), legacyNoteId: orNull(item.legacyNoteId, text), content: orNull(item.content, text),
    contentBytes: orNull(item.contentBytes, count), contentSha256: orNull(item.contentSha256, hex64), mirror,
    media: array(item.media).map(entry => { const media = record(entry, ['name', 'sha256', 'byteLength']);
      return { name: text(media.name), sha256: hex64(media.sha256), byteLength: count(media.byteLength) }; }),
    sourceSha256: orNull(item.sourceSha256, hex64), legacySourceSha256: orNull(item.legacySourceSha256, hex64) };
  if (state === 'missing' && (result.revision !== null || result.content !== null || result.sourceSha256 !== null)) bad();
  return result;
}
function pdfRow(value: unknown): PdfRow {
  const item = record(value, ['id', 'pagesColumn', 'file', 'fileMatchesRow', 'counts', 'pageNumbers', 'inkRows', 'bookmarkRows', 'annotationPages', 'problems']);
  const pages = isRecord(item.annotationPages) ? item.annotationPages : bad();
  return { id: hex32(item.id), pagesColumn: orNull(item.pagesColumn, count),
    file: orNull(item.file, file => { const entry = record(file, ['sha256', 'byteLength']); return { sha256: hex64(entry.sha256), byteLength: count(entry.byteLength) }; }),
    fileMatchesRow: orNull(item.fileMatchesRow, bool), counts: pdfCounts(item.counts), pageNumbers: array(item.pageNumbers).map(integer),
    inkRows: array(item.inkRows).map(row => {
      if (!isRecord(row)) return bad();
      const original = row.side === 'original';
      const entry = record(row, original ? ['side', 'page', 'strokeCount', 'strokes', 'sourceSha256'] : ['side', 'page', 'strokeCount']);
      const result: PdfInkRow = { side: text(entry.side), page: orNull(entry.page, integer), strokeCount: orNull(entry.strokeCount, count) };
      if (original) { result.strokes = orNull(entry.strokes, strokes => array(strokes)); result.sourceSha256 = hex64(entry.sourceSha256); }
      return result;
    }),
    bookmarkRows: array(item.bookmarkRows).map(row => {
      if (!isRecord(row)) return bad();
      const original = row.side === 'original';
      const entry = record(row, original ? ['id', 'side', 'page', 'kind', 'record', 'sourceSha256'] : ['id', 'side', 'page', 'kind']);
      const result: PdfBookmarkRow = { id: text(entry.id), side: text(entry.side), page: orNull(entry.page, integer), kind: text(entry.kind) };
      if (original) { result.record = record(entry.record, BOOKMARK_KEYS); result.sourceSha256 = hex64(entry.sourceSha256); }
      return result;
    }),
    annotationPages: Object.fromEntries(Object.entries(pages).map(([page, value]) => {
      const entry = record(value, ['rowCount', 'sourceSha256']);
      if (!/^[1-9][0-9]{0,8}$/.test(page)) bad();
      return [page, { rowCount: count(entry.rowCount), sourceSha256: hex64(entry.sourceSha256) }];
    })),
    problems: array(item.problems).map(code) };
}

/** The `rows` of work B7-d, exactly. Duplicate IDs are refused. */
export function assertStagingRows(value: unknown): StagingRows {
  const rows = record(value, ['items', 'folders', 'links', 'markdown', 'pdfs', 'notebooks']);
  const result: StagingRows = { items: array(rows.items).map(paperRow), folders: array(rows.folders).map(folderRow), links: array(rows.links).map(linkRow),
    markdown: array(rows.markdown).map(markdownRow), pdfs: array(rows.pdfs).map(pdfRow),
    notebooks: array(rows.notebooks).map(entry => ({ id: hex32(record(entry, ['id', 'pageRows', 'pageTextRows', 'pageNumbersContiguous', 'ink', 'strokes', 'bookmarks']).id) })) };
  const unique = (values: string[]) => { if (new Set(values).size !== values.length) bad(); };
  unique(result.items.map(item => item.id)); unique(result.folders.map(folder => folder.path));
  unique(result.links.map(link => `${link.a}:${link.b}`)); unique(result.markdown.map(note => note.id));
  unique(result.pdfs.map(pdf => pdf.id)); unique(result.notebooks.map(note => note.id));
  const kinds = new Map(result.items.map(item => [item.id, item.kind]));
  for (const [list, kind] of [[result.markdown, 'markdown'], [result.pdfs, 'pdf'], [result.notebooks, 'notebook']] as const)
    if (list.length !== result.items.filter(item => item.kind === kind).length || list.some(entry => kinds.get(entry.id) !== kind)) stagingFail('staging-conversion-input-mismatch');
  return result;
}

/** The resource descriptors the writer made from verified backup objects. Their IDs are checked by the converters (stable-ID rule). */
export function assertResourceDescriptors(value: unknown): ResourceDescriptor[] {
  const list = array(value).map(entry => {
    const item = record(entry, ['kind', 'resourceId', 'sourceKey', 'sha256', 'byteLength', 'mediaType', 'pdfPages']);
    const kind = item.kind === 'pdf' || item.kind === 'image' ? item.kind : bad();
    const pdfPages = orNull(item.pdfPages, pages => array(pages).map(page => {
      const size = record(page, ['widthPt', 'heightPt']);
      if (typeof size.widthPt !== 'number' || typeof size.heightPt !== 'number' || !Number.isFinite(size.widthPt) || !Number.isFinite(size.heightPt)
        || !(size.widthPt > 0) || !(size.heightPt > 0)) bad();
      return { widthPt: size.widthPt as number, heightPt: size.heightPt as number };
    }));
    if (pdfPages !== null && (!pdfPages.length || pdfPages.length > 100000)) bad();
    const sourceKey = array(item.sourceKey).map(text);
    if (!sourceKey.length || sourceKey.some(part => !part || Array.from(part).length > 1000)) bad();
    if (typeof item.mediaType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/.test(item.mediaType)
      || (kind === 'pdf') !== (pdfPages !== null) || (kind === 'pdf') !== (item.mediaType === 'application/pdf')) bad();
    return { kind, resourceId: id(item.resourceId), sourceKey, sha256: hex64(item.sha256), byteLength: count(item.byteLength), mediaType: item.mediaType, pdfPages } as ResourceDescriptor;
  });
  if (new Set(list.map(entry => entry.resourceId)).size !== list.length || new Set(list.map(entry => entry.sourceKey.join('\0'))).size !== list.length) bad();
  return list;
}

/** The stable-ID source of a resource (DESIGN 3.4): [sourceKind, ...backup key, entry sha256]. */
export const resourceSource = (descriptor: Pick<ResourceDescriptor, 'kind' | 'sourceKey' | 'sha256'>): string[] =>
  [descriptor.kind === 'pdf' ? 'pdf-original' : 'markdown-image', ...descriptor.sourceKey, descriptor.sha256];

/** The old->new ID table (DESIGN 3.4): one target for one (kind, source) and one (kind, source) for one target. The same entry twice is fine. */
export function assertIdTable(ids: readonly IdEntry[]): void {
  const bySource = new Map<string, string>(), byTarget = new Map<string, string>();
  for (const entry of ids) {
    const source = JSON.stringify([entry.kind, entry.source]);
    if (bySource.has(source) && bySource.get(source) !== entry.targetId) stagingFail('staging-conversion-id-collision');
    if (byTarget.has(entry.targetId) && byTarget.get(entry.targetId) !== source) stagingFail('staging-conversion-id-collision');
    bySource.set(source, entry.targetId); byTarget.set(entry.targetId, source);
  }
}
/** Provenance (DESIGN 3.5) has one row per (target kind, target id). */
export function assertProvenanceTable(rows: readonly ProvenanceRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) { const key = `${row.targetKind}|${row.targetId}`; if (seen.has(key)) stagingFail('staging-conversion-id-collision'); seen.add(key); }
}
