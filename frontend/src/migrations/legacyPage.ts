import { editSchema, type Page } from '../runtime/edits/contracts.ts';
import { assertSnapshot, EditRejected } from '../runtime/edits/editModel.ts';
import { validateStructure } from '../runtime/edits/schemaValidator.ts';

export type LegacyPageContext = { libraryId: string; documentId: string; sourceDocumentId: string;
  side: 'original' | 'translated'; sourcePageId: string; sourceRevision: string | null };
export type MigrationIdMapping = { kind: 'ink' | 'bookmark'; source: string[]; targetId: string; sourceFingerprint: string };
export type PageMigrationIssue = { source: string[]; code: string; detail: string };
export type LegacyPageMigration = { status: 'converted'; page: Page; mappings: MigrationIdMapping[] }
  | { status: 'blocked'; mappings: MigrationIdMapping[]; issues: PageMigrationIssue[] };
export const legacyPageKey = (context: LegacyPageContext) => [context.sourceDocumentId, context.side, context.sourcePageId];
export function assertLegacyPageTarget(page: Page, context: LegacyPageContext): void {
  validateStructure(editSchema, 'Id', context.libraryId);
  if (!['original', 'translated'].includes(context.side)
    || legacyPageKey(context).some(value => typeof value !== 'string' || !value || Array.from(value).length > 1000)) throw new EditRejected('migration-page-source');
  if (page.annotations.length) throw new EditRejected('migration-target-not-empty');
  assertSnapshot({ kind: 'document', id: context.documentId, version: page.annotationVersion, pages: [page], deletedPages: [] });
  if (page.background.kind === 'pdf' ? page.background.sourceRevision !== context.sourceRevision : context.sourceRevision !== null) throw new EditRejected('migration-background-mismatch');
}
