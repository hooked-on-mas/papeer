import type { Page } from '../runtime/edits/contracts.ts';
import { assertSnapshot } from '../runtime/edits/editModel.ts';
import { convertLegacyInkPage } from './legacyInk.ts';
import { convertLegacyBookmarksPage, type LegacyBookmarkContext } from './legacyBookmarks.ts';
import { legacyPageKey, type LegacyPageMigration } from './legacyPage.ts';

/** All annotation families enter one immutable page; no partial page is exposed on any conversion error. */
export async function convertLegacyAnnotationsPage(page: Page, ink: unknown, bookmarks: unknown, context: LegacyBookmarkContext): Promise<LegacyPageMigration> {
  let stable: { page: Page; ink: unknown; bookmarks: unknown; context: LegacyBookmarkContext };
  try { stable = structuredClone({ page, ink, bookmarks, context }); }
  catch (error) { return { status: 'blocked', mappings: [], issues: [{ source: [], code: 'non-data-source', detail: String(error) }] }; }
  const inkResult = await convertLegacyInkPage(stable.page, stable.ink, stable.context);
  const bookmarkResult = await convertLegacyBookmarksPage(stable.page, stable.bookmarks, stable.context);
  const mappings = [...inkResult.mappings, ...bookmarkResult.mappings];
  if (inkResult.status === 'blocked' || bookmarkResult.status === 'blocked') return { status: 'blocked', mappings,
    issues: [...(inkResult.status === 'blocked' ? inkResult.issues : []), ...(bookmarkResult.status === 'blocked' ? bookmarkResult.issues : [])] };
  const converted = { ...inkResult.page, annotations: [...inkResult.page.annotations, ...bookmarkResult.page.annotations] };
  try { assertSnapshot({ kind: 'document', id: stable.context.documentId, version: stable.page.annotationVersion, pages: [converted], deletedPages: [] }); }
  catch (error) { return { status: 'blocked', mappings, issues: [{ source: legacyPageKey(stable.context), code: 'invalid-target-page', detail: String(error) }] }; }
  return { status: 'converted', page: converted, mappings };
}
