import { editSchema, type DocumentSnapshot, type PageAnnotation } from '../runtime/edits/contracts.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { validateStructure } from '../runtime/edits/schemaValidator.ts';
import { projectLegacyNotebookEntry } from './legacyNotebookProjection.ts';
import type { MigrationIdMapping } from './legacyPage.ts';

// Pure, read-only half of work B6 (conversion input). The Python side (sidecar/migrations/conversion_input.py)
// returns a manifest and, for the Notebooks it could extract, the verified entry bytes plus the original-page rows.
// This module (1) validates the manifest exactly, (2) projects each extracted Notebook with the existing
// projectLegacyNotebookEntry and (3) requires the projected document to contain exactly the pages, strokes and
// bookmarks that the manifest counted from SQLite. Nothing is stored, nothing is written, and the whole Library is
// never accepted: `wholeLibrary.status` is the literal 'refused' in the type and the value.
//
// Every failure is an Error whose message is one closed code (no path, text or cause is carried):
//   conversion-input-manifest-invalid, conversion-input-entry-mismatch, conversion-input-count-mismatch,
//   conversion-input-extraction-missing, conversion-input-extraction-unexpected.

export const CONVERSION_INPUT_SCOPE = 'native-legacy-conversion-input-v1';
/** Same ceiling the Python side enforces (notebook_preview.MAX_NOTEBOOKS). */
export const MAX_CONVERSION_NOTEBOOKS = 256;
const SOURCE_KINDS = ['desktop-library', 'canonical', 'device'] as const;
const WAL_NAMES = ['library.sqlite3-shm', 'library.sqlite3-wal'] as const;
const CODE = /^[a-z0-9-]{1,96}$/;

type Hex64 = string;
type NotebookEntryRef = { sha256: Hex64; byteLength: number };
type PageRow = { number: number; pageId: string | null };
type InkRow = { side: string; page: number | null; pageId: string | null; strokeCount: number | null };
type BookmarkRow = { id: string; page: number | null; side: string; kind: string; pageId: string | null };
export type ConversionInputNotebook = {
  sourceDocumentId: string; notebookEntry: NotebookEntryRef | null; pageIds: string[];
  rows: { pages: PageRow[]; ink: InkRow[]; bookmarks: BookmarkRow[] };
  status: 'extracted' | 'blocked'; reason: string | null;
  coverage: { pageRows: number; inkRows: number; bookmarkRows: number } | null; incomplete: string[];
};
export type ConversionInputManifest = {
  version: 1; scope: typeof CONVERSION_INPUT_SCOPE; runId: string; peerId: string; libraryId: string;
  journalRecordSha256: Hex64; selectionSha256: Hex64; inputSetSha256: Hex64;
  sources: { kind: (typeof SOURCE_KINDS)[number]; sourceId: Hex64; backupId: string; planSha256: Hex64; observationSha256: Hex64;
    inventorySha256: Hex64; entryCount: number; totalBytes: number }[];
  inventory: { reportSha256: Hex64; summary: { supported: number; retainedBlocking: number; unknown: number; blockingReasons: string[] } };
  sqlite: null | { journalMode: string | null; walEntries: string[]; walComplete: boolean; userVersion: number | null;
    quickCheck: string | null; notebooksListable: boolean };
  notebooks: ConversionInputNotebook[];
  wholeLibrary: { status: 'refused'; reasons: string[] };
  manifestSha256: Hex64;
};
export type NotebookExtraction = {
  libraryId: string; sourceDocumentId: string; entry: { sha256: string; byteLength: number }; bytes: Uint8Array;
  annotations: { pageId: string; ink: unknown; bookmarks: unknown }[];
};
export type ProjectedNotebook =
  | { sourceDocumentId: string; status: 'converted'; document: DocumentSnapshot;
      pageMappings: { sourcePageId: string; targetPageId: string }[];
      counts: { pages: number; ink: number; sticky: number; highlight: number };
      // Added by work B7-e (pure addition; B6 callers ignore them): what the staging conversion records as provenance.
      mappings: MigrationIdMapping[]; provenance: { sourceDocumentId: string; notebookSha256: string; annotationDataSha256: string; revision: number } }
  | { sourceDocumentId: string; status: 'blocked'; reason: string };

