import type { Page, PageAnnotation, TextHighlight } from '../runtime/edits/contracts.ts';
import { assertSnapshot, EditRejected } from '../runtime/edits/editModel.ts';
import { validAnnotationTimestamp } from '../runtime/edits/annotationTime.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { assertLegacyPageTarget, legacyPageKey, type LegacyPageContext, type LegacyPageMigration,
  type MigrationIdMapping, type PageMigrationIssue } from './legacyPage.ts';
import { migrationStableId } from './stableId.ts';

/** Raw bookmarks-table records, not the joined/derived sticky-note API projection. */
export type LegacyBookmark = { id: string | number; paper_id: string; page: number; side: 'original' | 'translated';
  quote: string; label: string; note: string; anchor_x: number; anchor_y: number; kind: 'note' | 'highlight';
  color: string; rects: string; created_at: string };
export type LegacyBookmarkContext = LegacyPageContext & { sourcePageNumber: number };
const COLORS: Record<string, string> = { yellow: '#facc15', green: '#4ade80', blue: '#60a5fa', pink: '#f472b6', purple: '#c084fc' };
const KEYS = ['id', 'paper_id', 'page', 'side', 'quote', 'label', 'note', 'anchor_x', 'anchor_y', 'kind', 'color', 'rects', 'created_at'];
const reject = (reason: string): never => { throw new EditRejected(reason); };
const normalized = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function sourceRects(value: unknown): number[][] {
  if (typeof value !== 'string') return reject('invalid-bookmark-rects');
  const boxes: unknown = JSON.parse(value);
  if (!Array.isArray(boxes)) return reject('invalid-bookmark-rects');
  return boxes;
}
function sourceId(id: unknown): string {
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && /^[1-9][0-9]{0,18}$/.exec(id)?.[0] === id && (id.length < 19 || id <= '9223372036854775807')) return id;
  return reject('invalid-bookmark-id');
}
function timestamp(value: string): string {
  // SQLite CURRENT_TIMESTAMP is UTC. No machine locale/timezone or Date.parse heuristics enter migration.
  const result = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  if (!validAnnotationTimestamp(result)) reject('invalid-bookmark-time');
  return result;
}
function assertBookmark(value: unknown, context: LegacyBookmarkContext): asserts value is LegacyBookmark {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid-bookmark');
  const b = value as LegacyBookmark;
  if (Object.keys(b).length !== KEYS.length || Object.keys(b).some(key => !KEYS.includes(key))) reject('invalid-bookmark-fields');
  sourceId(b.id);
  if (b.paper_id !== context.sourceDocumentId || b.side !== context.side || b.page !== context.sourcePageNumber) reject('bookmark-source-mismatch');
  if (!normalized(b.anchor_x) || !normalized(b.anchor_y)) reject('invalid-bookmark-anchor');
  const boxes = sourceRects(b.rects);
  for (const [text, limit] of [[b.quote, 2000], [b.label, 40], [b.note, 1000]] as const) {
    if (typeof text !== 'string' || Array.from(text).length > limit) reject('invalid-bookmark-text');
  }
  if (typeof b.created_at !== 'string') reject('invalid-bookmark-time');
  timestamp(b.created_at);
  if (b.kind === 'highlight') {
    if (typeof b.color !== 'string' || !Object.prototype.hasOwnProperty.call(COLORS, b.color) || !b.quote.trim() || !boxes.length || boxes.length > 400
      || boxes.some(rect => !Array.isArray(rect) || rect.length !== 4 || !rect.every(normalized) || rect[2] <= 0 || rect[3] <= 0
        || rect[0] + rect[2] > 1.00002 || rect[1] + rect[3] > 1.00002)) reject('invalid-bookmark-highlight');
  } else if (b.kind !== 'note' || b.color !== '' || boxes.length) reject('invalid-bookmark-note');
}
function annotation(bookmark: LegacyBookmark, page: Page, id: string): PageAnnotation {
  const b = bookmark, anchor = { x: b.anchor_x * page.widthPt, y: b.anchor_y * page.heightPt };
  const common = { id, anchor, text: b.note, quote: b.quote, metadata: { label: b.label, createdAt: timestamp(b.created_at) } };
  if (b.kind === 'note') return { ...common, kind: 'sticky', color: null }; // No explicit color was stored; retain category/default styling.
  const quads = sourceRects(b.rects).map(([x, y, w, h]) => [{ x: x * page.widthPt, y: y * page.heightPt },
    { x: (x + w) * page.widthPt, y: y * page.heightPt }, { x: (x + w) * page.widthPt, y: (y + h) * page.heightPt },
    { x: x * page.widthPt, y: (y + h) * page.heightPt }]);
  return { ...common, kind: 'highlight', color: COLORS[b.color], quads, backgroundRevision: page.backgroundRevision,
    range: { kind: 'unindexed' } } satisfies TextHighlight;
}

/** Whole-page conversion: source range offsets are absent, so highlights remain explicitly unindexed. */
export async function convertLegacyBookmarksPage(page: Page, bookmarks: unknown, context: LegacyBookmarkContext): Promise<LegacyPageMigration> {
  let stable: { page: Page; bookmarks: unknown; context: LegacyBookmarkContext };
  try { stable = structuredClone({ page, bookmarks, context }); }
  catch (error) { return { status: 'blocked', mappings: [], issues: [{ source: [], code: 'non-data-source', detail: String(error) }] }; }
  const mappings: MigrationIdMapping[] = [], issues: PageMigrationIssue[] = [];
  if (!stable.context || typeof stable.context !== 'object') return { status: 'blocked', mappings, issues: [{ source: [], code: 'invalid-source-page', detail: 'migration-page-context' }] };
  const source = legacyPageKey(stable.context);
  try {
    assertLegacyPageTarget(stable.page, stable.context);
    if (!Number.isSafeInteger(stable.context.sourcePageNumber) || stable.context.sourcePageNumber < 1 || !Array.isArray(stable.bookmarks)) reject('invalid-bookmarks-page');
  } catch (error) { return { status: 'blocked', mappings, issues: [{ source, code: 'invalid-source-page', detail: String(error) }] }; }
  const annotations: PageAnnotation[] = [], ids = new Set<string>();
  for (const [index, value] of (stable.bookmarks as unknown[]).entries()) {
    let key = [...source, `row:${index}`];
    try {
      if (value && typeof value === 'object') key = [...source, sourceId((value as LegacyBookmark).id)];
      assertBookmark(value, stable.context);
      const oldId = sourceId(value.id); if (ids.has(oldId)) reject('duplicate-bookmark-id'); ids.add(oldId);
      const targetId = await migrationStableId(stable.context.libraryId, 'bookmark', key), sourceFingerprint = await editContentHash(value);
      mappings.push({ kind: 'bookmark', source: key, targetId, sourceFingerprint }); annotations.push(annotation(value, stable.page, targetId));
    } catch (error) { issues.push({ source: key, code: 'invalid-source-bookmark', detail: String(error) }); }
  }
  const converted = { ...stable.page, annotations };
  if (!issues.length) try {
    assertSnapshot({ kind: 'document', id: stable.context.documentId, version: stable.page.annotationVersion, pages: [converted], deletedPages: [] });
  } catch (error) { issues.push({ source, code: 'invalid-target-page', detail: String(error) }); }
  return issues.length ? { status: 'blocked', mappings, issues } : { status: 'converted', page: converted, mappings };
}