const invalid = (): never => { throw new Error('conversion-input-manifest-invalid'); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
/** Exact key set: unknown keys and missing keys are both refused. */
function record(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) return invalid();
  return value;
}
const array = (value: unknown): unknown[] => Array.isArray(value) && Object.keys(value).length === value.length ? value : invalid();
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const hex64 = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid();
const hex32 = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : invalid();
const code = (value: unknown): string => typeof value === 'string' && CODE.test(value) ? value : invalid();
const label = (value: unknown): string => typeof value === 'string' && value.length >= 1 && value.length <= 64 ? value : invalid();
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
const orNull = <T>(value: unknown, read: (item: unknown) => T): T | null => value === null ? null : read(value);
function id(value: unknown): string {
  try { validateStructure(editSchema, 'Id', value); } catch { return invalid(); }
  return value as string;
}
function sortedCodes(value: unknown): string[] {
  const items = array(value).map(code);
  return items.every((item, index) => index === 0 || items[index - 1] < item) ? items : invalid();   // ascending, no duplicates
}

function notebook(value: unknown): ConversionInputNotebook {
  const item = record(value, ['sourceDocumentId', 'notebookEntry', 'pageIds', 'rows', 'status', 'reason', 'coverage', 'incomplete']);
  const rows = record(item.rows, ['pages', 'ink', 'bookmarks']);
  const entry = orNull(item.notebookEntry, entryValue => {
    const entryRecord = record(entryValue, ['sha256', 'byteLength']);
    return { sha256: hex64(entryRecord.sha256), byteLength: count(entryRecord.byteLength) };
  });
  const result: ConversionInputNotebook = {
    sourceDocumentId: hex32(item.sourceDocumentId), notebookEntry: entry, pageIds: array(item.pageIds).map(hex32),
    rows: {
      pages: array(rows.pages).map(row => { const page = record(row, ['number', 'pageId']);
        return { number: count(page.number), pageId: orNull(page.pageId, hex32) }; }),
      ink: array(rows.ink).map(row => { const ink = record(row, ['side', 'page', 'pageId', 'strokeCount']);
        return { side: label(ink.side), page: orNull(ink.page, count), pageId: orNull(ink.pageId, hex32), strokeCount: orNull(ink.strokeCount, count) }; }),
      bookmarks: array(rows.bookmarks).map(row => { const mark = record(row, ['id', 'page', 'side', 'kind', 'pageId']);
        if (typeof mark.id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(mark.id)) invalid();
        return { id: mark.id as string, page: orNull(mark.page, count), side: label(mark.side), kind: label(mark.kind), pageId: orNull(mark.pageId, hex32) }; }),
    },
    status: item.status === 'extracted' || item.status === 'blocked' ? item.status : invalid(),
    reason: orNull(item.reason, code),
    coverage: orNull(item.coverage, coverageValue => { const coverage = record(coverageValue, ['pageRows', 'inkRows', 'bookmarkRows']);
      return { pageRows: count(coverage.pageRows), inkRows: count(coverage.inkRows), bookmarkRows: count(coverage.bookmarkRows) }; }),
    incomplete: array(item.incomplete).map(code),
  };
  if (new Set(result.pageIds).size !== result.pageIds.length) invalid();
  if (result.status === 'blocked') {
    if (result.reason === null || result.coverage !== null) invalid();
    return result;
  }
  // An extracted Notebook is exactly the shape the Python side only builds when every row is mapped (unmapped == 0).
  const { pages, ink, bookmarks } = result.rows, known = new Set(result.pageIds);
  if (result.reason !== null || result.coverage === null || result.notebookEntry === null || !result.pageIds.length
    || pages.length !== result.pageIds.length
    || pages.some((page, index) => page.number !== index + 1 || page.pageId !== result.pageIds[index])
    || result.coverage.pageRows !== pages.length || result.coverage.inkRows !== ink.length || result.coverage.bookmarkRows !== bookmarks.length
    || ink.some(row => row.side !== 'original' || row.strokeCount === null || row.pageId === null || !known.has(row.pageId)
      || row.page === null || result.pageIds[row.page - 1] !== row.pageId)
    || bookmarks.some(row => row.side !== 'original' || (row.kind !== 'note' && row.kind !== 'highlight') || row.pageId === null
      || !known.has(row.pageId) || row.page === null || result.pageIds[row.page - 1] !== row.pageId)
    || new Set(bookmarks.map(row => row.id)).size !== bookmarks.length) invalid();
  return result;
}

/** Exact structural check of the manifest (not its hash; see `assertManifestSeal`). */
export function assertConversionInputManifest(value: unknown): asserts value is ConversionInputManifest {
  const manifest = record(value, ['version', 'scope', 'runId', 'peerId', 'libraryId', 'journalRecordSha256', 'selectionSha256',
    'inputSetSha256', 'sources', 'inventory', 'sqlite', 'notebooks', 'wholeLibrary', 'manifestSha256']);
  if (manifest.version !== 1 || manifest.scope !== CONVERSION_INPUT_SCOPE) invalid();
  [manifest.runId, manifest.peerId, manifest.libraryId].forEach(id);
  [manifest.journalRecordSha256, manifest.selectionSha256, manifest.inputSetSha256, manifest.manifestSha256].forEach(hex64);
  const sources = array(manifest.sources);
  if (sources.length !== SOURCE_KINDS.length) invalid();
  sources.forEach((entry, index) => {
    const source = record(entry, ['kind', 'sourceId', 'backupId', 'planSha256', 'observationSha256', 'inventorySha256', 'entryCount', 'totalBytes']);
    if (source.kind !== SOURCE_KINDS[index]) invalid();
    [source.sourceId, source.planSha256, source.observationSha256, source.inventorySha256].forEach(hex64);
    id(source.backupId); count(source.entryCount); count(source.totalBytes);
  });
  if (new Set(sources.map(source => (source as { backupId: string }).backupId)).size !== sources.length) invalid();
  const inventory = record(manifest.inventory, ['reportSha256', 'summary']);
  hex64(inventory.reportSha256);
  const summary = record(inventory.summary, ['supported', 'retainedBlocking', 'unknown', 'blockingReasons']);
  count(summary.supported); count(summary.retainedBlocking); count(summary.unknown);
  const blocking = sortedCodes(summary.blockingReasons);
  const database = orNull(manifest.sqlite, sqliteValue => {
    const sqlite = record(sqliteValue, ['journalMode', 'walEntries', 'walComplete', 'userVersion', 'quickCheck', 'notebooksListable']);
    const wal = array(sqlite.walEntries);
    if (!wal.every((name, index) => (WAL_NAMES as readonly unknown[]).includes(name) && (index === 0 || (wal[index - 1] as string) < (name as string)))) invalid();
    return { journalMode: orNull(sqlite.journalMode, code), walComplete: bool(sqlite.walComplete), userVersion: orNull(sqlite.userVersion, count),
      quickCheck: orNull(sqlite.quickCheck, code), notebooksListable: bool(sqlite.notebooksListable) };
  });
  const notebooks = array(manifest.notebooks);
  if (notebooks.length > MAX_CONVERSION_NOTEBOOKS) invalid();
  const parsed = notebooks.map(notebook);
  if (new Set(parsed.map(item => item.sourceDocumentId)).size !== parsed.length) invalid();
  // Row tables are built only for a listable, WAL-complete database (conversion_input._library_tables).
  if (parsed.length && (database === null || !database.notebooksListable || !database.walComplete)) invalid();
  const whole = record(manifest.wholeLibrary, ['status', 'reasons']);
  if (whole.status !== 'refused') invalid();                   // 'accepted' exists neither as a type nor as a value
  const reasons = sortedCodes(whole.reasons);
  const expected = new Set([...blocking, 'uncollected-source']);
  if (parsed.some(item => item.status === 'blocked')) expected.add('notebook-extraction-blocked');
  if (reasons.join('|') !== [...expected].sort().join('|')) invalid();
}

/** The manifest's own hash must be the content hash of everything else (Python edit_content_hash == TS editContentHash). */
export async function assertManifestSeal(manifest: ConversionInputManifest): Promise<void> {
  const { manifestSha256, ...body } = manifest;
  if (await editContentHash(body) !== manifestSha256) invalid();
}

const mismatch = (): never => { throw new Error('conversion-input-count-mismatch'); };
const countKind = (annotations: readonly PageAnnotation[], kind: PageAnnotation['kind']) => annotations.filter(item => item.kind === kind).length;

/**
 * Project every extracted Notebook and verify its counts against the manifest.
 * Counting rule (verified against the converters):
 *  - one legacy stroke -> exactly one InkObject (legacyInk.ts convertLegacyInkPage: one annotations.push per stroke),
 *    so a page's ink annotations equal the sum of strokeCount of the ink rows that name that page;
 *  - one bookmark row -> exactly one annotation (legacyBookmarks.ts annotation()): kind 'note' -> 'sticky',
 *    kind 'highlight' -> 'highlight'.
 * Integrity failures (identity, entry, counts, a missing or surplus extraction) throw; a Notebook the manifest already
 * calls blocked, or that the projection itself rejects, is reported as `blocked` and never converted.
 */
export async function projectConversionInputNotebooks(manifestValue: unknown, extractionValues: ReadonlyMap<string, NotebookExtraction>): Promise<{
  notebooks: ProjectedNotebook[]; wholeLibrary: { status: 'refused'; reasons: readonly string[] };
}> {
  // Both inputs are captured before any await: later caller changes cannot enter the checks.
  let stable: unknown, extractions: Map<string, NotebookExtraction>;
  try { stable = structuredClone(manifestValue); extractions = new Map(structuredClone([...extractionValues])); }
  catch { throw new Error('conversion-input-manifest-invalid'); }
  assertConversionInputManifest(stable);
  const manifest: ConversionInputManifest = stable;
  await assertManifestSeal(manifest);
  const expected = new Set(manifest.notebooks.filter(item => item.status === 'extracted').map(item => item.sourceDocumentId));
  for (const [key, extraction] of extractions) {
    if (!expected.has(key)) throw new Error('conversion-input-extraction-unexpected');
    // The bridge hands over exactly these fields; anything else is not a verified extraction.
    if (!isRecord(extraction) || Object.keys(extraction).sort().join('|') !== 'annotations|bytes|entry|libraryId|sourceDocumentId'
      || extraction.sourceDocumentId !== key || !Array.isArray(extraction.annotations)) throw new Error('conversion-input-entry-mismatch');
  }
  const notebooks: ProjectedNotebook[] = [];
  for (const item of manifest.notebooks) {
    if (item.status === 'blocked') { notebooks.push({ sourceDocumentId: item.sourceDocumentId, status: 'blocked', reason: item.reason! }); continue; }
    const extraction = extractions.get(item.sourceDocumentId);
    if (!extraction) throw new Error('conversion-input-extraction-missing');
    const entry = item.notebookEntry!;
    if (extraction.libraryId !== manifest.libraryId || !isRecord(extraction.entry)
      || extraction.entry.sha256 !== entry.sha256 || extraction.entry.byteLength !== entry.byteLength
      || !(extraction.bytes instanceof Uint8Array) || extraction.bytes.byteLength !== entry.byteLength) throw new Error('conversion-input-entry-mismatch');
    let projection: Awaited<ReturnType<typeof projectLegacyNotebookEntry>>;
    try { projection = await projectLegacyNotebookEntry(extraction); }
    catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'notebook-entry-mismatch') throw new Error('conversion-input-entry-mismatch');   // bytes do not hash to the manifest's entry
      notebooks.push({ sourceDocumentId: item.sourceDocumentId, status: 'blocked', reason: CODE.test(reason) ? reason : 'projection-failed' });
      continue;
    }
    const { pages } = projection.document;
    if (projection.pageMappings.map(mapping => mapping.sourcePageId).join('|') !== item.pageIds.join('|')
      || pages.length !== item.pageIds.length || pages.length !== item.coverage!.pageRows) mismatch();
    const total = { ink: 0, sticky: 0, highlight: 0 };
    pages.forEach((page, index) => {
      const pageId = item.pageIds[index];
      const strokes = item.rows.ink.filter(row => row.pageId === pageId).reduce((sum, row) => sum + row.strokeCount!, 0);
      const notes = item.rows.bookmarks.filter(row => row.pageId === pageId && row.kind === 'note').length;
      const highlights = item.rows.bookmarks.filter(row => row.pageId === pageId && row.kind === 'highlight').length;
      const ink = countKind(page.annotations, 'ink'), sticky = countKind(page.annotations, 'sticky'), highlight = countKind(page.annotations, 'highlight');
      if (ink !== strokes || sticky !== notes || highlight !== highlights || page.annotations.length !== ink + sticky + highlight) mismatch();
      total.ink += ink; total.sticky += sticky; total.highlight += highlight;
    });
    if (total.sticky + total.highlight !== item.coverage!.bookmarkRows) mismatch();
    notebooks.push({ sourceDocumentId: item.sourceDocumentId, status: 'converted', document: projection.document, pageMappings: projection.pageMappings,
      counts: { pages: pages.length, ...total }, mappings: projection.mappings, provenance: projection.provenance });
  }
  return { notebooks, wholeLibrary: { status: 'refused', reasons: [...manifest.wholeLibrary.reasons] } };
}
